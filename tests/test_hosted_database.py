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
