"""Hosted puzzle training: the classic Practice/Mistakes/Progress data in Postgres.

Mirrors the local ``TrainingStore`` (same intervals, mastery rule, and ordering) but
is scoped to an account and one of its players, and reads the puzzles of the
player's active analysis result instead of a per-player SQLite file.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from psycopg.rows import dict_row

from ..training import ProgressRow, ProgressSummary, ReviewResult, _interval_for
from .database import Database

PUZZLE_FIELDS = (
    "game_id", "ply", "fen_before", "color", "game_label", "move_label", "your_move_san",
    "your_move_uci", "best_move_san", "best_move_uci", "cpl", "quality", "opening", "eco",
    "game_phase", "source_url", "motif", "difficulty",
)


class PracticeError(RuntimeError):
    pass


class NoActivePlayerError(PracticeError):
    pass


class PuzzleNotFoundError(PracticeError):
    pass


@dataclass(frozen=True)
class ActivePlayer:
    account_id: str
    player_id: str
    username: str
    display_username: str
    job_id: str | None
    dependency_hash: str | None


@dataclass(frozen=True)
class AdaptiveMetrics:
    sessions_completed: int
    success_rate: float | None
    continuation_accuracy: float | None
    average_accepted_decisions: float | None
    average_calculation_depth_plies: float | None


# Every puzzle of the player's active set, with this account's review state.
_ACTIVE = """
    FROM player_puzzles p
    JOIN players pl ON pl.id = p.player_id AND pl.active_dependency_hash = p.dependency_hash
    LEFT JOIN practice_states s
      ON s.account_id = %(account)s AND s.player_id = p.player_id AND s.puzzle_id = p.puzzle_id
    WHERE p.player_id = %(player)s
"""
_COLUMNS = """
    p.puzzle_id, p.game_id, p.ply, p.fen_before, p.color, p.game_label, p.move_label,
    p.your_move_san, p.your_move_uci, p.best_move_san, p.best_move_uci, p.cpl, p.quality,
    p.opening, p.eco, p.game_phase, p.source_url, p.motif, p.difficulty,
    COALESCE(s.attempts, 0) AS attempts,
    COALESCE(s.correct_attempts, 0) AS correct_attempts,
    COALESCE(s.consecutive_correct, 0) AS consecutive_correct,
    s.last_reviewed_at,
    COALESCE(s.next_review_at, p.created_at) AS next_review_at,
    COALESCE(s.mastered, false) AS mastered
