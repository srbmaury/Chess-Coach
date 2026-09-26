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
