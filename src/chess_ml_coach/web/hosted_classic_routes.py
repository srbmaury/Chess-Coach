"""The classic UI's API (profiles, dashboard, practice, puzzles, progress, report) for
hosted mode.

Paths and response models match the local routes exactly, so the same pages work in
both modes. Here every request is authenticated and scoped to the account's active
player, and data comes from Postgres and the player's latest analysis result instead
of local files. Engine work (adaptive practice, explanations) runs in the browser;
the server only records its outcome.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import chess
from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from ..hosted.checkpoints import bounded_gunzip
from ..hosted.practice import ActivePlayer, NoActivePlayerError, PracticeError, PuzzleNotFoundError
from ..move_quality import display_loss_pawns, stored_quality_reason
from .auth import require_account
from .hosted_analysis_routes import (
    MAX_DECOMPRESSED_BYTES,
    MAX_UPLOAD_BYTES,
    HostedAnalysisServices,
    HostedApiError,
    _services,
    guarded,
)
from .report_page import render_report_page
from .schemas import (
    AdaptiveProgressSummary,
    AdaptiveReviewResult,
    ArtifactState,
    AttemptRequest,
    AttemptResponse,
    DashboardResponse,
    PracticeNextResponse,
    PracticePuzzle,
    ProgressGroupRow,
    ProgressResponse,
    PuzzleItem,
    PuzzleListResponse,
    TrainingSummary,
)

router = APIRouter()


class ProfileCreateRequest(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    activate: bool = True


class AdaptiveCompleteRequest(BaseModel):
    """Outcome of a browser-run adaptive drill. The engine ran on the user's device."""

    model_config = ConfigDict(extra="forbid")
    succeeded: bool
    answer: str = Field(pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$")
    user_moves_accepted: int = Field(ge=0, le=10)
    current_ply: int = Field(ge=0, le=20)
    continuation_attempts: int = Field(default=0, ge=0, le=10)
    continuation_correct: int = Field(default=0, ge=0, le=10)


def _context(request: Request) -> tuple[HostedAnalysisServices, str]:
    account = require_account(request)
    return _services(request, analysis=False), account.id


def _active(request: Request) -> tuple[HostedAnalysisServices, ActivePlayer]:
    services, account_id = _context(request)
    try:
        return services, services.practice.require_active(account_id)
    except NoActivePlayerError as exc:
        raise HostedApiError(409, "no_active_player", str(exc)) from exc


def _practice_error(exc: PracticeError) -> HostedApiError:
    if isinstance(exc, PuzzleNotFoundError):
        return HostedApiError(404, "puzzle_not_found", "Puzzle not found")
    return HostedApiError(409, "practice_error", str(exc))


def _no_puzzles() -> HostedApiError:
    return HostedApiError(
        409, "no_puzzles", "No puzzles yet. Run the analysis from the Pipeline page."
    )


def _iso(value: datetime) -> datetime:
    return value.astimezone(UTC)


def _puzzle_item(row: dict) -> PuzzleItem:
    attempts, correct = int(row["attempts"]), int(row["correct_attempts"])
    reason = stored_quality_reason(row["quality"], row["cpl"])
    return PuzzleItem(
        puzzle_id=row["puzzle_id"],
        fen=row["fen_before"],
        orientation=row["color"],
        game=row["game_label"],
        move=row["move_label"],
        your_move_san=row["your_move_san"],
        your_move_uci=row["your_move_uci"],
        best_move_san=row["best_move_san"],
        best_move_uci=row["best_move_uci"],
        evaluation_loss_pawns=display_loss_pawns(row["cpl"], reason),
        quality=row["quality"],
        quality_reason=reason,
        opening=row["opening"],
        eco=row["eco"],
        phase=row["game_phase"],
        source_url=row["source_url"] or None,
        motif=row["motif"],
        difficulty=row["difficulty"],
        attempts=attempts,
        correct_attempts=correct,
        accuracy=(correct / attempts) if attempts else None,
        consecutive_correct=row["consecutive_correct"],
        next_review_at=_iso(row["next_review_at"]),
        mastered=row["mastered"],
    )


# Profiles (the classic player bar) ----------------------------------------------


def _profiles_payload(services: HostedAnalysisServices, account_id: str) -> dict[str, object]:
    active = services.practice.active_player(account_id)
    profiles = services.profiles.list(account_id)
    return {
        "active_username": active.username if active else None,
        "profiles": [
            {
                "username": profile.player.canonical_username,
                "display_username": profile.player.display_username,
            }
            for profile in profiles
        ],
    }


@router.get("/api/profiles")
def list_profiles(request: Request) -> dict[str, object]:
    services, account_id = _context(request)
    with guarded():
        return _profiles_payload(services, account_id)


@router.post("/api/profiles", status_code=201)
def create_profile(request: Request, body: ProfileCreateRequest) -> dict[str, object]:
    services, account_id = _context(request)
    with guarded():
        profile = services.profiles.claim(account_id, body.username)
        if body.activate or services.practice.active_player(account_id) is None:
            services.practice.set_active(account_id, profile.player.id)
        active = services.practice.active_player(account_id)
    return {
        "username": profile.player.canonical_username,
        "display_username": profile.player.display_username,
        "active_username": active.username if active else None,
    }


@router.post("/api/profiles/{username}/activate")
def activate_profile(request: Request, username: str) -> dict[str, object]:
    services, account_id = _context(request)
    wanted = username.strip().lower()
    with guarded():
        profile = next(
            (item for item in services.profiles.list(account_id)
             if item.player.canonical_username == wanted),
            None,
        )
        if profile is None:
            raise HostedApiError(404, "unknown_profile", "That player is not on your account")
        services.practice.set_active(account_id, profile.player.id)
        return _profiles_payload(services, account_id)


# Dashboard and report -------------------------------------------------------------------


@router.get("/api/dashboard", response_model=DashboardResponse)
def dashboard(request: Request) -> DashboardResponse:
    services, player = _active(request)
    summary = services.practice.progress(player)
    artifacts = services.practice.result_artifacts(player)
    analyzed = services.practice.analyzed_moves(player)
    analyzed_at = max(artifacts.values(), default=None)

    def state(artifact_type: str, rows: int | None = None) -> ArtifactState:
        created = artifacts.get(artifact_type)
        return ArtifactState(exists=created is not None, updated_at=created, rows=rows)

    return DashboardResponse(
        analyzed_moves=analyzed,
        training=TrainingSummary(
            total_puzzles=summary.total_puzzles,
            due_puzzles=summary.due_puzzles,
            reviewed_puzzles=summary.reviewed_puzzles,
            mastered_puzzles=summary.mastered_puzzles,
            total_reviews=summary.total_reviews,
            accuracy=summary.accuracy,
        ),
        artifacts={
            "analysis": ArtifactState(exists=bool(player.job_id), updated_at=analyzed_at, rows=analyzed),
            "puzzles": state("puzzles", summary.total_puzzles),
            "model": state("model_summary"),
            "report": state("report"),
        },
    )


@router.get("/api/report")
def report(request: Request) -> HTMLResponse:
    services, player = _active(request)
    key = services.practice.artifact_key(player, "report")
    if key is None:
        raise HostedApiError(404, "no_report", "Report not found. Run the analysis from the Pipeline page.")
    with guarded():
        stored = services.storage.get(key, max_bytes=MAX_UPLOAD_BYTES)
    document = json.loads(bounded_gunzip(stored.body, MAX_DECOMPRESSED_BYTES))
    return HTMLResponse(render_report_page(str(document["markdown"])))


# Practice ---------------------------------------------------------------------------------


@router.get("/api/practice/next", response_model=PracticeNextResponse)
def practice_next(request: Request) -> PracticeNextResponse:
    services, player = _active(request)
    if not player.dependency_hash:
        raise _no_puzzles()
    row = services.practice.next_due(player)
    if row is None:
        return PracticeNextResponse(puzzle=None)
    return PracticeNextResponse(
        puzzle=PracticePuzzle(
            puzzle_id=row["puzzle_id"],
            fen=row["fen_before"],
            orientation=row["color"],
            game=row["game_label"],
            move=row["move_label"],
            opening=row["opening"],
            eco=row["eco"],
            phase=row["game_phase"],
            motif=row["motif"],
            difficulty=row["difficulty"],
            source_url=row["source_url"] or None,
        )
    )


@router.post("/api/practice/{puzzle_id}/attempt", response_model=AttemptResponse)
def practice_attempt(request: Request, puzzle_id: str, body: AttemptRequest) -> AttemptResponse:
    services, player = _active(request)
    row = services.practice.get_puzzle(player, puzzle_id)
    if row is None:
        raise HostedApiError(404, "puzzle_not_found", "Puzzle not found")
    try:
        move = chess.Move.from_uci(body.move_uci.lower())
    except ValueError as exc:
        raise HostedApiError(422, "illegal_move", "Move must be legal UCI notation") from exc
    if move not in chess.Board(row["fen_before"]).legal_moves:
        raise HostedApiError(422, "illegal_move", "Submitted move is not legal in this position")
    answer = move.uci()
    correct = answer == row["best_move_uci"]
    try:
        review = services.practice.record_review(player, puzzle_id, answer=answer, correct=correct)
    except PracticeError as exc:
        raise _practice_error(exc) from exc
    reason = stored_quality_reason(row["quality"], row["cpl"])
    return AttemptResponse(
        correct=correct,
        best_move_san=row["best_move_san"],
        best_move_uci=row["best_move_uci"],
        your_game_move=row["your_move_san"],
        evaluation_loss_pawns=display_loss_pawns(row["cpl"], reason),
        quality=row["quality"],
        quality_reason=reason,
        next_interval_days=review.next_interval_days,
        next_review_at=review.next_review_at,
        source_url=row["source_url"] or None,
    )


@router.post("/api/practice/{puzzle_id}/skip")
def practice_skip(request: Request, puzzle_id: str) -> dict[str, bool]:
    services, player = _active(request)
    if services.practice.get_puzzle(player, puzzle_id) is None:
        raise HostedApiError(404, "puzzle_not_found", "Puzzle not found")
    return {"skipped": True}


@router.post("/api/practice/{puzzle_id}/adaptive/complete", response_model=AdaptiveReviewResult)
def adaptive_complete(
    request: Request, puzzle_id: str, body: AdaptiveCompleteRequest
) -> AdaptiveReviewResult:
    services, player = _active(request)
    if body.continuation_correct > body.continuation_attempts:
        raise HostedApiError(422, "invalid_drill", "Continuation counts are inconsistent")
    row = services.practice.get_puzzle(player, puzzle_id)
    if row is None:
        raise HostedApiError(404, "puzzle_not_found", "Puzzle not found")
    if chess.Move.from_uci(body.answer) not in chess.Board(row["fen_before"]).legal_moves:
        raise HostedApiError(422, "illegal_move", "The first answer is not legal in this position")
    try:
        review = services.practice.record_adaptive_drill(
            player,
            puzzle_id,
            succeeded=body.succeeded,
            answer=body.answer,
            user_moves_accepted=body.user_moves_accepted,
            current_ply=body.current_ply,
            continuation_attempts=body.continuation_attempts,
            continuation_correct=body.continuation_correct,
        )
    except PracticeError as exc:
        raise _practice_error(exc) from exc
    return AdaptiveReviewResult(
        next_interval_days=review.next_interval_days,
        next_review_at=review.next_review_at,
        consecutive_correct=review.consecutive_correct,
        mastered=review.mastered,
    )


# Mistakes and progress ---------------------------------------------------------------------


@router.get("/api/puzzles", response_model=PuzzleListResponse)
def puzzles(
    request: Request,
    quality: str | None = None,
    motif: str | None = None,
    opening: str | None = None,
    reviewed: bool | None = None,
    mastered: bool | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> PuzzleListResponse:
    services, player = _active(request)
    rows, total = services.practice.list_puzzles(
        player, quality=quality, motif=motif, opening=opening, reviewed=reviewed,
        mastered=mastered, limit=limit, offset=offset,
    )
    return PuzzleListResponse(
        items=[_puzzle_item(row) for row in rows], total=total, limit=limit, offset=offset
    )


@router.get("/api/puzzles/{puzzle_id}", response_model=PuzzleItem)
def puzzle_detail(request: Request, puzzle_id: str) -> PuzzleItem:
    services, player = _active(request)
    row = services.practice.get_puzzle(player, puzzle_id)
    if row is None:
        raise HostedApiError(404, "puzzle_not_found", "Puzzle not found")
    return _puzzle_item(row)


@router.get("/api/progress", response_model=ProgressResponse)
def progress(request: Request) -> ProgressResponse:
    services, player = _active(request)
    summary = services.practice.progress(player)
    metrics = services.practice.adaptive_metrics(player)
    return ProgressResponse(
        total_puzzles=summary.total_puzzles,
        due_puzzles=summary.due_puzzles,
        reviewed_puzzles=summary.reviewed_puzzles,
        mastered_puzzles=summary.mastered_puzzles,
        total_reviews=summary.total_reviews,
        accuracy=summary.accuracy,
        by_motif=[ProgressGroupRow(**row.__dict__) for row in summary.by_motif],
        by_opening=[ProgressGroupRow(**row.__dict__) for row in summary.by_opening],
        daily_reviews=services.practice.daily_reviews(player),
        adaptive=AdaptiveProgressSummary(**metrics.__dict__),
    )


def install_hosted_classic(app: FastAPI) -> None:
    app.include_router(router)
