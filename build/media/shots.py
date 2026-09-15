"""Take the README screenshots and annotate them. python3 shots.py [name ...]"""
import json, os, subprocess, sys
os.chdir("/tmp/show/build")
ENV = dict(os.environ, NODE_PATH="/opt/node-tools/node_modules")
OUT = "/home/claude/sb/docs/media"; os.makedirs(OUT, exist_ok=True)

SHOTS = {
    "sheet": dict(route="#/sheet", h=900, actions=[{"wait": 1200}],
        boxes={"budget": "#budget", "cfg": ".cfgbar", "best": ".hdr .stat:nth-child(1)", "over": ".hdr .stat:nth-child(3)",
               "add": "table.sheet input[placeholder^='Add to Drive']", "fix": "button:has-text('Fix weight')", "lib": "table.sheet tbody tr:has-text('MR63') .pill.cfg.lib, table.sheet tbody tr:has-text('MR63') .lib"},
        callouts=[
            ("budget", 1, "Always-on budget bar\nMeasured (dark) and estimated (light) mass against the class limit and your safety margin.", "bottom", dict(badge="l", bdx=-14)),
            ("cfg", 2, "Configurations\nLoadouts like “Standard” and “vs horizontal spinner”. A line can belong to some or all of them; every configuration must make weight.", "bottom", dict(dx=330, dy=130, width=330)),
            ("best", 3, "Best known\nYour scale wins where you have weighed something; everything else uses its estimate.", "bottom", dict(dx=0, dy=14, width=260)),
            ("add", 4, "Type to add a line\nThe component library autocompletes as you type; a fastener brings its weight, price and link along.", "bottom", dict(dx=60, dy=10, width=320)),
            ("fix", 5, "Over the limit?\n“Fix weight” hands the sheet to the optimizer.", "left", dict(dx=-8, dy=48, width=230)),
        ]),
    "sheet-printed": dict(route="#/sheet", h=900, actions=[{"wait": 1200}, {"eval": "(() => { const h = [...document.querySelectorAll('table.sheet tr')].find(t => /Printed Parts/i.test(t.textContent) && t.classList.contains('sec-h')) || [...document.querySelectorAll('table.sheet tr')].find(t => /PRINTED PARTS/.test(t.textContent)); h.scrollIntoView({block: 'start'}); window.scrollBy(0, -70); })()"}, {"wait": 500}],
        boxes={"row": "table.sheet tbody tr:has-text('Outer Fork.stl')", "est": "table.sheet tbody tr:has-text('Chassis.stl') td:nth-child(5)", "meas": "table.sheet tbody tr:has-text('Chassis.stl') td:nth-child(6)",
               "status": "table.sheet tbody tr:has-text('Drum Spacer') td:nth-child(10)", "tpu": "table.sheet tbody tr:has-text('TPU front wedge')"},
        callouts=[
            ("est", 1, "Sliced for real\nThe estimate is Bambu Studio’s own figure for this mesh, profile and filament — re-sliced whenever any of them change.", "left", dict(dx=-30, dy=-20, width=320)),
            ("meas", 2, "Weigh-ins\nEnter what the scale says after printing; it replaces the estimate and teaches the filament a correction factor.", "bottom", dict(dx=150, dy=70, width=300)),
            ("row", 3, "Supports and pairs are part of the line\nOuter Forks print with tree supports; Wheel Mounting Pods are a mirrored left/right pair on one line.", "bottom", dict(dx=650, dy=60, width=330)),
            ("tpu", 4, "Only in one configuration\nThe TPU wedge is greyed out here because the Standard loadout does not carry it.", "right", dict(dx=-330, dy=-12, width=300)),
        ]),
    "parts": dict(route="#/parts", w=1960, h=880, actions=[{"wait": 1000}],
        boxes={"drop": ".drop", "row": "table tbody tr:has-text('Outer Forks')", "slicer": "th:has-text('Slicer g')", "corr": "th:has-text('× corr.')",
               "upd": "th:has-text('Mesh updated')", "reslice": "button:has-text('Re-slice all')"},
        callouts=[
            ("drop", 1, "Drop your CAD exports here\nSTL, OBJ, PLY or a Bambu / Prusa 3MF — one file per part or the whole robot in one. A dialog matches each body to a new or existing part.", "bottom", dict(dx=1160, dy=36, width=360)),
            ("row", 2, "Supports, mirroring and pairs travel with the part\nTree supports with a Support-for-PLA interface here; the exported project carries them per object.", "top", dict(dx=560, dy=-70, width=330)),
            ("slicer", 3, "Real slicer grams\n“× corr.” applies the correction each filament learns from your weigh-ins.", "bottom", dict(dx=-300, dy=120, width=260)),
            ("upd", 4, "Timestamps\nWhen each mesh last changed, and when the current weight was sliced.", "bottom", dict(dx=-140, dy=330, width=240)),
        ]),
    "part": dict(route="#/part/1", w=1720, h=1290, actions=[{"wait": 6000}],
        boxes={"viewer": ".card:has(h3:has-text('Preview'))", "layer": ".card:has(h3:has-text('Layer view'))", "settings": ".card:has(h3:has-text('Print settings'))",
               "sweep": ".card.sweep", "printing": ".card:has(h3:has-text('Printing'))", "hist": ".card:has(h3:has-text('Mesh history'))"},
        callouts=[
            ("viewer", 1, "Orientation\nPresets, 90° turns, or pick a face and lay it on the bed. Every change re-slices the part.", "right", dict(dx=-380, dy=44, width=250)),
            ("layer", 2, "Layer view\nWalls, shells and infill layer by layer — a quick sanity check that the orientation makes sense before you print.", "right", dict(dx=-380, dy=300, width=340)),
            ("settings", 3, "Filament and profile\nCurrent slice, corrected weight, print time and cost update as you change them.", "left", dict(dx=-10, dy=412, width=340)),
            ("printing", 5, "Print prep\nSupports (with a dedicated interface material), mirrored parts and left/right pairs — written into the exported 3MF.", "left", dict(dx=-10, dy=100, width=340)),
            ("sweep", 4, "Every row is a real slice\nCompare profiles side by side, apply one to the part, and see when each result was sliced and whether it is for the current mesh.", "right", dict(dx=-410, dy=150, width=380)),
        ]),
    "optimizer": dict(route="#/optimizer/2", h=1700, actions=[{"wait": 1500}], crop_to=("results", -20, 14, 1240, 760),
        boxes={"results": "h3:has-text('Results')", "planA": ".plan.sel, .plan:first-child", "fits": ".plan .pill:has-text('fits')", "apply": "button:has-text('Apply to parts')",
               "table": "table:has(th:has-text('Configurations'))", "note": "p:has-text('Model predicted')"},
        callouts=[
            ("planA", 1, "Plans, not guesses\nEach plan is re-sliced for real before it appears — “confirmed” means the grams came from the slicer, not from a model.", "right", dict(dx=30, dy=0, width=320)),
            ("apply", 2, "One click to adopt\n“Apply to parts” writes the plan’s profiles onto the sheet.", "right", dict(dx=180, dy=-70, width=260)),
            ("table", 3, "Per part, per configuration\nParts shared by every configuration get one profile; configuration-specific parts may differ. The totals must fit everywhere.", "right", dict(dx=10, dy=10, width=330)),
            ("note", 4, "Model vs. reality\nThe fitted model predicted 226.8 g; the confirming slices came back at 227.6 g.", "right", dict(dx=340, dy=-80, width=290)),
        ]),
    "library": dict(route="#/library", h=900, actions=[{"wait": 1000}, {"click": "button:has-text('Fasteners')"}, {"wait": 600}],
        boxes={"row": "table tbody tr:has-text('socket head screw')", "used": "th:has-text('Used')", "fast": "button:has-text('Fastener…')", "specs": "th:has-text('Specs')"},
        callouts=[
            ("fast", 1, "Fasteners with real specs\nThread, length, head, drive, material — McMaster-style. The label and a weight estimate come from the specs; duplicate one to make the next length.", "bottom", dict(dx=-560, dy=-8, width=340)),
            ("row", 2, "Shared across robots\nMeasure a component once; every sheet that uses it updates.", "bottom", dict(dx=300, dy=14, width=280)),
            ("used", 3, "Where it is used\nWhich robots carry the component and how many, straight from their sheets.", "bottom", dict(dx=-70, dy=240, width=260)),
        ]),
    "home": dict(route="#/", h=760, actions=[{"wait": 1000}], crop=[200, 50, 1240, 420],
        boxes={"card": ".rcard:nth-child(2)", "cfg": ".rcard:first-child .mini, .rcard:first-child .bar", "new": "button:has-text('New robot')"},
        callouts=[
            ("card", 1, "One card per robot\nA budget bar for every configuration, how much of the mass is measured, the printed-part budget, last weigh-in and optimizer run.", "right", dict(dx=30, dy=40, width=340)),
        ]),
}


