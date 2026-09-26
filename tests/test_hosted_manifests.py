import builtins
import gzip
import json

import httpx
import pytest

from chess_ml_coach.chesscom import ChessComClient, ChessComResponseTooLargeError
from chess_ml_coach.hosted.manifests import (
    EmptyManifestError,
    ManifestService,
    build_manifest,
    parse_manifest_bytes,
)
from chess_ml_coach.hosted.profiles import Player

PLAYER = Player(id="player-1", canonical_username="srbmaury", display_username="srbmaury",
                chesscom_player_id=1)


def _pgn(site: str, white: str, black: str, moves: str, date: str = "2026.09.01") -> str:
    return (
        f'[Event "Live Chess"]\n[Site "{site}"]\n[Date "{date}"]\n[White "{white}"]\n'
        f'[Black "{black}"]\n[Result "*"]\n[TimeControl "600"]\n[ECO "C20"]\n'
        f'[Link "{site}"]\n\n{moves} *'
    )


GAME_A = {"pgn": _pgn("https://www.chess.com/game/live/1", "srbmaury", "opp",
                      "1. e4 {[%clk 0:09:59.9]} e5 {[%clk 0:10:00]} 2. Nf3", "2026.09.02")}
GAME_B = {"pgn": _pgn("https://www.chess.com/game/live/2", "opp", "SRBMAURY", "1. d4 d5 2. c4")}


def test_manifest_is_deterministic_regardless_of_archive_order():
    first = build_manifest(PLAYER, [GAME_A, GAME_B])
    second = build_manifest(PLAYER, [GAME_B, GAME_A])

    assert first.hash == second.hash
    assert first.canonical_bytes == second.canonical_bytes
    assert [game.game_id for game in first.games] == sorted(game.game_id for game in first.games)
    assert first.storage_key == f"players/player-1/manifests/{first.hash}.json.gz"


def test_manifest_games_capture_color_moves_clocks_and_user_plies():
    manifest = build_manifest(PLAYER, [GAME_A, GAME_B])
    by_id = {game.game_id: game for game in manifest.games}
    a = by_id["https://www.chess.com/game/live/1"]
    b = by_id["https://www.chess.com/game/live/2"]

    assert a.user_color == "white" and a.moves == ("e2e4", "e7e5", "g1f3")
    assert a.clocks == (599.9, 600.0, None)
    assert a.user_plies() == (1, 3)
    assert a.game_date == "2026-09-02"
    assert b.user_color == "black" and b.user_plies() == (2,)


def test_duplicate_pgns_are_deduplicated():
    assert len(build_manifest(PLAYER, [GAME_A, GAME_A, dict(GAME_A)]).games) == 1


def test_illegal_foreign_and_empty_games_are_rejected():
    illegal = {"pgn": _pgn("https://www.chess.com/game/live/3", "srbmaury", "x", "1. e5")}
    foreign = {"pgn": _pgn("https://www.chess.com/game/live/4", "a", "b", "1. e4")}
    manifest = build_manifest(PLAYER, [GAME_A, illegal, foreign, {"pgn": ""}, {}])

    assert [game.game_id for game in manifest.games] == ["https://www.chess.com/game/live/1"]
    with pytest.raises(EmptyManifestError):
        build_manifest(PLAYER, [illegal, foreign])


def test_manifest_keeps_the_most_recent_games_when_bounded():
    older = {"pgn": _pgn("https://www.chess.com/game/live/9", "srbmaury", "o", "1. e4", "2020.01.01")}
    manifest = build_manifest(PLAYER, [older, GAME_A, GAME_B], max_games=2)

    assert manifest.available_games == 3
    assert "https://www.chess.com/game/live/9" not in {game.game_id for game in manifest.games}


def test_manifest_round_trips_through_its_compressed_canonical_bytes():
    manifest = build_manifest(PLAYER, [GAME_A, GAME_B])
    body = gzip.decompress(manifest.compressed())

    parsed = parse_manifest_bytes("player-1", body)

    assert parsed.hash == manifest.hash
    assert parsed.games == manifest.games
    assert manifest.compressed() == manifest.compressed()
    assert json.loads(body)["schema_version"] == 1


def _client(handler, **kwargs) -> ChessComClient:
    return ChessComClient(httpx.Client(transport=httpx.MockTransport(handler)), **kwargs)


def test_service_fetches_archives_serially_with_retry_and_no_filesystem_writes(monkeypatch):
    calls: list[str] = []
    sleeps: list[float] = []
    failures = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/archives"):
            return httpx.Response(200, json={"archives": ["https://api.chess.com/pub/m/1",
                                                          "https://api.chess.com/pub/m/2"]})
        if request.url.path.endswith("/1") and failures["count"] == 0:
            failures["count"] += 1
            return httpx.Response(429)
        game = GAME_A if request.url.path.endswith("/1") else GAME_B
        return httpx.Response(200, json={"games": [game]})

    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in "wax+"):
            raise AssertionError(f"filesystem write attempted: {file}")
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)
    service = ManifestService(_client(handler, sleep=sleeps.append))

    manifest = service.build(PLAYER)

    assert len(manifest.games) == 2
    assert sleeps == [1]
    assert calls == ["/pub/player/srbmaury/games/archives", "/pub/m/1", "/pub/m/1", "/pub/m/2"]


def test_oversized_chesscom_responses_are_rejected_before_buffering_everything():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'{"archives": []}' + b" " * 2048)

    with pytest.raises(ChessComResponseTooLargeError):
        _client(handler, max_response_bytes=1024).archive_urls("srbmaury")


def test_freshness_uses_the_latest_manifest_time():
    from dataclasses import replace
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    assert not ManifestService.is_fresh(PLAYER, now)
    fresh = replace(PLAYER, latest_manifest_hash="h", latest_manifest_at=now - timedelta(hours=1))
    stale = replace(fresh, latest_manifest_at=now - timedelta(hours=7))
    assert ManifestService.is_fresh(fresh, now)
    assert not ManifestService.is_fresh(stale, now)
