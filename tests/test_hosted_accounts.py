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
