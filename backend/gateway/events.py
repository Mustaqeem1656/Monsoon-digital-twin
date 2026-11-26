"""Weather events: real events from the validation years, cut out as relocatable anomaly templates.

Build (at gateway startup, from data/india_climate_train.nc into git-ignored cache/gateway/):
  for each event the validation window is chosen with the local grader's rules (best year), then the PEAK DAY and
  CENTRE are found automatically:
    cyclone             lowest sea-level pressure over the sea south of 22 N
    heatwave            largest 2 m temperature anomaly over Indian land
    heavy_rain          largest 3-day rain total over Indian land
    monsoon_onset       largest moisture + south-west wind anomaly near Kerala (8-14 N, 72-78 E)
    western_disturbance largest rain over the far north (28-38 N, 70-82 E)
  template = anomaly (peak day minus the training-years climatology) for all 6 channels within R cells of the centre,
  tapered smoothly to zero (Hann window).
Use: shift the template to any centre inside the domain (whole cells; zero outside), scale by strength/100 and add it
to the start state's last day; the gateway then runs plain vs with-event through the inference server like a shock.
No dates are written in this file; event dates are data (cache JSON).
"""
from __future__ import annotations
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from backend.gateway import geo, shocks

R = 8                                                     # template radius in cells
CACHE = Path(__file__).resolve().parents[2] / "cache" / "gateway"
FILE_NPZ, FILE_JSON = CACHE / "events.npz", CACHE / "events.json"
EVENTS = {
    "monsoon_onset": ("Monsoon onset", "Moist south-west monsoon winds arrive at the Kerala coast.", "onset"),
    "heavy_rain": ("Heavy rain", "A peak-monsoon spell of very heavy rain over land.", "heavy_rain"),
    "heatwave": ("Heatwave", "A pre-monsoon heatwave over north and central India.", "heatwave"),
    "cyclone": ("Cyclone", "A tropical cyclone over the Bay of Bengal: deep low, spinning winds, torrential rain.", "cyclone"),
    "western_disturbance": ("Western disturbance", "A winter storm from the west bringing rain and snow to the far north.", "western_disturbance"),
}
WD_STATES = ["Jammu & Kashmir", "Himachal Pradesh", "Uttarakhand", "Punjab"]   # DataMeet's J&K includes Ladakh


def _hann(rr):
    return np.where(rr <= R, 0.5 * (1 + np.cos(np.pi * np.minimum(rr / R, 1.0))), 0.0)


