import pytest

from chess_ml_coach.config import get_settings


def test_settings_default_to_local_without_database(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CHESS_COACH_PERSISTENCE_MODE", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    settings = get_settings()
    assert settings.persistence_mode == "local"
    assert settings.database_url is None
    assert settings.is_hosted is False


def test_hosted_settings_require_database_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHESS_COACH_PERSISTENCE_MODE", "hosted")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValueError, match="DATABASE_URL"):
        get_settings()


def test_hosted_settings_read_database_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHESS_COACH_PERSISTENCE_MODE", "hosted")
    monkeypatch.setenv("DATABASE_URL", "postgresql://example.invalid/chess")
    settings = get_settings()
    assert settings.is_hosted is True
    assert settings.database_url == "postgresql://example.invalid/chess"


def test_unknown_persistence_mode_is_rejected(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHESS_COACH_PERSISTENCE_MODE", "other")
    with pytest.raises(ValueError, match="local.*hosted"):
        get_settings()


def test_explicit_hosted_arguments_override_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CHESS_COACH_PERSISTENCE_MODE", "local")
    settings = get_settings(
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
    )
    assert settings.is_hosted is True
