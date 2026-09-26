from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.web.app import create_app


class FakeDatabase:
    def __init__(self):
        self.opened = False
        self.closed = False

    def open(self) -> None:
        self.opened = True

    def close(self) -> None:
        self.closed = True

    def is_ready(self) -> bool:
        return self.opened and not self.closed


def _hosted_settings(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
    )


def test_hosted_database_opens_on_startup_and_closes_on_shutdown(tmp_path):
    database = FakeDatabase()
    app = create_app(_hosted_settings(tmp_path), database=database)

    with TestClient(app) as client:
        assert database.opened is True
        assert client.get("/api/health").json()["database_ready"] is True

    assert database.closed is True


def test_local_app_lifecycle_never_touches_a_database(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"))
    with TestClient(app) as client:
        assert client.get("/api/health").json()["database_ready"] is None