def build_templates(data, dates, static, clim_for, best, india_land):
    """data [N,6,32,36]; clim_for(date) -> [6,32,36]; best {grader event name: (t, score)}; india_land [32,36] bool."""
    lsm = static[0] > 0.5; sea = ~lsm
    LAT, LON = geo.LAT, geo.LON
    std = data.std(axis=(0, 2, 3))
    templates, meta = {}, []
    for eid, (name, desc, gname) in EVENTS.items():
        t = best[gname][0]; days = list(range(t - 2, t + 11))
        anom = {k: data[k] - clim_for(dates[k]) for k in days}
        if eid == "cyclone":
            m = sea & (LAT[:, None] <= 22) * np.ones((1, len(LON)), bool)
            k = min(days, key=lambda d: data[d, 4][m].min()); f = np.where(m, data[k, 4], np.inf); i, j = np.unravel_index(np.argmin(f), f.shape)
        elif eid == "heatwave":
            k = max(days, key=lambda d: anom[d][0][india_land].max()); f = np.where(india_land, anom[k][0], -np.inf); i, j = np.unravel_index(np.argmax(f), f.shape)
        elif eid == "heavy_rain":
            tot = {d: data[d - 2:d + 1, 1].sum(0) for d in days}
            k = max(days, key=lambda d: tot[d][india_land].max()); f = np.where(india_land, tot[k], -np.inf); i, j = np.unravel_index(np.argmax(f), f.shape)
        elif eid == "monsoon_onset":
            box = ((LAT >= 8) & (LAT <= 14))[:, None] & ((LON >= 72) & (LON <= 78))[None, :]
            sc = {d: anom[d][5] / std[5] + (anom[d][2] + anom[d][3]) / np.sqrt(2) / std[2] for d in days}
            k = max(days, key=lambda d: sc[d][box].mean()); f = np.where(box, sc[k], -np.inf); i, j = np.unravel_index(np.argmax(f), f.shape)
        else:
            box = (LAT >= 28)[:, None] & ((LON >= 70) & (LON <= 82))[None, :]
            k = max(days, key=lambda d: (data[d, 1] - anom[d][4] / 100.0)[box].mean()); f = np.where(box, data[k, 1], -np.inf); i, j = np.unravel_index(np.argmax(f), f.shape)
        a = anom[k]; patch = np.zeros((6, 2 * R + 1, 2 * R + 1), "f4")
        di, dj = np.mgrid[-R:R + 1, -R:R + 1]; w = _hann(np.hypot(di, dj))
        for a_, b_ in zip(di.ravel(), dj.ravel()):
            ii, jj = i + a_, j + b_
            if 0 <= ii < geo.NLAT and 0 <= jj < geo.NLON:
                patch[:, a_ + R, b_ + R] = a[:, ii, jj] * w[a_ + R, b_ + R]
        templates[eid] = patch
        c = patch[:, R, R]
        meta.append({"id": eid, "name": name, "description": desc, "source_date": str(dates[k]),
                     "centre": {"lat": float(LAT[i]), "lon": float(LON[j]), "region": geo.region_at(float(LAT[i]), float(LON[j]))},
                     "radius_cells": R, "signature": {
                         "t2m_anomaly_K": round(float(c[0]), 2), "rain_anomaly_mm_day": round(float(c[1]), 1),
                         "msl_anomaly_hPa": round(float(patch[4].min()) / 100, 1),
                         "max_wind_anomaly_m_s": round(float(np.hypot(patch[2], patch[3]).max()), 1),
                         "tcwv_anomaly_kg_m2": round(float(c[5]), 1), "max_rain_anomaly_mm_day": round(float(patch[1].max()), 1)}})
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(FILE_NPZ, **templates); FILE_JSON.write_text(json.dumps(meta, indent=1))
    return meta


@lru_cache(maxsize=1)
def catalogue():
    meta = json.loads(FILE_JSON.read_text()); z = np.load(FILE_NPZ)
    return {m["id"]: m for m in meta}, {k: z[k].astype("f4") for k in z.files}


def warnings_for(eid: str, lat: float, lon: float, strength: float) -> list[str]:
    lsm = geo.grid()["lsm"]; i = int(np.clip(round(lat - 6.5), 0, geo.NLAT - 1)); j = int(np.clip(round(lon - 65.5), 0, geo.NLON - 1))
    land = lsm[i, j] >= 0.5; out = []
    if eid == "cyclone" and land:
        out.append("A cyclone centred over land is unrealistic: cyclones form and keep their strength over warm sea.")
    if eid == "monsoon_onset" and not (8 <= lat <= 20 and lon <= 77.5):
        out.append("The monsoon arrives on the south-west coast (Kerala to Konkan); onset elsewhere is not physical.")
    if eid == "western_disturbance" and lat < 25:
        out.append("Western disturbances affect the far north; south of about 25°N this pattern is unrealistic.")
    if eid == "heatwave" and not land:
        out.append("Heatwaves happen over land; over the sea this pattern is unrealistic.")
    if strength > 120:
        out.append("Stronger than anything in the training data — results less reliable.")
    return out


