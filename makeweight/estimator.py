# MakeWeight — make weight, with the numbers to prove it
# Copyright (C) 2026 Devin Wright (13djwright)
# SPDX-License-Identifier: GPL-3.0-or-later
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
# later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for details.
"""Geometric material model used only as an interpolator between real slices.

Raster approach, numpy only:
  * slice the oriented mesh into layer masks at a fixed pitch,
  * walls   = cells within the wall band of the outline (morphological erosion),
  * shells  = interior cells that are uncovered within T layers above / B below,
  * sparse  = remaining interior cells x infill density.
Volumes are reported per region so a per-part fit against real slices can correct them.
"""
from __future__ import annotations

import numpy as np

from . import meshio


def _scanline_fill(segs: np.ndarray, xmin: float, ymin: float, pitch: float, W: int, H: int) -> np.ndarray:
    mask = np.zeros((H, W), dtype=bool)
    if len(segs) == 0:
        return mask
    x0, y0 = segs[:, 0, 0], segs[:, 0, 1]
    x1, y1 = segs[:, 1, 0], segs[:, 1, 1]
    ylo, yhi = np.minimum(y0, y1), np.maximum(y0, y1)
    rows = np.arange(H)
    ys = ymin + (rows + 0.5) * pitch
    # bucket segments by the rows they span
    r0 = np.clip(np.ceil((ylo - ymin) / pitch - 0.5), 0, H).astype(int)
    r1 = np.clip(np.floor((yhi - ymin) / pitch - 0.5), -1, H - 1).astype(int)
    for i in range(len(segs)):
        if r1[i] < r0[i]:
            continue
        rr = np.arange(r0[i], r1[i] + 1)
        y = ys[rr]
        dy = y1[i] - y0[i]
        if dy == 0:
            continue
        t = (y - y0[i]) / dy
        xs = x0[i] + t * (x1[i] - x0[i])
        cols = np.round((xs - xmin) / pitch - 0.5).astype(int)
        # toggle from col to end: even-odd fill via cumulative XOR
        ok = (cols >= 0) & (cols < W)
        mask[rr[ok], cols[ok]] ^= True
        far = cols >= W
        # segments crossing to the right of the grid don't toggle anything inside
    # cumulative XOR along x turns toggle points into filled spans
    return np.bitwise_xor.accumulate(mask, axis=1)


def slice_masks(tri: np.ndarray, layer_h: float, pitch: float | None = None, max_cells: int = 450_000):
    """Return (masks[z,y,x], pitch, n_layers). tri must already be oriented with z >= 0."""
    lo, hi = meshio.bbox(tri)
    size = hi - lo
    if pitch is None:
        pitch = 0.2
        while (size[0] / pitch + 4) * (size[1] / pitch + 4) > max_cells:
            pitch *= 1.25
    xmin, ymin = lo[0] - 2 * pitch, lo[1] - 2 * pitch
    W = int(np.ceil((size[0] + 4 * pitch) / pitch)) + 1
    H = int(np.ceil((size[1] + 4 * pitch) / pitch)) + 1
    n_layers = max(1, int(np.ceil((size[2] - 1e-6) / layer_h)))
    masks = np.zeros((n_layers, H, W), dtype=bool)
    zs = tri[:, :, 2]
    zlo, zhi = zs.min(axis=1), zs.max(axis=1)
    for i in range(n_layers):
        z = lo[2] + (i + 0.5) * layer_h
        cand = tri[(zlo <= z) & (zhi > z)]
        if len(cand) == 0:
            continue
        segs = _plane_segments(cand, z)
        masks[i] = _scanline_fill(segs, xmin, ymin, pitch, W, H)
    return masks, pitch, n_layers


def _plane_segments(tri: np.ndarray, z: float) -> np.ndarray:
    """Intersect triangles with plane z; half-open rule (lower vertex in, upper out)."""
    out = []
    for e in ((0, 1), (1, 2), (2, 0)):
        a, b = tri[:, e[0]], tri[:, e[1]]
        za, zb = a[:, 2], b[:, 2]
        hit = ((za <= z) & (z < zb)) | ((zb <= z) & (z < za))
        t = np.zeros(len(tri))
        d = zb - za
        t[hit] = (z - za[hit]) / d[hit]
        p = a[:, :2] + t[:, None] * (b[:, :2] - a[:, :2])
        out.append(np.where(hit[:, None], p, np.nan))
    P = np.stack(out, axis=1)  # (N,3,2)
    hit = ~np.isnan(P[:, :, 0])
    two = hit.sum(axis=1) >= 2
    if not two.any():
        return np.zeros((0, 2, 2))
    P, hit = P[two], hit[two]
    order = np.argsort(~hit, axis=1, kind="stable")[:, :2]          # the two hit edges first
    return np.take_along_axis(P, order[:, :, None], axis=1)


