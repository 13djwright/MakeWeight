"""Build the showcase robot on the demo instance (port 8790)."""
import json, urllib.request, time, sys, pathlib
BASE = "http://127.0.0.1:8790/api/"
def api(method, path, body=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
    req.add_header("X-Wake", "1")
    for k, v in (headers or {}).items(): req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read() or b"null")

M = "/tmp/sbroot/data/meshes/"
def mesh(fname, as_name):
    data = pathlib.Path(M + fname).read_bytes()
    r = api("POST", "meshes", raw=data, headers={"X-Filename": urllib.parse.quote(as_name)})
    return r["meshes"][0]["id"]
import urllib.parse

st = api("GET", "state")
F = {f["name"]: f["id"] for f in st["filaments"]}; P = {p["name"]: p["id"] for p in st["profiles"]}
PLA, PLAB, PETG, TPU = F["Generic PLA"], F["Bambu PLA Basic"], F["Bambu PETG HF"], F["Bambu TPU 95A"]

# --- component library --------------------------------------------------------------------------------------------
def comp(name, category, grams, kind="generic", specs=None, vendor=None, price=None, link=None, part_number=None, dims=None, source="manual", notes=None):
    return api("POST", "components", {"name": name, "category": category, "grams": grams, "grams_source": source, "kind": kind, "specs": specs,
                                      "vendor": vendor, "price": price, "link": link, "part_number": part_number, "dimensions": dims, "notes": notes})["id"]
def screw(thread, length, unit, head, material, finish, grams, price, pn, length_txt=None):
    sp = {"type": "screw", "screw_type": "machine screw", "thread": thread, "length": length, "length_unit": unit, "head": head, "drive": "hex (Allen)", "material": material, "finish": finish, "thread_type": "full"}
    nm = f"{thread} × {length_txt or (str(length) + ' mm')} {head} screw"
    return comp(nm, "Fasteners", grams, "fastener", sp, vendor="McMaster-Carr", price=price, part_number=pn, link=f"https://www.mcmaster.com/{pn}/", source="library")
C = {}
C["m3x8"] = screw("M3", 8, "mm", "button head", "18-8 stainless steel", "passivated", 0.74, 0.11, "92095A181")
C["m3x12"] = screw("M3", 12, "mm", "socket head", "alloy steel", "black oxide", 1.12, 0.09, "91290A115")
C["m3x16"] = screw("M3", 16, "mm", "socket head", "alloy steel", "black oxide", 1.36, 0.10, "91290A120")
C["440"] = screw("#4-40", "5/16", "in", "button head", "18-8 stainless steel", "passivated", 0.58, 0.08, "92949A106", '5/16"')
C["m2x6"] = screw("M2", 6, "mm", "pan head", "18-8 stainless steel", "passivated", 0.19, 0.06, "92000A013")
C["m3nut"] = comp("M3 nylon-insert lock nut, 18-8 stainless steel", "Fasteners", 0.42, "fastener", {"type": "nut", "thread": "M3", "nut_type": "nylon-insert lock nut", "material": "18-8 stainless steel"}, vendor="McMaster-Carr", price=0.12, part_number="94645A101", source="library")
C["m3ins"] = comp("M3 × 4 mm heat-set insert, brass", "Fasteners", 0.31, "fastener", {"type": "insert", "thread": "M3", "nut_type": "heat-set insert", "length": 4, "length_unit": "mm", "material": "brass"}, vendor="McMaster-Carr", price=0.24, part_number="94180A331", source="library")
C["m3wash"] = comp("M3 flat washer, 18-8 stainless steel", "Fasteners", 0.11, "fastener", {"type": "washer", "thread": "M3", "washer_type": "flat washer", "material": "18-8 stainless steel", "od": 7}, vendor="McMaster-Carr", price=0.03, part_number="93475A210", source="library")
C["motor"] = comp("Repeat Mini Brushless Drive Motor", "Drive", 14.2, vendor="Repeat Robotics", price=24.99, source="measured", dims="22 × 30 mm", notes="1 lb drive · 2500 KV")
C["esc"] = comp("Repeat Dual Brushless ESC", "Electronics", 9.6, vendor="Repeat Robotics", price=39.99, source="measured")
C["wesc"] = comp("Repeat Mini Weapon ESC", "Electronics", 6.5, vendor="Repeat Robotics", price=29.99, source="measured")
C["rx"] = comp("FrSky XM+ receiver", "Electronics", 1.6, vendor="FrSky", price=15.99, source="measured")
C["bat"] = comp("3S 300 mAh LiPo (XT30)", "Electronics", 32.4, vendor="Tattu", price=12.99, source="measured", dims="55 × 17 × 19 mm")
C["sw"] = comp("Power switch + XT30 harness", "Electronics", 4.1, source="measured")
C["hub"] = comp("Repeat Hubmotor 1800 KV", "Weapon", 60.8, vendor="Repeat Robotics", price=54.99, source="measured")
C["wheel"] = comp("Foam wheel + printed hub", "Drive", 12.6, source="measured", notes="1.75 in foam, TPU hub")
C["brg"] = comp("MR63 bearing (3 × 6 × 2.5 mm)", "Drive", 0.9, vendor="McMaster-Carr", price=1.95, part_number="57155K323", source="library")
C["axle"] = comp("4 mm shoulder axle, hardened", "Drive", 3.8, source="measured", dims="4 × 38 mm")
C["standoff"] = comp("#8-32 × 1-1/2 in aluminum standoff", "Weapon", 2.8, "fastener", {"type": "standoff", "thread": "#8-32", "length": "1-1/2", "length_unit": "in", "shape": "round", "material": "aluminum"}, vendor="McMaster-Carr", price=1.40, part_number="93330A467", source="library")

