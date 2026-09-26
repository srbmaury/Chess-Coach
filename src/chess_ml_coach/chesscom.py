from __future__ import annotations

import json
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

import httpx

from .config import Settings

API = "https://api.chess.com/pub"
ProgressCallback = Callable[[dict[str, object]], None]


DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024


class ChessComError(RuntimeError):
    pass


class ChessComNotFoundError(ChessComError):
    pass


class ChessComResponseTooLargeError(ChessComError):
    pass


@dataclass(frozen=True)
class ChessComPlayer:
    player_id: int | None
    username: str


@dataclass(frozen=True)
class SyncResult:
    downloaded: int
    existing: int
    total: int
    pgn_path: Path
    manifest_path: Path


class ChessComClient:
    def __init__(
        self,
        http: httpx.Client | None = None,
        retries: int = 3,
        *,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.http = http or httpx.Client(
            timeout=30,
            headers={"User-Agent": "chess-ml-coach/0.1"},
        )
        self.retries = retries
        self.max_response_bytes = max_response_bytes
        self._sleep = sleep

    def _bounded_body(self, response: httpx.Response, url: str) -> bytes:
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > self.max_response_bytes:
            raise ChessComResponseTooLargeError(f"Chess.com response too large: {url}")
        body = bytearray()
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > self.max_response_bytes:
                raise ChessComResponseTooLargeError(f"Chess.com response too large: {url}")
        return bytes(body)

    def _json(self, url: str, *, allow_unavailable: bool = False) -> dict | None:
        for attempt in range(self.retries + 1):
            with self.http.stream("GET", url) as response:
                if response.status_code < 400:
                    try:
                        return json.loads(self._bounded_body(response, url))
                    except ValueError as exc:
                        raise ChessComError(f"Chess.com returned invalid JSON: {url}") from exc
                status = response.status_code
            if allow_unavailable and status in {404, 410}:
                return None
            if status in {429, 500, 502, 503, 504} and attempt < self.retries:
                self._sleep(2**attempt)
                continue
            if status in {404, 410}:
                raise ChessComNotFoundError(f"Chess.com resource not found: {url}")
            raise ChessComError(f"Chess.com request failed: {status} {url}")
        raise AssertionError("unreachable")

    def player_profile(self, username: str) -> ChessComPlayer:
        data = self._json(f"{API}/player/{username}")
        if not isinstance(data, dict):
            raise ChessComError("Chess.com returned an invalid player profile")
        player_id = data.get("player_id")
        name = data.get("username") or username
        return ChessComPlayer(
            player_id=int(player_id) if isinstance(player_id, int) else None,
            username=str(name),
        )

    def archive_urls(self, username: str) -> list[str]:
        data = self._json(f"{API}/player/{username}/games/archives")
        if data is None:
            raise AssertionError("archive index cannot be unavailable")
        return data.get("archives", [])

    def games_for_archive(self, archive_url: str) -> list[dict] | None:
        data = self._json(archive_url, allow_unavailable=True)
        if data is None:
            return None
        return data.get("games", [])


def canonical_game_id(game: dict) -> str:
    url = game.get("url")
    if url:
        return str(url)
    return sha256(str(game.get("pgn", "")).encode("utf-8")).hexdigest()


def merge_games(existing: list[dict], incoming: list[dict]) -> list[dict]:
    by_id = {canonical_game_id(game): game for game in existing if game.get("pgn")}
    for game in incoming:
        if game.get("pgn"):
            by_id.setdefault(canonical_game_id(game), game)
    return [by_id[key] for key in sorted(by_id)]


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        temp_path = Path(handle.name)
    temp_path.replace(path)


def _load_games(path: Path) -> list[dict]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ChessComError(f"Invalid game cache format: {path}")
    return data


def _persist_sync(
    raw_dir: Path,
    username: str,
    games: list[dict],
    archives_done: list[str],
) -> tuple[Path, Path]:
    games_path = raw_dir / "games.json"
    pgn_path = raw_dir / f"{username}_all_games.pgn"
    manifest_path = raw_dir / "sync_manifest.json"

    _atomic_write_text(games_path, json.dumps(games, indent=2, sort_keys=True))
    pgn_text = "\n\n".join(str(game["pgn"]).rstrip() for game in games if game.get("pgn"))
    if pgn_text:
        pgn_text += "\n"
    _atomic_write_text(pgn_path, pgn_text)
    manifest = {
        "username": username,
        "archives_completed": archives_done,
        "game_count": len(games),
    }
    _atomic_write_text(manifest_path, json.dumps(manifest, indent=2, sort_keys=True))
    return pgn_path, manifest_path


def sync_games(
    client: ChessComClient,
    settings: Settings,
    *,
    progress: ProgressCallback | None = None,
) -> SyncResult:
    raw_dir = settings.data_dir / "raw"
    games_path = raw_dir / "games.json"
    existing_games = _load_games(games_path)
    existing_count = len(existing_games)
    games = list(existing_games)
    archives_done: list[str] = []
    archives = client.archive_urls(settings.username)

    for current, archive_url in enumerate(archives, start=1):
        archive_games = client.games_for_archive(archive_url)
        skipped = archive_games is None
        if archive_games is not None:
            games = merge_games(games, archive_games)
            archives_done.append(archive_url)
            pgn_path, manifest_path = _persist_sync(
                raw_dir,
                settings.username,
                games,
                archives_done,
            )
        if progress is not None:
            progress(
                {
                    "stage": "sync",
                    "current": current,
                    "total": len(archives),
                    "archive": archive_url,
                    "game_count": len(games),
                    "skipped": skipped,
                }
            )

    if not archives_done:
        pgn_path, manifest_path = _persist_sync(raw_dir, settings.username, games, archives_done)

    return SyncResult(
        downloaded=max(0, len(games) - existing_count),
        existing=existing_count,
        total=len(games),
        pgn_path=pgn_path,
        manifest_path=manifest_path,
    )
