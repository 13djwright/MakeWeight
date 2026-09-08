# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Target-weight optimizer: real anchor slices -> per-part model -> search -> confirm with real slices."""
from __future__ import annotations

import itertools
import json
import threading
import time
import traceback
from pathlib import Path

import numpy as np

from . import estimator, meshio, orient, profiles
from .db import loads, now

DEFAULT_RANGES = {"walls": [2, 5], "top": [3, 5], "bottom": [3, 5], "infill": [8, 40]}
ROLE_WEIGHT = {"weapon": 1.0, "armor": 1.0, "structure": 0.8, "internal": 0.5, "cosmetic": 0.2}
ROLE_PRIORITY = ["armor", "weapon", "structure", "internal", "cosmetic"]
ROLE_INFILL_OFFSET = {"armor": 8.0, "weapon": 8.0, "structure": 0.0, "internal": -6.0, "cosmetic": -10.0}
_ACTIVE: dict[int, "Optimization"] = {}


def start_optimization(app, rid: int, body: dict) -> int:
    run_id = app.db.insert("runs", {"robot_id": rid, "kind": "optimize", "date": now(), "status": "running",
                                    "name": body.get("name") or ("Target weight · single part" if body.get("mode") == "single" else f"Optimize · {body.get('strategy', 'per_role')}"),
                                    "inputs_json": json.dumps(body), "results_json": json.dumps({"status_text": "starting", "plans": []})})
    opt = Optimization(app, rid, run_id, body)
    _ACTIVE[run_id] = opt
    threading.Thread(target=opt.run, daemon=True, name=f"optimize-{run_id}").start()
    return run_id


def cancel(app, run_id: int):
    opt = _ACTIVE.get(run_id)
    if opt:
        opt.cancelled = True
    app.jobs.cancel_queued(run_id=run_id)
    app.db.update("runs", run_id, {"status": "cancelled"})


def apply_plan(app, run_id: int, plan_index: int) -> dict:
    db = app.db
    run = db.get("runs", run_id)
    res = loads(run["results_json"], {})
    plans = res.get("plans", [])
    if plan_index >= len(plans):
        raise ValueError("no such plan")
    plan = plans[plan_index]
    for a in plan["assignments"]:
        if a.get("locked") or not a.get("params"):
            continue
        params = profiles.normalize(a["params"])
        ph = profiles.profile_hash(params)
        prof = None
        for row in db.q("SELECT * FROM profiles"):
            if profiles.profile_hash(profiles.normalize(loads(row["params_json"], {}))) == ph:
                prof = row; break
        if not prof:
            pid = db.insert("profiles", {"name": profiles.profile_string(params), "printer_id": None, "nozzle": params["nozzle"],
                                         "params_json": json.dumps(params), "builtin": 0, "notes": f"Created by optimizer run #{run_id}"})
            prof = db.get("profiles", pid)
        db.update("printed_parts", a["part_id"], {"profile_id": prof["id"]})
        p = db.get("printed_parts", a["part_id"])
        if p and p.get("line_item_id") and db.one("SELECT 1 FROM weigh_ins WHERE line_item_id=?", [p["line_item_id"]]):
            db.update("line_items", p["line_item_id"], {"needs_reweigh": 1})
        app.current_slice_for_part(a["part_id"], priority=2)
    res["applied_plan"] = plan_index
    db.update("runs", run_id, {"results_json": json.dumps(res)})
    return app.robot_detail(run["robot_id"])


class PartModel:
    def __init__(self, item: dict, part: dict, mesh: dict, filament: dict, base_params: dict, ranges: dict):
        self.item = item; self.part = part; self.mesh = mesh; self.filament = filament
        self.base = base_params; self.ranges = ranges
        self.qty = float(item["qty"] or 1)
        self.corr = (loads(filament.get("correction_json"), {}).get("factor") or 1.0)
        self.role = part.get("role") or "structure"
        self.model = None  # FittedModel or GridModel
        self.anchors: dict[tuple, float] = {}
        self.cfgs: set = set()          # configuration ids this line is in (see Optimization.configs)

    def params_for(self, W: int, s: int, d: float) -> dict:
        p = dict(self.base)
        p["walls"] = int(W)
        p["top"] = int(min(max(s, self.ranges["top"][0]), self.ranges["top"][1]))
        p["bottom"] = int(min(max(s, self.ranges["bottom"][0]), self.ranges["bottom"][1]))
        p["infill"] = float(d)
        return profiles.normalize(p)

    def tb(self, s):
        return (int(min(max(s, self.ranges["top"][0]), self.ranges["top"][1])), int(min(max(s, self.ranges["bottom"][0]), self.ranges["bottom"][1])))

    def s_range(self):
        lo = min(self.ranges["top"][0], self.ranges["bottom"][0]); hi = max(self.ranges["top"][1], self.ranges["bottom"][1])
        return list(range(int(lo), int(hi) + 1))

    def w_range(self):
        return list(range(int(self.ranges["walls"][0]), int(self.ranges["walls"][1]) + 1))

    def predict(self, W, s, d) -> float:
        """Scale grams (slicer x correction) for one unit."""
        T, B = self.tb(s)
        return self.model.predict(W, T, B, d) * self.corr

    def line(self, W, s):
        """(a, b): grams = a + b*d for one unit, in scale grams."""
        T, B = self.tb(s)
        f0 = self.model.predict(W, T, B, 0.0) * self.corr
        f1 = self.model.predict(W, T, B, 100.0 if isinstance(self.model, GridModel) else 50.0) * self.corr
        span = 100.0 if isinstance(self.model, GridModel) else 50.0
        return f0, (f1 - f0) / span


