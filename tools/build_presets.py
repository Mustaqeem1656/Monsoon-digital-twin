"""Build the dashboard presets and the small static grids the gateway needs (laptop only, reads data/).
  python tools/build_presets.py

Writes
  gateway/presets/<id>.npz      init [3,6,32,36] + truth [10,6,32,36] (13 days each, physical units)
  gateway/presets/presets.json  id, name, description, date labels, doy_sincos, forecast months
  gateway/static/grid.npz       land-sea mask, orography (fixed geography)
  gateway/static/clim_pentad.npz  73 five-day climatology means of t2m and tp from TRAINING years (impact module)
Windows come from the local grader's selection rules on the validation years (2019-2021), best year per event.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from eval.baselines import load_data, train_climatology, VAL_YEARS  # noqa: E402
from eval.local_grader import pick_windows                          # noqa: E402
from monsoon_r1.contract import doy_sincos                          # noqa: E402

PRE, ST = ROOT / "gateway" / "presets", ROOT / "gateway" / "static"
INFO = {
    "onset": ("Monsoon onset", "Rain surges over Kerala as the southwest monsoon arrives."),
    "heavy_rain": ("Heavy-rain spell", "A peak-monsoon spell with widespread heavy rain over land."),
    "heatwave": ("Pre-monsoon heatwave", "The hottest 10 days over north-central India in May."),
    "cyclone": ("Bay of Bengal low", "The deepest sea-level pressure low over the Bay of Bengal."),
    "western_disturbance": ("Western disturbance", "A winter system bringing rain and snow to the far north."),
    "quiet": ("Quiet weather", "The calmest 10 days: little day-to-day change anywhere."),
}


def main():
    data, dates, static = load_data()
    PRE.mkdir(parents=True, exist_ok=True); ST.mkdir(parents=True, exist_ok=True)
    wins = pick_windows(0, with_scores=True)
    best = {}
    for label, t, sc in wins:
        ev = label.split(":")[0]
        if ev not in best or sc > best[ev][1]:
            best[ev] = (t, sc)
    # quiet: smallest mean day-to-day change (in std units) over the 10 forecast days, any validation day
    sd = data.std(axis=(0, 2, 3))[None, :, None, None]
    ok = [t for t in range(2, len(dates) - 10) if dates[t - 2].year in VAL_YEARS and dates[t + 10].year in VAL_YEARS]
    tend = np.array([(np.abs(np.diff(data[t:t + 11], axis=0)) / sd).mean() for t in ok])
    best["quiet"] = (ok[int(np.argmin(tend))], float(tend.min()))

    meta = []
    for ev, (t, _) in best.items():
        name, desc = INFO[ev]; pid = ev.replace("_", "-")
        np.savez_compressed(PRE / f"{pid}.npz", init=data[t - 2:t + 1].astype("f4"), truth=data[t + 1:t + 11].astype("f4"))
        doy = dates[t].timetuple().tm_yday
        meta.append({"id": pid, "name": name, "description": desc, "last_input_day": str(dates[t]),
                     "first_forecast_day": str(dates[t + 1]), "doy": doy, "doy_sincos": doy_sincos(doy),
                     "forecast_months": sorted({dates[t + k].month for k in range(1, 11)}),
                     "forecast_doys": [dates[t + k].timetuple().tm_yday for k in range(1, 11)]})
        print(f"  {pid:22s} last input {dates[t]}")
    (PRE / "presets.json").write_text(json.dumps(meta, indent=1))
    np.savez_compressed(ST / "grid.npz", land_sea_mask=static[0], orography_m=static[1])
    clim = train_climatology()                                           # [366,6,32,36], training years only
    pent = np.stack([clim[5 * p:5 * p + 5, [0, 1]].mean(0) for p in range(73)]).astype("f4")   # [73,2,32,36]
    np.savez_compressed(ST / "clim_pentad.npz", clim=pent, channels=np.array(["t2m", "tp"]))
    print(f"wrote {len(meta)} presets, grid.npz, clim_pentad.npz {pent.shape}")


if __name__ == "__main__":
    main()
