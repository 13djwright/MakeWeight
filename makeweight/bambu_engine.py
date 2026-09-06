"""Bambu Studio adapter: find it, install it, build presets from its own bundled profiles, run it headless, read its numbers.

Bambu Studio is the reference the user compares against, so when this engine is active there is no settings mapping:
the process / machine / filament JSONs are Bambu's own system presets (resolved through their `inherits` chains) with
the profile's values written over them.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Callable

from . import slicer_engine
from .log import log, run_logged
from .slicer_engine import app_root, download

BAMBU_VERSION = "02.08.02.61"
_BUILD = "20260820225108"
BAMBU_URLS = {
    "Windows": f"https://github.com/bambulab/BambuStudio/releases/download/v{BAMBU_VERSION}/Bambu_Studio_win-v{BAMBU_VERSION}-{_BUILD}.zip",
    "Darwin": f"https://github.com/bambulab/BambuStudio/releases/download/v{BAMBU_VERSION}/Bambu_Studio_mac-v{BAMBU_VERSION}-{_BUILD}.dmg",
    "Linux": f"https://github.com/bambulab/BambuStudio/releases/download/v{BAMBU_VERSION}/BambuStudio_ubuntu22.04-v{BAMBU_VERSION}-{_BUILD}.AppImage",
}
FLATPAK_ID = "com.bambulab.BambuStudio"
ENGINE = "bambu"


def bambu_dir() -> Path:
    return app_root() / "slicer" / "bambu"


def _exe_names() -> list[str]:
    s = platform.system()
    if s == "Windows":
        return ["bambu-studio.exe"]
    if s == "Darwin":
        return ["BambuStudio"]
    return ["AppRun", "bambu-studio", "BambuStudio.AppImage", "Bambu_Studio.AppImage"]


def locate(configured: str | None = None) -> list[str] | None:
    """Command prefix for Bambu Studio, or None."""
    if configured:
        p = Path(configured)
        if p.is_file():
            return [str(p)]
        if p.is_dir():
            for n in _exe_names():
                for c in p.rglob(n):
                    if c.is_file() and ("MacOS" in str(c) or not c.name.startswith("Bambu")):
                        return [str(c)]
        if configured.startswith("flatpak"):
            return configured.split()
    bd = bambu_dir()
    if bd.is_dir():
        for n in _exe_names():
            hits = [c for c in bd.rglob(n) if c.is_file()]
            hits.sort(key=lambda c: ("MacOS" not in str(c), len(str(c))))
            if hits:
                return [str(hits[0])]
    known = [
        Path(r"C:/Program Files/Bambu Studio/bambu-studio.exe"),
        Path("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"),
        Path.home() / "Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
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


def _env() -> dict:
    env = dict(os.environ)
    env.setdefault("LC_ALL", "C")
    if platform.system() == "Linux":
        rt = Path(tempfile.gettempdir()) / f"sb-xdg-{os.getuid() if hasattr(os, 'getuid') else 0}"
        rt.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(rt, 0o700)
        except OSError:
            pass
        env.setdefault("XDG_RUNTIME_DIR", str(rt))
    return env


def _version_cache_file() -> Path:
    return bambu_dir() / "version.txt"


def version_of(cmd: list[str]) -> str | None:
    """Version of the located Bambu Studio. `--help` prints it on Linux/macOS; the Windows build is a GUI-subsystem exe
    whose console output cannot be captured, so there we fall back to a real (tiny) slice and read the version from the
    G-code header, then cache it next to the install."""
    cache = _version_cache_file()
    try:
        if cache.exists():
            c = json.loads(cache.read_text())
            if c.get("cmd") == cmd and c.get("version") and Path(cmd[-1]).exists() and c.get("mtime") == os.path.getmtime(cmd[-1]):
                return c["version"]
    except Exception:  # noqa
        pass
    v = None
    try:
        r = run_logged(cmd + ["--help"], "bambu --help", capture_output=True, text=True, timeout=90, env=_env(),
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if platform.system() == "Windows" else 0)
        out = (r.stdout or "") + (r.stderr or "")
        m = re.search(r"BambuStudio-(\d[\d.]*\d)", out)
        if m:
            v = m.group(1)
        elif "cannot open shared object" in out:
            log.warning("bambu --help: %s", out.strip()[-300:])
            return None
        else:
            log.info("bambu --help printed nothing usable (exit %s) — running a probe slice instead", r.returncode)
    except Exception as e:  # noqa
        log.warning("bambu --help failed: %s", e)
        return None
    if not v:
        v = probe_version(cmd)
    if v:
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({"cmd": cmd, "version": v, "mtime": os.path.getmtime(cmd[-1])}))
        except Exception:  # noqa
            pass
    return v


def probe_version(cmd: list[str]) -> str | None:
    """Slice a 10 mm cube with the bundled presets and read '; BambuStudio <version>' from the G-code."""
    res = resources_dir(cmd)
    if res is None:
        log.warning("bambu probe: no resources/profiles/BBL next to %s", cmd)
        return None
    from . import meshio, profiles
    work = Path(tempfile.mkdtemp(prefix="sb-bambu-probe-"))
    try:
        cube = work / "cube.stl"
        meshio.write_stl(meshio.box_mesh([0, 0, 0], [10, 10, 10]), cube)
        P = Presets(res)
        presets = P.write(work / "presets", profiles.normalize({}), {"name": "Generic PLA", "material": "PLA", "density": 1.24, "flow": 0.98, "max_vol_speed": 12}, "P1S")
        r = run_slice(cmd, cube, presets, work / "job", work / "data", keep_gcode=True, timeout=600)
        v = r.get("slicer_version")
        log.info("bambu probe slice: %s g, version %s", r.get("grams"), v)
        return v or "unknown"
    except Exception as e:  # noqa
        log.error("bambu probe slice failed: %s", e)
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def missing_libs(cmd: list[str]) -> str | None:
    """Linux only: the AppImage needs GTK/WebKit even to slice headless. Returns a hint if a library is missing."""
    try:
        r = subprocess.run(cmd + ["--help"], capture_output=True, text=True, timeout=60, env=_env())
        out = (r.stdout or "") + (r.stderr or "")
        m = re.search(r"error while loading shared libraries: ([^:]+):", out)
        if m:
            return (f"Bambu Studio needs the system library {m.group(1)}. On Ubuntu/Debian: "
                    "sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libglu1-mesa libegl1")
    except Exception:
        pass
    return None


def resources_dir(cmd: list[str] | None) -> Path | None:
    """Folder holding profiles/BBL/… for the located install."""
    if not cmd:
        return None
    exe = Path(cmd[-1] if cmd[0] != "flatpak" else "")
    cands = []
    if exe.name:
        cands += [exe.parent / "resources",                                  # Windows zip, Linux AppRun dir
                  exe.parent.parent / "Resources",                           # macOS .app/Contents/MacOS/BambuStudio
                  exe.parent.parent / "resources"]
    if cmd[0] == "flatpak":
        cands += [Path("/var/lib/flatpak/app") / FLATPAK_ID / "current/active/files/bin/resources",
                  Path.home() / ".local/share/flatpak/app" / FLATPAK_ID / "current/active/files/bin/resources"]
    for c in cands:
        if (c / "profiles" / "BBL").is_dir():
            return c
    return None


# ------------------------------------------------------------------ install
def install(progress: Callable[[str, float], None] | None = None) -> list[str]:
    s = platform.system()
    bd = bambu_dir()
    bd.mkdir(parents=True, exist_ok=True)

    def prog(msg, frac):
        if progress:
            progress(msg, frac)

    log.info("bambu install: platform=%s target=%s (path length %d)", s, bd, len(str(bd)))
    if s == "Windows":
        z = bd / "download.zip"
        prog("Downloading Bambu Studio " + BAMBU_VERSION + " (about 470 MB)", 0.0)
        download(BAMBU_URLS["Windows"], z, lambda d, t: prog(f"Downloading {d / 1e6:.0f} / {t / 1e6:.0f} MB", 0.8 * d / t if t else 0.4))
        log.info("bambu install: downloaded %.1f MB", z.stat().st_size / 1e6)
        prog("Unpacking (this takes a minute)", 0.85)
        # Windows still has a 260-character path limit unless long paths are enabled; the \\?\ prefix lifts it
        target = str(bd.resolve())
        if not target.startswith("\\\\?\\"):
            target = "\\\\?\\" + target
        n = 0
        with zipfile.ZipFile(z) as zf:
            infos = [i for i in zf.infolist() if not i.filename.lower().endswith(".pdb")]  # skip ~200 MB of debug symbols
            for k, info in enumerate(infos):
                try:
                    zf.extract(info, target)
                except OSError as e:
                    if target != str(bd):
                        log.warning("bambu install: long-path extract failed for %s (%s); retrying without the prefix", info.filename, e)
                        target = str(bd)
                        zf.extract(info, target)
                    else:
                        raise RuntimeError(f"Could not unpack {info.filename}: {e}. The install folder path is {len(str(bd))} characters long; "
                                           "Windows limits paths to 260 unless long paths are enabled — try moving the app to a shorter path such as C:\\MakeWeight.") from e
                n += 1
                if k % 500 == 0:
                    prog(f"Unpacking {k}/{len(infos)}", 0.85 + 0.08 * k / max(1, len(infos)))
        log.info("bambu install: extracted %d files", n)
        z.unlink(missing_ok=True)
    elif s == "Darwin":
        dmg = bd / "download.dmg"
        prog("Downloading Bambu Studio " + BAMBU_VERSION + " (about 290 MB)", 0.0)
        download(BAMBU_URLS["Darwin"], dmg, lambda d, t: prog(f"Downloading {d / 1e6:.0f} / {t / 1e6:.0f} MB", 0.8 * d / t if t else 0.4))
        prog("Mounting disk image", 0.85)
        mounts = slicer_engine._hdiutil_attach(dmg)
        try:
            app = None
            for mp in mounts:
                for cand in list(Path(mp).glob("*.app")) + list(Path(mp).glob("*/*.app")):
                    if cand.is_dir() and not cand.is_symlink():
                        app = cand
                        break
                if app:
                    break
            if app is None:
                raise RuntimeError("No BambuStudio.app inside the disk image (mounted at %s)" % ", ".join(mounts))
            dest = bd / app.name
            if dest.exists():
                shutil.rmtree(dest)
            prog("Copying application", 0.9)
            if shutil.which("ditto"):
                run_logged(["ditto", str(app), str(dest)], "ditto", check=True)
            else:
                shutil.copytree(app, dest, symlinks=True)
        finally:
            for mp in mounts:
                run_logged(["hdiutil", "detach", str(mp), "-quiet", "-force"], "hdiutil detach", check=False)
        subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(dest)], check=False)
        dmg.unlink(missing_ok=True)
    else:
        img = bd / "BambuStudio.AppImage"
        prog("Downloading Bambu Studio " + BAMBU_VERSION + " (about 230 MB)", 0.0)
        download(BAMBU_URLS["Linux"], img, lambda d, t: prog(f"Downloading {d / 1e6:.0f} / {t / 1e6:.0f} MB", 0.8 * d / t if t else 0.4))
        img.chmod(img.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
        prog("Unpacking AppImage", 0.85)
        # extract so it runs without FUSE and so the bundled profiles are readable
        r = run_logged([str(img), "--appimage-extract"], "appimage extract", cwd=str(bd), capture_output=True, text=True, timeout=900)
        if r.returncode != 0 or not (bd / "squashfs-root" / "AppRun").exists():
            raise RuntimeError("Could not unpack the AppImage: " + (r.stderr or r.stdout)[-400:])
        img.unlink(missing_ok=True)
    prog("Verifying (a test slice, a few seconds)", 0.95)
    cmd = locate()
    log.info("bambu install: located %s; resources %s", cmd, resources_dir(cmd) if cmd else None)
    if not cmd:
        raise RuntimeError("Bambu Studio was unpacked but no executable was found in " + str(bd))
    if resources_dir(cmd) is None:
        raise RuntimeError("Bambu Studio was unpacked but its preset library (resources/profiles/BBL) is missing in " + str(bd))
    v = version_of(cmd)
    if not v:
        hint = missing_libs(cmd)
        raise RuntimeError(hint or ("Bambu Studio is installed but a test slice failed — see Diagnostics on this page. Command: " + " ".join(cmd)))
    prog("Installed Bambu Studio " + v, 1.0)
    log.info("bambu install: done, version %s", v)
    return cmd


# ------------------------------------------------------------------ presets
_PROCESS_BASE = {  # (nozzle, machine family) -> system process preset to start from
    ("0.4", "P1S"): "0.20mm Standard @BBL X1C",
    ("0.6", "P1S"): "0.30mm Standard @BBL X1C 0.6 nozzle",
    ("0.4", "H2D"): "0.20mm Standard @BBL H2D",
    ("0.6", "H2D"): "0.30mm Standard @BBL H2D 0.6 nozzle",
}
_MACHINE = {"P1S": "Bambu Lab P1S {n} nozzle", "H2D": "Bambu Lab H2D {n} nozzle"}
_PATTERN_TO_BAMBU = {"stars": "tri-hexagon", "alignedrectilinear": "alignedrectilinear"}


class Presets:
    def __init__(self, res: Path):
        self.bbl = res / "profiles" / "BBL"
        self._cache: dict = {}

    def load(self, kind: str, name: str) -> dict:
        key = (kind, name)
        if key in self._cache:
            return dict(self._cache[key])
        p = self.bbl / kind / (name + ".json")
        if not p.exists():
            raise FileNotFoundError(f"Bambu preset not found: {kind}/{name}")
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("inherits"):
            base = self.load(kind, d["inherits"])
            base.update({k: v for k, v in d.items() if k != "inherits"})
            d = base
        d.pop("inherits", None)
        self._cache[key] = d
        return dict(d)

    def has(self, kind: str, name: str) -> bool:
        return (self.bbl / kind / (name + ".json")).exists()

    def filament_for(self, filament: dict, machine: str, nozzle: str) -> dict:
        """Bambu's preset for this filament if its name matches one, otherwise Generic PLA; our density/flow/speed on top."""
        name = filament.get("name") or ""
        short = machine
        cands = [f"{name} @BBL {short} {nozzle} nozzle", f"{name} @BBL {short}", f"{name} @BBL X1C {nozzle} nozzle", f"{name} @BBL X1C", name,
                 f"Generic {filament.get('material') or 'PLA'}", "Generic PLA"]
        base = None
        for c in cands:
            if self.has("filament", c):
                base = self.load("filament", c)
                break
        if base is None:
            base = self.load("filament", "Generic PLA")

        def setarr(k, v):
            old = base.get(k)
            n = len(old) if isinstance(old, list) and old else 1
            base[k] = [str(v)] * n
        setarr("filament_density", f"{float(filament['density']):g}")
        setarr("filament_flow_ratio", f"{float(filament.get('flow') or 1.0):g}")
        if filament.get("max_vol_speed"):
            setarr("filament_max_volumetric_speed", f"{float(filament['max_vol_speed']):g}")
        mach_name = _MACHINE.get(machine, _MACHINE["P1S"]).format(n=nozzle)
        cp = list(base.get("compatible_printers") or [])
        if mach_name not in cp:
            cp.append(mach_name)
        base["compatible_printers"] = cp
        base["filament_settings_id"] = [name or "filament"]
        base["name"] = name or base.get("name")
        return base

    def machine_for(self, machine: str, nozzle: str) -> dict:
        return self.load("machine", _MACHINE.get(machine, _MACHINE["P1S"]).format(n=nozzle))

    def process_for(self, params: dict, machine: str) -> dict:
        from . import profiles
        p = profiles.normalize(params)
        nozzle = f"{p['nozzle']:g}"
        name = _PROCESS_BASE.get((nozzle, machine)) or _PROCESS_BASE[("0.4", machine if machine in ("P1S", "H2D") else "P1S")]
        d = self.load("process", name)
        lw = p["line_widths"]
        pattern = _PATTERN_TO_BAMBU.get(p["pattern"], p["pattern"])
        over = {
            "layer_height": f"{p['layer_height']:g}", "initial_layer_print_height": f"{p['first_layer_height']:g}",
            "wall_loops": str(int(p["walls"])), "top_shell_layers": str(int(p["top"])), "bottom_shell_layers": str(int(p["bottom"])),
            "top_shell_thickness": f"{p['top_min_thickness']:g}", "bottom_shell_thickness": f"{p['bottom_min_thickness']:g}",
            "sparse_infill_density": f"{p['infill']:g}%", "sparse_infill_pattern": pattern,
            "infill_direction": f"{p.get('infill_direction', 45):g}",
            "line_width": f"{lw['outer']:g}", "outer_wall_line_width": f"{lw['outer']:g}", "inner_wall_line_width": f"{lw['inner']:g}",
            "sparse_infill_line_width": f"{lw['infill']:g}", "internal_solid_infill_line_width": f"{lw['solid']:g}",
            "top_surface_line_width": f"{lw['top']:g}", "initial_layer_line_width": f"{lw['first']:g}",
            "infill_wall_overlap": f"{p['infill_wall_overlap']:g}%", "minimum_sparse_infill_area": f"{p.get('min_sparse_area', 15):g}",
            "only_one_wall_top": "1" if p.get("one_wall_top", True) else "0",
            "detect_thin_wall": "1" if p.get("thin_walls") else "0",
            "filter_out_gap_fill": "0" if p.get("gap_fill", True) else "1000",
            # no supports / brim / skirt / tower / timelapse so the number is the part alone
            "enable_support": "0", "brim_type": "no_brim", "skirt_loops": "0", "enable_prime_tower": "0",
            "timelapse_type": "0", "spiral_mode": "0", "print_sequence": "by layer",
        }
        d.update(over)
        mach_name = _MACHINE.get(machine, _MACHINE["P1S"]).format(n=nozzle)
        cp = list(d.get("compatible_printers") or [])
        if mach_name not in cp:
            cp.append(mach_name)
        d["compatible_printers"] = cp
        d["name"] = "MakeWeight"
        d["print_settings_id"] = "MakeWeight"
        return d

    def write(self, work: Path, params: dict, filament: dict, machine: str) -> tuple[Path, Path, Path]:
        from . import profiles
        nozzle = f"{profiles.normalize(params)['nozzle']:g}"
        work.mkdir(parents=True, exist_ok=True)
        m, pr, f = work / "machine.json", work / "process.json", work / "filament.json"
        m.write_text(json.dumps(self.machine_for(machine, nozzle)), encoding="utf-8")
        pr.write_text(json.dumps(self.process_for(params, machine)), encoding="utf-8")
        f.write_text(json.dumps(self.filament_for(filament, machine, nozzle)), encoding="utf-8")
        return m, pr, f

    def bed_center(self, machine: str, nozzle: str = "0.4") -> tuple[float, float]:
        try:
            area = self.machine_for(machine, nozzle).get("printable_area") or []
            xs = [float(a.split("x")[0]) for a in area]; ys = [float(a.split("x")[1]) for a in area]
            return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        except Exception:
            return (128.0, 128.0)