def _erode(mask: np.ndarray, k: int) -> np.ndarray:
    """Approximately circular erosion by k pixels (alternating square / cross steps)."""
    m = mask
    for i in range(k):
        p = np.pad(m, 1, constant_values=False)
        c = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
        if i % 2 == 1:
            c &= p[:-2, :-2] & p[:-2, 2:] & p[2:, :-2] & p[2:, 2:]
        m = c
    return m


def _dilate(mask: np.ndarray, k: int) -> np.ndarray:
    return ~_erode(~mask, k)


class RegionModel:
    """Region volumes (cm3) for any walls/top/bottom on a cached raster of one oriented part."""

    def __init__(self, tri: np.ndarray, params: dict):
        self.layer_h = float(params["layer_height"])
        self.lw = params["line_widths"]
        self.masks, self.pitch, self.n = slice_masks(tri, self.layer_h)
        self.cell_cm3 = self.pitch * self.pitch * self.layer_h / 1000.0
        self._wall_cache: dict[int, np.ndarray] = {}
        self._cov_cache: dict[tuple, np.ndarray] = {}
        self.solid_volume_cm3 = float(self.masks.sum()) * self.cell_cm3

    def band_mm(self, walls: int) -> float:
        """Total wall band = sum of PrusaSlicer bead spacings (width - h(1-pi/4)), the material actually laid."""
        if walls <= 0:
            return 0.0
        corr = self.layer_h * (1 - np.pi / 4)
        return (self.lw["outer"] - corr) + max(0, walls - 1) * (self.lw["inner"] - corr)

    def interior_px(self, k: int) -> np.ndarray:
        """Interior after eroding the outline by k pixels."""
        if k not in self._wall_cache:
            self._wall_cache[k] = np.stack([_erode(m, k) for m in self.masks]) if k > 0 else self.masks.copy()
        return self._wall_cache[k]

    def covered(self, above: int, below: int) -> np.ndarray:
        """Cells that have solid material for `above` layers up and `below` layers down."""
        key = (above, below)
        if key in self._cov_cache:
            return self._cov_cache[key]
        cov = np.ones_like(self.masks)
        for k in range(1, above + 1):
            sh = np.zeros_like(self.masks); sh[:-k] = self.masks[k:]
            cov &= sh
        for k in range(1, below + 1):
            sh = np.zeros_like(self.masks); sh[k:] = self.masks[:-k]
            cov &= sh
        self._cov_cache[key] = cov
        return cov

    def regions(self, walls: int, top: int, bottom: int) -> dict:
        """Fractional wall band: blend the volumes at floor/ceil pixel erosions."""
        px = self.band_mm(walls) / self.pitch
        k0 = int(np.floor(px)); f = px - k0
        r0 = self._regions_px(k0, top, bottom)
        if f < 1e-6:
            return r0
        r1 = self._regions_px(k0 + 1, top, bottom)
        return {k: (1 - f) * r0[k] + f * r1[k] for k in r0}

    def _regions_px(self, k: int, top: int, bottom: int) -> dict:
        inner = self.interior_px(k)
        wall = self.masks & ~inner
        exposed = inner & ~self.covered(top, bottom)
        # small-feature filter: open by one pixel so slivers on slopes don't count as shells
        exposed = np.stack([_dilate(_erode(e, 1), 1) & inner[i] for i, e in enumerate(exposed)])
        sparse = inner & ~exposed
        # regions too narrow for an infill line become gap fill / solid in the slicer
        g = max(1, int(round(0.5 * self.lw["infill"] / self.pitch)))
        thin = np.stack([sp & ~_dilate(_erode(sp, g), g) for sp in sparse])
        sparse = sparse & ~thin
        # one-cell ring where sparse infill meets walls/shells: anchors + infill/wall overlap live here
        ring = np.stack([sp & ~_erode(sp, 1) for sp in sparse])
        return {"wall": float(wall.sum()) * self.cell_cm3, "shell": float(exposed.sum()) * self.cell_cm3,
                "sparse": float(sparse.sum()) * self.cell_cm3, "gap": float(thin.sum()) * self.cell_cm3,
                "ring": float(ring.sum()) * self.cell_cm3}


