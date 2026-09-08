# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""HTTP API + static UI. Standard library only."""
from __future__ import annotations

import io
import json
import mimetypes
import os
import platform
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import bambu_engine, exports, log as applog, meshio, optimizer, orient, paths, profiles, slicer_engine
from .log import log
from .db import DB, loads, now
from .jobs import Events, JobManager
from .undo import UndoManager
from .updater import Updater, current_version, target as update_target

STATIC = Path(__file__).parent / "static"


class App:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.mesh_dir = self.data_dir / "meshes"
        self.mesh_dir.mkdir(parents=True, exist_ok=True)
        meshio.MESH_DIR = self.mesh_dir
        if not applog.log_file():
            applog.setup(self.data_dir)
        log.info("%s %s starting; data=%s; %s; python %s", paths.APP_NAME, applog._app_version(), self.root, platform.platform(), sys.version.split()[0])
        paths.migrate_db_filename(self.data_dir, log)
        self.db = DB(self.data_dir / paths.DB_FILE)
        self._repair_mesh_paths()
        self.events = Events()
        cores = os.cpu_count() or 2
        workers = self.db.setting("workers") or max(1, cores // 2)
        self.jobs = JobManager(self.db, self.events, self.data_dir, workers=workers)
        self.undo = UndoManager(self.db, self.events)
        self.updater = Updater(self.db, self.events)
        self.httpd = None  # set by serve()
        from . import seed
        seed.ensure_seed(self.db)
        self.jobs.start()
        self.install_state = {"status": "idle", "message": "", "progress": 0.0}
        self._rm_cache: dict = {}
        self._rm_lock = threading.Lock(); self._rm_build_lock = threading.Lock(); self._rm_building: dict = {}; self._rm_errors: dict = {}
        threading.Thread(target=self._backup_loop, daemon=True).start()

    def region_model(self, part: dict, params: dict, wait: bool = False):
        """RegionModel for a part's current geometry (cached, a few entries).

        Built by one background thread at a time so a big mesh in a tall orientation never hogs the request
        threads. Returns None while the model is still being built (unless wait=True)."""
        from . import estimator
        from .jobs import orient_key
        mesh = self.db.get("meshes", part["mesh_id"])
        key = (mesh["sha256"], orient_key(loads(part["orient_json"], {}), part.get("scale") or 1.0, bool(part.get("mirror"))), params["layer_height"], json.dumps(params["line_widths"], sort_keys=True))
        with self._rm_lock:
            if key in self._rm_cache:
                return self._rm_cache[key]
            if key in self._rm_errors:
                raise RuntimeError(self._rm_errors[key])
            ev = self._rm_building.get(key)
            if ev is None:
                ev = self._rm_building[key] = threading.Event()
                orient_json, scale, mirror = part["orient_json"], float(part.get("scale") or 1.0), bool(part.get("mirror"))

                def build():
                    try:
                        with self._rm_build_lock:  # one heavy build at a time
                            tri = self.preview_mesh(mesh)          # the layer classification is a picture; the decimated copy is plenty
                            t = orient.apply_orientation(tri, loads(orient_json, {}), scale, mirror)
                            rm = estimator.RegionModel(t, params)
                        with self._rm_lock:
                            while len(self._rm_cache) >= 4:
                                self._rm_cache.pop(next(iter(self._rm_cache)))
                            self._rm_cache[key] = rm
                    except Exception as e:  # noqa
                        with self._rm_lock:
                            self._rm_errors[key] = f"layer model failed: {e}"
                    finally:
                        with self._rm_lock:
                            self._rm_building.pop(key, None)
                        ev.set()
                threading.Thread(target=build, name="region-model", daemon=True).start()
        if not wait:
            return None
        ev.wait()
        return self.region_model(part, params, wait=False)

    # ------------------------------------------------------------ helpers
    PREVIEW_MAX_TRIS = 300_000

    def preview_mesh(self, mesh: dict):
        """The mesh for anything that only needs to *look* right (viewer, thumbnails, layer model): dense CAD exports
        are decimated once and cached as data/work/lod/<sha>.stl; small meshes come back untouched."""
        tri = meshio.load_mesh(meshio.mesh_path(mesh))
        if len(tri) <= self.PREVIEW_MAX_TRIS:
            return tri
        ldir = self.root / "data" / "work" / "lod"; ldir.mkdir(parents=True, exist_ok=True)
        f = ldir / f"{mesh['sha256'][:24]}.stl"
        if f.exists():
            return meshio.load_mesh(f)
        t0 = time.time()
        d = meshio.decimate_grid(tri, self.PREVIEW_MAX_TRIS // 2)
        meshio.write_stl(d, f)
        log.info("preview mesh for %s: %d → %d triangles in %.1fs", mesh.get("filename"), len(tri), len(d), time.time() - t0)
        return d

    def _repair_mesh_paths(self):
        """Mesh rows remember where their file was uploaded. After the data folder moved (new install location, an
        older version's data/ adopted) that path is stale while the file itself sits in the current meshes folder —
        point the rows at it, once, so nothing downstream has to guess."""
        fixed = 0
        for m in self.db.q("SELECT id, path, filename FROM meshes"):
            old = Path(m["path"] or "")
            if old.exists():
                continue
            alt = self.mesh_dir / old.name
            if old.name and alt.exists():
                self.db.update("meshes", m["id"], {"path": str(alt)}); fixed += 1
            else:
                log.warning("mesh %s (%s) is missing on disk: %s", m["id"], m["filename"], old)
        if fixed:
            log.info("repaired %d mesh path(s) to %s", fixed, self.mesh_dir)

    def robot_detail(self, rid: int) -> dict:
        robot = self.db.get("robots", rid)
        if not robot:
            raise KeyError("robot")
        sections = self.db.q("SELECT * FROM sections WHERE robot_id=? ORDER BY ord, id", [rid])
        items = self.db.q("SELECT li.* FROM line_items li JOIN sections s ON s.id=li.section_id WHERE s.robot_id=? ORDER BY li.ord, li.id", [rid])
        weigh = self.db.q("SELECT w.* FROM weigh_ins w JOIN line_items li ON li.id=w.line_item_id JOIN sections s ON s.id=li.section_id WHERE s.robot_id=? ORDER BY w.date, w.id", [rid])
        parts = self.db.q("SELECT * FROM printed_parts WHERE robot_id=?", [rid])
        by_item: dict[int, list] = {}
        for w in weigh:
            by_item.setdefault(w["line_item_id"], []).append(w)
        parts_by_item = {p["line_item_id"]: p for p in parts if p.get("line_item_id")}
        sec_map = {s["id"]: s for s in sections}
        for s in sections:
            s["counts"] = bool(s["counts"]); s["items"] = []; s["subtotal"] = 0.0; s["subtotal_est"] = 0.0
        total = est_total = measured_mass = 0.0
        flags = 0
        for it in items:
            ws = by_item.get(it["id"], [])
            it["weigh_ins"] = ws
            latest = ws[-1]["grams"] if ws else None
            it["measured_grams"] = latest
            it["best_grams"] = latest if latest is not None else (it["est_grams"] or 0.0)
            it["total_grams"] = (it["qty"] or 0) * it["best_grams"]
            it["total_est"] = (it["qty"] or 0) * (it["est_grams"] or 0.0)
            p = parts_by_item.get(it["id"])
            if p:
                it["part"] = self._part_view(p)
            s = sec_map.get(it["section_id"])
            if s is None:
                continue
            s["items"].append(it)
            s["subtotal"] += it["total_grams"]; s["subtotal_est"] += it["total_est"]
            it["counted"] = bool(it.get("counted", 1))
            if s["counts"] and it["counted"]:
                total += it["total_grams"]; est_total += it["total_est"]
                if latest is not None:
                    measured_mass += it["total_grams"]
                if it["needs_reweigh"]:
                    flags += 1
        printed = sum(it["total_grams"] for s in sections if s["counts"] for it in s["items"] if it.get("part") and it["counted"])
        robot["sections"] = sections
        robot["totals"] = {
            "best_known": total, "estimated_only": est_total, "measured_fraction": (measured_mass / total) if total else 0.0,
            "over_under": total - robot["weight_class_g"], "over_under_margin": total + (robot["margin_g"] or 0) - robot["weight_class_g"],
            "printed": printed, "flags": flags, "printed_budget": robot["weight_class_g"] - (robot["margin_g"] or 0) - (total - printed),
        }
        robot["queue"] = self.db.one("SELECT COUNT(*) n FROM slice_jobs j JOIN printed_parts p ON p.id=j.part_id WHERE p.robot_id=? AND j.status IN ('queued','running')", [rid])["n"]
        return robot

    def _part_view(self, p: dict) -> dict:
        p = dict(p)
        p["orient"] = loads(p.pop("orient_json", None), {"mode": "auto", "quat": [0, 0, 0, 1]})
        p["constraints"] = loads(p.pop("constraints_json", None), {})
        p["modifiers"] = loads(p.pop("modifiers_json", None), []) or []
        p["locked"] = bool(p["locked"]); p["mirror"] = bool(p.get("mirror"))
        mesh = self.db.get("meshes", p["mesh_id"]) if p.get("mesh_id") else None
        if mesh:
            mesh = dict(mesh); mesh["bbox"] = loads(mesh.pop("bbox_json", None), None); mesh.pop("path", None)
        p["mesh"] = mesh
        prof = self.db.get("profiles", p["profile_id"]) if p.get("profile_id") else None
        fil = self.db.get("filaments", p["filament_id"]) if p.get("filament_id") else None
        p["profile"] = self._profile_view(prof) if prof else None
        p["filament"] = self._filament_view(fil) if fil else None
        job = None
        if mesh and prof and fil:
            pj = p | {"orient_json": json.dumps(p["orient"]), "modifiers_json": json.dumps(p["modifiers"])}
            params = loads(prof["params_json"], {})
            job = self.jobs.cached_result(pj, params, fil)
            if not job:
                # the newest attempt for exactly this geometry + profile, whatever queued it (so a failed
                # orientation shows its error, and a fixed orientation never shows a stale one)
                from .jobs import part_okey
                job = self.db.one("SELECT * FROM slice_jobs WHERE part_id=? AND orient_key=? AND profile_hash=? AND status IN ('queued','running','error') ORDER BY id DESC LIMIT 1",
                                  [p["id"], part_okey(pj), profiles.profile_hash(params, fil)])
        p["slice"] = job
        if job and job.get("grams") is not None and fil:
            p["corrected_grams"] = job["grams"] * (loads(fil.get("correction_json"), {}).get("factor") or 1.0)
        return p

    def _profile_view(self, prof: dict) -> dict:
        prof = dict(prof)
        prof["params"] = profiles.normalize(loads(prof.pop("params_json", None), {}))
        prof["string"] = profiles.profile_string(prof["params"])
        prof["effective_shells"] = profiles.effective_shell_layers(prof["params"])
        prof["builtin"] = bool(prof.get("builtin"))
        return prof

    def _filament_view(self, f: dict) -> dict:
        f = dict(f)
        f["correction"] = loads(f.pop("correction_json", None), {})
        f["builtin"] = bool(f.get("builtin"))
        return f

    def current_slice_for_part(self, part_id: int, priority: int = 3):
        p = self.db.get("printed_parts", part_id)
        if not p or not p.get("mesh_id") or not p.get("profile_id") or not p.get("filament_id"):
            return None
        prof = self.db.get("profiles", p["profile_id"]); fil = self.db.get("filaments", p["filament_id"])
        try:
            job = self.jobs.ensure_slice(p, loads(prof["params_json"], {}), fil, purpose="current", priority=priority)
        except Exception as e:
            return {"error": str(e)}
        if job["status"] == "done":
            self.jobs._after(job)
        return job

    def recalc_filament_correction(self, filament_id: int):
        """Median of measured/sliced ratios over all parts using this filament."""
        rows = self.db.q("""SELECT p.id, p.line_item_id FROM printed_parts p WHERE p.filament_id=?""", [filament_id])
        ratios = []
        for r in rows:
            p = self.db.get("printed_parts", r["id"])
            pv = self._part_view(p)
            job = pv.get("slice")
            ws = self.db.q("SELECT grams FROM weigh_ins WHERE line_item_id=? ORDER BY date DESC, id DESC LIMIT 1", [r["line_item_id"]]) if r["line_item_id"] else []
            if job and job.get("status") == "done" and job.get("grams") and ws and not self.db.get("line_items", r["line_item_id"])["needs_reweigh"]:
                ratios.append(ws[0]["grams"] / job["grams"])
        ratios.sort()
        corr = {"n": len(ratios)}
        if ratios:
            mid = len(ratios) // 2
            med = ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2
            corr["factor"] = med
            corr["spread"] = (max(ratios) - min(ratios)) / 2 if len(ratios) > 1 else 0.0
            corr["ratios"] = ratios
        self.db.update("filaments", filament_id, {"correction_json": json.dumps(corr)})
        return corr

    def _backup_loop(self):
        while True:
            try:
                last = self.db.setting("last_backup", 0)
                if time.time() - last > 86400:
                    self.backup()
            except Exception:
                traceback.print_exc()
            time.sleep(3600)

    def backup(self) -> str:
        bdir = self.data_dir / "backups"
        bdir.mkdir(exist_ok=True)
        name = time.strftime(f"{paths.APP_SLUG}-%Y%m%d-%H%M%S")
        tmp = bdir / (name + "-db")
        tmp.mkdir(exist_ok=True)
        import sqlite3
        dst = sqlite3.connect(str(tmp / paths.DB_FILE))
        self.db._conn.backup(dst); dst.close()
        shutil.copytree(self.mesh_dir, tmp / "meshes", dirs_exist_ok=True)
        out = shutil.make_archive(str(bdir / name), "zip", tmp)
        shutil.rmtree(tmp)
        for old in sorted(bdir.glob(f"{paths.APP_SLUG}-*.zip"))[:-30]:
            old.unlink()
        self.db.set_setting("last_backup", time.time())
        return out

    def install_slicer_async(self, engine: str = "bambu"):
        if self.install_state["status"] == "running":
            return
        engine = engine if engine in ("bambu", "prusa") else "bambu"
        self.install_state = {"status": "running", "engine": engine, "message": "Starting", "progress": 0.0}

        def prog(msg, frac):
            self.install_state.update({"message": msg, "progress": frac})
            self.events.emit("install", self.install_state)
            if not re.match(r"(Downloading|Unpacking) \d+", msg):
                log.info("install %s: %s", engine, msg)

        def run():
            log.info("install %s: starting", engine)
            try:
                if engine == "bambu":
                    cmd = bambu_engine.install(prog)
                    ver = bambu_engine.version_of(cmd)
                    label = "Bambu Studio " + (ver or "")
                else:
                    cmd = slicer_engine.install(prog)
                    label = "PrusaSlicer " + (slicer_engine.version_of(cmd) or "")
                self.jobs.refresh_slicer()
                self.jobs.engine_status(force=True)
                self.install_state.update({"status": "done", "message": "Installed " + label, "progress": 1.0})
            except Exception as e:
                log.exception("install %s failed", engine)
                self.install_state.update({"status": "error", "message": str(e) or e.__class__.__name__})
            self.events.emit("install", self.install_state)
            self.events.emit("queue", self.jobs.queue_state())
        threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- router
class Handler(BaseHTTPRequestHandler):
    app: App = None  # set at startup
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        if os.environ.get("MAKEWEIGHT_DEBUG"):
            super().log_message(fmt, *args)

    # -- plumbing
    def _json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str, filename: str | None = None, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _jbody(self) -> dict:
        b = self._body()
        return json.loads(b.decode()) if b else {}

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        try:
            url = urllib.parse.urlparse(self.path)
            path = url.path
            qs = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if path.startswith("/api/"):
                api_path = path[5:].rstrip("/")
                if method in ("POST", "PUT", "DELETE") and not re.match(r"^(undo|redo|settings|slicer/|jobs|backup|log|diagnostics|meshes$|parts/\d+/(slice|orientation_sweep)$|robots/\d+/(optimize|slice_all|mesh_matches)$|runs/\d+/cancel$|filaments/\d+/recalc$)", api_path):
                    before = self.app.undo.snapshot()
                    try:
                        return self._api(method, api_path, qs)
                    finally:
                        try:
                            hint = self.headers.get("X-Undo-Label")
                            self.app.undo.record(before, method, api_path, urllib.parse.unquote(hint) if hint else None)
                        except Exception:  # noqa
                            log.exception("undo record failed")
                return self._api(method, api_path, qs)
            return self._static(path)
        except KeyError as e:
            self._json({"error": f"not found: {e}"}, 404)
        except (ValueError, RuntimeError, meshio.MeshFileMissing) as e:
            log.info("%s %s -> 400 %s", method, self.path, e)
            self._json({"error": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa
            log.exception("%s %s -> 500", method, self.path)
            try:
                self._json({"error": str(e), "trace": traceback.format_exc()[-2000:]}, 500)
            except Exception:
                pass

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[7:]
        f = (STATIC / rel).resolve()
        if not str(f).startswith(str(STATIC.resolve())) or not f.is_file():
            self._json({"error": "not found"}, 404); return
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        data = f.read_bytes()
        if f.name == "index.html":  # brand placeholders come from brand.json so a rename is a one-file change
            from . import paths
            data = data.replace(b"{{APP_NAME}}", paths.APP_NAME.encode()).replace(b"{{TAGLINE}}", (paths.BRAND.get("tagline") or "").encode())
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- API
    def _api(self, m, path, qs):
        app = self.app; db = app.db
        parts = path.split("/")
        r = lambda i: int(parts[i])  # noqa

        if path == "stream" and m == "GET":
            return self._sse()

        if path == "state":
            return self._json({
                "slicer": app.jobs.queue_state(), "install": app.install_state, "engines": app.jobs.engine_status(), "undo": app.undo.state(),
                "settings": {k: db.setting(k) for k in ("workers", "keep_gcode", "slicer_path", "bambu_path", "slicer_engine", "default_printer_id", "default_filament_id", "default_profile_id", "appearance", "update_repo")},
                "printers": [dict(p, nozzles=loads(p.pop("nozzles_json"), [0.4]), bed=loads(p.pop("bed_json"), {})) for p in db.q("SELECT * FROM printers ORDER BY id")],
                "filaments": [app._filament_view(f) for f in db.q("SELECT * FROM filaments ORDER BY builtin DESC, name")],
                "profiles": [app._profile_view(p) for p in db.q("SELECT * FROM profiles ORDER BY builtin DESC, name")],
                "robots": self._robot_list(), "update_repo": app.updater.repo(), "version": __import__("json").loads((Path(__file__).parent / "version.json").read_text())["version"], "root": str(app.root), "app": paths.BRAND, "install_dir": str(paths.install_dir()), "portable": paths.is_portable(),
                "classes": CLASSES,
            })
        if path == "settings" and m == "PUT":
            body = self._jbody()
            for k, v in body.items():
                db.set_setting(k, v)
            if "workers" in body:
                app.jobs.set_workers(int(body["workers"]))
            if "slicer_path" in body or "bambu_path" in body or "slicer_engine" in body:
                app.jobs.refresh_slicer()
                app.jobs.engine_status(force=True)
                if "slicer_engine" in body:
                    # jobs queued for the other engine are re-keyed when they run; make sure workers are awake
                    app.jobs.start()
            return self._json({"ok": True, "slicer": app.jobs.queue_state()})
        if path == "undo" and m == "GET":
            return self._json(app.undo.state())
        if path in ("undo", "redo") and m == "POST":
            act = app.undo.do_undo() if path == "undo" else app.undo.do_redo()
            if act:
                for pid in app.undo.affected_parts(act):
                    try:
                        app.current_slice_for_part(pid)
                    except Exception:  # noqa
                        pass
                self.app.events.emit("robot", {"robot_id": act.get("robot_id")})
            return self._json({"done": act["label"] if act else None, **app.undo.state()})
        if path == "update/check" and m == "POST":
            try:
                return self._json(app.updater.check())
            except Exception as e:  # noqa — offline / no repo / GitHub down: a plain answer, not a 500 in the log
                log.info("update check failed: %s", e)
                return self._json({"error": f"Could not check for updates: {e}"}, 502 if "quiet" not in qs else 200)
        if path == "update/status" and m == "GET":
            return self._json({"state": app.updater.state, "latest": app.updater.latest, "current": current_version(), "target": update_target(),
                               "repo": app.updater.repo(), "old_versions": app.updater.old_versions(), "portable": paths.is_portable()})
        if path == "update/start" and m == "POST":
            def stop():
                try:
                    if app.httpd is not None:
                        app.httpd.shutdown(); app.httpd.server_close()
                except Exception:  # noqa
                    log.exception("httpd stop failed")
            try:
                app.updater.port = app.httpd.server_address[1] if app.httpd is not None else None
            except Exception:  # noqa
                app.updater.port = None
            started = app.updater.start(stop)
            return self._json({"started": started, "state": app.updater.state})
        if path == "log" and m == "GET":
            n = int(qs.get("n") or 400)
            return self._json({"lines": applog.tail(n), "file": str(applog.log_file() or "")})
        if path == "diagnostics" and m == "GET":
            return self._bytes(applog.bundle(app), "application/zip", f"{paths.APP_SLUG}-diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.zip")
        if path == "environment" and m == "GET":
            return self._json(applog.environment(app))
        if path == "slicer/install" and m == "POST":
            b = self._jbody(); app.install_slicer_async(b.get("engine") or "bambu"); return self._json(app.install_state)
        if path == "slicer/refresh" and m == "POST":
            r_ = app.jobs.refresh_slicer(); r_["engines"] = app.jobs.engine_status(force=True); return self._json(r_)
        if path == "import/archive" and m == "POST":
            return self._json(exports.import_archive(self, self._body()))
        if path == "backup" and m == "POST":
            return self._json({"file": app.backup()})

        # ---- robots
        if path == "robots" and m == "GET":
            return self._json(self._robot_list())
        if path == "robots" and m == "POST":
            b = self._jbody()
            rid = db.insert("robots", {"name": b.get("name") or "New robot", "weight_class_g": float(b.get("weight_class_g") or 453.592),
                                       "class_name": b.get("class_name"), "margin_g": float(b.get("margin_g") if b.get("margin_g") is not None else round(float(b.get("weight_class_g") or 453.592) * 0.01, 1)),
                                       "printer_id": b.get("printer_id") or db.setting("default_printer_id"), "nozzle": b.get("nozzle") or 0.4,
                                       "status": "active", "notes": b.get("notes"), "created": now(), "updated": now()})
            for i, name in enumerate(b.get("sections") or ["Drive", "Electrical", "Weapon", "Misc Hardware", "Printed Parts", "Spares"]):
                db.insert("sections", {"robot_id": rid, "name": name, "ord": i, "counts": 0 if name.lower().startswith("spare") else 1})
            return self._json(app.robot_detail(rid))
        if parts[0] == "robots" and len(parts) >= 2:
            rid = r(1)
            if len(parts) == 2:
                if m == "GET":
                    return self._json(app.robot_detail(rid))
                if m == "PUT":
                    b = self._jbody(); allowed = {"name", "weight_class_g", "class_name", "margin_g", "printer_id", "nozzle", "status", "notes"}
                    db.update("robots", rid, {k: v for k, v in b.items() if k in allowed} | {"updated": now()})
                    return self._json(app.robot_detail(rid))
                if m == "DELETE":
                    self._delete_robot(rid); return self._json({"ok": True})
            sub = parts[2]
            if sub == "duplicate" and m == "POST":
                return self._json(app.robot_detail(self._duplicate_robot(rid, self._jbody().get("name"))))
            if sub == "sections" and m == "POST":
                b = self._jbody()
                n = db.one("SELECT COALESCE(MAX(ord),-1)+1 o FROM sections WHERE robot_id=?", [rid])["o"]
                sid = db.insert("sections", {"robot_id": rid, "name": b.get("name") or "Section", "ord": n, "counts": 1 if b.get("counts", True) else 0})
                return self._json(db.get("sections", sid))
            if sub == "weighin" and m == "POST":
                b = self._jbody(); det = app.robot_detail(rid)
                run_id = db.insert("runs", {"robot_id": rid, "kind": "weigh-in", "date": now(), "name": "Whole-robot weigh-in",
                                            "inputs_json": json.dumps({"grams": b["grams"], "note": b.get("note")}),
                                            "results_json": json.dumps({"sheet_total": det["totals"]["best_known"], "drift": det["totals"]["best_known"] - float(b["grams"])})})
                return self._json(db.get("runs", run_id))
            if sub == "events":
                if m == "GET":
                    return self._json(db.q("SELECT * FROM events WHERE robot_id=? ORDER BY date DESC, id DESC", [rid]))
                b = self._jbody(); det = app.robot_detail(rid)
                eid = db.insert("events", {"robot_id": rid, "date": b.get("date") or time.strftime("%Y-%m-%d"), "title": b.get("title"),
                                           "placing": b.get("placing"), "notes": b.get("notes"), "total_snapshot_g": b.get("total_snapshot_g", det["totals"]["best_known"])})
                return self._json(db.get("events", eid))
            if sub == "parts" and m == "POST":
                return self._json(self._create_part(rid, self._jbody()))
            if sub == "mesh_matches" and m == "POST":
                return self._json(self._mesh_matches(rid, [int(x) for x in (self._jbody().get("mesh_ids") or [])]))
            if sub == "import3mf" and m == "POST":
                return self._json(self._import_3mf(rid, self._body(), urllib.parse.unquote(self.headers.get("X-Filename") or "project.3mf")))
            if sub == "runs" and m == "GET":
                rows = db.q("SELECT * FROM runs WHERE robot_id=? ORDER BY date DESC", [rid])
                for x in rows:
                    x["inputs"] = loads(x.pop("inputs_json"), {}); x["results"] = loads(x.pop("results_json"), {})
                return self._json(rows)
            if sub == "optimize" and m == "POST":
                b = self._jbody()
                run_id = optimizer.start_optimization(app, rid, b)
                return self._json(db.get("runs", run_id))
            if sub == "slice_all" and m == "POST":
                ps = db.q("SELECT id FROM printed_parts WHERE robot_id=?", [rid])
                out = [app.current_slice_for_part(p["id"]) for p in ps]
                return self._json({"queued": len([o for o in out if o])})
            if sub == "export":
                return self._export(rid, parts[3] if len(parts) > 3 else "csv", qs)

        # ---- sections / items / weigh-ins / events
        if parts[0] == "sections" and len(parts) == 2:
            sid = r(1)
            if m == "PUT":
                b = self._jbody(); db.update("sections", sid, {k: (int(bool(v)) if k == "counts" else v) for k, v in b.items() if k in ("name", "ord", "counts")})
                return self._json(db.get("sections", sid))
            if m == "DELETE":
                items = db.q("SELECT id FROM line_items WHERE section_id=?", [sid])
                for it in items:
                    self._delete_item(it["id"])
                db.delete("sections", sid); return self._json({"ok": True})
        if parts[0] == "sections" and len(parts) == 3 and parts[2] == "items" and m == "POST":
            sid = r(1); b = self._jbody()
            return self._json(self._create_item(sid, b))
        if parts[0] == "items":
            iid = r(1)
            if len(parts) == 2:
                if m == "PUT":
                    return self._json(self._update_item(iid, self._jbody()))
                if m == "DELETE":
                    self._delete_item(iid); return self._json({"ok": True})
            if parts[2] == "weighins" and m == "POST":
                b = self._jbody(); it = db.get("line_items", iid)
                if not it:
                    raise KeyError("item")
                pstr = None
                pp = db.one("SELECT * FROM printed_parts WHERE line_item_id=?", [iid])
                if pp and pp.get("profile_id"):
                    prof = db.get("profiles", pp["profile_id"])
                    pstr = profiles.profile_string(loads(prof["params_json"], {})) if prof else None
                wid = db.insert("weigh_ins", {"line_item_id": iid, "grams": float(b["grams"]), "date": b.get("date") or time.strftime("%Y-%m-%d"), "note": b.get("note"), "profile_string": pstr})
                db.update("line_items", iid, {"needs_reweigh": 0})
                if it.get("component_id") and b.get("update_library"):
                    db.update("components", it["component_id"], {"grams": float(b["grams"]), "grams_source": "measured", "updated": now()})
                    db.insert("component_weighins", {"component_id": it["component_id"], "grams": float(b["grams"]), "date": b.get("date") or time.strftime("%Y-%m-%d")})
                if pp and pp.get("filament_id"):
                    app.recalc_filament_correction(pp["filament_id"])
                return self._json(db.get("weigh_ins", wid))
            if parts[2] == "move" and m == "POST":
                b = self._jbody(); db.update("line_items", iid, {"section_id": int(b["section_id"])}); return self._json({"ok": True})
        if parts[0] == "weighins" and m == "DELETE":
            w = db.get("weigh_ins", r(1))
            db.delete("weigh_ins", r(1))
            if w:
                pp = db.one("SELECT filament_id FROM printed_parts WHERE line_item_id=?", [w["line_item_id"]])
                if pp and pp.get("filament_id"):
                    app.recalc_filament_correction(pp["filament_id"])
            return self._json({"ok": True})
        if parts[0] == "events" and len(parts) == 2:
            eid = r(1)
            if m == "PUT":
                b = self._jbody(); db.update("events", eid, {k: v for k, v in b.items() if k in ("date", "title", "placing", "notes", "total_snapshot_g")}); return self._json(db.get("events", eid))
            if m == "DELETE":
                db.delete("events", eid); return self._json({"ok": True})

        # ---- library
        if parts[0] == "components":
            if len(parts) == 1:
                if m == "GET":
                    rows = db.q("SELECT c.*, (SELECT COUNT(*) FROM line_items li WHERE li.component_id=c.id) uses FROM components c ORDER BY category, name")
                    return self._json(rows)
                b = self._jbody()
                cid = db.insert("components", {k: b.get(k) for k in ("name", "category", "vendor", "link", "price", "dimensions", "grams", "grams_source", "notes")} | {"created": now(), "updated": now()})
                return self._json(db.get("components", cid))
            cid = r(1)
            if len(parts) == 2 and m == "PUT":
                b = self._jbody()
                db.update("components", cid, {k: v for k, v in b.items() if k in ("name", "category", "vendor", "link", "price", "dimensions", "grams", "grams_source", "notes")} | {"updated": now()})
                if b.get("propagate") and b.get("grams") is not None:
                    db.x("UPDATE line_items SET est_grams=?, est_source='library' WHERE component_id=?", [float(b["grams"]), cid])
                return self._json(db.get("components", cid))
            if len(parts) == 2 and m == "DELETE":
                db.x("UPDATE line_items SET component_id=NULL WHERE component_id=?", [cid]); db.delete("components", cid); return self._json({"ok": True})
            if parts[2] == "weighins":
                if m == "GET":
                    return self._json(db.q("SELECT * FROM component_weighins WHERE component_id=? ORDER BY date DESC", [cid]))
                b = self._jbody()
                db.insert("component_weighins", {"component_id": cid, "grams": float(b["grams"]), "date": b.get("date") or time.strftime("%Y-%m-%d"), "note": b.get("note")})
                db.update("components", cid, {"grams": float(b["grams"]), "grams_source": "measured", "updated": now()})
                if b.get("propagate", True):
                    db.x("UPDATE line_items SET est_grams=?, est_source='library' WHERE component_id=?", [float(b["grams"]), cid])
                return self._json(db.get("components", cid))
        if parts[0] == "filaments":
            if len(parts) == 2 and parts[1] == "import" and m == "POST":
                return self._json(self._import_filaments(self._body(), urllib.parse.unquote(self.headers.get("X-Filename") or "")))
            if len(parts) == 1 and m == "POST":
                b = self._jbody()
                fid = db.insert("filaments", {"name": b["name"], "material": b.get("material"), "density": float(b["density"]), "flow": float(b.get("flow") or 1.0),
                                              "color": b.get("color"), "cost_per_kg": b.get("cost_per_kg"), "notes": b.get("notes"), "max_vol_speed": b.get("max_vol_speed") or 12, "correction_json": "{}", "builtin": 0})
                return self._json(app._filament_view(db.get("filaments", fid)))
            fid = r(1)
            if m == "PUT":
                b = self._jbody()
                upd = {k: v for k, v in b.items() if k in ("name", "material", "density", "flow", "color", "cost_per_kg", "notes", "max_vol_speed")}
                if b.get("reset_correction"):
                    upd["correction_json"] = "{}"
                db.update("filaments", fid, upd)
                if "density" in b or "flow" in b or "max_vol_speed" in b:
                    for p in db.q("SELECT id FROM printed_parts WHERE filament_id=?", [fid]):
                        app.current_slice_for_part(p["id"])
                return self._json(app._filament_view(db.get("filaments", fid)))
            if m == "DELETE":
                if db.one("SELECT 1 FROM printed_parts WHERE filament_id=?", [fid]):
                    raise ValueError("Filament is in use by printed parts")
                db.delete("filaments", fid); return self._json({"ok": True})
            if len(parts) == 3 and parts[2] == "recalc" and m == "POST":
                return self._json(app.recalc_filament_correction(fid))
        if parts[0] == "profiles":
            if len(parts) == 1 and m == "POST":
                b = self._jbody()
                pid = db.insert("profiles", {"name": b.get("name") or "Profile", "printer_id": b.get("printer_id"), "nozzle": float(b.get("nozzle") or (b.get("params") or {}).get("nozzle") or 0.4),
                                             "params_json": json.dumps(profiles.normalize(b.get("params") or {})), "builtin": 0, "notes": b.get("notes")})
                return self._json(app._profile_view(db.get("profiles", pid)))
            pid = r(1)
            if len(parts) == 2 and m == "GET":
                return self._json(app._profile_view(db.get("profiles", pid)))
            if len(parts) == 2 and m == "PUT":
                b = self._jbody(); upd = {k: v for k, v in b.items() if k in ("name", "printer_id", "nozzle", "notes")}
                if "params" in b:
                    upd["params_json"] = json.dumps(profiles.normalize(b["params"]))
                db.update("profiles", pid, upd)
                if "params" in b:
                    for p in db.q("SELECT id FROM printed_parts WHERE profile_id=?", [pid]):
                        self._flag_reweigh_for_part(p["id"]); app.current_slice_for_part(p["id"])
                return self._json(app._profile_view(db.get("profiles", pid)))
            if len(parts) == 2 and m == "DELETE":
                if db.one("SELECT 1 FROM printed_parts WHERE profile_id=?", [pid]):
                    raise ValueError("Profile is in use by printed parts")
                db.delete("profiles", pid); return self._json({"ok": True})
            if len(parts) == 3 and parts[2] == "prusa.ini":
                prof = db.get("profiles", pid); fil = db.get("filaments", int(qs.get("filament") or (db.setting("default_filament_id") or 1)))
                pr = db.get("printers", prof["printer_id"]) if prof.get("printer_id") else db.one("SELECT * FROM printers ORDER BY builtin DESC, id LIMIT 1")
                return self._bytes(profiles.to_prusa_ini(loads(prof["params_json"], {}), fil, app.jobs.slicer_version, machine=profiles.machine_key(pr["name"] if pr else None)).encode(), "text/plain", f"{prof['name']}.ini")
            if len(parts) == 3 and parts[2] == "bambu.json":
                prof = db.get("profiles", pid); pr = db.get("printers", prof["printer_id"]) if prof.get("printer_id") else db.one("SELECT * FROM printers ORDER BY builtin DESC, id LIMIT 1")
                if app.jobs.presets is not None:
                    # the exact process preset the Bambu engine slices with (Bambu's own system preset + this profile)
                    data = app.jobs.presets.process_for(loads(prof["params_json"], {}), profiles.machine_key(pr["name"] if pr else None))
                    data["name"] = prof["name"]; data["print_settings_id"] = prof["name"]; data["from"] = "User"; data["is_custom_defined"] = "0"
                else:
                    data = profiles.to_bambu_preset(loads(prof["params_json"], {}), prof["name"], pr["name"] if pr else "Bambu Lab P1S")
                return self._bytes(json.dumps(data, indent=2).encode(), "application/json", f"{prof['name']}.json")
        if parts[0] == "printers":
            if len(parts) == 1 and m == "POST":
                b = self._jbody()
                pid = db.insert("printers", {"name": b["name"], "nozzles_json": json.dumps(b.get("nozzles") or [0.4]), "bed_json": json.dumps(b.get("bed") or {"x": 256, "y": 256, "z": 256})})
                return self._json(db.get("printers", pid))
            pid = r(1)
            if m == "PUT":
                b = self._jbody(); upd = {}
                if "name" in b: upd["name"] = b["name"]
                if "nozzles" in b: upd["nozzles_json"] = json.dumps(b["nozzles"])
                if "bed" in b: upd["bed_json"] = json.dumps(b["bed"])
                db.update("printers", pid, upd); return self._json(db.get("printers", pid))
            if m == "DELETE":
                db.delete("printers", pid); return self._json({"ok": True})

        # ---- meshes
        if path == "meshes" and m == "POST":
            fname = urllib.parse.unquote(self.headers.get("X-Filename") or "part.stl")
            data = self._body()
            return self._json(self._store_mesh(fname, data, split=qs.get("split") == "1"))
        if parts[0] == "meshes" and len(parts) == 3:
            mesh = db.get("meshes", r(1))
            if not mesh:
                raise KeyError("mesh")
            if parts[2] == "thumb.png":
                tdir = app.root / "data" / "work" / "thumbs"; tdir.mkdir(parents=True, exist_ok=True)
                f = tdir / f"{mesh['sha256'][:24]}.png"
                if not f.exists():
                    with self._thumb_lock:                       # one render at a time: six 1.5M-triangle bodies in parallel is what froze the app
                        if not f.exists():
                            f.write_bytes(meshio.render_thumbnail(app.preview_mesh(mesh)))
                return self._bytes(f.read_bytes(), "image/png")
            if parts[2] == "stl":
                # ?lod=1: a decimated copy for on-screen previews (the slicer always gets the real file)
                tri = app.preview_mesh(mesh) if qs.get("lod") else meshio.load_mesh(meshio.mesh_path(mesh))
                if qs.get("part"):
                    p = db.get("printed_parts", int(qs["part"]))
                    tri = orient.apply_orientation(tri, loads(p["orient_json"], {}), float(p.get("scale") or 1.0), bool(p.get("mirror")))
                return self._bytes(meshio.to_binary_stl_bytes(tri), "model/stl")

        # ---- parts
        if parts[0] == "parts":
            pid = r(1)
            p = db.get("printed_parts", pid)
            if not p:
                raise KeyError("part")
            if len(parts) == 2:
                if m == "GET":
                    v = app._part_view(p)
                    jobs = db.q("SELECT * FROM slice_jobs WHERE part_id=? ORDER BY id DESC LIMIT 300", [pid])
                    # name the profile each job used (by parameter hash) so the sweep table can say "Chassis 5W" rather than a bare string
                    by_hash = {}
                    for pr in db.q("SELECT id, name, params_json FROM profiles"):
                        by_hash.setdefault(profiles.profile_hash(loads(pr["params_json"], {})), pr["name"])
                    for j in jobs:
                        params = loads(j.get("profile_json"), None)
                        j["profile_name"] = by_hash.get(profiles.profile_hash(params)) if params else None
                        fk = (j.get("filament_key") or "").split("|")
                        j["filament_name"] = fk[4] if len(fk) > 4 else (f"{fk[0]} g/cm³" if fk and fk[0] else "")
                        j["engine"] = "Bambu Studio" if (j.get("slicer_version") or "").startswith("bambu-") else "PrusaSlicer"
                    v["jobs"] = jobs
                    return self._json(v)
                if m == "PUT":
                    return self._json(self._update_part(pid, self._jbody()))
                if m == "DELETE":
                    if p.get("line_item_id"):
                        self._delete_item(p["line_item_id"])
                    else:
                        db.delete("printed_parts", pid)
                    return self._json({"ok": True})
            sub = parts[2]
            if sub == "slice" and m == "POST":
                b = self._jbody()
                fil = db.get("filaments", b.get("filament_id") or p["filament_id"])
                params = b.get("params") or loads(db.get("profiles", b.get("profile_id") or p["profile_id"])["params_json"], {})
                job = app.jobs.ensure_slice(p, params, fil, purpose=b.get("purpose") or "sweep", priority=int(b.get("priority") or 5))
                return self._json(job)
            if sub == "auto_orient" and m == "POST":
                mesh = db.get("meshes", p["mesh_id"])
                tri = app.preview_mesh(mesh)                    # candidate orientations come from the shape, not the tessellation
                if p.get("mirror"):
                    tri = meshio.transform(tri, None, 1.0, True)
                cands = orient.auto_orient(tri)
                if self._jbody().get("apply", True) and cands:
                    self._update_part(pid, {"orient": {"mode": "auto", "quat": cands[0]["quat"], "label": cands[0]["label"]}})
                return self._json({"candidates": cands[:12], "part": app._part_view(db.get("printed_parts", pid))})
            if sub == "lay_on_face" and m == "POST":
                b = self._jbody()
                R = orient.rotation_face_down(b["normal"])
                # compose with current orientation: normal is given in the currently displayed (oriented) frame
                import numpy as np
                cur = meshio.quat_to_mat(loads(p["orient_json"], {}).get("quat", [0, 0, 0, 1]))
                q = meshio.mat_to_quat(R @ cur)
                return self._json(self._update_part(pid, {"orient": {"mode": "manual", "quat": q, "label": "face down"}}))
            if sub == "rotate" and m == "POST":
                b = self._jbody()
                import numpy as np
                ax = {"x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]}[b["axis"]]
                R = meshio.axis_angle(ax, float(b["degrees"]) * np.pi / 180)
                cur = meshio.quat_to_mat(loads(p["orient_json"], {}).get("quat", [0, 0, 0, 1]))
                return self._json(self._update_part(pid, {"orient": {"mode": "manual", "quat": meshio.mat_to_quat(R @ cur), "label": "manual"}}))
            if sub == "preset" and m == "POST":
                b = self._jbody()
                if b["name"] == "imported":
                    q = [0, 0, 0, 1]
                else:
                    q = orient.quat_for_preset(b["name"])
                return self._json(self._update_part(pid, {"orient": {"mode": "preset", "quat": q, "label": b["name"]}}))
            if sub == "orientation_sweep" and m == "POST":
                mesh = db.get("meshes", p["mesh_id"]); tri = app.preview_mesh(mesh)
                if p.get("mirror"):
                    tri = meshio.transform(tri, None, 1.0, True)
                cands = orient.auto_orient(tri)[:6]
                prof = db.get("profiles", p["profile_id"]); fil = db.get("filaments", p["filament_id"])
                out = []
                for c in cands:
                    fake = dict(p); fake["orient_json"] = json.dumps({"quat": c["quat"]})
                    job = app.jobs.ensure_slice(fake, loads(prof["params_json"], {}), fil, purpose="orient", priority=6)
                    out.append({"candidate": c, "job": job})
                return self._json(out)
            if sub == "jobs" and m == "GET":
                return self._json(db.q("SELECT * FROM slice_jobs WHERE part_id=? ORDER BY id DESC LIMIT 300", [pid]))
            if sub == "layers" and m == "GET":
                from . import estimator
                prof = db.get("profiles", p["profile_id"]); params = profiles.normalize(loads(prof["params_json"], {}))
                rm = app.region_model(p, params, wait=bool(qs.get("wait")))
                if rm is None:
                    return self._json({"building": True}, 202)
                T, B = profiles.effective_shell_layers(params)
                info = {"n_layers": rm.n, "layer_height": rm.layer_h, "pitch": rm.pitch, "width_px": rm.masks.shape[2], "height_px": rm.masks.shape[1], "walls": params["walls"], "top": T, "bottom": B}
                if "i" in qs:
                    i = max(0, min(rm.n - 1, int(qs["i"])))
                    cls = estimator.layer_classification(rm, params["walls"], T, B, i)
                    png = estimator.png_from_classes(cls, {1: (217, 95, 27, 255), 2: (53, 82, 110, 255), 3: (197, 210, 222, 255), 4: (120, 140, 160, 255)})
                    return self._bytes(png, "image/png")
                return self._json(info)
            if sub == "mirror_copy" and m == "POST":
                return self._json(self._mirror_copy(pid, self._jbody().get("name")))

        # ---- jobs
        if path == "jobs" and m == "GET":
            st = qs.get("status")
            if st:
                rows = db.q("SELECT j.*, p.robot_id, li.description part_name FROM slice_jobs j LEFT JOIN printed_parts p ON p.id=j.part_id LEFT JOIN line_items li ON li.id=p.line_item_id WHERE j.status=? ORDER BY j.priority, j.id DESC LIMIT 200", [st])
            else:
                rows = db.q("SELECT j.*, p.robot_id, li.description part_name FROM slice_jobs j LEFT JOIN printed_parts p ON p.id=j.part_id LEFT JOIN line_items li ON li.id=p.line_item_id WHERE j.status IN ('queued','running') OR j.id IN (SELECT id FROM slice_jobs ORDER BY id DESC LIMIT 40) ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, j.priority, j.id DESC LIMIT 120")
            stats = db.one("SELECT COUNT(*) n, COALESCE(SUM(time_s),0) t FROM slice_jobs WHERE status='done'")
            return self._json({"jobs": rows, "state": app.jobs.queue_state(), "cache": {"done": stats["n"], "time_s": stats["t"]}})
        if path == "jobs/delete" and m == "POST":
            ids = [int(i) for i in (self._jbody().get("ids") or [])]
            if ids:
                db.x(f"DELETE FROM slice_jobs WHERE status IN ('done','error','cancelled') AND id IN ({','.join('?' for _ in ids)})", ids)
            return self._json({"ok": True, "deleted": len(ids)})
        if re.match(r"^jobs/\d+$", path) and m == "DELETE":
            jid = int(path.split("/")[1]); db.x("DELETE FROM slice_jobs WHERE id=? AND status IN ('done','error','cancelled')", [jid]); return self._json({"ok": True})
        if path == "jobs/cancel" and m == "POST":
            b = self._jbody(); app.jobs.cancel_queued(b.get("run_id"), b.get("part_id")); return self._json({"ok": True})
        if path == "jobs/clear_cache" and m == "POST":
            db.x("DELETE FROM slice_jobs WHERE status IN ('done','error','cancelled')"); return self._json({"ok": True})
        if path == "jobs/retry_errors" and m == "POST":
            b = self._jbody()
            if b.get("part_id"):
                db.x("UPDATE slice_jobs SET status='queued', error=NULL WHERE status='error' AND part_id=?", [b["part_id"]])
            else:
                db.x("UPDATE slice_jobs SET status='queued', error=NULL WHERE status='error'")
            app.jobs.start(); return self._json({"ok": True})

        # ---- runs
        if parts[0] == "runs":
            run_id = r(1)
            run = db.get("runs", run_id)
            if not run:
                raise KeyError("run")
            if len(parts) == 2 and m == "GET":
                run["inputs"] = loads(run.pop("inputs_json"), {}); run["results"] = loads(run.pop("results_json"), {})
                return self._json(run)
            if len(parts) == 2 and m == "DELETE":
                app.jobs.cancel_queued(run_id=run_id); db.delete("runs", run_id); return self._json({"ok": True})
            if len(parts) == 3 and parts[2] == "apply" and m == "POST":
                b = self._jbody()
                return self._json(optimizer.apply_plan(app, run_id, int(b.get("plan", 0))))
            if len(parts) == 3 and parts[2] == "cancel" and m == "POST":
                optimizer.cancel(app, run_id); return self._json({"ok": True})

        raise KeyError(path)

    # ------------------------------------------------------------ SSE
    def _sse(self):
        q = self.app.events.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(b": hello\n\n"); self.wfile.flush()
            last = time.time()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode()); self.wfile.flush()
                except Exception:
                    if time.time() - last > 15:
                        self.wfile.write(b": ping\n\n"); self.wfile.flush(); last = time.time()
        except Exception:
            pass
        finally:
            self.app.events.unsubscribe(q)

    # ------------------------------------------------------------ mutations
    def _robot_list(self):
        rows = self.app.db.q("SELECT * FROM robots ORDER BY status='active' DESC, updated DESC")
        out = []
        for rb in rows:
            det = self.app.robot_detail(rb["id"])
            n_parts = sum(1 for s in det["sections"] for it in s["items"] if it.get("part"))
            out.append({k: rb[k] for k in rb} | {"totals": det["totals"], "printed_parts": n_parts})
        return out

    def _create_item(self, sid: int, b: dict) -> dict:
        db = self.app.db
        n = db.one("SELECT COALESCE(MAX(ord),-1)+1 o FROM line_items WHERE section_id=?", [sid])["o"]
        row = {"section_id": sid, "ord": n, "qty": float(b.get("qty") or 1), "description": b.get("description") or "",
               "purpose": b.get("purpose"), "link": b.get("link"), "dimensions": b.get("dimensions"), "price": b.get("price"),
               "est_grams": b.get("est_grams"), "est_source": b.get("est_source") or "manual", "component_id": b.get("component_id"),
               "status": b.get("status"), "notes": b.get("notes"), "to_buy": 1 if b.get("to_buy") else 0, "counted": 0 if b.get("counted") is False else 1}
        if b.get("component_id"):
            c = db.get("components", int(b["component_id"]))
            if c:
                row.setdefault("description", c["name"]); row["description"] = row["description"] or c["name"]
                if row["est_grams"] is None:
                    row["est_grams"] = c["grams"]; row["est_source"] = "library"
                row["link"] = row["link"] or c["link"]; row["price"] = row["price"] if row["price"] is not None else c["price"]
                row["dimensions"] = row["dimensions"] or c["dimensions"]
        iid = db.insert("line_items", row)
        if b.get("measured_grams") is not None:
            db.insert("weigh_ins", {"line_item_id": iid, "grams": float(b["measured_grams"]), "date": time.strftime("%Y-%m-%d")})
        sec = db.get("sections", sid); db.update("robots", sec["robot_id"], {"updated": now()})
        return db.get("line_items", iid)

    def _update_item(self, iid: int, b: dict) -> dict:
        db = self.app.db
        allowed = {"qty", "description", "purpose", "link", "dimensions", "price", "est_grams", "est_source", "component_id", "status", "notes", "needs_reweigh", "to_buy", "counted", "ord", "section_id"}
        upd = {k: v for k, v in b.items() if k in allowed}
        if "est_grams" in upd and "est_source" not in upd:
            upd["est_source"] = "manual"
        for k in ("needs_reweigh", "to_buy", "counted"):
            if k in upd:
                upd[k] = 1 if upd[k] else 0
        db.update("line_items", iid, upd)
        return db.get("line_items", iid)

    def _delete_item(self, iid: int):
        db = self.app.db
        db.x("DELETE FROM weigh_ins WHERE line_item_id=?", [iid])
        pp = db.one("SELECT id FROM printed_parts WHERE line_item_id=?", [iid])
        if pp:
            self.app.jobs.cancel_queued(part_id=pp["id"])
            db.delete("printed_parts", pp["id"])
        db.delete("line_items", iid)

    def _delete_robot(self, rid: int):
        db = self.app.db
        for s in db.q("SELECT id FROM sections WHERE robot_id=?", [rid]):
            for it in db.q("SELECT id FROM line_items WHERE section_id=?", [s["id"]]):
                self._delete_item(it["id"])
            db.delete("sections", s["id"])
        db.x("DELETE FROM printed_parts WHERE robot_id=?", [rid])
        db.x("DELETE FROM runs WHERE robot_id=?", [rid]); db.x("DELETE FROM events WHERE robot_id=?", [rid])
        db.delete("robots", rid)

    def _duplicate_robot(self, rid: int, name: str | None) -> int:
        db = self.app.db
        src = db.get("robots", rid)
        new = {k: src[k] for k in src if k != "id"} | {"name": name or (src["name"] + " copy"), "created": now(), "updated": now(), "status": "active"}
        nid = db.insert("robots", new)
        for s in db.q("SELECT * FROM sections WHERE robot_id=? ORDER BY ord", [rid]):
            nsid = db.insert("sections", {"robot_id": nid, "name": s["name"], "ord": s["ord"], "counts": s["counts"]})
            for it in db.q("SELECT * FROM line_items WHERE section_id=? ORDER BY ord", [s["id"]]):
                row = {k: it[k] for k in it if k != "id"} | {"section_id": nsid}
                niid = db.insert("line_items", row)
                for w in db.q("SELECT * FROM weigh_ins WHERE line_item_id=?", [it["id"]]):
                    db.insert("weigh_ins", {k: w[k] for k in w if k != "id"} | {"line_item_id": niid})
                pp = db.one("SELECT * FROM printed_parts WHERE line_item_id=?", [it["id"]])
                if pp:
                    db.insert("printed_parts", {k: pp[k] for k in pp if k != "id"} | {"robot_id": nid, "line_item_id": niid})
        for e in db.q("SELECT * FROM events WHERE robot_id=?", [rid]):
            db.insert("events", {k: e[k] for k in e if k != "id"} | {"robot_id": nid})
        return nid

    _mesh_lock = threading.Lock()
    _thumb_lock = threading.Lock()

    def _store_mesh(self, fname: str, data: bytes, split: bool = False) -> dict:
        # big CAD exports (hundreds of MB, millions of triangles) peak at several times their size in memory while
        # being split: one at a time, and hand memory back afterwards
        with self._mesh_lock:
            try:
                return self._store_mesh_inner(fname, data, split)
            finally:
                import gc
                gc.collect()

    def _store_mesh_inner(self, fname: str, data: bytes, split: bool = False) -> dict:
        db = self.app.db
        names: list[str] = []
        if split and fname.lower().endswith(".3mf"):
            # a 3MF already knows its objects (and their names): one body per object, no connectivity guessing
            objs = [o for o in meshio.load_3mf_objects(data) if o.get("tri") is not None and len(o["tri"])]
            bodies = [o["tri"] for o in objs]
            names = [str(o.get("name") or "").strip() for o in objs]
            if not bodies:
                bodies = [meshio.load_mesh(fname, data)]
        else:
            tri = meshio.load_mesh(fname, data)
            bodies = [tri]
            if split:
                t0 = time.time()
                bodies = meshio.split_bodies_by_edges(tri)
                bodies = [b for b in bodies if meshio.volume_mm3(b) > 1.0] or [tri]
                log.info("split %s (%d triangles) into %d bodies in %.1fs", fname, len(tri), len(bodies), time.time() - t0)
        out = []
        for i, b in enumerate(bodies):
            blob = meshio.to_binary_stl_bytes(b) if (len(bodies) > 1 or not fname.lower().endswith(".stl")) else data
            sha = meshio.sha256_of(blob)
            ex = db.one("SELECT * FROM meshes WHERE sha256=?", [sha])
            if ex:
                row = dict(ex) | {"bbox": loads(ex["bbox_json"], None), "existing": True}
                if i < len(names) and names[i]:
                    row["body_name"] = names[i]
                out.append(row); continue
            bname = names[i] if i < len(names) and names[i] else ""
            name = fname if len(bodies) == 1 else (f"{re.sub(r'[^A-Za-z0-9._ -]+', '_', bname)}.stl" if bname else f"{Path(fname).stem}_body{i + 1}.stl")
            path = self.app.mesh_dir / f"{sha[:16]}_{re.sub(r'[^A-Za-z0-9._-]+', '_', name)}"
            if not path.suffix.lower() == ".stl":
                path = path.with_suffix(".stl")
            path.write_bytes(blob)
            a = meshio.analyze(b)
            mid = db.insert("meshes", {"sha256": sha, "filename": name, "path": str(path), "triangles": a["triangles"], "volume_mm3": a["volume_mm3"],
                                       "bbox_json": json.dumps(a["bbox"]), "watertight": 1 if a["watertight"] else 0, "bodies": a["bodies"], "created": now()})
            row = db.get("meshes", mid); row["bbox"] = a["bbox"]; row["units_scale_guess"] = a["units_scale_guess"]; row["area_mm2"] = a["area_mm2"]
            if bname:
                row["body_name"] = bname
            out.append(row)
        return {"meshes": out}

    def _mesh_matches(self, rid: int, mesh_ids: list[int]) -> dict:
        """For each uploaded body, which printed part of this robot it most likely replaces. Compared against each
        part's current mesh by volume and sorted bounding-box dimensions (a re-export of the same part changes those
        very little; a different part rarely agrees on all four), and by name when the body has one (3MF objects)."""
        db = self.app.db
        parts = db.q("SELECT p.id, p.mesh_id, li.description FROM printed_parts p JOIN line_items li ON li.id=p.line_item_id WHERE p.robot_id=? AND p.mesh_id IS NOT NULL", [rid])
        cur = {}
        for pt in parts:
            m = db.get("meshes", pt["mesh_id"])
            if m:
                bb = loads(m["bbox_json"], None) or {}
                cur[pt["id"]] = {"desc": pt["description"], "sha": m["sha256"], "vol": float(m["volume_mm3"] or 0), "dims": sorted(float(x) for x in (bb.get("size") or [0, 0, 0])), "fname": m["filename"]}

        def norm(t):
            return re.sub(r"[^a-z0-9]+", " ", str(t or "").lower().replace(".stl", "")).strip()

        results = []
        for mid in mesh_ids:
            m = db.get("meshes", int(mid))
            if not m:
                continue
            bb = loads(m["bbox_json"], None) or {}
            vol = float(m["volume_mm3"] or 0); dims = sorted(float(x) for x in (bb.get("size") or [0, 0, 0]))
            best = None
            for pid, c in cur.items():
                if c["sha"] == m["sha256"]:
                    best = {"part_id": pid, "score": 1.0, "why": "identical file"}; break
                dv = abs(vol - c["vol"]) / max(vol, c["vol"], 1e-9)
                dd = max(abs(a - b) / max(a, b, 1e-9) for a, b in zip(dims, c["dims"])) if all(c["dims"]) else 1.0
                geo = max(0.0, 1.0 - dv / 0.10) * max(0.0, 1.0 - dd / 0.10)      # 1 = same, 0 = >10 % volume or >10 % size off
                name_hit = False
                bn = norm(m.get("filename"))
                for cand in (norm(c["desc"]), norm(c["fname"])):
                    if bn and cand and (bn == cand or (len(bn) > 3 and bn in cand) or (len(cand) > 3 and cand in bn)):
                        name_hit = True
                score = max(geo, 0.9 if name_hit and geo > 0.2 else (0.6 if name_hit else 0.0))
                if score > 0 and (best is None or score > best["score"]):
                    best = {"part_id": pid, "score": round(score, 3), "why": ("same name" if name_hit else "") + (" · " if name_hit and geo > 0.5 else "") + (f"volume within {dv * 100:.1f}%, size within {dd * 100:.1f}%" if geo > 0.5 else "")}
            results.append({"mesh_id": int(mid), "suggested": best if best and best["score"] >= 0.5 else None, "candidates": []})
        # one part should not be suggested for two bodies: keep the better one
        seen: dict[int, dict] = {}
        for r_ in results:
            sg = r_["suggested"]
            if not sg:
                continue
            other = seen.get(sg["part_id"])
            if other is None:
                seen[sg["part_id"]] = r_
            elif other["suggested"]["score"] >= sg["score"]:
                r_["suggested"] = None
            else:
                other["suggested"] = None; seen[sg["part_id"]] = r_
        return {"matches": results, "parts": [{"id": pid, "description": c["desc"], "volume_mm3": c["vol"], "filename": c["fname"]} for pid, c in cur.items()]}

    def _create_part(self, rid: int, b: dict) -> dict:
        db = self.app.db
        sec_id = b.get("section_id")
        if not sec_id:
            sec = db.one("SELECT id FROM sections WHERE robot_id=? AND lower(name) LIKE 'printed%' ORDER BY ord LIMIT 1", [rid])
            if not sec:
                n = db.one("SELECT COALESCE(MAX(ord),-1)+1 o FROM sections WHERE robot_id=?", [rid])["o"]
                sec_id = db.insert("sections", {"robot_id": rid, "name": "Printed Parts", "ord": n, "counts": 1})
            else:
                sec_id = sec["id"]
        item_id = b.get("line_item_id")
        if not item_id:
            item = self._create_item(sec_id, {"description": b.get("name") or "Printed part", "qty": b.get("qty") or 1, "est_source": "slicer", "status": b.get("status")})
            item_id = item["id"]
        robot = db.get("robots", rid)
        profile_id = b.get("profile_id") or db.setting("default_profile_id") or (db.one("SELECT id FROM profiles WHERE builtin=1 AND nozzle=? ORDER BY id LIMIT 1", [robot.get("nozzle") or 0.4]) or {}).get("id")
        filament_id = b.get("filament_id") or db.setting("default_filament_id") or (db.one("SELECT id FROM filaments ORDER BY builtin DESC, id LIMIT 1") or {}).get("id")
        orient_json = json.dumps(b.get("orient") or {"mode": "auto", "quat": [0, 0, 0, 1]})
        pid = db.insert("printed_parts", {"robot_id": rid, "line_item_id": item_id, "mesh_id": b.get("mesh_id"), "orient_json": orient_json,
                                          "scale": float(b.get("scale") or 1.0), "filament_id": filament_id, "profile_id": profile_id,
                                          "role": b.get("role") or "structure", "locked": 0, "constraints_json": json.dumps(b.get("constraints") or {}),
                                          "mirror": 1 if b.get("mirror") else 0})
        if b.get("mesh_id") and (b.get("orient") is None or b.get("auto_orient", True)):
            try:
                mesh = db.get("meshes", b["mesh_id"]); tri = meshio.load_mesh(meshio.mesh_path(mesh))
                if b.get("mirror"):
                    tri = meshio.transform(tri, None, 1.0, True)
                cands = orient.auto_orient(tri)
                if cands:
                    db.update("printed_parts", pid, {"orient_json": json.dumps({"mode": "auto", "quat": cands[0]["quat"], "label": cands[0]["label"]})})
            except Exception:
                traceback.print_exc()
        self.app.current_slice_for_part(pid)
        db.update("robots", rid, {"updated": now()})
        return self.app._part_view(db.get("printed_parts", pid))

    def _import_filaments(self, data: bytes, fname: str) -> dict:
        """Filaments from a Bambu Studio export: a filament preset .json (Export → Export preset bundle / filament) or a
        .3mf project (every filament in its project_settings.config). Same name + same numbers → reused, not duplicated."""
        db = self.app.db
        found: list[dict] = []
        if fname.lower().endswith(".3mf") or data[:2] == b"PK":
            import zipfile as _zf
            with _zf.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
                if "Metadata/project_settings.config" not in names:
                    raise ValueError("This .3mf has no project settings (not a Bambu Studio project).")
                ps = json.loads(z.read("Metadata/project_settings.config").decode("utf-8", "replace"))
            n = len(ps.get("filament_settings_id") or [])
            for i in range(n):
                pf = meshio.bambu_project_filament(ps, i + 1)
                if pf:
                    found.append(pf)
        else:
            try:
                j = json.loads(data.decode("utf-8-sig", "replace"))
            except Exception:
                raise ValueError("Expected a Bambu Studio filament preset (.json) or a .3mf project.")
            presets = j if isinstance(j, list) else [j]
            for pr in presets:
                if not isinstance(pr, dict) or not (pr.get("filament_density") or pr.get("type") == "filament"):
                    continue
                first = lambda k, d=None: (pr.get(k)[0] if isinstance(pr.get(k), list) and pr.get(k) else pr.get(k, d))  # noqa
                name = str(pr.get("name") or (first("filament_settings_id") or "Imported filament")).split(" @")[0].strip()
                found.append({"name": name, "material": str(first("filament_type") or "PLA"), "density": float(first("filament_density") or 1.24),
                              "flow": float(first("filament_flow_ratio") or 1.0), "max_vol_speed": float(first("filament_max_volumetric_speed") or 12),
                              "cost_per_kg": float(first("filament_cost") or 0) or None})
        if not found:
            raise ValueError("No filament settings found in that file.")
        created, reused = [], []
        for pf in found:
            row = db.one("SELECT * FROM filaments WHERE name=? AND ABS(density-?)<1e-4 AND ABS(flow-?)<1e-4", [pf["name"], pf["density"], pf["flow"]])
            if row:
                reused.append(self.app._filament_view(row)); continue
            fid = db.insert("filaments", {"name": pf["name"], "material": pf.get("material") or "PLA", "density": pf["density"], "flow": pf["flow"],
                                          "color": None, "cost_per_kg": pf.get("cost_per_kg"), "notes": f"Imported from {fname or 'Bambu Studio'}",
                                          "max_vol_speed": pf.get("max_vol_speed") or 12, "correction_json": "{}", "builtin": 0})
            created.append(self.app._filament_view(db.get("filaments", fid)))
        return {"created": created, "reused": reused}

    def _import_3mf(self, rid: int, data: bytes, fname: str) -> dict:
        """One printed part per 3MF object; per-object slicer settings become the starting profile."""
        db = self.app.db
        objs = meshio.load_3mf_objects(data)
        if not objs:
            raise ValueError("No objects found in the 3MF")
        robot = db.get("robots", rid)
        base_prof = db.get("profiles", db.setting("default_profile_id") or 1)
        base_params = profiles.normalize(loads(base_prof["params_json"], {})) if base_prof else profiles.default_params(robot.get("nozzle") or 0.4)
        created = []; merged = {}; fil_cache: dict = {}
        for o in objs:
            blob = meshio.to_binary_stl_bytes(meshio.place_on_bed(o["tri"]))  # placement-independent, so duplicates merge
            sha = meshio.sha256_of(blob)
            params = profiles.normalize(base_params | meshio.slicer_settings_to_params(o["settings"], o.get("project_defaults")))
            # the project's filament for this object (Bambu Studio): create it in the library if it is new
            fil_id = None
            try:
                ext = int((o.get("settings") or {}).get("extruder") or 1)
            except (TypeError, ValueError):
                ext = 1
            pf = meshio.bambu_project_filament(o.get("project_defaults") or {}, ext)
            if pf:
                key_f = (pf["name"], round(pf["density"], 4), round(pf["flow"], 4))
                if key_f not in fil_cache:
                    row = db.one("SELECT * FROM filaments WHERE name=? AND ABS(density-?)<1e-4 AND ABS(flow-?)<1e-4", [pf["name"], pf["density"], pf["flow"]])
                    if not row:
                        row = db.one("SELECT * FROM filaments WHERE name=?", [pf["name"]])
                        if row and (abs(row["density"] - pf["density"]) > 1e-4 or abs((row["flow"] or 1) - pf["flow"]) > 1e-4):
                            row = None  # same name, different numbers → keep the project's as a separate filament
                            pf["name"] = f"{pf['name']} (flow {pf['flow']:g})"
                            row = db.one("SELECT * FROM filaments WHERE name=?", [pf["name"]])
                    if not row:
                        fid = db.insert("filaments", {"name": pf["name"], "material": pf["material"], "density": pf["density"], "flow": pf["flow"],
                                                      "max_vol_speed": pf["max_vol_speed"], "color": "#8a8a8a", "correction_json": "{}", "builtin": 0,
                                                      "notes": f"Imported from {fname}"})
                        row = db.get("filaments", fid)
                    fil_cache[key_f] = row["id"]
                fil_id = fil_cache[key_f]
            ph = profiles.profile_hash(params)
            key = (sha, ph)
            if key in merged:  # same geometry + same settings → one line with qty+1
                it = db.get("line_items", merged[key]["line_item_id"])
                db.update("line_items", it["id"], {"qty": (it["qty"] or 1) + 1})
                continue
            res = self._store_mesh(re.sub(r"[\\/:*?\"<>|]+", "_", o["name"]) + ".stl", blob)
            mesh = res["meshes"][0]
            prof = next((r for r in db.q("SELECT * FROM profiles") if profiles.profile_hash(profiles.normalize(loads(r["params_json"], {}))) == ph), None)
            if not prof:
                pid = db.insert("profiles", {"name": profiles.profile_string(params), "printer_id": None, "nozzle": params["nozzle"], "params_json": json.dumps(params), "builtin": 0, "notes": f"Imported from {fname}"})
                prof = db.get("profiles", pid)
            spec = {"name": o["name"], "mesh_id": mesh["id"], "profile_id": prof["id"], "orient": {"mode": "preset", "quat": [0, 0, 0, 1], "label": "imported"}, "auto_orient": False}
            if fil_id:
                spec["filament_id"] = fil_id
            part = self._create_part(rid, spec)
            merged[key] = part; created.append(part)
        return {"created": len(created), "parts": created}

    def _flag_reweigh_for_part(self, pid: int):
        db = self.app.db
        p = db.get("printed_parts", pid)
        if p and p.get("line_item_id") and db.one("SELECT 1 FROM weigh_ins WHERE line_item_id=?", [p["line_item_id"]]):
            db.update("line_items", p["line_item_id"], {"needs_reweigh": 1})

    def _update_part(self, pid: int, b: dict) -> dict:
        db = self.app.db
        p = db.get("printed_parts", pid)
        upd = {}
        geometry_changed = False
        if "orient" in b:
            upd["orient_json"] = json.dumps(b["orient"]); geometry_changed = True
        for k in ("scale", "mirror", "mesh_id"):
            if k in b:
                upd[k] = (1 if b[k] else 0) if k == "mirror" else b[k]; geometry_changed = True
        for k in ("filament_id", "profile_id", "role", "notes"):
            if k in b:
                upd[k] = b[k]
        if "locked" in b:
            upd["locked"] = 1 if b["locked"] else 0
        if "constraints" in b:
            upd["constraints_json"] = json.dumps(b["constraints"])
        if "modifiers" in b:
            upd["modifiers_json"] = json.dumps(b["modifiers"] or []); geometry_changed = True
        if p["locked"] and not b.get("force") and any(k in upd for k in ("orient_json", "filament_id", "profile_id", "scale", "mirror")) and not ("locked" in b and not b["locked"]):
            raise ValueError("Part is locked: unlock it to change profile, orientation or filament")
        db.update("printed_parts", pid, upd)
        if "mesh_id" in b and b.get("mesh_id") and "orient" not in b and loads(p["orient_json"], {}).get("mode", "auto") == "auto":
            try:
                mesh = db.get("meshes", b["mesh_id"]); tri = meshio.load_mesh(meshio.mesh_path(mesh))
                if upd.get("mirror", p.get("mirror")):
                    tri = meshio.transform(tri, None, 1.0, True)
                cands = orient.auto_orient(tri)
                if cands:
                    db.update("printed_parts", pid, {"orient_json": json.dumps({"mode": "auto", "quat": cands[0]["quat"], "label": cands[0]["label"]})})
            except Exception:
                traceback.print_exc()
        if geometry_changed or "profile_id" in b or "filament_id" in b:
            self._flag_reweigh_for_part(pid)
            self.app.current_slice_for_part(pid)
        if "profile_id" in b and p.get("line_item_id"):
            pass
        db.update("robots", p["robot_id"], {"updated": now()})
        return self.app._part_view(db.get("printed_parts", pid))

    def _mirror_copy(self, pid: int, name: str | None) -> dict:
        db = self.app.db
        p = db.get("printed_parts", pid)
        li = db.get("line_items", p["line_item_id"]) if p.get("line_item_id") else None
        b = {"name": name or ((li["description"] if li else "Part") + " (mirror)"), "mesh_id": p["mesh_id"], "mirror": not p.get("mirror"),
             "filament_id": p["filament_id"], "profile_id": p["profile_id"], "role": p["role"], "scale": p["scale"],
             "orient": loads(p["orient_json"], {}), "auto_orient": False, "section_id": li["section_id"] if li else None,
             "constraints": loads(p["constraints_json"], {})}
        # mirroring about X flips the orientation quaternion's x-axis components
        q = b["orient"].get("quat", [0, 0, 0, 1])
        b["orient"] = dict(b["orient"], quat=[q[0], -q[1], -q[2], q[3]])
        mods = loads(p.get("modifiers_json"), []) or []
        new = self._create_part(p["robot_id"], b)
        if mods:
            mirrored = [dict(m, min=[-m["max"][0], m["min"][1], m["min"][2]], max=[-m["min"][0], m["max"][1], m["max"][2]]) for m in mods]
            self._update_part(new["id"], {"modifiers": mirrored})
            new = self.app._part_view(db.get("printed_parts", new["id"]))
        return new

    def _export(self, rid: int, kind: str, qs: dict):
        app = self.app
        det = app.robot_detail(rid)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", det["name"])
        if kind == "csv":
            return self._bytes(exports.sheet_csv(det).encode("utf-8-sig"), "text/csv", f"{safe}-weight-budget.csv")
        if kind == "xlsx":
            return self._bytes(exports.sheet_xlsx(app, det), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", f"{safe}.xlsx")
        if kind == "printsheet":
            return self._bytes(exports.print_sheet_html(app, det).encode(), "text/html; charset=utf-8")
        if kind == "purchase":
            return self._bytes(exports.purchase_csv(det).encode("utf-8-sig"), "text/csv", f"{safe}-to-purchase.csv")
        if kind == "archive":
            return self._bytes(exports.robot_archive(app, rid), "application/zip", f"{safe}.{paths.APP_SLUG}.zip")
        if kind == "bambu3mf":
            return self._bytes(exports.bambu_3mf(app, det), "application/vnd.ms-package.3dmanufacturing-3dmodel+xml", f"{safe}.3mf")
        if kind == "presets":
            return self._bytes(exports.bambu_presets_zip(app, det), "application/zip", f"{safe}-bambu-presets.zip")
        raise KeyError(kind)


CLASSES = [
    {"name": "150 g (UK Antweight)", "grams": 150.0}, {"name": "1 lb Antweight", "grams": 453.592},
    {"name": "1 lb Plastic Antweight", "grams": 453.592}, {"name": "3 lb Beetleweight", "grams": 1360.777},
    {"name": "6 lb Mantis", "grams": 2721.55}, {"name": "12 lb Hobbyweight", "grams": 5443.108}, {"name": "30 lb Featherweight", "grams": 13607.77},
]


class QuietServer(ThreadingHTTPServer):
    """Browsers drop keep-alive sockets all the time; don't print a traceback for each one."""
    def handle_error(self, request, client_address):
        import sys
        et, ev = sys.exc_info()[:2]
        if et and issubclass(et, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(root: Path, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    app = App(root)
    Handler.app = app
    httpd = QuietServer((host, port), Handler)
    app.httpd = httpd
    httpd.daemon_threads = True
    return httpd
