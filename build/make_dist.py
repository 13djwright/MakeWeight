"""Build per-platform SliceBudget zips: embedded CPython (python-build-standalone) + wheels + app + launcher.

Usage:  python3 make_dist.py --out DIST_DIR [--targets windows-x86_64,macos-arm64,macos-x86_64,linux-x86_64]
Needs network access to GitHub releases and PyPI. Pure stdlib + pip.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
APP_VERSION = json.loads((ROOT / "slicebudget" / "version.json").read_text())["version"] if (ROOT / "slicebudget" / "version.json").exists() else "0.1.0"

TARGETS = {
    # name: (python-build-standalone triple, pip platform tags, site-packages relative path, launcher)
    "windows-x86_64": ("x86_64-pc-windows-msvc", ["win_amd64"], "python/Lib/site-packages", "windows"),
    "macos-arm64": ("aarch64-apple-darwin", ["macosx_11_0_arm64", "macosx_12_0_arm64", "macosx_14_0_arm64"], "python/lib/python3.12/site-packages", "macos"),
    "macos-x86_64": ("x86_64-apple-darwin", ["macosx_10_9_x86_64", "macosx_10_13_x86_64", "macosx_12_0_x86_64"], "python/lib/python3.12/site-packages", "macos"),
    "linux-x86_64": ("x86_64-unknown-linux-gnu", ["manylinux_2_17_x86_64", "manylinux2014_x86_64", "manylinux_2_28_x86_64"], "python/lib/python3.12/site-packages", "linux"),
}
PY_SERIES = "3.12"
WHEELS = ["numpy>=1.26,<3", "openpyxl>=3.1,<4", "et_xmlfile>=1.1", "certifi"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def gh_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SliceBudget-build", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def download(url, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "SliceBudget-build"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    return dest


def find_runtime_assets():
    rel = gh_json("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest")
    out = {}
    for name, (triple, *_rest) in TARGETS.items():
        cands = [a for a in rel["assets"] if a["name"].startswith(f"cpython-{PY_SERIES}.") and a["name"].endswith(f"-{triple}-install_only_stripped.tar.gz")]
        if not cands:
            cands = [a for a in rel["assets"] if a["name"].startswith(f"cpython-{PY_SERIES}.") and a["name"].endswith(f"-{triple}-install_only.tar.gz")]
        if not cands:
            raise RuntimeError(f"no runtime asset for {triple} in {rel['tag_name']}")
        cands.sort(key=lambda a: a["name"])
        out[name] = cands[-1]["browser_download_url"]
    log("runtime release", rel["tag_name"])
    return out


def pip_download(platform_tags: list[str], dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--python-version", PY_SERIES, "--implementation", "cp", "--abi", "cp312", "-d", str(dest), "--no-deps", "-q"]
    for t in platform_tags:
        cmd += ["--platform", t]
    subprocess.run(cmd + WHEELS, check=True)
    return sorted(dest.glob("*.whl"))


def install_wheels(wheels, site: Path):
    site.mkdir(parents=True, exist_ok=True)
    for w in wheels:
        with zipfile.ZipFile(w) as z:
            z.extractall(site)
        log("  installed", w.name)


LAUNCHERS = {
    "windows": ("SliceBudget.bat", "\r\n".join([
        "@echo off", "title SliceBudget", "cd /d \"%~dp0\"",
        "echo Starting SliceBudget ... this window stays open while it runs. Close it to stop.",
        "\"%~dp0python\\python.exe\" -m slicebudget %*",
        "if errorlevel 1 pause", ""])),
    "macos": ("SliceBudget.command", "\n".join([
        "#!/bin/bash", "cd \"$(dirname \"$0\")\"",
        "echo \"Starting SliceBudget ... keep this window open while it runs (Ctrl-C to stop).\"",
        "xattr -dr com.apple.quarantine python 2>/dev/null",
        "exec ./python/bin/python3 -m slicebudget \"$@\"", ""])),
    "linux": ("slicebudget.sh", "\n".join([
        "#!/bin/bash", "cd \"$(dirname \"$0\")\"",
        "echo \"Starting SliceBudget ... keep this terminal open while it runs (Ctrl-C to stop).\"",
        "exec ./python/bin/python3 -m slicebudget \"$@\"", ""])),
}

README = """SliceBudget {version}
=================

1. Keep this folder together (it holds the app, its own Python runtime, and later your data).
2. Start it:
     Windows : double-click SliceBudget.bat
     macOS   : double-click SliceBudget.command  (first time: right-click > Open, or run
               `xattr -dr com.apple.quarantine .` in this folder if macOS refuses)
     Linux   : ./slicebudget.sh
   A browser tab opens at http://localhost:8765. The window that opened must stay open while you use it.
