import threading

import pytest
from hosted_factories import create_job, entitled_player, hosted_config, new_account

from chess_ml_coach.hosted.jobs import JobNotFoundError, JobRepository


def test_config_registration_is_idempotent_and_hash_is_stable(pg):
    repository = JobRepository(pg)
    config = hosted_config()

    assert repository.ensure_config(config) == repository.ensure_config(config)
    assert config.hash == hosted_config().hash
    assert len(config.hash) == 64


def test_create_then_join_share_one_job(pg):
    first_account, second_account = new_account(pg), new_account(pg)
    player = entitled_player(pg, first_account)
    entitled_player(pg, second_account)

    first = create_job(pg, first_account, player)
    second = create_job(pg, second_account, player)

    assert first.id == second.id
    assert first.status == "queued"
    assert second.subscription_state == "active"
    assert first.total_work == 4


def test_simultaneous_create_calls_yield_one_job(pg):
    accounts = [new_account(pg) for _ in range(6)]
    player = entitled_player(pg, accounts[0])
    jobs: list[str] = []
    barrier = threading.Barrier(len(accounts))

    def run(account: str) -> None:
        barrier.wait()
        jobs.append(create_job(pg, account, player).id)

    threads = [threading.Thread(target=run, args=(account,)) for account in accounts]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(set(jobs)) == 1
    with pg.transaction() as connection:
        assert connection.execute("SELECT count(*) FROM analysis_jobs").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM job_subscribers").fetchone()[0] == 6


def test_a_different_game_set_creates_a_separate_job(pg):
    account = new_account(pg)
    player = entitled_player(pg, account)

    assert create_job(pg, account, player).id != create_job(pg, account, player, manifest_hash="n" * 64).id


def _record_analyzed(pg, job_id: str, player_id: str, game_ids: list[str]) -> None:
    with pg.transaction() as connection:
        config_id = connection.execute(
            "SELECT analysis_config_id FROM analysis_jobs WHERE id = %s", (job_id,)
        ).fetchone()[0]
        checkpoint = connection.execute(
            "INSERT INTO analysis_checkpoints (job_id, sequence, storage_bucket, storage_key, "
            "byte_size, content_hash, result_count, first_unit, last_unit, first_game_id, "
            "last_game_id, analysis_config_hash, engine_build_hash, uploader_device_id) "
            "VALUES (%s, 1, 'b', %s, 1, %s, 1, 0, 0, 'g', 'g', 'c', 'e', 'd') RETURNING id",
            (job_id, f"key-{job_id}", "a" * 64),
        ).fetchone()[0]
        for game_id in game_ids:
            connection.execute(
                "INSERT INTO analyzed_games (player_id, analysis_config_id, game_id, checkpoint_id, "
                "move_count) VALUES (%s, %s, %s, %s, 20)",
                (player_id, config_id, game_id, checkpoint),
            )


def test_analyzed_games_are_never_analyzed_again(pg):
    account = new_account(pg)
    player = entitled_player(pg, account)
    first = create_job(pg, account, player, total_units=4)
    _record_analyzed(pg, first.id, player, ["game-0", "game-1"])

    # A new sync with two extra games supersedes the unfinished job ...
    second = create_job(pg, account, player, manifest_hash="n" * 64, total_units=6)
    assert second.total_work == 4
    assert JobRepository(pg).unit_game_ids(second.id) == ["game-2", "game-3", "game-4", "game-5"]
    assert JobRepository(pg).get(first.id).status == "cancelled"

    # ... and a game list that is fully analyzed finishes at once.
    _record_analyzed(pg, second.id, player, ["game-2", "game-3", "game-4", "game-5"])
    done = create_job(pg, account, player, manifest_hash="o" * 64, total_units=6)
    assert (done.status, done.total_work, done.subscription_state) == ("succeeded", 0, "completed")


def test_stopping_one_subscriber_does_not_stop_another(pg):
    first_account, second_account = new_account(pg), new_account(pg)
    player = entitled_player(pg, first_account)
    job = create_job(pg, first_account, player)
    create_job(pg, second_account, player)
    repository = JobRepository(pg)

    stopped = repository.stop_observing(job.id, first_account)

    assert stopped.subscription_state == "stopped"
    assert stopped.status == "queued"
    assert repository.get(job.id, second_account).subscription_state == "active"


def test_last_subscriber_stopping_pauses_and_rejoin_resumes(pg):
    account = new_account(pg)
    player = entitled_player(pg, account)
    job = create_job(pg, account, player)
    repository = JobRepository(pg)

    assert repository.stop_observing(job.id, account).status == "paused"
    rejoined = create_job(pg, account, player)

    assert rejoined.id == job.id
    assert rejoined.status == "queued"
    assert rejoined.subscription_state == "active"


def test_unknown_jobs_raise_a_sanitized_error(pg):
    with pytest.raises(JobNotFoundError, match="^Analysis job not found$"):
        JobRepository(pg).get("00000000-0000-0000-0000-000000000000")
