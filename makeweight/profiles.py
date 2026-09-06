# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Print profiles: Bambu Studio vocabulary in, PrusaSlicer .ini out."""
from __future__ import annotations

import hashlib
import json

# Bambu Studio system defaults per nozzle (read from bambulab/BambuStudio profile JSONs).
BAMBU_DEFAULTS = {
    0.4: {
        "layer_height": 0.20, "first_layer_height": 0.20,
        "walls": 2, "top": 5, "bottom": 3, "top_min_thickness": 0.0, "bottom_min_thickness": 0.0,
        "infill": 15, "pattern": "cubic",
        "line_widths": {"outer": 0.42, "inner": 0.45, "infill": 0.45, "solid": 0.42, "top": 0.42, "first": 0.50},
        "infill_wall_overlap": 15, "one_wall_top": True, "min_sparse_area": 15.0, "thin_walls": False,
        "gap_fill": True, "infill_direction": 45,
    },
    0.6: {
        "layer_height": 0.30, "first_layer_height": 0.30,
        "walls": 2, "top": 3, "bottom": 3, "top_min_thickness": 0.0, "bottom_min_thickness": 0.0,
        "infill": 15, "pattern": "cubic",
        "line_widths": {"outer": 0.62, "inner": 0.62, "infill": 0.62, "solid": 0.62, "top": 0.62, "first": 0.62},
        "infill_wall_overlap": 15, "one_wall_top": True, "min_sparse_area": 15.0, "thin_walls": False,
        "gap_fill": True, "infill_direction": 45,
    },
}

PATTERNS = ["cubic", "grid", "gyroid", "triangles", "rectilinear", "honeycomb", "3dhoneycomb", "adaptivecubic",
            "supportcubic", "lightning", "alignedrectilinear", "stars", "concentric"]

# Bambu pattern name -> PrusaSlicer fill_pattern
PATTERN_MAP = {p: p for p in PATTERNS}
PATTERN_MAP.update({"zig-zag": "rectilinear", "line": "alignedrectilinear", "tri-hexagon": "stars"})


def default_params(nozzle: float = 0.4) -> dict:
    base = BAMBU_DEFAULTS.get(float(nozzle), BAMBU_DEFAULTS[0.4])
    p = json.loads(json.dumps(base))
    p["nozzle"] = float(nozzle)
    return p


def normalize(params: dict) -> dict:
    """Fill gaps from the nozzle default and coerce types."""
    nozzle = float(params.get("nozzle", 0.4))
    p = default_params(nozzle)
    for k, v in params.items():
        if k == "line_widths" and isinstance(v, dict):
            p["line_widths"].update({kk: float(vv) for kk, vv in v.items()})
        elif v is not None:
            p[k] = v
    for k in ("layer_height", "first_layer_height", "top_min_thickness", "bottom_min_thickness", "infill", "min_sparse_area"):
        p[k] = float(p[k])
    for k in ("walls", "top", "bottom"):
        p[k] = int(round(float(p[k])))
    p["infill"] = max(0.0, min(100.0, p["infill"]))
    p["one_wall_top"] = bool(p.get("one_wall_top", True))
    return p


def effective_shell_layers(params: dict) -> tuple[int, int]:
    """Bambu's 'whichever is more' rule for top/bottom layer counts."""
    import math
    lh = params["layer_height"]
    top = max(params["top"], math.ceil(params["top_min_thickness"] / lh - 1e-9) if params["top_min_thickness"] > 0 else 0)
    bot = max(params["bottom"], math.ceil(params["bottom_min_thickness"] / lh - 1e-9) if params["bottom_min_thickness"] > 0 else 0)
    return top, bot


def profile_string(params: dict) -> str:
    p = normalize(params)
    inf = f"{p['infill']:g}%"
    pat = "" if p["infill"] >= 100 else f" {p['pattern']}"
    s = f"{p['walls']}W · {p['top']}T/{p['bottom']}B · {inf}{pat} · {p['layer_height']:g}"
    if abs(p["nozzle"] - 0.4) > 1e-6:
        s += f" · {p['nozzle']:g}"
    return s


