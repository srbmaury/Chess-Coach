"""Generate the cross-language parity fixture for the browser analysis pipeline.

The fixture pins what the existing Python pipeline produces for a fixed set of games
and fixed engine results, so the TypeScript port can be checked for identical output
without Stockfish, the network, or Supabase:

    .venv/bin/python tests/browser_parity.py > tests/fixtures/browser_parity.json

Engine answers come from a deterministic synthetic engine; every query the Python
analysis makes is recorded so the browser's fake engine can replay it by FEN.
"""

from __future__ import annotations

import json
import math
import random
import sys
import tempfile
from hashlib import sha256
from pathlib import Path

import chess
import chess.engine
import chess.pgn
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chess_ml_coach.config import MoveQualityThresholds, Settings
from chess_ml_coach.engine import analyze_user_moves
from chess_ml_coach.features import build_feature_dataset
from chess_ml_coach.hosted.manifests import build_manifest
from chess_ml_coach.hosted.profiles import Player
from chess_ml_coach.pgn import parse_pgn_file
from chess_ml_coach.puzzles import extract_puzzles
from chess_ml_coach.report import build_coaching_report, render_markdown

USERNAME = "parityplayer"
DEPTH = 12
MIN_GROUP_SIZE = 3
PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
TIME_CONTROLS = ["60", "180+2", "600", "1800+10", "1/86400", "300"]

# The browser model; the pure-Python reference below must match web/src/analysis/model.ts.
MODEL_NUMERIC = [
    "clock_seconds", "legal_move_count", "fullmove_number", "rating_difference",
    "material_balance", "total_non_king_material", "king_ring_attacks", "own_castling_rights",
    "own_doubled_pawns", "own_isolated_pawns", "own_pawn_islands", "engine_eval_before_cp",
]
MODEL_CATEGORICAL = ["color", "game_phase", "time_control_category"]
MODEL_ITERATIONS = 300
MODEL_LEARNING_RATE = 0.1
MODEL_L2 = 0.001
FEATURE_COLUMNS = [
    "game_id", "ply", "color", "fullmove_number", "legal_move_count", "in_check",
    "white_material", "black_material", "material_balance_white", "total_non_king_material",
    "non_pawn_non_king_material", "white_castling_rights", "black_castling_rights",
    "white_queen_present", "black_queen_present", "white_pawn_islands", "black_pawn_islands",
    "white_doubled_pawns", "black_doubled_pawns", "white_isolated_pawns",
    "black_isolated_pawns", "white_king_ring_attacks", "black_king_ring_attacks",
    "white_king_castled", "black_king_castled", "game_phase", "time_control_category",
    "user_rating", "opponent_rating", "rating_difference", "material_balance",
    "king_ring_attacks", "own_castling_rights", "own_doubled_pawns", "own_isolated_pawns",
    "own_pawn_islands", "engine_eval_before_cp", "significant_mistake", "clock_seconds",
    "eco", "opening", "fen_before", "fen_after",
]


def _material(board: chess.Board, color: chess.Color) -> int:
    return sum(len(board.pieces(kind, color)) * value for kind, value in PIECE_VALUES.items())


def _noise(board: chess.Board) -> int:
    return int(sha256(board.fen().encode()).hexdigest()[:4], 16) % 41 - 20


class SyntheticEngine:
    """A one-ply greedy engine whose answers are a pure function of the position."""

    def __init__(self) -> None:
        self.queries: dict[str, list[dict]] = {}

    def _search(self, board: chess.Board, multipv: int) -> list[tuple[chess.engine.Score, list]]:
        if board.is_checkmate():
            return [(chess.engine.Mate(0), [])]
        if board.is_stalemate() or board.is_insufficient_material():
            return [(chess.engine.Cp(0), [])]
        scored = []
        mover = board.turn
        for move in sorted(board.legal_moves, key=lambda item: item.uci()):
            child = board.copy(stack=False)
            child.push(move)
            if child.is_checkmate():
                score: chess.engine.Score = chess.engine.Mate(1)
                rank = 10**6
            else:
                value = 100 * (_material(child, mover) - _material(child, not mover)) + _noise(child)
                score = chess.engine.Cp(value)
                rank = value
            line = [move]
            replies = sorted(child.legal_moves, key=lambda item: item.uci())
            captures = [reply for reply in replies if child.is_capture(reply)]
            if captures or replies:
                line.append((captures or replies)[0])
            scored.append((rank, move.uci(), score, line))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [(score, line) for _, _, score, line in scored[:multipv]]

    def _record(self, board: chess.Board, multipv: int, results) -> None:
        encoded = []
        for score, line in results:
            if score.is_mate():
                value = {"mate": score.mate()}
            else:
                value = {"cp": score.score()}
            encoded.append({"score": value, "pv": [move.uci() for move in line]})
        self.queries[f"{board.fen()}|{multipv}"] = encoded

    def analyse(self, board: chess.Board, depth: int) -> dict:
        assert depth == DEPTH
        results = self._search(board, 1)
        self._record(board, 1, results)
        score, line = results[0]
        return {"score": chess.engine.PovScore(score, board.turn), "pv": line}

    def analyse_multipv(self, board: chess.Board, depth: int, multipv: int = 2) -> list[dict]:
        assert depth == DEPTH
        results = self._search(board, max(2, multipv))
        self._record(board, max(2, multipv), results)
        return [
            {"score": chess.engine.PovScore(score, board.turn), "pv": line}
            for score, line in results
        ]

    def close(self) -> None:
        pass


