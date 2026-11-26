"""Static geography for the gateway: model grid, land mask, cell areas, distances, and which Indian state each cell is in.
Region raster: gateway/static/regions.json (0.05 deg RLE, built by tools/build_geography.py from DataMeet + Natural Earth)."""
from __future__ import annotations
import json, math
from functools import lru_cache
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
LAT = np.arange(6.5, 37.6, 1.0); LON = np.arange(65.5, 100.6, 1.0)
NLAT, NLON = len(LAT), len(LON)
LAT_RANGE, LON_RANGE = (6.0, 38.0), (65.0, 101.0)
CHANNELS = ["t2m", "tp", "u10", "v10", "msl", "tcwv"]
UNITS = ["K", "mm/day", "m/s", "m/s", "Pa", "kg/m2"]
STD = np.array([13.4636, 7.5533, 2.8990, 2.4270, 619.0198, 20.4944], "f4")   # kit stats.json per-channel std
KM_PER_DEG = 111.32
EARTH_R = 6371.0


@lru_cache(maxsize=1)
def grid():
    z = np.load(HERE / "static" / "grid.npz")
    return {"lsm": z["land_sea_mask"].astype("f4"), "orography_m": z["orography_m"].astype("f4")}


@lru_cache(maxsize=1)
def cell_area_km2() -> np.ndarray:
    return (KM_PER_DEG ** 2 * np.cos(np.deg2rad(LAT)))[:, None] * np.ones((1, NLON))


@lru_cache(maxsize=1)
def regions():
    """-> dict(names {code:name}, raster [640,720] int16, frac [32,36,K] share of each region code in every 1 deg cell)."""
    m = json.loads((HERE / "static" / "regions.json").read_text())
    rle = np.asarray(m["rle"], np.int64).reshape(-1, 2)
    raster = np.repeat(rle[:, 0], rle[:, 1]).astype(np.int16).reshape(m["nrows"], m["ncols"])
    names = {int(k): v for k, v in m["names"].items()}
    K = max(names) + 1; f = int(round(1.0 / m["res"]))
    blocks = raster.reshape(NLAT, f, NLON, f).transpose(0, 2, 1, 3).reshape(NLAT, NLON, f * f)
    frac = np.zeros((NLAT, NLON, K), "f4")
    for k in range(K):
        frac[..., k] = (blocks == k).mean(-1)
    states = [c for c in m["indian_state_codes"]]
    india = frac[..., states].sum(-1) + frac[..., [c for c, n in names.items() if n == "India (unassigned)"]].sum(-1)
    return {"names": names, "raster": raster, "frac": frac, "state_codes": states, "india_frac": india, "meta": m}


def region_at(lat: float, lon: float) -> str:
    r = regions(); m = r["meta"]
    i = int((lat - m["lat0"]) / m["res"]); j = int((lon - m["lon0"]) / m["res"])
    if not (0 <= i < m["nrows"] and 0 <= j < m["ncols"]):
        return "outside the model domain"
    return r["names"][int(r["raster"][i, j])]


def check_point(lat: float, lon: float):
    if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
        raise ValueError(f"centre ({lat:.2f} N, {lon:.2f} E) is outside the model domain "
                         f"{LAT_RANGE[0]:g}-{LAT_RANGE[1]:g} N, {LON_RANGE[0]:g}-{LON_RANGE[1]:g} E")


def distance_km(lat0: float, lon0: float) -> np.ndarray:
    """Great-circle distance from a point to every cell centre [32,36]."""
    la, lo = np.deg2rad(LAT)[:, None], np.deg2rad(LON)[None, :]
    a, b = math.radians(lat0), math.radians(lon0)
    h = np.sin((la - a) / 2) ** 2 + math.cos(a) * np.cos(la) * np.sin((lo - b) / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


def top_states(values: np.ndarray, weight: np.ndarray, n: int = 5, key: str = "mean_change"):
    """Per Indian state: area-share-weighted mean of `values` over cells where weight>0. Ranked by |mean| x cells."""
    r = regions(); out = []
    for c in r["state_codes"]:
        w = r["frac"][..., c] * weight
        cells = float(w.sum())
        if cells < 0.05:
            continue
        mean = float((values * w).sum() / cells)
        out.append({"state": r["names"][c], key: round(mean, 4), "cells": round(cells, 2)})
    out.sort(key=lambda d: -abs(d[key]) * d["cells"])
    return out[:n]
