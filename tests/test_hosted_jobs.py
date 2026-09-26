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


def test_completed_results_are_reused_without_a_new_job(pg):
    first_account, second_account = new_account(pg), new_account(pg)
    player = entitled_player(pg, first_account)
    job = create_job(pg, first_account, player)
    with pg.transaction() as connection:
        connection.execute("UPDATE analysis_jobs SET status = 'succeeded', finished_at = now() "
                           "WHERE id = %s", (job.id,))

    reused = create_job(pg, second_account, player)

    assert reused.id == job.id
    assert reused.status == "succeeded"
    assert reused.subscription_state == "completed"


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
