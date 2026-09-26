import pytest

from chess_ml_coach.config import get_settings


def test_settings_default_audience(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SUPABASE_JWT_AUDIENCE", raising=False)
    assert get_settings().supabase_jwt_audience == "authenticated"


def test_settings_read_audience_from_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_JWT_AUDIENCE", "custom-audience")
    assert get_settings().supabase_jwt_audience == "custom-audience"


def test_explicit_audience_overrides_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_JWT_AUDIENCE", "env-aud")
    assert get_settings(supabase_jwt_audience="explicit-aud").supabase_jwt_audience == "explicit-aud"


def test_shared_jwt_secret_is_no_longer_a_setting(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "legacy-secret")
    assert not hasattr(get_settings(), "supabase_jwt_secret")
