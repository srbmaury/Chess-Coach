import gzip
import zlib

import pytest
from hosted_factories import DEFAULT_GAMES, analysis_rows

from chess_ml_coach.hosted.checkpoints import (
    CheckpointRejectedError,
    UploadTooLargeError,
    bounded_gunzip,
    validate_checkpoint_payload,
)
from chess_ml_coach.hosted.manifests import build_manifest
from chess_ml_coach.hosted.profiles import Player

PLAYER = Player(id="p", canonical_username="magnuscarlsen", display_username="M",
                chesscom_player_id=1)
MANIFEST = build_manifest(PLAYER, [{"pgn": text} for text in DEFAULT_GAMES])
GAMES = [game.as_dict() for game in MANIFEST.games]


def _payload(**overrides):
    payload = {
        "schema_version": 1, "job_id": "job", "sequence": 1, "analysis_config_hash": "cfg",
        "engine_build_hash": "eng", "first_unit": 0, "last_unit": 1,
        "games": [{"game_id": GAMES[i]["game_id"], "rows": analysis_rows(GAMES[i])}
                  for i in range(2)],
    }
    payload.update(overrides)
    return payload


def _validate(payload, first_unit=0):
    return validate_checkpoint_payload(
        payload, MANIFEST, job_id="job", sequence=1, first_unit=first_unit,
        config_hash="cfg", engine_hash="eng",
    )


def test_valid_payload_reports_its_range_and_result_count():
    expected = sum(len(analysis_rows(GAMES[i])) for i in range(2))
    assert _validate(_payload()) == (0, 1, expected)


@pytest.mark.parametrize(
    "overrides",
    [
        {"schema_version": 2},
        {"job_id": "other"},
        {"sequence": 2},
        {"analysis_config_hash": "other"},
        {"engine_build_hash": "other"},
        {"first_unit": 1},
        {"last_unit": 3},
        {"last_unit": 0},
        {"games": "nope"},
    ],
)
def test_identity_and_range_mismatches_are_rejected(overrides):
    with pytest.raises(CheckpointRejectedError):
        _validate(_payload(**overrides))


def _mutated_row(**changes):
    payload = _payload()
    payload["games"][0]["rows"][0].update(changes)
    return payload


@pytest.mark.parametrize(
    "changes",
    [
        {"best_move_uci": "e2e5"},
        {"best_move_uci": "zz99"},
        {"cpl": -1},
        {"cpl": 5},
        {"quality": "genius"},
        {"quality_reason": "because"},
        {"eval_before_cp": 10**7},
        {"expected_score_after": 1.5},
        {"mate_before": "3"},
    ],
)
def test_illegal_moves_and_malformed_values_are_rejected(changes):
    with pytest.raises(CheckpointRejectedError):
        _validate(_mutated_row(**changes))


def test_rows_must_cover_exactly_the_players_moves():
    missing = _payload()
    missing["games"][0]["rows"].pop()
    wrong_game = _payload()
    wrong_game["games"][0]["game_id"] = GAMES[2]["game_id"]
    for payload in (missing, wrong_game):
        with pytest.raises(CheckpointRejectedError):
            _validate(payload)


def test_bounded_gunzip_rejects_bombs_truncation_and_trailing_data():
    body = b"a" * 10_000
    compressed = gzip.compress(body)

    assert bounded_gunzip(compressed, 10_000) == body
    with pytest.raises(UploadTooLargeError):
        bounded_gunzip(compressed, 9_999)
    with pytest.raises(CheckpointRejectedError):
        bounded_gunzip(compressed[:-10], 10_000)
    with pytest.raises(CheckpointRejectedError):
        bounded_gunzip(compressed + compressed, 20_000)
    with pytest.raises(CheckpointRejectedError):
        bounded_gunzip(zlib.compress(body), 10_000)
