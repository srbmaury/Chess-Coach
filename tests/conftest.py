"""Shared fixtures.

Live PostgreSQL tests run only when ``CHESS_COACH_TEST_DATABASE_URL`` points at a
disposable Supabase-compatible database (for example the ``supabase/postgres`` image).
They drop and recreate every hosted table, so never point it at real data.
``CHESS_COACH_TEST_DATABASE_ADMIN_URL`` (a superuser) additionally installs a stub of
Supabase's ``realtime.messages``/``realtime.topic()``/``realtime.send()`` so private
Broadcast authorization can be exercised without the Realtime service.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

HOSTED_TABLES = (
    "analysis_upload_grants",
    "analysis_checkpoints",
    "audit_events",
    "stripe_events",
    "puzzle_reviews",
    "derived_artifacts",
    "move_analyses",
    "job_subscribers",
    "analysis_jobs",
    "analysis_configs",
    "player_games",
    "games",
    "account_profiles",
    "players",
    "subscriptions",
    "accounts",
    "schema_migrations",
)

_REALTIME_STUB = """
CREATE TABLE IF NOT EXISTS realtime.messages (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    inserted_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime.messages OWNER TO postgres;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('realtime.topic', true), '')::text $$;
CREATE OR REPLACE FUNCTION realtime.send(
    payload jsonb, event text, topic text, private boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES (payload, event, topic, private, 'broadcast');
END;
$$;
GRANT USAGE ON SCHEMA realtime TO postgres, authenticated;
GRANT SELECT, INSERT ON realtime.messages TO postgres, authenticated;
GRANT EXECUTE ON FUNCTION realtime.topic() TO postgres, authenticated;
GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO postgres;
"""


def _reset_schema(url: str, admin_url: str | None) -> None:
    import psycopg

    with psycopg.connect(url, autocommit=True) as connection:
        for table in HOSTED_TABLES:
            connection.execute(f"DROP TABLE IF EXISTS public.{table} CASCADE")
        connection.execute("DROP SCHEMA IF EXISTS chess_private CASCADE")
        connection.execute("DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as connection:
            connection.execute("DROP TABLE IF EXISTS realtime.messages CASCADE")
            connection.execute(_REALTIME_STUB)


@pytest.fixture(scope="session")
def live_database_url() -> str:
    url = os.getenv("CHESS_COACH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("CHESS_COACH_TEST_DATABASE_URL is not set")
    return url


@pytest.fixture(scope="session")
def migrated_database(live_database_url):
    from chess_ml_coach.hosted.database import Database
    from chess_ml_coach.hosted.migrations import apply_migrations

    _reset_schema(live_database_url, os.getenv("CHESS_COACH_TEST_DATABASE_ADMIN_URL"))
    database = Database(live_database_url)
    database.open()
    apply_migrations(database)
    yield database
    database.close()


@pytest.fixture
def pg(migrated_database):
    """A migrated database with every hosted table emptied before the test."""
    with migrated_database.transaction() as connection:
        tables = ", ".join(f"public.{name}" for name in HOSTED_TABLES if name != "schema_migrations")
        connection.execute(f"TRUNCATE {tables} CASCADE")
        if connection.execute("SELECT to_regclass('realtime.messages')").fetchone()[0]:
            connection.execute("DELETE FROM realtime.messages")
    return migrated_database


@contextmanager
def as_browser(database, account_id: str | None, *, topic: str | None = None) -> Iterator:
    """Run statements as Supabase's ``authenticated`` (or ``anon``) browser role."""
    with database.transaction() as connection:
        if account_id is None:
            connection.execute("SET LOCAL ROLE anon")
        else:
            claims = json.dumps({"sub": account_id, "role": "authenticated"})
            connection.execute("SELECT set_config('request.jwt.claims', %s, true)", (claims,))
            connection.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (account_id,))
            connection.execute("SET LOCAL ROLE authenticated")
        if topic is not None:
            connection.execute("SELECT set_config('realtime.topic', %s, true)", (topic,))
        yield connection