"""


def _now(now: datetime | None) -> datetime:
    return (now or datetime.now(UTC)).astimezone(UTC)


class PracticeRepository:
    def __init__(self, database: Database):
        self._database = database

    # Active player ----------------------------------------------------------------

    def active_player(self, account_id: str) -> ActivePlayer | None:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT p.id::text, p.canonical_username, p.display_username, "
                "p.active_job_id::text, p.active_dependency_hash "
                "FROM accounts a JOIN players p ON p.id = a.active_player_id "
                "JOIN account_profiles ap ON ap.account_id = a.id AND ap.player_id = p.id "
                "AND ap.state <> 'removed' WHERE a.id = %s",
                (account_id,),
            ).fetchone()
        if row is None:
            return None
        return ActivePlayer(account_id, row[0], row[1], row[2], row[3], row[4])

    def require_active(self, account_id: str) -> ActivePlayer:
        player = self.active_player(account_id)
        if player is None:
            raise NoActivePlayerError("Choose a Chess.com player first")
        return player

    def set_active(self, account_id: str, player_id: str) -> None:
        with self._database.transaction() as connection:
            connection.execute(
                "UPDATE accounts SET active_player_id = %s WHERE id = %s", (player_id, account_id)
            )

    # Results ------------------------------------------------------------------------

    @staticmethod
    def import_puzzles(connection, player_id: str, dependency_hash: str, puzzles: list[dict]) -> None:
        """Store a validated puzzles artifact (inside the caller's transaction)."""
        if not puzzles:
            return
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO player_puzzles (player_id, dependency_hash, puzzle_id, "
                + ", ".join(PUZZLE_FIELDS)
                + ") VALUES (%s, %s, %s, "
                + ", ".join(["%s"] * len(PUZZLE_FIELDS))
                + ") ON CONFLICT DO NOTHING",
                [
                    (player_id, dependency_hash, puzzle["puzzle_id"],
                     *(puzzle.get(field, "") for field in PUZZLE_FIELDS))
                    for puzzle in puzzles
                ],
            )

    @staticmethod
    def activate_results(connection, player_id: str, job_id: str, dependency_hash: str) -> None:
        """Make a completed analysis the one this player trains on (caller's transaction)."""
        connection.execute(
            "UPDATE players SET active_job_id = %s, active_dependency_hash = %s WHERE id = %s",
            (job_id, dependency_hash, player_id),
        )
        # Older sets are no longer reachable; keep only the active one.
        connection.execute(
            "DELETE FROM player_puzzles WHERE player_id = %s AND dependency_hash <> %s",
            (player_id, dependency_hash),
        )

    def analyzed_moves(self, player: ActivePlayer) -> int:
        """Moves analyzed for this player (at the depth with the most analysis)."""
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT COALESCE(max(total), 0) FROM (SELECT sum(move_count) AS total "
                "FROM analyzed_games WHERE player_id = %s GROUP BY analysis_config_id) totals",
                (player.player_id,),
            ).fetchone()
        return int(row[0])

    def result_artifacts(self, player: ActivePlayer) -> dict[str, datetime]:
        """When each result type (puzzles, model, report) was last published."""
        with self._database.transaction() as connection:
            rows = connection.execute(
                "SELECT artifact_type, max(created_at) FROM derived_artifacts WHERE player_id = %s "
                "AND account_id IS NULL AND status = 'ready' AND quarantined_at IS NULL "
                "GROUP BY artifact_type",
                (player.player_id,),
            ).fetchall()
        return {row[0]: row[1] for row in rows}

    def artifact_key(self, player: ActivePlayer, artifact_type: str) -> str | None:
        """The latest published result of this type."""
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT storage_key FROM derived_artifacts WHERE player_id = %s "
                "AND account_id IS NULL AND artifact_type = %s AND status = 'ready' "
                "AND quarantined_at IS NULL ORDER BY created_at DESC LIMIT 1",
                (player.player_id, artifact_type),
            ).fetchone()
        return row[0] if row else None

    # Puzzles ------------------------------------------------------------------------

    @staticmethod
    def _params(player: ActivePlayer, **extra) -> dict:
        return {"account": player.account_id, "player": player.player_id, **extra}

    def next_due(self, player: ActivePlayer, *, now: datetime | None = None) -> dict | None:
        with self._database.transaction() as connection:
            return connection.cursor(row_factory=dict_row).execute(
                f"SELECT {_COLUMNS} {_ACTIVE} "
                "AND COALESCE(s.next_review_at, p.created_at) <= %(now)s "
                "ORDER BY COALESCE(s.next_review_at, p.created_at) ASC, "
                "(COALESCE(s.attempts, 0) - COALESCE(s.correct_attempts, 0)) DESC, "
                "p.difficulty DESC, p.puzzle_id ASC LIMIT 1",
                self._params(player, now=_now(now)),
            ).fetchone()

    def get_puzzle(self, player: ActivePlayer, puzzle_id: str) -> dict | None:
        with self._database.transaction() as connection:
            return connection.cursor(row_factory=dict_row).execute(
                f"SELECT {_COLUMNS} {_ACTIVE} AND p.puzzle_id = %(puzzle)s",
                self._params(player, puzzle=puzzle_id),
            ).fetchone()

    def list_puzzles(
        self,
        player: ActivePlayer,
        *,
        quality: str | None = None,
        motif: str | None = None,
        opening: str | None = None,
        reviewed: bool | None = None,
        mastered: bool | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        clauses = []
        params = self._params(player, limit=int(limit), offset=int(offset))
        if quality:
            clauses.append("p.quality = %(quality)s")
            params["quality"] = quality
        if motif:
            clauses.append("p.motif = %(motif)s")
            params["motif"] = motif
        if opening:
            clauses.append("p.opening = %(opening)s")
            params["opening"] = opening
        if reviewed is not None:
            clauses.append("COALESCE(s.attempts, 0) " + ("> 0" if reviewed else "= 0"))
        if mastered is not None:
            clauses.append("COALESCE(s.mastered, false) = %(mastered)s")
            params["mastered"] = mastered
        where = "".join(f" AND {clause}" for clause in clauses)
        with self._database.transaction() as connection:
            total = connection.execute(f"SELECT count(*) {_ACTIVE}{where}", params).fetchone()[0]
            rows = connection.cursor(row_factory=dict_row).execute(
                f"SELECT {_COLUMNS} {_ACTIVE}{where} "
                "ORDER BY COALESCE(s.attempts, 0) ASC, p.difficulty DESC, "
                "COALESCE(s.next_review_at, p.created_at) ASC, p.puzzle_id ASC "
                "LIMIT %(limit)s OFFSET %(offset)s",
                params,
            ).fetchall()
        return rows, int(total)

    # Reviews ------------------------------------------------------------------------

    def _record(self, connection, player: ActivePlayer, puzzle_id: str, *, answer: str,
                correct: bool, now: datetime) -> ReviewResult:
        exists = connection.execute(
            f"SELECT 1 {_ACTIVE} AND p.puzzle_id = %(puzzle)s",
            self._params(player, puzzle=puzzle_id),
        ).fetchone()
        if exists is None:
            raise PuzzleNotFoundError("Puzzle not found")
        key = (player.account_id, player.player_id, puzzle_id)
        connection.execute(
            "INSERT INTO practice_states (account_id, player_id, puzzle_id, next_review_at) "
            "VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
            (*key, now),
        )
        state = connection.execute(
            "SELECT consecutive_correct FROM practice_states WHERE account_id = %s "
            "AND player_id = %s AND puzzle_id = %s FOR UPDATE",
            key,
        ).fetchone()
        streak = state[0] + 1 if correct else 0
        interval = _interval_for(correct, streak)
        next_review = now + timedelta(days=interval)
        mastered = bool(correct and streak >= 4)
        previous = connection.execute(
            "SELECT next_interval_days FROM practice_reviews WHERE account_id = %s "
            "AND player_id = %s AND puzzle_id = %s ORDER BY id DESC LIMIT 1",
            key,
        ).fetchone()
        connection.execute(
            "UPDATE practice_states SET attempts = attempts + 1, "
            "correct_attempts = correct_attempts + %s, consecutive_correct = %s, "
            "last_reviewed_at = %s, next_review_at = %s, mastered = %s "
            "WHERE account_id = %s AND player_id = %s AND puzzle_id = %s",
            (int(correct), streak, now, next_review, mastered, *key),
        )
        connection.execute(
            "INSERT INTO practice_reviews (account_id, player_id, puzzle_id, reviewed_at, "
            "answer, correct, previous_interval_days, next_interval_days) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (*key, now, answer, correct, previous[0] if previous else 0, interval),
        )
        return ReviewResult(
            puzzle_id=puzzle_id, correct=correct, next_interval_days=interval,
            consecutive_correct=streak, next_review_at=next_review, mastered=mastered,
        )

    def record_review(self, player: ActivePlayer, puzzle_id: str, *, answer: str,
                      correct: bool, now: datetime | None = None) -> ReviewResult:
        with self._database.transaction() as connection:
            return self._record(connection, player, puzzle_id, answer=answer, correct=correct,
                                now=_now(now))

    def record_adaptive_drill(
        self,
        player: ActivePlayer,
        puzzle_id: str,
        *,
        succeeded: bool,
        answer: str,
        user_moves_accepted: int,
        current_ply: int,
        continuation_attempts: int = 0,
        continuation_correct: int = 0,
        now: datetime | None = None,
    ) -> ReviewResult:
        resolved = _now(now)
        with self._database.transaction() as connection:
            review = self._record(connection, player, puzzle_id, answer=answer,
                                  correct=succeeded, now=resolved)
            connection.execute(
                "INSERT INTO adaptive_drills (account_id, player_id, puzzle_id, succeeded, "
                "user_moves_accepted, current_ply, continuation_attempts, continuation_correct, "
                "finished_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (player.account_id, player.player_id, puzzle_id, succeeded, user_moves_accepted,
                 current_ply, continuation_attempts, continuation_correct, resolved),
            )
        return review

    # Progress -----------------------------------------------------------------------

    def _group(self, connection, player: ActivePlayer, column: str) -> list[ProgressRow]:
        rows = connection.execute(
            f"SELECT p.{column} AS label, count(*) AS puzzles, "
            "COALESCE(sum(s.attempts), 0) AS attempts, "
            f"COALESCE(sum(s.correct_attempts), 0) AS correct {_ACTIVE} "
            f"GROUP BY p.{column} ORDER BY attempts DESC, puzzles DESC, label ASC",
            self._params(player),
        ).fetchall()
        return [
            ProgressRow(label=row[0], puzzles=int(row[1]), attempts=int(row[2]), correct=int(row[3]),
                        accuracy=(int(row[3]) / int(row[2])) if row[2] else None)
            for row in rows
        ]

    def progress(self, player: ActivePlayer, *, now: datetime | None = None) -> ProgressSummary:
        params = self._params(player, now=_now(now))
        with self._database.transaction() as connection:
            counts = connection.execute(
                "SELECT count(*), "
                "count(*) FILTER (WHERE COALESCE(s.next_review_at, p.created_at) <= %(now)s), "
                "count(*) FILTER (WHERE COALESCE(s.attempts, 0) > 0), "
                f"count(*) FILTER (WHERE COALESCE(s.mastered, false)) {_ACTIVE}",
                params,
            ).fetchone()
            reviews = connection.execute(
                "SELECT count(*), count(*) FILTER (WHERE r.correct) FROM practice_reviews r "
                "WHERE r.account_id = %(account)s AND r.player_id = %(player)s "
                f"AND r.puzzle_id IN (SELECT p.puzzle_id {_ACTIVE})",
                params,
            ).fetchone()
            by_motif = self._group(connection, player, "motif")
            by_opening = self._group(connection, player, "opening")
        total_reviews, correct_reviews = int(reviews[0]), int(reviews[1])
        return ProgressSummary(
            total_puzzles=int(counts[0]),
            due_puzzles=int(counts[1]),
            reviewed_puzzles=int(counts[2]),
            mastered_puzzles=int(counts[3]),
            total_reviews=total_reviews,
            accuracy=(correct_reviews / total_reviews) if total_reviews else None,
            by_motif=by_motif,
            by_opening=by_opening,
        )

    def daily_reviews(self, player: ActivePlayer, *, days: int = 90) -> list[dict]:
        params = self._params(player, since=datetime.now(UTC) - timedelta(days=days))
        with self._database.transaction() as connection:
            rows = connection.execute(
                "SELECT to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, "
                "count(*), count(*) FILTER (WHERE r.correct) FROM practice_reviews r "
                "WHERE r.account_id = %(account)s AND r.player_id = %(player)s "
                "AND r.reviewed_at >= %(since)s "
                f"AND r.puzzle_id IN (SELECT p.puzzle_id {_ACTIVE}) "
                "GROUP BY day ORDER BY day ASC",
                params,
            ).fetchall()
        return [
            {"date": row[0], "reviews": int(row[1]), "correct": int(row[2]),
             "accuracy": (int(row[2]) / int(row[1])) if row[1] else 0.0}
            for row in rows
        ]

    def adaptive_metrics(self, player: ActivePlayer) -> AdaptiveMetrics:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT count(*), count(*) FILTER (WHERE succeeded), "
                "COALESCE(sum(continuation_attempts), 0), COALESCE(sum(continuation_correct), 0), "
                "avg(user_moves_accepted)::float8, avg(current_ply)::float8 "
                "FROM adaptive_drills WHERE account_id = %s AND player_id = %s",
                (player.account_id, player.player_id),
            ).fetchone()
        count = int(row[0])
        if count == 0:
            return AdaptiveMetrics(0, None, None, None, None)
        return AdaptiveMetrics(
            sessions_completed=count,
            success_rate=int(row[1]) / count,
            continuation_accuracy=(int(row[3]) / int(row[2])) if row[2] else None,
            average_accepted_decisions=float(row[4]),
            average_calculation_depth_plies=float(row[5]),
        )
