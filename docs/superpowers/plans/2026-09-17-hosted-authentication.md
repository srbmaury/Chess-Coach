# Hosted Authentication and Account-Scoped Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify Supabase-issued session tokens on the backend, resolve them to an authoritative internal `accounts` row, and expose one protected endpoint that proves the seam end-to-end — without yet claiming profiles, enforcing entitlements, or changing any existing local-mode behavior.

**Architecture:** A `SupabaseJwtVerifier` decodes and validates the bearer token from each request. A `PostgresAccountRepository` upserts the verified subject into `accounts` (already defined by the Phase 1 schema). A `require_account` FastAPI dependency composes the two and is the *only* way any hosted route learns who is calling — the React client never supplies an authoritative account id. The hosted database pool, only ever test-injected in Phase 1, is now actually opened for the lifetime of the FastAPI process in hosted mode so this dependency has a real connection at runtime.

**Tech Stack:** Python 3.11+, FastAPI, PyJWT, PostgreSQL/Supabase, pytest, Ruff

**Spec:** `docs/superpowers/specs/2026-09-16-multi-user-shared-analysis-design.md`
**Depends on:** `docs/superpowers/plans/2026-09-16-hosted-persistence-foundation.md` (merged: `accounts` table, `Database` pool wrapper, `persistence_mode`/`is_hosted` settings)

## Global Constraints

