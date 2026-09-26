from __future__ import annotations

import math
from dataclasses import dataclass

import chess
import pandas as pd

MATE_THRESHOLD_CP = 50_000

DISPLAY_LABELS = {
    "samples": "Moves",
    "mistake_rate": "Mistake rate",
    "blunder_rate": "Blunder rate",
    "median_cpl": "Typical eval loss",
    "mean_cpl_non_mate": "Average eval loss",
    "mate_blunders": "Mate mistakes",
    "dimension": "Category",
    "context": "Context",
    "vs_baseline": "Vs baseline",
    "game_id": "Game ID",
    "game": "Game",
    "move": "Move",
    "your_move": "Your move",
    "better_move": "Best move",
    "eval_loss": "Eval loss",
    "quality": "Quality",
    "game_url": "Game link",
    "feature": "Signal",
    "relative_importance": "Relative importance",
}

FEATURE_LABELS = {
    "eval_before_cp": "Position evaluation",
    "engine_eval_before_cp": "Position evaluation",
    "clock_seconds": "Time remaining",
    "legal_move_count": "Legal move choices",
    "fullmove_number": "Move number",
    "rating_difference": "Rating difference",
    "material_balance": "Material advantage",
    "total_non_king_material": "Material remaining",
    "white_rating": "White rating",
    "black_rating": "Black rating",
    "material_balance_white": "White material advantage",
    "white_material": "White material",
    "black_material": "Black material",
    "king_ring_attacks": "King pressure",
    "own_castling_rights": "Castling options",
    "own_doubled_pawns": "Doubled pawns",
    "own_isolated_pawns": "Isolated pawns",
    "own_pawn_islands": "Pawn islands",
}


@dataclass(frozen=True)
class CoachingReport:
    overall: dict[str, float | int]
    by_color: pd.DataFrame
    by_phase: pd.DataFrame
    by_opening: pd.DataFrame
    by_time_control: pd.DataFrame
    recurring_contexts: pd.DataFrame
    candidate_positions: pd.DataFrame
    feature_importance: pd.DataFrame


def _delivered_checkmate(value: object) -> bool:
    if value is None or pd.isna(value):
        return False
    try:
        return chess.Board(str(value)).is_checkmate()
    except ValueError:
        return False


def _sanitize_analysis(frame: pd.DataFrame) -> pd.DataFrame:
    clean = frame.copy()
    same_move = pd.Series(False, index=clean.index)
    if {"uci", "best_move_uci"}.issubset(clean.columns):
        actual = clean["uci"].fillna("").astype(str)
        best = clean["best_move_uci"].fillna("").astype(str)
        same_move = actual.ne("") & best.ne("") & actual.eq(best)

    delivered_mate = pd.Series(False, index=clean.index)
    if "fen_after" in clean.columns:
        delivered_mate = clean["fen_after"].map(_delivered_checkmate)

    definitely_good = same_move | delivered_mate
    if definitely_good.any():
        clean.loc[definitely_good, "cpl"] = 0
        clean.loc[definitely_good, "quality"] = "good"
        clean.loc[definitely_good, "significant_mistake"] = 0
    return clean


def _mate_mask(frame: pd.DataFrame) -> pd.Series:
    mask = pd.Series(False, index=frame.index)
    if "eval_before_cp" in frame.columns:
        mask |= pd.to_numeric(frame["eval_before_cp"], errors="coerce").abs() >= MATE_THRESHOLD_CP
    if "eval_after_cp" in frame.columns:
        mask |= pd.to_numeric(frame["eval_after_cp"], errors="coerce").abs() >= MATE_THRESHOLD_CP
    if "cpl" in frame.columns:
        mask |= pd.to_numeric(frame["cpl"], errors="coerce") >= MATE_THRESHOLD_CP
    return mask.fillna(False)


def _summary_stats(frame: pd.DataFrame) -> dict[str, float | int]:
    mate_mask = _mate_mask(frame)
    normal_cpl = pd.to_numeric(frame.loc[~mate_mask, "cpl"], errors="coerce").dropna()
    return {
        "samples": len(frame),
        "mistake_rate": float(frame["significant_mistake"].mean()),
        "blunder_rate": float((frame["quality"] == "blunder").mean()),
        "median_cpl": float(normal_cpl.median()) if not normal_cpl.empty else 0.0,
        "mean_cpl_non_mate": float(normal_cpl.mean()) if not normal_cpl.empty else 0.0,
        "mate_blunders": int((mate_mask & (frame["quality"] == "blunder")).sum()),
    }