3. First run: open "Jobs & setup" and click "Install PrusaSlicer". SliceBudget downloads PrusaSlicer's
   portable build (~100 MB) into the slicer/ folder here. Nothing is installed elsewhere on your computer.
   Linux: PrusaSlicer comes from Flathub or your distribution; the Setup page explains.
4. Your data lives in data/ (SQLite database, mesh files, nightly backups). Back that folder up.
5. Tips: drop a Bambu Studio / PrusaSlicer .3mf project onto Printed parts to import every object with its
   settings; "Modifier regions" on a part slice a box with its own walls/infill for real; the Optimizer only
   shows plans it has re-sliced; Calculators hold the belt / tip-speed / drive / battery formulas.

Upgrading: unzip the new version next to the old one and move the data/ and slicer/ folders across.
"""


def build_target(name: str, runtime_url: str, out_dir: Path, cache: Path):
    triple, tags, site_rel, launcher = TARGETS[name]
    stage = cache.parent / "stage" / f"SliceBudget-{APP_VERSION}-{name}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    log(f"[{name}] runtime")
    tgz = download(runtime_url, cache / Path(runtime_url).name)
    with tarfile.open(tgz) as t:
        t.extractall(stage)  # extracts a top-level 'python/' directory
    # slim the runtime a little
    for junk in ("python/lib/python3.12/test", "python/Lib/test", "python/lib/python3.12/idlelib", "python/Lib/idlelib", "python/lib/tcl8.6", "python/lib/tcl9.0", "python/lib/tk9.0", "python/lib/tk8.6", "python/tcl", "python/lib/python3.12/tkinter", "python/Lib/tkinter", "python/share", "python/include", "python/lib/python3.12/ensurepip", "python/Lib/ensurepip", "python/lib/python3.12/__pycache__", "python/Lib/__pycache__", "python/lib/python3.12/config-3.12-x86_64-linux-gnu", "python/lib/python3.12/config-3.12-darwin"):
        p = stage / junk
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    for f in list((stage / "python").rglob("*")):
        n = f.name.lower()
        if f.is_file() and (n.endswith(".a") or n.startswith("libtcl") or n.startswith("libtk") or n.startswith("tcl") and n.endswith(".dll") or n.startswith("tk") and n.endswith(".dll") or n.startswith("_tkinter")):
            f.unlink()
        elif f.is_dir() and f.name == "tests" and "numpy" in str(f):
            shutil.rmtree(f, ignore_errors=True)
    log(f"[{name}] wheels")
    wheels = pip_download(tags, cache / f"wheels-{name}")
    install_wheels(wheels, stage / site_rel)
    for d in list((stage / site_rel).rglob("tests")):
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
    log(f"[{name}] app")
    shutil.copytree(ROOT / "slicebudget", stage / "slicebudget", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (stage / "data").mkdir(); (stage / "slicer").mkdir()
    (stage / "data" / ".keep").write_text(""); (stage / "slicer" / ".keep").write_text("")
    fname, body = LAUNCHERS[launcher]
    (stage / fname).write_text(body, newline="")
    (stage / "README.txt").write_text(README.format(version=APP_VERSION))
    (stage / "LICENSES.txt").write_text("SliceBudget bundles CPython (PSF license, python-build-standalone), numpy (BSD), openpyxl (MIT), et_xmlfile (MIT).\nPrusaSlicer (AGPL-3.0, https://github.com/prusa3d/PrusaSlicer) is downloaded separately on first run.\n")
    # zip with executable bits for posix launchers
    zpath = out_dir / f"SliceBudget-{APP_VERSION}-{name}.zip"
    log(f"[{name}] zipping -> {zpath.name}")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(stage.rglob("*")):
            rel = f.relative_to(stage.parent)
            if f.is_dir():
                continue
            zi = zipfile.ZipInfo(str(rel).replace(os.sep, "/"), date_time=time.localtime()[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if (f.suffix in (".command", ".sh") or "/bin/" in str(rel).replace(os.sep, "/") or os.access(f, os.X_OK)) else 0o644
            if f.is_symlink():
                zi.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(zi, os.readlink(f))
            else:
                zi.external_attr = (stat.S_IFREG | mode) << 16
                z.writestr(zi, f.read_bytes())
    shutil.rmtree(stage)
    log(f"[{name}] done {zpath.stat().st_size / 1e6:.1f} MB")
    return zpath


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--targets", default=",".join(TARGETS))
    ap.add_argument("--cache", default=str(HERE / "_cache"))
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    cache = Path(a.cache); cache.mkdir(parents=True, exist_ok=True)
    urls = find_runtime_assets()
    for t in a.targets.split(","):
        build_target(t.strip(), urls[t.strip()], out, cache)


if __name__ == "__main__":
    main()
