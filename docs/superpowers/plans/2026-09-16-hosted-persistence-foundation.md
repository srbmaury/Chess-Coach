# Hosted Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Supabase/PostgreSQL persistence foundation and complete hosted schema while preserving the current filesystem-backed local application unchanged by default.

**Architecture:** Introduce explicit `local` and `hosted` persistence modes in configuration. Hosted mode owns a small PostgreSQL connection-pool wrapper and ordered SQL migration runner; local mode does not import or connect to PostgreSQL at runtime. The initial migration creates the complete shared-data schema approved in the design, allowing later authentication, entitlement, queue, storage, and billing plans to build against stable tables.

**Tech Stack:** Python 3.11+, FastAPI, Typer, psycopg 3, psycopg-pool, PostgreSQL/Supabase, pytest, Ruff

**Spec:** `docs/superpowers/specs/2026-09-16-multi-user-shared-analysis-design.md`

## Global Constraints

- Default behavior remains local and requires neither Supabase nor PostgreSQL configuration.
- Hosted mode requires `DATABASE_URL`; secrets must never be committed or returned by API responses.
- Existing CLI commands and filesystem profile behavior remain backward-compatible.
- SQL migrations are ordered, transactional, repeatable, and recorded in `schema_migrations`.
- The initial migration creates the complete approved schema, but this phase does not activate authentication, billing, storage uploads, or the worker.
- All production changes follow red-green-refactor TDD.
- The current Render service remains in local mode until a Supabase project and secret environment variables are explicitly configured.

## File Structure

- `src/chess_ml_coach/config.py`: persistence-mode and database settings.
- `src/chess_ml_coach/hosted/__init__.py`: hosted package boundary.
- `src/chess_ml_coach/hosted/database.py`: PostgreSQL pool lifecycle and transaction API.
- `src/chess_ml_coach/hosted/migrations.py`: ordered migration discovery and transactional runner.
- `src/chess_ml_coach/hosted/sql/0001_hosted_schema.sql`: authoritative hosted schema.
- `src/chess_ml_coach/cli.py`: explicit `db-migrate` operational command.
- `src/chess_ml_coach/web/app.py`: optional database readiness in health output; no implicit migration.
- `src/chess_ml_coach/web/schemas.py`: health response persistence fields.
- `tests/test_hosted_config.py`: mode configuration tests.
- `tests/test_hosted_database.py`: pool lifecycle tests with a fake pool.
- `tests/test_hosted_migrations.py`: migration ordering, idempotency, and schema-contract tests.
- `tests/test_hosted_health.py`: local/hosted health behavior.
- `tests/test_cli_migrations.py`: migration command behavior.
- `README.md`: hosted-mode setup and operational boundaries.

## Follow-On Plans

This is plan 1 of the approved delivery sequence. Later plans, written after this foundation is merged, will cover:

1. Supabase JWT authentication and account-scoped authorization.
2. Profile entitlements and the shared player/game catalog.
3. Deduplicated jobs, subscribers, leases, resumable Stockfish work, and persisted move analysis.
4. Supabase Storage and derived artifact orchestration.
5. Stripe Checkout/webhooks and the ₹4,999 monthly five-additional-profile entitlement.
6. Hosted React onboarding, progress, cancellation, plan, and ready-state UX.
7. Rate limiting, admin operations, observability, local-data import, and production verification.

---

### Task 1: Add explicit persistence-mode configuration

**Files:**
- Modify: `src/chess_ml_coach/config.py`
- Create: `tests/test_hosted_config.py`

**Interfaces:**
- Produces: `PersistenceMode = Literal["local", "hosted"]`
- Produces: `Settings.persistence_mode: PersistenceMode`
- Produces: `Settings.database_url: str | None`
- Produces: `Settings.is_hosted: bool`
- Produces: `get_settings(..., persistence_mode: PersistenceMode | None = None, database_url: str | None = None)`.
- Consumes later: `Database.from_settings(settings: Settings)` from Task 2.

- [x] **Step 1: Write failing configuration tests**

```python
import pytest

from chess_ml_coach.config import Settings, get_settings


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
```

