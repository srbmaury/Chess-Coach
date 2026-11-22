import threading
from datetime import UTC, datetime, timedelta

import pytest
from hosted_factories import entitled_player, new_account, parity_puzzles, publish_results

from chess_ml_coach.hosted.practice import (
    NoActivePlayerError,
    PracticeRepository,
    PuzzleNotFoundError,
)

NOW = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)


@pytest.fixture
def practice(pg):
    account = new_account(pg)
    player_id = entitled_player(pg, account)
    repository = PracticeRepository(pg)
    repository.set_active(account, player_id)
    publish_results(pg, player_id, parity_puzzles(6))
    return {"repo": repository, "player": repository.require_active(account), "account": account,
            "player_id": player_id, "pg": pg}


def test_active_player_is_required_and_scoped_to_the_account(pg):
    repository = PracticeRepository(pg)
    account = new_account(pg)
    with pytest.raises(NoActivePlayerError):
        repository.require_active(account)
    stranger_player = entitled_player(pg, new_account(pg), "someoneelse")
    repository.set_active(account, stranger_player)
    assert repository.active_player(account) is None


def test_new_puzzles_are_due_and_ordered_like_the_local_store(practice):
    repo, player = practice["repo"], practice["player"]
    first = repo.next_due(player, now=datetime.now(UTC) + timedelta(seconds=1))
    expected = min(parity_puzzles(6), key=lambda p: (-p["difficulty"], p["puzzle_id"]))
    assert first["puzzle_id"] == expected["puzzle_id"]
    assert first["attempts"] == 0


def test_review_intervals_mastery_and_history_follow_the_training_rules(practice):
    repo, player = practice["repo"], practice["player"]
    puzzle_id = parity_puzzles(1)[0]["puzzle_id"]

    wrong = repo.record_review(player, puzzle_id, answer="a2a3", correct=False, now=NOW)
    intervals = [repo.record_review(player, puzzle_id, answer="e2e4", correct=True, now=NOW).next_interval_days
                 for _ in range(4)]

    assert wrong.next_interval_days == 1 and wrong.consecutive_correct == 0
    assert intervals == [3, 7, 14, 30]
    row = repo.get_puzzle(player, puzzle_id)
    assert row["attempts"] == 5 and row["correct_attempts"] == 4 and row["mastered"] is True
    with practice["pg"].transaction() as connection:
        previous = [r[0] for r in connection.execute(
            "SELECT previous_interval_days FROM practice_reviews ORDER BY id").fetchall()]
    assert previous == [0, 1, 3, 7, 14]


def test_reviewed_puzzles_leave_the_due_queue(practice):
    repo, player = practice["repo"], practice["player"]
    later = datetime.now(UTC) + timedelta(seconds=1)
    seen = set()
    while (row := repo.next_due(player, now=later)) is not None:
        seen.add(row["puzzle_id"])
        repo.record_review(player, row["puzzle_id"], answer="a2a3", correct=True, now=later)
    assert len(seen) == 6
    assert repo.next_due(player, now=later + timedelta(days=3, seconds=1)) is not None


def test_unknown_or_inactive_puzzles_cannot_be_reviewed(practice):
    with pytest.raises(PuzzleNotFoundError):
        practice["repo"].record_review(practice["player"], "nope", answer="a2a3", correct=True)
    other = parity_puzzles()[10]["puzzle_id"]
    with pytest.raises(PuzzleNotFoundError):
        practice["repo"].record_review(practice["player"], other, answer="a2a3", correct=True)


def test_republishing_replaces_the_set_but_keeps_history_for_the_same_puzzles(practice):
    repo, player, pg = practice["repo"], practice["player"], practice["pg"]
    kept = parity_puzzles(1)[0]["puzzle_id"]
    repo.record_review(player, kept, answer="a2a3", correct=True, now=NOW)

    publish_results(pg, practice["player_id"], parity_puzzles(3), dependency="e" * 64)
    refreshed = repo.require_active(practice["account"])

    _rows, total = repo.list_puzzles(refreshed)
    assert total == 3
    assert repo.get_puzzle(refreshed, kept)["attempts"] == 1
    with pg.transaction() as connection:
        assert connection.execute("SELECT count(DISTINCT dependency_hash) FROM player_puzzles").fetchone()[0] == 1


