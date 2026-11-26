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

from backend.gateway import geo

HERE = Path(__file__).resolve().parent
IMD = [("moderate", 15.6, 64.5), ("heavy", 64.5, 115.6), ("very_heavy", 115.6, 204.5), ("extremely_heavy", 204.5, float("inf"))]
HEAT_LEVELS = [(1, "elevated", 3.0), (2, "high", 5.0)]
EXTREME_T = 308.15
FLOOD_3DAY_MM = 150.0
NOTE_HEAT = "Heat-stress index from daily-mean temperature vs climatology. Not an IMD heatwave warning."


@lru_cache(maxsize=1)
def clim():
    from backend.gateway.presets_builder import CACHE
    z = np.load(CACHE / "clim_pentad.npz"); return z["clim"]          # [73, 2(t2m,tp), 32, 36]


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


# =================================================================================================================
# KPI tiles for the Impact dashboard (one tile per impact; documented thresholds)
# =================================================================================================================
"""Tile rules. Every tile has a daily series (day 0 = last real input day, days 1..S = forecast), a headline value,
a level (Low / Moderate / High / Severe), the top affected Indian states and hotspot cells. All on India land cells.

flood   daily = largest daily rain in any India land cell (mm/day).  value = peak over the forecast days.
        level = IMD 24-h category of that value: Low < 15.6, Moderate 15.6-64.4, High (heavy) 64.5-115.5,
        Severe (very heavy or worse) >= 115.6. Also reported: largest three-day running total (mm).
        River cascade / snowmelt routing is NOT built, so those are not reported.
heat    daily = largest daily-mean t2m anomaly vs the training-years pentad climatology (K).  value = peak.
        level: Low < 3 K, Moderate 3-5 K, High >= 5 K, Severe >= 5 K in a cell whose daily-mean t2m >= 35 C.
crop    (June-September only) daily = cropland rain deficit so far (%) = 100 * (1 - forecast total / clim total),
        India land as cropland proxy.  value = share of cropland (%) whose deficit over the horizon is >= 50 % (and clim
        total >= 10 mm).  level: Low < 10 %, Moderate 10-25 %, High 25-50 %, Severe >= 50 %.
solar   daily = share of India land (%) with a "good solar day" (rain < 1 mm/day and tcwv < 40 kg/m2).
        value = mean over the forecast; normal = the same share in the training years for the same 5-day periods.
        level = solar LOSS vs normal (value - normal, percentage points): Low > -5, Moderate -5 to -15,
        High -15 to -30, Severe < -30.
wind    daily = India-land mean wind power density at 10 m, 0.5 * 1.225 kg/m3 * speed^3 (W/m2).  value = mean.
        Also: % of normal (training-years mean for the same 5-day periods).
        level = wind-power availability: Low < 12, Moderate 12-37, High 37-92, Severe >= 92 W/m2 (storm-strength).
heat    is shown as degrees C above the normal for the date (an anomaly in K equals one in degrees C).
Change: delta = with-change value minus plain value; |delta| below NO_CHANGE[tile] counts as "no change".
Cause:  mean change of the tile's own channel (heat: t2m, flood/crop: rain, wind: wind speed; solar: whichever of rain
        and tcwv is larger in std units) over the cells where the tile's field changed most (top 10 % of |change| on the
        peak-change day); a second channel is named as "also" when its change is at least half as large in std units.
"""
CH = ["t2m", "tp", "u10", "v10", "msl", "tcwv"]
LEVELS = ["Low", "Moderate", "High", "Severe"]
TILES = {
    "flood": {"name": "Flood risk", "unit": "mm/day", "label": "wettest India cell, daily rain", "thresholds": [15.6, 64.5, 115.6], "higher_is_worse": True,
              "causes": ["tp", "tcwv", "wind"], "layer": "rain"},
    "heat": {"name": "Heat stress", "unit": "°C above normal", "label": "hottest India cell vs normal for the date", "thresholds": [3.0, 5.0], "higher_is_worse": True,
             "causes": ["t2m", "tcwv", "wind"], "layer": "heat"},
    "crop": {"name": "Crop-water stress", "unit": "%", "label": "cropland with under half its normal rain", "thresholds": [10.0, 25.0, 50.0], "higher_is_worse": True,
             "causes": ["tp", "tcwv"], "layer": "rain"},
    "solar": {"name": "Solar", "unit": "%", "label": "clear, dry share of India land vs normal", "thresholds": [-5.0, -15.0, -30.0], "higher_is_worse": False,
              "causes": ["tp", "tcwv"], "layer": "clouds"},
    "wind": {"name": "Wind power", "unit": "W/m²", "label": "India-land mean power density at 10 m", "thresholds": [12.0, 37.0, 92.0], "higher_is_worse": True,
             "causes": ["wind", "msl"], "layer": "wind"},
}
NO_CHANGE = {"flood": 0.5, "heat": 0.1, "crop": 0.5, "solar": 0.5, "wind": 0.5}
CAUSE_UNITS = {"t2m": "°C", "tp": "mm/day", "wind": "m/s", "msl": "hPa", "tcwv": "kg/m²"}
CAUSE_NAMES = {"t2m": "temperature", "tp": "rain", "wind": "wind speed", "msl": "sea-level pressure", "tcwv": "moisture"}
CAUSE_STD = {"t2m": 13.4636, "tp": 7.5533, "wind": 2.9, "msl": 6.190198, "tcwv": 20.4944}


