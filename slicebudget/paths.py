"""Where the app lives vs. where its data lives.

The app folder (this package's parent, with python/ and the launcher) is disposable: a new version is a new folder.
Data (database, meshes, logs, backups) and the slicer installs live in the user's data directory, so any version's
launcher finds the same data and "updating" is just unzipping the new version and starting it.

    Windows   %LOCALAPPDATA%\\<Name>
    macOS     ~/Library/Application Support/<Name>
    Linux     $XDG_DATA_HOME/<slug>  (default ~/.local/share/<slug>)

<Name>/<slug> come from brand.json (currently MakeWeight / makeweight); renaming the app = editing that file.
Data left behind by an earlier name (brand.json "legacy_names") is adopted on first start.
Overrides: <NAME>_HOME (older GRMLN_HOME / SLICEBUDGET_HOME still work) points data anywhere; a file named `portable.txt` in the
app folder keeps data inside the app folder (USB-stick style).
"""
from __future__ import annotations

import os
import platform
import shutil
import sys
import time
from pathlib import Path

def _brand() -> dict:
    import json
    try:
        return json.loads((Path(__file__).parent / "brand.json").read_text(encoding="utf-8"))
    except Exception:
        return {"name": "MakeWeight", "slug": "makeweight", "tagline": "", "legacy_names": []}


BRAND = _brand()
APP_NAME = BRAND.get("name") or "MakeWeight"            # folders, launchers, zips, UI
APP_SLUG = BRAND.get("slug") or APP_NAME.lower()       # Linux data dir, shell launcher
LEGACY_NAMES = list(BRAND.get("legacy_names") or [])   # earlier names whose folders/data we adopt
LEGACY_NAME = LEGACY_NAMES[-1] if LEGACY_NAMES else APP_NAME


def install_dir() -> Path:
    """The folder the running app was unpacked into."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def os_data_dir(name: str | None = None) -> Path:
    name = name or APP_NAME
    s = platform.system()
    if s == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / name
    if s == "Darwin":
        return Path.home() / "Library" / "Application Support" / name
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / (APP_SLUG if name == APP_NAME else name.lower())


def data_root() -> Path:
    """Folder that holds data/ and slicer/."""
    for var in (APP_NAME.upper() + "_HOME", "GRMLN_HOME", "SLICEBUDGET_HOME"):
        v = os.environ.get(var)
        if v:
            return Path(v)
    if (install_dir() / "portable.txt").exists():
        return install_dir()
    return os_data_dir()


def is_portable() -> bool:
    return (install_dir() / "portable.txt").exists() or any(os.environ.get(v) for v in (APP_NAME.upper() + "_HOME", "GRMLN_HOME", "SLICEBUDGET_HOME"))


def _has_db(folder: Path) -> bool:
    return (folder / "data" / "slicebudget.db").exists()


def _move_tree(src: Path, dst: Path, log) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dst))
    except Exception as e:  # noqa — e.g. cross-device on Windows with a junction; fall back to copy
        log.warning("move %s -> %s failed (%s); copying instead", src, dst, e)
        shutil.copytree(src, dst, dirs_exist_ok=True)
        shutil.rmtree(src, ignore_errors=True)


def _merge_move(src: Path, dst: Path, log) -> None:
    """Move src to dst; if dst already exists (e.g. data/logs was created before migration ran), move the children
    into it one by one, never overwriting an existing file."""
    if not dst.exists():
        _move_tree(src, dst, log); return
    if src.is_file():
        return
    for child in list(src.iterdir()):
        _merge_move(child, dst / child.name, log)
    try:
        if not any(src.iterdir()):
            src.rmdir()
    except OSError:
        pass


def migrate_legacy_data(log) -> list[str]:
    """First start of a version that keeps data in the user directory: adopt data/ and slicer/ from
    (a) this app folder (older layout) or (b) the newest sibling folder of a previous version. Returns notes."""
    notes: list[str] = []
    root = data_root()
    if is_portable():
        return notes
    root.mkdir(parents=True, exist_ok=True)
    if _has_db(root):
        return notes
    # (0) the same user data directory under an earlier app name: rename it in place (same volume → instant)
    for old_name in LEGACY_NAMES:
        legacy_root = os_data_dir(old_name)
        if legacy_root != root and _has_db(legacy_root):
            log.info("adopting data directory %s as %s", legacy_root, root)
            moved = []
            for sub in ("data", "slicer", "updates", "MIGRATED.txt"):
                if (legacy_root / sub).exists():
                    _merge_move(legacy_root / sub, root / sub, log); moved.append(sub)
            try:
                if not any(legacy_root.iterdir()):
                    legacy_root.rmdir()
            except OSError:
                pass
            notes.append(f"Moved your data from the previous name's folder ({legacy_root}) to {root}")
            (root / "MIGRATED.txt").write_text(time.strftime("%Y-%m-%d %H:%M:%S") + "\n" + "\n".join(notes) + "\n", encoding="utf-8")
            return notes
    here = install_dir()
    candidates: list[Path] = []
    if _has_db(here):
        candidates.append(here)
    try:
        for sib in here.parent.iterdir():
            if sib.is_dir() and sib != here and any(sib.name.startswith(n) for n in [APP_NAME, *LEGACY_NAMES]) and _has_db(sib):
                candidates.append(sib)
    except OSError:
        pass
    if not candidates:
        return notes
    # newest database wins
    candidates.sort(key=lambda c: (c / "data" / "slicebudget.db").stat().st_mtime, reverse=True)
    src = candidates[0]
    log.info("adopting data from %s into %s", src, root)
    # data/: move (copy for a sibling version so the old install keeps working until the user deletes it)
    if src == here:
        _move_tree(src / "data", root / "data", log)
        notes.append(f"Moved your data from {src / 'data'} to {root / 'data'}")
    else:
        shutil.copytree(src / "data", root / "data", dirs_exist_ok=True)
        notes.append(f"Copied your data from the previous version ({src.name}) to {root / 'data'}")
    # slicer/: adopt if present and non-trivial (Bambu Studio / PrusaSlicer installs are hundreds of MB)
    ssrc = src / "slicer"
    if ssrc.exists() and any(p for p in ssrc.iterdir() if p.name != ".keep") and not any(p for p in (root / "slicer").glob("*") if p.name != ".keep"):
        try:
            if src == here:
                _move_tree(ssrc, root / "slicer", log)
            else:
                shutil.copytree(ssrc, root / "slicer", dirs_exist_ok=True, symlinks=True)
            notes.append(f"Brought the installed slicer along from {ssrc}")
        except Exception as e:  # noqa
            log.warning("could not adopt slicer folder from %s: %s", ssrc, e)
    (root / "MIGRATED.txt").write_text(time.strftime("%Y-%m-%d %H:%M:%S") + "\n" + "\n".join(notes) + "\n", encoding="utf-8")
    return notes