def _play_game(seed: int, *, user_white: bool) -> str:
    rng = random.Random(seed)
    board = chess.Board()
    game = chess.pgn.Game()
    white, black = (USERNAME.title(), f"opponent{seed}") if user_white else (
        f"opponent{seed}", USERNAME.upper())
    month, day = 1 + seed % 9, 1 + seed % 27
    game.headers.update({
        "Event": "Live Chess", "Site": f"https://www.chess.com/game/live/{9000 + seed}",
        "Date": f"2026.{month:02d}.{day:02d}", "White": white, "Black": black,
        "WhiteElo": str(1400 + 37 * seed % 300), "BlackElo": str(1450 + 53 * seed % 250),
        "TimeControl": TIME_CONTROLS[seed % len(TIME_CONTROLS)], "ECO": ["C20", "D00", "B01"][seed % 3],
        "Link": f"https://www.chess.com/game/live/{9000 + seed}", "Result": "*",
    })
    if seed % 2 == 0:
        game.headers["ECOUrl"] = "https://www.chess.com/openings/Kings-Pawn-Opening-Kings-Knight"
    node = game
    clock = 600.0
    for ply in range(1, 40 + seed * 11):
        moves = sorted(board.legal_moves, key=lambda item: item.uci())
        if not moves:
            break
        mates = [move for move in moves if board.gives_check(move) and _mates(board, move)]
        captures = [move for move in moves if board.is_capture(move)]
        if mates and rng.random() < 0.7:
            move = mates[0]
        elif captures and rng.random() < 0.6:
            move = rng.choice(captures)
        else:
            move = rng.choice(moves)
        node = node.add_variation(move)
        if seed % 3 != 1:
            clock = max(1.0, clock - rng.randint(1, 9) - 0.5 * (ply % 2))
            node.set_clock(clock)
        board.push(move)
        if board.is_game_over():
            break
    game.headers["Result"] = board.result(claim_draw=False) if board.is_game_over() else "*"
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    return game.accept(exporter)


# Short games that reach the mate paths random play rarely finds: a missed mate-in-one,
# a move that allows mate, and a user who delivers mate.
TACTICAL_GAMES = [
    ("2026.03.03", USERNAME, "scholar", "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Nc3 Nxh5 5. Nf3"),
    ("2026.03.04", "scholar2", USERNAME, "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#"),
    ("2026.03.05", USERNAME, "fool", "1. f3 e5 2. g4 Qh4#"),
    ("2026.03.06", "fool2", USERNAME, "1. f3 e5 2. g4 Qh4#"),
]


def _tactical_pgn(index: int, date: str, white: str, black: str, moves: str) -> str:
    site = f"https://www.chess.com/game/live/{8000 + index}"
    return (
        f'[Event "Live Chess"]\n[Site "{site}"]\n[Date "{date}"]\n[White "{white}"]\n'
        f'[Black "{black}"]\n[Result "*"]\n[TimeControl "180+2"]\n[ECO "C20"]\n'
        f'[Opening "Kings Pawn Opening"]\n[Link "{site}"]\n\n{moves} *'
    )


def _mates(board: chess.Board, move: chess.Move) -> bool:
    child = board.copy(stack=False)
    child.push(move)
    return child.is_checkmate()


def _json_value(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, pd.Timestamp):
        return None if pd.isna(value) else value.date().isoformat()
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


