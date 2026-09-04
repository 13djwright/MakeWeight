"""Orientation helpers: auto-orient candidates and face-down rotations."""
from __future__ import annotations

import numpy as np

from . import meshio

AXIS_PRESETS = {
    "Z+": [0, 0, 1], "Z-": [0, 0, -1], "X+": [1, 0, 0], "X-": [-1, 0, 0], "Y+": [0, 1, 0], "Y-": [0, -1, 0],
}


def face_normals_areas(tri: np.ndarray):
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    a = 0.5 * np.linalg.norm(n, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        n = n / (2 * a[:, None])
    n[~np.isfinite(n)] = 0
    return n, a


def candidate_normals(tri: np.ndarray, max_candidates: int = 14) -> list[np.ndarray]:
    """Distinct outward directions with the most planar area, plus the six axes."""
    n, a = face_normals_areas(tri)
    key = np.round(n * 20).astype(int)  # ~3° bins
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    area = np.zeros(len(uniq)); np.add.at(area, inv, a)
    order = np.argsort(-area)[:max_candidates]
    cands = []
    for i in order:
        m = inv == i
        v = (n[m] * a[m, None]).sum(axis=0)
        if np.linalg.norm(v) > 1e-9:
            cands.append(v / np.linalg.norm(v))
    for ax in AXIS_PRESETS.values():
        cands.append(np.array(ax, float))
    # dedupe
    out = []
    for c in cands:
        if not any(np.dot(c, o) > 0.995 for o in out):
            out.append(c)
    return out


def rotation_face_down(normal) -> np.ndarray:
    """Rotation that points `normal` (an outward face normal) straight down (-Z)."""
    return meshio.rotation_between(normal, [0, 0, -1])


def score_orientation(tri_rot: np.ndarray) -> dict:
    n, a = face_normals_areas(tri_rot)
    lo, hi = meshio.bbox(tri_rot)
    zmin = lo[2]
    zc = tri_rot[:, :, 2].max(axis=1)
    contact = float(a[(n[:, 2] < -0.95) & (zc < zmin + 0.3)].sum())
    down = n[:, 2] < -np.cos(np.radians(45))  # facing down more than 45°
    overhang = float(a[down & (zc >= zmin + 0.3)].sum())
    height = float(hi[2] - lo[2])
    footprint = float((hi[0] - lo[0]) * (hi[1] - lo[1]))
    score = contact - 0.6 * overhang - 6.0 * height
    return {"contact_mm2": contact, "overhang_mm2": overhang, "height_mm": height, "score": float(score)}


def auto_orient(tri: np.ndarray) -> list[dict]:
    results = []
    for nrm in candidate_normals(tri):
        R = rotation_face_down(nrm)
        t = meshio.transform(tri, R)
        s = score_orientation(t)
        s["quat"] = meshio.mat_to_quat(R)
        s["normal"] = [float(v) for v in nrm]
        s["label"] = axis_label(nrm)
        results.append(s)
    results.sort(key=lambda r: -r["score"])
    return results


def axis_label(nrm) -> str:
    for k, v in AXIS_PRESETS.items():
        if np.dot(nrm, v) > 0.999:
            return k + " down"
    return "face " + "/".join(f"{x:+.2f}" for x in nrm)


def quat_for_preset(name: str) -> list:
    """Preset means: put this axis direction down on the bed."""
    return meshio.mat_to_quat(rotation_face_down(AXIS_PRESETS[name]))


def apply_orientation(tri: np.ndarray, orient: dict, scale: float = 1.0, mirror: bool = False) -> np.ndarray:
    q = orient.get("quat", [0, 0, 0, 1])
    R = meshio.quat_to_mat(q)
    t = meshio.transform(tri, R, scale=scale, mirror_x=mirror)
    return meshio.place_on_bed(t)
