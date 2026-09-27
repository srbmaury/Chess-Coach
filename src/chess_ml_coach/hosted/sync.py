"""The hosted Sync stage: fetch a player's Chess.com games in the background.

Sync is shared by everyone studying the player and runs in a server thread, so it
keeps going if the page that started it reloads or closes. Progress and the outcome
are stored on the player row for any page to read.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from psycopg.types.json import Jsonb

from ..chesscom import ChessComError
from .database import Database
from .manifests import ManifestError, ManifestService
from .profiles import Player, ProfileRepository

LOGGER = logging.getLogger(__name__)
# A sync still marked running after this long was interrupted (e.g. by a restart).
STALE_AFTER = timedelta(minutes=20)

Runner = Callable[[Callable[[], None]], None]


def _thread_runner(task: Callable[[], None]) -> None:
    threading.Thread(target=task, name="chess-sync", daemon=True).start()


class SyncBusyError(RuntimeError):
    code = "sync_running"


@dataclass(frozen=True)
class SyncState:
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    progress: dict
    game_count: int | None
    synced_at: datetime | None


class SyncService:
    def __init__(
        self,
        database: Database,
        manifests: ManifestService,
        store_manifest: Callable,
        profiles: ProfileRepository,
        *,
        runner: Runner = _thread_runner,
    ):
        self._database = database
        self._manifests = manifests
        self._store_manifest = store_manifest
        self._profiles = profiles
        self._runner = runner

    def state(self, player_id: str) -> SyncState:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT sync_status, sync_started_at, sync_finished_at, sync_error, sync_progress, "
                "latest_manifest_game_count, latest_manifest_at, "
                "sync_status = 'running' AND sync_started_at < now() - make_interval(secs => %s) "
                "FROM players WHERE id = %s",
                (STALE_AFTER.total_seconds(), player_id),
            ).fetchone()
        status = "failed" if row[7] else row[0]
        error = "Sync was interrupted; run it again" if row[7] else row[3]
        return SyncState(status, row[1], row[2], error, row[4] or {}, row[5], row[6])

    def start(self, player: Player) -> SyncState:
        with self._database.transaction() as connection:
            claimed = connection.execute(
                "UPDATE players SET sync_status = 'running', sync_started_at = now(), "
                "sync_finished_at = NULL, sync_error = NULL, sync_progress = '{}'::jsonb "
                "WHERE id = %s AND (sync_status <> 'running' "
                "OR sync_started_at < now() - make_interval(secs => %s)) RETURNING 1",
                (player.id, STALE_AFTER.total_seconds()),
            ).fetchone()
        if claimed is None:
            raise SyncBusyError("Sync is already running for this player")
        self._runner(lambda: self._run(player))
        return self.state(player.id)

    def _update(self, player_id: str, sql: str, params: tuple) -> None:
        with self._database.transaction() as connection:
            connection.execute(f"UPDATE players SET {sql} WHERE id = %s", (*params, player_id))

    def _run(self, player: Player) -> None:
        def progress(current: int, total: int) -> None:
            self._update(player.id, "sync_progress = %s", (Jsonb({"current": current, "total": total}),))

        try:
            manifest = self._manifests.build(player, progress=progress)
            self._store_manifest(manifest)
            self._profiles.record_manifest(
                player.id,
                manifest_hash=manifest.hash,
                storage_key=manifest.storage_key,
                game_count=len(manifest.games),
                built_at=datetime.now(UTC),
            )
            self._update(
                player.id,
                "sync_status = 'succeeded', sync_finished_at = now()",
                (),
            )
        except Exception as exc:  # Any failure must end the running state.
            if isinstance(exc, ManifestError):
                message = str(exc)
            elif isinstance(exc, ChessComError):
                message = "Chess.com is temporarily unavailable; try again later"
            else:
                LOGGER.exception("Sync failed for player %s", player.id)
                message = "Sync failed; try again"
            self._update(
                player.id,
                "sync_status = 'failed', sync_finished_at = now(), sync_error = %s",
                (message,),
            )
