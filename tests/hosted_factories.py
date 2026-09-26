"""Helpers shared by live hosted-database tests."""

from __future__ import annotations

import uuid

from chess_ml_coach.chesscom import ChessComNotFoundError, ChessComPlayer


def new_account(pg, email: str | None = None) -> str:
    account_id = str(uuid.uuid4())
    with pg.transaction() as connection:
        connection.execute(
            "INSERT INTO accounts (id, email) VALUES (%s, %s)",
            (account_id, email or f"{account_id}@example.test"),
        )
    return account_id


def subscribe(pg, account_id: str, status: str = "active") -> None:
    with pg.transaction() as connection:
        connection.execute(
            "INSERT INTO subscriptions (account_id, stripe_subscription_id, stripe_price_id, status) "
            "VALUES (%s, %s, 'price', %s)",
            (account_id, f"sub_{uuid.uuid4().hex}", status),
        )


class FakePlayerLookup:
    def __init__(self, players: dict[str, int] | None = None):
        self.players = players or {}
        self.calls: list[str] = []

    def __call__(self, username: str) -> ChessComPlayer:
        self.calls.append(username)
        if username not in self.players:
            if self.players:
                raise ChessComNotFoundError("missing")
            return ChessComPlayer(player_id=abs(hash(username)) % 10_000_000, username=username)
        return ChessComPlayer(player_id=self.players[username], username=username.title())


def entitled_player(pg, account_id: str, username: str = "magnuscarlsen") -> str:
    from chess_ml_coach.hosted.profiles import ProfileRepository

    return ProfileRepository(pg, player_lookup=FakePlayerLookup()).claim(account_id, username).player.id


def hosted_config():
    from chess_ml_coach.hosted.analysis_config import HostedAnalysisConfig

    return HostedAnalysisConfig(
        depth=12, inaccuracy_cpl=50, mistake_cpl=100, blunder_cpl=200, min_group_size=10
    )


def create_job(pg, account_id: str, player_id: str, *, manifest_hash: str = "m" * 64,
               total_units: int = 4, can_compute: bool = True):
    from chess_ml_coach.hosted.jobs import JobRepository

    repository = JobRepository(pg)
    config = hosted_config()
    return repository.create_or_join(
        account_id=account_id,
        player_id=player_id,
        config_id=repository.ensure_config(config),
        engine_build_hash=config.engine_build_hash,
        manifest_hash=manifest_hash,
        manifest_storage_key=f"players/{player_id}/manifests/{manifest_hash}.json.gz",
        total_units=total_units,
        can_compute=can_compute,
    )


def expire_lease(pg, job_id: str) -> None:
    with pg.transaction() as connection:
        connection.execute(
            "UPDATE analysis_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (job_id,),
        )


DEVICE_A = "device-aaaaaaaaaaaaaaaa"
DEVICE_B = "device-bbbbbbbbbbbbbbbb"