# --- robot -----------------------------------------------------------------------------------------------------------
r = api("POST", "robots", {"name": "Pothos", "weight_class_g": 453.592, "class_name": "1 lb Plastic Antweight", "margin_g": 4.5, "printer_id": 1, "nozzle": 0.4,
                            "notes": "Vertical drum spinner · 3D-printed PLA chassis · Repeat drive"})
rid = r["id"]; S = {s["name"]: s["id"] for s in r["sections"]}
api("PUT", f"robots/{rid}", {"configs": [{"name": "Standard"}, {"name": "vs horizontal spinner"}]})
r = api("GET", f"robots/{rid}"); cfg = {c["name"]: c["id"] for c in r["configs"]}
def item(sec, desc=None, qty=1, comp_id=None, grams=None, purpose=None, status=None, measured=None, price=None, configs=None, to_buy=False, link=None):
    b = {"description": desc, "qty": qty, "component_id": comp_id, "est_grams": grams, "purpose": purpose, "status": status, "price": price, "to_buy": to_buy, "link": link}
    if measured is not None: b["measured_grams"] = measured
    it = api("POST", f"sections/{S[sec]}/items", {k: v for k, v in b.items() if v is not None})
    if configs: api("PUT", f"items/{it['id']}", {"configs": [cfg[c] for c in configs]})
    return it