- [x] **Step 2: Run the tests and verify the expected failure**

Run: `.venv/bin/pytest tests/test_hosted_config.py -q`

Expected: FAIL because `Settings` has no persistence fields and hosted validation does not exist.

- [x] **Step 3: Implement minimal validated settings**

Add to `config.py`:

```python
from typing import Literal, cast

PersistenceMode = Literal["local", "hosted"]


def _persistence_mode(value: str) -> PersistenceMode:
    normalized = value.strip().lower()
    if normalized not in {"local", "hosted"}:
        raise ValueError("Persistence mode must be 'local' or 'hosted'")
    return cast(PersistenceMode, normalized)
```

Extend `Settings`:

```python
    persistence_mode: PersistenceMode = "local"
    database_url: str | None = None

    def __post_init__(self) -> None:
        if self.persistence_mode == "hosted" and not self.database_url:
            raise ValueError("DATABASE_URL is required in hosted persistence mode")

    @property
    def is_hosted(self) -> bool:
        return self.persistence_mode == "hosted"
```

Do not merge this validation with `MoveQualityThresholds.__post_init__`; it belongs on `Settings`. Populate the fields in `get_settings()`:

```python
        persistence_mode=(
            persistence_mode
            if persistence_mode is not None
            else _persistence_mode(os.getenv("CHESS_COACH_PERSISTENCE_MODE", "local"))
        ),
        database_url=(
            database_url if database_url is not None else os.getenv("DATABASE_URL") or None
        ),
```

Add the two keyword-only parameters to `get_settings()` with the exact types shown in the Interfaces block.

- [x] **Step 4: Run focused and regression tests**

Run: `.venv/bin/pytest tests/test_hosted_config.py tests/test_cli.py tests/test_profiles.py -q`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/config.py tests/test_hosted_config.py
git commit -m "feat: add hosted persistence configuration"
```

---

### Task 2: Add PostgreSQL pool lifecycle behind a hosted boundary

**Files:**
- Modify: `pyproject.toml`
- Create: `src/chess_ml_coach/hosted/__init__.py`
- Create: `src/chess_ml_coach/hosted/database.py`
- Create: `tests/test_hosted_database.py`

**Interfaces:**
- Consumes: `Settings.database_url` and `Settings.is_hosted` from Task 1.
- Produces: `Database.from_settings(settings: Settings) -> Database`
- Produces: `Database.open() -> None`, `Database.close() -> None`
- Produces: `Database.transaction() -> ContextManager[psycopg.Connection]`
- Produces: `Database.is_ready() -> bool`
- Produces: `DatabaseConfigurationError`.

- [x] **Step 1: Add dependencies and write failing lifecycle tests**

Add these bounded dependencies to `pyproject.toml`:

```toml
  "psycopg[binary]>=3.2,<4",
  "psycopg-pool>=3.2,<4",
```

Create tests using a fake pool so unit tests never connect to a live database:

```python
from contextlib import contextmanager

import pytest

from chess_ml_coach.config import Settings
from chess_ml_coach.hosted.database import Database, DatabaseConfigurationError


class FakeConnection:
    @contextmanager
    def transaction(self):
        yield self

    def execute(self, sql: str):
        assert sql == "SELECT 1"
        return self

    def fetchone(self):
        return (1,)


class FakePool:
    def __init__(self):
        self.opened = False
        self.closed = False

    def open(self, *, wait: bool):
        assert wait is True
        self.opened = True

    def close(self):
        self.closed = True

    @contextmanager
    def connection(self):
        yield FakeConnection()


def test_database_rejects_local_settings():
    with pytest.raises(DatabaseConfigurationError, match="hosted"):
        Database.from_settings(Settings())


def test_database_owns_pool_lifecycle_and_healthcheck():
    pool = FakePool()
    database = Database("postgresql://example.invalid/chess", pool_factory=lambda _: pool)
    database.open()
    assert pool.opened is True
    with database.transaction() as connection:
        assert connection is not None
    assert database.is_ready() is True
    database.close()
    assert pool.closed is True
