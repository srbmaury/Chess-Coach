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

    assert tuple(item.version for item in migrations) == (
        "0001_hosted_schema",
        "0002_browser_analysis",
    )


def test_apply_migrations_is_idempotent():
    database = FakeDatabase()

    assert apply_migrations(database) == ("0001_hosted_schema", "0002_browser_analysis")
    first_execution_count = len(database.connection.executed)

    assert apply_migrations(database) == ()
    assert len(database.connection.executed) == first_execution_count + 2
