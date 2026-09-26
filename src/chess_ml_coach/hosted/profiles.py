"""Account profile entitlements for shared hosted players.

Every account gets one immutable free profile. An active or trialing paid
subscription adds up to five paid profiles; when the subscription lapses those
paid profiles become read-only (completed results stay visible, new computation
is refused).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from ..chesscom import ChessComNotFoundError, ChessComPlayer
from .database import Database

MAX_PAID_PROFILES = 5
ENTITLING_SUBSCRIPTION_STATUSES = ("active", "trialing")
_USERNAME = re.compile(r"^[a-z0-9_-]{3,25}$")


class ProfileError(RuntimeError):
    code = "profile_error"


class InvalidUsernameError(ProfileError):
    code = "invalid_username"


class UnknownPlayerError(ProfileError):
    code = "unknown_player"


class PaidSubscriptionRequiredError(ProfileError):
    code = "subscription_required"


class ProfileLimitError(ProfileError):
    code = "profile_limit"


class NotEntitledError(ProfileError):
    code = "not_entitled"


@dataclass(frozen=True)
class Player:
    id: str
    canonical_username: str
    display_username: str
    chesscom_player_id: int | None
    latest_manifest_hash: str | None = None
    latest_manifest_key: str | None = None
    latest_manifest_game_count: int | None = None
    latest_manifest_at: datetime | None = None


@dataclass(frozen=True)
class AccountProfile:
    id: str
    account_id: str
    player: Player
    slot_type: str
    state: str

    @property
    def can_compute(self) -> bool:
        return self.state == "active"


PlayerLookup = Callable[[str], ChessComPlayer]

_PLAYER_COLUMNS = (
    "p.id, p.canonical_username, p.display_username, p.chesscom_player_id, "
    "p.latest_manifest_hash, p.latest_manifest_key, p.latest_manifest_game_count, "
    "p.latest_manifest_at"
)

# A paid slot is only writable while the account has an entitling subscription.
_EFFECTIVE_STATE = """
CASE
    WHEN ap.state = 'active' AND ap.slot_type = 'paid' AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.account_id = ap.account_id AND s.status IN ('active', 'trialing')
    ) THEN 'read_only'
    ELSE ap.state
