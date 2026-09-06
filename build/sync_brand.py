"""Propagate slicebudget/brand.json into the few files that cannot read it at runtime (installers, README title).

Renaming the app:
  1. edit slicebudget/brand.json  (move the old name into "legacy_names" so existing users' data is adopted)
  2. python3 build/sync_brand.py
  3. commit; the next release ships zips/launchers/folders under the new name.
Everything else (UI title, data directory, updater asset names, launcher names, README.txt inside the zip) reads
brand.json directly.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
B = json.loads((ROOT / "slicebudget" / "brand.json").read_text(encoding="utf-8"))
APP, SLUG, TAG = B["name"], B.get("slug") or B["name"].lower(), B.get("tagline", "")
ENV = re.sub(r"[^A-Z0-9]", "", APP.upper())


def edit(rel: str, subs: list[tuple[str, str]]):
    p = ROOT / rel
    s = p.read_text(encoding="utf-8")
    n = 0
    for pat, rep in subs:
        s, k = re.subn(pat, rep, s, flags=re.M)
        n += k
    p.write_text(s, encoding="utf-8")
    print(f"{rel}: {n} substitutions")


edit("install.sh", [
    (r'^APP="[^"]*"$', f'APP="{APP}"'),
    (r'^SLUG="[^"]*"$', f'SLUG="{SLUG}"'),
    (r"\b(?!DEFAULT_)[A-Z0-9]+_(REPO|DIR)\b", ENV + r"_\1"),
])
edit("install.ps1", [
    (r'^\$App = "[^"]*"$', f'$App = "{APP}"'),
    (r'^\$Tagline = "[^"]*"$', f'$Tagline = "{TAG}"'),
    (r"\b(?!DEFAULT_)[A-Z0-9]+_(REPO|DIR)\b", ENV + r"_\1"),
])
edit("README.md", [
    (r"^# .* — .*$", f"# {APP} — {TAG}"),
])
if "--check" in sys.argv:
    import subprocess
    sys.exit(subprocess.call(["git", "-C", str(ROOT), "diff", "--quiet"]))