class GridModel:
    """Piecewise-linear interpolation in infill over real slices at a grid of (W,T,B)."""

    def __init__(self):
        self.points: dict[tuple, list[tuple[float, float]]] = {}

    def add(self, W, T, B, d, grams):
        self.points.setdefault((W, T, B), []).append((float(d), float(grams)))

    def predict(self, W, T, B, d) -> float:
        pts = sorted(self.points.get((W, T, B), []))
        if not pts:
            raise KeyError((W, T, B))
        if len(pts) == 1:
            return pts[0][1]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        return float(np.interp(d, xs, ys, left=None, right=None)) if xs[0] <= d <= xs[-1] else float(ys[0] + (ys[-1] - ys[0]) / (xs[-1] - xs[0]) * (d - xs[0]))


class Optimization:
    def __init__(self, app, rid: int, run_id: int, body: dict):
        self.app = app; self.db = app.db; self.rid = rid; self.run_id = run_id; self.body = body
        self.cancelled = False
        self.res: dict = {"status_text": "starting", "plans": [], "pareto": []}
        self.strategy = body.get("strategy") or "per_role"
        self.mode_model = body.get("model") or "anchored"
        self.alpha = float(body.get("rank", 25)) / 100.0
        self.n_plans = int(body.get("n_plans") or 5)
        self.configs: list[dict] = [{"id": None, "name": ""}]
        self.budgets: dict = {}; self.fixed_g: dict = {}; self.fixed_items: list = []

    # ------------------------------------------------------------ plumbing
    def save(self, text: str | None = None, status: str | None = None):
        if text:
            self.res["status_text"] = text
        upd = {"results_json": json.dumps(self.res, default=float)}
        if status:
            upd["status"] = status
        self.db.update("runs", self.run_id, upd)
        self.app.events.emit("run", {"run_id": self.run_id, "robot_id": self.rid, "status_text": self.res.get("status_text")})
        self.app.events.emit("job", {"job": {"run_id": self.run_id}})

    def check_cancel(self):
        if self.cancelled or (self.db.get("runs", self.run_id) or {}).get("status") == "cancelled":
            raise InterruptedError("cancelled")

    def wait_jobs(self, job_ids: list[int], label: str):
        ids = list(dict.fromkeys(job_ids))
        while True:
            self.check_cancel()
            rows = self.db.q(f"SELECT id, status, grams, error FROM slice_jobs WHERE id IN ({','.join('?' * len(ids))})", ids) if ids else []
            done = [r for r in rows if r["status"] in ("done", "error", "cancelled")]
            if len(done) >= len(ids):
                return {r["id"]: r for r in rows}
            self.save(f"{label}: {len(done)} of {len(ids)} slices done")
            time.sleep(1.0)

    def slice(self, pm: PartModel, params: dict, purpose: str, priority: int) -> dict:
        return self.app.jobs.ensure_slice(pm.part, params, pm.filament, purpose=purpose, priority=priority, run_id=self.run_id)

    # ------------------------------------------------------------ main
    def run(self):
        try:
            self._run()
            self.save("done", status="done")
        except InterruptedError:
            self.save("cancelled", status="cancelled")
        except Exception as e:  # noqa
            traceback.print_exc()
            self.res["error"] = str(e)
            self.save("error: " + str(e), status="error")
        finally:
            _ACTIVE.pop(self.run_id, None)

    def _run(self):
        det = self.app.robot_detail(self.rid)
        robot = det
        single = self.body.get("mode") == "single"
        # Configurations: a plan must make weight in *every* loadout. A line shared by several configurations gets one
        # profile (the same physical part is printed once); a line that is only in some of them is free to differ.
        cfg_rows = det.get("configs") or []
        if single or not cfg_rows:
            cfg_rows = [{"id": None, "name": robot["name"]}]
        self.configs = [{"id": c["id"], "name": c.get("name") or "?"} for c in cfg_rows]
        cids = [c["id"] for c in self.configs]

        def member(it, cid):
            cj = it.get("configs")
            return cid is None or cj is None or cid in cj

        items = []
        for sec in det["sections"]:
            for it in sec["items"]:
                if not (sec["counts"] and it.get("counted", True)):
                    continue
                it["_cfgs"] = {cid for cid in cids if member(it, cid)}
                if it["_cfgs"]:
                    items.append(it)
        free: list[PartModel] = []
        fixed_g = {cid: 0.0 for cid in cids}          # locked / mesh-less printed parts, per configuration
        non_printed = {cid: 0.0 for cid in cids}
        why = []
        locked_g = 0.0
        fixed_items = []
        for it in items:
            p = it.get("part")
            if not p:
                for cid in it["_cfgs"]:
                    non_printed[cid] += it["total_grams"]
                continue
            is_target = single and p["id"] == self.body.get("part_id")
            if single and not is_target:
                continue
            if p["locked"] or not p.get("mesh") or not p.get("profile") or not p.get("filament"):
                for cid in it["_cfgs"]:
                    fixed_g[cid] += it["total_grams"]
                fixed_items.append(it)
                if p["locked"]:
                    locked_g += it["total_grams"]
                elif not p.get("mesh"):
                    why.append({"title": "No mesh", "text": f"{it['description']} has no STL attached; it counts as its sheet weight ({it['total_grams']:.1f} g)."})
                continue
            row = self.db.get("printed_parts", p["id"])
            mesh = self.db.get("meshes", row["mesh_id"]); fil = self.db.get("filaments", row["filament_id"])
            base = profiles.normalize(p["profile"]["params"])
            ranges = {k: list(v) for k, v in DEFAULT_RANGES.items()}
            for k, v in (p.get("constraints") or {}).items():
                if k in ranges and isinstance(v, list) and len(v) == 2 and v[0] is not None and v[1] is not None:
                    ranges[k] = [min(v), max(v)]
            pm = PartModel(it, row, mesh, fil, base, ranges)
            pm.cfgs = set(it["_cfgs"])
            free.append(pm)
        if not free:
            raise RuntimeError("No unlocked printed parts with a mesh to optimize")
        self.fixed_items = fixed_items
        margin = float(self.body.get("margin_g", robot["margin_g"] or 0))
        if single:
            b = float(self.body.get("target_g") or 0) * free[0].qty
            budgets = {cid: b for cid in cids}
            self.res["budget_g"] = b
            self.res["budget_total_g"] = b
        else:
            budgets = {cid: robot["weight_class_g"] - margin - non_printed[cid] - fixed_g[cid] for cid in cids}
            self.res["budget_g"] = min(budgets.values())
            self.res["budget_total_g"] = min(budgets[cid] + fixed_g[cid] for cid in cids)
            self.res["non_printed_g"] = max(non_printed.values()); self.res["fixed_printed_g"] = max(fixed_g.values())
        self.budgets = budgets; self.fixed_g = fixed_g
        self.res["configs"] = [{"id": c["id"], "name": c["name"], "budget_g": budgets[c["id"]] + fixed_g[c["id"]], "non_printed_g": non_printed[c["id"]],
                                "fixed_printed_g": fixed_g[c["id"]], "n_parts": sum(1 for pm in free if c["id"] in pm.cfgs)} for c in self.configs]
        self.res["multi_config"] = len(self.configs) > 1
        self.res["roles"] = sorted({pm.role for pm in free})
        shared = [pm for pm in free if len(pm.cfgs) == len(cids)]
        if len(self.configs) > 1:
            self.res["config_note"] = (f"{len(shared)} part{'s' if len(shared) != 1 else ''} shared by every configuration get one profile; "
                                       f"{len(free) - len(shared)} configuration-specific part{'s' if len(free) - len(shared) != 1 else ''} may differ. Every plan shown makes weight in all {len(self.configs)} configurations.")
        budget = budgets  # dict per configuration from here on
        if locked_g:
            why.insert(0, {"title": "Locked", "text": f"{locked_g:.1f} g of locked printed parts cannot move."})
        # current plan for comparison
        cur = self.totals(free, {pm.part["id"]: None for pm in free}, lambda pm, _a: pm.item["total_grams"] / max(pm.qty, 1e-9))
        self.res["current"] = self.fit_view(cur, fixed_g, budget)

        # ---- stage 1: anchors / grid
        self.save("queueing anchor slices")
        job_map: dict[int, tuple[PartModel, tuple]] = {}
        for pm in free:
            W0, W1 = pm.w_range()[0], pm.w_range()[-1]
            s0, s1 = pm.s_range()[0], pm.s_range()[-1]
            d0, d1 = pm.ranges["infill"]
            if self.mode_model == "grid":
                combos = [(W, s, d) for W in pm.w_range() for s in pm.s_range() for d in sorted({d0, (d0 + d1) / 2, d1})]
            else:
                Wm, sm, dm = round((W0 + W1) / 2), round((s0 + s1) / 2), (d0 + d1) / 2
                combos = [(W0, s0, d0), (W1, s0, d0), (W0, s1, d0), (W0, s0, d1), (W1, s1, d1), (Wm, sm, dm), (W1, s0, d1)]
                cw, ct, cd = pm.base["walls"], pm.base["top"], pm.base["infill"]
                if W0 <= cw <= W1 and d0 <= cd <= d1:
                    combos.append((cw, ct, cd))
            for c in dict.fromkeys(combos):
                job = self.slice(pm, pm.params_for(*c), "anchor", 4)
                job_map[job["id"]] = (pm, c)
        rows = self.wait_jobs(list(job_map.keys()), "anchor slices")
        for jid, (pm, c) in job_map.items():
            r = rows.get(jid)
            if r and r["status"] == "done" and r["grams"] is not None:
                pm.anchors[c] = r["grams"]
        # ---- stage 2: models
        self.save("fitting models")
        reports = []
        for pm in free:
            self.check_cancel()
            if len(pm.anchors) < 3:
                raise RuntimeError(f"Not enough successful anchor slices for {pm.item['description']} (slicer errors?)")
            if self.mode_model == "grid":
                gm = GridModel()
                for (W, s, d), g in pm.anchors.items():
                    T, B = pm.tb(s); gm.add(W, T, B, d, g)
                pm.model = gm
                reports.append(f"{pm.item['description']}: grid of {len(pm.anchors)} real slices")
            else:
                tri = self.app.preview_mesh(pm.mesh)          # the region model is a coarse voxel picture; decimated is plenty
                t = orient.apply_orientation(tri, loads(pm.part["orient_json"], {}), float(pm.part.get("scale") or 1.0), bool(pm.part.get("mirror")))
                rm = estimator.RegionModel(t, pm.base)
                fm = estimator.FittedModel(rm, float(pm.filament["density"]), float(pm.filament.get("flow") or 1.0))
                anchors = []
                for (W, s, d), g in pm.anchors.items():
                    T, B = pm.tb(s); anchors.append(((W, T, B, d), g))
                fm.fit(anchors)
                pm.model = fm
                reports.append(f"{pm.item['description']}: {len(anchors)} anchors, fit rms {fm.rms_err * 100:.1f}%, coef {np.round(fm.coef, 2).tolist()}")
        self.res["model_report"] = "; ".join(reports)

        # ---- stage 3 + 4: search, confirm, refine
        prev_worst = None
        for round_no in range(3):
            self.check_cancel()
            self.save(f"searching (round {round_no + 1})")
            cands = self.search(free, budget)
            plans = self.select(cands, free)
            self.res["plans"] = [self.plan_view(pl, free, fixed_g, budget) for pl in plans]
            self.res["pareto"] = self.pareto_view(cands, plans, free, fixed_g)
            self.res["why"] = why + self.why_not_lighter(free, budget, locked_g)
            self.save("confirming plans with real slices")
            worst = self.confirm(plans, free, fixed_g, budget)
            if worst <= 0.015 or self.mode_model == "grid" or (prev_worst is not None and worst >= prev_worst - 0.002):
                break
            prev_worst = worst
            # refit with the confirmed points as extra anchors
            for pm in free:
                if isinstance(pm.model, estimator.FittedModel):
                    anchors = [((W, *pm.tb(s), d), g) for (W, s, d), g in pm.anchors.items()]
                    pm.model.fit(anchors)
            self.res["model_report"] += f" · round {round_no + 1}: worst confirm miss {worst * 100:.1f}%, refit"
        self.res["plans"].sort(key=lambda p: (not p["fits"], -p["score"] if p["fits"] else p["total_g"]))
        for i, p in enumerate(self.res["plans"]):
            p["name"] = f"{chr(65 + i)} · {p['label']}"
        for pp in self.res["pareto"]:
            pp["label"] = next((p["name"].split(" ")[0] for p in self.res["plans"] if p.get("full") == pp.get("full")), None)
            pp["shown"] = pp["label"] is not None

    # ------------------------------------------------------------ search
    def totals(self, free, assign: dict, grams_fn) -> dict:
        """Free-part grams per configuration: {cid: total}. grams_fn(pm, assign[pid]) -> grams for one unit."""
        out = {c["id"]: 0.0 for c in self.configs}
        for pm in free:
            g = grams_fn(pm, assign[pm.part["id"]]) * pm.qty
            for cid in pm.cfgs:
                out[cid] += g
        return out

    def fit_view(self, totals: dict, fixed_g: dict, budget: dict) -> dict:
        """Per-configuration totals incl. fixed parts, overall fits/slack (worst configuration) and the heaviest total."""
        per = []
        for c in self.configs:
            cid = c["id"]; t = totals[cid] + fixed_g[cid]; sl = budget[cid] - totals[cid]
            per.append({"id": cid, "name": c["name"], "total_g": t, "slack_g": sl, "fits": sl >= -1e-6})
        worst = min(per, key=lambda x: x["slack_g"])
        return {"total_g": max(x["total_g"] for x in per), "slack_g": worst["slack_g"], "fits": all(x["fits"] for x in per), "per_config": per,
                "worst_config": worst["name"] if len(per) > 1 else None}

    def candidate(self, free, assign: dict[int, tuple], budget: dict) -> dict:
        """assign: part_id -> (W, s, d). Fits only if every configuration makes weight; slack is the tightest one."""
        score = 0.0; norm = 0.0
        tot = self.totals(free, assign, lambda pm, a: pm.predict(*a))
        for pm in free:
            W, s, d = assign[pm.part["id"]]
            w = ROLE_WEIGHT.get(pm.role, 0.6) * pm.qty
            wr, sr, dr = pm.w_range(), pm.s_range(), pm.ranges["infill"]
            wn = (W - wr[0]) / max(1, wr[-1] - wr[0]); sn = (s - sr[0]) / max(1, sr[-1] - sr[0]); dn = (d - dr[0]) / max(1e-6, dr[1] - dr[0])
            score += w * ((1 - self.alpha) * (0.8 * wn + 0.2 * sn) + self.alpha * dn); norm += w
        slack = min(budget[cid] - tot[cid] for cid in tot)
        return {"assign": assign, "total_g": max(tot.values()), "totals": tot, "score": score / norm if norm else 0.0, "fits": slack >= -1e-6, "slack_g": slack,
                "key": tuple((pid, a[0], a[1]) for pid, a in sorted(assign.items()))}

    def solve_shared_d(self, free, ws: dict[int, tuple], budget: dict, offsets: dict[str, float] | None = None):
        """Common infill % (plus an optional per-role offset) so that the tightest configuration lands on its budget for
        fixed (W,s) per part; whole percent, rounded down, clamped to the parts' ranges. None when even the minimum is over."""
        lines = {}
        for pm in free:
            W, s = ws[pm.part["id"]]
            lines[pm.part["id"]] = pm.line(W, s)
        offs = offsets or {}

        def d_of(pm, base):
            lo, hi = pm.ranges["infill"]
            return float(min(max(base + offs.get(pm.role, 0.0), lo), hi))

        def total(cid, base):
            return sum((lines[pm.part["id"]][0] + lines[pm.part["id"]][1] * d_of(pm, base)) * pm.qty for pm in free if cid in pm.cfgs)

        lo = min(pm.ranges["infill"][0] for pm in free) - max([abs(v) for v in offs.values()] + [0.0])
        hi = max(pm.ranges["infill"][1] for pm in free) + max([abs(v) for v in offs.values()] + [0.0])
        if any(total(cid, lo) > budget[cid] + 1e-6 for cid in budget):
            return None
        # totals rise with infill: bisect the largest base that still fits every configuration
        a, b = lo, hi
        if all(total(cid, hi) <= budget[cid] + 1e-6 for cid in budget):
            a = hi
        else:
            for _ in range(40):
                m = (a + b) / 2
                if all(total(cid, m) <= budget[cid] + 1e-6 for cid in budget):
                    a = m
                else:
                    b = m
        base = float(np.floor(a))
        return {pm.part["id"]: d_of(pm, base) for pm in free}

    def search(self, free, budget) -> list[dict]:
        cands: list[dict] = []
        pid = lambda pm: pm.part["id"]  # noqa
        d_lo = max(pm.ranges["infill"][0] for pm in free); d_hi = min(pm.ranges["infill"][1] for pm in free)
        d_grid = sorted(set([float(d_lo), float(d_hi)] + [float(round(x)) for x in np.arange(d_lo, d_hi + 0.01, max(2.0, (d_hi - d_lo) / 6))]))

        def add_ws(ws, offsets=None):
            sol = self.solve_shared_d(free, ws, budget, offsets)
            outs = []
            if sol is not None:
                outs.append(self.candidate(free, {pm.part["id"]: (ws[pm.part["id"]][0], ws[pm.part["id"]][1], sol[pm.part["id"]]) for pm in free}, budget))
            for dd in d_grid:
                assign = {}
                for pm in free:
                    lo, hi = pm.ranges["infill"]
                    assign[pm.part["id"]] = (ws[pm.part["id"]][0], ws[pm.part["id"]][1], float(min(max(dd + (offsets or {}).get(pm.role, 0.0), lo), hi)))
                outs.append(self.candidate(free, assign, budget))
            cands.extend(outs)

        if self.strategy == "uniform":
            Ws = sorted(set.intersection(*[set(pm.w_range()) for pm in free])) or sorted(set(free[0].w_range()))
            Ss = sorted(set.intersection(*[set(pm.s_range()) for pm in free])) or sorted(set(free[0].s_range()))
            for W in Ws:
                for s in Ss:
                    add_ws({pid(pm): (W, s) for pm in free})
        elif self.strategy == "per_role":
            roles = sorted({pm.role for pm in free}, key=lambda r: ROLE_PRIORITY.index(r) if r in ROLE_PRIORITY else 9)
            opts = {}
            for r in roles:
                members = [pm for pm in free if pm.role == r]
                Ws = sorted(set.intersection(*[set(pm.w_range()) for pm in members])) or members[0].w_range()
                Ss = sorted(set.intersection(*[set(pm.s_range()) for pm in members])) or members[0].s_range()
                opts[r] = [(W, s) for W in Ws for s in Ss]
            combos = list(itertools.product(*[opts[r] for r in roles]))
            if len(combos) > 4000:  # coarsen shells
                for r in roles:
                    ss = sorted({o[1] for o in opts[r]}); keep = {ss[0], ss[-1]}
                    opts[r] = [o for o in opts[r] if o[1] in keep]
                combos = list(itertools.product(*[opts[r] for r in roles]))
            for combo in combos[:6000]:
                ws = {}
                for r, (W, s) in zip(roles, combo):
                    for pm in free:
                        if pm.role == r:
                            ws[pid(pm)] = (W, s)
                add_ws(ws)
                if len(roles) > 1:      # armor/weapon denser than structure, internals and cosmetics sparser
                    add_ws(ws, ROLE_INFILL_OFFSET)
        elif self.strategy in ("priority", "trim"):
            order = sorted(free, key=lambda pm: ROLE_PRIORITY.index(pm.role) if pm.role in ROLE_PRIORITY else 9)
            if self.strategy == "priority":
                state = {pid(pm): [pm.w_range()[0], pm.s_range()[0], float(pm.ranges["infill"][0])] for pm in free}
            else:
                state = {}
                for pm in free:
                    W = min(max(pm.base["walls"], pm.w_range()[0]), pm.w_range()[-1]); s = min(max(max(pm.base["top"], pm.base["bottom"]), pm.s_range()[0]), pm.s_range()[-1])
                    d = min(max(pm.base["infill"], pm.ranges["infill"][0]), pm.ranges["infill"][1])
                    state[pid(pm)] = [W, s, float(d)]
            def snap(): return {k: tuple(v) for k, v in state.items()}
            c = self.candidate(free, snap(), budget); cands.append(c)
            if self.strategy == "priority":
                # spend grams: walls on high-priority roles first, then shells, then infill
                improved = True
                while improved:
                    improved = False
                    for pm in order:
                        for idx, hi in ((0, pm.w_range()[-1]), (1, pm.s_range()[-1])):
                            st = state[pid(pm)]
                            if st[idx] < hi:
                                st[idx] += 1
                                c = self.candidate(free, snap(), budget)
                                if c["fits"]:
                                    cands.append(c); improved = True
                                else:
                                    st[idx] -= 1
                    for pm in order:
                        st = state[pid(pm)]
                        if st[2] + 2 <= pm.ranges["infill"][1]:
                            st[2] += 2
                            c = self.candidate(free, snap(), budget)
                            if c["fits"]:
                                cands.append(c); improved = True
                            else:
                                st[2] -= 2
            else:  # trim: remove grams from low-priority roles first
                rev = list(reversed(order))
                guard = 0
                while not self.candidate(free, snap(), budget)["fits"] and guard < 2000:
                    guard += 1; moved = False
                    for pm in rev:
                        st = state[pid(pm)]
                        if st[2] - 1 >= pm.ranges["infill"][0]:
                            st[2] -= 1; moved = True; cands.append(self.candidate(free, snap(), budget)); break
                    if moved:
                        continue
                    for pm in rev:
                        st = state[pid(pm)]
                        if st[1] > pm.s_range()[0]:
                            st[1] -= 1; moved = True; cands.append(self.candidate(free, snap(), budget)); break
                    if moved:
                        continue
                    for pm in rev:
                        st = state[pid(pm)]
                        if st[0] > pm.w_range()[0]:
                            st[0] -= 1; moved = True; cands.append(self.candidate(free, snap(), budget)); break
                    if not moved:
                        break
                cands.append(self.candidate(free, snap(), budget))
            # add a uniform sweep too so the Pareto cloud has context
            Ws = sorted(set.intersection(*[set(pm.w_range()) for pm in free])) or free[0].w_range()
            Ss = sorted(set.intersection(*[set(pm.s_range()) for pm in free])) or free[0].s_range()
            for W in Ws:
                for s in Ss:
                    add_ws({pid(pm): (W, s) for pm in free})
        return cands

    def select(self, cands: list[dict], free) -> list[dict]:
        fits = [c for c in cands if c["fits"]]
        fits.sort(key=lambda c: (-c["score"], -c["total_g"]))
        weights = {pm.part["id"]: ROLE_WEIGHT.get(pm.role, 0.6) * pm.qty for pm in free}

        def dist(a, b):
            d = 0.0
            for pid, w in weights.items():
                A, B = a["assign"][pid], b["assign"][pid]
                d += w * (abs(A[0] - B[0]) + 0.5 * abs(A[1] - B[1]) + abs(A[2] - B[2]) / 10.0)
            return d / max(1e-6, sum(weights.values()))

        picked = []
        for c in fits:
            if all(dist(c, p) >= 0.6 for p in picked):
                picked.append(c)
            if len(picked) >= self.n_plans:
                break
        if len(picked) < self.n_plans:  # relax if the space is small
            for c in fits:
                if c not in picked and all(dist(c, p) > 0 for p in picked):
                    picked.append(c)
                if len(picked) >= self.n_plans:
                    break
        if not picked and cands:
            cands.sort(key=lambda c: c["total_g"])
            picked = cands[:min(3, len(cands))]
        return picked

    def plan_view(self, c: dict, free, fixed_g: float, budget: float) -> dict:
        assigns = []
        for pm in free:
            W, s, d = c["assign"][pm.part["id"]]
            params = pm.params_for(W, s, d)
            assigns.append({"part_id": pm.part["id"], "name": pm.item["description"], "qty": pm.qty, "params": params, "profile_string": profiles.profile_string(params),
                            "role": pm.role, "grams": None, "model_grams": pm.predict(W, s, d), "status": "pending", "locked": False, "configs": self._cfg_names(pm.cfgs)})
        if self.body.get("mode") != "single":
            for it in self.fixed_items:
                assigns.append({"part_id": it["part"]["id"], "name": it["description"], "qty": it["qty"], "params": None, "profile_string": it["part"]["profile"]["string"] if it["part"].get("profile") else "",
                                "grams": it["best_grams"], "status": "fixed", "locked": True, "configs": self._cfg_names(it["_cfgs"])})
        summary = self.summarize(c, free)
        label = self.label_for(c, free)
        fv = self.fit_view(c["totals"], fixed_g, budget)
        return {"name": label, "label": label, "key": [list(k) for k in c["key"]], "full": [[k] + list(v) for k, v in sorted(c["assign"].items())], "assignments": assigns,
                "total_g": fv["total_g"], "model_total_g": fv["total_g"], "per_config": fv["per_config"], "worst_config": fv["worst_config"],
                "slack_g": fv["slack_g"], "fits": fv["fits"], "score": c["score"], "summary": summary, "status": "confirming", "locked_g": sum(a["grams"] * a["qty"] for a in assigns if a["locked"] and a["grams"] is not None)}

    def _cfg_names(self, cfgs) -> list | None:
        """None when the part is in every configuration (or there is only one), else the names it belongs to."""
        if len(self.configs) <= 1 or len(cfgs) == len(self.configs):
            return None
        return [c["name"] for c in self.configs if c["id"] in cfgs]

    def summarize(self, c: dict, free) -> list[str]:
        by_role: dict[str, set] = {}
        for pm in free:
            W, s, d = c["assign"][pm.part["id"]]
            T, B = pm.tb(s)
            by_role.setdefault(pm.role, set()).add(f"{W}W · {T}T/{B}B · {d:g}%")
        out = []
        for role in sorted(by_role, key=lambda r: ROLE_PRIORITY.index(r) if r in ROLE_PRIORITY else 9):
            vals = sorted(by_role[role])
            out.append(f"{role.capitalize()}: {vals[0]}" if len(vals) == 1 else f"{role.capitalize()}: {' / '.join(vals)}")
        return out

    def label_for(self, c: dict, free) -> str:
        maxw = all(c["assign"][pm.part["id"]][0] == pm.w_range()[-1] for pm in free if pm.role == "armor") and any(pm.role == "armor" for pm in free)
        minw = all(c["assign"][pm.part["id"]][0] == pm.w_range()[0] for pm in free)
        ds = [c["assign"][pm.part["id"]][2] for pm in free]
        if self.strategy == "trim":
            return "smallest change"
        if self.strategy == "uniform":
            return "uniform profile"
        ss = [c["assign"][pm.part["id"]][1] for pm in free]
        shells = f"{min(ss)}–{max(ss)} shells" if min(ss) != max(ss) else f"{ss[0]} shells"
        if not c["fits"]:
            return f"over budget · {shells}"
        dtxt = f"{min(ds):g}%" if min(ds) == max(ds) else f"{min(ds):g}–{max(ds):g}%"
        if maxw:
            return f"strongest armor · {shells} · {dtxt}"
        if minw and max(ds) > min(pm.ranges["infill"][1] for pm in free) * 0.6:
            return f"infill-heavy · {shells} · {dtxt}"
        if minw:
            return f"lightest walls · {shells} · {dtxt}"
        return f"balanced · {shells} · {dtxt}"

    def pareto_view(self, cands: list[dict], plans: list[dict], free, fixed_g: float) -> list[dict]:
        pts = []
        shown = {tuple(sorted(p["assign"].items())) for p in plans}
        # thin the cloud
        cands_sorted = sorted(cands, key=lambda c: c["total_g"])
        step = max(1, len(cands_sorted) // 400)
        for i, c in enumerate(cands_sorted):
            if i % step and tuple(sorted(c["assign"].items())) not in shown:
                continue
            full = tuple(sorted(c["assign"].items()))
            pts.append({"total_g": self.fit_view(c["totals"], fixed_g, self.budgets)["total_g"], "score": c["score"], "fits": c["fits"], "summary": self.summarize(c, free), "key": [list(k) for k in c["key"]],
                        "shown": full in shown, "full": [[k] + list(v) for k, v in sorted(c["assign"].items())]})
        return pts

    def why_not_lighter(self, free, budget: dict, locked_g: float) -> list[dict]:
        floors = self.totals(free, {pm.part["id"]: None for pm in free}, lambda pm, _a: pm.predict(pm.w_range()[0], pm.s_range()[0], pm.ranges["infill"][0]))
        ceils = self.totals(free, {pm.part["id"]: None for pm in free}, lambda pm, _a: pm.predict(pm.w_range()[-1], pm.s_range()[-1], pm.ranges["infill"][1]))
        multi = len(self.configs) > 1
        out = []
        for c in self.configs:
            cid = c["id"]; tag = f"{c['name']}: " if multi else ""
            out.append({"title": "Minimums" if not multi else f"Minimums · {c['name']}", "text": f"{tag}with every free part at its minimum walls/shells/infill the printed parts weigh {floors[cid]:.1f} g (model). Budget for them: {budget[cid]:.1f} g → headroom {budget[cid] - floors[cid]:+.1f} g."})
        if all(ceils[cid] <= budget[cid] for cid in budget):
            worst = min(budget[cid] - ceils[cid] for cid in budget)
            out.append({"title": "Headroom", "text": f"Even every free part at its maximum walls/shells/infill fits, with {worst:.1f} g to spare{' in the tightest configuration' if multi else ''}. Raise the ranges in Part detail if you want to spend it."})
        if any(floors[cid] > budget[cid] for cid in budget):
            bad = [c["name"] for c in self.configs if floors[c["id"]] > budget[c["id"]]]
            out.append({"title": "Infeasible", "text": ("Even the minimums exceed the budget" + (f" in {', '.join(bad)}" if multi else "") + ": loosen a constraint, unlock a part, or lighten something that isn't printed.")})
        return out

    # ------------------------------------------------------------ confirm
    def confirm(self, plans: list[dict], free, fixed_g: float, budget: float) -> float:
        by_id = {pm.part["id"]: pm for pm in free}
        jobs = {}
        for pi, pl in enumerate(self.res["plans"]):
            for a in pl["assignments"]:
                if a["locked"]:
                    continue
                pm = by_id[a["part_id"]]
                job = self.slice(pm, a["params"], "confirm", 3)
                jobs.setdefault(job["id"], []).append((pi, a))
        pending = list(jobs.keys())
        worst = 0.0
        while pending:
            rows = self.wait_jobs(pending, "confirming")
            for jid in list(pending):
                r = rows.get(jid)
                if not r or r["status"] not in ("done", "error", "cancelled"):
                    continue
                pending.remove(jid)
                for (pi, a) in jobs[jid]:
                    pm = by_id[a["part_id"]]
                    if r["status"] == "done" and r["grams"] is not None:
                        a["grams"] = r["grams"] * pm.corr; a["status"] = "confirmed"
                        # feed back as anchor
                        W, T, B, d = a["params"]["walls"], a["params"]["top"], a["params"]["bottom"], a["params"]["infill"]
                        s = max(T, B)
                        pm.anchors[(W, s, d)] = r["grams"]
                        if a.get("model_grams"):
                            worst = max(worst, abs(a["grams"] - a["model_grams"]) / max(a["model_grams"], 1e-6))
                    else:
                        a["status"] = "error"; a["error"] = r.get("error") if r else "cancelled"
            for pl in self.res["plans"]:
                done_n = sum(1 for a in pl["assignments"] if a["locked"] or a["status"] in ("confirmed", "error"))
                pl["confirmed_n"] = done_n; pl["total_n"] = len(pl["assignments"])
                if done_n == len(pl["assignments"]):
                    names = {c["name"]: c["id"] for c in self.configs}
                    tot = {c["id"]: 0.0 for c in self.configs}
                    for a in pl["assignments"]:
                        if a["locked"]:
                            continue          # fixed parts are already in fixed_g
                        ids = tot.keys() if a.get("configs") is None else [names[n] for n in a["configs"] if n in names]
                        for cid in ids:
                            tot[cid] += (a["grams"] or 0) * a["qty"]
                    fv = self.fit_view(tot, fixed_g if self.body.get("mode") != "single" else {cid: 0.0 for cid in tot}, budget)
                    pl["total_g"] = fv["total_g"]; pl["status"] = "confirmed"; pl["per_config"] = fv["per_config"]; pl["worst_config"] = fv["worst_config"]
                    pl["slack_g"] = fv["slack_g"]; pl["fits"] = fv["fits"]
            self.save()
        return worst