# Lightweight browser model: pure-Python reference ------------------------------------------


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp = math.exp(value)
    return exp / (1.0 + exp)


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _auc(labels: list[int], scores: list[float]) -> float:
    order = sorted(range(len(scores)), key=lambda index: scores[index])
    ranks = [0.0] * len(scores)
    index = 0
    while index < len(order):
        end = index
        while end + 1 < len(order) and scores[order[end + 1]] == scores[order[index]]:
            end += 1
        average = (index + end) / 2 + 1
        for position in range(index, end + 1):
            ranks[order[position]] = average
        index = end + 1
    positives = sum(labels)
    negatives = len(labels) - positives
    positive_ranks = sum(rank for rank, label in zip(ranks, labels, strict=True) if label == 1)
    return (positive_ranks - positives * (positives + 1) / 2) / (positives * negatives)


def train_lightweight_model(rows: list[dict]) -> dict:
    base = {"schema_version": 1, "algorithm": "logistic-gd-v1"}
    labels = [int(row["significant_mistake"]) for row in rows]
    if not rows or len(set(labels)) < 2:
        return {**base, "status": "insufficient_data", "reason": "Both outcomes are required"}
    if any(row["game_date"] is None for row in rows):
        return {**base, "status": "insufficient_data", "reason": "Every game needs a date"}
    first_seen: dict[str, str] = {}
    for row in rows:
        first_seen.setdefault(row["game_id"], row["game_date"])
    games = sorted(first_seen.items(), key=lambda item: (item[1], item[0]))
    if len(games) < 3:
        return {**base, "status": "insufficient_data", "reason": "At least 3 games are required"}
    test_count = min(max(1, math.ceil(len(games) * 0.2)), len(games) - 1)
    test_ids = {game_id for game_id, _ in games[-test_count:]}
    train = [row for row in rows if row["game_id"] not in test_ids]
    test = [row for row in rows if row["game_id"] in test_ids]
    if len({int(row["significant_mistake"]) for row in train}) < 2:
        return {**base, "status": "insufficient_data",
                "reason": "Training games must include both outcomes"}

    def numeric(row: dict, name: str) -> float | None:
        value = row.get(name)
        if value is None:
            return None
        value = float(value)
        if name == "engine_eval_before_cp":
            value = max(-1000.0, min(1000.0, value))
        return value

    medians, means, scales = [], [], []
    for name in MODEL_NUMERIC:
        present = [value for row in train if (value := numeric(row, name)) is not None]
        median = _median(present) if present else 0.0
        filled = [numeric(row, name) if numeric(row, name) is not None else median for row in train]
        mean = sum(filled) / len(filled)
        variance = sum((value - mean) ** 2 for value in filled) / len(filled)
        medians.append(median)
        means.append(mean)
        scales.append(math.sqrt(variance) if variance > 0 else 1.0)
    categories = {
        name: sorted({str(row.get(name) or "unknown") for row in train})
        for name in MODEL_CATEGORICAL
    }
    names = [f"numeric__{name}" for name in MODEL_NUMERIC] + [
        f"categorical__{name}_{value}" for name in MODEL_CATEGORICAL for value in categories[name]
    ]

    def vector(row: dict) -> list[float]:
        values = []
        for index, name in enumerate(MODEL_NUMERIC):
            value = numeric(row, name)
            value = medians[index] if value is None else value
            values.append((value - means[index]) / scales[index])
        for name in MODEL_CATEGORICAL:
            current = str(row.get(name) or "unknown")
            values.extend(1.0 if current == value else 0.0 for value in categories[name])
        return values

    train_x = [vector(row) for row in train]
    train_y = [int(row["significant_mistake"]) for row in train]
    positive_rate = sum(train_y) / len(train_y)
    weights = [0.0] * len(names)
    bias = math.log(positive_rate / (1 - positive_rate))
    count = len(train_x)
    for _ in range(MODEL_ITERATIONS):
        gradient = [0.0] * len(names)
        bias_gradient = 0.0
        for features, label in zip(train_x, train_y, strict=True):
            linear = bias
            for weight, value in zip(weights, features, strict=True):
                linear += weight * value
            error = _sigmoid(linear) - label
            bias_gradient += error
            for index, value in enumerate(features):
                gradient[index] += error * value
        for index in range(len(weights)):
            weights[index] -= MODEL_LEARNING_RATE * (
                gradient[index] / count + MODEL_L2 * weights[index]
            )
        bias -= MODEL_LEARNING_RATE * bias_gradient / count

    test_y = [int(row["significant_mistake"]) for row in test]
    probabilities = []
    for row in test:
        linear = bias
        for weight, value in zip(weights, vector(row), strict=True):
            linear += weight * value
        probabilities.append(_sigmoid(linear))
    eps = 1e-15
    log_loss = -sum(
        label * math.log(min(1 - eps, max(eps, p))) + (1 - label) * math.log(min(1 - eps, max(eps, 1 - p)))
        for label, p in zip(test_y, probabilities, strict=True)
    ) / len(test_y)
    brier = sum((p - label) ** 2 for label, p in zip(test_y, probabilities, strict=True)) / len(test_y)
    importance = sorted(
        ({"feature": name, "importance": abs(weight)} for name, weight in zip(names, weights, strict=True)),
        key=lambda item: (-item["importance"], item["feature"]),
    )
    return {
        **base,
        "status": "trained",
        "train_rows": len(train),
        "test_rows": len(test),
        "train_positive_rate": positive_rate,
        "test_positive_rate": sum(test_y) / len(test_y),
        "chronological_test_start": min(row["game_date"] for row in test),
        "metrics": {
            "roc_auc": _auc(test_y, probabilities) if len(set(test_y)) == 2 else None,
            "log_loss": log_loss,
            "brier_score": brier,
        },
        "feature_names": names,
        "weights": weights,
        "bias": bias,
        "feature_importance": importance,
    }


