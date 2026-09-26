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
    upload = first.upload(job["id"], "checkpoint", gzip_json(payload), sequence=1)

    assert again.status_code == 200 and again.json()["sequence"] == 1
    assert upload.json()["already_finalized"] is True
    assert worker["first"].get(f"/api/hosted/jobs/{job['id']}").json()["completed_units"] == 2


def test_skipped_and_replayed_sequences_are_rejected(worker):
    first, job, games = worker["first"], worker["job"], worker["games"]
    skipped = first.upload(job["id"], "checkpoint",
                           gzip_json(checkpoint_payload(job, games, 2, 0, 1, ENGINE)), sequence=2)
    assert skipped.status_code == 409
    first.checkpoint(job["id"], 1, checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    replay = gzip_json(checkpoint_payload(job, games, 1, 0, 0, ENGINE))
    response = first.upload(job["id"], "checkpoint", replay, sequence=1)
    assert response.status_code == 409 and response.json()["code"] == "sequence_conflict"


def test_stale_lease_cannot_finalize_after_takeover(worker):
    first, second, job, games = worker["first"], worker["second"], worker["job"], worker["games"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    assert first.upload(job["id"], "checkpoint", body, sequence=1).status_code == 200

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


def test_artifacts_require_complete_analysis_and_matching_dependency(worker):
    first, job = worker["first"], worker["job"]
    early = first.upload(job["id"], "artifact", gzip_json({}), artifact_type="report")
    assert early.status_code == 409 and early.json()["code"] == "incomplete_job"

    _commit_all(worker)
    listing = first.get(f"/api/hosted/jobs/{job['id']}/checkpoints").json()
    assert len(listing["dependency_hash"]) == 64
    assert [item["sequence"] for item in listing["checkpoints"]] == [1, 2]
    assert all(item["download_url"] for item in listing["checkpoints"])

    wrong = first.artifact(job["id"], "report",
                           artifact_payload("report", "0" * 64, job["analysis_config_hash"]))
    assert wrong.status_code == 422


def test_full_completion_and_result_reuse(worker, pg):
    first, second, job = worker["first"], worker["second"], worker["job"]
    _commit_all(worker)
    dependency = first.get(f"/api/hosted/jobs/{job['id']}/checkpoints").json()["dependency_hash"]
    lease = first.lease_body()
    early = first.post(f"/api/hosted/jobs/{job['id']}/complete", lease)
    assert early.status_code == 409 and "Missing derived results" in early.json()["detail"]

    for kind in ("puzzles", "model_summary", "report"):
        response = first.artifact(job["id"], kind,
                                  artifact_payload(kind, dependency, job["analysis_config_hash"]))
        assert response.status_code == 200, response.text
        assert response.json()["compute_source"] == "community_computed"

    done = first.post(f"/api/hosted/jobs/{job['id']}/complete", lease)
    assert done.status_code == 200 and done.json()["status"] == "succeeded"

    results = second.get(f"/api/hosted/profiles/{worker['player_id']}/results").json()
    assert {item["artifact_type"] for item in results["artifacts"]} == {
        "puzzles", "model_summary", "report"
    }
    assert all(item["compute_source"] == "community_computed" for item in results["artifacts"])
    newcomer = BrowserClient(first.client.app, worker["storage"], new_account(pg), "device-dddddddddddddddd")
    newcomer.claim_profile()
    reused = newcomer.join(worker["player_id"])
    assert reused["id"] == job["id"] and reused["status"] == "succeeded"


def test_quarantined_artifacts_are_hidden(worker):
    first, job = worker["first"], worker["job"]
    _commit_all(worker)
    dependency = first.get(f"/api/hosted/jobs/{job['id']}/checkpoints").json()["dependency_hash"]
    first.artifact(job["id"], "report", artifact_payload("report", dependency, job["analysis_config_hash"]))
    with worker["pg"].transaction() as connection:
        connection.execute("UPDATE derived_artifacts SET quarantined_at = now()")

    results = first.get(f"/api/hosted/profiles/{worker['player_id']}/results").json()
    assert results["artifacts"] == []


def test_orphaned_uploads_are_cleaned_up(worker):
    first, job, games, storage = worker["first"], worker["job"], worker["games"], worker["storage"]
    body = gzip_json(checkpoint_payload(job, games, 1, 0, 1, ENGINE))
    grant = first.upload(job["id"], "checkpoint", body, sequence=1).json()
    with worker["pg"].transaction() as connection:
        connection.execute("UPDATE analysis_upload_grants SET expires_at = now() - interval '2 hours'")

    removed = worker["services"].checkpoints.cleanup_orphans()

    assert removed == 1
    assert grant["storage_key"] not in storage.objects
