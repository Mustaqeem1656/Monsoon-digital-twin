"""Impact module: turns a rollout [steps,6,32,36] (physical units) into simple, documented impact indicators.

All indicators are computed on the 1 deg model grid from DAILY MEAN fields. They are screening proxies for the
dashboard, NOT official warnings (IMD issues those). Rules:

1. Heat stress (land cells in India). Anomaly = daily-mean t2m minus the training-years climatology for that 5-day
   period. Level 1 "elevated": anomaly >= 3 K. Level 2 "high": anomaly >= 5 K. Level 3 "extreme": anomaly >= 5 K AND
   daily-mean t2m >= 35 C. NOT an IMD heatwave warning (IMD uses station maximum temperatures).
2. Heavy rain / flood (India land cells), IMD 24-h categories applied to the cell's daily total: moderate 15.6-64.4,
   heavy 64.5-115.5,
   very heavy 115.6-204.4, extremely heavy >= 204.5 mm/day. Plus the largest 3-day running total and the area where
   the 3-day total reaches 150 mm or more (flood-prone accumulation). 1 deg averages understate local extremes, and
   the current model rarely forecasts > 50 mm/day in a 1 deg cell, so the heavy+ categories are usually empty.
3. Crop-water stress (only when the forecast covers June-September). Cropland proxy = India land cells (land-sea
   mask >= 0.5). Deficit = 1 - forecast rain total / climatological total over the horizon; a cell is "stressed"
   when the deficit is >= 50% and the climatological total is at least 10 mm.
4. Solar proxy: a "good solar day" cell has rain < 1 mm/day and tcwv < 40 kg/m2 (clear, dry air). Share of India land.
5. Wind-power proxy: mean of (10 m wind speed)^3 over India land and over sea (proportional to available power;
   10 m winds understate hub-height winds).
"""
from __future__ import annotations
from functools import lru_cache
from pathlib import Path

import numpy as np

from gateway import geo

HERE = Path(__file__).resolve().parent
IMD = [("moderate", 15.6, 64.5), ("heavy", 64.5, 115.6), ("very_heavy", 115.6, 204.5), ("extremely_heavy", 204.5, float("inf"))]
HEAT_LEVELS = [(1, "elevated", 3.0), (2, "high", 5.0)]
EXTREME_T = 308.15
FLOOD_3DAY_MM = 150.0
NOTE_HEAT = "Heat-stress index from daily-mean temperature vs climatology. Not an IMD heatwave warning."


@lru_cache(maxsize=1)
def clim():
    z = np.load(HERE / "static" / "clim_pentad.npz"); return z["clim"]          # [73, 2(t2m,tp), 32, 36]


