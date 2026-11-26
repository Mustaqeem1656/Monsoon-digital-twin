"""Data-accuracy check: proves the gateway and the dashboard show the real dataset values, in the right places.
  python backend/tools/verify_data.py
Needs serve.py (:8000) and the gateway (:8100) running; the dashboard readout part also needs `npm run preview`
(:5173) and node with playwright-core (frontend/). Prints a PASS/FAIL table; exit code 1 if anything fails.

a. For 3 presets, the start day read straight from data/india_climate_train.nc (xarray) vs GET /presets/{id} at six
   places (all 6 channels, nearest 1-degree cell), and vs the dashboard's Current-conditions readout (bilinear at the
   lat/lon the dashboard reports, compared to its display rounding).
b. Orientation checks that catch flipped or shifted grids.
c. Forecast days come from serve.py (gateway /run vs a direct call through the kit client) and the gateway's units are
   physical (K, Pa); the only K->degC conversion is in the dashboard's display code.
"""
from __future__ import annotations
import os
import json, subprocess, sys, urllib.request
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from monsoon_r1.client import call_simulate                # noqa: E402

GW, SERVE, DASH = "http://127.0.0.1:8100", "http://127.0.0.1:8000", "http://127.0.0.1:5173/"
PLACES = {"Mumbai": (19.1, 72.9), "Delhi": (28.6, 77.2), "Chennai": (13.1, 80.3), "Leh": (34.2, 77.6),
          "mid-Bay of Bengal": (15.0, 88.0), "mid-Arabian Sea": (15.0, 65.5)}
PRESETS = ["heavy-rain", "heatwave", "western-disturbance"]
CH = ["t2m", "tp", "u10", "v10", "msl", "tcwv"]
ROWS = []


