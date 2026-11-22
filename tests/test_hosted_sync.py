import pytest
from hosted_factories import DEVICE_A, BrowserClient, hosted_app, new_account

from chess_ml_coach.hosted.sync import SyncBusyError


def test_a_second_sync_while_one_runs_is_refused(pg):
    pending = []
    app, services, storage = hosted_app(pg)
    services.sync._runner = pending.append  # hold the background task
    user = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    player_id = user.claim_profile()

    assert user.post(f"/api/hosted/players/{player_id}/sync").json()["status"] == "running"
    busy = user.post(f"/api/hosted/players/{player_id}/sync")
    assert busy.status_code == 409 and busy.json()["code"] == "sync_running"

    pending[0]()
    assert user.get(f"/api/hosted/players/{player_id}/pipeline").json()["sync"]["status"] == "succeeded"


def test_a_player_without_games_fails_with_a_clear_message(pg):
    app, _services, storage = hosted_app(pg, games=[])
    user = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    player_id = user.claim_profile()
    user.sync(player_id)

    sync = user.get(f"/api/hosted/players/{player_id}/pipeline").json()["sync"]
    assert sync["status"] == "failed"
    assert sync["error"] == "No analyzable games were found for this player"


def test_an_interrupted_sync_is_reported_and_can_run_again(pg):
    app, services, storage = hosted_app(pg)
    user = BrowserClient(app, storage, new_account(pg), DEVICE_A)
    player_id = user.claim_profile()
    with pg.transaction() as connection:
        connection.execute(
            "UPDATE players SET sync_status = 'running', sync_started_at = now() - interval '1 hour' "
            "WHERE id = %s", (player_id,),
        )

    stale = user.get(f"/api/hosted/players/{player_id}/pipeline").json()["sync"]
    assert stale["status"] == "failed" and "interrupted" in stale["error"]
    user.sync(player_id)
    assert user.get(f"/api/hosted/players/{player_id}/pipeline").json()["sync"]["status"] == "succeeded"
    with pytest.raises(SyncBusyError):
        with pg.transaction() as connection:
            connection.execute("UPDATE players SET sync_status = 'running', sync_started_at = now() WHERE id = %s", (player_id,))
        services.sync.start(services.profiles.require_entitled(user.account_id, player_id))
