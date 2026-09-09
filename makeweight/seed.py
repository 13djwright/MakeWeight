# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""First-run seed: printers, filaments and starter profiles. Robots and the component library start empty."""
from __future__ import annotations

import json

from . import profiles
from .db import DB

FILAMENTS = [
    # name, material, density g/cm3, flow ratio, colour, $/kg, max volumetric speed mm3/s  (Bambu Studio 2.08 system profiles, 0.4 nozzle)
    ("Bambu PLA Basic", "PLA", 1.26, 0.98, "#3b82c4", 24.99, 21),
    ("Generic PLA", "PLA", 1.24, 0.98, "#7aa0c4", 20.0, 12),
    ("Bambu PLA Matte", "PLA", 1.32, 0.98, "#6b8fb3", 24.99, 22),
    ("Bambu PLA Tough", "PLA", 1.26, 0.98, "#4f77a8", 29.99, 21),
    ("Bambu PLA-CF", "PLA-CF", 1.22, 0.98, "#444444", 39.99, 15),
    ("Bambu PETG HF", "PETG", 1.28, 0.95, "#4aa3a3", 24.99, 21),
    ("Bambu PETG Basic", "PETG", 1.25, 0.95, "#3f8f8f", 24.99, 15),
    ("Generic PETG", "PETG", 1.27, 0.95, "#5cb8b8", 22.0, 12),
    ("Bambu PET-CF", "PET-CF", 1.29, 0.9555, "#3d6b6b", 49.99, 5),
    ("Generic ABS", "ABS", 1.04, 0.95, "#8d6e63", 22.0, 15),
    ("Bambu ABS", "ABS", 1.04, 0.95, "#a1887f", 24.99, 16),
    ("Generic ASA", "ASA", 1.04, 0.95, "#c9a227", 25.0, 12),
    ("Bambu ASA", "ASA", 1.05, 0.95, "#d4b04a", 29.99, 18),
    ("Bambu TPU 95A HF", "TPU", 1.22, 1.00, "#5e9c76", 39.99, 12),
    ("Bambu TPU 95A", "TPU", 1.22, 1.00, "#6fae86", 34.99, 3.6),
    ("Generic TPU", "TPU", 1.24, 1.00, "#7fb894", 30.0, 3.2),
    ("Bambu PA6-CF", "PA-CF", 1.10, 0.96, "#333333", 79.99, 8),
    ("Bambu PAHT-CF", "PA-CF", 1.06, 0.96, "#2d2d2d", 79.99, 8),
    ("Bambu PC", "PC", 1.185, 0.94, "#9aa5b1", 39.99, 18),
]

PRINTERS = [("Bambu Lab H2D", [0.4, 0.6], {"x": 350, "y": 320, "z": 325}), ("Bambu Lab P1S", [0.4, 0.6], {"x": 256, "y": 256, "z": 256})]


def refresh_builtin_filaments(db: DB) -> int:
    """One-time upgrade of built-in filament rows to Bambu Studio 2.08's density / flow / max volumetric speed.
    Adds filaments that did not exist before. Keeps corrections, colours and costs. Returns rows changed."""
    if (db.setting("filaments_v") or 1) >= 2:
        return 0
    n = 0
    with db.transaction():
        for name, mat, dens, flow, color, cost, mvs in FILAMENTS:
            row = db.one("SELECT * FROM filaments WHERE name=?", [name])
            if row is None:
                db.insert("filaments", {"name": name, "material": mat, "density": dens, "flow": flow, "color": color,
                                        "cost_per_kg": cost, "max_vol_speed": mvs, "correction_json": "{}", "builtin": 1}); n += 1
            elif row.get("builtin"):
                if (row["density"], row["flow"], row.get("max_vol_speed")) != (dens, flow, mvs):
                    db.update("filaments", row["id"], {"density": dens, "flow": flow, "max_vol_speed": mvs}); n += 1
        db.x("UPDATE filaments SET max_vol_speed=12 WHERE max_vol_speed IS NULL")
        db.set_setting("filaments_v", 2)
    return n


