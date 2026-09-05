"""python -m slicebudget  — start the local service and open the browser."""
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
    ap = argparse.ArgumentParser(prog="slicebudget")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SLICEBUDGET_PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", default=None, help="folder holding data/ and slicer/ (default: app folder)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.root:
        os.environ["SLICEBUDGET_HOME"] = str(Path(args.root).resolve())
    from . import slicer_engine
    from .server import serve
    root = slicer_engine.app_root()
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
    log.info("SliceBudget running at %s   (data in %s)", url, root / "data")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
