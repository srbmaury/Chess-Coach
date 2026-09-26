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
