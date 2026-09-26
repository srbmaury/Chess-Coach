import time

import jwt
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.accounts import Account
from chess_ml_coach.hosted.identity import SupabaseJwtVerifier
from chess_ml_coach.web.app import create_app

SECRET = "test-secret-at-least-32-bytes-long-for-hs256"


class FakeAccountRepository:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def upsert(self, *, account_id: str, email: str) -> Account:
        self.calls.append((account_id, email))
        return Account(
            id=account_id, email=email, stripe_customer_id=None,
            created_at=None, updated_at=None,
        )


def _token(subject: str = "11111111-1111-1111-1111-111111111111", **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": subject, "email": "player@example.com", "aud": "authenticated",
        "exp": now + 3600, "iat": now, **overrides,
    }
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _authed_app(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
        supabase_jwt_secret=SECRET,
    )
    repository = FakeAccountRepository()
    app = create_app(
        settings,
        jwt_verifier=SupabaseJwtVerifier.from_settings(settings),
        account_repository=repository,
    )
    return app, repository


def test_me_requires_a_bearer_token(tmp_path):
    app, _ = _authed_app(tmp_path)
    response = TestClient(app).get("/api/hosted/account/me")
    assert response.status_code == 401


def test_me_rejects_an_invalid_token(tmp_path):
    app, _ = _authed_app(tmp_path)
    response = TestClient(app).get(
        "/api/hosted/account/me", headers={"Authorization": "Bearer not-a-jwt"},
    )
    assert response.status_code == 401


def test_me_resolves_the_authenticated_account_from_the_token_subject(tmp_path):
    app, repository = _authed_app(tmp_path)
    response = TestClient(app).get(
        "/api/hosted/account/me",
        headers={"Authorization": f"Bearer {_token()}"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == "11111111-1111-1111-1111-111111111111"
    assert payload["email"] == "player@example.com"
    assert repository.calls == [("11111111-1111-1111-1111-111111111111", "player@example.com")]


def test_two_different_tokens_resolve_to_two_different_accounts(tmp_path):
    app, repository = _authed_app(tmp_path)
    client = TestClient(app)

    first = client.get(
        "/api/hosted/account/me",
        headers={"Authorization": f"Bearer {_token(subject='11111111-1111-1111-1111-111111111111')}"},
    ).json()
    second = client.get(
        "/api/hosted/account/me",
        headers={"Authorization": f"Bearer {_token(subject='22222222-2222-2222-2222-222222222222')}"},
    ).json()

    assert first["id"] != second["id"]
    assert {call[0] for call in repository.calls} == {
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
    }


def test_me_is_unavailable_when_hosted_auth_is_not_configured(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")
    app = create_app(settings)
    response = TestClient(app).get(
        "/api/hosted/account/me", headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 503
