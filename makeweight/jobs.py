# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Slice job queue: worker threads, result cache, event broadcast."""
from __future__ import annotations

import hashlib
import shutil
import json
import queue
import threading
import time
import traceback
from pathlib import Path

from . import bambu_engine, meshio, orient, profiles, slicer_engine
from .log import log
from .db import DB, loads, now


class Events:
    """Fan-out of JSON events to SSE subscribers."""

    def __init__(self):
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def emit(self, kind: str, data: dict):
        msg = json.dumps({"type": kind, "t": time.time(), **data})
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


def orient_key(orient_json: dict, scale: float, mirror, modifiers=None) -> str:
    """mirror: falsy, True/"x" (both encode as m1 so older cache keys stay valid), "y" → my, "z" → mz."""
    q = orient_json.get("quat", [0, 0, 0, 1])
    mcode = "0" if not mirror else ("1" if mirror is True or mirror == "x" else str(mirror))
    key = "q" + ",".join(f"{float(x):.4f}" for x in q) + f"|s{float(scale):.4f}|m{mcode}"
    if modifiers:
        key += "|mods" + hashlib.sha1(json.dumps(modifiers, sort_keys=True).encode()).hexdigest()[:10]
    return key


def supports_suffix(supports: dict | None) -> str:
    """Cache-key suffix for a slice with supports generated (the plain slice has none)."""
    if not supports or not supports.get("enabled"):
        return ""
    core = {k: supports.get(k) for k in ("type", "plate_only", "angle")}
    from . import bambu_engine
    core["dedicated"] = bool(bambu_engine.SUPPORT_INTERFACES.get(supports.get("interface") or "same"))
    return "|sup" + hashlib.sha1(json.dumps(core, sort_keys=True).encode()).hexdigest()[:10]


def part_supports(part: dict) -> dict | None:
    """The part's support settings from print_json, or None when supports are off."""
    pj = loads(part.get("print_json"), {}) if "print_json" in part else (part.get("print") or {})
    sp = (pj or {}).get("supports") or {}
    return sp if sp.get("enabled") else None


def part_okey(part: dict) -> str:
    return orient_key(loads(part.get("orient_json"), {}), part.get("scale") or 1.0, orient.mirror_of(part), loads(part.get("modifiers_json"), []))


MOD_KEYS = {"walls": "perimeters", "infill": "fill_density", "pattern": "fill_pattern", "top": "top_solid_layers", "bottom": "bottom_solid_layers"}
MOD_KEYS_BAMBU = {"walls": "wall_loops", "infill": "sparse_infill_density", "pattern": "sparse_infill_pattern", "top": "top_shell_layers", "bottom": "bottom_shell_layers"}


def modifier_settings(md: dict, engine: str = "prusa") -> dict:
    keys = MOD_KEYS_BAMBU if engine == "bambu" else MOD_KEYS
    out = {}
    for k, v in (md.get("params") or {}).items():
        if k in keys and v not in (None, ""):
            if k == "infill":
                out[keys[k]] = f"{float(v):g}%"
            elif k in ("walls", "top", "bottom"):
                out[keys[k]] = str(int(float(v)))
            elif k == "pattern" and engine == "bambu":
                out[keys[k]] = profiles.BAMBU_PATTERN.get(str(v), str(v))
            else:
                out[keys[k]] = str(v)
    if engine != "bambu" and out.get("fill_density") in ("100%",) and "fill_pattern" not in out:
        out["fill_pattern"] = "rectilinear"
    return out


def cache_key(mesh_sha: str, okey: str, phash: str, slicer_version: str, machine: str = "") -> str:
    """Identity of a slice result. The printer (P1S/H2D) is part of it: its process base differs, not just its speeds."""
    return hashlib.sha1(f"{mesh_sha}|{okey}|{phash}|{slicer_version}|{profiles.MAPPING_VERSION}|{machine}".encode()).hexdigest()


def filament_key(filament: dict, machine: str) -> str:
    name = str(filament.get("name") or "").replace("|", "/")
    return f"{filament['density']}|{filament.get('flow', 1)}|{filament.get('max_vol_speed') or 12}|{machine}|{name}"


