# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Mesh loading, analysis and writing. numpy only.

Triangles are float64 arrays of shape (N, 3, 3): N triangles, 3 vertices, xyz.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import struct
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np

from .paths import APP_NAME as _APP


# ---------------------------------------------------------------- loading
MESH_DIR: Path | None = None      # set by the app at startup: where uploaded meshes live now


class MeshFileMissing(FileNotFoundError):
    pass


def basename(p: str) -> str:
    """Last path component, whichever OS wrote the path (both / and \\ count as separators)."""
    return re.split(r"[\\/]", str(p).rstrip("\\/"))[-1]


def mesh_path(mesh: dict) -> Path:
    """The file behind a meshes row. The database keeps the path the file had when it was uploaded; if the data
    folder has moved since (new install location, migration from an older version), the same file name in the current
    meshes folder is used instead. Raises MeshFileMissing with a message fit for the UI when neither exists."""
    stored = Path(mesh["path"]) if mesh.get("path") else None
    if stored and stored.exists():
        return stored
    if MESH_DIR is not None and stored is not None:
        # the row may have been written on another OS (shared data folder): "G:\…\meshes\x.stl" read on a Mac is one
        # opaque name to pathlib, so take the last component of either separator style
        alt = MESH_DIR / basename(mesh["path"])
        if alt.exists():
            return alt
    raise MeshFileMissing(f"The mesh file for “{mesh.get('filename', '?')}” is no longer on disk"
                          f"{f' (last seen at {stored})' if stored else ''}. Re-attach the mesh to this part.")


def load_mesh(path: str | Path, data: bytes | None = None) -> np.ndarray:
    p = Path(path)
    if data is None:
        data = p.read_bytes()
    ext = p.suffix.lower()
    if ext == ".stl":
        return _load_stl(data)
    if ext == ".obj":
        return _load_obj(data.decode("utf-8", "replace"))
    if ext == ".3mf":
        return _load_3mf(data)
    if ext == ".ply":
        return _load_ply(data)
    raise ValueError(f"Unsupported mesh format: {ext}")


