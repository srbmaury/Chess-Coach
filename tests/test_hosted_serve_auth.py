import time

import jwt
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.accounts import Account
from chess_ml_coach.hosted.identity import SupabaseJwtVerifier
from chess_ml_coach.web.serve import create_served_app

SECRET = "test-secret-at-least-32-bytes-long-for-hs256"


class FakeAccountRepository:
    def upsert(self, *, account_id: str, email: str) -> Account:
        return Account(
            id=account_id, email=email, stripe_customer_id=None,
            created_at=None, updated_at=None,
        )


def test_served_app_forwards_auth_dependencies_to_the_whoami_route(tmp_path):
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html></html>", encoding="utf-8")
    settings = Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
        supabase_jwt_secret=SECRET,
    )
    app = create_served_app(
        settings,
        static_dir=static_dir,
        jwt_verifier=SupabaseJwtVerifier.from_settings(settings),
        account_repository=FakeAccountRepository(),
    )
    now = int(time.time())
    token = jwt.encode(
        {"sub": "acct-1", "email": "a@example.com", "aud": "authenticated", "exp": now + 3600, "iat": now},
        SECRET, algorithm="HS256",
    )

    response = TestClient(app).get(
        "/api/hosted/account/me", headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "acct-1"
