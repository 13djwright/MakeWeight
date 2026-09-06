# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""python -m makeweight  — start the local service and open the browser."""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
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
    root = paths.data_root()
    (root / "data").mkdir(parents=True, exist_ok=True)
    from . import log as applog
    applog.setup(root / "data")
    try:
        notes = paths.migrate_legacy_data(applog.log)
        for n in notes:
            applog.log.info("migration: %s", n)
    except Exception:  # noqa
        applog.log.exception("data migration failed")
    port = args.port
    # pick the next free port if busy (another instance is probably already running)
    for p in range(port, port + 20):
        with socket.socket() as s:
            if s.connect_ex((args.host, p)) != 0:
                port = p
                break
    httpd = serve(root, args.host, port)
    url = f"http://{args.host}:{port}/"
    from .log import log
    log.info("%s running at %s   (app in %s, data in %s)", paths.APP_NAME, url, paths.install_dir(), root / "data")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    # a finished self-update asked us to hand over: the port is free now, start the new version and leave
    app = getattr(httpd.RequestHandlerClass, "app", None)
    launch = getattr(getattr(app, "updater", None), "launch_path", None)
    if launch:
        from .updater import Updater
        log.info("update: starting %s and exiting", launch)
        try:
            Updater.launch(launch)
        except Exception:  # noqa
            log.exception("update: could not start the new version")
        import time
        time.sleep(1.0)


if __name__ == "__main__":
    main()
