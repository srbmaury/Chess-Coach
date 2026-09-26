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


class OpenFailureDatabase(FakeDatabase):
    def open(self):
        self.opened = True
        raise RuntimeError("database is unavailable")


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


def test_db_migrate_prefers_explicit_database_url_over_environment(monkeypatch):
    database = FakeDatabase()
    seen = {}

    def factory(settings):
        seen["database_url"] = settings.database_url
        return database

    monkeypatch.setattr(cli, "_database_factory", factory)
    monkeypatch.setattr(cli, "_apply_migrations", lambda _database: ())

    result = runner.invoke(
        cli.app,
        ["db-migrate", "--database-url", "postgresql://option.invalid/chess"],
        env={"DATABASE_URL": "postgresql://environment.invalid/chess"},
    )

    assert result.exit_code == 0
    assert seen["database_url"] == "postgresql://option.invalid/chess"


def test_db_migrate_reports_when_schema_is_current(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(cli, "_database_factory", lambda _settings: database)
    monkeypatch.setattr(cli, "_apply_migrations", lambda _database: ())

    result = runner.invoke(
        cli.app,
        ["db-migrate", "--database-url", "postgresql://example.invalid/chess"],
    )

    assert result.exit_code == 0
    assert "Database schema is already current" in result.stdout


def test_db_migrate_closes_database_when_open_fails(monkeypatch):
    database = OpenFailureDatabase()
    monkeypatch.setattr(cli, "_database_factory", lambda _settings: database)

    result = runner.invoke(
        cli.app,
        ["db-migrate", "--database-url", "postgresql://example.invalid/chess"],
    )

    assert result.exit_code != 0
    assert "Database migration failed" in result.output
    assert database.opened is True
    assert database.closed is True


def test_db_migrate_redacts_database_uri_from_factory_error(monkeypatch):
    database_url = "postgresql://demo_user:demo_password@invalid/chess"

    def failing_factory(_settings):
        raise RuntimeError(database_url)

    monkeypatch.setattr(cli, "_database_factory", failing_factory)

    result = runner.invoke(cli.app, ["db-migrate", "--database-url", database_url])

    assert result.exit_code != 0
    assert "Database migration failed" in result.output
    assert database_url not in result.output
    assert "demo_password" not in result.output