def _load_stl(data: bytes) -> np.ndarray:
    # Binary if the size matches the header's triangle count; ASCII if it starts with 'solid' and doesn't
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + n * 50 == len(data):
            rec = np.frombuffer(data[84:84 + n * 50], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
            return rec["v"].astype(np.float64)
    text = data.decode("ascii", "replace")
    nums = re.findall(r"vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)", text)
    if not nums:
        raise ValueError("STL file has no triangles")
    v = np.array(nums, dtype=np.float64)
    if len(v) % 3:
        v = v[: len(v) - len(v) % 3]
    return v.reshape(-1, 3, 3)


def _load_obj(text: str) -> np.ndarray:
    verts, faces = [], []
    for line in text.splitlines():
        if line.startswith("v "):
            parts = line.split()
            verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
        elif line.startswith("f "):
            idx = [int(t.split("/")[0]) for t in line.split()[1:]]
            idx = [i - 1 if i > 0 else len(verts) + i for i in idx]
            for k in range(1, len(idx) - 1):  # fan triangulation
                faces.append([idx[0], idx[k], idx[k + 1]])
    if not faces:
        raise ValueError("OBJ file has no faces")
    V = np.array(verts, dtype=np.float64)
    return V[np.array(faces, dtype=np.int64)]


def _load_ply(data: bytes) -> np.ndarray:
    head_end = data.find(b"end_header")
    if head_end < 0:
        raise ValueError("Bad PLY header")
    header = data[:head_end].decode("ascii", "replace")
    body = data[head_end + len("end_header"):].lstrip(b"\r\n")
    if "format ascii" not in header:
        raise ValueError("Only ASCII PLY is supported")
    nv = int(re.search(r"element vertex (\d+)", header).group(1))
    nf = int(re.search(r"element face (\d+)", header).group(1))
    lines = body.decode("ascii", "replace").splitlines()
    V = np.array([list(map(float, l.split()[:3])) for l in lines[:nv]])
    F = []
    for l in lines[nv:nv + nf]:
        t = list(map(int, l.split()))
        for k in range(2, t[0]):
            F.append([t[1], t[k], t[k + 1]])
    return V[np.array(F, dtype=np.int64)]


def _load_3mf(data: bytes) -> np.ndarray:
    objs = load_3mf_objects(data)
    if not objs:
        raise ValueError("3MF contains no triangles")
    return np.concatenate([o["tri"] for o in objs], axis=0)


def load_3mf_objects(data: bytes) -> list[dict]:
    """Every build item of a 3MF as {name, tri (world coords), settings (slicer keys), source}.

    Understands plain 3MF, Bambu Studio projects (per-object files + Metadata/model_settings.config +
    project_settings.config) and PrusaSlicer projects (Metadata/Slic3r_PE_model.config + Slic3r_PE.config).
    """
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    root_model = next((n for n in names if n.lower().endswith("3d/3dmodel.model")), None)
    if root_model is None:
        raise ValueError("3MF has no 3D/3dmodel.model")
    ns = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
    PPATH = "{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path"

    def parse_model(name: str):
        xml = ET.fromstring(z.read(name))
        objs: dict[str, np.ndarray] = {}
        comps: dict[str, list] = {}
        onames: dict[str, str] = {}
        for obj in xml.iter("{%s}object" % ns["m"]):
            oid = obj.get("id")
            onames[oid] = obj.get("name") or ""
            mesh = obj.find("m:mesh", ns)
            if mesh is not None:
                vs = [[float(v.get("x")), float(v.get("y")), float(v.get("z"))] for v in mesh.find("m:vertices", ns)]
                ts = [[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in mesh.find("m:triangles", ns)]
                if ts:
                    objs[oid] = np.array(vs)[np.array(ts)]
            cs = obj.find("m:components", ns)
            if cs is not None:
                comps[oid] = [(c.get("objectid"), c.get("transform"), c.get(PPATH)) for c in cs]
        items = []
        build = xml.find("m:build", ns)
        if build is not None:
            for it in build:
                items.append((it.get("objectid"), it.get("transform"), it.get(PPATH)))
        return objs, comps, onames, items

    def tf(mat_str):
        M = np.eye(4)
        if mat_str:
            v = list(map(float, mat_str.split()))
            if len(v) == 12:
                M[:3, :3] = np.array(v[:9]).reshape(3, 3).T
                M[:3, 3] = v[9:12]
        return M

    cache = {}

    def get_model(fname):
        key = next((n for n in names if n.lower() == fname.lower()), None)
        if key is None:
            return None
        if key not in cache:
            cache[key] = parse_model(key)
        return cache[key]

    root = get_model(root_model)
    _, _, root_names, items = root

    def resolve(oid, path, M):
        model = get_model(path.lstrip("/") if path else root_model)
        if model is None:
            return [], ""
        objs, comps, onames, _ = model
        out = []
        nm = onames.get(oid, "")
        if oid in objs:
            pts = objs[oid].reshape(-1, 3)
            pts = (M[:3, :3] @ pts.T).T + M[:3, 3]
            out.append(pts.reshape(-1, 3, 3))
        for (cid, ctf, cpath) in comps.get(oid, []):
            sub, subname = resolve(cid, cpath or path, M @ tf(ctf))
            out += sub
            nm = nm or subname
        return out, nm

    # per-object settings
    settings_by_id: dict[str, dict] = {}
    names_by_id: dict[str, str] = {}
    project_defaults: dict = {}
    if "Metadata/model_settings.config" in names:  # Bambu Studio
        cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
        for obj in cfg.iter("object"):
            oid = obj.get("id"); st = {}
            for md in obj.findall("metadata"):
                k, v = md.get("key"), md.get("value")
                if k == "name":
                    names_by_id[oid] = v
                elif k:
                    st[k] = v
            settings_by_id[oid] = st
    if "Metadata/project_settings.config" in names:
        try:
            project_defaults = json.loads(z.read("Metadata/project_settings.config").decode("utf-8", "replace"))
        except Exception:
            project_defaults = {}
    if "Metadata/Slic3r_PE_model.config" in names:  # PrusaSlicer
        cfg = ET.fromstring(z.read("Metadata/Slic3r_PE_model.config"))
        for obj in cfg.iter("object"):
            oid = obj.get("id"); st = {}
            for md in obj.findall("metadata"):
                if md.get("type") == "object":
                    k, v = md.get("key"), md.get("value")
                    if k == "name":
                        names_by_id[oid] = v
                    elif k:
                        st[k] = v
            settings_by_id[oid] = st
    if "Metadata/Slic3r_PE.config" in names:
        for line in z.read("Metadata/Slic3r_PE.config").decode("utf-8", "replace").splitlines():
            line = line.strip().lstrip(";").strip()
            if "=" in line:
                k, v = line.split("=", 1); project_defaults[k.strip()] = v.strip()

    out = []
    for (oid, t, p) in items:
        tris, nm = resolve(oid, p, tf(t))
        if not tris:
            continue
        out.append({"name": names_by_id.get(oid) or root_names.get(oid) or nm or f"object {oid}", "tri": np.concatenate(tris, axis=0),
                    "settings": settings_by_id.get(oid, {}), "object_id": oid})
    for o in out:
        o["project_defaults"] = project_defaults
    return out


def slicer_settings_to_params(settings: dict, defaults: dict | None = None) -> dict:
    """Bambu Studio / PrusaSlicer keys -> app profile params (only what is present)."""
    src = dict(defaults or {}); src.update(settings or {})
    out = {}

    def num(v):
        try:
            return float(str(v).rstrip("%"))
        except (TypeError, ValueError):
            return None
    for keys, dst, conv in (
        (("wall_loops", "perimeters"), "walls", lambda v: int(num(v))),
        (("top_shell_layers", "top_solid_layers"), "top", lambda v: int(num(v))),
        (("bottom_shell_layers", "bottom_solid_layers"), "bottom", lambda v: int(num(v))),
        (("sparse_infill_density", "fill_density"), "infill", num),
        (("sparse_infill_pattern", "fill_pattern"), "pattern", lambda v: str(v)),
        (("layer_height",), "layer_height", num),
        (("initial_layer_print_height", "first_layer_height"), "first_layer_height", num),
        (("top_shell_thickness", "top_solid_min_thickness"), "top_min_thickness", num),
        (("bottom_shell_thickness", "bottom_solid_min_thickness"), "bottom_min_thickness", num),
        (("infill_wall_overlap", "infill_overlap"), "infill_wall_overlap", num),
    ):
        for k in keys:
            if k in src and src[k] not in (None, ""):
                try:
                    val = conv(src[k])
                    if val is not None:
                        out[dst] = val
                except (TypeError, ValueError):
                    pass
                break
    return out


# ---------------------------------------------------------------- analysis
def volume_mm3(tri: np.ndarray) -> float:
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    return float(abs(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)


def bbox(tri: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    pts = tri.reshape(-1, 3)
    return pts.min(axis=0), pts.max(axis=0)


def surface_area(tri: np.ndarray) -> float:
    return float(0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1).sum())


def _indexed(tri: np.ndarray, tol: float = 1e-6):
    """Weld coincident vertices (within tol) → (verts, faces). The three rounded coordinates are hashed into one
    24-byte record so np.unique sorts a 1-D array: several times less memory and time than unique(axis=0) on the
    multi-million-vertex meshes CAD exports produce."""
    pts = tri.reshape(-1, 3)
    key = np.ascontiguousarray(np.round(pts / tol).astype(np.int64))
    keyv = key.view(np.dtype((np.void, key.dtype.itemsize * 3))).ravel()
    _, first, inv = np.unique(keyv, return_index=True, return_inverse=True)
    del key, keyv
    inv = inv.ravel()
    faces = inv.reshape(-1, 3)
    verts = np.zeros((len(first), 3))
    np.add.at(verts, inv, pts)
    counts = np.bincount(inv, minlength=len(first)).reshape(-1, 1)
    verts /= counts
    return verts, faces


def is_watertight(tri: np.ndarray) -> bool:
    _, F = _indexed(tri)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e.sort(axis=1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return bool(np.all(cnt == 2))


def split_bodies(tri: np.ndarray) -> list[np.ndarray]:
    """Connected components by shared vertices (union-find)."""
    _, F = _indexed(tri)
    n = F.max() + 1
    parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in F:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[find(rc)] = ra
    roots = np.array([find(v) for v in F[:, 0]])
    bodies = []
    for r in np.unique(roots):
        bodies.append(tri[roots == r])
    bodies.sort(key=lambda t: -len(t))
    return bodies


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def guess_units_scale(tri: np.ndarray) -> float:
    """1.0 if the part looks like millimetres, 25.4 if it looks like inches."""
    lo, hi = bbox(tri)
    ext = hi - lo
    return 25.4 if ext.max() < 12.0 else 1.0


# ---------------------------------------------------------------- transforms
def quat_to_mat(q) -> np.ndarray:
    x, y, z, w = q
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mat_to_quat(R: np.ndarray):
    t = np.trace(R)
    if t > 0:
        s = (t + 1.0) ** 0.5 * 2
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = (1 + R[0, 0] - R[1, 1] - R[2, 2]) ** 0.5 * 2
            w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s; y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
        elif i == 1:
            s = (1 + R[1, 1] - R[0, 0] - R[2, 2]) ** 0.5 * 2
            w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s; y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
        else:
            s = (1 + R[2, 2] - R[0, 0] - R[1, 1]) ** 0.5 * 2
            w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s; y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    return [float(x), float(y), float(z), float(w)]


def rotation_between(a, b) -> np.ndarray:
    """Rotation matrix taking unit vector a onto unit vector b."""
    a = np.asarray(a, float); b = np.asarray(b, float)
    a /= np.linalg.norm(a); b /= np.linalg.norm(b)
    v = np.cross(a, b); c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(3)
        # 180°: rotate about any axis perpendicular to a
        p = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        axis = np.cross(a, p); axis /= np.linalg.norm(axis)
        return axis_angle(axis, np.pi)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def axis_angle(axis, ang) -> np.ndarray:
    axis = np.asarray(axis, float); axis /= np.linalg.norm(axis)
    x, y, z = axis; c, s = np.cos(ang), np.sin(ang); C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def transform(tri: np.ndarray, R: np.ndarray | None = None, scale: float = 1.0, mirror_x: bool = False) -> np.ndarray:
    pts = tri.reshape(-1, 3) * scale
    if mirror_x:
        pts = pts * np.array([-1.0, 1.0, 1.0])
    if R is not None:
        pts = (R @ pts.T).T
    out = pts.reshape(-1, 3, 3)
    if mirror_x:
        out = out[:, ::-1, :]  # keep outward winding after reflection
    return out


def place_on_bed(tri: np.ndarray, center_xy=(0.0, 0.0)) -> np.ndarray:
    lo, hi = bbox(tri)
    shift = np.array([center_xy[0] - (lo[0] + hi[0]) / 2, center_xy[1] - (lo[1] + hi[1]) / 2, -lo[2]])
    return tri + shift


# ---------------------------------------------------------------- writing
def write_stl(tri: np.ndarray, path: str | Path, name: bytes = b"MakeWeight") -> None:
    tri = np.ascontiguousarray(tri, dtype=np.float32)
    n = len(tri)
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(normals, axis=1, keepdims=True); ln[ln == 0] = 1
    normals = (normals / ln).astype(np.float32)
    rec = np.zeros(n, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"] = normals; rec["v"] = tri
    with open(path, "wb") as f:
        f.write(name.ljust(80, b"\0")[:80])
        f.write(struct.pack("<I", n))
        f.write(rec.tobytes())


def to_binary_stl_bytes(tri: np.ndarray) -> bytes:
    buf = io.BytesIO()
    tri32 = np.ascontiguousarray(tri, dtype=np.float32)
    normals = np.cross(tri32[:, 1] - tri32[:, 0], tri32[:, 2] - tri32[:, 0])
    ln = np.linalg.norm(normals, axis=1, keepdims=True); ln[ln == 0] = 1
    rec = np.zeros(len(tri32), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"] = (normals / ln).astype(np.float32); rec["v"] = tri32
    buf.write(_APP.encode().ljust(80, b"\0")); buf.write(struct.pack("<I", len(tri32))); buf.write(rec.tobytes())
    return buf.getvalue()


def analyze(tri: np.ndarray) -> dict:
    lo, hi = bbox(tri)
    return {
        "triangles": int(len(tri)),
        "volume_mm3": volume_mm3(tri),
        "area_mm2": surface_area(tri),
        "bbox": {"min": lo.tolist(), "max": hi.tolist(), "size": (hi - lo).tolist()},
        "watertight": is_watertight(tri) if len(tri) < 600000 else None,
        "bodies": len(split_bodies(tri)) if len(tri) < 400000 else 1,
        "units_scale_guess": guess_units_scale(tri),
    }


# ---------------------------------------------------------------- PrusaSlicer 3MF with modifiers
def box_mesh(lo, hi) -> np.ndarray:
    x0, y0, z0 = lo; x1, y1, z1 = hi
    v = lambda x, y, z: [x, y, z]  # noqa
    f = [[v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)], [v(x0, y0, z0), v(x1, y1, z0), v(x1, y0, z0)],
         [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1)], [v(x0, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
         [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1)], [v(x0, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
         [v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1)], [v(x1, y1, z0), v(x0, y1, z1), v(x1, y1, z1)],
         [v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1)], [v(x0, y1, z0), v(x0, y0, z1), v(x0, y1, z1)],
         [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)], [v(x1, y0, z0), v(x1, y1, z1), v(x1, y0, z1)]]
    return np.array(f, dtype=float)


def prusa_3mf_with_modifiers(tri: np.ndarray, name: str, modifiers: list[dict]) -> bytes:
    """A PrusaSlicer-style 3MF: one object whose mesh is the part followed by modifier boxes, with
    Metadata/Slic3r_PE_model.config declaring the modifier volumes and their setting overrides.
    modifiers: [{name, min:[x,y,z], max:[x,y,z], settings:{prusa_key: value}}] in the part's bed frame."""
    from xml.sax.saxutils import escape
    vols = [("ModelPart", name, tri, {})]
    for md in modifiers:
        vols.append(("ParameterModifier", md.get("name") or "modifier", box_mesh(md["min"], md["max"]), md.get("settings") or {}))
    all_tri = np.concatenate([v[2] for v in vols], axis=0)
    verts, faces = _indexed(all_tri, tol=1e-5)
    model = io.StringIO()
    model.write('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n')
    model.write(' <metadata name="Application">' + _APP + '</metadata>\n <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n')
    for v in verts:
        model.write(f'     <vertex x="{v[0]:.5f}" y="{v[1]:.5f}" z="{v[2]:.5f}"/>\n')
    model.write('    </vertices>\n    <triangles>\n')
    for f in faces:
        model.write(f'     <triangle v1="{f[0]}" v2="{f[1]}" v3="{f[2]}"/>\n')
    model.write('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n </build>\n</model>\n')
    cfg = io.StringIO()
    cfg.write('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n')
    cfg.write(f'  <metadata type="object" key="name" value="{escape(name)}"/>\n')
    first = 0
    for (vtype, vname, vtri, settings) in vols:
        last = first + len(vtri) - 1
        cfg.write(f'  <volume firstid="{first}" lastid="{last}">\n')
        cfg.write(f'   <metadata type="volume" key="name" value="{escape(vname)}"/>\n')
        cfg.write(f'   <metadata type="volume" key="volume_type" value="{vtype}"/>\n')
        cfg.write('   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n')
        for k, v in settings.items():
            cfg.write(f'   <metadata type="volume" key="{escape(str(k))}" value="{escape(str(v))}"/>\n')
        cfg.write('  </volume>\n')
        first = last + 1
    cfg.write(' </object>\n</config>\n')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n')
        z.writestr("3D/3dmodel.model", model.getvalue())
        z.writestr("Metadata/Slic3r_PE_model.config", cfg.getvalue())
    return buf.getvalue()


def bambu_3mf_with_modifiers(tri: np.ndarray, name: str, modifiers: list[dict], center=(128.0, 128.0)) -> bytes:
    """A Bambu Studio-style 3MF: the part and each modifier box are separate mesh objects, assembled into one
    object through <components>; Metadata/model_settings.config marks the boxes as modifier parts with their
    setting overrides (Bambu keys, e.g. wall_loops / sparse_infill_density).
    modifiers: [{name, min, max, settings}] in the part's bed frame (part centred on x=y=0, z from bed)."""
    from xml.sax.saxutils import escape
    parts = [(2, "normal_part", name, tri, {})]
    nid = 3
    for md in modifiers:
        parts.append((nid, "modifier_part", md.get("name") or "modifier", box_mesh(md["min"], md["max"]), md.get("settings") or {}))
        nid += 1
    root_id = nid
    model = io.StringIO()
    model.write('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n')
    model.write(' <metadata name="Application">' + _APP + '</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n')
    for (pid, subtype, pname, ptri, settings) in parts:
        verts, faces = _indexed(ptri, tol=1e-5)
        model.write(f'  <object id="{pid}" name="{escape(pname)}" type="model">\n   <mesh>\n    <vertices>\n')
        for v in verts:
            model.write(f'     <vertex x="{v[0]:.5f}" y="{v[1]:.5f}" z="{v[2]:.5f}"/>\n')
        model.write('    </vertices>\n    <triangles>\n')
        for f in faces:
            model.write(f'     <triangle v1="{f[0]}" v2="{f[1]}" v3="{f[2]}"/>\n')
        model.write('    </triangles>\n   </mesh>\n  </object>\n')
    model.write(f'  <object id="{root_id}" name="{escape(name)}" type="model">\n   <components>\n')
    for (pid, *_rest) in parts:
        model.write(f'    <component objectid="{pid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n')
    model.write('   </components>\n  </object>\n </resources>\n <build>\n')
    model.write(f'  <item objectid="{root_id}" transform="1 0 0 0 1 0 0 0 1 {center[0]:.4f} {center[1]:.4f} 0" printable="1"/>\n </build>\n</model>\n')
    cfg = io.StringIO()
    cfg.write(f'<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="{root_id}">\n    <metadata key="name" value="{escape(name)}"/>\n    <metadata key="extruder" value="1"/>\n')
    for (pid, subtype, pname, ptri, settings) in parts:
        cfg.write(f'    <part id="{pid}" subtype="{subtype}">\n      <metadata key="name" value="{escape(pname)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n')
        for k, v in settings.items():
            cfg.write(f'      <metadata key="{escape(str(k))}" value="{escape(str(v))}"/>\n')
        cfg.write('    </part>\n')
    cfg.write(f'  </object>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n    <model_instance>\n      <metadata key="object_id" value="{root_id}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="{root_id * 10}"/>\n    </model_instance>\n  </plate>\n</config>\n')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="config" ContentType="text/xml"/>\n</Types>\n')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n')
        z.writestr("3D/3dmodel.model", model.getvalue())
        z.writestr("Metadata/model_settings.config", cfg.getvalue())
    return buf.getvalue()


def bambu_project_filament(ps: dict, extruder: int = 1, variant: str = "Direct Drive Standard") -> dict | None:
    """The filament a Bambu Studio project assigns to `extruder` (1-based): name, material, density, flow, max
    volumetric speed. Bambu stores per-variant arrays (Standard / High Flow nozzle …) indexed through
    filament_self_index / filament_extruder_variant; older projects have one entry per filament."""
    if not ps:
        return None
    try:
        ids = ps.get("filament_settings_id") or []
        n = len(ids)
        if n == 0:
            return None
        i = max(0, min(n - 1, int(extruder) - 1))
        name = str(ids[i]).split(" @")[0].strip() or f"Filament {i + 1}"
        types = ps.get("filament_type") or []
        dens = ps.get("filament_density") or []
        self_idx = ps.get("filament_self_index") or []
        variants = ps.get("filament_extruder_variant") or []

        def pick(arr):
            if not isinstance(arr, list) or not arr:
                return None
            if len(arr) == n:
                return arr[i]
            if self_idx and variants and len(arr) == len(self_idx):
                cands = [k for k in range(len(arr)) if str(self_idx[k]) == str(i + 1)]
                for k in cands:
                    if k < len(variants) and variants[k] == variant:
                        return arr[k]
                if cands:
                    return arr[cands[0]]
            return arr[min(i, len(arr) - 1)]
        out = {"name": name, "material": (types[i] if i < len(types) else None) or "PLA",
               "density": float(pick(dens) or 1.24), "flow": float(pick(ps.get("filament_flow_ratio")) or 1.0),
               "max_vol_speed": float(pick(ps.get("filament_max_volumetric_speed")) or 12)}
        return out
    except Exception:
        return None


# ---------------------------------------------------------------- splitting into bodies (manifold-edge connectivity)
def split_bodies_by_edges(tri: np.ndarray, max_rounds: int = 200) -> list[np.ndarray]:
    """Connected components of the faces, joining two faces only across an edge that exactly two faces share.

    Parts exported together from CAD touch each other: a lid sitting on a chassis shares the corners and edges of the
    contact face with it, so vertex connectivity glues them into one body. Inside one closed solid every edge has
    exactly two faces; on a contact between two solids the same edge has four. Ignoring such edges keeps touching
    parts apart while every solid stays whole. Vectorised label propagation (hook + shortcut) — fine for millions of
    triangles without a Python loop per face."""
    if len(tri) == 0:
        return []
    _, F = _indexed(tri)
    nf = len(F)
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    e = np.sort(e, axis=1)
    face_of = np.tile(np.arange(nf), 3)
    key = e[:, 0].astype(np.int64) * (F.max() + 1) + e[:, 1]
    order = np.argsort(key, kind="stable")
    key, face_of = key[order], face_of[order]
    uniq, start, counts = np.unique(key, return_index=True, return_counts=True)
    two = counts == 2
    f1 = face_of[start[two]]; f2 = face_of[start[two] + 1]
    labels = np.arange(nf)
    for _ in range(max_rounds):
        la, lb = labels[f1], labels[f2]
        lo = np.minimum(la, lb); hi = np.maximum(la, lb)
        before = labels.copy()
        np.minimum.at(labels, hi, lo)
        # shortcut: point every label at its root
        for _k in range(64):
            nl = labels[labels]
            if np.array_equal(nl, labels):
                break
            labels = nl
        if np.array_equal(before, labels):
            break
    roots, inv = np.unique(labels, return_inverse=True)
    bodies = [tri[inv == i] for i in range(len(roots))]
    bodies.sort(key=lambda t: -len(t))
    return bodies


# ---------------------------------------------------------------- thumbnails (software render, no GPU, no deps)
def _png(rgba: np.ndarray) -> bytes:
    """Encode an (h, w, 4) uint8 array as PNG with the standard library."""
    import struct
    import zlib
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def render_thumbnail(tri: np.ndarray, w: int = 200, h: int = 150, color=(217, 95, 27)) -> bytes:
    """A small shaded PNG of a mesh from a three-quarter view above (the way it stands on the bed), transparent
    background. Triangles are projected, the ones larger than a pixel are subdivided until they are not, and every
    piece is splatted at its centroid into a depth buffer — a rasteriser without loops over triangles, which matters for
    multi-million-triangle CAD exports. Good enough to tell a chassis from a fork at a glance."""
    if len(tri) == 0:
        return _png(np.zeros((h, w, 4), np.uint8))
    t = tri.astype(np.float64)
    if len(t) > 600_000:                            # dense CAD exports: a subset is plenty for 200×150 px
        t = t[np.random.default_rng(0).choice(len(t), 600_000, replace=False)]
    az, el = np.radians(35.0), np.radians(55.0)
    rz = np.array([[np.cos(az), -np.sin(az), 0], [np.sin(az), np.cos(az), 0], [0, 0, 1]])
    rx = np.array([[1, 0, 0], [0, np.cos(el), -np.sin(el)], [0, np.sin(el), np.cos(el)]])
    R = rx @ rz
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    nv = n @ R.T
    v = t.reshape(-1, 3) @ R.T                     # rotated vertices, (3n, 3)
    lo, hi = v.min(axis=0), v.max(axis=0)
    span = max(hi[0] - lo[0], hi[1] - lo[1], 1e-9)
    pad = 6
    scale = (min(w, h) - 2 * pad) / span
    ox = (w - (hi[0] - lo[0]) * scale) / 2; oy = (h - (hi[1] - lo[1]) * scale) / 2
    sv = np.empty_like(v)
    sv[:, 0] = (v[:, 0] - lo[0]) * scale + ox
    sv[:, 1] = h - ((v[:, 1] - lo[1]) * scale + oy)
    sv[:, 2] = v[:, 2]
    T = sv.reshape(-1, 3, 3)                        # screen-space triangles
    shade = np.abs(nv @ (np.array([0.3, 0.5, 0.8]) / np.linalg.norm([0.3, 0.5, 0.8]))) * 0.75 + 0.25
    # subdivide screen-large triangles until each covers about a pixel (bounded: 12 rounds, 3M pieces)
    for _ in range(12):
        area = 0.5 * np.abs((T[:, 1, 0] - T[:, 0, 0]) * (T[:, 2, 1] - T[:, 0, 1]) - (T[:, 2, 0] - T[:, 0, 0]) * (T[:, 1, 1] - T[:, 0, 1]))
        ext = np.maximum(T[:, :, 0].max(1) - T[:, :, 0].min(1), T[:, :, 1].max(1) - T[:, :, 1].min(1))
        big = (area > 0.6) | (ext > 1.2)
        if not big.any() or len(T) > 3_000_000:
            break
        B, S = T[big], shade[big]
        a, b, c = B[:, 0], B[:, 1], B[:, 2]
        ab, bc, ca = (a + b) / 2, (b + c) / 2, (c + a) / 2
        T = np.concatenate([T[~big], np.stack([a, ab, ca], 1), np.stack([ab, b, bc], 1), np.stack([ca, bc, c], 1), np.stack([ab, bc, ca], 1)])
        shade = np.concatenate([shade[~big], S, S, S, S])
    cen = T.mean(axis=1)
    xi = np.clip(cen[:, 0].astype(int), 0, w - 1); yi = np.clip(cen[:, 1].astype(int), 0, h - 1)
    depth = cen[:, 2]
    flat = yi * w + xi
    order = np.argsort(depth, kind="stable")          # larger z = closer to the viewer after the tilt: written last, wins
    zb = np.full(h * w, -np.inf); zb[flat[order]] = depth[order]
    win = depth >= zb[flat] - 1e-9
    img = np.zeros((h * w, 4), np.uint8)
    col = np.array(color, dtype=np.float64)
    img[flat[win], :3] = (col[None, :] * shade[win, None]).clip(0, 255).astype(np.uint8)
    img[flat[win], 3] = 255
    img = img.reshape(h, w, 4)
    # close single-pixel holes from the neighbours
    a_ = img[:, :, 3] > 0
    if a_.any():
        from numpy.lib.stride_tricks import sliding_window_view
        pa = np.pad(a_, 1); pr = np.pad(img[:, :, :3], ((1, 1), (1, 1), (0, 0)))
        neigh = sliding_window_view(pa, (3, 3)).reshape(h, w, 9)
        holes = (~a_) & (neigh.sum(axis=2) >= 6)
        if holes.any():
            nr = sliding_window_view(pr, (3, 3), axis=(0, 1)).reshape(h, w, 3, 9)
            cnt = np.maximum(neigh.sum(axis=2), 1)
            avg = (nr.sum(axis=3) / cnt[:, :, None]).astype(np.uint8)
            img[holes, :3] = avg[holes]; img[holes, 3] = 255
    return _png(img)


# ---------------------------------------------------------------- level of detail for previews
def decimate_grid(tri: np.ndarray, target: int = 250_000) -> np.ndarray:
    """Cheap decimation for previews/thumbnails (never for slicing): snap vertices to a grid, merge the ones that
    land in the same cell, drop the triangles that collapse. The grid is coarsened until the result is under
    `target` triangles. Silhouette and features stay put; only the surface tessellation gets coarser."""
    if len(tri) <= target:
        return tri
    lo, hi = bbox(tri)
    ext = float((hi - lo).max()) or 1.0
    cells = 600.0
    out = tri
    for _ in range(12):
        cell = ext / cells
        pts = tri.reshape(-1, 3)
        key = np.floor((pts - lo) / cell).astype(np.int64)
        keyv = np.ascontiguousarray(key).view(np.dtype((np.void, 24))).ravel()
        _, inv = np.unique(keyv, return_inverse=True)
        inv = inv.ravel()
        nverts = int(inv.max()) + 1
        verts = np.zeros((nverts, 3)); np.add.at(verts, inv, pts)
        verts /= np.bincount(inv, minlength=nverts).reshape(-1, 1)
        faces = inv.reshape(-1, 3)
        keep = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
        out = verts[faces[keep]]
        if len(out) <= target:
            break
        cells *= 0.7
    return out