def get(path, body=None):
    req = urllib.request.Request(GW + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def rec(ok, what, detail=""):
    ROWS.append((bool(ok), what, detail)); print(f"  {'PASS' if ok else 'FAIL'}  {what:58s} {detail}")


def cell(la, lo):
    return int(np.clip(round(la - 6.5), 0, 31)), int(np.clip(round(lo - 65.5), 0, 35))


def bilinear(a, la, lo):
    gy, gx = np.clip(la - 6.5, 0, 31), np.clip(lo - 65.5, 0, 35)
    y0, x0 = int(gy), int(gx); y1, x1 = min(31, y0 + 1), min(35, x0 + 1); fy, fx = gy - y0, gx - x0
    return (a[y0, x0] * (1 - fx) + a[y0, x1] * fx) * (1 - fy) + (a[y1, x0] * (1 - fx) + a[y1, x1] * fx) * fy


def main():
    ds = xr.open_dataset(Path(os.environ.get("MONSOON_DATA", ROOT / "data")) / "india_climate_train.nc")
    assert float(ds.lat[0]) == 6.5 and float(ds.lon[0]) == 65.5, "dataset grid origin changed"
    metas = {p["id"]: p for p in get("/presets")}
    print("\n== a. dataset vs gateway vs dashboard ==")
    for pid in PRESETS:
        m = metas[pid]; day = m["last_input_day"]
        nc = ds["data"].sel(time=day).values.astype("f8")                       # [6,32,36], lat south->north
        gw = np.asarray(get(f"/presets/{pid}")["init_states"], "f8")[2]
        worst = 0.0
        for name, (la, lo) in PLACES.items():
            i, j = cell(la, lo); worst = max(worst, float(np.abs(nc[:, i, j] - gw[:, i, j]).max()))
        rec(worst <= 6e-4, f"{m['name']} {day}: .nc == /presets at 6 places x 6 channels", f"max |diff| {worst:.1e} (gateway rounds to 3 decimals)")
        try:
            pts = list(PLACES.values())
            res = subprocess.run(["node", "tests/readout.mjs"], cwd=ROOT / "frontend", input=json.dumps({"url": DASH, "preset": m["name"], "points": pts}),
                                 capture_output=True, text=True, timeout=240, shell=sys.platform == "win32")
            reads = json.loads(res.stdout) if res.returncode == 0 else None
        except Exception as e:
            reads = None; res = type("R", (), {"stderr": str(e)})
        if reads is None:
            rec(False, f"{m['name']}: dashboard readout", "dashboard not reachable: " + res.stderr.strip()[-160:]); continue
        bad = []
        for (name, _), r in zip(PLACES.items(), reads):
            if not r or r["lat"] is None: bad.append(f"{name}: no readout"); continue
            la, lo = r["lat"], r["lon"]; ws = np.hypot(nc[2], nc[3])
            exp = {"rain": (bilinear(nc[1], la, lo), 1), "temp": (bilinear(nc[0], la, lo) - 273.15, 1), "wind": (bilinear(ws, la, lo), 1),
                   "pressure": (bilinear(nc[4], la, lo) / 100, 0), "moisture": (bilinear(nc[5], la, lo), 0)}
            for k, (v, dp) in exp.items():
                tol = 0.5 * 10 ** -dp + 0.02 * 10 ** -dp * 10                      # display rounding + 0.01-degree position rounding
                if r[k] is None or abs(r[k] - v) > tol: bad.append(f"{name} {k}: shown {r[k]} vs data {v:.3f}")
        rec(not bad, f"{m['name']}: dashboard readout == .nc at 6 places", "; ".join(bad[:3]) or "rain, temp, wind, pressure, moisture all match to rounding")
    print("\n== b. orientation ==")
    jul = ds["data"].sel(time=metas["heavy-rain"]["last_input_day"]).values
    g = lambda name, c: jul[c][cell(*PLACES[name])]
    rec(g("Leh", 0) < g("Delhi", 0), "Leh colder than Delhi (July)", f"{g('Leh', 0) - 273.15:.1f} vs {g('Delhi', 0) - 273.15:.1f} °C")
    rec(g("mid-Arabian Sea", 2) > 0, "July Arabian Sea u10 > 0 (south-west monsoon)", f"{g('mid-Arabian Sea', 2):.1f} m/s")
    # moisture: compare the July MEAN over the training years (a single day can be wetter over Rajasthan, e.g. 2019-07-23)
    tidx = ds.indexes["time"]; sel = np.where((tidx.month == 7) & (tidx.year <= 2018))[0]
    tc = ds["data"].isel(channel=5).values[sel].mean(0); bay, raj = tc[cell(15.0, 88.0)], tc[cell(27.0, 72.0)]
    rec(bay > raj, "July-mean moisture: Bay of Bengal > Rajasthan (2005-2018)", f"{bay:.0f} vs {raj:.0f} kg/m²")
    geo = get("/geography"); lsm = np.asarray(geo["land_sea_mask"]); oro = np.asarray(geo["orography_m"]); st = ds["static"].values
    d_, b_ = cell(*PLACES["Delhi"]), cell(*PLACES["mid-Bay of Bengal"])          # the mask is a land FRACTION (0..1)
    rec(lsm[d_] >= 0.99 and st[0][d_] >= 0.99, "land-sea mask = 1 at Delhi (gateway and .nc)", f"{st[0][d_]:.3f}")
    rec(lsm[b_] <= 0.01 and st[0][b_] <= 0.01, "land-sea mask = 0 mid-Bay (gateway and .nc)", f"{st[0][b_]:.3f}")
    rec(oro[cell(*PLACES["Leh"])] > 2500, "orography high at Leh", f"{oro[cell(*PLACES['Leh'])]:.0f} m")
    rec(oro[cell(*PLACES["Chennai"])] < 100, "orography ~0 at Chennai", f"{oro[cell(*PLACES['Chennai'])]:.0f} m")
    print("\n== c. forecast source and units ==")
    m = metas["heavy-rain"]; t = ds.indexes["time"].get_loc(np.datetime64(m["last_input_day"]))
    init = ds["data"].isel(time=slice(t - 2, t + 1)).values.astype("f4")
    direct = call_simulate(SERVE, {"init_states": init.tolist(), "doy_sincos": m["doy_sincos"], "steps": 10, "perturbation": None}, allow_private=True)
    run = np.asarray(get("/run", {"preset_id": "heavy-rain", "shock": None})["prime"], "f4")
    d = float(np.abs(direct.out - run).max()) if direct.ok else float("inf")
    rec(direct.ok and d <= 1.5e-3, "gateway forecast days == serve.py (direct call)", f"max |diff| {d:.1e}")
    rec(230 < run[:, 0].min() and run[:, 0].max() < 335 and 9e4 < run[:, 4].min() and run[:, 4].max() < 1.1e5 and run[:, 1].min() >= 0,
        "gateway units are physical (t2m in K, msl in Pa, rain >= 0)", f"t2m {run[:, 0].min():.0f}-{run[:, 0].max():.0f} K, msl {run[:, 4].min():.0f}-{run[:, 4].max():.0f} Pa")
    conv = [str(p.relative_to(ROOT)) for p in (ROOT / "frontend" / "src").rglob("*.js*") if "273.15" in p.read_text(encoding="utf-8")]
    rec(conv == [str(Path("frontend/src/data.js"))], "K->°C conversion only in the dashboard display code", ", ".join(conv))
    n = sum(ok for ok, *_ in ROWS)
    print(f"\nRESULT: {n}/{len(ROWS)} PASS"); return 0 if n == len(ROWS) else 1


if __name__ == "__main__":
    sys.exit(main())