def _aggregate(frame: pd.DataFrame, column: str, min_group_size: int) -> pd.DataFrame:
    if column not in frame.columns:
        return pd.DataFrame(
            columns=[
                "samples",
                "mistake_rate",
                "blunder_rate",
                "median_cpl",
                "mean_cpl_non_mate",
                "mate_blunders",
            ]
        )
    rows: list[dict] = []
    labels: list[object] = []
    for label, group in frame.groupby(column, dropna=False):
        stats = _summary_stats(group)
        if int(stats["samples"]) < min_group_size:
            continue
        labels.append(label)
        rows.append(stats)
    result = pd.DataFrame(rows, index=labels)
    result.index.name = column
    if result.empty:
        return result
    return result.sort_values(["mistake_rate", "samples"], ascending=[False, False])


def _humanize_opening_name(value: object) -> str:
    text = str(value).strip()
    replacements = [
        ("Kings Pawn", "King's Pawn"),
        ("Queens Pawn", "Queen's Pawn"),
        ("Kings Indian", "King's Indian"),
        ("Queens Indian", "Queen's Indian"),
        ("Queens Gambit", "Queen's Gambit"),
        ("Petrovs Defense", "Petrov's Defense"),
    ]
    for old, new in replacements:
        text = text.replace(old, new)
    return text


def _opening_label(row: pd.Series) -> str:
    eco = str(row.get("eco") or "unknown")
    opening = row.get("opening")
    if opening is None or pd.isna(opening) or str(opening).strip().lower() in {"", "unknown", "nan"}:
        return eco
    return f"{_humanize_opening_name(opening)} ({eco})"


def _recurring_contexts(
    overall_mistake_rate: float,
    tables: list[tuple[str, pd.DataFrame]],
) -> pd.DataFrame:
    rows: list[dict] = []
    for dimension, table in tables:
        for context, row in table.iterrows():
            excess = float(row.mistake_rate) - overall_mistake_rate
            score = excess * math.log1p(int(row.samples))
            rows.append(
                {
                    "dimension": dimension,
                    "context": str(context),
                    "samples": int(row.samples),
                    "mistake_rate": float(row.mistake_rate),
                    "blunder_rate": float(row.blunder_rate),
                    "median_cpl": float(row.median_cpl),
                    "vs_baseline": excess,
                    "_score": score,
                }
            )
    if not rows:
        return pd.DataFrame(
            columns=[
                "dimension",
                "context",
                "samples",
                "mistake_rate",
                "blunder_rate",
                "median_cpl",
                "vs_baseline",
            ]
        )
    return (
        pd.DataFrame(rows)
        .sort_values("_score", ascending=False, kind="stable")
        .drop(columns=["_score"])
        .reset_index(drop=True)
    )


def _best_move_san(fen: object, best_move_uci: object) -> str:
    if fen is None or best_move_uci is None or pd.isna(fen) or pd.isna(best_move_uci):
        return "unknown"
    try:
        board = chess.Board(str(fen))
        move = chess.Move.from_uci(str(best_move_uci))
        return board.san(move)
    except (ValueError, AssertionError):
        return str(best_move_uci)


def _move_label(row: pd.Series) -> str:
    fullmove = row.get("fullmove_number")
    san = row.get("san")
    if fullmove is None or pd.isna(fullmove):
        return str(san or row.get("uci") or "unknown")
    separator = "." if row.get("color") == "white" else "..."
    return f"{int(fullmove)}{separator}{san or row.get('uci') or 'unknown'}"


def _game_label(row: pd.Series) -> str:
    white = row.get("white")
    black = row.get("black")
    if white is None or black is None or pd.isna(white) or pd.isna(black):
        return "Game"
    return f"{white} vs {black}"