```

- [x] **Step 2: Verify tests fail for the missing module**

Run: `.venv/bin/pytest tests/test_hosted_database.py -q`

Expected: FAIL with `ModuleNotFoundError: chess_ml_coach.hosted`.

- [x] **Step 3: Install the editable project dependencies**

Run: `.venv/bin/pip install -e '.[dev]'`

Expected: psycopg and psycopg-pool install successfully.

- [x] **Step 4: Implement the database wrapper**

Create `hosted/database.py` with this public shape:

```python
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from psycopg_pool import ConnectionPool

from ..config import Settings


class DatabaseConfigurationError(RuntimeError):
    pass


PoolFactory = Callable[[str], Any]


def _pool(database_url: str) -> ConnectionPool:
    return ConnectionPool(conninfo=database_url, open=False, min_size=1, max_size=4)


class Database:
    def __init__(self, database_url: str, *, pool_factory: PoolFactory = _pool):
        self._pool = pool_factory(database_url)

    @classmethod
    def from_settings(cls, settings: Settings) -> "Database":
        if not settings.is_hosted or not settings.database_url:
            raise DatabaseConfigurationError("Database requires hosted persistence settings")
        return cls(settings.database_url)

    def open(self) -> None:
        self._pool.open(wait=True)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        with self._pool.connection() as connection:
            with connection.transaction():
                yield connection

    def is_ready(self) -> bool:
        try:
            with self._pool.connection() as connection:
                return connection.execute("SELECT 1").fetchone() == (1,)
        except Exception:
            return False
```

Keep `hosted/__init__.py` empty except for a module docstring. Do not export a global pool.

- [x] **Step 5: Run focused tests and lint**

Run: `.venv/bin/pytest tests/test_hosted_database.py tests/test_hosted_config.py -q`

Run: `.venv/bin/ruff check src/chess_ml_coach/hosted tests/test_hosted_database.py`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add pyproject.toml src/chess_ml_coach/hosted tests/test_hosted_database.py
git commit -m "feat: add hosted database lifecycle"
```

---

### Task 3: Create the complete hosted PostgreSQL schema

**Files:**
- Create: `src/chess_ml_coach/hosted/sql/0001_hosted_schema.sql`
- Create: `tests/test_hosted_schema.py`

**Interfaces:**
- Consumes: PostgreSQL 15+ as provided by Supabase.
- Produces: tables and constraints named exactly as in the approved specification.
- Produces: active-job deduplication index `analysis_jobs_one_active_target`.
- Produces: updated-at trigger function `set_updated_at()`.

- [x] **Step 1: Write a failing schema-contract test**

```python
from importlib.resources import files


def test_initial_hosted_schema_contains_required_contracts():
    sql = (
        files("chess_ml_coach.hosted")
        .joinpath("sql/0001_hosted_schema.sql")
        .read_text(encoding="utf-8")
    )
    required_tables = {
        "schema_migrations",
        "accounts",
        "subscriptions",
        "players",
        "account_profiles",
        "games",
        "player_games",
        "analysis_configs",
        "analysis_jobs",
        "job_subscribers",
        "move_analyses",
        "derived_artifacts",
        "puzzle_reviews",
        "stripe_events",
        "audit_events",
    }
    for table in required_tables:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql
    assert "analysis_jobs_one_active_target" in sql
    assert "account_profiles_one_free_slot" in sql
    assert "UNIQUE (job_id, account_id)" in sql
    assert "UNIQUE (game_id, ply, analysis_config_id)" in sql
```

- [x] **Step 2: Verify the contract test fails**

Run: `.venv/bin/pytest tests/test_hosted_schema.py -q`

Expected: FAIL because the SQL resource does not exist.

- [x] **Step 3: Write the initial migration**

Create one transactional migration containing these exact definitions (formatting may differ, names may not):

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    stripe_customer_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_subscription_id text NOT NULL UNIQUE,
    stripe_price_id text NOT NULL,
    status text NOT NULL CHECK (status IN (
        'incomplete', 'incomplete_expired', 'trialing', 'active',
        'past_due', 'canceled', 'unpaid', 'paused'
    )),
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    last_event_created_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chesscom_player_id bigint UNIQUE,
    canonical_username text NOT NULL UNIQUE,
    display_username text NOT NULL,
    profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    slot_type text NOT NULL CHECK (slot_type IN ('free', 'paid')),
    state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'read_only', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_active_player
