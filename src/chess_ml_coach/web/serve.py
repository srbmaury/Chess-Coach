from __future__ import annotations

import hashlib
import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..config import Settings
from ..hosted.accounts import AccountRepository
from ..hosted.database import Database
from ..hosted.identity import SupabaseJwtVerifier
from .app import create_app
from .hosted_analysis_routes import HostedAnalysisServices
from .profile_routes import enable_profiles

_BUILD_INPUTS = (
    "index.html",
    "package.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "vite.config.ts",
    "scripts/write-build-fingerprint.mjs",
)


def default_frontend_dist() -> Path:
    configured = os.getenv("CHESS_COACH_FRONTEND_DIST")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[3] / "web" / "dist"


def _frontend_source_fingerprint(root: Path) -> str:
    files = [path for path in (root / "src").rglob("*") if path.is_file()]
    files.extend(path for name in _BUILD_INPUTS if (path := root / name).is_file())
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _verify_frontend_build(dist: Path, source_root: Path) -> None:
    marker = dist / ".source-fingerprint"
    expected = _frontend_source_fingerprint(source_root)
    try:
        actual = marker.read_text(encoding="utf-8").strip()
    except OSError:
        actual = ""
    if not actual or actual != expected:
        raise RuntimeError(
            "The frontend build is stale. Run `cd web && npm install && npm run build` "
            "before starting `chess-coach ui`."
        )


def create_served_app(
    settings: Settings | None = None,
    *,
    static_dir: Path | None = None,
    source_dir: Path | None = None,
    initial_username: str | None = None,
    database: Database | None = None,
    jwt_verifier: SupabaseJwtVerifier | None = None,
    account_repository: AccountRepository | None = None,
    hosted_analysis: HostedAnalysisServices | None = None,
):
    dist = Path(static_dir) if static_dir is not None else default_frontend_dist()
    index_path = dist / "index.html"
    if not index_path.exists():
        raise FileNotFoundError(
            f"Missing built web UI at {index_path}. Run `cd web && npm install && npm run build` first."
        )

    source_root = Path(source_dir) if source_dir is not None else None
    if source_root is None and static_dir is None:
        source_root = dist.parent
    if source_root is not None and (source_root / "src").exists():
        _verify_frontend_build(dist, source_root)

    resolved = settings or Settings()
    app = create_app(
        resolved,
        database=database,
        jwt_verifier=jwt_verifier,
        account_repository=account_repository,
        hosted_analysis=hosted_analysis,
    )
    enable_profiles(app, resolved, initial_username=initial_username)
    assets = dist / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        return FileResponse(index_path)

    return app
