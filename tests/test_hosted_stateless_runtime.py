import chess.engine
import pytest
from fastapi.testclient import TestClient

import chess_ml_coach.engine as engine_module
import chess_ml_coach.web.app as app_module
from chess_ml_coach.config import Settings
from chess_ml_coach.web.app import create_app
from chess_ml_coach.web.serve import create_served_app

LOCAL_ROUTES = [
    ("get", "/api/dashboard"),
    ("get", "/api/report"),
    ("get", "/api/practice/next"),
    ("get", "/api/puzzles"),
    ("get", "/api/progress"),
    ("get", "/api/pipeline/status"),
    ("post", "/api/pipeline/analyze"),
    ("post", "/api/adaptive/puzzles/abc/start"),
    ("get", "/api/practice/abc/explanation"),
    ("get", "/api/profiles"),
]


def _hosted(tmp_path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://unused.invalid/db",
    )


@pytest.fixture
def no_native_engine(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("hosted mode must not construct native pipeline or engine objects")

    monkeypatch.setattr(app_module, "PipelineManager", forbidden)
    monkeypatch.setattr(engine_module, "StockfishAdapter", forbidden)
    monkeypatch.setattr(chess.engine.SimpleEngine, "popen_uci", forbidden)


@pytest.fixture
def dist(tmp_path):
    root = tmp_path / "dist"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><div id=root></div>")
    return root


def test_hosted_startup_builds_no_pipeline_or_engine_and_writes_nothing(tmp_path, dist, no_native_engine):
    settings = _hosted(tmp_path)
    app = create_served_app(settings, static_dir=dist)

    with TestClient(app) as client:
        assert client.get("/api/hosted/config").json()["hosted"] is True
        assert client.get("/api/health").status_code == 200
        for method, path in LOCAL_ROUTES:
            assert getattr(client, method)(path).status_code == 404, path
        assert client.get("/api/hosted/profiles").status_code == 503
        assert client.get("/").status_code == 200

    assert app.state.pipeline_manager is None
    assert not (tmp_path / "data").exists()
    assert not (tmp_path / "models").exists()


def test_oversized_streamed_bodies_are_rejected_before_buffering():
    import asyncio

    from chess_ml_coach.web.hosted_analysis_routes import BodyLimitMiddleware

    reached_app = []

    async def app(scope, receive, send):
        reached_app.append(True)

    middleware = BodyLimitMiddleware(app, max_bytes=16 * 1024)
    chunks_read = 0
    sent = []

    async def receive():
        nonlocal chunks_read
        chunks_read += 1
        return {"type": "http.request", "body": b"x" * 1024, "more_body": True}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "path": "/api/hosted/profiles", "headers": []}
    asyncio.run(middleware(scope, receive, send))

    assert sent[0]["status"] == 413
    assert chunks_read == 17
    assert not reached_app


def _render_env() -> dict[str, dict[str, str]]:
    import re
    from pathlib import Path

    text = (Path(__file__).parents[1] / "render.yaml").read_text()
    env: dict[str, dict[str, str]] = {}
    for block in re.split(r"\n\s*- key: ", text)[1:]:
        lines = block.splitlines()
        fields = dict(
            re.match(r"\s*(\w+):\s*(.*)", line).groups()
            for line in lines[1:]
            if re.match(r"\s+\w+:", line)
        )
        env[lines[0].strip()] = fields
    return env


def test_committed_render_config_enables_nothing_and_holds_no_secrets():
    env = _render_env()
    flag = env.get("CHESS_COACH_HOSTED_BROWSER_ANALYSIS_ENABLED", {"value": '"false"'})
    assert flag.get("value", '"false"').strip('"') == "false"
    for secret in ("SUPABASE_SECRET_KEY", "DATABASE_URL"):
        assert "value" not in env.get(secret, {}), f"{secret} must not be committed"


def test_local_mode_keeps_its_pipeline_and_routes(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"))
    client = TestClient(app)

    assert app.state.pipeline_manager is not None
    assert client.get("/api/pipeline/status").status_code == 200
    assert client.get("/api/dashboard").status_code == 200