ON account_profiles (account_id, player_id)
WHERE state <> 'removed';

CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_one_free_slot
ON account_profiles (account_id)
WHERE slot_type = 'free' AND state <> 'removed';

CREATE TABLE IF NOT EXISTS games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chesscom_url text UNIQUE,
    pgn_hash text NOT NULL UNIQUE,
    pgn_storage_key text NOT NULL,
    game_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_games (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_color text NOT NULL CHECK (player_color IN ('white', 'black')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, game_id)
);

CREATE TABLE IF NOT EXISTS analysis_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stockfish_version text NOT NULL,
    depth integer NOT NULL CHECK (depth > 0),
    thresholds jsonb NOT NULL,
    algorithm_version text NOT NULL,
    config_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    analysis_config_id uuid NOT NULL REFERENCES analysis_configs(id) ON DELETE RESTRICT,
    input_game_set_hash text NOT NULL,
    stage text NOT NULL,
    status text NOT NULL CHECK (status IN (
        'queued', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'
    )),
    completed_work integer NOT NULL DEFAULT 0 CHECK (completed_work >= 0),
    total_work integer NOT NULL DEFAULT 0 CHECK (total_work >= 0),
    lease_owner text,
    lease_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error text,
    cancellation_requested boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_one_active_target
ON analysis_jobs (player_id, analysis_config_id, input_game_set_hash)
WHERE status IN ('queued', 'running', 'stopping');

CREATE TABLE IF NOT EXISTS job_subscribers (
    job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive')),
    notify_when_ready boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, account_id)
);

CREATE TABLE IF NOT EXISTS move_analyses (
    game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply integer NOT NULL CHECK (ply > 0),
    analysis_config_id uuid NOT NULL REFERENCES analysis_configs(id) ON DELETE RESTRICT,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (game_id, ply, analysis_config_id)
);

CREATE TABLE IF NOT EXISTS derived_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    artifact_type text NOT NULL,
    dependency_hash text NOT NULL,
    schema_version text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        player_id, account_id, artifact_type, dependency_hash, schema_version
    )
);

CREATE TABLE IF NOT EXISTS puzzle_reviews (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    puzzle_id text NOT NULL,
    review_state jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, puzzle_id)
);

CREATE TABLE IF NOT EXISTS stripe_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    event_created_at timestamptz NOT NULL,
    processing_status text NOT NULL
        CHECK (processing_status IN ('processing', 'processed', 'failed')),
    failure_details text,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('account', 'system', 'admin')),
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'accounts', 'subscriptions', 'players', 'account_profiles', 'games',
        'analysis_jobs', 'job_subscribers', 'move_analyses',
        'derived_artifacts', 'puzzle_reviews'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', table_name);
        EXECUTE format(
            'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            table_name
        );
    END LOOP;
END;
$$;
```

- [x] **Step 4: Run schema-contract and package-resource tests**

Run: `.venv/bin/pytest tests/test_hosted_schema.py -q`

Also run:

```bash
.venv/bin/python -c "from importlib.resources import files; print(files('chess_ml_coach.hosted').joinpath('sql/0001_hosted_schema.sql').is_file())"
```

Expected: test passes and command prints `True`.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/hosted/sql/0001_hosted_schema.sql tests/test_hosted_schema.py
git commit -m "feat: define hosted database schema"
```

---

### Task 4: Add ordered transactional migration execution

**Files:**
- Create: `src/chess_ml_coach/hosted/migrations.py`
- Create: `tests/test_hosted_migrations.py`

**Interfaces:**
- Consumes: `Database.transaction()` from Task 2.
- Produces: `Migration(version: str, sql: str)`.
- Produces: `discover_migrations() -> tuple[Migration, ...]`.
- Produces: `apply_migrations(database: Database) -> tuple[str, ...]` returning versions newly applied.

