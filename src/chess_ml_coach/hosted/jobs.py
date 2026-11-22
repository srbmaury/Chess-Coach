"""Shared analysis jobs: one non-terminal job per (player, game set, configuration).

Observation (subscriptions) is independent of computation (the lease). Stopping a
subscription never cancels another account's work; a job with no active subscribers
pauses and stays resumable from its last acknowledged checkpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from psycopg.types.json import Jsonb

from .analysis_config import ENGINE_BUILD, MODEL_ALGORITHM, HostedAnalysisConfig
from .database import Database

NON_TERMINAL = ("queued", "running", "paused")
TERMINAL = ("succeeded", "failed", "cancelled")


class JobError(RuntimeError):
    code = "job_error"


class JobNotFoundError(JobError):
    code = "job_not_found"


# Public job view. The stored status is reinterpreted when a lease lapsed without a
# takeover, so observers never see "running" for a worker that has disappeared.
_JOB_COLUMNS = """
    j.id,
    j.player_id,
    CASE
        WHEN j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now())
        THEN CASE WHEN EXISTS (
            SELECT 1 FROM job_subscribers s WHERE s.job_id = j.id AND s.state = 'active'
        ) THEN 'queued' ELSE 'paused' END
        ELSE j.status
    END AS effective_status,
    j.completed_work,
    j.total_work,
    j.checkpoint_sequence,
    c.config_hash,
    j.input_game_set_hash,
    j.manifest_storage_key,
    j.compute_source,
    (j.lease_token_digest IS NOT NULL AND j.lease_expires_at > now()) AS worker_active,
    j.created_at,
    j.updated_at,
    j.finished_at