def run(name):
    sp = SHOTS[name]
    raw = f"raw/{name}.png"
    opts = {"w": sp.get("w", 1440), "h": sp.get("h", 900), "actions": sp.get("actions", []), "boxes": sp.get("boxes", {}), "full": sp.get("full", False)}
    r = subprocess.run(["node", "rig.js", "shot", sp["route"], raw, json.dumps(opts)], env=ENV, capture_output=True, text=True)
    print(name, r.stdout.strip()[-200:], r.stderr.strip()[-300:])
    boxes = json.load(open(raw.replace(".png", ".boxes.json")))
    spec = {"scale": 2, "callouts": [], "downscale": sp.get("downscale", 1.0), "style": "markers"}
    legend = []
    if sp.get("crop_to"):
        key, dx, dy, w, hh = sp["crop_to"]
        b = boxes.get(key)
        if b:
            x0 = max(0, int(b["x"] + dx)); x0 = min(x0, sp.get("w", 1440) - w)
            spec["crop"] = [x0, max(0, int(b["y"] - dy)), w, hh]
    if sp.get("crop"):
        spec["crop"] = sp["crop"]
    for co in sp["callouts"]:
        key, n, text, at, extra = co[:5]
        b = boxes.get(key)
        if not b:
            print("  missing box", key); continue
        spec["callouts"].append({"n": n, "box": [b["x"], b["y"], b["width"], b["height"]], "text": text, "at": at, **extra})
        title, _, body = text.partition("\n")
        legend.append((n, title, body))
    legend.sort()
    md = "\n".join(f"{n}. **{t}** — {b}" for n, t, b in legend)
    open(f"{OUT}/{name}.legend.md", "w").write(md + "\n")
    json.dump(spec, open(f"raw/{name}.spec.json", "w"))
    subprocess.run(["python3", "annotate.py", raw, f"{OUT}/{name}-annotated.png", f"raw/{name}.spec.json"], check=True)
    from PIL import Image
    im = Image.open(f"{OUT}/{name}-annotated.png").convert("RGB")
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f"{OUT}/{name}-annotated.png", optimize=True)


if __name__ == "__main__":
    names = sys.argv[1:] or list(SHOTS)
    for n in names:
        run(n)
