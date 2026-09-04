"""First-run seed: printers, filaments, profiles, component library and Devin's three robots."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from . import profiles
from .db import DB, now

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


def parse_profile_note(note: str | None) -> dict | None:
    """'5 Walls, 2 Top, 4 Bottom, 15% infill' -> params."""
    if not note:
        return None
    p = {}
    m = re.search(r"(\d+)\s*walls?", note, re.I)
    if m: p["walls"] = int(m.group(1))
    m = re.search(r"(\d+)\s*top\s*&\s*bottom", note, re.I)
    if m: p["top"] = p["bottom"] = int(m.group(1))
    m = re.search(r"(\d+)\s*top\b", note, re.I)
    if m and "top" not in p: p["top"] = int(m.group(1))
    m = re.search(r"(\d+)\s*bottom", note, re.I)
    if m and "bottom" not in p: p["bottom"] = int(m.group(1))
    m = re.search(r"(\d+)\s*%\s*(\w+)?\s*infill", note, re.I)
    if m:
        p["infill"] = float(m.group(1))
        if m.group(2) and m.group(2).lower() in profiles.PATTERNS: p["pattern"] = m.group(2).lower()
    m = re.search(r"(0\.\d+)\s*(mm)?\s*layer", note, re.I)
    if m: p["layer_height"] = float(m.group(1)); p["first_layer_height"] = float(m.group(1))
    return p or None


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


def ensure_seed(db: DB) -> None:
    if db.setting("seeded_v1"):
        refresh_builtin_filaments(db)
        return
    with db.transaction():
        for name, nozzles, bed in PRINTERS:
            db.insert("printers", {"name": name, "nozzles_json": json.dumps(nozzles), "bed_json": json.dumps(bed), "builtin": 1})
        fil_ids = {}
        for name, mat, dens, flow, color, cost, mvs in FILAMENTS:
            fil_ids[name] = db.insert("filaments", {"name": name, "material": mat, "density": dens, "flow": flow, "color": color,
                                                     "cost_per_kg": cost, "max_vol_speed": mvs, "correction_json": "{}", "builtin": 1})
        db.set_setting("filaments_v", 2)
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

        data_path = Path(__file__).parent / "seed_data.json"
        if data_path.exists():
            data = json.loads(data_path.read_text())
            comp_ids = {}
            for c in data["components"]:
                cid = db.insert("components", {"name": c["name"], "category": c["category"], "link": c.get("link"), "price": c.get("price"),
                                               "dimensions": c.get("dimensions"), "grams": c.get("grams"), "grams_source": "sheet",
                                               "notes": ("Used in " + ", ".join(c["used_in"])) if c.get("used_in") else None,
                                               "created": now(), "updated": now()})
                comp_ids[c["name"].lower()] = cid
            for rb in data["robots"]:
                rid = db.insert("robots", {"name": rb["name"], "weight_class_g": rb["weight_class_g"], "class_name": rb.get("class_name"),
                                           "margin_g": round(rb["weight_class_g"] * 0.01, 1), "printer_id": p1s, "nozzle": 0.4, "status": "active",
                                           "notes": "Seeded from the Excel weight budget. Sheet weights imported as estimates (source: sheet); add weigh-ins to mark them measured.",
                                           "created": now(), "updated": now()})
                for si, sec in enumerate(rb["sections"]):
                    sid = db.insert("sections", {"robot_id": rid, "name": sec["name"], "ord": si, "counts": 1 if sec["counts"] else 0})
                    for ii, it in enumerate(sec["items"]):
                        iid = db.insert("line_items", {"section_id": sid, "ord": ii, "qty": it["qty"], "description": it["description"], "purpose": it.get("purpose"),
                                                       "link": it.get("link"), "dimensions": it.get("dimensions"), "price": it.get("price"),
                                                       "est_grams": it.get("grams"), "est_source": "slicer" if it.get("printed") else "sheet",
                                                       "component_id": comp_ids.get((it.get("component_key") or "").lower()), "notes": it.get("notes"),
                                                       "counted": 0 if it.get("excluded") else 1})
                        if it.get("printed"):
                            params = parse_profile_note(it.get("profile_note"))
                            prof_id = prof_ids["Bambu 0.20mm Standard · 0.4 (cubic)"]
                            if it.get("locked"):
                                prof_id = prof_ids["Weapon solid 3W/100%"]
                            elif params:
                                nm = f"{rb['name']} · {it['description']}"
                                prof_id = db.insert("profiles", {"name": nm, "printer_id": None, "nozzle": 0.4, "params_json": json.dumps(profiles.normalize(params)), "builtin": 0,
                                                                 "notes": "From sheet note: " + (it.get("profile_note") or "")})
                            role = it.get("role") or "structure"
                            if "upright" in it["description"].lower():
                                role = "structure"
                            db.insert("printed_parts", {"robot_id": rid, "line_item_id": iid, "mesh_id": None, "orient_json": json.dumps({"mode": "auto", "quat": [0, 0, 0, 1]}),
                                                        "scale": 1.0, "filament_id": fil_ids.get(it.get("filament"), fil_ids["Bambu PLA Basic"]), "profile_id": prof_id,
                                                        "role": role, "locked": 1 if it.get("locked") else 0, "constraints_json": "{}"})
                for ev in rb.get("events", []):
                    db.insert("events", {"robot_id": rid, "date": ev["date"], "title": ev["title"], "notes": ev.get("notes"), "total_snapshot_g": None})
        db.set_setting("seeded_v1", True)
