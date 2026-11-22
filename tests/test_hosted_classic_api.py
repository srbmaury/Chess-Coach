import pytest
from fastapi.testclient import TestClient
from hosted_factories import (
    DEVICE_A,
    DEVICE_B,
    BrowserClient,
    gzip_json,
    hosted_app,
    new_account,
    parity_puzzles,
    publish_results,
)

PUZZLES = parity_puzzles(6)


@pytest.fixture
def api(pg):
    app, services, storage = hosted_app(pg)
    user = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    return {"app": app, "services": services, "storage": storage, "user": user, "pg": pg}


def _published(api) -> str:
    user = api["user"]
    created = user.post("/api/profiles", {"username": "MagnusCarlsen", "activate": True})
    assert created.status_code == 201, created.text
    player_id = api["services"].practice.require_active(user.account_id).player_id
    publish_results(api["pg"], player_id, PUZZLES)
    return player_id


def test_classic_routes_require_a_session(api):
    client = TestClient(api["app"])
    for path in ("/api/profiles", "/api/dashboard", "/api/practice/next", "/api/progress"):
        assert client.get(path).status_code == 401, path


def test_profiles_match_the_local_player_bar_contract(api):
    user = api["user"]
    assert user.get("/api/profiles").json() == {"active_username": None, "profiles": []}

    created = user.post("/api/profiles", {"username": "MagnusCarlsen", "activate": True})
    assert created.status_code == 201
    assert created.json()["active_username"] == "magnuscarlsen"
    listed = user.get("/api/profiles").json()
    assert listed["active_username"] == "magnuscarlsen"
    assert [p["username"] for p in listed["profiles"]] == ["magnuscarlsen"]

    second = user.post("/api/profiles", {"username": "hikaru", "activate": True})
    assert second.status_code == 402 and "subscription" in second.json()["detail"]
    missing = user.post("/api/profiles/hikaru/activate")
    assert missing.status_code == 404
    assert user.post("/api/profiles/MagnusCarlsen/activate").json()["active_username"] == "magnuscarlsen"


def test_pages_explain_what_to_do_before_any_results(api):
    user = api["user"]
    assert user.get("/api/dashboard").status_code == 409
    user.post("/api/profiles", {"username": "magnuscarlsen"})

    dashboard = user.get("/api/dashboard").json()
    assert dashboard["analyzed_moves"] == 0
    assert dashboard["artifacts"]["analysis"]["exists"] is False
    blocked = user.get("/api/practice/next")
    assert blocked.status_code == 409 and "Pipeline" in blocked.json()["detail"]
    assert user.get("/api/report").status_code == 404


def test_quick_practice_flow(api):
    _published(api)
    user = api["user"]
    puzzle = user.get("/api/practice/next").json()["puzzle"]
    source = next(p for p in PUZZLES if p["puzzle_id"] == puzzle["puzzle_id"])
    assert puzzle["fen"] == source["fen_before"] and puzzle["orientation"] == source["color"]

    illegal = user.post(f"/api/practice/{puzzle['puzzle_id']}/attempt", {"move_uci": "a1a8"})
    assert illegal.status_code == 422
    answer = user.post(f"/api/practice/{puzzle['puzzle_id']}/attempt", {"move_uci": source["best_move_uci"]})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["correct"] is True and body["next_interval_days"] == 3
    assert body["best_move_san"] == source["best_move_san"]

    assert user.get("/api/practice/next").json()["puzzle"]["puzzle_id"] != puzzle["puzzle_id"]
    assert user.post(f"/api/practice/{puzzle['puzzle_id']}/skip").json() == {"skipped": True}
    assert user.post("/api/practice/unknown/skip").status_code == 404


def test_mistakes_list_detail_and_filters(api):
    _published(api)
    user = api["user"]
    listing = user.get("/api/puzzles?limit=4").json()
    assert listing["total"] == 6 and len(listing["items"]) == 4
    item = listing["items"][0]
    assert {"your_move_san", "best_move_uci", "evaluation_loss_pawns", "next_review_at", "mastered"} <= set(item)
    quality = PUZZLES[0]["quality"]
    filtered = user.get(f"/api/puzzles?quality={quality}").json()
    assert all(entry["quality"] == quality for entry in filtered["items"])
    assert user.get(f"/api/puzzles/{item['puzzle_id']}").json()["puzzle_id"] == item["puzzle_id"]
    assert user.get("/api/puzzles/unknown").status_code == 404


def test_adaptive_drill_outcome_updates_review_and_progress(api):
    _published(api)
    user = api["user"]
    puzzle = PUZZLES[0]
    body = {"succeeded": True, "answer": puzzle["best_move_uci"], "user_moves_accepted": 3,
            "current_ply": 5, "continuation_attempts": 2, "continuation_correct": 2}

    review = user.post(f"/api/practice/{puzzle['puzzle_id']}/adaptive/complete", body)
    assert review.status_code == 200, review.text
    assert review.json()["next_interval_days"] == 3 and review.json()["consecutive_correct"] == 1

    progress = user.get("/api/progress").json()
    assert progress["total_reviews"] == 1
    assert progress["adaptive"]["sessions_completed"] == 1
    assert progress["adaptive"]["average_calculation_depth_plies"] == 5.0
    assert len(progress["daily_reviews"]) == 1

    bad = dict(body, continuation_correct=3)
    assert user.post(f"/api/practice/{puzzle['puzzle_id']}/adaptive/complete", bad).status_code == 422
    illegal = dict(body, answer="a1a8")
    assert user.post(f"/api/practice/{puzzle['puzzle_id']}/adaptive/complete", illegal).status_code == 422
    forged = dict(body, account_id="someone-else")
    assert user.post(f"/api/practice/{puzzle['puzzle_id']}/adaptive/complete", forged).status_code == 422


def test_report_is_rendered_from_the_active_result(api):
    player_id = _published(api)
    key = "players/p/artifacts/report/rep.json.gz"
    api["storage"].put(key, gzip_json({"markdown": "# Chess ML Coach Report\n\n## Your priorities\n- **Opening**\n"}))
    with api["pg"].transaction() as connection:
        connection.execute(
            "INSERT INTO derived_artifacts (player_id, artifact_type, dependency_hash, schema_version, "
            "storage_bucket, storage_key, status) VALUES (%s, 'report', %s, '1', 'b', %s, 'ready')",
            (player_id, "d" * 64, key),
        )
    response = api["user"].get("/api/report")
    assert response.status_code == 200
    assert "<h2>Your priorities</h2>" in response.text
    assert api["user"].get("/api/dashboard").json()["artifacts"]["report"]["exists"] is True


def test_practice_state_is_private_per_account(api):
    _published(api)
    other = BrowserClient(api["app"], api["storage"], new_account(api["pg"]), DEVICE_B)
    other.post("/api/profiles", {"username": "magnuscarlsen"})
    puzzle = PUZZLES[0]
    api["user"].post(f"/api/practice/{puzzle['puzzle_id']}/attempt", {"move_uci": puzzle["best_move_uci"]})

    assert other.get("/api/progress").json()["total_reviews"] == 0
    assert api["user"].get("/api/progress").json()["total_reviews"] == 1
