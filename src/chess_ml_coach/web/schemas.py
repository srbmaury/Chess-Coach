from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    username: str
    data_dir: str
    model_dir: str
    persistence_mode: str
    database_ready: bool | None


class HostedBrowserConfig(BaseModel):
    hosted: bool
    supabase_url: str | None = None
    supabase_publishable_key: str | None = None
    analysis_enabled: bool | None = None
    engine_version: str | None = None
    config_version: str | None = None
    lease_seconds: int | None = None
    renew_interval_seconds: int | None = None
    max_upload_bytes: int | None = None
    max_decompressed_bytes: int | None = None
    max_browser_cache_bytes: int | None = None


class PracticePuzzle(BaseModel):
    puzzle_id: str
    fen: str
    orientation: str
    game: str
    move: str
    opening: str
    eco: str
    phase: str
    motif: str
    difficulty: int
    source_url: str | None = None


class PracticeNextResponse(BaseModel):
    puzzle: PracticePuzzle | None


class AttemptRequest(BaseModel):
    move_uci: str = Field(min_length=4, max_length=5)


class AttemptResponse(BaseModel):
    correct: bool
    best_move_san: str
    best_move_uci: str
    your_game_move: str
    evaluation_loss_pawns: float | None
    quality: str
    quality_reason: str
    next_interval_days: int
    next_review_at: datetime
    source_url: str | None = None


class AdaptiveSafeStep(BaseModel):
    step_index: int
    side: str
    move_uci: str
    move_san: str
    accepted: bool


class AdaptiveReviewResult(BaseModel):
    next_interval_days: int
    next_review_at: datetime
    consecutive_correct: int
    mastered: bool


class AdaptiveStartResponse(BaseModel):
    session_id: str
    puzzle_id: str
    status: str
    current_fen: str
    orientation: str
    user_moves_attempted: int
    user_moves_accepted: int
    current_ply: int
    max_eval_loss_cp: int
    max_user_decisions: int = 4
    steps: list[AdaptiveSafeStep]
    review: AdaptiveReviewResult | None = None


class AdaptiveMoveRequest(BaseModel):
    move_uci: str = Field(min_length=4, max_length=5)


class AdaptiveHintResponse(BaseModel):
    session_id: str
    puzzle_id: str
    status: str
    move_uci: str
    move_san: str
    current_fen: str
    user_moves_attempted: int
    user_moves_accepted: int
    current_ply: int


class AdaptiveMoveResponse(BaseModel):
    session_id: str
    puzzle_id: str
    status: str
    accepted: bool | None
    move_uci: str | None = None
    move_san: str | None = None
    eval_loss_cp: int | None = None
    engine_reply_uci: str | None = None
    engine_reply_san: str | None = None
    current_fen: str
    user_moves_attempted: int
    user_moves_accepted: int
    current_ply: int
    max_eval_loss_cp: int
    review: AdaptiveReviewResult | None = None


class PuzzleItem(BaseModel):
    puzzle_id: str
    fen: str
    orientation: str
    game: str
    move: str
    your_move_san: str
    your_move_uci: str
    best_move_san: str
    best_move_uci: str
    evaluation_loss_pawns: float | None
    quality: str
    quality_reason: str
    opening: str
    eco: str
    phase: str
    source_url: str | None = None
    motif: str
    difficulty: int
    attempts: int
    correct_attempts: int
    accuracy: float | None
    consecutive_correct: int
    next_review_at: datetime
    mastered: bool


class PuzzleListResponse(BaseModel):
    items: list[PuzzleItem]
    total: int
    limit: int
    offset: int


class DailyReviewRow(BaseModel):
    date: str
    reviews: int
    correct: int
    accuracy: float


class ProgressGroupRow(BaseModel):
    label: str
    puzzles: int
    attempts: int
    correct: int
    accuracy: float | None


class AdaptiveProgressSummary(BaseModel):
    sessions_completed: int
    success_rate: float | None
    continuation_accuracy: float | None
    average_accepted_decisions: float | None
    average_calculation_depth_plies: float | None


class ProgressResponse(BaseModel):
    total_puzzles: int
    due_puzzles: int
    reviewed_puzzles: int
    mastered_puzzles: int
    total_reviews: int
    accuracy: float | None
    by_motif: list[ProgressGroupRow]
    by_opening: list[ProgressGroupRow]
    daily_reviews: list[DailyReviewRow]
    adaptive: AdaptiveProgressSummary


class TrainingSummary(BaseModel):
    total_puzzles: int
    due_puzzles: int
    reviewed_puzzles: int
    mastered_puzzles: int
    total_reviews: int
    accuracy: float | None


class ArtifactState(BaseModel):
    exists: bool
    updated_at: datetime | None = None
    rows: int | None = None


class DashboardResponse(BaseModel):
    analyzed_moves: int
    training: TrainingSummary
    artifacts: dict[str, ArtifactState]