def profile_hash(params: dict, filament: dict | None = None) -> str:
    p = normalize(params)
    key = {"p": p}
    if filament:
        key["f"] = {"density": round(float(filament["density"]), 4), "flow": round(float(filament.get("flow", 1.0)), 4)}
    return hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]


def _ver_tuple(version: str | None) -> tuple:
    if not version:
        return (2, 9, 0)
    import re
    m = re.findall(r"\d+", version)
    return tuple(int(x) for x in m[:3]) if m else (2, 9, 0)


# Speeds / accelerations from Bambu Studio 2.08 "0.20mm Standard" process + machine profiles (0.4 nozzle).
# They do not change filament weight; they make PrusaSlicer's print-time estimate comparable to Bambu Studio's.
MACHINES = {
    "P1S": {"outer": 200, "inner": 300, "sparse": 270, "solid": 250, "top": 200, "gap": 250, "bridge": 50, "support": 150,
            "travel": 500, "first": 50, "first_infill": 105, "accel": 10000, "outer_accel": 5000, "top_accel": 2000,
            "travel_accel": 10000, "first_accel": 500, "max_accel": 20000, "max_accel_travel": 9000, "max_feed": 500,
            "max_feed_z": 20, "max_feed_e": 30, "jerk": 9, "jerk_z": 3, "jerk_e": 2.5, "bed": (256, 256), "height": 250},
    "H2D": {"outer": 200, "inner": 300, "sparse": 350, "solid": 250, "top": 200, "gap": 250, "bridge": 50, "support": 150,
            "travel": 1000, "first": 50, "first_infill": 105, "accel": 8000, "outer_accel": 5000, "top_accel": 2000,
            "travel_accel": 10000, "first_accel": 500, "max_accel": 20000, "max_accel_travel": 9000, "max_feed": 1000,
            "max_feed_z": 30, "max_feed_e": 50, "jerk": 9, "jerk_z": 3, "jerk_e": 2.5, "bed": (350, 320), "height": 325},
}
MAPPING_VERSION = "m2"  # bump when the ini mapping changes in a way that should invalidate cached slices


def machine_key(printer_name: str | None) -> str:
    n = (printer_name or "").upper()
    return "H2D" if "H2D" in n else "P1S"


