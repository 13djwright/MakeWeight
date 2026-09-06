"""Self-update from GitHub Releases.

The app downloads the zip for this platform itself (downloads made by a running program are not quarantined by
macOS and carry no Mark-of-the-Web on Windows), unpacks it as a sibling folder of the current install, and starts
the new version's launcher before shutting itself down. Data lives in the user data directory, so the new version
simply finds it. The old folder is left for the user to delete (it is reported on the setup page).
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from . import paths
from .log import log

APP = paths.APP_NAME
_UA = {"User-Agent": f"{APP}-updater"}


def target() -> str:
    s, m = platform.system(), platform.machine().lower()
    if s == "Windows":
        return "windows-x86_64"
    if s == "Darwin":
        return "macos-arm64" if m in ("arm64", "aarch64") else "macos-x86_64"
    return "linux-x86_64"


def current_version() -> str:
    try:
        return json.loads((Path(__file__).parent / "version.json").read_text())["version"]
    except Exception:
        return "0"


def default_repo() -> str:
    try:
        return json.loads((Path(__file__).parent / "version.json").read_text()).get("repo") or ""
    except Exception:
        return ""


def vtuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def fetch_latest(repo: str) -> dict:
    """{version, tag, notes, url, asset, published, html_url} for the newest release that has this platform's zip."""
    if not repo or "/" not in repo:
        raise RuntimeError("No update source configured. Set the GitHub repository (owner/name) on this page.")
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases?per_page=10", headers={**_UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        rels = json.loads(r.read().decode())
    if not isinstance(rels, list):
        raise RuntimeError(f"Unexpected answer from GitHub for {repo}")
    tgt = target()
    for rel in rels:
        if rel.get("draft"):
            continue
        for a in rel.get("assets") or []:
            n = a.get("name", "")
            if n.endswith(f"-{tgt}.zip") and n.lower().startswith(APP.lower()):
                ver = re.sub(r"^v", "", rel.get("tag_name") or "")
                m = re.search(r"-(\d+\.\d+\.\d+)-", n)
                if m:
                    ver = m.group(1)
                return {"version": ver, "tag": rel.get("tag_name"), "notes": (rel.get("body") or "")[:4000], "url": a["browser_download_url"],
                        "asset": n, "size": a.get("size"), "published": rel.get("published_at"), "html_url": rel.get("html_url"),
                        "newer": vtuple(ver) > vtuple(current_version())}
    raise RuntimeError(f"No release in {repo} has a zip for {tgt} yet")


