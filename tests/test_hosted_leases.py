import threading
from datetime import datetime

import pytest
from hosted_factories import (
    DEVICE_A,
    DEVICE_B,
    create_job,
    entitled_player,
    expire_lease,
    new_account,
)

from chess_ml_coach.hosted.jobs import JobRepository
from chess_ml_coach.hosted.leases import (
    InvalidDeviceError,
    LeaseLostError,
    LeaseService,
    LeaseUnavailableError,
    ObserverOnlyError,
    token_digest,
)


@pytest.fixture
def shared(pg):
    first, second = new_account(pg), new_account(pg)
    player = entitled_player(pg, first)
    job = create_job(pg, first, player)
    create_job(pg, second, player)
    return {"job": job.id, "first": first, "second": second, "player": player}


def _db_seconds_left(pg, job_id: str) -> float:
    with pg.transaction() as connection:
        return connection.execute(
            "SELECT extract(epoch FROM lease_expires_at - now()) FROM analysis_jobs WHERE id = %s",
            (job_id,),
        ).fetchone()[0]


def test_claim_grants_a_sixty_second_lease_by_database_time(pg, shared):
    grant = LeaseService(pg).claim(shared["job"], shared["first"], DEVICE_A)

    assert grant.lease_seconds == 60
    assert grant.renew_interval_seconds == 20
    assert isinstance(grant.expires_at, datetime)
    assert 58 < float(_db_seconds_left(pg, shared["job"])) <= 60
    assert JobRepository(pg).get(shared["job"]).status == "running"


def test_only_the_digest_is_persisted(pg, shared):
    grant = LeaseService(pg).claim(shared["job"], shared["first"], DEVICE_A)
    with pg.transaction() as connection:
        row = connection.execute(
            "SELECT row_to_json(analysis_jobs)::text, lease_token_digest FROM analysis_jobs"
        ).fetchone()

    assert grant.token not in row[0]
    assert row[1] == token_digest(grant.token)
    assert len(grant.token) >= 43


def test_simultaneous_claims_have_exactly_one_winner(pg, shared):
    outcomes: list[str] = []
    barrier = threading.Barrier(2)
    service = LeaseService(pg)

    def run(account: str, device: str) -> None:
        barrier.wait()
        try:
            service.claim(shared["job"], account, device)
            outcomes.append("won")
        except LeaseUnavailableError:
            outcomes.append("lost")

    threads = [
        threading.Thread(target=run, args=(shared["first"], DEVICE_A)),
        threading.Thread(target=run, args=(shared["second"], DEVICE_B)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(outcomes) == ["lost", "won"]


def test_same_owner_reclaim_rotates_the_token(pg, shared):
    service = LeaseService(pg)
    first = service.claim(shared["job"], shared["first"], DEVICE_A)
    second = service.claim(shared["job"], shared["first"], DEVICE_A)

    assert first.token != second.token
    with pytest.raises(LeaseLostError):
        service.renew(shared["job"], shared["first"], DEVICE_A, first.token)
    service.renew(shared["job"], shared["first"], DEVICE_A, second.token)


def test_takeover_only_after_expiry_and_stale_token_is_denied(pg, shared):
    service = LeaseService(pg)
    old = service.claim(shared["job"], shared["first"], DEVICE_A)
    with pytest.raises(LeaseUnavailableError):
        service.claim(shared["job"], shared["second"], DEVICE_B)

    expire_lease(pg, shared["job"])
    assert JobRepository(pg).get(shared["job"]).status == "queued"
    new = service.claim(shared["job"], shared["second"], DEVICE_B)

    with pytest.raises(LeaseLostError):
        service.renew(shared["job"], shared["first"], DEVICE_A, old.token)
    assert service.renew(shared["job"], shared["second"], DEVICE_B, new.token).token == new.token
    with pg.transaction() as connection:
        assert connection.execute(
            "SELECT count(*) FROM audit_events WHERE action = 'lease_takeover'"
        ).fetchone()[0] == 1


def test_renew_rejects_expired_wrong_device_and_wrong_account(pg, shared):
    service = LeaseService(pg)
    grant = service.claim(shared["job"], shared["first"], DEVICE_A)
    for account, device in ((shared["first"], DEVICE_B), (shared["second"], DEVICE_A)):
        with pytest.raises(LeaseLostError):
            service.renew(shared["job"], account, device, grant.token)
    expire_lease(pg, shared["job"])
    with pytest.raises(LeaseLostError):
        service.renew(shared["job"], shared["first"], DEVICE_A, grant.token)


def test_stop_observing_releases_the_holders_lease(pg, shared):
    service = LeaseService(pg)
    grant = service.claim(shared["job"], shared["first"], DEVICE_A)

    job = JobRepository(pg).stop_observing(shared["job"], shared["first"])

    assert job.status == "queued"
    assert not job.worker_active
    with pytest.raises(LeaseLostError):
        service.renew(shared["job"], shared["first"], DEVICE_A, grant.token)
    service.claim(shared["job"], shared["second"], DEVICE_B)


def test_release_frees_the_lease_and_ignores_non_holders(pg, shared):
    service = LeaseService(pg)
    grant = service.claim(shared["job"], shared["first"], DEVICE_A)

    service.release(shared["job"], shared["second"], DEVICE_B, "not-the-token")
    assert JobRepository(pg).get(shared["job"]).worker_active
    service.release(shared["job"], shared["first"], DEVICE_A, grant.token)

    assert not JobRepository(pg).get(shared["job"]).worker_active
    service.claim(shared["job"], shared["second"], DEVICE_B)


def test_observer_only_subscribers_cannot_claim(pg):
    account = new_account(pg)
    player = entitled_player(pg, account)
    job = create_job(pg, account, player, can_compute=False)

    with pytest.raises(ObserverOnlyError):
        LeaseService(pg).claim(job.id, account, DEVICE_A)


def test_opting_out_releases_a_held_lease(pg, shared):
    service = LeaseService(pg)
    service.claim(shared["job"], shared["first"], DEVICE_A)

    job = JobRepository(pg).set_can_compute(shared["job"], shared["first"], False)

    assert not job.can_compute and not job.worker_active


def test_malformed_device_ids_are_rejected(pg, shared):
    with pytest.raises(InvalidDeviceError):
        LeaseService(pg).claim(shared["job"], shared["first"], "short")


def test_public_job_view_exposes_no_lease_identity(pg, shared):
    LeaseService(pg).claim(shared["job"], shared["first"], DEVICE_A)
    job = JobRepository(pg).get(shared["job"], shared["second"])

    assert DEVICE_A not in repr(job)
    assert shared["first"] not in repr(job)
