"""Validate decoded hosted analysis results independently of persistence."""

from __future__ import annotations

import re
import zlib
from hashlib import sha256
from typing import TYPE_CHECKING

import chess

if TYPE_CHECKING:
    from .manifests import GameManifest, ManifestGame

CHECKPOINT_SCHEMA_VERSION = 1
ARTIFACT_SCHEMA_VERSION = 1
MAX_CHECKPOINT_GAMES = 25
_UCI = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")
MATE_CP = 100_000

QUALITY_REASONS: dict[str, frozenset[str]] = {
    "brilliant": frozenset({"sound sacrifice and uniquely strong move"}),
    "best": frozenset({"delivers checkmate", "engine top move", "engine-equivalent move"}),
    "excellent": frozenset({"near-best move"}),
    "good": frozenset({"outcome essentially preserved"}),
    "inaccuracy": frozenset({"noticeable drop in expected score"}),
    "mistake": frozenset({"significant drop in expected score"}),
    "blunder": frozenset({"large drop in expected score", "allows forced mate"}),
    "miss": frozenset({"forced mate was available", "decisive winning chance was missed"}),
}
PUZZLE_QUALITIES = frozenset({"miss", "mistake", "blunder"})
PUZZLE_MOTIFS = frozenset({
    "missed mate", "forcing check", "fork", "pin", "winning capture", "king safety",
    "positional / calculation",
})


class CheckpointRejectedError(RuntimeError):
    code = "checkpoint_rejected"


class UploadTooLargeError(CheckpointRejectedError):
    code = "upload_too_large"


def bounded_gunzip(data: bytes, limit: int) -> bytes:
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        body = decompressor.decompress(data, limit + 1)
    except zlib.error:
        raise CheckpointRejectedError("Upload is not valid gzip data") from None
    if len(body) > limit or decompressor.unconsumed_tail:
        raise UploadTooLargeError("Upload expands beyond the decompressed size limit")
    if not decompressor.eof or decompressor.unused_data:
        raise CheckpointRejectedError("Upload is not a single complete gzip member")
    return body


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckpointRejectedError(message)


def _validate_row(row: object, board: chess.Board, played: chess.Move) -> None:
    _require(isinstance(row, dict), "Analysis rows must be objects")
    best = row.get("best_move_uci")
    if best is not None:
        _require(isinstance(best, str) and bool(_UCI.fullmatch(best)), "Invalid best move")
        _require(chess.Move.from_uci(best) in board.legal_moves, "Best move is not legal")
    for key in ("eval_before_cp", "eval_after_cp"):
        _require(_is_int(row.get(key)) and abs(row[key]) <= MATE_CP, f"Invalid {key}")
    for key in ("mate_before", "mate_after"):
        value = row.get(key)
        _require(value is None or _is_int(value) and abs(value) <= 1000, f"Invalid {key}")
    for key in ("expected_score_before", "expected_score_after"):
        value = row.get(key)
        _require(
            isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1,
            f"Invalid {key}",
        )
    cpl = row.get("cpl")
    _require(_is_int(cpl) and 0 <= cpl <= 2 * MATE_CP, "Invalid cpl")
    if best == played.uci():
        _require(cpl == 0, "The engine move cannot lose evaluation")
    quality = row.get("quality")
    _require(quality in QUALITY_REASONS, "Invalid move quality")
    _require(row.get("quality_reason") in QUALITY_REASONS[quality], "Invalid quality reason")