def test_filters_and_pagination(practice):
    repo, player = practice["repo"], practice["player"]
    puzzles = parity_puzzles(6)
    quality = puzzles[0]["quality"]
    repo.record_review(player, puzzles[0]["puzzle_id"], answer="a2a3", correct=True, now=NOW)

    by_quality, total = repo.list_puzzles(player, quality=quality)
    assert total == sum(1 for p in puzzles if p["quality"] == quality)
    assert all(row["quality"] == quality for row in by_quality)
    reviewed, total_reviewed = repo.list_puzzles(player, reviewed=True)
    assert total_reviewed == 1 and reviewed[0]["puzzle_id"] == puzzles[0]["puzzle_id"]
    page, total_all = repo.list_puzzles(player, limit=2, offset=2)
    assert len(page) == 2 and total_all == 6


def test_progress_daily_reviews_and_adaptive_metrics(practice):
    repo, player = practice["repo"], practice["player"]
    puzzles = parity_puzzles(6)
    now = datetime.now(UTC)
    repo.record_review(player, puzzles[0]["puzzle_id"], answer="a2a3", correct=True, now=now)
    repo.record_review(player, puzzles[1]["puzzle_id"], answer="a2a3", correct=False, now=now)
    repo.record_adaptive_drill(player, puzzles[2]["puzzle_id"], succeeded=True, answer="e2e4",
                               user_moves_accepted=3, current_ply=5, continuation_attempts=2,
                               continuation_correct=2, now=now)
    repo.record_adaptive_drill(player, puzzles[3]["puzzle_id"], succeeded=False, answer="e2e4",
                               user_moves_accepted=1, current_ply=1, now=now)

    summary = repo.progress(player, now=now)
    assert (summary.total_puzzles, summary.reviewed_puzzles, summary.total_reviews) == (6, 4, 4)
    assert summary.accuracy == 0.5
    assert sum(row.puzzles for row in summary.by_motif) == 6
    daily = repo.daily_reviews(player)
    assert daily == [{"date": now.date().isoformat(), "reviews": 4, "correct": 2, "accuracy": 0.5}]
    metrics = repo.adaptive_metrics(player)
    assert metrics.sessions_completed == 2 and metrics.success_rate == 0.5
    assert metrics.continuation_accuracy == 1.0
    assert metrics.average_accepted_decisions == 2.0 and metrics.average_calculation_depth_plies == 3.0


def test_practice_is_private_to_each_account(practice):
    repo, pg = practice["repo"], practice["pg"]
    other_account = new_account(pg)
    entitled_player(pg, other_account)  # same shared player, different account
    repo.set_active(other_account, practice["player_id"])
    other = repo.require_active(other_account)
    puzzle_id = parity_puzzles(1)[0]["puzzle_id"]
    repo.record_review(practice["player"], puzzle_id, answer="a2a3", correct=True, now=NOW)

    assert repo.get_puzzle(other, puzzle_id)["attempts"] == 0
    assert repo.progress(other).total_reviews == 0


def test_concurrent_first_reviews_do_not_lose_updates(practice):
    repo, player = practice["repo"], practice["player"]
    puzzle_id = parity_puzzles(1)[0]["puzzle_id"]
    barrier = threading.Barrier(4)

    def review():
        barrier.wait()
        repo.record_review(player, puzzle_id, answer="a2a3", correct=True)

    threads = [threading.Thread(target=review) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    row = repo.get_puzzle(player, puzzle_id)
    assert row["attempts"] == 4 and row["consecutive_correct"] == 4
