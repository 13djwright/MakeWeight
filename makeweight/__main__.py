# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""python -m makeweight  — start the local service and open the browser."""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path


def _ssl_certs():
    """Bundled runtimes (macOS/Linux) have no system CA store: point Python at certifi's bundle."""
    if os.environ.get("SSL_CERT_FILE"):
        return
    try:
        import certifi  # type: ignore
        os.environ["SSL_CERT_FILE"] = certifi.where()
    except Exception:
        pass


def main():
    _ssl_certs()
    ap = argparse.ArgumentParser(prog="makeweight")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MAKEWEIGHT_PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", default=None, help="folder holding data/ and slicer/ (default: app folder)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.root:
        os.environ["MAKEWEIGHT_HOME"] = str(Path(args.root).resolve())
    from . import paths
    from .server import serve
    local = paths.local_root()
    root = paths.data_root()
    from . import log as applog
    applog.setup(local)
    if paths.is_shared() and not root.exists():
        applog.log.warning("shared data folder %s is not reachable — falling back to this computer's own data until it is", root)
        os.environ["MAKEWEIGHT_SHARED_UNREACHABLE"] = str(root)
        root = local
    (root / "data").mkdir(parents=True, exist_ok=True)
    try:
        notes = paths.migrate_legacy_data(applog.log)
        for n in notes:
            applog.log.info("migration: %s", n)
    except Exception:  # noqa
        applog.log.exception("data migration failed")
    port = args.port
    no_browser = args.no_browser
    # started by the self-updater (or a data-folder move)? then take over the previous port and leave the user's tab alone
    marker = local / "updates" / "handover.json"
    try:
        if marker.exists():
            h = json.loads(marker.read_text(encoding="utf-8"))
            marker.unlink(missing_ok=True)
            if time.time() - float(h.get("ts") or 0) < 300:
                if h.get("port"):
                    port = int(h["port"])
                no_browser = no_browser or bool(h.get("no_browser"))
                applog.log.info("update handover from %s: reusing port %s, not opening a browser", h.get("from"), port)
                for _ in range(60):                       # the old process is still letting go of the socket
                    with socket.socket() as s:
                        if s.connect_ex((args.host, port)) != 0:
                            break
                    time.sleep(0.25)
    except Exception:  # noqa
        applog.log.exception("handover marker unreadable")
    # pick the next free port if busy (another instance is probably already running)
    for p in range(port, port + 20):
        with socket.socket() as s:
            if s.connect_ex((args.host, p)) != 0:
                port = p
                break
    httpd = serve(root, args.host, port, local=local)
    url = f"http://{args.host}:{port}/"
    from .log import log
    log.info("%s running at %s   (app in %s, data in %s)", paths.APP_NAME, url, paths.install_dir(), root / "data")
    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        try:
            getattr(getattr(httpd.RequestHandlerClass, "app", None), "lock", None).shutdown()
        except Exception:  # noqa
            pass
    # a finished self-update asked us to hand over: the port is free now, start the new version and leave
    app = getattr(httpd.RequestHandlerClass, "app", None)
    launch = getattr(getattr(app, "updater", None), "launch_path", None)
    if launch:
        from .updater import Updater
        log.info("update: starting %s and exiting", launch)
        try:
            Updater.launch(launch, getattr(app.updater, "launch_args", None))
        except Exception:  # noqa
            log.exception("update: could not start the new version")
            # keep this window open so the message can be read, and tell the user exactly what to do
            print("\n" + "=" * 70 + f"\nMakeWeight could not start the new version automatically.\nYour data is safe. Start it by double-clicking:\n  {launch}\n" + "=" * 70)
            try:
                input("Press Enter to close this window…")
            except Exception:  # noqa
                pass
            sys.exit(1)
        time.sleep(1.0)


if __name__ == "__main__":
    main()
