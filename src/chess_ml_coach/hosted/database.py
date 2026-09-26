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
    def from_settings(cls, settings: Settings) -> Database:
        if not settings.is_hosted or not settings.database_url:
            raise DatabaseConfigurationError("Database requires hosted persistence settings")
        return cls(settings.database_url)

    def open(self) -> None:
        self._pool.open(wait=True)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        with self._pool.connection() as connection, connection.transaction():
            yield connection

    def is_ready(self) -> bool:
        try:
            with self._pool.connection() as connection:
                return connection.execute("SELECT 1").fetchone() == (1,)
        except Exception:  # noqa: BLE001 - readiness maps database failures to False.
            return False