- Default behavior remains local and unauthenticated. Existing single-profile `/api/...` endpoints are untouched by this phase; every new authenticated endpoint lives under a distinct `/api/hosted/` prefix so the "this route requires a verified JWT" boundary is unambiguous and auditable.
- `require_account` resolves identity **only** from the verified JWT's `sub` claim. No request body, query parameter, or header may substitute for it. This is the core security property this phase exists to establish (spec: "Authorization is resolved from the verified subject, never a client account ID").
- Token verification uses Supabase's legacy shared HS256 JWT secret (`SUPABASE_JWT_SECRET`), fully offline-testable with no network calls. **Open decision, confirm before implementing:** a Supabase project created with the newer asymmetric signing-key mode (Dashboard → Authentication → JWT Keys → "Standard" ES256/RS256 keys rather than "Legacy JWT Secret") does not expose a usable HS256 secret at all, and this verifier will not work against it. Check the target project's JWT Keys setting first; if it is asymmetric-only, Task 2 must fetch and cache the project's JWKS instead of reading a shared secret, which is a materially different (and not yet written) task.
- This phase does not implement profile claiming, entitlements, or the shared player/game catalog (Phase 3), Stripe/billing (Phase 6), or Row-Level Security policies (deferred to the production-hardening phase as defense in depth — this phase's authorization boundary is enforced entirely in the FastAPI layer).
- Secrets (`SUPABASE_JWT_SECRET`, `DATABASE_URL`) must never be committed, logged, or returned in API responses.
- All production changes follow red-green-refactor TDD.
- The current Render service remains in local mode until Supabase project secrets are explicitly configured; this phase does not flip that.

## File Structure

- `src/chess_ml_coach/config.py`: Supabase JWT secret/audience settings.
- `src/chess_ml_coach/hosted/identity.py`: JWT verification.
- `src/chess_ml_coach/hosted/accounts.py`: `Account` model and repository.
- `src/chess_ml_coach/web/app.py`: hosted database pool lifecycle; `jwt_verifier`/`account_repository` app state.
- `src/chess_ml_coach/web/auth.py`: `require_account` FastAPI dependency.
- `src/chess_ml_coach/web/hosted_routes.py`: `GET /api/hosted/account/me`.
- `src/chess_ml_coach/web/serve.py`: forward auth dependencies to `create_app`.
- `src/chess_ml_coach/cli.py`: construct real `Database`/verifier/repository for `chess-coach ui` in hosted mode.
- `pyproject.toml`: add `pyjwt`.
- `tests/test_hosted_auth_config.py`, `tests/test_hosted_identity.py`, `tests/test_hosted_accounts.py`, `tests/test_hosted_app_lifecycle.py`, `tests/test_hosted_auth_dependency.py`.
- `README.md`: hosted auth setup and the `/api/hosted/account/me` smoke test.

## Follow-On Plans

This is plan 2 of the approved delivery sequence. Later plans, written after this one is merged, will cover:

1. Profile entitlements and the shared player/game catalog.
2. Deduplicated jobs, subscribers, leases, resumable Stockfish work, and persisted move analysis.
3. Supabase Storage and derived artifact orchestration.
4. Stripe Checkout/webhooks and the ₹4,999 monthly five-additional-profile entitlement.
5. Hosted React onboarding, progress, cancellation, plan, and ready-state UX.
6. Rate limiting, admin operations, observability, local-data import, and production verification.

---

### Task 1: Add Supabase auth configuration

**Files:**
- Modify: `src/chess_ml_coach/config.py`
- Create: `tests/test_hosted_auth_config.py`

**Interfaces:**
- Produces: `Settings.supabase_jwt_secret: str | None`
- Produces: `Settings.supabase_jwt_audience: str` (default `"authenticated"`, Supabase's standard default)
- Produces: `get_settings(..., supabase_jwt_secret: str | None = None, supabase_jwt_audience: str | None = None)`
- Consumes later: nothing new; independent of `persistence_mode`/`is_hosted` so Phase 1's already-shipped hosted-without-auth behavior is not disturbed.

- [x] **Step 1: Write failing configuration tests**

```python
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
```

- [x] **Step 2: Run the tests and verify the expected failure**

Run: `.venv/bin/pytest tests/test_hosted_auth_config.py -q`

Expected: FAIL because `Settings` has no auth fields.

- [x] **Step 3: Implement the settings fields**

Extend `Settings` (no `__post_init__` validation — an unconfigured secret is a valid, common state; it is validated lazily where it is actually needed, in Task 2):

```python
    supabase_jwt_secret: str | None = None
    supabase_jwt_audience: str = "authenticated"
```

Populate them in `get_settings()` alongside the existing hosted fields:

```python
        supabase_jwt_secret=(
            supabase_jwt_secret
            if supabase_jwt_secret is not None
            else os.getenv("SUPABASE_JWT_SECRET") or None
        ),
        supabase_jwt_audience=(
            supabase_jwt_audience
            if supabase_jwt_audience is not None
            else os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated")
        ),
```

Add the two keyword-only parameters to `get_settings()` with the exact types shown in the Interfaces block.

- [x] **Step 4: Run focused and regression tests**

Run: `.venv/bin/pytest tests/test_hosted_auth_config.py tests/test_hosted_config.py tests/test_cli.py -q`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/config.py tests/test_hosted_auth_config.py
git commit -m "feat: add supabase auth configuration"
```

---

### Task 2: Implement the Supabase JWT verifier

**Files:**
- Modify: `pyproject.toml`
- Create: `src/chess_ml_coach/hosted/identity.py`
- Create: `tests/test_hosted_identity.py`

**Interfaces:**
- Consumes: `Settings.supabase_jwt_secret`/`supabase_jwt_audience` from Task 1.
- Produces: `VerifiedIdentity(subject: str, email: str | None)`.
- Produces: `AuthConfigurationError`, `InvalidTokenError`.
- Produces: `SupabaseJwtVerifier.from_settings(settings) -> SupabaseJwtVerifier`.
- Produces: `SupabaseJwtVerifier.verify(token: str) -> VerifiedIdentity`.

- [x] **Step 1: Add the dependency and write failing verification tests**

Add to `pyproject.toml`:

```toml
  "pyjwt>=2.9,<3",
```

Build test tokens with PyJWT directly against a known secret, so nothing here ever talks to a real Supabase project:

```python
import time

import jwt
import pytest

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.identity import (
    AuthConfigurationError,
    InvalidTokenError,
    SupabaseJwtVerifier,
)

SECRET = "test-secret"
SUBJECT = "11111111-1111-1111-1111-111111111111"


def _token(**overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": SUBJECT,
        "email": "player@example.com",
        "aud": "authenticated",
        "exp": now + 3600,
        "iat": now,
        **overrides,
    }
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_verifier_requires_a_configured_secret():
    with pytest.raises(AuthConfigurationError):
        SupabaseJwtVerifier.from_settings(Settings())


def test_valid_token_resolves_subject_and_email():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))

    identity = verifier.verify(_token())

    assert identity.subject == SUBJECT
    assert identity.email == "player@example.com"


def test_expired_token_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify(_token(exp=int(time.time()) - 10))


