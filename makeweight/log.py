# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""One log for the whole app: data/logs/<slug>.log (rotating), mirrored to the console.

Everything that can fail on a machine we cannot see goes through here — installs, every slicer subprocess,
job failures, HTTP 500s, unhandled thread exceptions — so the Diagnostics card can show it and the bundle can
carry it to whoever is debugging.
"""
from __future__ import annotations

import io
import json
import logging
import logging.handlers
import os
import platform
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path

log = logging.getLogger("makeweight")
_LOG_FILE: Path | None = None
_RING: list[str] = []          # last lines, for the API even if the file is unreadable
_RING_MAX = 2000
_lock = threading.Lock()


class _RingHandler(logging.Handler):
    def emit(self, record):
        try:
            line = self.format(record)
        except Exception:  # noqa
            return
        with _lock:
            _RING.append(line)
            if len(_RING) > _RING_MAX:
                del _RING[: len(_RING) - _RING_MAX]


def _slug() -> str:
    from . import paths
    return paths.APP_SLUG


def setup(local_dir: Path) -> Path:
    """Call once at startup with this computer's local folder. Returns the log file path."""
    global _LOG_FILE
    logs = Path(local_dir) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    _LOG_FILE = logs / f"{_slug()}.log"
    fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(threadName)s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.DEBUG)
    log.handlers.clear()
    fh = logging.handlers.RotatingFileHandler(_LOG_FILE, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt); fh.setLevel(logging.DEBUG); log.addHandler(fh)
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)-5s %(message)s", "%H:%M:%S")); ch.setLevel(logging.INFO); log.addHandler(ch)
    rh = _RingHandler(); rh.setFormatter(fmt); rh.setLevel(logging.DEBUG); log.addHandler(rh)
    log.propagate = False

    # unhandled exceptions anywhere (main thread and worker threads) end up in the log too
    def hook(exc_type, exc, tb):
        log.error("unhandled exception", exc_info=(exc_type, exc, tb))
    sys.excepthook = hook
    if hasattr(threading, "excepthook"):
        threading.excepthook = lambda a: log.error("unhandled exception in thread %s", a.thread.name if a.thread else "?", exc_info=(a.exc_type, a.exc_value, a.exc_traceback))
    return _LOG_FILE


def tail(n: int = 400) -> list[str]:
    with _lock:
        return list(_RING[-n:])


def log_file() -> Path | None:
    return _LOG_FILE


def run_logged(args: list[str], what: str, **kw):
    """subprocess.run with the command, return code, duration and the tail of stderr/stdout in the log."""
    import subprocess
    t0 = time.time()
    log.debug("%s: %s", what, " ".join(str(a) for a in args))
    try:
        r = subprocess.run(args, **kw)
    except Exception as e:  # noqa
        log.error("%s: could not start (%s) after %.1fs", what, e, time.time() - t0)
        raise
    dt = time.time() - t0
    out = (getattr(r, "stderr", None) or b"") if not kw.get("text") else (r.stderr or "")
    so = (getattr(r, "stdout", None) or b"") if not kw.get("text") else (r.stdout or "")
    if isinstance(out, bytes):
        out = out.decode("utf-8", "replace")
    if isinstance(so, bytes):
        so = so.decode("utf-8", "replace")
    lvl = logging.DEBUG if r.returncode == 0 else logging.WARNING
    squash = lambda t, n: " | ".join(ln.strip() for ln in t.strip().splitlines() if ln.strip())[-n:] or "-"
    log.log(lvl, "%s: exit %s in %.1fs; stderr: %s; stdout tail: %s", what, r.returncode, dt, squash(out, 600), squash(so, 300))
    return r


def environment(app=None) -> dict:
    """Facts about this machine and install that matter when something fails."""
    from . import paths, slicer_engine
    root = slicer_engine.app_root()
    info = {
        "app_version": _app_version(), "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "os": platform.platform(), "machine": platform.machine(), "python": sys.version.split()[0], "executable": sys.executable,
        "data_root": str(paths.data_root()), "shared_data": paths.is_shared(), "local_root": str(root), "install_dir": str(paths.install_dir()), "portable": paths.is_portable(), "root_path_length": len(str(root)), "cwd": os.getcwd(),
        "env": {k: os.environ.get(k) for k in ("MAKEWEIGHT_HOME", "MAKEWEIGHT_PORT", "SSL_CERT_FILE", "PATH") if os.environ.get(k)},
    }
    try:
        du = shutil.disk_usage(str(root))
        info["disk_free_gb"] = round(du.free / 1e9, 2)
    except Exception:
        pass
    try:
        sd = root / "slicer"
        info["slicer_dir"] = [str(p.relative_to(sd)) for p in sorted(sd.rglob("*"))[:200]] if sd.exists() else []
        info["slicer_dir_count"] = sum(1 for _ in sd.rglob("*")) if sd.exists() else 0
    except Exception as e:  # noqa
        info["slicer_dir"] = f"error: {e}"
    if app is not None:
        try:
            info["engines"] = app.jobs.engine_status(force=True)
            info["active_engine"] = app.jobs.engine
            info["slicer_version"] = app.jobs.slicer_version
            info["install_state"] = app.install_state
            info["settings"] = {k: app.db.setting(k) for k in ("slicer_engine", "slicer_path", "bambu_path", "workers", "keep_gcode", "filaments_v")}
            info["counts"] = {t: app.db.one(f"SELECT COUNT(*) n FROM {t}")["n"] for t in ("robots", "printed_parts", "meshes", "slice_jobs", "filaments", "profiles")}
            info["recent_job_errors"] = app.db.q("SELECT id, part_id, status, slicer_version, error, finished FROM slice_jobs WHERE status='error' ORDER BY id DESC LIMIT 20")
        except Exception as e:  # noqa
            info["app_error"] = str(e)
    return info


def _app_version() -> str:
    try:
        return json.loads((Path(__file__).parent / "version.json").read_text())["version"]
    except Exception:
        return "?"


def bundle(app=None) -> bytes:
    """Zip with the log files, environment facts and (non-sensitive) settings — to attach to a bug report."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("environment.json", json.dumps(environment(app), indent=2, default=str))
        z.writestr("recent.log", "\n".join(tail(2000)))
        if _LOG_FILE and _LOG_FILE.parent.exists():
            for f in sorted(_LOG_FILE.parent.glob(_LOG_FILE.name + "*")):
                try:
                    z.write(f, f"logs/{f.name}")
                except OSError:
                    pass
    return buf.getvalue()