# ------------------------------------------------------------------ slicing
_W_RE = re.compile(r";\s*total filament weight \[g\]\s*:\s*([\d.]+)")
_T_RE = re.compile(r";\s*model printing time:\s*([^;]+);\s*total estimated time:\s*([^\n]+)")
_V_RE = re.compile(r";\s*total filament used \[cm\^?3\]\s*:\s*([\d.]+)")


def _parse_time(s: str) -> float:
    total = 0
    for val, unit in re.findall(r"(\d+)\s*([dhms])", s):
        total += int(val) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return float(total)


def run_slice(cmd: list[str], model_path: Path, presets: tuple[Path, Path, Path], work_dir: Path, datadir: Path,
              keep_gcode: bool = False, timeout: int = 1800) -> dict:
    machine, process, filament = presets
    out = work_dir / "out"
    out.mkdir(parents=True, exist_ok=True)
    datadir.mkdir(parents=True, exist_ok=True)
    args = cmd + ["--datadir", str(datadir), "--load-settings", f"{machine};{process}", "--load-filaments", str(filament),
                  "--slice", "0", "--export-3mf", "result.3mf", "--outputdir", str(out), "--debug", "0", str(model_path)]
    t0 = time.time()
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0) if platform.system() == "Windows" else 0
    r = run_logged(args, f"bambu slice {model_path.name}", capture_output=True, text=True, timeout=timeout, env=_env(), creationflags=creation)
    dt = time.time() - t0
    gcodes = sorted(out.glob("*.gcode"))
    res: dict = {}
    rj = out / "result.json"
    if rj.exists():
        try:
            info = json.loads(rj.read_text(encoding="utf-8"))
            plates = info.get("sliced_plates") or []
            if plates:
                pl = plates[0]
                g = sum(float(f.get("total_used_g") or 0) for f in pl.get("filaments") or [])
                if g > 0:
                    res["grams"] = round(g, 3)
                if pl.get("total_predication"):
                    res["print_time_s"] = float(pl["total_predication"])
                res["feature_times"] = pl.get("feature_type_times")
            if info.get("error_string") and not gcodes and not res.get("grams"):
                res["error"] = info["error_string"]
        except Exception:
            pass
    if gcodes:
        head = gcodes[0].read_text(encoding="utf-8", errors="replace")[:200000]
        mv = re.search(r";\s*BambuStudio\s+(\S+)", head)
        if mv:
            res["slicer_version"] = mv.group(1)
        m = _W_RE.search(head)
        if m and "grams" not in res:
            res["grams"] = float(m.group(1))
        m = _V_RE.search(head)
        if m:
            res["cm3"] = float(m.group(1))
        m = _T_RE.search(head)
        if m and "print_time_s" not in res:
            res["print_time_s"] = _parse_time(m.group(2))
    if "grams" not in res:
        text = ((r.stderr or "") + "\n" + (r.stdout or "")).strip()
        lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("[")]
        msg = res.get("error") or " ".join(lines[-3:]) or f"exit code {r.returncode}"
        log.warning("bambu slice produced no result: rc=%s files=%s msg=%s", r.returncode, [p.name for p in out.iterdir()] if out.exists() else [], msg[:300])
        raise RuntimeError(slicer_engine.explain_slicer_error(None, "Bambu Studio: " + msg, r.returncode))
    res["grams_source"] = "bambu"
    res["time_s"] = dt
    res["gcode"] = str(gcodes[0]) if (keep_gcode and gcodes) else None
    if not keep_gcode:
        shutil.rmtree(out, ignore_errors=True)
    return res