"""


@dataclass(frozen=True)
class SharedJob:
    id: str
    player_id: str
    status: str
    completed_work: int
    total_work: int
    checkpoint_sequence: int
    analysis_config_hash: str
    manifest_hash: str
    manifest_storage_key: str | None
    compute_source: str
    worker_active: bool
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None
    subscription_state: str | None = None
    can_compute: bool = False

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL


def _job(row, subscription: tuple | None = None) -> SharedJob:
    return SharedJob(
        id=str(row[0]),
        player_id=str(row[1]),
        status=row[2],
        completed_work=row[3],
        total_work=row[4],
        checkpoint_sequence=row[5],
        analysis_config_hash=row[6],
        manifest_hash=row[7],
        manifest_storage_key=row[8],
        compute_source=row[9],
        worker_active=bool(row[10]),
        created_at=row[11],
        updated_at=row[12],
        finished_at=row[13],
        subscription_state=subscription[0] if subscription else None,
        can_compute=bool(subscription[1]) if subscription else False,
    )


def _select_job(connection, job_id: str, account_id: str | None = None) -> SharedJob | None:
    row = connection.execute(
        f"SELECT {_JOB_COLUMNS} FROM analysis_jobs j "
        "JOIN analysis_configs c ON c.id = j.analysis_config_id WHERE j.id = %s",
        (job_id,),
    ).fetchone()
    if row is None:
        return None
    subscription = None
    if account_id is not None:
        subscription = connection.execute(
            "SELECT state, can_compute FROM job_subscribers WHERE job_id = %s AND account_id = %s",
            (job_id, account_id),
        ).fetchone()
    return _job(row, subscription)


def settle_unleased_status(connection, job_id: str) -> None:
    """After a lease is cleared: queued while someone watches, otherwise paused."""
    connection.execute(
        "UPDATE analysis_jobs SET status = CASE WHEN EXISTS ("
        "SELECT 1 FROM job_subscribers s WHERE s.job_id = analysis_jobs.id AND s.state = 'active'"
        ") THEN 'queued' ELSE 'paused' END "
        "WHERE id = %s AND status IN ('queued', 'running', 'paused')",
        (job_id,),
    )


def clear_lease(connection, job_id: str) -> None:
    connection.execute(
        "UPDATE analysis_jobs SET lease_token_digest = NULL, lease_account_id = NULL, "
        "lease_device_id = NULL, lease_expires_at = NULL WHERE id = %s",
        (job_id,),
    )


class JobRepository:
    def __init__(self, database: Database):
        self._database = database

    def ensure_config(self, config: HostedAnalysisConfig) -> str:
        document = config.document()
        with self._database.transaction() as connection:
            found = connection.execute(
                "SELECT id FROM analysis_configs WHERE config_hash = %s", (config.hash,)
            ).fetchone()
            if found:
                return str(found[0])
            row = connection.execute(
                "INSERT INTO analysis_configs (stockfish_version, depth, thresholds, "
                "algorithm_version, config_hash, config) VALUES (%s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (config_hash) DO UPDATE SET config = excluded.config "
                "RETURNING id",
                (
                    f"{ENGINE_BUILD['version']}-{ENGINE_BUILD['flavor']}",
                    config.depth,
                    Jsonb(document["thresholds"]),
                    MODEL_ALGORITHM,
                    config.hash,
                    Jsonb(document),
                ),
            ).fetchone()
        return str(row[0])

    def config_quarantined(self, config_hash: str) -> bool:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT quarantined_at IS NOT NULL FROM analysis_configs WHERE config_hash = %s",
                (config_hash,),
            ).fetchone()
        return bool(row and row[0])

    def create_or_join(
        self,
        *,
        account_id: str,
        player_id: str,
        config_id: str,
        engine_build_hash: str,
        manifest_hash: str,
        manifest_storage_key: str,
        game_ids: list[str],
        can_compute: bool,
    ) -> SharedJob:
        """Join the running analysis of this game list, or start one for its unanalyzed games.

        Games already analyzed for this player and configuration are never analyzed
        again, so a job covers only the games still missing when it is created. A job
        with nothing left to do finishes immediately.
        """
        key = (player_id, config_id, manifest_hash)
        with self._database.transaction() as connection:
            # Serialize job creation per player so concurrent requests agree on one job.
            connection.execute("SELECT id FROM players WHERE id = %s FOR UPDATE", (player_id,))
            existing = connection.execute(
                "SELECT id FROM analysis_jobs WHERE player_id = %s AND analysis_config_id = %s "
                "AND input_game_set_hash = %s AND status IN ('queued', 'running', 'paused') "
                "FOR UPDATE",
                key,
            ).fetchone()
            if existing:
                job_id = existing[0]
                connection.execute(
                    "INSERT INTO job_subscribers (job_id, account_id, state, can_compute) "
                    "VALUES (%s, %s, 'active', %s) ON CONFLICT (job_id, account_id) "
                    "DO UPDATE SET state = 'active', can_compute = excluded.can_compute",
                    (job_id, account_id, can_compute),
                )
                connection.execute(
                    "UPDATE analysis_jobs SET status = 'queued' WHERE id = %s AND status = 'paused'",
                    (job_id,),
                )
                return _select_job(connection, str(job_id), account_id)

            # An unfinished job for an older game list is superseded; its analyzed games
            # are already kept per game, so nothing is lost.
            stale = connection.execute(
                "UPDATE analysis_jobs SET status = 'cancelled', finished_at = now(), "
                "lease_token_digest = NULL, lease_account_id = NULL, lease_device_id = NULL, "
                "lease_expires_at = NULL WHERE player_id = %s AND analysis_config_id = %s "
                "AND status IN ('queued', 'running', 'paused') RETURNING id",
                (player_id, config_id),
            ).fetchall()
            for (stale_id,) in stale:
                connection.execute(
                    "UPDATE job_subscribers SET state = 'stopped' WHERE job_id = %s "
                    "AND state = 'active'",
                    (stale_id,),
                )

            analyzed = {
                row[0]
                for row in connection.execute(
                    "SELECT game_id FROM analyzed_games WHERE player_id = %s "
                    "AND analysis_config_id = %s",
                    (player_id, config_id),
                ).fetchall()
            }
            pending = [game_id for game_id in game_ids if game_id not in analyzed]
            finished = not pending
            row = connection.execute(
                "INSERT INTO analysis_jobs (player_id, analysis_config_id, input_game_set_hash, "
                "stage, status, total_work, analysis_config_hash, engine_build_hash, "
                "manifest_storage_key, finished_at) "
                "SELECT %s, %s, %s, %s, %s, %s, config_hash, %s, %s, "
                "CASE WHEN %s THEN now() END FROM analysis_configs WHERE id = %s RETURNING id",
                (
                    player_id, config_id, manifest_hash,
                    "complete" if finished else "analyze",
                    "succeeded" if finished else "queued",
                    len(pending), engine_build_hash, manifest_storage_key, finished, config_id,
                ),
            ).fetchone()
            if row is None:
                raise JobError("Could not create the analysis job")
            job_id = row[0]
            if pending:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        "INSERT INTO job_units (job_id, unit_index, game_id) VALUES (%s, %s, %s)",
                        [(job_id, index, game_id) for index, game_id in enumerate(pending)],
                    )
            connection.execute(
                "INSERT INTO job_subscribers (job_id, account_id, state, can_compute) "
                "VALUES (%s, %s, %s, %s)",
                (job_id, account_id, "completed" if finished else "active", can_compute),
            )
            return _select_job(connection, str(job_id), account_id)

    def config_document(self, config_hash: str) -> dict:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT config FROM analysis_configs WHERE config_hash = %s", (config_hash,)
            ).fetchone()
        if row is None:
            raise JobNotFoundError("Analysis configuration not found")
        return row[0]

    def subscribe(self, job_id: str, account_id: str, can_compute: bool) -> SharedJob:
        """Follow an unfinished job again (e.g. after stopping)."""
        with self._database.transaction() as connection:
            connection.execute(
                "INSERT INTO job_subscribers (job_id, account_id, state, can_compute) "
                "SELECT id, %s, 'active', %s FROM analysis_jobs WHERE id = %s "
                "AND status IN ('queued', 'running', 'paused') "
                "ON CONFLICT (job_id, account_id) DO UPDATE SET state = 'active', "
                "can_compute = excluded.can_compute",
                (account_id, can_compute, job_id),
            )
            connection.execute(
                "UPDATE analysis_jobs SET status = 'queued' WHERE id = %s AND status = 'paused'",
                (job_id,),
            )
            job = _select_job(connection, job_id, account_id)
        if job is None:
            raise JobNotFoundError("Analysis job not found")
        return job

    def unit_game_ids(self, job_id: str) -> list[str]:
        with self._database.transaction() as connection:
            rows = connection.execute(
                "SELECT game_id FROM job_units WHERE job_id = %s ORDER BY unit_index", (job_id,)
            ).fetchall()
        return [row[0] for row in rows]

    def get(self, job_id: str, account_id: str | None = None) -> SharedJob:
        with self._database.transaction() as connection:
            job = _select_job(connection, job_id, account_id)
        if job is None:
            raise JobNotFoundError("Analysis job not found")
        return job

    def latest_for_player(self, player_id: str, config_id: str, account_id: str) -> SharedJob | None:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT id FROM analysis_jobs WHERE player_id = %s AND analysis_config_id = %s "
                "ORDER BY (status IN ('queued', 'running', 'paused')) DESC, created_at DESC LIMIT 1",
                (player_id, config_id),
            ).fetchone()
            return _select_job(connection, str(row[0]), account_id) if row else None

    def set_can_compute(self, job_id: str, account_id: str, can_compute: bool) -> SharedJob:
        with self._database.transaction() as connection:
            updated = connection.execute(
                "UPDATE job_subscribers SET can_compute = %s WHERE job_id = %s AND account_id = %s "
                "RETURNING 1",
                (can_compute, job_id, account_id),
            ).fetchone()
            if not updated:
                raise JobNotFoundError("Analysis job not found")
            if not can_compute:
                self._release_account_lease(connection, job_id, account_id)
            return _select_job(connection, job_id, account_id)

    @staticmethod
    def _release_account_lease(connection, job_id: str, account_id: str) -> None:
        held = connection.execute(
            "SELECT 1 FROM analysis_jobs WHERE id = %s AND lease_account_id = %s FOR UPDATE",
            (job_id, account_id),
        ).fetchone()
        if held:
            clear_lease(connection, job_id)
            settle_unleased_status(connection, job_id)

    def stop_observing(self, job_id: str, account_id: str) -> SharedJob:
        with self._database.transaction() as connection:
            locked = connection.execute(
                "SELECT status FROM analysis_jobs WHERE id = %s FOR UPDATE", (job_id,)
            ).fetchone()
            if locked is None:
                raise JobNotFoundError("Analysis job not found")
            stopped = connection.execute(
                "UPDATE job_subscribers SET state = 'stopped' "
                "WHERE job_id = %s AND account_id = %s AND state = 'active' RETURNING 1",
                (job_id, account_id),
            ).fetchone()
            if stopped:
                self._release_account_lease(connection, job_id, account_id)
                # With nobody left watching, no browser may keep computing.
                remaining = connection.execute(
                    "SELECT 1 FROM job_subscribers WHERE job_id = %s AND state = 'active' LIMIT 1",
                    (job_id,),
                ).fetchone()
                if not remaining and locked[0] in NON_TERMINAL:
                    clear_lease(connection, job_id)
                    connection.execute(
                        "UPDATE analysis_jobs SET status = 'paused' WHERE id = %s", (job_id,)
                    )
            return _select_job(connection, job_id, account_id)