def test_token_signed_with_a_different_secret_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    forged = jwt.encode(
        {"sub": SUBJECT, "aud": "authenticated", "exp": int(time.time()) + 3600},
        "a-different-secret",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        verifier.verify(forged)


def test_token_missing_a_subject_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    claims = {"aud": "authenticated", "exp": int(time.time()) + 3600}
    token = jwt.encode(claims, SECRET, algorithm="HS256")
    with pytest.raises(InvalidTokenError):
        verifier.verify(token)


def test_token_with_the_wrong_audience_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify(_token(aud="some-other-app"))


def test_malformed_token_is_rejected():
    verifier = SupabaseJwtVerifier.from_settings(Settings(supabase_jwt_secret=SECRET))
    with pytest.raises(InvalidTokenError):
        verifier.verify("not-a-jwt")
```

- [x] **Step 2: Verify tests fail for the missing module**

Run: `.venv/bin/pytest tests/test_hosted_identity.py -q`

Expected: FAIL with `ModuleNotFoundError: chess_ml_coach.hosted.identity`.

- [x] **Step 3: Install the editable project dependencies**

Run: `.venv/bin/pip install -e '.[dev]'`

Expected: `pyjwt` installs successfully.

- [x] **Step 4: Implement the verifier**

```python
from __future__ import annotations

from dataclasses import dataclass

import jwt

from ..config import Settings


class AuthConfigurationError(RuntimeError):
    pass


class InvalidTokenError(RuntimeError):
    pass


@dataclass(frozen=True)
class VerifiedIdentity:
    subject: str
    email: str | None


class SupabaseJwtVerifier:
    def __init__(self, *, secret: str, audience: str):
        self._secret = secret
        self._audience = audience

    @classmethod
    def from_settings(cls, settings: Settings) -> SupabaseJwtVerifier:
        if not settings.supabase_jwt_secret:
            raise AuthConfigurationError("SUPABASE_JWT_SECRET is required for authentication")
        return cls(secret=settings.supabase_jwt_secret, audience=settings.supabase_jwt_audience)

    def verify(self, token: str) -> VerifiedIdentity:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                audience=self._audience,
            )
        except jwt.PyJWTError as exc:
            raise InvalidTokenError("Invalid or expired session token") from exc
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise InvalidTokenError("Token is missing a subject claim")
        email = claims.get("email")
        return VerifiedIdentity(subject=subject, email=email if isinstance(email, str) else None)
```

Keep this module free of FastAPI imports; it is a plain verification seam reusable by the CLI, the web layer, and tests alike.

- [x] **Step 5: Run focused tests and lint**

Run: `.venv/bin/pytest tests/test_hosted_identity.py -q`

Run: `.venv/bin/ruff check src/chess_ml_coach/hosted tests/test_hosted_identity.py`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add pyproject.toml src/chess_ml_coach/hosted/identity.py tests/test_hosted_identity.py
git commit -m "feat: add supabase jwt verifier"
```

---

### Task 3: Add the account repository

**Files:**
- Create: `src/chess_ml_coach/hosted/accounts.py`
- Create: `tests/test_hosted_accounts.py`

**Interfaces:**
- Consumes: `Database.transaction()` from the persistence foundation.
- Produces: `Account(id: str, email: str, stripe_customer_id: str | None, created_at, updated_at)`.
- Produces: `AccountRepository` Protocol with `upsert(self, *, account_id: str, email: str) -> Account`.
- Produces: `PostgresAccountRepository(database: Database)` implementing it.

- [x] **Step 1: Write a failing upsert test against a fake connection**

Follow the fake-connection pattern already established for `hosted/migrations.py` tests — no real database in unit tests:

```python
from contextlib import contextmanager
from datetime import UTC, datetime

from chess_ml_coach.hosted.accounts import Account, PostgresAccountRepository


class FakeCursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self):
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, sql: str, params=None):
        self.executed.append((sql, params))
        now = datetime.now(UTC)
        account_id, email = params
        return FakeCursor((account_id, email, None, now, now))


class FakeDatabase:
    def __init__(self):
        self.connection = FakeConnection()

    @contextmanager
    def transaction(self):
        yield self.connection


def test_upsert_account_inserts_and_returns_the_account():
    database = FakeDatabase()
    repository = PostgresAccountRepository(database)

    account = repository.upsert(
        account_id="11111111-1111-1111-1111-111111111111",
        email="player@example.com",
    )

    assert isinstance(account, Account)
    assert account.id == "11111111-1111-1111-1111-111111111111"
    assert account.email == "player@example.com"
    sql, params = database.connection.executed[0]
    assert "INSERT INTO accounts" in sql
    assert "ON CONFLICT (id)" in sql
    assert params == ("11111111-1111-1111-1111-111111111111", "player@example.com")


def test_upsert_account_is_idempotent_for_the_same_subject():
    database = FakeDatabase()
    repository = PostgresAccountRepository(database)

    repository.upsert(account_id="acct-1", email="old@example.com")
    second = repository.upsert(account_id="acct-1", email="new@example.com")

    assert len(database.connection.executed) == 2
    assert second.email == "new@example.com"
```

