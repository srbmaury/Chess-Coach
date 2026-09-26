import re
import uuid
from importlib.resources import files

import pytest
from conftest import as_browser


def _sql() -> str:
    return (
        files("chess_ml_coach.hosted")
        .joinpath("sql/0002_browser_analysis.sql")
        .read_text(encoding="utf-8")
    )


def test_migration_declares_browser_lease_and_checkpoint_contracts():
    sql = _sql()
    for column in (
        "lease_token_digest",
        "lease_account_id",
        "lease_device_id",
        "last_heartbeat_at",
        "checkpoint_sequence",
        "checkpoint_hash",
        "compute_source",
        "can_compute",
    ):
        assert column in sql
    assert "'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'" in sql
    assert "WHERE status IN ('queued', 'running', 'paused')" in sql
    assert "CREATE TABLE IF NOT EXISTS analysis_checkpoints" in sql
    assert "UNIQUE (job_id, sequence)" in sql
    assert "UNIQUE (job_id, content_hash)" in sql
    assert "'community_computed'" in sql


def test_migration_leaves_transaction_control_to_runner_and_realtime_schema_alone():
    sql = _sql()
    assert not re.search(
        r"^\s*(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?\s*;",
        sql,
        re.MULTILINE | re.IGNORECASE,
    )
    assert not re.search(
        r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|VIEW|SCHEMA|TYPE)\s+"
        r"(?:IF\s+NOT\s+EXISTS\s+)?realtime\.",
        sql,
        re.IGNORECASE,
    )
    # The single realtime touch point is the supported authorization policy.
    assert re.findall(r"ON realtime\.(\w+)", sql) == ["messages", "messages"]


def test_policy_filter_columns_lead_their_indexes():
    sql = _sql()
    assert "ON job_subscribers (account_id, state, job_id)" in sql
    assert "UNIQUE (job_id, sequence)" in sql


# Live database tests -------------------------------------------------------------

ACCOUNT_A = "11111111-1111-1111-1111-111111111111"
ACCOUNT_B = "22222222-2222-2222-2222-222222222222"


def _seed(pg):
    with pg.transaction() as connection:
        for account in (ACCOUNT_A, ACCOUNT_B):
            connection.execute(
                "INSERT INTO accounts (id, email) VALUES (%s, %s)", (account, f"{account}@x.test")
            )
        player = connection.execute(
            "INSERT INTO players (canonical_username, display_username) "
            "VALUES ('magnuscarlsen', 'MagnusCarlsen') RETURNING id"
        ).fetchone()[0]
        other_player = connection.execute(
            "INSERT INTO players (canonical_username, display_username) "
            "VALUES ('hikaru', 'Hikaru') RETURNING id"
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO account_profiles (account_id, player_id, slot_type) VALUES (%s, %s, 'free')",
            (ACCOUNT_A, player),
        )
        connection.execute(
            "INSERT INTO account_profiles (account_id, player_id, slot_type) VALUES (%s, %s, 'free')",
            (ACCOUNT_B, other_player),
        )
        config = connection.execute(
            "INSERT INTO analysis_configs (stockfish_version, depth, thresholds, "
            "algorithm_version, config_hash) VALUES ('19', 12, '{}', '1', 'cfg') RETURNING id"
        ).fetchone()[0]
        job = connection.execute(
            "INSERT INTO analysis_jobs (player_id, analysis_config_id, input_game_set_hash, "
            "stage, status, total_work) VALUES (%s, %s, 'games', 'analyze', 'queued', 4) "
            "RETURNING id",
            (player, config),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO job_subscribers (job_id, account_id, state) VALUES (%s, %s, 'active')",
            (job, ACCOUNT_A),
        )
        connection.execute(
            "INSERT INTO derived_artifacts (player_id, artifact_type, dependency_hash, "
            "schema_version, storage_bucket, storage_key, status) "
            "VALUES (%s, 'report', 'dep', '1', 'bucket', 'key', 'ready')",
            (player,),
        )
    return {"player": player, "other_player": other_player, "config": config, "job": job}


def test_migrations_apply_and_record_both_versions(pg):
    with pg.transaction() as connection:
        versions = [row[0] for row in connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()]
    assert versions == ["0001_hosted_schema", "0002_browser_analysis"]


def test_one_non_terminal_job_per_shared_key_including_paused(pg):
    import psycopg

    ids = _seed(pg)
    with pg.transaction() as connection:
        connection.execute("UPDATE analysis_jobs SET status = 'paused' WHERE id = %s", (ids["job"],))
    with pytest.raises(psycopg.errors.UniqueViolation), pg.transaction() as connection:
        connection.execute(
            "INSERT INTO analysis_jobs (player_id, analysis_config_id, input_game_set_hash, "
            "stage, status) VALUES (%s, %s, 'games', 'analyze', 'queued')",
            (ids["player"], ids["config"]),
        )
    with pg.transaction() as connection:
        connection.execute("UPDATE analysis_jobs SET status = 'succeeded' WHERE id = %s", (ids["job"],))
        connection.execute(
            "INSERT INTO analysis_jobs (player_id, analysis_config_id, input_game_set_hash, "
            "stage, status) VALUES (%s, %s, 'games', 'analyze', 'queued')",
            (ids["player"], ids["config"]),
        )


def test_lease_columns_must_be_set_together(pg):
    import psycopg

    ids = _seed(pg)
    with pytest.raises(psycopg.errors.CheckViolation), pg.transaction() as connection:
        connection.execute(
            "UPDATE analysis_jobs SET lease_token_digest = 'x' WHERE id = %s", (ids["job"],)
        )


