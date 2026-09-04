"""Slice job queue: worker threads, result cache, event broadcast."""
from __future__ import annotations

import hashlib
import json
import queue
import threading
import time
import traceback
from pathlib import Path

from . import meshio, orient, profiles, slicer_engine
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


def orient_key(orient_json: dict, scale: float, mirror: bool) -> str:
    q = orient_json.get("quat", [0, 0, 0, 1])
    return "q" + ",".join(f"{float(x):.4f}" for x in q) + f"|s{float(scale):.4f}|m{1 if mirror else 0}"


def cache_key(mesh_sha: str, okey: str, phash: str, slicer_version: str) -> str:
    return hashlib.sha1(f"{mesh_sha}|{okey}|{phash}|{slicer_version}".encode()).hexdigest()


class JobManager:
    def __init__(self, db: DB, events: Events, data_dir: Path, workers: int = 2):
        self.db = db
        self.events = events
        self.data_dir = Path(data_dir)
        self.work_dir = self.data_dir / "work"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.workers = max(1, int(workers))
        self._threads: list[threading.Thread] = []
        self._wake = threading.Condition()
        self._stop = False
        self._running: dict[int, float] = {}
        self._lock = threading.Lock()
        self.slicer_cmd: list[str] | None = None
        self.slicer_version: str | None = None
        self.refresh_slicer()
        # any job left 'running' from a crash goes back to queued
        db.x("UPDATE slice_jobs SET status='queued' WHERE status='running'")

    # ---- slicer status
    def refresh_slicer(self):
        configured = self.db.setting("slicer_path")
        cmd = slicer_engine.locate(configured)
        self.slicer_cmd = cmd
        self.slicer_version = slicer_engine.version_of(cmd) if cmd else None
        return {"cmd": cmd, "version": self.slicer_version}

    def set_workers(self, n: int):
        self.workers = max(1, int(n))
        self.start()

    # ---- lifecycle
    def start(self):
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

    # ---- public API
    def ensure_slice(self, part: dict, params: dict, filament: dict, purpose: str = "current",
                     priority: int = 5, run_id: int | None = None) -> dict:
        """Return an existing done/queued job for this exact configuration or queue a new one."""
        if not self.slicer_version:
            self.refresh_slicer()
        mesh = self.db.get("meshes", part["mesh_id"]) if part.get("mesh_id") else None
        if not mesh:
            raise ValueError("part has no mesh")
        okey = orient_key(loads(part.get("orient_json"), {}), part.get("scale") or 1.0, bool(part.get("mirror")))
        phash = profiles.profile_hash(params, filament)
        ver = self.slicer_version or "none"
        ck = cache_key(mesh["sha256"], okey, phash, ver)
        existing = self.db.one("SELECT * FROM slice_jobs WHERE cache_key=? AND status IN ('done','queued','running') ORDER BY status='done' DESC, id DESC LIMIT 1", [ck])
        if existing:
            if existing["status"] != "done" and priority < (existing.get("priority") or 5):
                self.db.update("slice_jobs", existing["id"], {"priority": priority})
            if existing["part_id"] != part["id"] and existing["status"] == "done":
                # same geometry+profile sliced for another part (mirror twin, duplicate): copy the result
                jid = self.db.insert("slice_jobs", {
                    "part_id": part["id"], "cache_key": ck, "mesh_sha": mesh["sha256"], "orient_key": okey,
                    "profile_hash": phash, "profile_json": json.dumps(profiles.normalize(params)),
                    "filament_key": f"{filament['density']}|{filament.get('flow', 1)}", "slicer_version": ver,
                    "status": "done", "purpose": purpose, "run_id": run_id, "created": now(), "started": existing["started"],
                    "finished": existing["finished"], "grams": existing["grams"], "cm3": existing["cm3"],
                    "time_s": 0.0, "print_time_s": existing.get("print_time_s"), "priority": priority})
                return self.db.get("slice_jobs", jid)
            return existing
        jid = self.db.insert("slice_jobs", {
            "part_id": part["id"], "cache_key": ck, "mesh_sha": mesh["sha256"], "orient_key": okey,
            "profile_hash": phash, "profile_json": json.dumps(profiles.normalize(params)),
            "filament_key": f"{filament['density']}|{filament.get('flow', 1)}", "slicer_version": ver,
            "status": "queued", "purpose": purpose, "run_id": run_id, "created": now(), "priority": priority})
        job = self.db.get("slice_jobs", jid)
        self.events.emit("job", {"job": job})
        self.start()
        return job

    def cached_result(self, part: dict, params: dict, filament: dict) -> dict | None:
        mesh = self.db.get("meshes", part["mesh_id"]) if part.get("mesh_id") else None
        if not mesh or not self.slicer_version:
            return None
        okey = orient_key(loads(part.get("orient_json"), {}), part.get("scale") or 1.0, bool(part.get("mirror")))
        ck = cache_key(mesh["sha256"], okey, profiles.profile_hash(params, filament), self.slicer_version)
        return self.db.one("SELECT * FROM slice_jobs WHERE cache_key=? AND status='done' ORDER BY id DESC LIMIT 1", [ck])

    def queue_state(self) -> dict:
        rows = self.db.q("SELECT status, COUNT(*) n FROM slice_jobs WHERE status IN ('queued','running') GROUP BY status")
        st = {r["status"]: r["n"] for r in rows}
        return {"queued": st.get("queued", 0), "running": st.get("running", 0), "workers": self.workers,
                "slicer": self.slicer_version, "slicer_cmd": self.slicer_cmd}

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
            if not self.slicer_cmd:
                self.refresh_slicer()
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
                    upd["cache_key"] = cache_key(job["mesh_sha"], job["orient_key"], job["profile_hash"], self.slicer_version)
                self.db.update("slice_jobs", job["id"], upd)
            except Exception as e:  # noqa
                self.db.update("slice_jobs", job["id"], {"status": "error", "finished": now(), "error": str(e)[:1000]})
                traceback.print_exc()
            job = self.db.get("slice_jobs", job["id"])
            self._after(job)
            self.events.emit("job", {"job": job})
            self.events.emit("queue", self.queue_state())

    def oriented_stl(self, part: dict, mesh: dict) -> Path:
        okey = orient_key(loads(part.get("orient_json"), {}), part.get("scale") or 1.0, bool(part.get("mirror")))
        name = hashlib.sha1(f"{mesh['sha256']}|{okey}".encode()).hexdigest()[:20] + ".stl"
        out = self.work_dir / "oriented" / name
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            tri = meshio.load_mesh(Path(mesh["path"]))
            t = orient.apply_orientation(tri, loads(part.get("orient_json"), {}), float(part.get("scale") or 1.0), bool(part.get("mirror")))
            t = t + [200.0 - (t[:, :, 0].min() + t[:, :, 0].max()) / 2, 200.0 - (t[:, :, 1].min() + t[:, :, 1].max()) / 2, 0]
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
        dens, flow = job["filament_key"].split("|")
        ini = profiles.to_prusa_ini(params, {"density": float(dens), "flow": float(flow)}, self.slicer_version)
        stl = self.oriented_stl(part, mesh)
        keep = bool(self.db.setting("keep_gcode", False))
        jobdir = self.work_dir / "jobs" / str(job["id"])
        res = slicer_engine.run_slice(self.slicer_cmd, stl, ini, jobdir, keep_gcode=keep)
        if not keep:
            try:
                for f in jobdir.iterdir():
                    f.unlink()
                jobdir.rmdir()
            except OSError:
                pass
        return res

    def _after(self, job: dict):
        """When a part's *current* profile slice lands, push it onto the sheet line."""
        if job["status"] != "done" or job.get("purpose") not in ("current",):
            return
        part = self.db.get("printed_parts", job["part_id"])
        if not part or not part.get("line_item_id"):
            return
        # only if this job still matches the part's current configuration
        prof = self.db.get("profiles", part["profile_id"]) if part.get("profile_id") else None
        fil = self.db.get("filaments", part["filament_id"]) if part.get("filament_id") else None
        if not prof or not fil:
            return
        okey = orient_key(loads(part.get("orient_json"), {}), part.get("scale") or 1.0, bool(part.get("mirror")))
        phash = profiles.profile_hash(loads(prof["params_json"], {}), fil)
        if okey != job["orient_key"] or phash != job["profile_hash"]:
            return
        corr = loads(fil.get("correction_json"), {}).get("factor") or 1.0
        self.db.update("line_items", part["line_item_id"], {"est_grams": job["grams"] * corr, "est_source": "slicer"})
        self.events.emit("line_item", {"id": part["line_item_id"], "robot_id": part["robot_id"]})
