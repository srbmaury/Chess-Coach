import re
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


def test_initial_migration_leaves_transaction_control_to_runner():
    sql = (
        files("chess_ml_coach.hosted")
        .joinpath("sql/0001_hosted_schema.sql")
        .read_text(encoding="utf-8")
    )

    assert not re.search(
        r"^\s*(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?\s*;",
        sql,
        re.MULTILINE | re.IGNORECASE,
    )