- [x] **Step 2: Verify tests fail for the missing module**

Run: `.venv/bin/pytest tests/test_hosted_accounts.py -q`

Expected: FAIL with `ModuleNotFoundError: chess_ml_coach.hosted.accounts`.

- [x] **Step 3: Implement the repository**

```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from .database import Database


@dataclass(frozen=True)
class Account:
    id: str
    email: str
    stripe_customer_id: str | None
    created_at: datetime
    updated_at: datetime


class AccountRepository(Protocol):
    def upsert(self, *, account_id: str, email: str) -> Account: ...


_UPSERT_SQL = """
INSERT INTO accounts (id, email)
VALUES (%s, %s)
ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = now()
RETURNING id, email, stripe_customer_id, created_at, updated_at
"""


class PostgresAccountRepository:
    def __init__(self, database: Database):
        self._database = database

    def upsert(self, *, account_id: str, email: str) -> Account:
        with self._database.transaction() as connection:
            row = connection.execute(_UPSERT_SQL, (account_id, email)).fetchone()
        return Account(
            id=str(row[0]),
            email=str(row[1]),
            stripe_customer_id=row[2],
            created_at=row[3],
            updated_at=row[4],
        )
```

`account_id` is always the verified JWT subject (a Supabase Auth UUID), never a client-chosen value — `accounts.id` has no default generator in the Phase 1 schema for exactly this reason.

- [x] **Step 4: Run focused tests and lint**

Run: `.venv/bin/pytest tests/test_hosted_accounts.py -q`

Run: `.venv/bin/ruff check src/chess_ml_coach/hosted tests/test_hosted_accounts.py`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/hosted/accounts.py tests/test_hosted_accounts.py
git commit -m "feat: add hosted account repository"
```

---

### Task 4: Open the hosted database pool for the lifetime of the app

**Files:**
- Modify: `src/chess_ml_coach/web/app.py`
- Create: `tests/test_hosted_app_lifecycle.py`

**Interfaces:**
- Consumes: `Database.open()`/`close()` from the persistence foundation.
- Changes: `create_app`'s `lifespan` now opens `database` (if supplied) on startup and closes it on shutdown.

Today `chess-coach ui` never passes a real `Database` into `create_served_app` — hosted health readiness and, from Task 5 onward, the account repository have nothing to talk to in an actual deployment. This task closes that gap before wiring auth into a live route.

- [x] **Step 1: Write a failing lifecycle test**

```python
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
```

- [x] **Step 2: Verify the lifecycle test fails**

Run: `.venv/bin/pytest tests/test_hosted_app_lifecycle.py -q`

Expected: FAIL — `database.opened` is still `False` because nothing calls it today.

- [x] **Step 3: Bind the pool to the FastAPI lifespan**

In `create_app`, extend the existing `lifespan`:

```python
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if database is not None:
            database.open()
        try:
            yield
        finally:
            adaptive.close_all()
            if database is not None:
                database.close()
```

`database` is already a `create_app` parameter from the persistence foundation; only the lifespan body changes.

- [x] **Step 4: Run focused and regression tests**

Run: `.venv/bin/pytest tests/test_hosted_app_lifecycle.py tests/test_hosted_health.py tests/test_web_api.py tests/test_web_static.py -q`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/web/app.py tests/test_hosted_app_lifecycle.py
git commit -m "feat: open hosted database pool for the app lifetime"
```

---

### Task 5: Add the `require_account` dependency and a protected whoami endpoint

**Files:**
- Create: `src/chess_ml_coach/web/auth.py`
- Create: `src/chess_ml_coach/web/hosted_routes.py`
- Modify: `src/chess_ml_coach/web/app.py`
- Create: `tests/test_hosted_auth_dependency.py`

