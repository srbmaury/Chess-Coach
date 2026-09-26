from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, TypeVar

import typer

from . import services
from .config import Settings
from .config import get_settings as _get_root_settings
from .hosted.database import Database
from .hosted.migrations import apply_migrations
from .profiles import ProfileManager, canonicalize_username

app = typer.Typer(no_args_is_help=True)
T = TypeVar("T")
ProgressCallback = Callable[[dict[str, object]], None]

# Keep these aliases as stable monkeypatch/backward-compatibility seams for the CLI tests.
_run_sync = services.run_sync
_run_analyze = services.run_analyze
_run_features = services.run_features
_run_train = services.run_train
_run_report = services.run_report
_run_puzzles = services.run_puzzles
_training_db_path = services.training_db_path
_answer_to_uci = services.answer_to_uci
_database_factory = Database.from_settings
_apply_migrations = apply_migrations


def _resolve_profile_settings(username: str | None, **kwargs) -> Settings:
    """Resolve CLI commands into an isolated per-player workspace."""
    root = _get_root_settings(None, **kwargs)
    manager = ProfileManager(root)
    manager.migrate_legacy(root.username)
    selected = username or root.username
    manager.create_or_activate(selected, activate=False)
    return manager.settings_for(selected)


get_settings = _resolve_profile_settings


def _execute(action: Callable[[], T]) -> T:
    try:
        return action()
    except typer.Exit:
        raise
    except Exception as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(code=1) from exc


def _print_sync_progress(event: dict[str, object]) -> None:
    archive = str(event.get("archive", ""))
    parts = archive.rstrip("/").split("/")
    month = "/".join(parts[-2:]) if len(parts) >= 2 else archive
    status = " skipped (unavailable)" if event.get("skipped") else ""
    typer.echo(
        f"[sync] {event.get('current')}/{event.get('total')} {month} • "
        f"{event.get('game_count')} games{status}"
    )


def _print_analyze_progress(event: dict[str, object]) -> None:
    completed = int(event.get("completed", 0))
    total = int(event.get("total", 0))
    reused = int(event.get("reused", 0))
    analyzed = int(event.get("analyzed", 0))
    detail = ""
    if event.get("game_id") is not None and event.get("ply") is not None:
        detail = f" • ply {event['ply']}"
    typer.echo(
        f"\r[analyze] {completed}/{total} • {reused} reused • {analyzed} new{detail}",
        nl=False,
    )


def _print_train_progress(event: dict[str, object]) -> None:
    typer.echo(f"[train] {event.get('message', event.get('stage', 'working'))}")


def _print_puzzle_progress(event: dict[str, object]) -> None:
    typer.echo(
        f"\r[puzzles] scanning {event.get('current')}/{event.get('total')} • "
        f"{event.get('eligible')} eligible",
        nl=False,
    )


def _run_practice(settings, limit: int) -> dict:
    import chess

    from .training import TrainingStore

    if limit <= 0:
        raise ValueError("--limit must be greater than zero")
    db_path = _training_db_path(settings)
    if not db_path.exists():
        raise FileNotFoundError(f"Missing {db_path}. Run `chess-coach puzzles` first.")
    store = TrainingStore(db_path)
    due = store.due_puzzles(limit=limit)
    if not due:
        typer.echo("No puzzles are due right now. Use `chess-coach progress` to see your schedule.")
        return {"reviewed": 0, "correct": 0, "stopped": False}

    reviewed = 0
    correct_count = 0
    for index, puzzle in enumerate(due, start=1):
        board = chess.Board(puzzle.fen_before)
        side = "White" if board.turn == chess.WHITE else "Black"
        typer.echo("")
        typer.echo(f"Puzzle {index}/{len(due)} • {side} to move")
        typer.echo(f"Game: {puzzle.game_label} • {puzzle.move_label}")
        typer.echo(f"Opening: {puzzle.opening} ({puzzle.eco})")
        typer.echo(f"Phase: {puzzle.game_phase}")
        typer.echo(f"Theme (heuristic): {puzzle.motif} • Difficulty: {puzzle.difficulty}/5")
        typer.echo(str(board))
        answer = typer.prompt("Your move (SAN/UCI, q to quit)").strip()
        if answer.lower() in {"q", "quit", "exit"}:
            typer.echo("Practice stopped. No review was recorded for this puzzle.")
            return {"reviewed": reviewed, "correct": correct_count, "stopped": True}

        answer_uci = _answer_to_uci(puzzle.fen_before, answer)
        correct = answer_uci == puzzle.best_move_uci
        review = store.record_review(
            puzzle.puzzle_id,
            answer=answer,
            correct=correct,
        )
        reviewed += 1
        if correct:
            correct_count += 1
            typer.echo(f"Correct! Best move: {puzzle.best_move_san}")
        else:
            typer.echo(f"Not quite. Best move: {puzzle.best_move_san}")
            typer.echo(f"You played in the game: {puzzle.your_move_san}")
            typer.echo(f"Evaluation loss: {puzzle.eval_loss_pawns:.2f} pawns")
        typer.echo(
            f"Next review: {review.next_review_at.date().isoformat()} "
            f"(+{review.next_interval_days} days)"
        )
        if puzzle.source_url:
            typer.echo(f"Game: {puzzle.source_url}")

    return {"reviewed": reviewed, "correct": correct_count, "stopped": False}


