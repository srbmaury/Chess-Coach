from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import chess
import markdown as markdown_lib
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse

from ..adaptive_store import AdaptiveSessionStore
from ..config import Settings
from ..hosted.accounts import AccountRepository
from ..hosted.database import Database
from ..hosted.identity import SupabaseJwtVerifier
from ..move_quality import display_loss_pawns, stored_quality_reason
from ..services import training_db_path
from ..training import TrainingStore
from .adaptive_routes import AdaptiveServiceRegistry
from .adaptive_routes import router as adaptive_router
from .explanation_routes import router as explanation_router
from .hosted_analysis_routes import HostedAnalysisServices, install_hosted_analysis
from .hosted_routes import router as hosted_router
from .pipeline import (
    TERMINAL_STATUSES,
    PipelineBusyError,
    PipelineManager,
    UnknownPipelineStageError,
)
from .schemas import (
    AdaptiveProgressSummary,
    ArtifactState,
    AttemptRequest,
    AttemptResponse,
    DashboardResponse,
    HealthResponse,
    PracticeNextResponse,
    PracticePuzzle,
    ProgressGroupRow,
    ProgressResponse,
    PuzzleItem,
    PuzzleListResponse,
    TrainingSummary,
)
from .storage import daily_reviews, get_puzzle, list_puzzles

APP_VERSION = "0.1.0"


def _require_training_db(settings: Settings) -> Path:
    path = training_db_path(settings)
    if not path.exists():
        raise HTTPException(
            status_code=409,
            detail="Puzzle bank not found. Run Features, then Puzzles from the Pipeline page.",
        )
    return path


def _artifact_state(path: Path, *, parquet_rows: bool = False) -> ArtifactState:
    if not path.exists():
        return ArtifactState(exists=False)
    rows = None
    if parquet_rows:
        try:
            import pyarrow.parquet as pq

            rows = int(pq.ParquetFile(path).metadata.num_rows)
        except (OSError, ValueError):
            rows = None
    return ArtifactState(
        exists=True,
        updated_at=datetime.fromtimestamp(path.stat().st_mtime, tz=UTC),
        rows=rows,
    )