**Interfaces:**
- Consumes: `SupabaseJwtVerifier` from Task 2, `AccountRepository` from Task 3.
- Produces: `create_app(..., jwt_verifier: SupabaseJwtVerifier | None = None, account_repository: AccountRepository | None = None)`.
- Produces: `require_account(request: Request) -> Account` FastAPI dependency.
- Produces: `GET /api/hosted/account/me` — `200 {"id": ..., "email": ...}` for a valid token, `401` for a missing/invalid/expired token, `503` when hosted auth is not configured on this deployment.

- [x] **Step 1: Write failing dependency and endpoint tests**

```python
import time

import jwt
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.accounts import Account
from chess_ml_coach.hosted.identity import SupabaseJwtVerifier
from chess_ml_coach.web.app import create_app

SECRET = "test-secret"


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
```

- [x] **Step 2: Verify the tests fail**

Run: `.venv/bin/pytest tests/test_hosted_auth_dependency.py -q`

Expected: FAIL — no `/api/hosted/account/me` route exists yet.

- [x] **Step 3: Implement the dependency and the route**

`web/auth.py`:

```python
from __future__ import annotations

from fastapi import HTTPException, Request

from ..hosted.accounts import Account
from ..hosted.identity import InvalidTokenError


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization")
    if not header or not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="A bearer session token is required")
    return header.split(" ", 1)[1].strip()


def require_account(request: Request) -> Account:
    verifier = request.app.state.jwt_verifier
    repository = request.app.state.account_repository
    if verifier is None or repository is None:
        raise HTTPException(status_code=503, detail="Hosted authentication is not configured")
    token = _bearer_token(request)
    try:
        identity = verifier.verify(token)
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session token") from exc
    return repository.upsert(account_id=identity.subject, email=identity.email or "")
```

`web/hosted_routes.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..hosted.accounts import Account
from .auth import require_account

router = APIRouter()


@router.get("/api/hosted/account/me")
def whoami(account: Account = Depends(require_account)) -> dict[str, object]:
    return {"id": account.id, "email": account.email}
```

In `web/app.py`, extend `create_app`'s signature with `jwt_verifier: SupabaseJwtVerifier | None = None, account_repository: AccountRepository | None = None`, store both on `app.state` next to `app.state.database`, and `app.include_router(hosted_router)` alongside the existing routers. Import `hosted_router` the same way `adaptive_router`/`explanation_router` are imported.

- [x] **Step 4: Run focused and full regression tests**

Run: `.venv/bin/pytest tests/test_hosted_auth_dependency.py tests/test_web_api.py tests/test_hosted_health.py -q`

Run: `.venv/bin/ruff check src/chess_ml_coach/web tests/test_hosted_auth_dependency.py`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/web/auth.py src/chess_ml_coach/web/hosted_routes.py src/chess_ml_coach/web/app.py tests/test_hosted_auth_dependency.py
git commit -m "feat: add require_account dependency and whoami endpoint"
```

---

### Task 6: Wire real auth into the served app, document, and verify the phase

**Files:**
- Modify: `src/chess_ml_coach/web/serve.py`
- Modify: `src/chess_ml_coach/cli.py`
- Create: `tests/test_hosted_serve_auth.py`
- Modify: `README.md`
- Test: full Python and frontend suites

**Interfaces:**
- Extends: `create_served_app(..., jwt_verifier=None, account_repository=None)`, forwarded to `create_app`.
- Documents: `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_AUDIENCE`, and a `/api/hosted/account/me` smoke test.

- [x] **Step 1: Write a failing test that the served app forwards auth dependencies**

```python
import time

import jwt
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.accounts import Account
from chess_ml_coach.hosted.identity import SupabaseJwtVerifier
from chess_ml_coach.web.serve import create_served_app