def _run_progress(settings):
    from .training import TrainingStore

    db_path = _training_db_path(settings)
    if not db_path.exists():
        raise FileNotFoundError(f"Missing {db_path}. Run `chess-coach puzzles` first.")
    return TrainingStore(db_path).progress()


def _accuracy_text(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1%}"


def _print_progress_rows(title: str, rows) -> None:
    typer.echo(title)
    if not rows:
        typer.echo("  No data yet.")
        return
    for row in rows[:8]:
        typer.echo(
            f"  {row.label}: {row.puzzles} puzzles • {row.attempts} reviews • "
            f"{_accuracy_text(row.accuracy)} accuracy"
        )


@app.command("db-migrate")
def db_migrate(
    database_url: Annotated[str | None, typer.Option("--database-url")] = None,
) -> None:
    """Apply pending hosted PostgreSQL migrations."""
    resolved_url = database_url or os.getenv("DATABASE_URL")
    if not resolved_url:
        typer.echo("DATABASE_URL is required for db-migrate")
        raise typer.Exit(code=1)
    database = None
    try:
        hosted = _get_root_settings(
            None,
            persistence_mode="hosted",
            database_url=resolved_url,
        )
        database = _database_factory(hosted)
        try:
            database.open()
            applied = _apply_migrations(database)
        finally:
            database.close()
    except Exception:  # noqa: BLE001 - never expose database connection details to the CLI.
        typer.echo("Database migration failed", err=True)
        raise typer.Exit(code=1) from None
    if applied:
        typer.echo(f"Applied migrations: {', '.join(applied)}")
    else:
        typer.echo("Database schema is already current")


@app.command()
def sync(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
) -> None:
    """Download and deduplicate Chess.com games."""
    settings = _execute(lambda: get_settings(username, data_dir=data_dir))
    result = _execute(lambda: _run_sync(settings, progress=_print_sync_progress))
    typer.echo(
        f"Synced {result['total']} games ({result['downloaded']} new games) -> {result['pgn_path']}"
    )


@app.command()
def analyze(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    stockfish_path: Annotated[str | None, typer.Option("--stockfish-path")] = None,
    depth: Annotated[int | None, typer.Option("--depth")] = None,
    inaccuracy_cpl: Annotated[int | None, typer.Option("--inaccuracy-cpl")] = None,
    mistake_cpl: Annotated[int | None, typer.Option("--mistake-cpl")] = None,
    blunder_cpl: Annotated[int | None, typer.Option("--blunder-cpl")] = None,
) -> None:
    """Parse PGNs and run resumable Stockfish analysis."""
    settings = _execute(
        lambda: get_settings(
            username,
            data_dir=data_dir,
            stockfish_path=stockfish_path,
            stockfish_depth=depth,
            inaccuracy_cpl=inaccuracy_cpl,
            mistake_cpl=mistake_cpl,
            blunder_cpl=blunder_cpl,
        )
    )
    result = _execute(lambda: _run_analyze(settings, progress=_print_analyze_progress))
    typer.echo()
    typer.echo(f"Analyzed {result['rows']} user moves -> {result['output']}")


@app.command()
def features(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    inaccuracy_cpl: Annotated[int | None, typer.Option("--inaccuracy-cpl")] = None,
    mistake_cpl: Annotated[int | None, typer.Option("--mistake-cpl")] = None,
    blunder_cpl: Annotated[int | None, typer.Option("--blunder-cpl")] = None,
) -> None:
    """Create the ML-ready feature dataset."""
    settings = _execute(
        lambda: get_settings(
            username,
            data_dir=data_dir,
            inaccuracy_cpl=inaccuracy_cpl,
            mistake_cpl=mistake_cpl,
            blunder_cpl=blunder_cpl,
        )
    )
    result = _execute(lambda: _run_features(settings))
    typer.echo(f"Built {result['rows']} feature rows -> {result['output']}")


@app.command()
def train(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    model_dir: Annotated[Path | None, typer.Option("--model-dir")] = None,
) -> None:
    """Train the personalized LightGBM mistake-risk model."""
    settings = _execute(
        lambda: get_settings(username, data_dir=data_dir, model_dir=model_dir)
    )
    result = _execute(lambda: _run_train(settings, progress=_print_train_progress))
    typer.echo(f"Saved model -> {result['model_path']}")
    typer.echo(json.dumps(result["metrics"], indent=2, sort_keys=True))


@app.command()
def report(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    model_dir: Annotated[Path | None, typer.Option("--model-dir")] = None,
    min_group_size: Annotated[int | None, typer.Option("--min-group-size")] = None,
) -> None:
    """Generate a statistically guarded coaching report."""
    settings = _execute(
        lambda: get_settings(
            username,
            data_dir=data_dir,
            model_dir=model_dir,
            min_group_size=min_group_size,
        )
    )
    result = _execute(lambda: _run_report(settings))
    typer.echo(f"Generated report from {result['samples']} moves -> {result['output']}")


