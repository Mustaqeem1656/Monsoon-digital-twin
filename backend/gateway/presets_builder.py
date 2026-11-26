"""Builds the gateway's data-derived files at startup from the organisers' archive (nothing weather-derived is committed).

Reads data/india_climate_train.nc and writes, into the git-ignored cache/gateway/ folder:
  <id>.npz             init [3,6,32,36] + truth [10,6,32,36] for each preset (physical units)
  presets_index.json   per preset: date labels, doy, doy_sincos, forecast months and doys
  clim_pentad.npz      73 five-day climatology means of t2m and tp, TRAINING years only (impact module)
Preset windows use the local grader's selection rules on the validation years (best year per event) plus a "quiet"
window. Rebuilt automatically when a file is missing or the archive is newer than the cache.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "india_climate_train.nc"
CACHE = ROOT / "cache" / "gateway"
META = Path(__file__).resolve().parent / "presets" / "presets.json"     # committed: names/descriptions only
MISSING = (f"Gateway needs the organisers' training archive at {DATA}.\n"
           "Download india_climate_train.nc (and stats.json) from the Round-1 kit and put them in the data/ folder, "
           "then start the gateway again. The file is never committed to the repo.")


def ids():
    return [p["id"] for p in json.loads(META.read_text())]


def up_to_date() -> bool:
    need = [CACHE / f"{i}.npz" for i in ids()] + [CACHE / "presets_index.json", CACHE / "clim_pentad.npz", CACHE / "clim_extra.npz",
                                                  CACHE / "events.npz", CACHE / "events.json"]
    if not all(p.exists() for p in need):
        return False
    return not DATA.exists() or min(p.stat().st_mtime for p in need) >= DATA.stat().st_mtime


def build(force: bool = False) -> Path:
    if not force and up_to_date():
        return CACHE
    if not DATA.exists():
        raise FileNotFoundError(MISSING)
    sys.path.insert(0, str(ROOT))
    from backend.eval.baselines import load_data, train_climatology, VAL_YEARS
    from backend.eval.local_grader import pick_windows
    data, dates, static = load_data()
    best = {}
    for label, t, sc in pick_windows(0, with_scores=True):
        ev = label.split(":")[0].replace("_", "-")
        if ev not in best or sc > best[ev][1]:
            best[ev] = (t, sc)
    sd = data.std(axis=(0, 2, 3))[None, :, None, None]                 # quiet: least day-to-day change over 10 days
    ok = [t for t in range(2, len(dates) - 10) if dates[t - 2].year in VAL_YEARS and dates[t + 10].year in VAL_YEARS]
    tend = np.array([(np.abs(np.diff(data[t:t + 11], axis=0)) / sd).mean() for t in ok])
    best["quiet"] = (ok[int(np.argmin(tend))], float(tend.min()))
    CACHE.mkdir(parents=True, exist_ok=True); index = {}
    for pid in ids():
        t = best[pid][0]
        np.savez_compressed(CACHE / f"{pid}.npz", init=data[t - 2:t + 1].astype("f4"), truth=data[t + 1:t + 11].astype("f4"))
        doy = dates[t].timetuple().tm_yday; ang = 2 * np.pi * doy / 365.0
        index[pid] = {"last_input_day": str(dates[t]), "first_forecast_day": str(dates[t + 1]), "doy": doy,
                      "doy_sincos": [float(np.sin(ang)), float(np.cos(ang))],
                      "forecast_months": sorted({dates[t + k].month for k in range(1, 11)}),
                      "forecast_doys": [dates[t + k].timetuple().tm_yday for k in range(1, 11)]}
    (CACHE / "presets_index.json").write_text(json.dumps(index, indent=1))
    clim = train_climatology()
    pent = np.stack([clim[5 * p:5 * p + 5, [0, 1]].mean(0) for p in range(73)]).astype("f4")
    np.savez_compressed(CACHE / "clim_pentad.npz", clim=pent, channels=np.array(["t2m", "tp"]))
    # normals for "vs normal for this date": clear-dry-day share and wind power, per pentad, training years only
    tr = np.array([d.year not in VAL_YEARS for d in dates]); pid_ = np.array([min((d.timetuple().tm_yday - 1) // 5, 72) for d in dates])
    good = ((data[:, 1] < 1.0) & (data[:, 5] < 40.0)).astype("f4"); p3 = (np.hypot(data[:, 2], data[:, 3]) ** 3).astype("f4")
    np.savez_compressed(CACHE / "clim_extra.npz", good=np.stack([good[tr & (pid_ == k)].mean(0) for k in range(73)]),
                        speed3=np.stack([p3[tr & (pid_ == k)].mean(0) for k in range(73)]))
    # weather-event templates (anomaly vs the training-years day-of-year climatology), from the same windows
    from monsoon_r1 import stats as KS
    from backend.gateway import events, geo
    india_land = (geo.regions()["india_frac"] >= 0.5) & (static[0] > 0.5)
    ev_best = {k.replace("-", "_"): v for k, v in best.items()}
    events.build_templates(data, dates, static, lambda d: KS.clim_for(clim, d), ev_best, india_land)
    return CACHE


if __name__ == "__main__":
    try:
        build(force="--force" in sys.argv); print(f"gateway cache ready in {CACHE}")
    except FileNotFoundError as e:
        sys.exit(str(e))