def validate_checkpoint_payload(
    payload: object,
    units: list[ManifestGame],
    *,
    job_id: str,
    sequence: int,
    first_unit: int,
    config_hash: str,
    engine_hash: str,
) -> tuple[int, int, int]:
    """Validate a decoded checkpoint; return ``(first_unit, last_unit, result_count)``."""
    _require(isinstance(payload, dict), "Checkpoint must be a JSON object")
    _require(payload.get("schema_version") == CHECKPOINT_SCHEMA_VERSION, "Unsupported schema")
    _require(payload.get("job_id") == job_id, "Checkpoint belongs to another job")
    _require(payload.get("sequence") == sequence, "Checkpoint sequence mismatch")
    _require(payload.get("analysis_config_hash") == config_hash, "Configuration mismatch")
    _require(payload.get("engine_build_hash") == engine_hash, "Engine build mismatch")
    _require(payload.get("first_unit") == first_unit, "Checkpoint does not resume at the cursor")
    last_unit = payload.get("last_unit")
    games = payload.get("games")
    _require(_is_int(last_unit) and last_unit >= first_unit, "Invalid unit range")
    _require(last_unit < len(units), "Checkpoint extends past the job's games")
    _require(last_unit - first_unit + 1 <= MAX_CHECKPOINT_GAMES, "Checkpoint batch is too large")
    _require(
        isinstance(games, list) and len(games) == last_unit - first_unit + 1,
        "Checkpoint games do not match its unit range",
    )
    results = 0
    for offset, entry in enumerate(games):
        expected = units[first_unit + offset]
        _require(isinstance(entry, dict), "Checkpoint games must be objects")
        _require(entry.get("game_id") == expected.game_id, "Game identity mismatch")
        rows = entry.get("rows")
        _require(isinstance(rows, list), "Game rows must be a list")
        plies = expected.user_plies()
        _require(
            [row.get("ply") if isinstance(row, dict) else None for row in rows] == list(plies),
            "Analysis rows do not cover exactly the player's moves",
        )
        board = chess.Board()
        row_by_ply = dict(zip(plies, rows, strict=True))
        for ply, uci in enumerate(expected.moves, start=1):
            move = chess.Move.from_uci(uci)
            if ply in row_by_ply:
                _validate_row(row_by_ply[ply], board, move)
            board.push(move)
        results += len(rows)
    return first_unit, last_unit, results


def validate_artifact_payload(
    payload: object,
    manifest: GameManifest,
    *,
    artifact_type: str,
    dependency: str,
    config_hash: str,
    result_count: int,
) -> None:
    _require(isinstance(payload, dict), "Artifact must be a JSON object")
    _require(payload.get("schema_version") == ARTIFACT_SCHEMA_VERSION, "Unsupported schema")
    _require(payload.get("artifact_type") == artifact_type, "Artifact type mismatch")
    _require(payload.get("dependency_hash") == dependency, "Artifact dependency mismatch")
    _require(payload.get("analysis_config_hash") == config_hash, "Configuration mismatch")
    if artifact_type == "puzzles":
        puzzles = payload.get("puzzles")
        _require(isinstance(puzzles, list) and len(puzzles) <= result_count, "Invalid puzzles")
        game_ids = {game.game_id for game in manifest.games}
        for puzzle in puzzles:
            _require(isinstance(puzzle, dict), "Puzzles must be objects")
            _require(puzzle.get("game_id") in game_ids, "Puzzle game is not in the game set")
            _require(_is_int(puzzle.get("ply")) and puzzle["ply"] > 0, "Invalid puzzle ply")
            best = puzzle.get("best_move_uci")
            _require(isinstance(best, str) and bool(_UCI.fullmatch(best)), "Invalid puzzle move")
            expected_id = sha256(f"{puzzle['game_id']}:{puzzle['ply']}:{best}".encode()).hexdigest()
            _require(puzzle.get("puzzle_id") == expected_id[:24], "Invalid puzzle id")
            try:
                board = chess.Board(puzzle.get("fen_before"))
            except (TypeError, ValueError):
                raise CheckpointRejectedError("Invalid puzzle position") from None
            _require(chess.Move.from_uci(best) in board.legal_moves, "Puzzle move is not legal")
            _require(puzzle.get("quality") in PUZZLE_QUALITIES, "Invalid puzzle quality")
            _require(puzzle.get("motif") in PUZZLE_MOTIFS, "Invalid puzzle motif")
            _require(
                _is_int(puzzle.get("difficulty")) and 1 <= puzzle["difficulty"] <= 5,
                "Invalid puzzle difficulty",
            )
    elif artifact_type == "model_summary":
        _require(payload.get("status") in {"trained", "insufficient_data"}, "Invalid model status")
    elif artifact_type == "report":
        markdown = payload.get("markdown")
        _require(isinstance(markdown, str) and markdown.startswith("# "), "Invalid report")
        _require(isinstance(payload.get("overall"), dict), "Invalid report summary")
    else:
        raise CheckpointRejectedError("Unknown artifact type")