def clim_for(doys):
    idx = [min((int(d) - 1) // 5, 72) for d in doys]
    c = clim()[idx]; return c[:, 0], c[:, 1]                                     # t2m [S,32,36], tp [S,32,36]


@lru_cache(maxsize=1)
def masks():
    india = geo.regions()["india_frac"] >= 0.5
    land = geo.grid()["lsm"] >= 0.5
    return india & land, ~land


def _area(mask):
    return round(float((geo.cell_area_km2() * mask).sum()) / 1e3, 1)              # thousand km2


def indicators(R: np.ndarray, doys, months) -> dict:
    t2m, tp, u, v, tcwv = R[:, 0], R[:, 1], R[:, 2], R[:, 3], R[:, 5]
    S = R.shape[0]; ct, cp = clim_for(doys[:S]); il, sea = masks(); w = il.astype("f4")
    anom = t2m - ct
    lvl = np.zeros_like(anom, np.int8)
    for k, _, thr in HEAT_LEVELS:
        lvl[anom >= thr] = k
    lvl[(anom >= 5.0) & (t2m >= EXTREME_T)] = 3; lvl[:, ~il] = 0
    heat = {"note": NOTE_HEAT,
            "per_day": [{"day": d + 1, "max_anomaly_K": round(float(anom[d][il].max()), 2),
                         "area_elevated_kkm2": _area(lvl[d] >= 1), "area_high_kkm2": _area(lvl[d] >= 2),
                         "area_extreme_kkm2": _area(lvl[d] >= 3)} for d in range(S)],
            "top_states": geo.top_states(anom.mean(0), w, key="mean_anomaly_K")}
    heat["peak_area_elevated_kkm2"] = max(x["area_elevated_kkm2"] for x in heat["per_day"])
    tot3 = np.stack([tp[max(0, d - 2):d + 1].sum(0) for d in range(S)])
    rain = {"categories": "IMD 24-h: moderate 15.6-64.4, heavy 64.5-115.5, very heavy 115.6-204.4, extremely heavy >= 204.5 mm/day",
            "per_day": [dict({"day": d + 1, "max_mm": round(float(tp[d][il].max()), 1),
                              "max_3day_total_mm": round(float(tot3[d][il].max()), 1),
                              "area_3day_ge150_kkm2": _area(il & (tot3[d] >= FLOOD_3DAY_MM))},
                             **{f"area_{n}_kkm2": _area(il & (tp[d] >= lo) & (tp[d] < hi)) for n, lo, hi in IMD})
                        for d in range(S)],
            "top_states": geo.top_states(tp.sum(0), w, key="total_mm")}
    rain["peak_area_heavy_or_worse_kkm2"] = max(_area(il & (tp[d] >= 64.5)) for d in range(S))
    if any(m in (6, 7, 8, 9) for m in months):
        fc, cl = tp.sum(0), cp.sum(0)
        deficit = np.where(cl > 0, 1 - fc / np.maximum(cl, 1e-6), 0.0)
        stressed = il & (deficit >= 0.5) & (cl >= 10.0)
        crop = {"active": True, "rule": "deficit >= 50% vs climatology over the horizon, India land as cropland proxy",
                "cropland_stressed_pct": round(100 * float(stressed.sum()) / max(int(il.sum()), 1), 1),
                "mean_deficit_pct": round(100 * float(deficit[il].mean()), 1),
                "area_stressed_kkm2": _area(stressed), "top_states": geo.top_states(100 * deficit, w, key="deficit_pct")}
    else:
        crop = {"active": False, "reason": "crop-water stress is evaluated only for June-September forecasts"}
    good = (tp < 1.0) & (tcwv < 40.0)
    solar = {"rule": "good solar day: rain < 1 mm/day and tcwv < 40 kg/m2",
             "per_day_good_pct": [round(100 * float(good[d][il].mean()), 1) for d in range(S)]}
    solar["mean_good_pct"] = round(float(np.mean(solar["per_day_good_pct"])), 1)
    sp3 = np.hypot(u, v) ** 3
    wind = {"rule": "mean (10 m wind speed)^3, proportional to available wind power",
            "per_day_land_index": [round(float(sp3[d][il].mean()), 1) for d in range(S)],
            "per_day_sea_index": [round(float(sp3[d][sea].mean()), 1) for d in range(S)]}
    wind["mean_land_index"] = round(float(np.mean(wind["per_day_land_index"])), 1)
    wind["mean_sea_index"] = round(float(np.mean(wind["per_day_sea_index"])), 1)
    return {"heat_stress": heat, "heavy_rain": rain, "crop_water": crop, "solar": solar, "wind": wind}


def diff(a, b):
    """Branch minus Prime for every matching number; non-numeric fields are kept from the branch."""
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: diff(a[k], b[k]) for k in b if k in a and k != "top_states"}
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [diff(x, y) for x, y in zip(a, b)]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return round(b - a, 3)
    return b


def impacts(prime: np.ndarray, branch: np.ndarray, doys, months) -> dict:
    p, b = indicators(prime, doys, months), indicators(branch, doys, months)
    return {"prime": p, "branch": b, "difference": diff(p, b)}