def zero_min_thickness(db: DB) -> int:
    """One-time (v2): layer counts mean exactly what they say — no hidden 'minimum shell thickness' rule."""
    if (db.setting("profiles_v") or 1) >= 2:
        return 0
    n = 0
    for r in db.q("SELECT * FROM profiles"):
        params = json.loads(r["params_json"] or "{}")
        if params.get("top_min_thickness") or params.get("bottom_min_thickness"):
            params["top_min_thickness"] = 0.0; params["bottom_min_thickness"] = 0.0
            db.update("profiles", r["id"], {"params_json": json.dumps(params)}); n += 1
    db.set_setting("profiles_v", 2)
    return n


def drop_used_in_notes(db: DB) -> int:
    """One-time: components imported from the old workbooks carried "Used in <robot>" as their note; usage is computed
    from the sheets now, so those notes only get stale."""
    if db.setting("components_v"):
        return 0
    n = 0
    for r in db.q("SELECT id, notes FROM components WHERE notes LIKE 'Used in %'"):
        note = (r["notes"] or "")
        rest = note.split("\n", 1)[1].strip() if "\n" in note else ""
        db.update("components", r["id"], {"notes": rest or None}); n += 1
    db.set_setting("components_v", 2)
    return n


def ensure_seed(db: DB) -> None:
    if db.setting("seeded_v1"):
        refresh_builtin_filaments(db)
        zero_min_thickness(db)
        drop_used_in_notes(db)
        return
    with db.transaction():
        for name, nozzles, bed in PRINTERS:
            db.insert("printers", {"name": name, "nozzles_json": json.dumps(nozzles), "bed_json": json.dumps(bed), "builtin": 1})
        fil_ids = {}
        for name, mat, dens, flow, color, cost, mvs in FILAMENTS:
            fil_ids[name] = db.insert("filaments", {"name": name, "material": mat, "density": dens, "flow": flow, "color": color,
                                                     "cost_per_kg": cost, "max_vol_speed": mvs, "correction_json": "{}", "builtin": 1})
        db.set_setting("filaments_v", 2)
        db.set_setting("profiles_v", 2)
        db.set_setting("components_v", 2)
        prof_ids = {}
        for nozzle in (0.4, 0.6):
            params = profiles.default_params(nozzle)
            nm = f"Bambu {'0.20mm' if nozzle == 0.4 else '0.30mm'} Standard · {nozzle:g} (cubic)"
            prof_ids[nm] = db.insert("profiles", {"name": nm, "printer_id": None, "nozzle": nozzle, "params_json": json.dumps(params), "builtin": 1,
                                                  "notes": "Bambu Studio system default; sparse pattern changed from grid to cubic."})
        for nm, params in [("Chassis 5W/2T/4B/15%", {"walls": 5, "top": 2, "bottom": 4, "infill": 15}),
                           ("TPU armor 0.24 · 6W/5T/5B/25%", {"walls": 6, "top": 5, "bottom": 5, "infill": 25, "layer_height": 0.24, "first_layer_height": 0.24}),
                           ("Weapon solid 3W/100%", {"walls": 3, "infill": 100, "pattern": "rectilinear"}),
                           ("Light 2W/3T/3B/10%", {"walls": 2, "top": 3, "bottom": 3, "infill": 10})]:
            prof_ids[nm] = db.insert("profiles", {"name": nm, "printer_id": None, "nozzle": 0.4, "params_json": json.dumps(profiles.normalize(params)), "builtin": 0})
        p1s = db.one("SELECT id FROM printers WHERE name LIKE '%P1S%'")["id"]
        db.set_setting("default_printer_id", p1s)
        db.set_setting("default_filament_id", fil_ids["Bambu PLA Basic"])
        db.set_setting("default_profile_id", prof_ids["Bambu 0.20mm Standard · 0.4 (cubic)"])

        db.set_setting("seeded_v1", True)