class JobManager:
    on_weighin_slice = None   # set by App: called with the finished job of a weigh-in slice

    def __init__(self, db: DB, events: Events, data_dir: Path, workers: int = 2, work_dir: Path | None = None):
        self.db = db
        self.events = events
        self.data_dir = Path(data_dir)
        self.work_dir = Path(work_dir) if work_dir else self.data_dir / "work"     # caches: this computer only
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.workers = max(1, int(workers))
        self._threads: list[threading.Thread] = []
        self._wake = threading.Condition()
        self._stop = False
        self._running: dict[int, float] = {}
        self._lock = threading.Lock()
        self.slicer_cmd: list[str] | None = None
        self.slicer_version: str | None = None
        self.presets = None
        self.refresh_slicer()
        # any job left 'running' from a crash goes back to queued
        db.x("UPDATE slice_jobs SET status='queued' WHERE status='running'")

    # ---- slicer status
    @property
    def engine(self) -> str:
        """'bambu' (Bambu Studio, the default) or 'prusa' (PrusaSlicer through the settings mapping)."""
        e = self.db.setting("slicer_engine") or "bambu"
        return e if e in ("bambu", "prusa") else "bambu"

    def engine_status(self, force: bool = False) -> dict:
        """Locate both engines so the setup page can show what is installed (cached for 60 s; --help is slow on Windows)."""
        cached = getattr(self, "_engine_status", None)
        if cached and not force and time.time() - cached[0] < 60:
            return cached[1]
        out = {}
        pc = slicer_engine.locate(self.db.setting("slicer_path"))
        out["prusa"] = {"cmd": pc, "version": slicer_engine.version_of(pc) if pc else None}
        bc = bambu_engine.locate(self.db.setting("bambu_path"))
        bv = bambu_engine.version_of(bc) if bc else None
        out["bambu"] = {"cmd": bc, "version": bv, "resources": str(bambu_engine.resources_dir(bc) or "") if bc else "",
                        "hint": bambu_engine.missing_libs(bc) if (bc and not bv) else None}
        self._engine_status = (time.time(), out)
        return out

    def refresh_slicer(self):
        self._engine_status = None
        self.presets = None
        if self.engine == "bambu":
            cmd = bambu_engine.locate(self.db.setting("bambu_path"))
            ver = bambu_engine.version_of(cmd) if cmd else None
            res = bambu_engine.resources_dir(cmd) if cmd else None
            if cmd and ver and res is None:
                ver = None  # can run but its preset library is missing — cannot build settings
            if cmd and ver:
                self.presets = bambu_engine.Presets(res)
            self.slicer_cmd = cmd if ver else None
            self.slicer_version = ("bambu-" + ver) if ver else None
        else:
            cmd = slicer_engine.locate(self.db.setting("slicer_path"))
            self.slicer_cmd = cmd
            self.slicer_version = slicer_engine.version_of(cmd) if cmd else None
        state = (self.engine, str(self.slicer_cmd), self.slicer_version)
        if state != getattr(self, "_last_logged", None):      # only when something changed — workers re-probe while nothing is installed
            self._last_logged = state
            log.info("slicer: engine=%s cmd=%s version=%s", self.engine, self.slicer_cmd, self.slicer_version)
        self._last_probe = time.time()
        return {"cmd": self.slicer_cmd, "version": self.slicer_version, "engine": self.engine}

    @property
    def slicer_label(self) -> str | None:
        v = self.slicer_version
        if not v:
            return None
        return ("Bambu Studio " + v[6:]) if v.startswith("bambu-") else ("PrusaSlicer " + v)

    def set_workers(self, n: int):
        self.workers = max(1, int(n))
        self.start()

    # ---- lifecycle
    def start(self):
        self._stop = False
        alive = [t for t in self._threads if t.is_alive()]
        self._threads = alive
        for i in range(len(alive), self.workers):
            t = threading.Thread(target=self._worker, name=f"slicer-{i}", daemon=True)
            t.start()
            self._threads.append(t)
        with self._wake:
            self._wake.notify_all()

    def stop(self):
        self._stop = True
        with self._wake:
            self._wake.notify_all()

    pause = stop

    # ---- public API
    def machine_for_part(self, part: dict) -> str:
        """P1S / H2D speed set for the robot's printer (falls back to the first printer, then P1S)."""
        try:
            robot = self.db.get("robots", part["robot_id"]) if part.get("robot_id") else None
            pr = self.db.get("printers", robot["printer_id"]) if robot and robot.get("printer_id") else None
            if pr is None:
                pr = self.db.one("SELECT * FROM printers ORDER BY builtin DESC, id LIMIT 1")
            return profiles.machine_key(pr["name"] if pr else None)
        except Exception:  # noqa
            return "P1S"

    def ensure_slice(self, part: dict, params: dict, filament: dict, purpose: str = "current",
                     priority: int = 5, run_id: int | None = None, supports: dict | None = None) -> dict:
        """Return an existing done/queued job for this exact configuration or queue a new one. `supports` slices the
        same part with supports generated (its grams minus the plain slice = the support material)."""
        if not self.slicer_version:
            self.refresh_slicer()
        mesh = self.db.get("meshes", part["mesh_id"]) if part.get("mesh_id") else None
        if not mesh:
            raise ValueError("part has no mesh")
        okey = part_okey(part)
        phash = profiles.profile_hash(params, filament) + supports_suffix(supports)
        ver = self.slicer_version or "none"
        machine = self.machine_for_part(part)
        ck = cache_key(mesh["sha256"], okey, phash, ver, machine)
        fkey = filament_key(filament, machine)
        existing = self.db.one("SELECT * FROM slice_jobs WHERE cache_key=? AND status IN ('done','queued','running') ORDER BY status='done' DESC, id DESC LIMIT 1", [ck])
        if existing:
            if existing["status"] != "done" and priority < (existing.get("priority") or 5):
                self.db.update("slice_jobs", existing["id"], {"priority": priority})
            if existing["part_id"] != part["id"] and existing["status"] == "done":
                # same geometry+profile sliced for another part (mirror twin, duplicate): copy the result
                jid = self.db.insert("slice_jobs", {
                    "part_id": part["id"], "cache_key": ck, "mesh_sha": mesh["sha256"], "orient_key": okey,
                    "profile_hash": phash, "profile_json": json.dumps(profiles.normalize(params)), "extra_json": json.dumps({"supports": supports}) if supports else None,
                    "filament_key": fkey, "slicer_version": ver,
                    "status": "done", "purpose": purpose, "run_id": run_id, "created": now(), "started": existing["started"],
                    "finished": existing["finished"], "grams": existing["grams"], "cm3": existing["cm3"],
                    "time_s": 0.0, "print_time_s": existing.get("print_time_s"), "priority": priority})
                return self.db.get("slice_jobs", jid)
            return existing
        jid = self.db.insert("slice_jobs", {
            "part_id": part["id"], "cache_key": ck, "mesh_sha": mesh["sha256"], "orient_key": okey,
            "profile_hash": phash, "profile_json": json.dumps(profiles.normalize(params)), "extra_json": json.dumps({"supports": supports}) if supports else None,
            "filament_key": fkey, "slicer_version": ver,
            "status": "queued", "purpose": purpose, "run_id": run_id, "created": now(), "priority": priority})
        job = self.db.get("slice_jobs", jid)
        self.events.emit("job", {"job": job})
        self.start()
        return job

    def cached_result(self, part: dict, params: dict, filament: dict, supports: dict | None = None) -> dict | None:
        mesh = self.db.get("meshes", part["mesh_id"]) if part.get("mesh_id") else None
        if not mesh or not self.slicer_version:
            return None
        okey = part_okey(part)
        ck = cache_key(mesh["sha256"], okey, profiles.profile_hash(params, filament) + supports_suffix(supports), self.slicer_version, self.machine_for_part(part))
        return self.db.one("SELECT * FROM slice_jobs WHERE cache_key=? AND status='done' ORDER BY id DESC LIMIT 1", [ck])

    def queue_state(self) -> dict:
        rows = self.db.q("SELECT status, COUNT(*) n FROM slice_jobs WHERE status IN ('queued','running') GROUP BY status")
        st = {r["status"]: r["n"] for r in rows}
        return {"queued": st.get("queued", 0), "running": st.get("running", 0), "workers": self.workers,
                "slicer": self.slicer_version, "slicer_label": self.slicer_label, "engine": self.engine, "slicer_cmd": self.slicer_cmd}

    def cancel_queued(self, run_id: int | None = None, part_id: int | None = None):
        sql = "UPDATE slice_jobs SET status='cancelled' WHERE status='queued'"
        args = []
        if run_id is not None:
            sql += " AND run_id=?"; args.append(run_id)
        if part_id is not None:
            sql += " AND part_id=?"; args.append(part_id)
        self.db.x(sql, args)
        self.events.emit("queue", self.queue_state())

    # ---- workers
    def _claim(self) -> dict | None:
        with self._lock:
            job = self.db.one("SELECT * FROM slice_jobs WHERE status='queued' ORDER BY priority ASC, id ASC LIMIT 1")
            if not job:
                return None
            self.db.update("slice_jobs", job["id"], {"status": "running", "started": now()})
            job["status"] = "running"
            return job

    def _worker(self):
        while not self._stop:
            if not self.slicer_cmd and time.time() - getattr(self, "_last_probe", 0) > 15:
                self.refresh_slicer()                            # pick up an install made outside the app, without probing every second
            job = self._claim() if self.slicer_cmd else None
            if not job:
                with self._wake:
                    self._wake.wait(timeout=1.0)
                continue
            self.events.emit("job", {"job": job})
            try:
                res = self._run(job)
                upd = {"status": "done", "finished": now(), "grams": res["grams"], "cm3": res.get("cm3"),
                       "time_s": res.get("time_s"), "print_time_s": res.get("print_time_s"), "error": None}
                if job.get("slicer_version") != self.slicer_version and self.slicer_version:
                    # queued before the slicer was installed: re-key so the cache finds it later
                    upd["slicer_version"] = self.slicer_version
                    upd["cache_key"] = cache_key(job["mesh_sha"], job["orient_key"], job["profile_hash"], self.slicer_version, (job.get("filament_key") or "").split("|")[3:4] and (job.get("filament_key") or "").split("|")[3] or "")
                self.db.update("slice_jobs", job["id"], upd)
            except Exception as e:  # noqa
                self.db.update("slice_jobs", job["id"], {"status": "error", "finished": now(), "error": str(e)[:1000]})
                if isinstance(e, RuntimeError):
                    log.warning("slice job %s (part %s) failed: %s", job["id"], job.get("part_id"), e)
                else:
                    log.exception("slice job %s (part %s) crashed", job["id"], job.get("part_id"))
            job = self.db.get("slice_jobs", job["id"])
            self._after(job)
            self.events.emit("job", {"job": job})
            self.events.emit("queue", self.queue_state())

    def oriented_stl(self, part: dict, mesh: dict, center=(200.0, 200.0)) -> Path:
        """Oriented geometry for the slicer: an STL, or (with modifier regions) a 3MF in the active engine's dialect."""
        okey = part_okey(part)
        mods = loads(part.get("modifiers_json"), []) or []
        engine = self.engine if mods else ""
        tag = f"{mesh['sha256']}|{okey}|{engine}|{center[0]:g},{center[1]:g}" if mods else f"{mesh['sha256']}|{okey}|{center[0]:g},{center[1]:g}"
        name = hashlib.sha1(tag.encode()).hexdigest()[:20] + (".3mf" if mods else ".stl")
        out = self.work_dir / "oriented" / name
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            tri = meshio.load_mesh(meshio.mesh_path(mesh))
            t = orient.apply_orientation(tri, loads(part.get("orient_json"), {}), float(part.get("scale") or 1.0), orient.mirror_of(part))
            if mods and engine == "bambu":
                boxes = [{"name": m.get("name") or "modifier", "min": [float(v) for v in m["min"]], "max": [float(v) for v in m["max"]],
                          "settings": modifier_settings(m, "bambu")} for m in mods if m.get("min") and m.get("max")]
                out.write_bytes(meshio.bambu_3mf_with_modifiers(t, mesh.get("filename") or "part", boxes, center=center))
            else:
                shift = [center[0] - (t[:, :, 0].min() + t[:, :, 0].max()) / 2, center[1] - (t[:, :, 1].min() + t[:, :, 1].max()) / 2, 0.0]
                t = t + shift
                if mods:
                    boxes = [{"name": m.get("name") or "modifier", "min": [float(m["min"][i]) + shift[i] for i in range(3)],
                              "max": [float(m["max"][i]) + shift[i] for i in range(3)], "settings": modifier_settings(m, "prusa")} for m in mods if m.get("min") and m.get("max")]
                    out.write_bytes(meshio.prusa_3mf_with_modifiers(t, mesh.get("filename") or "part", boxes))
                else:
                    meshio.write_stl(t, out)
        return out

    def _run(self, job: dict) -> dict:
        part = self.db.get("printed_parts", job["part_id"])
        if not part:
            raise RuntimeError("part deleted")
        mesh = self.db.get("meshes", part["mesh_id"])
        if not mesh:
            raise RuntimeError("mesh missing")
        params = loads(job["profile_json"], {})
        fk = (job["filament_key"] or "1.24|1").split("|") + [None, None, None]
        dens, flow, mvs, machine, fname = fk[0], fk[1], fk[2], fk[3] or "P1S", fk[4]
        fil = {"density": float(dens), "flow": float(flow), "max_vol_speed": float(mvs) if mvs else None, "name": fname or ""}
        frow = self.db.one("SELECT material FROM filaments WHERE name=?", [fname]) if fname else None
        fil["material"] = (frow or {}).get("material") or "PLA"
        keep = bool(self.db.setting("keep_gcode", False))
        jobdir = self.work_dir / "jobs" / str(job["id"])
        if self.engine == "bambu":
            if not self.presets:
                self.refresh_slicer()
            if not self.presets:
                raise RuntimeError("Bambu Studio is not installed (Jobs & setup → Install)")
            nozzle = f"{profiles.normalize(params)['nozzle']:g}"
            center = self.presets.bed_center(machine, nozzle)
            model = self.oriented_stl(part, mesh, center=center)
            supports = (loads(job.get("extra_json"), {}) or {}).get("supports")
            presets = self.presets.write(jobdir / "presets", params, fil, machine, supports=supports)
            res = bambu_engine.run_slice(self.slicer_cmd, model, presets, jobdir, self.work_dir / "bambu_data", keep_gcode=keep)
        else:
            ini = profiles.to_prusa_ini(params, fil, self.slicer_version, machine=machine)
            model = self.oriented_stl(part, mesh)
            res = slicer_engine.run_slice(self.slicer_cmd, model, ini, jobdir, keep_gcode=keep)
        if not keep:
            shutil.rmtree(jobdir, ignore_errors=True)
        return res

    def _after(self, job: dict):
        """When a part's *current* profile slice lands, push it onto the sheet line; a slice behind a weigh-in fills in
        that weigh-in's sliced grams and refreshes the filament correction."""
        if job["status"] == "done" and job.get("purpose") == "weigh-in" and self.on_weighin_slice:
            try:
                self.on_weighin_slice(job)
            except Exception:  # noqa
                log.exception("weigh-in slice hook")
        if job["status"] != "done":
            return
        # any purpose counts (anchor/confirm/sweep slices too): what matters is whether this job *is* the part's current
        # geometry + profile — after "Apply to parts" the optimizer's confirm slice is exactly that, and used to be skipped
        # here, which left the sheet's estimate at the previous profile's grams while the Estimated column showed the new one
        part = self.db.get("printed_parts", job["part_id"])
        if not part or not part.get("line_item_id"):
            return
        if job.get("extra_json"):
            # a slice with supports: not the sheet's weight (supports are removed), but the part view shows it — refresh
            self.events.emit("line_item", {"id": part["line_item_id"], "robot_id": part["robot_id"]})
            return
        # only if this job still matches the part's current configuration
        prof = self.db.get("profiles", part["profile_id"]) if part.get("profile_id") else None
        fil = self.db.get("filaments", part["filament_id"]) if part.get("filament_id") else None
        if not prof or not fil:
            return
        okey = part_okey(part)
        phash = profiles.profile_hash(loads(prof["params_json"], {}), fil)
        if okey != job["orient_key"] or phash != job["profile_hash"]:
            return
        corr = loads(fil.get("correction_json"), {}).get("factor") or 1.0
        self.db.update("line_items", part["line_item_id"], {"est_grams": job["grams"] * corr, "est_source": "slicer"})
        self.events.emit("line_item", {"id": part["line_item_id"], "robot_id": part["robot_id"]})