class Updater:
    def __init__(self, db, events):
        self.db = db
        self.events = events
        self.state = {"status": "idle", "message": "", "progress": 0.0}
        self.latest: dict | None = None
        self._thread: threading.Thread | None = None

    def repo(self) -> str:
        return self.db.setting("update_repo") or default_repo()

    def _set(self, **kw):
        self.state.update(kw)
        try:
            self.events.emit("update", self.state)
        except Exception:  # noqa
            pass

    def check(self) -> dict:
        info = fetch_latest(self.repo())
        self.latest = info
        self.db.set_setting("update_last_check", time.time())
        log.info("update check: current %s, latest %s (%s)", current_version(), info["version"], info["asset"])
        return {"current": current_version(), "target": target(), **info}

    def old_versions(self) -> list[str]:
        """Sibling folders that look like older installs of this app."""
        here = paths.install_dir()
        out = []
        try:
            for sib in here.parent.iterdir():
                if sib.is_dir() and sib != here and re.match(rf"^({APP}|{paths.LEGACY_NAME})-\d", sib.name):
                    out.append(str(sib))
        except OSError:
            pass
        return sorted(out)

    def start(self, httpd_stop) -> bool:
        """Download + unpack + relaunch in the background. httpd_stop() is called at the very end to let the new
        version take the port."""
        if self.state.get("status") == "running":
            return False
        if paths.is_portable():
            raise RuntimeError("Portable mode: update by unzipping the new version over this folder (data stays in data/).")
        self._set(status="running", message="Checking", progress=0.0)
        self._thread = threading.Thread(target=self._run, args=(httpd_stop,), name="updater", daemon=True)
        self._thread.start()
        return True

    def _run(self, httpd_stop):
        try:
            info = self.latest or fetch_latest(self.repo())
            here = paths.install_dir()
            dest = here.parent / f"{APP}-{info['version']}-{target()}"
            if dest.exists() and any(dest.iterdir()):
                dest = here.parent / f"{APP}-{info['version']}-{target()}-{int(time.time())}"
            tmp = paths.data_root() / "updates"
            tmp.mkdir(parents=True, exist_ok=True)
            zpath = tmp / info["asset"]
            log.info("update: downloading %s -> %s", info["url"], zpath)
            self._set(message=f"Downloading {APP} {info['version']}", progress=0.02)
            req = urllib.request.Request(info["url"], headers=_UA)
            with urllib.request.urlopen(req, timeout=60) as r, open(zpath, "wb") as f:
                total = int(r.headers.get("Content-Length") or info.get("size") or 0)
                done = 0
                while True:
                    chunk = r.read(1 << 18)
                    if not chunk:
                        break
                    f.write(chunk); done += len(chunk)
                    if total:
                        self._set(message=f"Downloading {done / 1e6:.0f} / {total / 1e6:.0f} MB", progress=0.02 + 0.7 * done / total)
            self._set(message="Unpacking", progress=0.75)
            with zipfile.ZipFile(zpath) as zf:
                names = zf.namelist()
                top = names[0].split("/")[0] if names else ""
                for info_ in zf.infolist():
                    rel = info_.filename[len(top) + 1:] if top and info_.filename.startswith(top + "/") else info_.filename
                    if not rel or rel.endswith("/"):
                        continue
                    out = dest / rel
                    out.parent.mkdir(parents=True, exist_ok=True)
                    mode = (info_.external_attr >> 16) & 0o777
                    if stat.S_ISLNK(info_.external_attr >> 16):
                        try:
                            os.symlink(zf.read(info_).decode(), out)
                        except OSError:
                            pass
                        continue
                    with zf.open(info_) as src, open(out, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    if mode:
                        os.chmod(out, mode)
            zpath.unlink(missing_ok=True)
            if platform.system() == "Darwin":
                subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(dest)], check=False)
            cur = here.parent / "current"
            if cur.is_symlink():
                try:
                    cur.unlink(); os.symlink(dest, cur)
                except OSError as e:
                    log.warning("update: could not repoint %s: %s", cur, e)
            launcher = self._launcher(dest)
            if launcher is None:
                raise RuntimeError(f"Unpacked to {dest} but found no launcher inside")
            log.info("update: unpacked to %s; handing over to %s", dest, launcher)
            self._set(status="done", message=f"{APP} {info['version']} is starting — this page reconnects by itself.", progress=1.0, new_dir=str(dest))
            time.sleep(0.8)          # let the browser receive that event
            httpd_stop()             # free the port first, so the new version binds the same one
            self._launch(launcher)
            time.sleep(1.5)
            log.info("update: old version exiting")
            os._exit(0)
        except Exception as e:  # noqa
            log.exception("update failed")
            self._set(status="error", message=str(e))

    @staticmethod
    def _launcher(dest: Path) -> Path | None:
        s = platform.system()
        for n in ([f"{APP}.bat"] if s == "Windows" else [f"{APP}.command"] if s == "Darwin" else [f"{APP.lower()}.sh"]):
            if (dest / n).exists():
                return dest / n
        return None

    @staticmethod
    def _launch(launcher: Path):
        s = platform.system()
        cwd = str(launcher.parent)
        quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if s == "Windows":
            # a fresh console window like a double-click, detached from this process
            subprocess.Popen(["cmd", "/c", "start", "", str(launcher)], cwd=cwd, close_fds=True,
                             creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0) | getattr(subprocess, "DETACHED_PROCESS", 0), **quiet)
        elif s == "Darwin":
            # Terminal runs the .command in a new window, same as a double-click (no quarantine, so no Gatekeeper)
            r = subprocess.run(["open", "-a", "Terminal", str(launcher)], capture_output=True, text=True)
            if r.returncode != 0:
                subprocess.Popen(["bash", str(launcher)], cwd=cwd, start_new_session=True, **quiet)
        else:
            term = shutil.which("x-terminal-emulator") or shutil.which("gnome-terminal") or shutil.which("konsole") or shutil.which("xterm")
            if term:
                subprocess.Popen([term, "-e", f"bash \"{launcher}\""] if "gnome" not in term else [term, "--", "bash", str(launcher)], cwd=cwd, start_new_session=True, **quiet)
            else:
                subprocess.Popen(["bash", str(launcher)], cwd=cwd, start_new_session=True, **quiet)