def _render_report_page(report_markdown: str) -> str:
    body = markdown_lib.markdown(report_markdown, extensions=["tables", "sane_lists"])
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coaching report</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{
    margin: 0; padding: 32px 20px 64px; background: #11130f; color: #f3f4ef;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    line-height: 1.6;
  }}
  main {{ max-width: 880px; margin: 0 auto; }}
  h1, h2, h3 {{ line-height: 1.3; }}
  h1 {{ font-size: 30px; margin: 0 0 20px; }}
  h2 {{ font-size: 20px; margin: 36px 0 12px; padding-top: 16px; border-top: 1px solid #2b3026; }}
  h2:first-of-type {{ border-top: 0; padding-top: 0; }}
  strong {{ color: #d7ff75; }}
  a {{ color: #d7ff75; }}
  p, li {{ color: #f3f4ef; }}
  ul {{ padding-left: 22px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 14px; }}
  th, td {{ border: 1px solid #2b3026; padding: 8px 10px; text-align: left; }}
  th {{ background: #1a1d17; color: #9da596; font-weight: 600; }}
  tr:nth-child(even) td {{ background: #14170f; }}
</style>
</head>
<body>
<main>
{body}
</main>
</body>
</html>
"""


def _empty_training_summary() -> TrainingSummary:
    return TrainingSummary(
        total_puzzles=0,
        due_puzzles=0,
        reviewed_puzzles=0,
        mastered_puzzles=0,
        total_reviews=0,
        accuracy=None,
    )


def _training_summary(settings: Settings) -> TrainingSummary:
    db_path = training_db_path(settings)
    if not db_path.exists():
        return _empty_training_summary()
    summary = TrainingStore(db_path).progress()
    return TrainingSummary(
        total_puzzles=summary.total_puzzles,
        due_puzzles=summary.due_puzzles,
        reviewed_puzzles=summary.reviewed_puzzles,
        mastered_puzzles=summary.mastered_puzzles,
        total_reviews=summary.total_reviews,
        accuracy=summary.accuracy,
    )


def _public_practice_puzzle(puzzle) -> PracticePuzzle:
    return PracticePuzzle(
        puzzle_id=puzzle.puzzle_id,
        fen=puzzle.fen_before,
        orientation=puzzle.color,
        game=puzzle.game_label,
        move=puzzle.move_label,
        opening=puzzle.opening,
        eco=puzzle.eco,
        phase=puzzle.game_phase,
        motif=puzzle.motif,
        difficulty=puzzle.difficulty,
        source_url=puzzle.source_url or None,
    )


def create_app(
    settings: Settings | None = None,
    *,
    pipeline_manager: PipelineManager | None = None,
    adaptive_services: AdaptiveServiceRegistry | None = None,
    database: Database | None = None,
    jwt_verifier: SupabaseJwtVerifier | None = None,
    account_repository: AccountRepository | None = None,
    hosted_analysis: HostedAnalysisServices | None = None,
) -> FastAPI:
    initial = settings or Settings()
    hosted = initial.is_hosted
    # Hosted Render is stateless: no pipeline, native engine, or local artifact routes.
    manager = None if hosted else pipeline_manager or PipelineManager(initial)
    adaptive = adaptive_services or AdaptiveServiceRegistry()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if database is not None:
            database.open()
        try:
            yield
        finally:
            adaptive.close_all()
            if database is not None:
                database.close()

    app = FastAPI(title="Chess ML Coach", version=APP_VERSION, lifespan=lifespan)
    app.state.settings = initial
    app.state.pipeline_manager = manager
    app.state.adaptive_services = adaptive
    app.state.database = database
    app.state.jwt_verifier = jwt_verifier
    app.state.account_repository = account_repository
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    if not hosted:
        app.include_router(explanation_router)
        app.include_router(adaptive_router)
    app.include_router(hosted_router)
    install_hosted_analysis(app, hosted_analysis)

    def current() -> Settings:
        return app.state.settings

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        active = current()
        database_ready = None
        if active.is_hosted:
            database_ready = database is not None and database.is_ready()
        return HealthResponse(
            version=APP_VERSION,
            username=active.username,
            data_dir=str(active.data_dir),
            model_dir=str(active.model_dir),
            persistence_mode=active.persistence_mode,
            database_ready=database_ready,
        )

    local = APIRouter()

    def _report_path(settings: Settings) -> Path:
        return settings.data_dir / "processed" / "coaching_report.md"

    @local.get("/api/dashboard", response_model=DashboardResponse)
    def dashboard() -> DashboardResponse:
        active = current()
        analysis_path = active.data_dir / "engine" / "analysis.parquet"
        features_path = active.data_dir / "processed" / "features.parquet"
        report_path = _report_path(active)
        db_path = training_db_path(active)
        model_path = active.model_dir / "mistake_model.joblib"
        analysis_state = _artifact_state(analysis_path, parquet_rows=True)
        return DashboardResponse(
            analyzed_moves=analysis_state.rows or 0,
            training=_training_summary(active),
            artifacts={
                "analysis": analysis_state,
                "features": _artifact_state(features_path, parquet_rows=True),
                "report": _artifact_state(report_path),
                "puzzles": _artifact_state(db_path),
                "model": _artifact_state(model_path),
            },
        )

    @local.get("/api/report")
    def report() -> HTMLResponse:
        report_path = _report_path(current())
        if not report_path.exists():
            raise HTTPException(
                status_code=404,
                detail="Report not found. Run the Report stage from the Pipeline page.",
            )
        return HTMLResponse(_render_report_page(report_path.read_text(encoding="utf-8")))

    @local.get("/api/practice/next", response_model=PracticeNextResponse)
    def practice_next() -> PracticeNextResponse:
        db_path = _require_training_db(current())
        due = TrainingStore(db_path).due_puzzles(limit=1)
        return PracticeNextResponse(
            puzzle=_public_practice_puzzle(due[0]) if due else None,
        )

    @local.post(
        "/api/practice/{puzzle_id}/attempt",
        response_model=AttemptResponse,
    )
    def practice_attempt(puzzle_id: str, request: AttemptRequest) -> AttemptResponse:
        db_path = _require_training_db(current())
        store = TrainingStore(db_path)
        puzzle = store.get_puzzle(puzzle_id)
        if puzzle is None or not puzzle.active:
            raise HTTPException(status_code=404, detail="Puzzle not found")
        try:
            move = chess.Move.from_uci(request.move_uci.lower())
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Move must be legal UCI notation") from exc
        board = chess.Board(puzzle.fen_before)
        if move not in board.legal_moves:
            raise HTTPException(status_code=422, detail="Submitted move is not legal in this position")
        normalized = move.uci()
        correct = normalized == puzzle.best_move_uci
        review = store.record_review(puzzle_id, answer=normalized, correct=correct)
        quality_reason = stored_quality_reason(puzzle.quality, puzzle.cpl)
        return AttemptResponse(
            correct=correct,
            best_move_san=puzzle.best_move_san,
            best_move_uci=puzzle.best_move_uci,
            your_game_move=puzzle.your_move_san,
            evaluation_loss_pawns=display_loss_pawns(puzzle.cpl, quality_reason),
            quality=puzzle.quality,
            quality_reason=quality_reason,
            next_interval_days=review.next_interval_days,
            next_review_at=review.next_review_at,
            source_url=puzzle.source_url or None,
        )

    @local.post("/api/practice/{puzzle_id}/skip")
    def practice_skip(puzzle_id: str) -> dict[str, bool]:
        db_path = _require_training_db(current())
        puzzle = TrainingStore(db_path).get_puzzle(puzzle_id)
        if puzzle is None or not puzzle.active:
            raise HTTPException(status_code=404, detail="Puzzle not found")
        return {"skipped": True}

    @local.get("/api/puzzles", response_model=PuzzleListResponse)
    def puzzles(
        quality: str | None = None,
        motif: str | None = None,
        opening: str | None = None,
        reviewed: bool | None = None,
        mastered: bool | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> PuzzleListResponse:
        db_path = _require_training_db(current())
        items, total = list_puzzles(
            db_path,
            quality=quality,
            motif=motif,
            opening=opening,
            reviewed=reviewed,
            mastered=mastered,
            limit=limit,
            offset=offset,
        )
        return PuzzleListResponse(
            items=[PuzzleItem.model_validate(item) for item in items],
            total=total,
            limit=limit,
            offset=offset,
        )

    @local.get("/api/puzzles/{puzzle_id}", response_model=PuzzleItem)
    def puzzle_detail(puzzle_id: str) -> PuzzleItem:
        db_path = _require_training_db(current())
        item = get_puzzle(db_path, puzzle_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Puzzle not found")
        return PuzzleItem.model_validate(item)

    @local.get("/api/progress", response_model=ProgressResponse)
    def progress() -> ProgressResponse:
        db_path = _require_training_db(current())
        summary = TrainingStore(db_path).progress()
        adaptive_metrics = AdaptiveSessionStore(db_path).metrics()
        return ProgressResponse(
            total_puzzles=summary.total_puzzles,
            due_puzzles=summary.due_puzzles,
            reviewed_puzzles=summary.reviewed_puzzles,
            mastered_puzzles=summary.mastered_puzzles,
            total_reviews=summary.total_reviews,
            accuracy=summary.accuracy,
            by_motif=[ProgressGroupRow(**row.__dict__) for row in summary.by_motif],
            by_opening=[ProgressGroupRow(**row.__dict__) for row in summary.by_opening],
            daily_reviews=daily_reviews(db_path),
            adaptive=AdaptiveProgressSummary(**adaptive_metrics.__dict__),
        )

    @local.get("/api/pipeline/status")
    def pipeline_status() -> dict[str, object]:
        return jsonable_encoder(asdict(manager.snapshot()))

    @local.post("/api/pipeline/{stage}", status_code=202)
    def start_pipeline(
        stage: str,
        options: dict[str, object] | None = None,
    ) -> dict[str, object]:
        try:
            snapshot = manager.start(stage, options, settings=current())
        except UnknownPipelineStageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except PipelineBusyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return jsonable_encoder(asdict(snapshot))

    @local.get("/api/pipeline/events")
    def pipeline_events(
        after_sequence: int | None = Query(default=None, ge=0),
    ) -> StreamingResponse:
        def stream():
            sequence = manager.latest_sequence() if after_sequence is None else after_sequence
            while True:
                events = manager.events(after_sequence=sequence)
                for event in events:
                    sequence = event.sequence
                    payload = {
                        "sequence": event.sequence,
                        "created_at": event.created_at.isoformat(),
                        **event.payload,
                    }
                    encoded = json.dumps(jsonable_encoder(payload), separators=(",", ":"))
                    yield f"data: {encoded}\n\n"
                snapshot = manager.snapshot()
                if snapshot.status in TERMINAL_STATUSES and not manager.events(
                    after_sequence=sequence
                ):
                    break
                if not events:
                    yield ": heartbeat\n\n"
                    time.sleep(0.25)

        return StreamingResponse(stream(), media_type="text/event-stream")

    if not hosted:
        app.include_router(local)
    return app