def build(spec: dict, last: np.ndarray):
    """spec {event_id, lat, lon (default real centre), strength % (default 100, 0..150)} -> (perturbation, info)."""
    meta, tmpl = catalogue(); eid = spec.get("event_id")
    if eid not in meta:
        raise ValueError(f"unknown event {eid!r}; choose one of {', '.join(meta)}")
    m = meta[eid]
    lat = float(spec.get("lat", m["centre"]["lat"])); lon = float(spec.get("lon", m["centre"]["lon"]))
    geo.check_point(lat, lon)
    strength = float(spec.get("strength", 100))
    if not (0 <= strength <= 150):
        raise ValueError("strength must be between 0 and 150 %")
    i = int(np.clip(round(lat - 6.5), 0, geo.NLAT - 1)); j = int(np.clip(round(lon - 65.5), 0, geo.NLON - 1))
    d = np.zeros_like(last, dtype="f4"); P = tmpl[eid] * (strength / 100.0)
    for a in range(-R, R + 1):
        for b in range(-R, R + 1):
            ii, jj = i + a, j + b
            if 0 <= ii < geo.NLAT and 0 <= jj < geo.NLON:
                d[:, ii, jj] = P[:, a + R, b + R]
    d = shocks.finalize(d, last)
    size = np.abs(d).reshape(6, -1).max(1) / geo.STD
    info = {"kind": "event", "type": eid, "name": m["name"], "description": m["description"], "source_date": m["source_date"],
            "real_centre": m["centre"], "centre": {"lat": lat, "lon": lon, "region": geo.region_at(lat, lon)},
            "strength_pct": strength, "radius_cells": R, "size_std": {geo.CHANNELS[c]: round(float(size[c]), 3) for c in range(6)},
            "warnings": warnings_for(eid, lat, lon, strength)}
    return d, info


# ---- event-specific outcomes ------------------------------------------------------------------------------
def _states_mean(field, w, n=5, key="value"):
    return geo.top_states(field, w, n=n, key=key)


def cyclone_metrics(start_b, branch, start_p, prime, lat0, lon0):
    """Track = position of the branch's msl minimum, searched within 4 cells of the previous position each day."""
    seq_b = np.concatenate([start_b[None], branch]); seq_p = np.concatenate([start_p[None], prime])
    i = int(np.clip(round(lat0 - 6.5), 0, 31)); j = int(np.clip(round(lon0 - 65.5), 0, 35)); track = []; depth0 = None
    for d in range(seq_b.shape[0]):
        dm = seq_b[d, 4] - seq_p[d, 4]
        i0, i1, j0, j1 = max(0, i - 4), min(32, i + 5), max(0, j - 4), min(36, j + 5)
        sub = dm[i0:i1, j0:j1]; a, b = np.unravel_index(np.argmin(sub), sub.shape); i, j = i0 + a, j0 + b
        depth = float(-dm[i, j]) / 100                       # hPa below the plain forecast at the centre
        ws = np.hypot(seq_b[d, 2], seq_b[d, 3])[max(0, i - 3):i + 4, max(0, j - 3):j + 4]
        ring = [dm[ii, jj] for ii in range(i - 3, i + 4) for jj in range(j - 3, j + 4)
                if 0 <= ii < 32 and 0 <= jj < 36 and 2.5 <= np.hypot(ii - i, jj - j) <= 3.5]
        asym = float(np.std(ring) / max(abs(np.mean(ring)), 1e-6)) if ring else 0.0
        if depth0 is None: depth0 = depth
        track.append({"day": d, "lat": float(geo.LAT[i]), "lon": float(geo.LON[j]), "lowest_pressure_hPa": round(float(seq_b[d, 4, i, j]) / 100, 1),
                      "depth_hPa": round(depth, 1), "strongest_wind_m_s": round(float(ws.max()), 1), "asymmetry": round(asym, 2),
                      "region": geo.region_at(float(geo.LAT[i]), float(geo.LON[j]))})
    notes = []
    weak = next((t["day"] for t in track if depth0 > 0 and t["depth_hPa"] < 0.5 * depth0), None)
    if weak is not None:
        notes.append(f"The vortex weakens: by day +{weak} the low is less than half as deep as at the start ({track[weak]['depth_hPa']} vs {track[0]['depth_hPa']} hPa).")
    lop = next((t["day"] for t in track if t["day"] > 0 and t["asymmetry"] > 0.6), None)
    if lop is not None:
        notes.append(f"The vortex loses its round shape by day +{lop} (pressure around the centre is no longer even).")
    if not notes:
        notes.append("The vortex keeps its depth and round shape over the 10 days.")
    notes.append("Note: a 1° grid cannot hold a tight cyclone core, so peak winds and the lowest pressure are smoothed.")
    w = (geo.grid()["lsm"] >= 0.5).astype("f4")
    return {"track": track, "notes": notes, "rain_by_state_total_mm": _states_mean(branch[:, 1].sum(0), w, key="total_mm"),
            "rain_change_by_state_mm": _states_mean(branch[:, 1].sum(0) - prime[:, 1].sum(0), w, key="change_mm")}


