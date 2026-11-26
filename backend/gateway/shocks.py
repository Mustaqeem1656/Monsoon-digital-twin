"""Shock builder: turns a dashboard request into a perturbation [6,32,36] in PHYSICAL units (added to the last input day).

Every shock except the two judge shocks has a Gaussian footprint around (lat, lon): sigma = radius/2 cells, cut to zero
beyond 1.5 x radius so the shock stays local. `strength` scales the default amplitude (1 = default).
"""
from __future__ import annotations
import numpy as np

from backend.gateway import geo

T2M, TP, U10, V10, MSL, TCWV = range(6)
BOX_BAY_OF_BENGAL = (8.0, 20.0, 82.0, 94.0)        # the kit's judge boxes (lat_min, lat_max, lon_min, lon_max)
BOX_ARABIAN_SEA = (8.0, 20.0, 65.0, 75.0)

TYPES = {
    "judge_warm": "Judge's warm_ocean shock, exactly: +3 K t2m and +15% tcwv over the Bay of Bengal box (8-20 N, 82-94 E).",
    "judge_stall": "Judge's monsoon_stall shock, exactly: -40% u10 and v10 over the Arabian Sea box (8-20 N, 65-75 E).",
    "heatwave": "+4 K x strength on 2 m temperature over land.",
    "warm_sea": "+3 K x strength temperature and +15% x strength moisture over sea.",
    "cyclone": "Low pressure (-15 hPa x strength), counter-clockwise winds (15 m/s x strength), +20% moisture, +20 mm rain.",
    "monsoon_stall": "Weakens the surface winds by 40% x strength (capped at 100%).",
    "rain_burst": "+60 mm/day x strength of rain and +10% moisture.",
    "dry_spell": "Removes rain (100% x strength, capped) and 20% x strength of the moisture.",
    "custom": "Adds `amount` (physical units of `variable`) x strength, Gaussian-shaped.",
}
JUDGE_CENTRES = {"judge_warm": (14.0, 88.0), "judge_stall": (14.0, 70.0)}


def _box_mask(box):
    la0, la1, lo0, lo1 = box
    return ((geo.LAT >= la0) & (geo.LAT <= la1))[:, None] & ((geo.LON >= lo0) & (geo.LON <= lo1))[None, :]


def judge_shock(name: str, last: np.ndarray) -> np.ndarray:
    """Identical to monsoon_r1.scoring.make_shock (verified in gateway/test_gateway.py)."""
    d = np.zeros_like(last, dtype="f4")
    if name == "judge_warm":
        m = _box_mask(BOX_BAY_OF_BENGAL); d[T2M][m] = 3.0; d[TCWV][m] = 0.15 * last[TCWV][m]
    else:
        m = _box_mask(BOX_ARABIAN_SEA); d[U10][m] = -0.4 * last[U10][m]; d[V10][m] = -0.4 * last[V10][m]
    return d


def footprint(lat: float, lon: float, radius: float):
    """Gaussian weight [32,36] and (east, north) offsets in cells from the centre."""
    dx = (geo.LON[None, :] - lon) * np.cos(np.deg2rad(lat)) * np.ones((geo.NLAT, 1))
    dy = (geo.LAT[:, None] - lat) * np.ones((1, geo.NLON))
    r = np.hypot(dx, dy); s = max(radius, 0.5) / 2.0
    g = np.exp(-0.5 * (r / s) ** 2); g[r > 1.5 * max(radius, 0.5)] = 0.0
    return g.astype("f4"), dx, dy, r


