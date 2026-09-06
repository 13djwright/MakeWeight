# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Undo / redo for everything the user edits.

Each mutating API request is one action. Before and after the request the content tables are read and the rows
that changed (inserted, updated, deleted) are kept as before/after pairs; undo writes the before rows back, redo
the after rows. Working on row snapshots means every route — including hand-written SQL — is covered without
touching the handlers, at the cost of two reads of a small database per edit (a few milliseconds).
"""
from __future__ import annotations

import json
import re
import threading
import time

from .db import DB
from .log import log

# tables the user edits; slice_jobs / runs / settings / meshes are machine state and are not undone
TABLES = ["robots", "sections", "line_items", "weigh_ins", "printed_parts", "components", "component_weighins",
          "filaments", "profiles", "printers", "events"]
MAX_ACTIONS = 100

_LABELS = [
    (r"^PUT items/\d+$", "edit line"), (r"^POST sections/\d+/items$", "add line"), (r"^DELETE items/\d+$", "delete line"),
    (r"^POST items/\d+/weighins$", "weigh-in"), (r"^DELETE weighins/\d+$", "delete weigh-in"), (r"^POST items/\d+/move$", "move line"),
    (r"^PUT parts/\d+$", "edit part"), (r"^DELETE parts/\d+$", "delete part"), (r"^POST parts/\d+/(auto_orient|lay_on_face|rotate|preset)$", "change orientation"),
    (r"^POST parts/\d+/mirror_copy$", "mirror copy"), (r"^POST robots/\d+/parts$", "add part"), (r"^POST robots/\d+/import3mf$", "import 3MF"),
    (r"^PUT sections/\d+$", "edit section"), (r"^POST robots/\d+/sections$", "add section"), (r"^DELETE sections/\d+$", "delete section"),
    (r"^PUT robots/\d+$", "edit robot"), (r"^POST robots$", "new robot"), (r"^DELETE robots/\d+$", "delete robot"), (r"^POST robots/\d+/duplicate$", "duplicate robot"),
    (r"^POST robots/\d+/weighin$", "robot weigh-in"), (r"^POST robots/\d+/events$", "log entry"), (r"^PUT events/\d+$", "edit entry"), (r"^DELETE events/\d+$", "delete entry"),
    (r"^POST components$", "add component"), (r"^PUT components/\d+$", "edit component"), (r"^DELETE components/\d+$", "delete component"), (r"^POST components/\d+/weighins$", "component weigh-in"),
    (r"^POST filaments$", "add filament"), (r"^PUT filaments/\d+$", "edit filament"), (r"^DELETE filaments/\d+$", "delete filament"),
    (r"^POST profiles$", "add profile"), (r"^PUT profiles/\d+$", "edit profile"), (r"^DELETE profiles/\d+$", "delete profile"),
    (r"^POST printers$", "add printer"), (r"^PUT printers/\d+$", "edit printer"), (r"^DELETE printers/\d+$", "delete printer"),
    (r"^POST runs/\d+/apply$", "apply optimizer plan"), (r"^POST import/archive$", "import archive"),
]


def label_for(method: str, path: str, hint: str | None = None) -> str:
    if hint:
        return hint[:80]
    key = f"{method} {path}"
    for rx, lab in _LABELS:
        if re.match(rx, key):
            return lab
    return f"{method.lower()} {path.split('/')[0]}"


class UndoManager:
    def __init__(self, db: DB, events=None):
        self.db = db
        self.events = events
        self.undo: list[dict] = []
        self.redo: list[dict] = []
        self._lock = threading.Lock()

    # ---- snapshots
    def snapshot(self) -> dict:
        snap = {}
        for t in TABLES:
            try:
                snap[t] = {r["id"]: r for r in self.db.q(f"SELECT * FROM {t}")}
            except Exception:  # noqa — table may not exist in an old database
                snap[t] = {}
        return snap

    @staticmethod
    def diff(before: dict, after: dict) -> dict:
        out = {}
        for t in TABLES:
            b, a = before.get(t, {}), after.get(t, {})
            rows = []
            for i in set(b) | set(a):
                rb, ra = b.get(i), a.get(i)
                if rb != ra:
                    rows.append({"id": i, "before": rb, "after": ra})
            if rows:
                out[t] = rows
        return out

    def record(self, before: dict, method: str, path: str, hint: str | None = None) -> dict | None:
        after = self.snapshot()
        d = self.diff(before, after)
        if not d:
            return None
        act = {"label": label_for(method, path, hint), "time": time.time(), "diff": d, "robot_id": self._robot_of(d, after),
               "n": sum(len(v) for v in d.values())}
        with self._lock:
            self.undo.append(act)
            del self.undo[:-MAX_ACTIONS]
            self.redo.clear()
        self._emit()
        return act

    def _robot_of(self, d: dict, snap: dict) -> int | None:
        for r in d.get("robots", []):
            return r["id"]
        for r in d.get("sections", []):
            row = r["after"] or r["before"]
            return row.get("robot_id")
        for t in ("line_items", "printed_parts"):
            for r in d.get(t, []):
                row = r["after"] or r["before"]
                if row.get("robot_id"):
                    return row["robot_id"]
                sec = snap.get("sections", {}).get(row.get("section_id"))
                if sec:
                    return sec.get("robot_id")
        return None

    # ---- apply
    def _apply(self, d: dict, side: str):
        """Write the `side` ('before' / 'after') rows of a diff into the database."""
        with self.db.transaction():
            for t, rows in d.items():
                for r in rows:
                    target = r[side]
                    if target is None:
                        self.db._conn.execute(f"DELETE FROM {t} WHERE id=?", [r["id"]])
                    else:
                        cols = list(target.keys())
                        exists = self.db._conn.execute(f"SELECT 1 FROM {t} WHERE id=?", [r["id"]]).fetchone()
                        if exists:
                            self.db._conn.execute(f"UPDATE {t} SET {', '.join(c + '=?' for c in cols if c != 'id')} WHERE id=?",
                                                  [target[c] for c in cols if c != "id"] + [r["id"]])
                        else:
                            self.db._conn.execute(f"INSERT INTO {t} ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", [target[c] for c in cols])

    def do_undo(self) -> dict | None:
        with self._lock:
            if not self.undo:
                return None
            act = self.undo.pop()
        self._apply(act["diff"], "before")
        with self._lock:
            self.redo.append(act)
        log.info("undo: %s (%d rows)", act["label"], act["n"])
        self._emit()
        return act

    def do_redo(self) -> dict | None:
        with self._lock:
            if not self.redo:
                return None
            act = self.redo.pop()
        self._apply(act["diff"], "after")
        with self._lock:
            self.undo.append(act)
        log.info("redo: %s (%d rows)", act["label"], act["n"])
        self._emit()
        return act

    def affected_parts(self, act: dict) -> list[int]:
        ids = set()
        for r in act["diff"].get("printed_parts", []):
            ids.add(r["id"])
        for t in ("filaments", "profiles"):
            for r in act["diff"].get(t, []):
                col = "filament_id" if t == "filaments" else "profile_id"
                for p in self.db.q(f"SELECT id FROM printed_parts WHERE {col}=?", [r["id"]]):
                    ids.add(p["id"])
        return sorted(ids)

    def state(self) -> dict:
        with self._lock:
            return {"undo": [{"label": a["label"], "time": a["time"], "robot_id": a["robot_id"]} for a in self.undo[-20:]],
                    "redo": [{"label": a["label"], "time": a["time"], "robot_id": a["robot_id"]} for a in self.redo[-20:]]}

    def _emit(self):
        if self.events is not None:
            try:
                self.events.emit("undo", self.state())
            except Exception:  # noqa
                pass