# Fixture assembly ------------------------------------------------------------------------------


def build_fixture() -> dict:
    seeds = [(seed, seed % 2 == 0) for seed in range(1, 9)]
    pgns = [_play_game(seed, user_white=user_white) for seed, user_white in seeds]
    pgns += [_tactical_pgn(index, *game) for index, game in enumerate(TACTICAL_GAMES)]
    player = Player(id="parity", canonical_username=USERNAME, display_username=USERNAME,
                    chesscom_player_id=None)
    manifest = build_manifest(player, [{"pgn": text} for text in pgns])
    thresholds = MoveQualityThresholds()
    engine = SyntheticEngine()

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        pgn_path = root / "games.pgn"
        pgn_path.write_text("\n\n".join(pgns) + "\n", encoding="utf-8")
        games, moves = parse_pgn_file(pgn_path, USERNAME)
        settings = Settings(username=USERNAME, data_dir=root / "data", model_dir=root / "models",
                            stockfish_depth=DEPTH, min_group_size=MIN_GROUP_SIZE)
        analysis = analyze_user_moves(moves, settings, root / "analysis.parquet", adapter=engine)
    features = build_feature_dataset(games, moves, analysis, thresholds)
    puzzles = extract_puzzles(features)

    feature_rows = []
    for record in features.to_dict("records"):
        row = {column: _json_value(record.get(column)) for column in FEATURE_COLUMNS}
        row["game_date"] = _json_value(record.get("game_date"))
        feature_rows.append(row)
    model = train_lightweight_model(feature_rows)
    importance = (
        [{"feature": item["feature"], "importance": item["importance"]}
         for item in model["feature_importance"]]
        if model["status"] == "trained" else None
    )
    report = build_coaching_report(features, MIN_GROUP_SIZE, feature_importance=importance)

    analysis_rows = [
        {key: _json_value(value) for key, value in record.items()
         if key not in {"engine_config_hash", "scoring_version"}}
        for record in analysis.sort_values(["game_id", "ply"]).to_dict("records")
    ]
    return {
        "description": "Generated by tests/browser_parity.py; do not edit by hand.",
        "username": USERNAME,
        "depth": DEPTH,
        "min_group_size": MIN_GROUP_SIZE,
        "thresholds": {"inaccuracy": thresholds.inaccuracy, "mistake": thresholds.mistake,
                       "blunder": thresholds.blunder},
        "manifest": json.loads(manifest.canonical_bytes),
        "manifest_hash": manifest.hash,
        "engine": dict(sorted(engine.queries.items())),
        "analysis": analysis_rows,
        "features": feature_rows,
        "puzzles": [{key: _json_value(value) for key, value in puzzle.__dict__.items()}
                    for puzzle in puzzles],
        "model_summary": model,
        "report": {"overall": {key: _json_value(value) for key, value in report.overall.items()},
                   "markdown": render_markdown(report)},
    }


def render_fixture() -> str:
    return json.dumps(build_fixture(), indent=1, sort_keys=True, allow_nan=False) + "\n"


if __name__ == "__main__":
    sys.stdout.write(render_fixture())
