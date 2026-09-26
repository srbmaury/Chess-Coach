import pytest
from fastapi.testclient import TestClient
from hosted_factories import (
    DEVICE_A,
    DEVICE_B,
    BrowserClient,
    hosted_app,
    jwt_for,
    new_account,
    subscribe,
)

from chess_ml_coach.hosted.rate_limit import InMemoryRateLimiter, Limit


@pytest.fixture
def api(pg):
    app, _services, storage = hosted_app(pg)
    owner = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    stranger = BrowserClient(app, storage, new_account(pg), DEVICE_B)
    player_id = owner.claim_profile()
    job = owner.join(player_id)
    return {"app": app, "storage": storage, "owner": owner, "stranger": stranger,
            "player_id": player_id, "job": job, "pg": pg}


@pytest.mark.parametrize("header", [None, "Bearer not-a-jwt", "Basic abc"])
def test_missing_or_invalid_tokens_are_rejected(api, header):
    headers = {"Authorization": header} if header else {}
    client = TestClient(api["app"])

    assert client.get("/api/hosted/profiles", headers=headers).status_code == 401
    assert client.post(f"/api/hosted/jobs/{api['job']['id']}/lease/claim",
                       json={"device_id": DEVICE_A}, headers=headers).status_code == 401


def test_expired_token_is_rejected(api):
    import time

    from jwt_support import token

    expired = token(api["owner"].account_id, exp=int(time.time()) - 10)
    response = TestClient(api["app"]).get(
        "/api/hosted/profiles", headers={"Authorization": f"Bearer {expired}"}
    )
    assert response.status_code == 401


def test_unentitled_account_cannot_see_or_join_another_players_job(api):
    stranger, job = api["stranger"], api["job"]

    assert stranger.get(f"/api/hosted/jobs/{job['id']}").status_code == 404
    assert stranger.post("/api/hosted/jobs", {"player_id": api["player_id"]}).status_code == 403
    assert stranger.claim(job["id"]).status_code == 403
    assert stranger.get(f"/api/hosted/jobs/{job['id']}/checkpoints").status_code == 404
    assert stranger.get(f"/api/hosted/profiles/{api['player_id']}/results").status_code == 403


def test_stopped_subscription_cannot_claim_or_download_the_manifest(api):
    owner, job = api["owner"], api["job"]
    owner.post(f"/api/hosted/jobs/{job['id']}/stop")

    assert owner.claim(job["id"]).status_code == 403
    assert owner.get(f"/api/hosted/jobs/{job['id']}/manifest").status_code == 403


def test_another_devices_lease_cannot_be_renewed_or_released(api):
    owner, job = api["owner"], api["job"]
    owner.claim(job["id"])
    other_device = BrowserClient(api["app"], api["storage"], owner.account_id, "device-cccccccccccccccc")
    other_device.token = owner.token

    renew = other_device.post(f"/api/hosted/jobs/{job['id']}/lease/renew", other_device.lease_body())
    other_device.post(f"/api/hosted/jobs/{job['id']}/lease/release", other_device.lease_body())

    assert renew.status_code == 409
    assert owner.get(f"/api/hosted/jobs/{job['id']}").json()["worker_active"] is True


def test_unknown_ids_are_not_found(api):
    unknown = "00000000-0000-0000-0000-000000000000"
    assert api["owner"].get(f"/api/hosted/jobs/{unknown}").status_code == 404
    assert api["owner"].post("/api/hosted/jobs", {"player_id": unknown}).status_code == 403


@pytest.mark.parametrize("device_id", ["short", "x" * 65, "bad device id!!!!!", ""])
def test_malformed_device_ids_are_rejected(api, device_id):
    response = api["owner"].post(f"/api/hosted/jobs/{api['job']['id']}/lease/claim",
                                 {"device_id": device_id})
    assert response.status_code == 422


def test_forged_identity_and_status_fields_are_rejected(api):
    owner, job = api["owner"], api["job"]
    forged = owner.post("/api/hosted/jobs", {"player_id": api["player_id"],
                                             "account_id": api["stranger"].account_id})
    status = owner.post(f"/api/hosted/jobs/{job['id']}/lease/claim",
                        {"device_id": DEVICE_A, "status": "succeeded"})

    assert forged.status_code == 422
    assert status.status_code == 422


def test_oversized_bodies_are_rejected_before_parsing(api):
    response = api["owner"].post("/api/hosted/profiles", {"username": "x" * 20_000})
    assert response.status_code == 413
    assert response.json()["code"] == "body_too_large"


def test_paid_slot_and_limit_errors_are_explicit(api):
    owner = api["owner"]
    response = owner.post("/api/hosted/profiles", {"username": "secondplayer"})
    assert response.status_code == 402 and response.json()["code"] == "subscription_required"
    subscribe(api["pg"], owner.account_id)
    assert owner.post("/api/hosted/profiles", {"username": "secondplayer"}).status_code == 201
    assert owner.post("/api/hosted/profiles", {"username": "ghostplayer"}).status_code == 404


def test_rate_limits_apply_per_account(pg):
    limiter = InMemoryRateLimiter({"claim": Limit(capacity=2, per_seconds=60)}, clock=lambda: 0.0)
    app, _, storage = hosted_app(pg, rate_limiter=limiter)
    client = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    job = client.join(client.claim_profile())

    codes = [client.claim(job["id"]).status_code for _ in range(3)]

    assert codes == [200, 200, 429]


def test_errors_never_leak_server_secrets(api):
    owner = api["owner"]
    responses = [
        owner.get("/api/hosted/jobs/not-a-uuid"),
        owner.post(f"/api/hosted/jobs/{api['job']['id']}/lease/renew",
                   {"device_id": DEVICE_A, "lease_token": "x" * 40}),
        owner.post(f"/api/hosted/jobs/{api['job']['id']}/uploads",
                   {"device_id": DEVICE_A, "lease_token": "x" * 40, "kind": "checkpoint",
                    "sequence": 1, "byte_size": 10, "content_hash": "a" * 64}),
    ]
    for response in responses:
        text = response.text
        assert "sb_secret" not in text
        assert "postgresql://" not in text
        assert jwt_for(owner.account_id)[:20] not in text
