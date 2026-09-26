import pytest
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings, get_settings
from chess_ml_coach.web.app import create_app


def test_local_browser_config_contains_no_hosted_values():
    response = TestClient(create_app(Settings())).get("/api/hosted/config")

    assert response.status_code == 200
    assert response.json() == {"hosted": False}


def test_hosted_browser_config_is_public_and_exposes_only_browser_values():
    settings = Settings(
        persistence_mode="hosted",
        database_url="postgresql://private-user:private-password@example.invalid/chess",
        supabase_jwt_secret="private-jwt-secret",
        supabase_url="https://public-project.supabase.co",
        supabase_publishable_key="sb_publishable_public",
        hosted_browser_analysis_enabled=True,
    )

    response = TestClient(create_app(settings)).get("/api/hosted/config")

    assert response.status_code == 200
    assert response.json() == {
        "hosted": True,
        "supabase_url": "https://public-project.supabase.co",
        "supabase_publishable_key": "sb_publishable_public",
        "analysis_enabled": True,
        "engine_version": "19.0.0",
        "config_version": "1",
        "lease_seconds": 60,
        "renew_interval_seconds": 20,
        "max_upload_bytes": 8 * 1024 * 1024,
        "max_decompressed_bytes": 32 * 1024 * 1024,
        "max_browser_cache_bytes": 256 * 1024 * 1024,
    }
    body = response.text.lower()
    assert "private-password" not in body
    assert "private-jwt-secret" not in body
    assert "service_role" not in body


def test_hosted_persistence_keeps_browser_analysis_disabled_without_public_config():
    settings = Settings(
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
    )

    payload = TestClient(create_app(settings)).get("/api/hosted/config").json()

    assert payload["hosted"] is True
    assert payload["analysis_enabled"] is False
    assert payload["supabase_url"] is None
    assert payload["supabase_publishable_key"] is None


@pytest.mark.parametrize("missing", ["url", "key"])
def test_enabling_browser_analysis_requires_both_public_values(missing):
    kwargs = {
        "supabase_url": "https://public-project.supabase.co",
        "supabase_publishable_key": "sb_publishable_public",
    }
    kwargs["supabase_url" if missing == "url" else "supabase_publishable_key"] = None

    with pytest.raises(ValueError, match="SUPABASE_URL.*SUPABASE_PUBLISHABLE_KEY"):
        Settings(
            persistence_mode="hosted",
            database_url="postgresql://example.invalid/chess",
            hosted_browser_analysis_enabled=True,
            **kwargs,
        )


def test_public_settings_are_read_from_environment(monkeypatch):
    monkeypatch.setenv("CHESS_COACH_PERSISTENCE_MODE", "hosted")
    monkeypatch.setenv("DATABASE_URL", "postgresql://example.invalid/chess")
    monkeypatch.setenv("SUPABASE_URL", "https://public-project.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_public")
    monkeypatch.setenv("CHESS_COACH_HOSTED_BROWSER_ANALYSIS_ENABLED", "true")

    settings = get_settings()

    assert settings.supabase_url == "https://public-project.supabase.co"
    assert settings.supabase_publishable_key == "sb_publishable_public"
    assert settings.hosted_browser_analysis_enabled is True


def test_secret_key_cannot_be_published_as_browser_key():
    with pytest.raises(ValueError, match="SUPABASE_PUBLISHABLE_KEY"):
        Settings(
            persistence_mode="hosted",
            database_url="postgresql://example.invalid/chess",
            supabase_url="https://public-project.supabase.co",
            supabase_publishable_key="sb_secret_private",
        )


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "postgresql://private-user:private-password@example.invalid/chess",
        "https://private-user:private-password@project.supabase.co",
        "https://project.supabase.co?token=private-secret",
        "https://private-user:private-password@bad\uff0fhost",
    ],
)
def test_database_or_credentialed_url_cannot_be_published(unsafe_url):
    with pytest.raises(ValueError, match="SUPABASE_URL") as exc_info:
        Settings(
            persistence_mode="hosted",
            database_url="postgresql://example.invalid/chess",
            supabase_url=unsafe_url,
            supabase_publishable_key="sb_publishable_public",
        )
    assert "private-password" not in str(exc_info.value)
    assert "private-secret" not in str(exc_info.value)
    assert exc_info.value.__cause__ is None


def test_browser_analysis_flag_defaults_off_in_hosted_mode(monkeypatch):
    monkeypatch.delenv("CHESS_COACH_HOSTED_BROWSER_ANALYSIS_ENABLED", raising=False)

    settings = Settings(
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
        supabase_url="https://public-project.supabase.co",
        supabase_publishable_key="sb_publishable_public",
    )

    assert (
        TestClient(create_app(settings)).get("/api/hosted/config").json()["analysis_enabled"]
        is False
    )
