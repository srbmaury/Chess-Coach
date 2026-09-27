from datetime import UTC, datetime, timedelta
from hashlib import sha256

import pytest
from hosted_factories import (
    DEVICE_A,
    DEVICE_B,
    BrowserClient,
    artifact_payload,
    checkpoint_payload,
    expire_lease,
    gzip_json,
    hosted_app,
    new_account,
)

from chess_ml_coach.hosted.analysis_config import engine_build_hash

ENGINE = engine_build_hash()


@pytest.fixture
def worker(pg):
    app, services, storage = hosted_app(pg)
    first = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    second = BrowserClient(app, storage, new_account(pg), DEVICE_B)
    player_id = first.claim_profile()
    second.claim_profile()
    job = first.join(player_id)
    second.join(player_id)
    assert first.claim(job["id"]).status_code == 200
    games = first.manifest_games(job["id"])
    return {"first": first, "second": second, "job": job, "games": games, "pg": pg,
            "storage": storage, "services": services, "player_id": player_id}


def _commit_all(worker) -> None:
    first, job, games = worker["first"], worker["job"], worker["games"]
    assert first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE)).status_code == 200
    assert first.checkpoint(job["id"], 2, checkpoint_payload(job, games, 2, 2, 2, ENGINE)).status_code == 200


def test_checkpoint_finalization_advances_progress_monotonically(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]

    response = first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))

    assert response.status_code == 200, response.text
    assert response.json()["first_unit"] == 0 and response.json()["last_unit"] == 1
    state = worker["second"].get(f"/api/hosted/jobs/{job['id']}").json()
    assert state["completed_units"] == 2 and state["checkpoint_sequence"] == 1


