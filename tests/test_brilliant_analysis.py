from pathlib import Path

import chess
import chess.engine
import pandas as pd

from chess_ml_coach.config import Settings
from chess_ml_coach.engine import analyze_user_moves
from chess_ml_coach.move_quality import (
    alternatives_show_uniqueness,
    sacrifices_material_after_reply,
)

SACRIFICE_FEN = "3rk3/8/8/8/8/8/8/3QK3 w - - 0 1"


def test_material_sacrifice_requires_the_reply_to_take_material():
    before = chess.Board(SACRIFICE_FEN)
    sacrifice = chess.Move.from_uci("d1d8")
    after = before.copy(stack=False)
    after.push(sacrifice)

    assert sacrifices_material_after_reply(
        before,
        after,
        chess.WHITE,
        chess.Move.from_uci("e8d8"),
    ) is True


def test_candidate_moves_must_be_clearly_separated_to_count_as_unique():
    clearly_unique = [
        chess.engine.PovScore(chess.engine.Cp(220), chess.WHITE),
        chess.engine.PovScore(chess.engine.Cp(80), chess.WHITE),
    ]
    roughly_equivalent = [
        chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE),
        chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE),
    ]

    assert alternatives_show_uniqueness(clearly_unique, chess.WHITE) is True
    assert alternatives_show_uniqueness(roughly_equivalent, chess.WHITE) is False


class BrilliantEngine:
    def __init__(self):
        self.calls = 0
        self.multipv_calls = 0

    def analyse(self, board: chess.Board, depth: int) -> dict:
        self.calls += 1
        if self.calls == 1:
            return {
                "score": chess.engine.PovScore(chess.engine.Cp(220), chess.WHITE),
                "pv": [chess.Move.from_uci("d1d8")],
            }
        return {
            "score": chess.engine.PovScore(chess.engine.Cp(205), chess.WHITE),
            "pv": [chess.Move.from_uci("e8d8")],
        }

    def analyse_multipv(self, board: chess.Board, depth: int, multipv: int = 2) -> list[dict]:
        self.multipv_calls += 1
        return [
            {"score": chess.engine.PovScore(chess.engine.Cp(220), chess.WHITE)},
            {"score": chess.engine.PovScore(chess.engine.Cp(80), chess.WHITE)},
        ]

    def close(self) -> None:
        pass


def test_analysis_only_calls_the_verified_sacrifice_brilliant(tmp_path: Path):
    before = chess.Board(SACRIFICE_FEN)
    move = chess.Move.from_uci("d1d8")
    after = before.copy(stack=False)
    after.push(move)
    moves = pd.DataFrame(
        [
            {
                "game_id": "brilliant-1",
                "ply": 1,
                "color": "white",
                "fen_before": before.fen(),
                "fen_after": after.fen(),
                "uci": move.uci(),
                "is_user_move": True,
            }
        ]
    )
    engine = BrilliantEngine()
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")

    result = analyze_user_moves(
        moves,
        settings,
        tmp_path / "analysis.parquet",
        adapter=engine,
    )

    assert engine.calls == 2
    assert engine.multipv_calls == 1
    assert result.iloc[0].quality == "brilliant"
    assert result.iloc[0].quality_reason == "sound sacrifice and uniquely strong move"
