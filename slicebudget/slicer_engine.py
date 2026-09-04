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
        mount_points = _hdiutil_attach(dmg)
        try:
            app = None
            for mp in mount_points:
                app = _find_app(mp)
                if app:
                    break
            if app is None:
                listing = "; ".join(f"{mp}: {[x.name for x in Path(mp).iterdir()]}" for mp in mount_points if Path(mp).exists())
                raise RuntimeError("No PrusaSlicer.app inside the disk image. Mounted at " + (listing or "nothing") +
                                   ". You can also point SliceBudget at an existing PrusaSlicer.app in Setup → 'Use a different install'.")
            dest = sd / app.name
            if dest.exists():
                shutil.rmtree(dest)
            prog("Copying application", 0.9)
            if shutil.which("ditto"):
                subprocess.run(["ditto", str(app), str(dest)], check=True)  # preserves the code signature
            else:
                shutil.copytree(app, dest, symlinks=True)
        finally:
            for mp in mount_points:
                subprocess.run(["hdiutil", "detach", str(mp), "-quiet", "-force"], check=False)
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


def _hdiutil_attach(dmg: Path) -> list[str]:
    """Mount a dmg (accepting any license prompt) and return its mount points."""
    import plistlib
    r = subprocess.run(["hdiutil", "attach", str(dmg), "-nobrowse", "-readonly", "-noautoopen", "-plist"],
                       input=b"Y\n", capture_output=True, timeout=300)
    mounts: list[str] = []
    if r.returncode == 0:
        try:
            out = r.stdout
            i = out.find(b"<?xml")  # a license agreement, if any, is printed before the plist
            info = plistlib.loads(out[i:] if i >= 0 else out)
            for ent in info.get("system-entities", []):
                if ent.get("mount-point"):
                    mounts.append(ent["mount-point"])
        except Exception:
            pass
    if not mounts:
        # fall back: whatever PrusaSlicer volume is mounted
        vols = Path("/Volumes")
        if vols.exists():
            mounts = [str(v) for v in vols.iterdir() if "prusa" in v.name.lower()]
    if not mounts:
        raise RuntimeError("Could not mount the PrusaSlicer disk image: " + (r.stderr or r.stdout or b"").decode(errors="replace")[-400:])
    return mounts


def _find_app(mount_point: str) -> Path | None:
    root = Path(mount_point)
    best = None
    for depth_glob in ("*.app", "*/*.app", "*/*/*.app"):
        for cand in root.glob(depth_glob):
            if cand.is_symlink() or not cand.is_dir():
                continue  # the 'Applications' shortcut in most dmgs
            if "prusa" in cand.name.lower():
                return cand
            best = best or cand
    return best


# ------------------------------------------------------------------ slicing
_HINTS = [
    (re.compile(r"no extrusions in the first layer|empty layers? detected|first layer is empty", re.I),
     "Nothing solid touches the bed in this orientation — the part is balancing on an edge, a point or a curve. Pick a flat face (Pick a face → Lay on bed) or use Auto."),
    (re.compile(r"too tall|exceeds the maximum print height|larger than the print volume|outside (of )?the print (volume|area)", re.I),
     "The part does not fit the slicer's build volume in this orientation."),
    (re.compile(r"infill pattern .* is not supposed to work at 100%|not supposed to work at 100", re.I),
     "This infill pattern cannot be used at 100% — the profile should use rectilinear for solid parts."),
    (re.compile(r"empty print|nothing to (print|slice)|no object", re.I),
     "The slicer produced nothing — the mesh may be empty or far below the bed."),
]


def explain_slicer_error(stderr: str | None, stdout: str | None, rc: int) -> str:
    """Turn PrusaSlicer's CLI output into one useful line (full text, plus a hint for the usual causes)."""
    def clean(txt):
        ls = [ln.strip() for ln in (txt or "").splitlines() if ln.strip() and not re.match(r"^\d+\s*=>", ln.strip())]
        return [ln for ln in ls if not ln.startswith("Slicing result exported")]
    err_lines, out_lines = clean(stderr), clean(stdout)
    # stderr carries the real error; stdout mostly carries progress and support/brim advice
    lines = err_lines or [ln for ln in out_lines if not re.search(r"consider enabling|bed adhesion|bridge anchors|bridging extrusions", ln, re.I)] or out_lines
    core = " ".join(lines[-4:]) if lines else f"exit code {rc}"
    core = re.sub(r"\s+", " ", core)[:400]
    for rx, hint in _HINTS:
        if rx.search(core):
            return f"{hint} (PrusaSlicer: {core})"
    return "PrusaSlicer failed: " + core


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
        raise RuntimeError(explain_slicer_error(r.stderr, r.stdout, r.returncode))
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
