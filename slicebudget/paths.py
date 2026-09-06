"""Where the app lives vs. where its data lives.

The app folder (this package's parent, with python/ and the launcher) is disposable: a new version is a new folder.
Data (database, meshes, logs, backups) and the slicer installs live in the user's data directory, so any version's
launcher finds the same data and "updating" is just unzipping the new version and starting it.

    Windows   %LOCALAPPDATA%\\GRMLN
    macOS     ~/Library/Application Support/GRMLN
    Linux     $XDG_DATA_HOME/grmln  (default ~/.local/share/grmln)

Overrides: GRMLN_HOME (or the older SLICEBUDGET_HOME) points data anywhere; a file named `portable.txt` in the
app folder keeps data inside the app folder (USB-stick style).
"""
from __future__ import annotations

import os
import platform
import shutil
import sys
import time
from pathlib import Path

APP_NAME = "GRMLN"
LEGACY_NAME = "SliceBudget"


def install_dir() -> Path:
    """The folder the running app was unpacked into."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def os_data_dir() -> Path:
    s = platform.system()
    if s == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_NAME
    if s == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / APP_NAME.lower()


def data_root() -> Path:
    """Folder that holds data/ and slicer/."""
    for var in ("GRMLN_HOME", "SLICEBUDGET_HOME"):
        v = os.environ.get(var)
        if v:
            return Path(v)
    if (install_dir() / "portable.txt").exists():
        return install_dir()
    return os_data_dir()


def is_portable() -> bool:
    return (install_dir() / "portable.txt").exists() or bool(os.environ.get("GRMLN_HOME") or os.environ.get("SLICEBUDGET_HOME"))


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
    here = install_dir()
    candidates: list[Path] = []
    if _has_db(here):
        candidates.append(here)
    try:
        for sib in here.parent.iterdir():
            if sib.is_dir() and sib != here and (sib.name.startswith(LEGACY_NAME) or sib.name.startswith(APP_NAME)) and _has_db(sib):
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