def to_prusa_ini(params: dict, filament: dict, slicer_version: str | None = None, bed=(400, 400), machine: str = "P1S") -> str:
    """Generate a PrusaSlicer print+filament+printer config reproducing Bambu Studio's behaviour."""
    p = normalize(params)
    v = _ver_tuple(slicer_version)
    lw = p["line_widths"]
    density = float(filament["density"])
    flow = float(filament.get("flow", 1.0) or 1.0)
    mvs = float(filament.get("max_vol_speed") or 12)
    M = MACHINES.get(machine, MACHINES["P1S"])
    lines = [
        "# generated by MakeWeight",
        f"layer_height = {p['layer_height']:g}",
        f"first_layer_height = {p['first_layer_height']:g}",
        f"perimeters = {p['walls']}",
        f"top_solid_layers = {p['top']}",
        f"bottom_solid_layers = {p['bottom']}",
        f"top_solid_min_thickness = {p['top_min_thickness']:g}",
        f"bottom_solid_min_thickness = {p['bottom_min_thickness']:g}",
        f"fill_density = {p['infill']:g}%",
        f"fill_pattern = {'rectilinear' if p['infill'] >= 100 else PATTERN_MAP.get(p['pattern'], 'cubic')}",
        f"fill_angle = {p.get('infill_direction', 45)}",
        "top_fill_pattern = monotonic",
        "bottom_fill_pattern = monotonic",
        f"extrusion_width = {lw['inner']:g}",
        f"external_perimeter_extrusion_width = {lw['outer']:g}",
        f"perimeter_extrusion_width = {lw['inner']:g}",
        f"infill_extrusion_width = {lw['infill']:g}",
        f"solid_infill_extrusion_width = {lw['solid']:g}",
        f"top_infill_extrusion_width = {lw['top']:g}",
        f"first_layer_extrusion_width = {lw['first']:g}",
        f"infill_overlap = {p['infill_wall_overlap']:g}%",
        f"solid_infill_below_area = {p.get('min_sparse_area', 15):g}",
        f"thin_walls = {1 if p.get('thin_walls') else 0}",
        f"gap_fill_enabled = {1 if p.get('gap_fill', True) else 0}",
        "perimeter_generator = classic",
        "extra_perimeters = 0",
        "extra_perimeters_on_overhangs = 0",
        "infill_every_layers = 1",
        "infill_anchor = 400%",
        "infill_anchor_max = 20",
        "seam_position = aligned",
        "support_material = 0",
        "support_material_auto = 0",
        "skirts = 0",
        "brim_width = 0",
        "brim_type = no_brim",
        "raft_layers = 0",
        "elefant_foot_compensation = 0",
        "complete_objects = 0",
        "wipe_tower = 0",
        # filament
        f"filament_density = {density:g}",
        f"extrusion_multiplier = {flow:g}",
        "filament_diameter = 1.75",
        "filament_cost = 0",
        # printer
        f"nozzle_diameter = {p['nozzle']:g}",
        f"bed_shape = 0x0,{bed[0]}x0,{bed[0]}x{bed[1]},0x{bed[1]}",
        "max_print_height = 400",
        "printer_technology = FFF",
        "gcode_flavor = marlin2",
        "use_relative_e_distances = 0",
        # speeds (Bambu process profile)
        f"perimeter_speed = {M['inner']}",
        f"external_perimeter_speed = {M['outer']}",
        "small_perimeter_speed = 50%",
        f"infill_speed = {M['sparse']}",
        f"solid_infill_speed = {M['solid']}",
        f"top_solid_infill_speed = {M['top']}",
        f"gap_fill_speed = {M['gap']}",
        f"bridge_speed = {M['bridge']}",
        f"support_material_speed = {M['support']}",
        f"travel_speed = {M['travel']}",
        "travel_speed_z = 0",
        f"first_layer_speed = {M['first']}",
        f"first_layer_infill_speed = {M['first_infill']}",
        "first_layer_speed_over_raft = 30",
        "enable_dynamic_overhang_speeds = 1",
        "overhang_speed_0 = 10",
        "overhang_speed_1 = 30",
        "overhang_speed_2 = 50",
        f"overhang_speed_3 = {M['outer']}",
        f"default_acceleration = {M['accel']}",
        f"perimeter_acceleration = {M['accel']}",
        f"external_perimeter_acceleration = {M['outer_accel']}",
        f"infill_acceleration = {M['accel']}",
        f"solid_infill_acceleration = {M['accel']}",
        f"top_solid_infill_acceleration = {M['top_accel']}",
        f"bridge_acceleration = {M['accel']}",
        f"travel_acceleration = {M['travel_accel']}",
        f"first_layer_acceleration = {M['first_accel']}",
        f"first_layer_acceleration_over_raft = {M['first_accel']}",
        # machine limits (Bambu machine profile) — used for the time estimate only
        "machine_limits_usage = time_estimate_only",
        f"machine_max_acceleration_x = {M['max_accel']},{M['max_accel']}",
        f"machine_max_acceleration_y = {M['max_accel']},{M['max_accel']}",
        "machine_max_acceleration_z = 500,500",
        "machine_max_acceleration_e = 5000,5000",
        f"machine_max_acceleration_extruding = {M['max_accel']},{M['max_accel']}",
        "machine_max_acceleration_retracting = 5000,5000",
        f"machine_max_acceleration_travel = {M['max_accel_travel']},{M['max_accel_travel']}",
        f"machine_max_feedrate_x = {M['max_feed']},{M['max_feed']}",
        f"machine_max_feedrate_y = {M['max_feed']},{M['max_feed']}",
        f"machine_max_feedrate_z = {M['max_feed_z']},{M['max_feed_z']}",
        f"machine_max_feedrate_e = {M['max_feed_e']},{M['max_feed_e']}",
        f"machine_max_jerk_x = {M['jerk']},{M['jerk']}",
        f"machine_max_jerk_y = {M['jerk']},{M['jerk']}",
        f"machine_max_jerk_z = {M['jerk_z']},{M['jerk_z']}",
        f"machine_max_jerk_e = {M['jerk_e']},{M['jerk_e']}",
        "machine_min_extruding_rate = 0,0",
        "machine_min_travel_rate = 0,0",
        # filament: Bambu caps every speed by the filament's max volumetric speed; so does PrusaSlicer
        f"filament_max_volumetric_speed = {mvs:g}",
        "slowdown_below_layer_time = 8",
        "min_print_speed = 20",
        "cooling = 1",
        "fan_always_on = 1",
        # retraction (Bambu machine profile); no effect on weight, small effect on time
        "retract_length = 0.8",
        "retract_speed = 30",
        "deretract_speed = 30",
        # Bambu lifts 0.4 mm with a spiral move that overlaps the travel; PrusaSlicer's straight lift would add ~8% to the
        # time estimate on hole-rich parts, so it is left off here (weight is unaffected either way)
        "retract_lift = 0",
        "retract_layer_change = 1",
        "retract_before_travel = 1",
        "wipe = 1",
        "retract_before_wipe = 0%",
        "start_gcode = ",
        "end_gcode = ",
        "layer_gcode = ",
        "before_layer_gcode = ",
        "toolchange_gcode = ",
        "gcode_comments = 0",
        "gcode_label_objects = disabled",
        "binary_gcode = 0",
    ]
    if v < (2, 8, 0):
        lines = [l for l in lines if not l.startswith("binary_gcode")]
    if v >= (2, 8, 0):
        lines.append("ensure_vertical_shell_thickness = enabled")
        lines.append(f"top_one_perimeter_type = {'top' if p['one_wall_top'] else 'none'}")
    else:
        lines.append("ensure_vertical_shell_thickness = 1")
    return "\n".join(lines) + "\n"