@app.command()
def puzzles(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
) -> None:
    """Build or refresh a personal puzzle bank from analyzed mistakes."""
    settings = _execute(lambda: get_settings(username, data_dir=data_dir))
    result = _execute(lambda: _run_puzzles(settings, progress=_print_puzzle_progress))
    typer.echo()
    typer.echo(
        f"Puzzle bank: {result['eligible']} eligible • {result['inserted']} new • "
        f"{result['updated']} refreshed • {result['total']} total -> {result['db_path']}"
    )


@app.command()
def practice(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    limit: Annotated[int, typer.Option("--limit", min=1)] = 10,
) -> None:
    """Practice due positions from your own mistakes."""
    settings = _execute(lambda: get_settings(username, data_dir=data_dir))
    result = _execute(lambda: _run_practice(settings, limit))
    if result["reviewed"]:
        typer.echo(
            f"Session: {result['correct']}/{result['reviewed']} correct "
            f"({_accuracy_text(result['correct'] / result['reviewed'])})"
        )


@app.command()
def progress(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
) -> None:
    """Show personal puzzle review progress and recurring themes."""
    settings = _execute(lambda: get_settings(username, data_dir=data_dir))
    summary = _execute(lambda: _run_progress(settings))
    typer.echo("Puzzle training progress")
    typer.echo(f"Total puzzles: {summary.total_puzzles}")
    typer.echo(f"Due now: {summary.due_puzzles}")
    typer.echo(f"Reviewed: {summary.reviewed_puzzles}")
    typer.echo(f"Mastered: {summary.mastered_puzzles}")
    typer.echo(f"Total reviews: {summary.total_reviews}")
    typer.echo(f"Review accuracy: {_accuracy_text(summary.accuracy)}")
    _print_progress_rows("Top heuristic motifs:", summary.by_motif)
    _print_progress_rows("Top openings:", summary.by_opening)


@app.command("delete-user-data")
def delete_user_data(
    username: Annotated[str, typer.Option("--username")],
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    model_dir: Annotated[Path | None, typer.Option("--model-dir")] = None,
    yes: Annotated[
        bool,
        typer.Option("--yes", help="Delete without the interactive username confirmation."),
    ] = False,
) -> None:
    """Permanently delete all locally stored data for one player."""
    root = _execute(
        lambda: _get_root_settings(None, data_dir=data_dir, model_dir=model_dir)
    )
    key = _execute(lambda: canonicalize_username(username))
    if not yes:
        confirmation = typer.prompt(
            f"Type '{key}' to permanently delete this player's local data"
        )
        if confirmation.strip() != key:
            typer.echo("Deletion cancelled.")
            raise typer.Exit(code=1)

    manager = ProfileManager(root)
    _execute(lambda: manager.delete_profile(key))
    typer.echo(f"Permanently deleted local data for '{key}'.")


@app.command()
def ui(
    username: Annotated[str | None, typer.Option("--username")] = None,
    data_dir: Annotated[Path | None, typer.Option("--data-dir")] = None,
    model_dir: Annotated[Path | None, typer.Option("--model-dir")] = None,
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port", min=1, max=65535)] = 8000,
    open_browser: Annotated[bool, typer.Option("--open/--no-open")] = True,
) -> None:
    """Start the local Chess ML Coach web application."""
    import threading
    import webbrowser

    import uvicorn

    from .hosted.accounts import PostgresAccountRepository
    from .hosted.database import Database
    from .hosted.identity import AuthConfigurationError, SupabaseJwtVerifier
    from .web.hosted_analysis_routes import build_hosted_analysis
    from .web.serve import create_served_app

    # UI starts from root storage so a fresh community clone can choose a player.
    root = _execute(
        lambda: _get_root_settings(None, data_dir=data_dir, model_dir=model_dir)
    )

    def _build_app():
        database = Database.from_settings(root) if root.is_hosted else None
        jwt_verifier = None
        account_repository = None
        hosted_analysis = None
        if database is not None:
            try:
                jwt_verifier = SupabaseJwtVerifier.from_settings(root)
            except AuthConfigurationError:
                # Hosted DB may go live before SUPABASE_URL is configured;
                # /api/hosted/* routes report 503 until it is set, rather than
                # refusing to start the whole service.
                jwt_verifier = None
            account_repository = PostgresAccountRepository(database)
            # Without SUPABASE_SECRET_KEY the analysis routes answer 503.
            hosted_analysis = build_hosted_analysis(root, database)
        return create_served_app(
            root,
            initial_username=username,
            database=database,
            jwt_verifier=jwt_verifier,
            account_repository=account_repository,
            hosted_analysis=hosted_analysis,
        )

    web_app = _execute(_build_app)
    url = f"http://{host}:{port}"
    typer.echo(f"Chess ML Coach UI -> {url}")
    if open_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    uvicorn.run(web_app, host=host, port=port)


if __name__ == "__main__":
    app()
