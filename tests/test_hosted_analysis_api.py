import pytest
from hosted_factories import (
    DEVICE_A,
    DEVICE_B,
    BrowserClient,
    expire_lease,
    hosted_app,
    new_account,
)


@pytest.fixture
def api(pg):
    app, services, storage = hosted_app(pg)
    first = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    second = BrowserClient(app, storage, new_account(pg), DEVICE_B)
    return {"app": app, "services": services, "storage": storage, "first": first,
            "second": second, "pg": pg}


def test_profile_claim_and_listing(api):
    player_id = api["first"].claim_profile("MagnusCarlsen")

    listing = api["first"].get("/api/hosted/profiles").json()

    assert listing["analysis_enabled"] is True
    [profile] = listing["profiles"]
    assert profile["player_id"] == player_id
    assert profile["slot_type"] == "free"
    assert profile["latest_job"] is None
    assert profile["has_results"] is False


def test_create_join_observe_and_manifest(api):
    first, second = api["first"], api["second"]
    player_id = first.claim_profile()
    second.claim_profile()

    created = first.join(player_id)
    joined = second.join(player_id, can_compute=False)

    assert created["id"] == joined["id"]
    assert created["total_units"] == 3
    assert created["compute_source"] == "community_computed"
    assert joined["subscription_state"] == "active" and joined["can_compute"] is False
    manifest = first.get(f"/api/hosted/jobs/{created['id']}/manifest")
    assert manifest.status_code == 200
    assert manifest.headers["etag"] == f'"{created["manifest_hash"]}"'
    body = manifest.json()
    assert body["analysis_config_hash"] == created["analysis_config_hash"]
    assert body["analysis_config"]["engine"]["flavor"] == "lite-single"
    assert len(first.manifest_games(created["id"])) == 3


def test_sync_runs_on_request_and_reports_progress(api):
    first = api["first"]
    player_id = first.claim_profile()
    before = first.get(f"/api/hosted/players/{player_id}/pipeline").json()
    assert before["sync"]["status"] == "idle" and before["total_games"] == 0
    assert first.post(f"/api/hosted/players/{player_id}/analysis", {}).status_code == 409

    synced = first.sync(player_id)
    after = first.get(f"/api/hosted/players/{player_id}/pipeline").json()

    assert synced["status"] in {"running", "succeeded"}
    assert after["sync"]["status"] == "succeeded"
    assert (after["sync"]["current"], after["sync"]["total"]) == (1, 1)
    assert after["sync"]["game_count"] == 3 and after["total_games"] == 3
    assert after["analyzed_games"] == 0 and after["dependency_hash"] is None


def test_each_depth_is_its_own_shared_analysis(api):
    first = api["first"]
    player_id = first.claim_profile()
    first.sync(player_id)
    default = first.analyze(player_id)
    deeper = first.analyze(player_id, depth=16)

    assert default["id"] != deeper["id"]
    assert default["analysis_config_hash"] != deeper["analysis_config_hash"]
    manifest = first.get(f"/api/hosted/jobs/{deeper['id']}/manifest").json()
    assert manifest["analysis_config"]["depth"] == 16
    assert first.post(f"/api/hosted/players/{player_id}/analysis", {"depth": 40}).status_code == 422


def test_lease_grant_renew_release_over_http(api):
    first, second = api["first"], api["second"]
    player_id = first.claim_profile()
    second.claim_profile()
    job = first.join(player_id)
    second.join(player_id)

    granted = first.claim(job["id"])
    assert granted.status_code == 200
    assert granted.json()["lease_seconds"] == 60
    assert granted.json()["renew_interval_seconds"] == 20
    blocked = second.claim(job["id"])
    assert blocked.status_code == 409 and blocked.json()["code"] == "lease_unavailable"
    observed = second.get(f"/api/hosted/jobs/{job['id']}").json()
    assert observed["status"] == "running" and observed["worker_active"] is True

    renewed = first.post(f"/api/hosted/jobs/{job['id']}/lease/renew", first.lease_body())
    assert renewed.status_code == 200 and renewed.json()["lease_token"] == first.token
    released = first.post(f"/api/hosted/jobs/{job['id']}/lease/release", first.lease_body())
    assert released.status_code == 204
    assert second.claim(job["id"]).status_code == 200


def test_expired_lease_takeover_rejects_the_stale_worker(api):
    first, second = api["first"], api["second"]
    player_id = first.claim_profile()
    second.claim_profile()
    job = first.join(player_id)
    second.join(player_id)
    first.claim(job["id"])
    stale = first.lease_body()

    expire_lease(api["pg"], job["id"])
    assert second.claim(job["id"]).status_code == 200

    response = first.post(f"/api/hosted/jobs/{job['id']}/lease/renew", stale)
    assert response.status_code == 409 and response.json()["code"] == "lease_lost"


def test_stop_keeps_other_subscribers_and_completed_features(api):
    first, second = api["first"], api["second"]
    player_id = first.claim_profile()
    second.claim_profile()
    job = first.join(player_id)
    second.join(player_id)
    first.claim(job["id"])

    stopped = first.post(f"/api/hosted/jobs/{job['id']}/stop").json()

    assert stopped["subscription_state"] == "stopped"
    assert stopped["worker_active"] is False
    assert second.get(f"/api/hosted/jobs/{job['id']}").json()["subscription_state"] == "active"
    assert first.get(f"/api/hosted/players/{player_id}/pipeline").status_code == 200


def test_compute_opt_out_makes_a_browser_observer_only(api):
    first = api["first"]
    job = first.join(first.claim_profile())
    first.claim(job["id"])

    opted_out = first.post(f"/api/hosted/jobs/{job['id']}/compute", {"can_compute": False})

    assert opted_out.json()["can_compute"] is False and opted_out.json()["worker_active"] is False
    response = first.claim(job["id"])
    assert response.status_code == 403 and response.json()["code"] == "observer_only"


def test_disabled_feature_flag_blocks_analysis_but_not_profiles(pg):
    app, _, storage = hosted_app(pg, enabled=False)
    client = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    player_id = client.claim_profile()

    response = client.post(f"/api/hosted/players/{player_id}/sync")

    assert response.status_code == 503 and response.json()["code"] == "analysis_disabled"
    assert client.get("/api/hosted/profiles").json()["analysis_enabled"] is False


def test_openapi_schema_generates(api):
    paths = api["app"].openapi()["paths"]
    assert "/api/hosted/jobs/{job_id}/lease/claim" in paths
    assert "/api/hosted/jobs/{job_id}/checkpoints/finalize" in paths


def test_analysis_survives_its_config_rows_being_cleared(api):
    first = api["first"]
    player_id = first.claim_profile()
    first.join(player_id)
    # An operator clears the analysis data while the server keeps running.
    with api["pg"].transaction() as connection:
        connection.execute("DELETE FROM job_units")
        connection.execute("DELETE FROM job_subscribers")
        connection.execute("DELETE FROM analysis_jobs")
        connection.execute("DELETE FROM analysis_configs")

    response = first.post(f"/api/hosted/players/{player_id}/analysis", {})

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "queued"