def to_bambu_preset(params: dict, name: str, printer_name: str = "Bambu Lab P1S", inherits: str | None = None) -> dict:
    """A Bambu Studio user process preset (JSON) that overrides only what differs from the system default."""
    p = normalize(params)
    base = default_params(p["nozzle"])
    nozzle = p["nozzle"]
    if inherits is None:
        inherits = f"{'0.20mm Standard' if nozzle == 0.4 else '0.30mm Standard'} @BBL {printer_name.replace('Bambu Lab ', '')}{'' if nozzle == 0.4 else ' 0.6 nozzle'}"
    out = {
        "type": "process", "name": name, "from": "User", "inherits": inherits, "version": "1.9.0.0",
        "wall_loops": str(p["walls"]), "top_shell_layers": str(p["top"]), "bottom_shell_layers": str(p["bottom"]),
        "top_shell_thickness": f"{p['top_min_thickness']:g}", "bottom_shell_thickness": f"{p['bottom_min_thickness']:g}",
        "sparse_infill_density": f"{p['infill']:g}%", "sparse_infill_pattern": p["pattern"],
        "layer_height": f"{p['layer_height']:g}", "initial_layer_print_height": f"{p['first_layer_height']:g}",
        "infill_wall_overlap": f"{p['infill_wall_overlap']:g}%", "only_one_wall_top": "1" if p["one_wall_top"] else "0",
        "minimum_sparse_infill_area": f"{p.get('min_sparse_area', 15):g}",
    }
    lw = p["line_widths"]; blw = base["line_widths"]
    keys = {"outer": "outer_wall_line_width", "inner": "inner_wall_line_width", "infill": "sparse_infill_line_width",
            "solid": "internal_solid_infill_line_width", "top": "top_surface_line_width", "first": "initial_layer_line_width"}
    for k, bk in keys.items():
        if abs(lw[k] - blw[k]) > 1e-6:
            out[bk] = f"{lw[k]:g}"
    return out
