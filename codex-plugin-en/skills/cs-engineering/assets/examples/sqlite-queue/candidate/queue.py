"""Small local-SQLite reference queue, not an AGS production replacement.

Protects database result publication with an owner generation and lease.
It does not provide exactly-once execution of external effects. All timestamps
are injected by the caller; production clock/restart policy is out of scope.
"""
from __future__ import annotations
import sqlite3
from contextlib import closing
from pathlib import Path


def connect(filename: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(filename), timeout=5, isolation_level=None)
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def initialize(filename: str | Path) -> None:
    with closing(connect(filename)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY,
            state TEXT NOT NULL CHECK(state IN ('pending','running','done')),
            owner TEXT,
            generation INTEGER NOT NULL DEFAULT 0,
            lease_until INTEGER NOT NULL DEFAULT 0,
            result TEXT
        )""")


def claim(filename: str | Path, owner: str, now: int, lease: int) -> dict | None:
    if not owner or not isinstance(now, int) or not isinstance(lease, int) or lease <= 0:
        raise ValueError("An owner and a positive integer lease are required")
    with closing(connect(filename)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute("""SELECT id, generation FROM tasks
                WHERE state='pending' OR (state='running' AND lease_until<=?)
                ORDER BY id LIMIT 1""", (now,)).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            task_id, generation = row
            cursor = connection.execute("""UPDATE tasks
                SET state='running', owner=?, generation=generation+1, lease_until=?
                WHERE id=? AND generation=?""", (owner, now + lease, task_id, generation))
            if cursor.rowcount != 1:
                raise RuntimeError("Claim invariant violated")
            connection.execute("COMMIT")
            return {"taskId": task_id, "owner": owner, "generation": generation + 1}
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise


def finish(filename: str | Path, token: dict, result: str, now: int) -> bool:
    with closing(connect(filename)) as connection:
        cursor = connection.execute("""UPDATE tasks SET state='done', result=?
            WHERE id=? AND owner=? AND generation=? AND state='running'
                AND lease_until>?""", (result, token["taskId"], token["owner"], token["generation"], now))
        return cursor.rowcount == 1