- [x] **Step 1: Write failing discovery and idempotency tests**

Use a fake database/connection that records SQL and simulates applied versions:

```python
from contextlib import contextmanager

from chess_ml_coach.hosted.migrations import apply_migrations, discover_migrations


class FakeResult:
    def __init__(self, rows=()):
        self._rows = rows

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self):
        self.applied: set[str] = set()
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, sql: str, params=None):
        self.executed.append((sql, params))
        if sql.startswith("SELECT version"):
            return FakeResult((version,) for version in sorted(self.applied))
        if sql.startswith("INSERT INTO schema_migrations"):
            self.applied.add(str(params[0]))
        return FakeResult()


class FakeDatabase:
    def __init__(self):
        self.connection = FakeConnection()

    @contextmanager
    def transaction(self):
        yield self.connection


def test_discover_migrations_returns_sorted_versions():
    migrations = discover_migrations()
    assert tuple(item.version for item in migrations) == ("0001_hosted_schema",)


def test_apply_migrations_is_idempotent():
    database = FakeDatabase()
    assert apply_migrations(database) == ("0001_hosted_schema",)
    first_execution_count = len(database.connection.executed)
    assert apply_migrations(database) == ()
    assert len(database.connection.executed) == first_execution_count + 2
```

The second call adds exactly the `CREATE TABLE schema_migrations` and version query; it does not execute migration SQL or insert a version.

- [x] **Step 2: Verify tests fail for the missing runner**

Run: `.venv/bin/pytest tests/test_hosted_migrations.py -q`

Expected: FAIL with missing module or symbols.

- [x] **Step 3: Implement discovery and migration application**

```python
from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files

from .database import Database


@dataclass(frozen=True)
class Migration:
    version: str
    sql: str


def discover_migrations() -> tuple[Migration, ...]:
    root = files("chess_ml_coach.hosted").joinpath("sql")
    migrations = [
        Migration(path.name.removesuffix(".sql"), path.read_text(encoding="utf-8"))
        for path in root.iterdir()
        if path.name.endswith(".sql")
    ]
    return tuple(sorted(migrations, key=lambda item: item.version))


def apply_migrations(database: Database) -> tuple[str, ...]:
    newly_applied: list[str] = []
    with database.transaction() as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version text PRIMARY KEY, "
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        rows = connection.execute("SELECT version FROM schema_migrations").fetchall()
        applied = {str(row[0]) for row in rows}
        for migration in discover_migrations():
            if migration.version in applied:
                continue
            connection.execute(migration.sql)
            connection.execute(
                "INSERT INTO schema_migrations (version) VALUES (%s)",
                (migration.version,),
            )
            newly_applied.append(migration.version)
    return tuple(newly_applied)
```

- [x] **Step 4: Run focused tests and lint**

Run: `.venv/bin/pytest tests/test_hosted_migrations.py tests/test_hosted_schema.py -q`

Run: `.venv/bin/ruff check src/chess_ml_coach/hosted tests/test_hosted_migrations.py`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/hosted/migrations.py tests/test_hosted_migrations.py
git commit -m "feat: add hosted migration runner"
```

---

### Task 5: Expose an explicit database migration CLI command

**Files:**
- Modify: `src/chess_ml_coach/cli.py`
- Create: `tests/test_cli_migrations.py`

**Interfaces:**
- Consumes: `Database.from_settings`, `open`, `close` from Task 2.
- Consumes: `apply_migrations` from Task 4.
- Produces: `chess-coach db-migrate --database-url <url>`.

- [x] **Step 1: Write failing CLI tests with injected seams**

Follow the existing CLI seam pattern (`_run_sync`, `_run_analyze`) and add module-level `_database_factory` and `_apply_migrations` aliases. Test without a real database:

```python
from typer.testing import CliRunner

from chess_ml_coach import cli


runner = CliRunner()


class FakeDatabase:
    opened = False
    closed = False

    def open(self):
        self.opened = True

    def close(self):
        self.closed = True


def test_db_migrate_requires_database_url():
    result = runner.invoke(cli.app, ["db-migrate"], env={"DATABASE_URL": ""})
    assert result.exit_code != 0
    assert "DATABASE_URL" in result.stdout


