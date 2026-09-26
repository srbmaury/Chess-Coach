from fastapi.testclient import TestClient
from jwt_support import SUPABASE_URL, token, verifier

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.accounts import Account
from chess_ml_coach.web.serve import create_served_app


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
        supabase_url=SUPABASE_URL,
    )
    app = create_served_app(
        settings,
        static_dir=static_dir,
        jwt_verifier=verifier(settings),
        account_repository=FakeAccountRepository(),
    )
    session = token("acct-1", email="a@example.com")

    response = TestClient(app).get(
        "/api/hosted/account/me", headers={"Authorization": f"Bearer {session}"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "acct-1"
