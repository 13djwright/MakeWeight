# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""SQLite storage for MakeWeight.

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
    def __init__(self, path: Path, sync_safe: bool = False):
        self.path = Path(path)
        self.sync_safe = sync_safe
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = None
        self._connect()
        with _lock:
            self._conn.executescript(SCHEMA)
        self._migrate()

    def _connect(self):
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        if self.sync_safe:
            # On a cloud-drive folder: no -wal/-shm side files (sync clients copy them at the wrong moment and other
            # computers see a stale database); every change lands in the single .db file straight away.
            self._conn.execute("PRAGMA journal_mode=DELETE")
            self._conn.execute("PRAGMA synchronous=FULL")
        else:
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")

    @property
    def closed(self) -> bool:
        return self._conn is None

    def reopen(self):
        """Reconnect after close() — the file may have been replaced by the cloud drive in the meantime, which is
        exactly why we closed it."""
        with _lock:
            if self._conn is None:
                self._connect()
                self._migrate()

    def _migrate(self):
        # additive migrations: add columns that older databases lack
        wanted = {
            "printed_parts": {"mirror": "INTEGER DEFAULT 0", "modifiers_json": "TEXT DEFAULT '[]'", "print_json": "TEXT DEFAULT '{}'"},
            "line_items": {"to_buy": "INTEGER DEFAULT 0", "counted": "INTEGER DEFAULT 1", "configs_json": "TEXT"},
            "slice_jobs": {"print_time_s": "REAL", "priority": "INTEGER DEFAULT 5", "profile_json": "TEXT", "extra_json": "TEXT"},
            "runs": {"status": "TEXT DEFAULT 'done'", "name": "TEXT"},
            "robots": {"nozzle": "REAL DEFAULT 0.4", "class_name": "TEXT", "configs_json": "TEXT", "active_config": "TEXT"},
            "filaments": {"max_vol_speed": "REAL"},
            "weigh_ins": {"profile_id": "INTEGER", "sliced_grams": "REAL"},
            "components": {"kind": "TEXT DEFAULT 'generic'", "part_number": "TEXT", "specs_json": "TEXT"},
        }
        for table, cols in wanted.items():
            have = {r["name"] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            for c, typ in cols.items():
                if c not in have:
                    self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {c} {typ}")

    def close(self):
        """Flush and close so the files can be copied/moved (WAL is checkpointed into the main file first)."""
        with _lock:
            if self._conn is None:
                return
            try:
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            self._conn.close()
            self._conn = None

    # ---- primitives -------------------------------------------------------
    def _c(self):
        if self._conn is None:
            raise RuntimeError("The shared data is paused on this computer (idle or in use elsewhere) — resume it first.")
        return self._conn

    def q(self, sql: str, args: Iterable = ()) -> list[dict]:
        with _lock:
            return [dict(r) for r in self._c().execute(sql, tuple(args)).fetchall()]

    def one(self, sql: str, args: Iterable = ()) -> dict | None:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: Iterable = ()) -> int:
        with _lock:
            cur = self._c().execute(sql, tuple(args))
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

    # Settings that describe *this computer* (where its slicer is, how many cores to use) live in a small JSON file in
    # the local folder when the database itself is shared between computers, so one machine's paths never leak into
    # another's. Everything else (defaults, appearance, update source) is in the database like before.
    LOCAL_KEYS = {"bambu_path", "slicer_path", "workers", "keep_gcode", "slicer_engine"}
    local_file: Path | None = None

    def _local(self) -> dict:
        try:
            return json.loads(self.local_file.read_text(encoding="utf-8")) if self.local_file and self.local_file.exists() else {}
        except Exception:
            return {}

    def setting(self, key: str, default: Any = None) -> Any:
        if self.local_file is not None and key in self.LOCAL_KEYS:
            loc = self._local()
            if key in loc:
                return loc[key]
        if self._conn is None:
            return default                      # paused: shared settings are unreadable, callers get their defaults
        r = self.one("SELECT value FROM settings WHERE key=?", [key])
        return json.loads(r["value"]) if r else default

    def set_setting(self, key: str, value: Any) -> None:
        if self.local_file is not None and key in self.LOCAL_KEYS:
            loc = self._local(); loc[key] = value
            self.local_file.parent.mkdir(parents=True, exist_ok=True)
            self.local_file.write_text(json.dumps(loc, indent=1), encoding="utf-8")
            return
        self.x("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               [key, json.dumps(value)])

    def transaction(self):
        return _Tx(self._c())


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