def test_db_migrate_applies_and_closes(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(cli, "_database_factory", lambda _settings: database)
    monkeypatch.setattr(cli, "_apply_migrations", lambda _database: ("0001_hosted_schema",))
    result = runner.invoke(
        cli.app,
        ["db-migrate", "--database-url", "postgresql://example.invalid/chess"],
    )
    assert result.exit_code == 0
    assert "0001_hosted_schema" in result.stdout
    assert database.opened is True
    assert database.closed is True
```

- [x] **Step 2: Verify the command tests fail**

Run: `.venv/bin/pytest tests/test_cli_migrations.py -q`

Expected: FAIL because `db-migrate` and its seams do not exist.

- [x] **Step 3: Implement the command**

At module import level, alias:

```python
from .hosted.database import Database
from .hosted.migrations import apply_migrations

_database_factory = Database.from_settings
_apply_migrations = apply_migrations
```

Add the command:

```python
@app.command("db-migrate")
def db_migrate(
    database_url: Annotated[str | None, typer.Option("--database-url")] = None,
) -> None:
    """Apply pending hosted PostgreSQL migrations."""
    resolved_url = database_url or os.getenv("DATABASE_URL")
    if not resolved_url:
        typer.echo("DATABASE_URL is required for db-migrate")
        raise typer.Exit(code=1)
    hosted = _get_root_settings(
        None,
        persistence_mode="hosted",
        database_url=resolved_url,
    )
    database = _database_factory(hosted)
    database.open()
    try:
        applied = _apply_migrations(database)
    finally:
        database.close()
    if applied:
        typer.echo(f"Applied migrations: {', '.join(applied)}")
    else:
        typer.echo("Database schema is already current")
```

Import `os`; `replace` is not needed. Use the existing `_get_root_settings` alias so the command does not create a filesystem player profile. Ensure error handling does not print the database URL.

- [x] **Step 4: Run CLI tests and help smoke tests**

Run: `.venv/bin/pytest tests/test_cli_migrations.py tests/test_cli.py -q`

Run: `.venv/bin/chess-coach --help`

Expected: tests pass and help includes `db-migrate`.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/cli.py tests/test_cli_migrations.py
git commit -m "feat: add hosted database migration command"
```

---

### Task 6: Add optional hosted database readiness to the health endpoint

**Files:**
- Modify: `src/chess_ml_coach/web/schemas.py`
- Modify: `src/chess_ml_coach/web/app.py`
- Modify: `src/chess_ml_coach/web/serve.py`
- Create: `tests/test_hosted_health.py`

**Interfaces:**
- Consumes: `Database` from Task 2.
- Produces: `create_app(..., database: Database | None = None)`.
- Produces: health JSON fields `persistence_mode` and `database_ready`.
- Local response: `persistence_mode="local"`, `database_ready=None`.
- Hosted response: `persistence_mode="hosted"`, `database_ready=true|false`.

- [x] **Step 1: Write failing local and hosted health tests**

```python
from fastapi.testclient import TestClient

from chess_ml_coach.config import Settings
from chess_ml_coach.web.app import create_app


class FakeDatabase:
    def __init__(self, ready: bool):
        self.ready = ready

    def is_ready(self) -> bool:
        return self.ready


def test_local_health_does_not_require_database(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models"))
    payload = TestClient(app).get("/api/health").json()
    assert payload["persistence_mode"] == "local"
    assert payload["database_ready"] is None


def test_hosted_health_reports_database_readiness(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        persistence_mode="hosted",
        database_url="postgresql://example.invalid/chess",
    )
    app = create_app(settings, database=FakeDatabase(ready=True))
    payload = TestClient(app).get("/api/health").json()
    assert payload["persistence_mode"] == "hosted"
    assert payload["database_ready"] is True
```

- [x] **Step 2: Verify health tests fail**

Run: `.venv/bin/pytest tests/test_hosted_health.py -q`

Expected: FAIL because the response and dependency parameter do not exist.

- [x] **Step 3: Implement optional readiness without opening pools in local mode**

Extend `HealthResponse` in `web/schemas.py`:

```python
    persistence_mode: str
    database_ready: bool | None
```

Extend `create_app` with `database: Database | None = None`, store it on `app.state`, and return:

```python
        database_ready = None
        if active.is_hosted:
            database_ready = database is not None and database.is_ready()
        return HealthResponse(
            version=APP_VERSION,
            username=active.username,
            data_dir=str(active.data_dir),
            model_dir=str(active.model_dir),
            persistence_mode=active.persistence_mode,
            database_ready=database_ready,
        )
```

Do not expose `database_url`. Do not automatically run migrations during web startup.

Update `create_served_app` to accept and forward an optional database dependency. Pool construction and hosted repository integration remain for the authentication plan; this task only establishes the app seam and health contract.

- [x] **Step 4: Run web regressions**

Run: `.venv/bin/pytest tests/test_hosted_health.py tests/test_web_api.py tests/test_web_static.py tests/test_web_profiles.py -q`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/chess_ml_coach/web/app.py src/chess_ml_coach/web/schemas.py src/chess_ml_coach/web/serve.py tests/test_hosted_health.py
git commit -m "feat: expose hosted persistence readiness"
```

---

### Task 7: Document and verify the persistence foundation

**Files:**
- Modify: `README.md`
- Test: full Python suite

**Interfaces:**
- Documents: `CHESS_COACH_PERSISTENCE_MODE`, `DATABASE_URL`, and `db-migrate`.
- Documents: local mode is default and hosted mode is not activated by this phase.

- [x] **Step 1: Add the hosted persistence documentation**

Add a section containing these exact operational points:

~~~~markdown
## Hosted persistence foundation

Local filesystem persistence remains the default. It does not require Supabase:

```bash
chess-coach ui
```

Hosted persistence is opt-in and requires a PostgreSQL connection string from Supabase:

```bash
export CHESS_COACH_PERSISTENCE_MODE=hosted
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/postgres'
chess-coach db-migrate
```

`db-migrate` applies ordered migrations and is safe to run repeatedly. Never commit
`DATABASE_URL`; use deployment secrets. Hosted authentication and repositories are
introduced in subsequent phases, so setting hosted mode alone does not yet convert
the existing profile APIs to multi-user behavior.
~~~~

Use the displayed Markdown content exactly, including its inner shell code fences.

- [x] **Step 2: Run the complete verification suite**

Run: `.venv/bin/ruff check src tests`

Run: `.venv/bin/pytest -q`

Run: `cd web && npm test -- --run`

Run: `cd web && npm run build`

Expected: all commands succeed. Existing deprecation warnings may remain; no new failures or warnings attributable to this phase are allowed.

- [x] **Step 3: Confirm local startup remains independent of PostgreSQL**

Run:

```bash
env -u DATABASE_URL -u CHESS_COACH_PERSISTENCE_MODE \
  .venv/bin/python -c "from chess_ml_coach.config import get_settings; s=get_settings(); assert not s.is_hosted; print('local-ok')"
```

Expected: `local-ok`.

- [x] **Step 4: Review the final diff for secrets and unintended generated files**

Run:

```bash
git diff --check
git status --short
rg -n "postgresql://[^.].+@|service_role|stripe_secret" src tests README.md
```

Expected: no real database URL or secret is present. Generated `.DS_Store`, caches, local data, models, and backups remain untracked/ignored and are not staged.

- [x] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: describe hosted persistence setup"
```

---

## Phase Acceptance Criteria

- Local settings and all existing workflows behave as before with no database configured.
- Hosted configuration fails fast when `DATABASE_URL` is missing.
- A bounded PostgreSQL pool can open, close, provide transactions, and report readiness.
- The complete approved schema is packaged with the application.
- Migrations apply transactionally, in order, exactly once.
- `chess-coach db-migrate` applies migrations without leaking connection secrets.
- Health responses disclose persistence mode and readiness but never credentials.
- Python lint/tests, frontend tests, and frontend production build all pass.
- No hosted feature is activated on the live Render service during this foundation phase.