item("Drive", comp_id=C["motor"], qty=2, purpose="Drive motors", status="have")
item("Drive", comp_id=C["esc"], qty=1, purpose="Drive ESC", status="have")
item("Drive", comp_id=C["wheel"], qty=2, purpose="Wheels", status="have")
item("Drive", comp_id=C["axle"], qty=2, status="have")
item("Drive", comp_id=C["brg"], qty=4, status="have")
item("Drive", comp_id=C["m3x8"], qty=6, purpose="Motor mounts", status="have")
item("Electrical", comp_id=C["bat"], qty=1, purpose="Battery", status="have")
item("Electrical", comp_id=C["rx"], qty=1, status="have")
item("Electrical", comp_id=C["wesc"], qty=1, purpose="Weapon ESC", status="have")
item("Electrical", comp_id=C["sw"], qty=1, status="have")
item("Weapon", comp_id=C["hub"], qty=1, purpose="Weapon motor", status="have")
item("Weapon", comp_id=C["standoff"], qty=1, purpose="Weapon axle", status="have")
item("Weapon", comp_id=C["m3x16"], qty=4, purpose="Drum clamp", status="ordered", to_buy=True)
item("Misc Hardware", comp_id=C["m3x12"], qty=8, purpose="Chassis top", status="have")
item("Misc Hardware", comp_id=C["m3nut"], qty=8, status="have")
item("Misc Hardware", comp_id=C["m3ins"], qty=12, purpose="Chassis inserts", status="have")
item("Misc Hardware", comp_id=C["m3wash"], qty=8, status="have")
item("Misc Hardware", comp_id=C["440"], qty=6, purpose="Fork pivots", status="have")
item("Misc Hardware", comp_id=C["m2x6"], qty=4, purpose="Receiver / ESC", status="have")
item("Misc Hardware", "Wire, connectors, heat-shrink", qty=1, grams=6.0, status="have")
item("Misc Hardware", "TPU front wedge (vs spinners)", qty=1, grams=38.0, purpose="Swap forks for a wedge against horizontals", status="printed", configs=["vs horizontal spinner"])
item("Spares", comp_id=C["m3x8"], qty=10, status="have")
item("Spares", comp_id=C["brg"], qty=2, status="have")

# --- printed parts ----------------------------------------------------------------------------------------------------
mid = {
    "chassis": mesh("b94f02ff04ba969e_pothos_small_body1.stl", "Chassis.stl"),
    "upright": mesh("9d726271556e91ae_pothos_small_body2.stl", "Stator Side Upright.stl"),
    "pod": mesh("4e309b33dfc50dfc_pothos_small_body3.stl", "Wheel Mounting Pod.stl"),
    "inner": mesh("ad46972b27d7b3b5_pothos_small_body4.stl", "Inner Fork.stl"),
    "outer": mesh("5364d3a52ed537cf_Planti_Drum_Parts_-_Left_AntiDrum_Forks_1.stl", "Outer Fork.stl"),
    "disk": mesh("73b8317d328711ba_disk.stl", "Drum Spacer.stl"),
}
def part(name, key, qty, profile, filament, role, print_=None, purpose=None, configs=None):
    p = api("POST", f"robots/{rid}/parts", {"name": name, "mesh_id": mid[key], "qty": qty, "profile_id": P[profile], "filament_id": filament, "role": role, "print": print_ or {}})
    if purpose or configs:
        b = {}
        if purpose: b["purpose"] = purpose
        if configs: b["configs"] = [cfg[c] for c in configs]
        api("PUT", f"items/{p['line_item_id']}", b)
    return p
parts = {}
parts["chassis"] = part("Chassis", "chassis", 1, "Chassis 5W/2T/4B/15%", PLAB, "structure", purpose="Main body, holds drive + battery")
parts["upright"] = part("Stator Side Upright", "upright", 1, "Chassis 5W/2T/4B/15%", PLAB, "structure", purpose="Weapon motor mount")
parts["pod"] = part("Wheel Mounting Pods", "pod", 2, "Light 2W/3T/3B/10%", PLAB, "structure", {"pair_mirror": "x"}, purpose="Left/right pair (mirrored)")
parts["inner"] = part("Inner Forks", "inner", 2, "Light 2W/3T/3B/10%", PETG, "armor", purpose="Anti-drum forks", configs=["Standard"])
parts["outer"] = part("Outer Forks", "outer", 2, "Chassis 5W/2T/4B/15%", PETG, "armor", {"supports": {"enabled": True, "type": "tree", "interface": "support_pla", "plate_only": True, "angle": 35}}, purpose="Outer forks, tree supports", configs=["Standard"])
parts["disk"] = part("Drum Spacer", "disk", 1, "Weapon solid 3W/100%", PLAB, "weapon", purpose="Weapon spacer, solid")
json.dump({"rid": rid, "cfg": cfg, "parts": {k: {"id": v["id"], "li": v["line_item_id"]} for k, v in parts.items()}, "S": S, "C": C}, open("/tmp/show/build/ids.json", "w"))
print("robot", rid, "parts", {k: v["id"] for k, v in parts.items()})