class FittedModel:
    """RegionModel plus per-part multipliers fitted to real slices."""

    def __init__(self, rm: RegionModel, density: float, flow: float):
        self.rm = rm
        self.k = density * flow
        self.coef = np.array([1.0, 1.0, 1.0, 1.0])
        self.anchors: list[tuple[tuple, float]] = []  # ((W,T,B,d), grams)
        self._reg_cache: dict[tuple, dict] = {}
        self.rms_err = None

    def _regions(self, W, T, B):
        key = (W, T, B)
        if key not in self._reg_cache:
            self._reg_cache[key] = self.rm.regions(W, T, B)
        return self._reg_cache[key]

    def features(self, W, T, B, d) -> np.ndarray:
        r = self._regions(W, T, B)
        if d >= 99.9:  # 100% infill is printed as solid infill, not a sparse pattern
            return np.array([r["wall"], r["shell"] + r.get("gap", 0.0) + r["sparse"], 0.0, 0.0]) * self.k
        if d <= 0.0:
            return np.array([r["wall"], r["shell"] + r.get("gap", 0.0), 0.0, 0.0]) * self.k
        return np.array([r["wall"], r["shell"] + r.get("gap", 0.0), r["sparse"] * (d / 100.0), r.get("ring", 0.0)]) * self.k

    def fit(self, anchors: list[tuple[tuple, float]], ridge: float = 0.05):
        self.anchors = list(anchors)
        X = np.array([self.features(*a) for a, _ in anchors])
        y = np.array([g for _, g in anchors])
        # ridge toward coefficient 1: minimise |Xc - y|^2 + ridge*|c-1|^2 * scale
        scale = float((X ** 2).sum() / max(1, X.shape[0])) * ridge
        n = X.shape[1]
        A = X.T @ X + scale * np.eye(n)
        b = X.T @ y + scale * np.ones(n)
        self.coef = np.linalg.solve(A, b)
        pred = X @ self.coef
        self.rms_err = float(np.sqrt(np.mean(((pred - y) / np.maximum(y, 1e-6)) ** 2)))
        return self.coef

    def predict(self, W, T, B, d) -> float:
        return float(self.features(W, T, B, d) @ self.coef)

    def solve_density(self, W, T, B, target_g: float) -> float | None:
        """Infill % that hits target for fixed walls/shells (linear in d)."""
        f0 = self.features(W, T, B, 0.0) @ self.coef
        f1 = self.features(W, T, B, 100.0) @ self.coef
        if f1 - f0 <= 1e-9:
            return None
        return float((target_g - f0) / (f1 - f0) * 100.0)


# ---------------------------------------------------------------- layer view
def layer_classification(rm: RegionModel, walls: int, top: int, bottom: int, i: int) -> np.ndarray:
    """uint8 class map for layer i: 0 empty, 1 wall, 2 shell/solid, 3 sparse, 4 gap-fill."""
    px = rm.band_mm(walls) / rm.pitch
    k = int(round(px))
    inner = rm.interior_px(k)[i]
    m = rm.masks[i]
    wall = m & ~inner
    exposed = inner & ~rm.covered(top, bottom)[i]
    exposed = _dilate(_erode(exposed, 1), 1) & inner
    sparse = inner & ~exposed
    g = max(1, int(round(0.5 * rm.lw["infill"] / rm.pitch)))
    thin = sparse & ~_dilate(_erode(sparse, g), g)
    out = np.zeros(m.shape, dtype=np.uint8)
    out[sparse & ~thin] = 3; out[thin] = 4; out[exposed] = 2; out[wall] = 1
    return out


def png_from_classes(cls: np.ndarray, colors: dict[int, tuple]) -> bytes:
    """Encode a class map as an RGBA PNG (stdlib only). Row 0 is the +Y edge."""
    import struct, zlib
    H, W = cls.shape
    lut = np.zeros((256, 4), dtype=np.uint8)
    for k, rgba in colors.items():
        lut[k] = rgba
    rgba = lut[cls[::-1]]  # flip so +Y is up in the image
    raw = b"".join(b"\x00" + rgba[r].tobytes() for r in range(H))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
