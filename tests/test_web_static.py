from pathlib import Path

import click
import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from chess_ml_coach.cli import app
from chess_ml_coach.config import Settings
from chess_ml_coach.web.serve import create_served_app, default_frontend_dist

runner = CliRunner()


def test_default_frontend_dist_honors_environment_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    dist = tmp_path / "deployed-web-dist"
    monkeypatch.setenv("CHESS_COACH_FRONTEND_DIST", str(dist))

    assert default_frontend_dist() == dist


def test_served_app_returns_spa_and_keeps_unknown_api_as_404(tmp_path: Path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>Chess UI</body></html>", encoding="utf-8")

    web_app = create_served_app(
        Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"),
        static_dir=dist,
    )
    client = TestClient(web_app)

    assert client.get("/").status_code == 200
    assert "Chess UI" in client.get("/practice").text
    assert client.get("/api/does-not-exist").status_code == 404


def test_served_app_serves_root_level_build_files_before_spa_fallback(tmp_path: Path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>Chess UI</body></html>", encoding="utf-8")
    preview = b"\\x89PNG\\r\\n\\x1a\\npreview"
    (dist / "social-preview.png").write_bytes(preview)

    web_app = create_served_app(
        Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"),
        static_dir=dist,
    )
    client = TestClient(web_app)

    response = client.get("/social-preview.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == preview

    assert "Chess UI" in client.get("/does-not-exist.png").text
    assert "Chess UI" in client.get("/../outside.txt").text


def test_served_app_requires_built_frontend(tmp_path: Path):
    try:
        create_served_app(static_dir=tmp_path / "missing")
    except FileNotFoundError as exc:
        assert "npm run build" in str(exc)
    else:
        raise AssertionError("expected missing frontend build to fail")


def test_served_app_rejects_stale_frontend_bundle(tmp_path: Path):
    web_root = tmp_path / "web"
    source = web_root / "src"
    dist = web_root / "dist"
    source.mkdir(parents=True)
    dist.mkdir()
    (source / "App.tsx").write_text("export default function App(){return null}", encoding="utf-8")
    (web_root / "package.json").write_text('{"scripts":{"build":"vite build"}}', encoding="utf-8")
    (dist / "index.html").write_text("<html><body>old build</body></html>", encoding="utf-8")
    (dist / ".source-fingerprint").write_text("stale", encoding="utf-8")

    with pytest.raises(RuntimeError, match="frontend build is stale"):
        create_served_app(
            Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"),
            static_dir=dist,
            source_dir=web_root,
        )


def test_cli_exposes_ui_and_defaults_to_localhost():
    help_result = runner.invoke(app, ["--help"])
    assert help_result.exit_code == 0
    assert "ui" in click.unstyle(help_result.stdout)

    ui_help = runner.invoke(app, ["ui", "--help"])
    assert ui_help.exit_code == 0
    plain_help = click.unstyle(ui_help.stdout)
    assert "127.0.0.1" in plain_help
    assert "--no-open" in plain_help
