from pathlib import Path

from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.web.app import create_app
from chess_ml_coach.web.serve import create_served_app


class FakeDatabase:
    def __init__(self, ready: bool):
        self.ready = ready

    def is_ready(self) -> bool:
        return self.ready


def _hosted_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
    )


def test_local_health_does_not_require_database(tmp_path: Path):
    app = create_app(Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"))

    payload = TestClient(app).get("/api/health").json()

    assert payload["persistence_mode"] == "local"
    assert payload["database_ready"] is None


def test_hosted_health_reports_database_readiness(tmp_path: Path):
    app = create_app(_hosted_settings(tmp_path), database=FakeDatabase(ready=True))

    payload = TestClient(app).get("/api/health").json()

    assert payload["persistence_mode"] == "hosted"
    assert payload["database_ready"] is True


def test_hosted_health_reports_unready_database(tmp_path: Path):
    app = create_app(_hosted_settings(tmp_path), database=FakeDatabase(ready=False))

    payload = TestClient(app).get("/api/health").json()

    assert payload["database_ready"] is False


def test_served_app_forwards_optional_database_to_health(tmp_path: Path):
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html></html>", encoding="utf-8")
    app = create_served_app(
        _hosted_settings(tmp_path),
        static_dir=static_dir,
        database=FakeDatabase(ready=True),
    )

    payload = TestClient(app).get("/api/health").json()

    assert payload["database_ready"] is True