def _candidate_positions(
    frame: pd.DataFrame,
    limit: int = 20,
    max_per_game: int = 2,
) -> pd.DataFrame:
    mistakes = frame[frame["quality"].isin(["mistake", "blunder"])].copy()
    if {"uci", "best_move_uci"}.issubset(mistakes.columns):
        mistakes = mistakes[
            mistakes["best_move_uci"].isna()
            | mistakes["uci"].isna()
            | (mistakes["uci"].astype(str) != mistakes["best_move_uci"].astype(str))
        ].copy()

    rows: list[dict] = []
    per_game: dict[str, int] = {}
    mate_mask = _mate_mask(mistakes)
    # A stable sort keeps equal losses in chronological order on every platform.
    ranked = mistakes.assign(_mate_related=mate_mask).sort_values(
        "cpl", ascending=False, kind="stable"
    )
    for _, row in ranked.iterrows():
        game_id = str(row["game_id"])
        if per_game.get(game_id, 0) >= max_per_game:
            continue
        cpl = float(row["cpl"])
        rows.append(
            {
                "game_id": game_id,
                "game": _game_label(row),
                "move": _move_label(row),
                "your_move": str(row.get("san") or row.get("uci") or "unknown"),
                "better_move": _best_move_san(row.get("fen_before"), row.get("best_move_uci")),
                "eval_loss": "Mate swing" if bool(row["_mate_related"]) else f"{cpl / 100:.2f} pawns",
                "quality": str(row.get("quality", "unknown")),
                "game_url": str(row.get("source_url") or ""),
            }
        )
        per_game[game_id] = per_game.get(game_id, 0) + 1
        if len(rows) >= limit:
            break
    return pd.DataFrame(
        rows,
        columns=[
            "game_id",
            "game",
            "move",
            "your_move",
            "better_move",
            "eval_loss",
            "quality",
            "game_url",
        ],
    )


def _human_feature_name(raw: object) -> str:
    name = str(raw)
    if "__" in name:
        name = name.split("__", 1)[1]
    if name in FEATURE_LABELS:
        return FEATURE_LABELS[name]

    categorical_prefixes = {
        "game_phase_": "Game phase",
        "time_control_category_": "Time control",
        "color_": "Color",
        "eco_": "Opening code",
        "opening_": "Opening",
    }
    for prefix, label in categorical_prefixes.items():
        if name.startswith(prefix):
            value = name[len(prefix) :].replace("_", " ")
            return f"{label}: {value}"

    return name.replace("_", " ").strip().title()


def _feature_importance_frame(feature_importance: list[dict] | None) -> pd.DataFrame:
    raw = pd.DataFrame(feature_importance or [], columns=["feature", "importance"])
    if raw.empty:
        return pd.DataFrame(columns=["feature", "relative_importance"])
    numeric = pd.to_numeric(raw["importance"], errors="coerce").fillna(0.0)
    total = float(numeric.sum())
    relative = numeric / total if total > 0 else numeric * 0
    return pd.DataFrame(
        {
            "feature": raw["feature"].map(_human_feature_name),
            "relative_importance": relative,
        }
    )


def build_coaching_report(
    frame: pd.DataFrame,
    min_group_size: int = 10,
    *,
    feature_importance: list[dict] | None = None,
) -> CoachingReport:
    if frame.empty:
        raise ValueError("Feature dataset is empty")
    clean = _sanitize_analysis(frame)
    overall = _summary_stats(clean)
    overall_mistake_rate = float(overall["mistake_rate"])
    by_color = _aggregate(clean, "color", min_group_size)
    by_phase = _aggregate(clean, "game_phase", min_group_size)

    opening_frame = clean.copy()
    opening_frame["opening_display"] = opening_frame.apply(_opening_label, axis=1)
    by_opening = _aggregate(opening_frame, "opening_display", min_group_size)
    by_opening.index.name = "opening"

    by_time_control = _aggregate(clean, "time_control_category", min_group_size)
    contexts = _recurring_contexts(
        overall_mistake_rate,
        [
            ("color", by_color),
            ("phase", by_phase),
            ("opening", by_opening),
            ("time_control", by_time_control),
        ],
    )
    return CoachingReport(
        overall=overall,
        by_color=by_color,
        by_phase=by_phase,
        by_opening=by_opening,
        by_time_control=by_time_control,
        recurring_contexts=contexts,
        candidate_positions=_candidate_positions(clean),
        feature_importance=_feature_importance_frame(feature_importance),
    )


