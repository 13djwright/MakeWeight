"""SQLite storage for SliceBudget.

One database file, WAL mode, a thin helper layer. Flexible per-row detail is kept
as JSON text in *_json columns so the schema stays small.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, nozzles_json TEXT NOT NULL DEFAULT '[0.4]',
  bed_json TEXT NOT NULL DEFAULT '{"x":256,"y":256,"z":256}', builtin INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS filaments (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, material TEXT, density REAL NOT NULL,
  flow REAL NOT NULL DEFAULT 1.0, color TEXT, cost_per_kg REAL, notes TEXT,
  correction_json TEXT DEFAULT '{}', builtin INTEGER DEFAULT 0, max_vol_speed REAL);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, printer_id INTEGER, nozzle REAL NOT NULL DEFAULT 0.4,
  params_json TEXT NOT NULL, builtin INTEGER DEFAULT 0, notes TEXT);

CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, vendor TEXT, link TEXT, price REAL,
  dimensions TEXT, grams REAL, grams_source TEXT DEFAULT 'manual', notes TEXT,
  created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS component_weighins (
  id INTEGER PRIMARY KEY, component_id INTEGER NOT NULL, grams REAL NOT NULL, date TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS robots (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, weight_class_g REAL NOT NULL DEFAULT 453.592,
  class_name TEXT, margin_g REAL NOT NULL DEFAULT 4.5, printer_id INTEGER, nozzle REAL DEFAULT 0.4,
  status TEXT DEFAULT 'active', notes TEXT, created REAL, updated REAL);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY, robot_id INTEGER NOT NULL, name TEXT NOT NULL, ord INTEGER DEFAULT 0,
  counts INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY, section_id INTEGER NOT NULL, ord INTEGER DEFAULT 0,
  qty REAL DEFAULT 1, description TEXT, purpose TEXT, link TEXT, dimensions TEXT, price REAL,
  est_grams REAL, est_source TEXT DEFAULT 'manual', component_id INTEGER,
  status TEXT, needs_reweigh INTEGER DEFAULT 0, to_buy INTEGER DEFAULT 0, counted INTEGER DEFAULT 1, notes TEXT);

CREATE TABLE IF NOT EXISTS weigh_ins (
  id INTEGER PRIMARY KEY, line_item_id INTEGER NOT NULL, grams REAL NOT NULL, date TEXT, note TEXT,
  profile_string TEXT);

CREATE TABLE IF NOT EXISTS meshes (
  id INTEGER PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, filename TEXT, path TEXT, triangles INTEGER,
  volume_mm3 REAL, bbox_json TEXT, watertight INTEGER, bodies INTEGER, created REAL);

CREATE TABLE IF NOT EXISTS printed_parts (
  id INTEGER PRIMARY KEY, robot_id INTEGER NOT NULL, line_item_id INTEGER UNIQUE,
  mesh_id INTEGER, orient_json TEXT DEFAULT '{"mode":"auto","quat":[0,0,0,1]}', scale REAL DEFAULT 1.0,
  filament_id INTEGER, profile_id INTEGER, role TEXT DEFAULT 'structure', locked INTEGER DEFAULT 0,
  constraints_json TEXT DEFAULT '{}', mirror INTEGER DEFAULT 0, notes TEXT);

CREATE TABLE IF NOT EXISTS slice_jobs (
  id INTEGER PRIMARY KEY, part_id INTEGER, cache_key TEXT, mesh_sha TEXT, orient_key TEXT,
  profile_hash TEXT, profile_json TEXT, filament_key TEXT, slicer_version TEXT,
  status TEXT DEFAULT 'queued', purpose TEXT, run_id INTEGER, created REAL, started REAL, finished REAL,
  grams REAL, cm3 REAL, time_s REAL, print_time_s REAL, error TEXT, priority INTEGER DEFAULT 5);
CREATE INDEX IF NOT EXISTS ix_jobs_cache ON slice_jobs(cache_key);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON slice_jobs(status);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, robot_id INTEGER NOT NULL, kind TEXT, date REAL, name TEXT,
  inputs_json TEXT, results_json TEXT, notes TEXT, status TEXT DEFAULT 'done');

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, robot_id INTEGER NOT NULL, date TEXT, title TEXT, placing TEXT, notes TEXT,
  total_snapshot_g REAL);
"""

_lock = threading.RLock()


class DB:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with _lock:
            self._conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self):
        # additive migrations: add columns that older databases lack
        wanted = {
            "printed_parts": {"mirror": "INTEGER DEFAULT 0", "modifiers_json": "TEXT DEFAULT '[]'"},
            "line_items": {"to_buy": "INTEGER DEFAULT 0", "counted": "INTEGER DEFAULT 1"},
            "slice_jobs": {"print_time_s": "REAL", "priority": "INTEGER DEFAULT 5", "profile_json": "TEXT"},
            "runs": {"status": "TEXT DEFAULT 'done'", "name": "TEXT"},
            "robots": {"nozzle": "REAL DEFAULT 0.4", "class_name": "TEXT"},
            "filaments": {"max_vol_speed": "REAL"},
        }
        for table, cols in wanted.items():
            have = {r["name"] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            for c, typ in cols.items():
                if c not in have:
                    self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {c} {typ}")

    # ---- primitives -------------------------------------------------------
    def q(self, sql: str, args: Iterable = ()) -> list[dict]:
        with _lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(args)).fetchall()]

    def one(self, sql: str, args: Iterable = ()) -> dict | None:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: Iterable = ()) -> int:
        with _lock:
            cur = self._conn.execute(sql, tuple(args))
            return cur.lastrowid

    def insert(self, table: str, row: dict) -> int:
        cols = list(row.keys())
        sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})"
        return self.x(sql, [row[c] for c in cols])

    def update(self, table: str, id_: int, row: dict) -> None:
        if not row:
            return
        cols = list(row.keys())
        sql = f"UPDATE {table} SET {', '.join(c + '=?' for c in cols)} WHERE id=?"
        self.x(sql, [row[c] for c in cols] + [id_])

    def delete(self, table: str, id_: int) -> None:
        self.x(f"DELETE FROM {table} WHERE id=?", [id_])

    def get(self, table: str, id_: int) -> dict | None:
        return self.one(f"SELECT * FROM {table} WHERE id=?", [id_])

    def setting(self, key: str, default: Any = None) -> Any:
        r = self.one("SELECT value FROM settings WHERE key=?", [key])
        return json.loads(r["value"]) if r else default

    def set_setting(self, key: str, value: Any) -> None:
        self.x("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               [key, json.dumps(value)])

    def transaction(self):
        return _Tx(self._conn)


class _Tx:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        _lock.acquire()
        self.conn.execute("BEGIN")
        return self

    def __exit__(self, et, ev, tb):
        try:
            if et is None:
                self.conn.execute("COMMIT")
            else:
                self.conn.execute("ROLLBACK")
        finally:
            _lock.release()


def now() -> float:
    return time.time()


def loads(s: str | None, default):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default
