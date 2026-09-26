"""Canonical, immutable game manifests for hosted shared analysis.

A manifest is the exact input every browser worker analyzes: the player's games in
a deterministic order, each reduced to metadata plus its UCI move list. It is built
in memory (never written to the Render filesystem) and hashed over canonical JSON, so
two builds of the same game set share one hash, one Storage object, and one job.
"""

from __future__ import annotations

import gzip
import io
import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256

import chess
import chess.pgn
import pandas as pd

from ..chesscom import ChessComClient
from ..pgn import _game_date, _game_id, _opening_name, _parse_bool, _parse_int
from .profiles import Player

LOGGER = logging.getLogger(__name__)

MANIFEST_SCHEMA_VERSION = 1
DEFAULT_MAX_GAMES = 5000
MANIFEST_MAX_AGE = timedelta(hours=6)


class ManifestError(RuntimeError):
    code = "manifest_error"


class EmptyManifestError(ManifestError):
    code = "no_games"


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


@dataclass(frozen=True)
class ManifestGame:
    game_id: str
    user_color: str
    game_date: str | None
    white: str
    black: str
    white_rating: int | None
    black_rating: int | None
    result: str | None
    time_control: str | None
    rated: bool | None
    eco: str | None
    opening: str | None
    source_url: str | None
    moves: tuple[str, ...]
    clocks: tuple[float | None, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "game_id": self.game_id,
            "user_color": self.user_color,
            "game_date": self.game_date,
            "white": self.white,
            "black": self.black,
            "white_rating": self.white_rating,
            "black_rating": self.black_rating,
            "result": self.result,
            "time_control": self.time_control,
            "rated": self.rated,
            "eco": self.eco,
            "opening": self.opening,
            "source_url": self.source_url,
            "moves": list(self.moves),
            "clocks": list(self.clocks),
        }

    def user_plies(self) -> tuple[int, ...]:
        first = 1 if self.user_color == "white" else 2
        return tuple(range(first, len(self.moves) + 1, 2))


@dataclass(frozen=True)
class GameManifest:
    player_id: str
    canonical_username: str
    games: tuple[ManifestGame, ...]
    available_games: int
    canonical_bytes: bytes
    hash: str

    @property
    def storage_key(self) -> str:
        return manifest_storage_key(self.player_id, self.hash)

    def compressed(self) -> bytes:
        # mtime=0 keeps the compressed object byte-stable for identical manifests.
        return gzip.compress(self.canonical_bytes, compresslevel=6, mtime=0)


def manifest_storage_key(player_id: str, manifest_hash: str) -> str:
    return f"players/{player_id}/manifests/{manifest_hash}.json.gz"


def parse_game(pgn_text: str, username: str) -> ManifestGame | None:
    """Parse one Chess.com PGN into a manifest game, or ``None`` if unusable."""
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:  # noqa: BLE001 - malformed third-party PGNs are skipped
        return None
    if game is None or game.errors:
        return None
    headers = game.headers
    white = str(headers.get("White", ""))
    black = str(headers.get("Black", ""))
    folded = username.casefold()
    if white.casefold() == folded:
        color = "white"
    elif black.casefold() == folded:
        color = "black"
    else:
        return None
    if game.board().fen() != chess.STARTING_FEN:
        return None
    moves: list[str] = []
    clocks: list[float | None] = []
    for node in game.mainline():
        moves.append(node.move.uci())
        clock = node.clock()
        clocks.append(float(clock) if clock is not None else None)
    parsed_date = _game_date(headers)
    return ManifestGame(
        game_id=_game_id(game),
        user_color=color,
        game_date=None if pd.isna(parsed_date) else parsed_date.date().isoformat(),
        white=white,
        black=black,
        white_rating=_parse_int(headers.get("WhiteElo")),
        black_rating=_parse_int(headers.get("BlackElo")),
        result=headers.get("Result"),
        time_control=headers.get("TimeControl"),
        rated=_parse_bool(headers.get("Rated")),
        eco=headers.get("ECO"),
        opening=_opening_name(headers),
        source_url=headers.get("Link") or headers.get("Site"),
        moves=tuple(moves),
        clocks=tuple(clocks),
    )


def build_manifest(
    player: Player,
    raw_games: Iterable[dict],
    *,
    max_games: int = DEFAULT_MAX_GAMES,
) -> GameManifest:
    by_id: dict[str, ManifestGame] = {}
    seen_pgn: set[str] = set()
    for raw in raw_games:
        pgn_text = raw.get("pgn")
        if not isinstance(pgn_text, str) or not pgn_text.strip():
            continue
        pgn_hash = sha256(pgn_text.encode("utf-8")).hexdigest()
        if pgn_hash in seen_pgn:
            continue
        seen_pgn.add(pgn_hash)
        game = parse_game(pgn_text, player.canonical_username)
        if game is not None:
            by_id.setdefault(game.game_id, game)
    if not by_id:
        raise EmptyManifestError("No analyzable games were found for this player")
    # Keep the most recent games when a player exceeds the hosted bound.
    recent = sorted(by_id.values(), key=lambda item: (item.game_date or "", item.game_id))
    kept = recent[-max_games:]
    games = tuple(sorted(kept, key=lambda item: item.game_id))
    document = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "player": {"canonical_username": player.canonical_username},
        "available_games": len(by_id),
        "games": [game.as_dict() for game in games],
    }
    body = canonical_json(document)
    return GameManifest(
        player_id=player.id,
        canonical_username=player.canonical_username,
        games=games,
        available_games=len(by_id),
        canonical_bytes=body,
        hash=sha256(body).hexdigest(),
    )


def parse_manifest_bytes(player_id: str, body: bytes) -> GameManifest:
    """Rebuild a manifest from its canonical JSON (for server-side validation)."""
    document = json.loads(body)
    games = tuple(
        ManifestGame(
            game_id=item["game_id"],
            user_color=item["user_color"],
            game_date=item["game_date"],
            white=item["white"],
            black=item["black"],
            white_rating=item["white_rating"],
            black_rating=item["black_rating"],
            result=item["result"],
            time_control=item["time_control"],
            rated=item["rated"],
            eco=item["eco"],
            opening=item["opening"],
            source_url=item["source_url"],
            moves=tuple(item["moves"]),
            clocks=tuple(item["clocks"]),
        )
        for item in document["games"]
    )
    return GameManifest(
        player_id=player_id,
        canonical_username=document["player"]["canonical_username"],
        games=games,
        available_games=int(document["available_games"]),
        canonical_bytes=body,
        hash=sha256(body).hexdigest(),
    )


class ManifestService:
    def __init__(self, client: ChessComClient, *, max_games: int = DEFAULT_MAX_GAMES):
        self._client = client
        self._max_games = max_games

    @staticmethod
    def is_fresh(player: Player, now: datetime, *, max_age: timedelta = MANIFEST_MAX_AGE) -> bool:
        return (
            player.latest_manifest_hash is not None
            and player.latest_manifest_at is not None
            and now - player.latest_manifest_at < max_age
        )

    def _raw_games(self, username: str) -> Iterable[dict]:
        # Archives are fetched serially and discarded after parsing, bounding memory.
        for archive_url in self._client.archive_urls(username):
            games = self._client.games_for_archive(archive_url)
            if games:
                yield from games

    def build(self, player: Player) -> GameManifest:
        return build_manifest(
            player, self._raw_games(player.canonical_username), max_games=self._max_games
        )