SECRET = "test-secret"


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
```

- [x] **Step 2: Verify the test fails**

Run: `.venv/bin/pytest tests/test_hosted_serve_auth.py -q`

Expected: FAIL — `create_served_app` does not accept `jwt_verifier`/`account_repository` yet.

- [x] **Step 3: Forward the dependencies and wire the CLI**

In `web/serve.py`, add `jwt_verifier: SupabaseJwtVerifier | None = None, account_repository: AccountRepository | None = None` to `create_served_app` and pass them through to `create_app(resolved, database=database, jwt_verifier=jwt_verifier, account_repository=account_repository)`.

In `cli.py`'s `ui` command, construct real instances in hosted mode instead of always passing `database=None`:

```python
    from .hosted.accounts import PostgresAccountRepository
    from .hosted.database import Database
    from .hosted.identity import AuthConfigurationError, SupabaseJwtVerifier

    database = Database.from_settings(root) if root.is_hosted else None
    jwt_verifier = None
    account_repository = None
    if database is not None:
        try:
            jwt_verifier = SupabaseJwtVerifier.from_settings(root)
        except AuthConfigurationError:
            jwt_verifier = None  # hosted DB may be live before SUPABASE_JWT_SECRET is set
        account_repository = PostgresAccountRepository(database)

    web_app = _execute(
        lambda: create_served_app(
            root,
            initial_username=username,
            database=database,
            jwt_verifier=jwt_verifier,
            account_repository=account_repository,
        )
    )
```

An unset `SUPABASE_JWT_SECRET` must not crash `chess-coach ui` in hosted mode — it should simply leave `/api/hosted/account/me` returning `503` until the secret is configured, exactly as Task 5's dependency already handles.

- [x] **Step 4: Add hosted authentication documentation**

Append to the "Hosted persistence foundation" README section added in Phase 1:

~~~~markdown
### Hosted authentication

Authenticated hosted endpoints live under `/api/hosted/` and require a Supabase
session token. Configure the project's JWT secret alongside `DATABASE_URL`:

```bash
export SUPABASE_JWT_SECRET='your-project-jwt-secret'
```

This assumes the Supabase project uses the legacy shared HS256 JWT secret
(Dashboard -> Authentication -> JWT Keys). A project on the newer
asymmetric-only signing keys is not yet supported and needs a JWKS-based
verifier instead.

Smoke-test with a real session token:

```bash
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  http://127.0.0.1:8000/api/hosted/account/me
```

An unset or invalid token returns `401`; a deployment without
`SUPABASE_JWT_SECRET` configured returns `503`. No hosted product route
depends on this endpoint yet — profile claiming and entitlements are
introduced in the next phase.
~~~~

- [x] **Step 5: Run the complete verification suite**

Run: `.venv/bin/ruff check src tests`

Run: `.venv/bin/pytest -q`

Run: `cd web && npm test -- --run`

Run: `cd web && npm run build`

Expected: all commands succeed with no new failures or warnings.

- [x] **Step 6: Confirm local startup remains independent of Supabase**

Run:

```bash
env -u DATABASE_URL -u CHESS_COACH_PERSISTENCE_MODE -u SUPABASE_JWT_SECRET \
  .venv/bin/python -c "from chess_ml_coach.config import get_settings; s=get_settings(); assert not s.is_hosted; assert s.supabase_jwt_secret is None; print('local-ok')"
```

Expected: `local-ok`.

- [x] **Step 7: Review the final diff for secrets and unintended generated files**

Run:

```bash
git diff --check
git status --short
rg -n "postgresql://[^.].+@|service_role|stripe_secret|SUPABASE_JWT_SECRET=[^'\"$]" src tests README.md
```

Expected: no real secret is present — only placeholder connection strings/JWT secrets in tests and the README template.

- [x] **Step 8: Commit**

```bash
git add src/chess_ml_coach/web/serve.py src/chess_ml_coach/cli.py tests/test_hosted_serve_auth.py README.md
git commit -m "feat: wire hosted authentication into the served app"
```

---

## Phase Acceptance Criteria

- A request to any `/api/hosted/` route without a bearer token is rejected with `401`.
- A forged, expired, wrong-audience, or otherwise invalid token is rejected with `401` and never reaches account resolution.
- A deployment with `DATABASE_URL` set but no `SUPABASE_JWT_SECRET` returns `503` on hosted routes rather than crashing at startup.
- Two different verified subjects resolve to two different, independently upserted `accounts` rows; nothing about one account's request can be inferred from or attributed to another.
- Account identity is derived solely from the verified JWT subject — no code path accepts a client-supplied account id as authoritative.
- The hosted database pool opens once at process startup and closes once at shutdown in hosted mode; local mode never touches it.
- Existing local-mode endpoints and CLI commands are unchanged.
- Python lint/tests, frontend tests, and frontend production build all pass.
- No real secret appears anywhere in the diff.