def test_duplicate_finalization_is_idempotent(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    payload = checkpoint_payload(job, games, 1, 0, 1, ENGINE)
    first.checkpoint(job["id"], 1, payload)
    content_hash = sha256(gzip_json(payload)).hexdigest()

    again = first.post(f"/api/hosted/jobs/{job['id']}/checkpoints/finalize",
                       first.lease_body(sequence=1, content_hash=content_hash))
    upload = first.upload(job["id"], gzip_json(payload), sequence=1)

    assert again.status_code == 200 and again.json()["sequence"] == 1
    assert upload.json()["already_finalized"] is True
    assert worker["first"].get(f"/api/hosted/jobs/{job['id']}").json()["completed_units"] == 2


def test_skipped_and_replayed_sequences_are_rejected(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    skipped = first.upload(job["id"],
                           gzip_json(checkpoint_payload(job, games, 2, 0, 1, ENGINE)), sequence=2)
    assert skipped.status_code == 409
    first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    replay = gzip_json(checkpoint_payload(job, games, 1, 0, 0, ENGINE))
    response = first.upload(job["id"], replay, sequence=1)
    assert response.status_code == 409 and response.json()["code"] == "sequence_conflict"


def test_stale_lease_cannot_finalize_after_takeover(worker):
    first, second, job, games = worker["first"], worker["second"], worker["job"], worker["games"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    assert first.upload(job["id"], body, sequence=1).status_code == 200

    expire_lease(worker["pg"], job["id"])
    assert second.claim(job["id"]).status_code == 200
    response = first.post(f"/api/hosted/jobs/{job['id']}/checkpoints/finalize",
                          first.lease_body(sequence=1, content_hash=sha256(body).hexdigest()))

    assert response.status_code == 409 and response.json()["code"] == "lease_lost"
    assert second.get(f"/api/hosted/jobs/{job['id']}").json()["completed_units"] == 0


def test_new_worker_resumes_from_the_acknowledged_checkpoint(worker):
    first, second, job, games = worker["first"], worker["second"], worker["job"], worker["games"]
    first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    expire_lease(worker["pg"], job["id"])

    grant = second.claim(job["id"]).json()
    response = second.checkpoint(job["id"], 2, checkpoint_payload(job, games, 2, 2, 2, ENGINE))

    assert grant["completed_units"] == 2 and grant["checkpoint_sequence"] == 1
    assert response.status_code == 200


def test_interrupted_upload_does_not_advance_progress(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    request = first.lease_body(kind="checkpoint", sequence=1, byte_size=len(body),
                               content_hash=sha256(body).hexdigest())
    assert first.post(f"/api/hosted/jobs/{job['id']}/uploads", request).status_code == 200

    response = first.post(f"/api/hosted/jobs/{job['id']}/checkpoints/finalize",
                          first.lease_body(sequence=1, content_hash=sha256(body).hexdigest()))

    assert response.status_code == 422
    assert first.get(f"/api/hosted/jobs/{job['id']}").json()["completed_units"] == 0


def test_hash_size_and_late_upload_mismatches_are_rejected(worker):
    first, job, games, storage = worker["first"], worker["job"], worker["games"], worker["storage"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    digest = sha256(body).hexdigest()
    request = first.lease_body(kind="checkpoint", sequence=1, byte_size=len(body), content_hash=digest)
    grant = first.post(f"/api/hosted/jobs/{job['id']}/uploads", request).json()

    tampered = body[:20] + bytes([body[20] ^ 0xFF]) + body[21:]
    storage.upload_signed(grant["storage_key"], tampered)
    finalize = first.lease_body(sequence=1, content_hash=digest)
    assert first.post(f"/api/hosted/jobs/{job['id']}/checkpoints/finalize", finalize).status_code == 422

    storage.objects.pop(grant["storage_key"])
    storage.upload_signed(grant["storage_key"], body, at=datetime.now(UTC) + timedelta(hours=1))
    late = first.post(f"/api/hosted/jobs/{job['id']}/checkpoints/finalize", finalize)
    assert late.status_code == 422 and "expired" in late.json()["detail"]


def test_upload_size_limits_are_enforced_at_grant_time(worker):
    first, job = worker["first"], worker["job"]
    request = first.lease_body(kind="checkpoint", sequence=1, byte_size=8 * 1024 * 1024 + 1,
                               content_hash="a" * 64)
    response = first.post(f"/api/hosted/jobs/{job['id']}/uploads", request)
    assert response.status_code == 413


def test_illegal_move_in_uploaded_checkpoint_is_rejected(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    payload = checkpoint_payload(job, games, 1, 0, 1, ENGINE)
    payload["games"][0]["rows"][0]["best_move_uci"] = "e1e8"

    response = first.checkpoint(job["id"], 1, payload)

    assert response.status_code == 422 and "legal" in response.json()["detail"]


def test_last_checkpoint_finishes_the_job_and_records_every_game(worker, pg):
    first, job = worker["first"], worker["job"]
    _commit_all(worker)

    finished = worker["second"].get(f"/api/hosted/jobs/{job['id']}").json()
    assert finished["status"] == "succeeded" and finished["worker_active"] is False
    with pg.transaction() as connection:
        recorded = connection.execute("SELECT count(*) FROM analyzed_games").fetchone()[0]
    assert recorded == 3
    # Nothing is analyzed twice: the same game list now needs no work.
    again = first.analyze(worker["player_id"])
    assert again["status"] == "succeeded" and again["total_units"] == 0


def test_results_can_be_built_from_partial_analysis(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))

    found = first.analysis_set(worker["player_id"])
    assert (found["analyzed_games"], found["total_games"]) == (2, 3)
    hashes = [item["content_hash"] for item in found["checkpoints"]]
    assert all(item["download_url"] for item in found["checkpoints"])

    report = first.artifact(worker["player_id"], "report",
                            artifact_payload("report", found["dependency_hash"], job["analysis_config_hash"]), hashes)
    assert report.status_code == 200, report.text
    assert report.json()["compute_source"] == "community_computed"
    pipeline = first.get(f"/api/hosted/players/{worker['player_id']}/pipeline").json()
    assert pipeline["results"]["report"]["dependency_hash"] == found["dependency_hash"]


def test_results_must_cite_this_players_analysis_and_match_its_dependency(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    found = first.analysis_set(worker["player_id"])
    hashes = [item["content_hash"] for item in found["checkpoints"]]
    payload = artifact_payload("report", found["dependency_hash"], job["analysis_config_hash"])

    forged = first.artifact(worker["player_id"], "report", payload, ["f" * 64])
    assert forged.status_code == 422
    stale = first.artifact(worker["player_id"], "report",
                           artifact_payload("report", "0" * 64, job["analysis_config_hash"]), hashes)
    assert stale.status_code == 422
    stranger = BrowserClient(first.client.app, worker["storage"], new_account(worker["pg"]), "device-cccccccccccccccc")
    assert stranger.artifact(worker["player_id"], "report", payload, hashes).status_code == 403


def test_published_puzzles_become_the_practice_set(worker, pg):
    first, job = worker["first"], worker["job"]
    _commit_all(worker)
    found = first.analysis_set(worker["player_id"])
    hashes = [item["content_hash"] for item in found["checkpoints"]]
    for kind in ("puzzles", "model_summary", "report"):
        response = first.artifact(worker["player_id"], kind,
                                  artifact_payload(kind, found["dependency_hash"], job["analysis_config_hash"]), hashes)
        assert response.status_code == 200, response.text

    with pg.transaction() as connection:
        active = connection.execute(
            "SELECT active_dependency_hash FROM players WHERE id = %s", (worker["player_id"],)
        ).fetchone()[0]
    assert active == found["dependency_hash"]
    again = first.artifact(worker["player_id"], "report",
                           artifact_payload("report", found["dependency_hash"], job["analysis_config_hash"]), hashes)
    assert again.status_code == 200


def test_quarantined_artifacts_are_hidden(worker):
    first, job = worker["first"], worker["job"]
    _commit_all(worker)
    found = first.analysis_set(worker["player_id"])
    hashes = [item["content_hash"] for item in found["checkpoints"]]
    first.artifact(worker["player_id"], "report",
                   artifact_payload("report", found["dependency_hash"], job["analysis_config_hash"]), hashes)
    with worker["pg"].transaction() as connection:
        connection.execute("UPDATE derived_artifacts SET quarantined_at = now()")

    pipeline = first.get(f"/api/hosted/players/{worker['player_id']}/pipeline").json()
    assert pipeline["results"] == {}


def test_orphaned_uploads_are_cleaned_up(worker):
    first, job, games, storage = worker["first"], worker["job"], worker["games"], worker["storage"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    grant = first.upload(job["id"], body, sequence=1).json()
    with worker["pg"].transaction() as connection:
        connection.execute("UPDATE analysis_upload_grants SET expires_at = now() - interval '2 hours'")

    removed = worker["services"].checkpoints.cleanup_orphans()

    assert removed == 1
    assert grant["storage_key"] not in storage.objects
