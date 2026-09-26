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