def _level(tid: str, value: float, severe_flag: bool = False) -> str:
    t = TILES[tid]; thr = t["thresholds"]
    k = sum(value >= x for x in thr) if t["higher_is_worse"] else sum(value < x for x in thr)
    if tid == "heat":
        k = 3 if (k == 2 and severe_flag) else k
    return LEVELS[k]


RHO_HALF = 0.5 * 1.225


@lru_cache(maxsize=1)
def clim_extra():
    from backend.gateway.presets_builder import CACHE
    z = np.load(CACHE / "clim_extra.npz"); return z["good"], z["speed3"]          # [73,32,36] each


def normals(doys) -> dict:
    """Training-years normal over the forecast days: clear-dry share (%) and power density (W/m2), India land."""
    il, _ = masks(); g, s3 = clim_extra(); idx = [min((int(d) - 1) // 5, 72) for d in doys]
    return {"solar": 100 * float(g[idx][:, il].mean()), "wind": RHO_HALF * float(s3[idx][:, il].mean())}


def _cause_fields(X: np.ndarray) -> dict:
    """X [6,32,36] -> the fields a cause can name (wind as speed, msl in hPa)."""
    return {"t2m": X[0], "tp": X[1], "wind": np.hypot(X[2], X[3]), "msl": X[4] / 100.0, "tcwv": X[5]}


def _fields(X: np.ndarray, doys, start_doy: int, start: np.ndarray, months) -> dict:
    """X = states [S+1,6,32,36] (index 0 = start). Returns per-tile daily cell field [S+1,32,36] and daily series."""
    il, _ = masks(); S = X.shape[0] - 1
    ct, cp = clim_for([start_doy] + list(doys[:S]))
    t2m, tp = X[:, 0], X[:, 1]
    anom = np.where(il, t2m - ct, -np.inf)
    sev = (anom >= 5.0) & (t2m >= EXTREME_T)
    good = ((tp < 1.0) & (X[:, 5] < 40.0)).astype("f4")
    sp3 = RHO_HALF * np.hypot(X[:, 2], X[:, 3]) ** 3
    cf, cc = np.cumsum(tp[1:], 0), np.cumsum(cp[1:], 0)
    deficit = np.concatenate([np.zeros((1,) + tp.shape[1:], "f4"), 100 * (1 - cf / np.maximum(cc, 1e-6))])
    crop_on = any(m in (6, 7, 8, 9) for m in months)
    out = {
        "flood": {"cell": np.where(il, tp, 0.0), "series": [float(tp[d][il].max()) for d in range(S + 1)]},
        "heat": {"cell": np.where(il, t2m - ct, 0.0), "series": [float(anom[d][il].max()) for d in range(S + 1)],
                 "severe": bool(sev[1:][:, il].any())},
        "solar": {"cell": good * 100, "series": [100 * float(good[d][il].mean()) for d in range(S + 1)]},
        "wind": {"cell": sp3, "series": [float(sp3[d][il].mean()) for d in range(S + 1)]},
        "_tot3": max(float(tp[max(1, d - 2):d + 1].sum(0)[il].max()) for d in range(1, S + 1)),
    }
    if crop_on:
        stressed = il & (deficit[-1] >= 50.0) & (cc[-1] >= 10.0)
        out["crop"] = {"cell": np.where(il, deficit, 0.0), "series": [float(deficit[d][il].mean()) for d in range(S + 1)],
                       "value": 100 * float(stressed.sum()) / max(int(il.sum()), 1)}
    return out


def _value(tid: str, f: dict) -> float:
    s = f[tid]["series"][1:]
    return {"flood": max(s), "heat": max(s), "solar": float(np.mean(s)), "wind": float(np.mean(s))}.get(tid, f[tid].get("value"))


def _hotspots(field: np.ndarray, n: int = 3):
    il, _ = masks(); a = np.where(il, field, -np.inf); idx = np.argsort(a.ravel())[::-1][:n]
    return [{"lat": float(geo.LAT[k // geo.NLON]), "lon": float(geo.LON[k % geo.NLON]), "value": round(float(a.ravel()[k]), 1)}
            for k in idx if np.isfinite(a.ravel()[k])]


def _highlight(field: np.ndarray, frac: float = 0.1):
    """Cells to highlight: India land cells in the top `frac` of |field| (and > 0). Returns [[lat, lon], ...]."""
    il, _ = masks(); a = np.where(il, np.abs(field), 0.0)
    if a.max() <= 0: return []
    thr = max(np.quantile(a[il], 1 - frac), 1e-6)
    ii, jj = np.nonzero(a >= thr)
    return [[float(geo.LAT[i]), float(geo.LON[j])] for i, j in zip(ii, jj)]


def _level_of(tid, v, f, nrm):
    """Solar is judged against its normal (percentage points); every other tile on its own value."""
    return _level(tid, v - nrm["solar"] if tid == "solar" else v, f[tid].get("severe", False))


def scalar_tiles(X: np.ndarray, doys, start_doy, months) -> dict:
    """Cheap per-member summary: {tile: (value, level)} for the ensemble."""
    f = _fields(X, doys, start_doy, X[0], months); nrm = normals(doys[:X.shape[0] - 1]); out = {}
    for tid in TILES:
        if tid not in f: continue
        v = _value(tid, f); out[tid] = (v, _level_of(tid, v, f, nrm))
    return out


def tiles(p_start, b_start, prime, branch, doys, start_doy: int, months) -> list[dict]:
    """p_start / b_start [6,32,36] = start state without / with the change; prime / branch [S,6,32,36]."""
    XP, XB = np.concatenate([p_start[None], prime]), np.concatenate([b_start[None], branch])
    fp, fb = _fields(XP, doys, start_doy, p_start, months), _fields(XB, doys, start_doy, b_start, months)
    il, _ = masks(); w = il.astype("f4"); S = prime.shape[0]; out = []; nrm = normals(doys[:S])
    for tid, t in TILES.items():
        base = {"id": tid, "name": t["name"], "unit": t["unit"], "layer": t["layer"], "thresholds": t["thresholds"],
                "higher_is_worse": t["higher_is_worse"], "levels": LEVELS, "label": t["label"],
                "no_change_margin": NO_CHANGE[tid]}
        if tid not in fp:
            out.append({**base, "active": False, "reason": "crop-water stress is evaluated only for June-September forecasts"}); continue
        vp, vb = round(_value(tid, fp), 1), round(_value(tid, fb), 1)
        sp, sb = [round(x, 1) for x in fp[tid]["series"]], [round(x, 1) for x in fb[tid]["series"]]
        dseries = [round(b - a, 1) for a, b in zip(sp, sb)]
        delta = round(vb - vp, 1)
        dcell = fb[tid]["cell"] - fp[tid]["cell"]
        changed = bool(np.abs(dcell[1:][:, il]).max() > 1e-6) if S else False
        direction = "none" if abs(delta) < NO_CHANGE[tid] else ("up" if delta > 0 else "down")
        if changed:
            dd = int(np.argmax(np.abs(np.asarray(dseries[1:])))) + 1 if any(dseries[1:]) else                  int(np.argmax(np.abs(dcell[1:][:, il]).max(-1))) + 1
            field_days = dcell[1:].mean(0)
            states = geo.top_states(field_days, w, n=3, key="value")
            hot = _hotspots(np.abs(dcell[dd]))
            hl = _highlight(dcell[dd])
            a = np.where(il, np.abs(dcell[dd]), 0.0)
            sel = il & (a >= max(np.quantile(a[il], 0.9), 1e-6))
            cp, cb = _cause_fields(XP[dd]), _cause_fields(XB[dd])
            sc = {c: float((cb[c] - cp[c])[sel].mean()) if sel.any() else 0.0 for c in t["causes"]}
            z = {k: abs(sc[k]) / CAUSE_STD[k] for k in sc}
            c = max(t["causes"][:2], key=z.get) if tid == "solar" else t["causes"][0]
            oth = [k for k in t["causes"] if k != c]; o = max(oth, key=z.get) if oth else None
            mk = lambda k: {"channel": k, "name": CAUSE_NAMES[k], "mean_change": round(sc[k], 1), "unit": CAUSE_UNITS[k]}
            cause = {**mk(c), "day": dd, "also": mk(o) if o and z[o] >= 0.5 * z[c] and round(sc[o], 1) != 0 else None}
        else:
            ser = np.asarray(sp[1:]); dd = int(np.argmax(ser) if t["higher_is_worse"] else np.argmin(ser)) + 1
            states = geo.top_states(fp[tid]["cell"][1:].mean(0), w, n=3, key="value")
            hot = _hotspots(fp[tid]["cell"][dd] if t["higher_is_worse"] else -fp[tid]["cell"][dd])
            if not t["higher_is_worse"]: hot = [{**h, "value": round(-h["value"], 1)} for h in hot]
            hl = _highlight(fp[tid]["cell"][dd] if t["higher_is_worse"] else 100 - fp[tid]["cell"][dd]); cause = None
        tile = {**base, "active": True,
                "prime": {"value": vp, "level": _level_of(tid, vp, fp, nrm), "series": sp},
                "branch": {"value": vb, "level": _level_of(tid, vb, fb, nrm), "series": sb},
                "delta": delta, "delta_series": dseries, "direction": direction, "changed": changed, "day": dd,
                "top_states": [{"state": x["state"], "value": round(x["value"], 1)} for x in states],
                "hotspots": hot, "highlight": hl, "cause": cause}
        if tid in nrm:
            nv = round(nrm[tid], 1); tile["normal"] = nv
            for k, v in (("prime", vp), ("branch", vb)):
                tile[k]["vs_normal"] = round(v - nv, 1)
                if tid == "wind": tile[k]["pct_of_normal"] = round(100 * v / max(nv, 1e-6))
        if tid == "heat":
            tile["severe_t2m_C"] = round(EXTREME_T - 273.15, 1)
        if tid == "flood":
            tile["extra"] = {"max_3day_total_mm": {"prime": round(fp["_tot3"], 1), "branch": round(fb["_tot3"], 1)}}
        out.append(tile)
    return out