def _format_cell(column: str, value: object) -> str:
    if pd.isna(value):
        return "n/a"
    if column in {"mistake_rate", "blunder_rate", "relative_importance"}:
        return f"{float(value):.1%}"
    if column == "vs_baseline":
        return f"{float(value) * 100:+.1f} pp"
    if column in {"median_cpl", "mean_cpl_non_mate"}:
        return f"{float(value) / 100:.2f} pawns"
    if column == "game_url":
        text = str(value)
        return f"[Open game]({text})" if text else "n/a"
    if column in {"quality", "dimension"}:
        return str(value).replace("_", " ").title()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _table_markdown(
    frame: pd.DataFrame,
    *,
    include_index: bool = True,
    max_rows: int = 12,
) -> str:
    limited = frame.head(max_rows).copy()
    if limited.empty:
        return "_Insufficient sample size._"
    if include_index:
        index_name = limited.index.name or "group"
        columns = [index_name, *limited.columns.tolist()]
        data_rows = [[idx, *row.tolist()] for idx, row in limited.iterrows()]
    else:
        columns = limited.columns.tolist()
        data_rows = limited.values.tolist()

    display_columns = [DISPLAY_LABELS.get(column, str(column).replace("_", " ").title()) for column in columns]
    header = "| " + " | ".join(display_columns) + " |"
    separator = "| " + " | ".join("---" for _ in columns) + " |"
    body = []
    for row in data_rows:
        body.append(
            "| "
            + " | ".join(_format_cell(column, value) for column, value in zip(columns, row))
            + " |"
        )
    return "\n".join([header, separator, *body])


def _context_title(dimension: str, context: str) -> str:
    if dimension in {"color", "phase", "time_control"}:
        return context.replace("_", " ").title()
    return context


def _priority_lines(report: CoachingReport) -> list[str]:
    positive = report.recurring_contexts[report.recurring_contexts["vs_baseline"] > 0].head(3)
    if positive.empty:
        return ["- No recurring context is clearly worse than your overall baseline yet."]
    lines: list[str] = []
    for _, row in positive.iterrows():
        title = _context_title(str(row["dimension"]), str(row["context"]))
        lines.append(
            f"- **{title}**: {float(row['mistake_rate']):.1%} significant mistakes "
            f"across {int(row['samples'])} moves "
            f"({float(row['vs_baseline']) * 100:+.1f} percentage points vs your baseline)."
        )
    return lines


def render_markdown(report: CoachingReport) -> str:
    candidates = report.candidate_positions.drop(columns=["game_id"], errors="ignore")
    lines = [
        "# Chess ML Coach Report",
        "",
        "## Your priorities",
        *_priority_lines(report),
        "",
        "Use these as training priorities, not absolute judgments; larger samples are more reliable.",
        "",
        "## Overall",
        f"- Analyzed moves: {report.overall['samples']}",
        f"- Mistake rate: {float(report.overall['mistake_rate']):.1%}",
        f"- Blunder rate: {float(report.overall['blunder_rate']):.1%}",
        f"- Typical eval loss: {float(report.overall['median_cpl']) / 100:.2f} pawns",
        f"- Average eval loss: {float(report.overall['mean_cpl_non_mate']) / 100:.2f} pawns",
        f"- Mate mistakes: {report.overall['mate_blunders']}",
        "",
        "## By color",
        _table_markdown(report.by_color),
        "",
        "## By phase",
        _table_markdown(report.by_phase),
        "",
        "## Openings",
        _table_markdown(report.by_opening),
        "",
        "## Time controls",
        _table_markdown(report.by_time_control),
        "",
        "## Recurring weakness contexts",
        _table_markdown(report.recurring_contexts, include_index=False),
        "",
        "## Candidate training positions",
        "These are positions from your own games to review first.",
        "",
        _table_markdown(candidates, include_index=False, max_rows=20),
    ]
    if not report.feature_importance.empty:
        lines.extend(
            [
                "",
                "## Model feature importance",
                "Feature importance is associative, not causal.",
                "",
                _table_markdown(report.feature_importance, include_index=False),
            ]
        )
    return "\n".join(lines).rstrip() + "\n"