def heavy_rain_metrics(branch, prime):
    from backend.gateway import impact
    il, _ = impact.masks(); w = il.astype("f4"); out = []
    tot3 = lambda R_, d: R_[max(0, d - 2):d + 1, 1].sum(0)
    for d in range(branch.shape[0]):
        b3, p3 = tot3(branch, d), tot3(prime, d); tp = branch[d, 1]
        cats = {n: impact._area(il & (tp >= lo) & (tp < hi)) for n, lo, hi in impact.IMD}
        out.append({"day": d + 1, "max_3day_total_mm": round(float(b3[il].max()), 1), "max_3day_change_mm": round(float((b3 - p3)[il].max()), 1),
                    "area_kkm2_by_category": cats})
    S = branch.shape[0]
    return {"per_day": out, "states_by_max_3day_total_mm": _states_mean(np.max([tot3(branch, d) for d in range(S)], 0), w, key="max_3day_total_mm"),
            "categories": "IMD: moderate 15.6-64.4, heavy 64.5-115.5, very heavy 115.6-204.4, extremely heavy >= 204.5 mm/day"}


def heatwave_metrics(branch, prime, doys, thr_t2m):
    from backend.gateway import impact
    il, _ = impact.masks(); w = il.astype("f4"); ct, _ = impact.clim_for(doys[:branch.shape[0]])
    anom = branch[:, 0] - ct
    area = [impact._area(il & (anom[d] >= 3.0)) for d in range(branch.shape[0])]
    persist = sum(1 for d in range(branch.shape[0]) if ((branch[d, 0] - prime[d, 0])[il] >= thr_t2m).any())
    return {"heat_stress_area_kkm2_per_day": area, "rule": "India land with daily-mean t2m >= 3 K above climatology",
            "hottest_states_mean_C": [{**s, "mean_C": round(s["mean_C"] - 273.15, 1)} for s in _states_mean(branch[:, 0].mean(0), w, key="mean_C")],
            "days_it_persists": persist}


def onset_metrics(branch, prime):
    from backend.gateway import impact
    il, _ = impact.masks()
    def north(R_, d):
        rows = [i for i in range(geo.NLAT) if ((R_[d, 1, i] >= 5.0) & il[i]).any()]
        return float(geo.LAT[max(rows)]) if rows else None
    return {"rule": "northernmost latitude of an India land cell with rain >= 5 mm/day",
            "per_day": [{"day": d + 1, "with": north(branch, d), "without": north(prime, d)} for d in range(branch.shape[0])]}


def wd_metrics(branch, prime):
    r = geo.regions(); codes = [c for c in r["state_codes"] if r["names"][c] in WD_STATES]
    out = []
    for c in codes:
        w = r["frac"][..., c]; s = float(w.sum())
        if s < 0.05: continue
        m = lambda F: float((F * w).sum() / s)
        out.append({"state": r["names"][c], "rain_with_mm_per_day": [round(m(branch[d, 1]), 2) for d in range(branch.shape[0])],
                    "rain_without_mm_per_day": [round(m(prime[d, 1]), 2) for d in range(branch.shape[0])],
                    "temperature_change_K": [round(m(branch[d, 0] - prime[d, 0]), 2) for d in range(branch.shape[0])]})
    return {"states": out, "note": "Jammu & Kashmir includes Ladakh in the DataMeet boundaries used here."}


def metrics(eid, start_b, branch, start_p, prime, lat0, lon0, doys, thr):
    if eid == "cyclone": return cyclone_metrics(start_b, branch, start_p, prime, lat0, lon0)
    if eid == "heavy_rain": return heavy_rain_metrics(branch, prime)
    if eid == "heatwave": return heatwave_metrics(branch, prime, doys, thr["t2m"])
    if eid == "monsoon_onset": return onset_metrics(branch, prime)
    if eid == "western_disturbance": return wd_metrics(branch, prime)
    return {}