END
"""


def normalize_username(username: str) -> str:
    normalized = username.strip().lower()
    if not _USERNAME.fullmatch(normalized):
        raise InvalidUsernameError("Enter a valid Chess.com username")
    return normalized


def _player(row) -> Player:
    return Player(
        id=str(row[0]),
        canonical_username=row[1],
        display_username=row[2],
        chesscom_player_id=row[3],
        latest_manifest_hash=row[4],
        latest_manifest_key=row[5],
        latest_manifest_game_count=row[6],
        latest_manifest_at=row[7],
    )


def _profile(row) -> AccountProfile:
    return AccountProfile(
        id=str(row[0]),
        account_id=str(row[1]),
        slot_type=row[2],
        state=row[3],
        player=_player(row[4:]),
    )


class ProfileRepository:
    def __init__(self, database: Database, *, player_lookup: PlayerLookup):
        self._database = database
        self._lookup = player_lookup

    def list(self, account_id: str) -> list[AccountProfile]:
        with self._database.transaction() as connection:
            rows = connection.execute(
                f"SELECT ap.id, ap.account_id, ap.slot_type, {_EFFECTIVE_STATE}, {_PLAYER_COLUMNS} "
                "FROM account_profiles ap JOIN players p ON p.id = ap.player_id "
                "WHERE ap.account_id = %s AND ap.state <> 'removed' "
                "ORDER BY ap.slot_type DESC, ap.created_at, ap.id",
                (account_id,),
            ).fetchall()
        return [_profile(row) for row in rows]

    def _resolve_player(self, connection, username: str) -> Player | None:
        row = connection.execute(
            f"SELECT {_PLAYER_COLUMNS} FROM players p WHERE p.canonical_username = %s",
            (username,),
        ).fetchone()
        return _player(row) if row else None

    def _upsert_player(self, username: str, remote: ChessComPlayer) -> Player:
        with self._database.transaction() as connection:
            if remote.player_id is not None:
                # Prefer the stable Chess.com id so a renamed account keeps its shared player.
                row = connection.execute(
                    "UPDATE players SET canonical_username = %s, display_username = %s "
                    "WHERE chesscom_player_id = %s "
                    f"RETURNING {_PLAYER_COLUMNS.replace('p.', '')}",
                    (username, remote.username, remote.player_id),
                ).fetchone()
                if row:
                    return _player(row)
            row = connection.execute(
                "INSERT INTO players (canonical_username, display_username, chesscom_player_id) "
                "VALUES (%s, %s, %s) "
                "ON CONFLICT (canonical_username) DO UPDATE SET "
                "display_username = excluded.display_username, "
                "chesscom_player_id = COALESCE(players.chesscom_player_id, "
                "excluded.chesscom_player_id) "
                f"RETURNING {_PLAYER_COLUMNS.replace('p.', '')}",
                (username, remote.username, remote.player_id),
            ).fetchone()
        return _player(row)

    def claim(self, account_id: str, username: str) -> AccountProfile:
        canonical = normalize_username(username)
        with self._database.transaction() as connection:
            player = self._resolve_player(connection, canonical)
        if player is None:
            # Network lookup happens outside any transaction or row lock.
            try:
                remote = self._lookup(canonical)
            except ChessComNotFoundError as exc:
                raise UnknownPlayerError("That Chess.com player does not exist") from exc
            player = self._upsert_player(canonical, remote)

        with self._database.transaction() as connection:
            # Serialize slot decisions per account.
            connection.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account_id,))
            existing = connection.execute(
                f"SELECT ap.id, ap.account_id, ap.slot_type, {_EFFECTIVE_STATE}, {_PLAYER_COLUMNS} "
                "FROM account_profiles ap JOIN players p ON p.id = ap.player_id "
                "WHERE ap.account_id = %s AND ap.player_id = %s AND ap.state <> 'removed'",
                (account_id, player.id),
            ).fetchone()
            if existing:
                return _profile(existing)
            has_free = connection.execute(
                "SELECT 1 FROM account_profiles WHERE account_id = %s "
                "AND slot_type = 'free' AND state <> 'removed'",
                (account_id,),
            ).fetchone()
            slot = "paid" if has_free else "free"
            if slot == "paid":
                entitled = connection.execute(
                    "SELECT 1 FROM subscriptions WHERE account_id = %s AND status = ANY(%s)",
                    (account_id, list(ENTITLING_SUBSCRIPTION_STATUSES)),
                ).fetchone()
                if not entitled:
                    raise PaidSubscriptionRequiredError(
                        "Additional players require an active subscription"
                    )
                paid = connection.execute(
                    "SELECT count(*) FROM account_profiles WHERE account_id = %s "
                    "AND slot_type = 'paid' AND state <> 'removed'",
                    (account_id,),
                ).fetchone()[0]
                if paid >= MAX_PAID_PROFILES:
                    raise ProfileLimitError(
                        f"Your subscription includes {MAX_PAID_PROFILES} additional players"
                    )
            row = connection.execute(
                "INSERT INTO account_profiles (account_id, player_id, slot_type) "
                "VALUES (%s, %s, %s) RETURNING id, account_id, slot_type, state",
                (account_id, player.id, slot),
            ).fetchone()
        return AccountProfile(
            id=str(row[0]), account_id=str(row[1]), slot_type=row[2], state=row[3], player=player
        )

    def require_entitled(self, account_id: str, player_id: str, *, write: bool = True) -> Player:
        """Return the player when the account may read it (and, with ``write``, compute)."""
        with self._database.transaction() as connection:
            row = connection.execute(
                f"SELECT ap.id, ap.account_id, ap.slot_type, {_EFFECTIVE_STATE}, {_PLAYER_COLUMNS} "
                "FROM account_profiles ap JOIN players p ON p.id = ap.player_id "
                "WHERE ap.account_id = %s AND ap.player_id = %s AND ap.state <> 'removed'",
                (account_id, player_id),
            ).fetchone()
        if row is None:
            raise NotEntitledError("This player is not on your account")
        profile = _profile(row)
        if write and not profile.can_compute:
            raise NotEntitledError("This player is read-only until your subscription is renewed")
        return profile.player

    def record_manifest(
        self,
        player_id: str,
        *,
        manifest_hash: str,
        storage_key: str,
        game_count: int,
        built_at: datetime,
    ) -> Player:
        """Record a newly built manifest unless a newer one was recorded meanwhile."""
        with self._database.transaction() as connection:
            connection.execute(
                "UPDATE players SET latest_manifest_hash = %s, latest_manifest_key = %s, "
                "latest_manifest_game_count = %s, latest_manifest_at = %s, last_synced_at = %s "
                "WHERE id = %s AND (latest_manifest_at IS NULL OR latest_manifest_at < %s)",
                (manifest_hash, storage_key, game_count, built_at, built_at, player_id, built_at),
            )
            row = connection.execute(
                f"SELECT {_PLAYER_COLUMNS} FROM players p WHERE p.id = %s", (player_id,)
            ).fetchone()
        return _player(row)