def test_checkpoint_sequence_and_hash_are_unique_per_job(pg):
    import psycopg

    ids = _seed(pg)
    insert = (
        "INSERT INTO analysis_checkpoints (job_id, sequence, storage_bucket, storage_key, "
        "byte_size, content_hash, result_count, first_unit, last_unit, first_game_id, "
        "last_game_id, analysis_config_hash, engine_build_hash, uploader_device_id) "
        "VALUES (%s, %s, 'b', %s, 10, %s, 1, 0, 0, 'g', 'g', 'cfg', 'eng', 'device')"
    )
    with pg.transaction() as connection:
        connection.execute(insert, (ids["job"], 1, "k1", "a" * 64))
    with pytest.raises(psycopg.errors.UniqueViolation), pg.transaction() as connection:
        connection.execute(insert, (ids["job"], 1, "k2", "b" * 64))
    with pytest.raises(psycopg.errors.UniqueViolation), pg.transaction() as connection:
        connection.execute(insert, (ids["job"], 2, "k3", "a" * 64))


def test_anon_reads_nothing(pg):
    import psycopg

    _seed(pg)
    for table in ("accounts", "players", "analysis_jobs", "job_subscribers", "derived_artifacts"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), as_browser(pg, None) as connection:
            connection.execute(f"SELECT 1 FROM {table}").fetchall()


def test_authenticated_reads_only_own_entitled_and_subscribed_rows(pg):
    ids = _seed(pg)
    with as_browser(pg, ACCOUNT_A) as connection:
        assert connection.execute("SELECT id FROM accounts").fetchall() == [(uuid.UUID(ACCOUNT_A),)]
        assert [row[0] for row in connection.execute("SELECT id FROM players").fetchall()] == [
            ids["player"]
        ]
        assert [row[0] for row in connection.execute("SELECT id FROM analysis_jobs").fetchall()] == [
            ids["job"]
        ]
        assert len(connection.execute("SELECT id FROM derived_artifacts").fetchall()) == 1
    with as_browser(pg, ACCOUNT_B) as connection:
        assert connection.execute("SELECT id FROM analysis_jobs").fetchall() == []
        assert connection.execute("SELECT job_id FROM job_subscribers").fetchall() == []
        assert connection.execute("SELECT id FROM derived_artifacts").fetchall() == []
        assert [row[0] for row in connection.execute("SELECT id FROM players").fetchall()] == [
            ids["other_player"]
        ]


def test_authenticated_cannot_read_lease_internals_or_write(pg):
    import psycopg

    ids = _seed(pg)
    with as_browser(pg, ACCOUNT_A) as connection:
        for statement, params in (
            ("SELECT lease_token_digest FROM analysis_jobs", None),
            ("SELECT lease_account_id FROM analysis_jobs", None),
            ("SELECT storage_key FROM derived_artifacts", None),
            ("SELECT * FROM analysis_upload_grants", None),
            ("UPDATE analysis_jobs SET status = 'succeeded' WHERE id = %s", (ids["job"],)),
            ("DELETE FROM job_subscribers", None),
            (
                "INSERT INTO job_subscribers (job_id, account_id) VALUES (%s, %s)",
                (ids["job"], ACCOUNT_A),
            ),
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
                connection.execute(statement, params)


def _realtime_available(pg) -> bool:
    with pg.transaction() as connection:
        return connection.execute("SELECT to_regclass('realtime.messages')").fetchone()[0] is not None


def test_job_updates_broadcast_sanitized_progress_to_private_topic(pg):
    if not _realtime_available(pg):
        pytest.skip("realtime stub requires CHESS_COACH_TEST_DATABASE_ADMIN_URL")
    ids = _seed(pg)
    with pg.transaction() as connection:
        connection.execute("DELETE FROM realtime.messages")
        connection.execute(
            "UPDATE analysis_jobs SET status = 'running', lease_token_digest = 'secret-digest', "
            "lease_account_id = %s, lease_device_id = 'device-1', "
            "lease_expires_at = now() + interval '60 seconds' WHERE id = %s",
            (ACCOUNT_A, ids["job"]),
        )
        connection.execute(
            "UPDATE analysis_jobs SET last_heartbeat_at = now() WHERE id = %s", (ids["job"],)
        )
        rows = connection.execute(
            "SELECT topic, event, private, payload::text FROM realtime.messages"
        ).fetchall()
    assert len(rows) == 1, "heartbeat-only updates must not broadcast"
    topic, event, private, payload = rows[0]
    assert (topic, event, private) == (f"job:{ids['job']}", "progress", True)
    assert '"worker_active": true' in payload
    for secret in ("secret-digest", ACCOUNT_A, "device-1"):
        assert secret not in payload


def test_private_broadcast_reaches_only_active_subscribers(pg):
    if not _realtime_available(pg):
        pytest.skip("realtime stub requires CHESS_COACH_TEST_DATABASE_ADMIN_URL")
    ids = _seed(pg)
    topic = f"job:{ids['job']}"
    with pg.transaction() as connection:
        connection.execute("DELETE FROM realtime.messages")
        connection.execute("UPDATE analysis_jobs SET completed_work = 1 WHERE id = %s", (ids["job"],))
    with as_browser(pg, ACCOUNT_A, topic=topic) as connection:
        assert len(connection.execute("SELECT 1 FROM realtime.messages").fetchall()) == 1
    with as_browser(pg, ACCOUNT_B, topic=topic) as connection:
        assert connection.execute("SELECT 1 FROM realtime.messages").fetchall() == []
    with pg.transaction() as connection:
        connection.execute("UPDATE job_subscribers SET state = 'stopped' WHERE job_id = %s", (ids["job"],))
    with as_browser(pg, ACCOUNT_A, topic=topic) as connection:
        assert connection.execute("SELECT 1 FROM realtime.messages").fetchall() == []
