"""Shock builder: turns a dashboard request into a perturbation [6,32,36] in PHYSICAL units (added to the last input day).

Exactly four shocks (realistic weather patterns live in events.py):
  judge_warm   the kit's warm_ocean shock, exactly (+3 K t2m, +15% tcwv over the Bay of Bengal box)
  judge_stall  the kit's monsoon_stall shock, exactly (-40% u10/v10 over the Arabian Sea box)
  zero         all zeros: must change nothing (proves the model is deterministic)
  custom       one variable, `amount` physical units at the centre, Gaussian footprint (sigma = radius/2 cells, cut to
               zero beyond 1.5 x radius so the shock stays local)
"""
from __future__ import annotations
import numpy as np

from backend.gateway import geo

T2M, TP, U10, V10, MSL, TCWV = range(6)
BOX_BAY_OF_BENGAL = (8.0, 20.0, 82.0, 94.0)        # the kit's judge boxes (lat_min, lat_max, lon_min, lon_max)
BOX_ARABIAN_SEA = (8.0, 20.0, 65.0, 75.0)

TYPES = {
    "judge_warm": "Warm Bay of Bengal: the judge's warm_ocean shock, exactly (+3 K temperature, +15% moisture over 8-20 N, 82-94 E).",
    "judge_stall": "Weaker Arabian Sea winds: the judge's monsoon_stall shock, exactly (-40% wind over 8-20 N, 65-75 E).",
    "zero": "Zero shock: adds nothing at all. The difference must be exactly 0 (the model is deterministic).",
    "custom": "Adds `amount` (physical units of `variable`) at the centre, Gaussian-shaped, `radius` cells wide.",
}
NAMES = {"judge_warm": "Warm Bay of Bengal", "judge_stall": "Weaker Arabian Sea winds", "zero": "Zero shock", "custom": "Custom"}
JUDGE_CENTRES = {"judge_warm": (14.0, 88.0), "judge_stall": (14.0, 70.0)}
BOXES = {"judge_warm": BOX_BAY_OF_BENGAL, "judge_stall": BOX_ARABIAN_SEA}


def _box_mask(box):
    la0, la1, lo0, lo1 = box
    return ((geo.LAT >= la0) & (geo.LAT <= la1))[:, None] & ((geo.LON >= lo0) & (geo.LON <= lo1))[None, :]


def judge_shock(name: str, last: np.ndarray) -> np.ndarray:
    """Identical to monsoon_r1.scoring.make_shock (verified in backend/gateway/test_gateway.py)."""
    d = np.zeros_like(last, dtype="f4")
    if name == "judge_warm":
        m = _box_mask(BOX_BAY_OF_BENGAL); d[T2M][m] = 3.0; d[TCWV][m] = 0.15 * last[TCWV][m]
    else:
        m = _box_mask(BOX_ARABIAN_SEA); d[U10][m] = -0.4 * last[U10][m]; d[V10][m] = -0.4 * last[V10][m]
    return d


def footprint(lat: float, lon: float, radius: float):
    """Gaussian weight [32,36] around (lat, lon)."""
    dx = (geo.LON[None, :] - lon) * np.cos(np.deg2rad(lat)) * np.ones((geo.NLAT, 1))
    dy = (geo.LAT[:, None] - lat) * np.ones((1, geo.NLON))
    r = np.hypot(dx, dy); s = max(radius, 0.5) / 2.0
    g = np.exp(-0.5 * (r / s) ** 2); g[r > 1.5 * max(radius, 0.5)] = 0.0
    return g.astype("f4")


def finalize(d: np.ndarray, last: np.ndarray) -> np.ndarray:
    """Keep the perturbed state physical: rain and moisture never negative, temperature in the valid band."""
    d = d.astype("f4", copy=True)
    d[TP] = np.maximum(d[TP], -last[TP]); d[TCWV] = np.maximum(d[TCWV], -last[TCWV])
    d[T2M] = np.clip(last[T2M] + d[T2M], 234.0, 332.0) - last[T2M]
    return d


def build(spec: dict, last: np.ndarray) -> tuple[np.ndarray, dict]:
    """spec: {type, lat, lon, radius (cells, default 4), variable, amount}. last [6,32,36] physical."""
    kind = spec.get("type")
    if kind not in TYPES:
        raise ValueError(f"unknown shock type {kind!r}; choose one of {', '.join(TYPES)}")
    radius = 6.0
    if kind in JUDGE_CENTRES:
        d = judge_shock(kind, last); lat, lon = JUDGE_CENTRES[kind]
    elif kind == "zero":
        d = np.zeros_like(last, dtype="f4"); lat, lon = float(spec.get("lat", 20.0)), float(spec.get("lon", 80.0))
    else:
        try:
            lat, lon = float(spec["lat"]), float(spec["lon"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("custom shock needs a numeric centre: 'lat' and 'lon'")
        geo.check_point(lat, lon)
        radius = float(spec.get("radius", 4.0))
        if not (0.5 <= radius <= 15):
            raise ValueError("radius must be between 0.5 and 15 cells")
        var = spec.get("variable")
        if var not in geo.CHANNELS:
            raise ValueError(f"custom shock needs 'variable' in {geo.CHANNELS}")
        try:
            amount = float(spec["amount"]) * float(spec.get("strength", 1.0))
        except (KeyError, TypeError, ValueError):
            raise ValueError("custom shock needs a numeric 'amount' in physical units")
        d = np.zeros_like(last, dtype="f4"); d[geo.CHANNELS.index(var)] = amount * footprint(lat, lon, radius)
    if kind != "zero":
        d = finalize(d, last)
    size = np.abs(d).reshape(6, -1).max(1) / geo.STD
    warn = [f"{geo.CHANNELS[c]} shock is {size[c]:.1f} std (> 3 std): very strong, the model may react unrealistically"
            for c in range(6) if size[c] > 3.0]
    info = {"kind": "shock", "type": kind, "name": NAMES[kind], "description": TYPES[kind],
            "centre": {"lat": lat, "lon": lon, "region": geo.region_at(lat, lon)}, "radius_cells": radius,
            "box": BOXES.get(kind), "size_std": {geo.CHANNELS[c]: round(float(size[c]), 3) for c in range(6)},
            "peak_physical": {geo.CHANNELS[c]: round(float(d[c].flat[np.abs(d[c]).argmax()]), 3) for c in range(6)},
            "cells_touched": int((np.abs(d / geo.STD[:, None, None]).max(0) > 1e-6).sum()), "warnings": warn}
    return d.astype("f4"), info
