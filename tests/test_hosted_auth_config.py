import pytest

from chess_ml_coach.config import get_settings


def test_settings_default_to_no_auth_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_AUDIENCE", raising=False)
    settings = get_settings()
    assert settings.supabase_jwt_secret is None
    assert settings.supabase_jwt_audience == "authenticated"


def test_settings_read_supabase_jwt_secret_from_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "env-secret")
    monkeypatch.setenv("SUPABASE_JWT_AUDIENCE", "custom-audience")
    settings = get_settings()
    assert settings.supabase_jwt_secret == "env-secret"
    assert settings.supabase_jwt_audience == "custom-audience"


def test_explicit_auth_arguments_override_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "env-secret")
    settings = get_settings(supabase_jwt_secret="explicit-secret", supabase_jwt_audience="explicit-aud")
    assert settings.supabase_jwt_secret == "explicit-secret"
    assert settings.supabase_jwt_audience == "explicit-aud"
