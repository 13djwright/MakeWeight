"""PrusaSlicer adapter: find it, install it, run it, read its numbers."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

PRUSA_VERSION = "2.9.6"
PRUSA_URLS = {
    "Windows": f"https://github.com/prusa3d/PrusaSlicer/releases/download/version_{PRUSA_VERSION}/PrusaSlicer-{PRUSA_VERSION}.zip",
    "Darwin": f"https://github.com/prusa3d/PrusaSlicer/releases/download/version_{PRUSA_VERSION}/PrusaSlicer-{PRUSA_VERSION}.dmg",
}
FLATPAK_ID = "com.prusa3d.PrusaSlicer"


class SlicerNotFound(Exception):
    pass


def app_root() -> Path:
    """Folder that holds slicer/, data/ etc. Override with SLICEBUDGET_HOME."""
    env = os.environ.get("SLICEBUDGET_HOME")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def slicer_dir() -> Path:
    return app_root() / "slicer"


def _exe_names() -> list[str]:
    s = platform.system()
    if s == "Windows":
        return ["prusa-slicer-console.exe", "prusa-slicer.exe"]
    if s == "Darwin":
        return ["PrusaSlicer", "prusa-slicer"]
    return ["prusa-slicer", "PrusaSlicer", "prusa-slicer.AppImage", "PrusaSlicer.AppImage"]


def locate(configured: str | None = None) -> list[str] | None:
    """Return the command prefix (list) for the slicer, or None."""
    if configured:
        p = Path(configured)
        if p.is_file():
            return [str(p)]
        if p.is_dir():
            for n in _exe_names():
                for c in p.rglob(n):
                    if c.is_file():
                        return [str(c)]
        if configured.startswith("flatpak"):
            return configured.split()
    sd = slicer_dir()
    if sd.is_dir():
        for n in _exe_names():
            hits = [c for c in sd.rglob(n) if c.is_file()]
            # prefer the console exe / the .app binary
            hits.sort(key=lambda c: ("MacOS" not in str(c), "console" not in c.name))
            if hits:
                return [str(hits[0])]
    for n in ("prusa-slicer", "prusa-slicer-console", "PrusaSlicer", "prusa-slicer-console.exe"):
        w = shutil.which(n)
        if w:
            return [w]
    known = [
        Path(r"C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe"),
        Path(r"C:/Program Files/PrusaSlicer/prusa-slicer-console.exe"),
        Path("/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"),
        Path("/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"),
        Path.home() / "Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
    ]
    for k in known:
        if k.is_file():
            return [str(k)]
    if shutil.which("flatpak"):
        try:
            r = subprocess.run(["flatpak", "info", FLATPAK_ID], capture_output=True, timeout=5)
            if r.returncode == 0:
                return ["flatpak", "run", FLATPAK_ID]
        except Exception:
            pass
    return None


def version_of(cmd: list[str]) -> str | None:
    try:
        r = subprocess.run(cmd + ["--help"], capture_output=True, text=True, timeout=30)
        m = re.search(r"PrusaSlicer-(\d+\.\d+\.\d+[^\s]*)", (r.stdout or "") + (r.stderr or ""))
        return m.group(1) if m else ((r.stdout or "").splitlines() or ["?"])[0][:60]
    except Exception:
        return None


# ------------------------------------------------------------------ install
def download(url: str, dest: Path, progress: Callable[[int, int], None] | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "SliceBudget/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1 << 18)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)
    return dest


def install(progress: Callable[[str, float], None] | None = None) -> list[str]:
    """Download and unpack PrusaSlicer into slicer/. Returns the command prefix."""
    s = platform.system()
    sd = slicer_dir()
    sd.mkdir(parents=True, exist_ok=True)

    def prog(msg, frac):
        if progress:
            progress(msg, frac)

    if s == "Windows":
        url = PRUSA_URLS["Windows"]
        z = sd / "download.zip"
        prog("Downloading PrusaSlicer " + PRUSA_VERSION, 0.0)
        download(url, z, lambda d, t: prog(f"Downloading {d / 1e6:.0f} / {t / 1e6:.0f} MB", 0.8 * d / t if t else 0.4))
        prog("Unpacking", 0.85)
        with zipfile.ZipFile(z) as zf:
            zf.extractall(sd)
        z.unlink(missing_ok=True)
    elif s == "Darwin":
        url = PRUSA_URLS["Darwin"]
        dmg = sd / "download.dmg"
        prog("Downloading PrusaSlicer " + PRUSA_VERSION, 0.0)
        download(url, dmg, lambda d, t: prog(f"Downloading {d / 1e6:.0f} / {t / 1e6:.0f} MB", 0.8 * d / t if t else 0.4))
        prog("Mounting disk image", 0.85)
        mnt = Path(tempfile.mkdtemp(prefix="prusa_dmg_"))
        subprocess.run(["hdiutil", "attach", str(dmg), "-mountpoint", str(mnt), "-nobrowse", "-quiet"], check=True)
        try:
            apps = list(mnt.glob("*.app"))
            if not apps:
                raise RuntimeError("No .app inside the PrusaSlicer disk image")
            dest = sd / apps[0].name
            if dest.exists():
                shutil.rmtree(dest)
            prog("Copying application", 0.9)
            shutil.copytree(apps[0], dest, symlinks=True)
        finally:
            subprocess.run(["hdiutil", "detach", str(mnt), "-quiet"], check=False)
        subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(dest)], check=False)
        dmg.unlink(missing_ok=True)
    else:
        # Linux: PrusaSlicer publishes Linux builds on Flathub.
        if shutil.which("flatpak"):
            prog("Installing PrusaSlicer from Flathub (flatpak)", 0.1)
            r = subprocess.run(["flatpak", "install", "-y", "--user", "flathub", FLATPAK_ID], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("flatpak install failed: " + (r.stderr or r.stdout)[-800:])
        else:
            raise RuntimeError(
                "On Linux PrusaSlicer is distributed through Flathub or your distribution. Install it "
                "(e.g. 'flatpak install flathub com.prusa3d.PrusaSlicer' or 'sudo apt install prusa-slicer') "
                "or point SliceBudget at an AppImage in Setup.")
    prog("Verifying", 0.95)
    cmd = locate()
    if not cmd:
        raise RuntimeError("PrusaSlicer was unpacked but no executable was found")
    v = version_of(cmd)
    if not v:
        raise RuntimeError("PrusaSlicer did not start. Executable: " + " ".join(cmd))
    prog("Installed PrusaSlicer " + v, 1.0)
    return cmd


# ------------------------------------------------------------------ slicing
_TIME_RE = re.compile(r"estimated printing time \(normal mode\)\s*=\s*(.+)")


def _parse_time(s: str) -> float:
    total = 0
    for val, unit in re.findall(r"(\d+)\s*([dhms])", s):
        total += int(val) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return float(total)


def parse_gcode_header(path: Path) -> dict:
    out: dict = {}
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        # metadata is at the end of PrusaSlicer G-code; read the tail
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - 200_000))
        tail = f.read()
    m = re.search(r"^;\s*total filament used \[g\]\s*=\s*([\d.,\s]+)$", tail, re.M)
    if m:
        out["grams"] = sum(float(x) for x in m.group(1).split(",") if x.strip())
    else:
        m = re.search(r"^;\s*filament used \[g\]\s*=\s*([\d.,\s]+)$", tail, re.M)
        if m:
            out["grams"] = sum(float(x) for x in m.group(1).split(",") if x.strip())
    m = re.search(r"^;\s*filament used \[cm3\]\s*=\s*([\d.,\s]+)$", tail, re.M)
    if m:
        out["cm3"] = sum(float(x) for x in m.group(1).split(",") if x.strip())
    m = re.search(r"^;\s*filament used \[mm\]\s*=\s*([\d.,\s]+)$", tail, re.M)
    if m:
        out["mm"] = sum(float(x) for x in m.group(1).split(",") if x.strip())
    m = _TIME_RE.search(tail)
    if m:
        out["print_time_s"] = _parse_time(m.group(1))
    return out


def run_slice(cmd: list[str], stl_path: Path, ini_text: str, work_dir: Path, keep_gcode: bool = False,
              center=(200.0, 200.0), timeout: int = 1800) -> dict:
    work_dir.mkdir(parents=True, exist_ok=True)
    ini = work_dir / (stl_path.stem + ".ini")
    ini.write_text(ini_text, encoding="utf-8")
    gcode = work_dir / (stl_path.stem + ".gcode")
    args = cmd + ["--export-gcode", "--load", str(ini), "--output", str(gcode),
                  "--center", f"{center[0]:g},{center[1]:g}", "--dont-arrange", str(stl_path)]
    t0 = time.time()
    env = dict(os.environ)
    if platform.system() == "Windows":
        creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        creation = 0
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, creationflags=creation)
    dt = time.time() - t0
    if r.returncode != 0 or not gcode.exists():
        msg = (r.stderr or r.stdout or "").strip().splitlines()
        raise RuntimeError("PrusaSlicer failed: " + (msg[-1] if msg else f"exit {r.returncode}"))
    res = parse_gcode_header(gcode)
    if "grams" not in res and "cm3" in res:
        m = re.search(r"filament_density\s*=\s*([\d.]+)", ini_text)
        res["grams"] = res["cm3"] * float(m.group(1)) if m else None
        res["grams_source"] = "cm3_x_density"
    else:
        res["grams_source"] = "gcode"
    res["time_s"] = dt
    res["gcode"] = str(gcode) if keep_gcode else None
    if not keep_gcode:
        try:
            gcode.unlink()
        except OSError:
            pass
    try:
        ini.unlink()
    except OSError:
        pass
    if res.get("grams") is None:
        raise RuntimeError("PrusaSlicer produced G-code without filament statistics")
    return res
