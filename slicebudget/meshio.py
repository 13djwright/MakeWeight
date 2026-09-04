"""Mesh loading, analysis and writing. numpy only.

Triangles are float64 arrays of shape (N, 3, 3): N triangles, 3 vertices, xyz.
"""
from __future__ import annotations

import hashlib
import io
import re
import struct
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np


# ---------------------------------------------------------------- loading
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
    """Read every mesh object of a 3MF (incl. Bambu's per-object files) and apply build transforms."""
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    root_model = next((n for n in names if n.lower().endswith("3d/3dmodel.model")), None)
    if root_model is None:
        raise ValueError("3MF has no 3D/3dmodel.model")
    ns = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
    meshes_by_file: dict[str, dict[str, np.ndarray]] = {}

    def parse_model(name: str) -> tuple[dict[str, np.ndarray], dict[str, list], list]:
        xml = ET.fromstring(z.read(name))
        objs: dict[str, np.ndarray] = {}
        comps: dict[str, list] = {}
        for obj in xml.iter("{%s}object" % ns["m"]):
            oid = obj.get("id")
            mesh = obj.find("m:mesh", ns)
            if mesh is not None:
                vs = [[float(v.get("x")), float(v.get("y")), float(v.get("z"))] for v in mesh.find("m:vertices", ns)]
                ts = [[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in mesh.find("m:triangles", ns)]
                if ts:
                    objs[oid] = np.array(vs)[np.array(ts)]
            cs = obj.find("m:components", ns)
            if cs is not None:
                comps[oid] = [(c.get("objectid"), c.get("transform"), c.get("{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path")) for c in cs]
        items = []
        build = xml.find("m:build", ns)
        if build is not None:
            for it in build:
                items.append((it.get("objectid"), it.get("transform"), it.get("{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path")))
        return objs, comps, items

    def tf(mat_str: str | None) -> np.ndarray:
        M = np.eye(4)
        if mat_str:
            v = list(map(float, mat_str.split()))
            if len(v) == 12:
                M[:3, :3] = np.array(v[:9]).reshape(3, 3).T
                M[:3, 3] = v[9:12]
        return M

    root_objs, root_comps, items = parse_model(root_model)
    cache = {root_model: (root_objs, root_comps)}

    def resolve(oid, path, M) -> list[np.ndarray]:
        fname = root_model if not path else path.lstrip("/")
        if fname not in cache:
            key = next((n for n in names if n.lower() == fname.lower()), None)
            if key is None:
                return []
            o, c, _ = parse_model(key)
            cache[fname] = (o, c)
        objs, comps = cache[fname]
        out = []
        if oid in objs:
            tri = objs[oid]
            pts = tri.reshape(-1, 3)
            pts = (M[:3, :3] @ pts.T).T + M[:3, 3]
            out.append(pts.reshape(-1, 3, 3))
        for (cid, ctf, cpath) in comps.get(oid, []):
            out += resolve(cid, cpath or (path if path else None), M @ tf(ctf))
        return out

    parts = []
    for (oid, t, p) in items:
        parts += resolve(oid, p, tf(t))
    if not parts:
        raise ValueError("3MF contains no triangles")
    return np.concatenate(parts, axis=0)


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
    pts = tri.reshape(-1, 3)
    key = np.round(pts / tol).astype(np.int64)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    faces = inv.reshape(-1, 3)
    verts = np.zeros((len(uniq), 3))
    np.add.at(verts, inv, pts)
    counts = np.bincount(inv, minlength=len(uniq)).reshape(-1, 1)
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
def write_stl(tri: np.ndarray, path: str | Path, name: bytes = b"SliceBudget") -> None:
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
    buf.write(b"SliceBudget".ljust(80, b"\0")); buf.write(struct.pack("<I", len(tri32))); buf.write(rec.tobytes())
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