def build(spec: dict, last: np.ndarray) -> tuple[np.ndarray, dict]:
    """spec: {type, lat, lon, radius (cells, default 4), strength (default 1), variable, amount}. last [6,32,36] physical.
    Returns (perturbation [6,32,36], info with the shock size in std units and warnings)."""
    kind = spec.get("type")
    if kind not in TYPES:
        raise ValueError(f"unknown shock type {kind!r}; choose one of {', '.join(TYPES)}")
    if kind in JUDGE_CENTRES:
        d = judge_shock(kind, last); lat, lon = JUDGE_CENTRES[kind]; radius = 6.0; strength = 1.0
    else:
        try:
            lat, lon = float(spec["lat"]), float(spec["lon"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("shock needs a numeric centre: 'lat' and 'lon'")
        geo.check_point(lat, lon)
        radius = float(spec.get("radius", 4.0)); strength = float(spec.get("strength", 1.0))
        if not (0.5 <= radius <= 15):
            raise ValueError("radius must be between 0.5 and 15 cells")
        if not (0 < abs(strength) <= 5):
            raise ValueError("strength must be non-zero and at most 5 in size")
        g, dx, dy, r = footprint(lat, lon, radius)
        lsm = geo.grid()["lsm"]; d = np.zeros_like(last, dtype="f4")
        if kind == "heatwave":
            d[T2M] = 4.0 * strength * g * lsm
        elif kind == "warm_sea":
            sea = 1.0 - lsm; d[T2M] = 3.0 * strength * g * sea; d[TCWV] = 0.15 * strength * g * sea * last[TCWV]
        elif kind == "cyclone":
            rm = max(radius / 2.0, 0.5); x = r / rm
            vt = 15.0 * strength * x * np.exp(0.5 * (1 - x ** 2))          # Rankine-like tangential wind profile
            rr = np.where(r > 1e-6, r, 1.0)
            d[U10] = -vt * dy / rr * (g > 0); d[V10] = vt * dx / rr * (g > 0)  # counter-clockwise (northern hemisphere)
            d[MSL] = -1500.0 * strength * g; d[TCWV] = 0.20 * strength * g * last[TCWV]; d[TP] = 20.0 * strength * g
        elif kind == "monsoon_stall":
            f = min(0.4 * strength, 1.0) * g; d[U10] = -f * last[U10]; d[V10] = -f * last[V10]
        elif kind == "rain_burst":
            d[TP] = 60.0 * strength * g; d[TCWV] = 0.10 * strength * g * last[TCWV]
        elif kind == "dry_spell":
            d[TP] = -min(strength, 1.0) * g * last[TP]; d[TCWV] = -min(0.2 * strength, 1.0) * g * last[TCWV]
        elif kind == "custom":
            var = spec.get("variable")
            if var not in geo.CHANNELS:
                raise ValueError(f"custom shock needs 'variable' in {geo.CHANNELS}")
            try:
                amount = float(spec["amount"])
            except (KeyError, TypeError, ValueError):
                raise ValueError("custom shock needs a numeric 'amount' in physical units")
            d[geo.CHANNELS.index(var)] = amount * strength * g
    # keep the shocked state physical: rain and moisture never negative, temperature in the valid band
    d[TP] = np.maximum(d[TP], -last[TP]); d[TCWV] = np.maximum(d[TCWV], -last[TCWV])
    d[T2M] = np.clip(last[T2M] + d[T2M], 234.0, 332.0) - last[T2M]
    size = np.abs(d).reshape(6, -1).max(1) / geo.STD
    warn = [f"{geo.CHANNELS[c]} shock is {size[c]:.1f} std (> {3:g} std): very strong, the model may react unrealistically"
            for c in range(6) if size[c] > 3.0]
    info = {"type": kind, "description": TYPES[kind], "centre": {"lat": lat, "lon": lon, "region": geo.region_at(lat, lon)},
            "radius_cells": radius, "strength": strength,
            "size_std": {geo.CHANNELS[c]: round(float(size[c]), 3) for c in range(6)},
            "peak_physical": {geo.CHANNELS[c]: round(float(d[c].flat[np.abs(d[c]).argmax()]), 3) for c in range(6)},
            "cells_touched": int((np.abs(d / geo.STD[:, None, None]).max(0) > 1e-6).sum()), "warnings": warn}
    return d.astype("f4"), info
