"""Per-day table of a shock's outcome, straight from the running gateway (needs serve.py :8000 and gateway :8100).
  python backend/tools/outcome_diagnostic.py [--preset heavy-rain] [--lat 15 --lon 77 --deg 2]
Default: a +2 C heatwave (gateway strength = deg / 4) at 15 N 77 E with the dashboard's default size (radius 3.75 cells).
"""
from __future__ import annotations
import argparse, json, urllib.request

UNIT_SCALE = {"msl": (0.01, "hPa")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default="http://127.0.0.1:8100"); ap.add_argument("--preset", default="heavy-rain")
    ap.add_argument("--lat", type=float, default=15.0); ap.add_argument("--lon", type=float, default=77.0)
    ap.add_argument("--deg", type=float, default=2.0); ap.add_argument("--radius", type=float, default=3.75)
    a = ap.parse_args()
    body = {"preset_id": a.preset, "include_fields": False, "steps": 10,
            "shock": {"type": "heatwave", "lat": a.lat, "lon": a.lon, "radius": a.radius, "strength": a.deg / 4}}
    req = urllib.request.Request(a.gateway + "/run", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=60).read())
    thr = r["thresholds"]; rows = [r["outcome_day0"]] + r["outcome"]
    print(f"+{a.deg:g} C heatwave at {a.lat:g}N {a.lon:g}E ({r['shock']['centre']['region']}), preset {a.preset}")
    print("thresholds: " + ", ".join(f"{k} {v * UNIT_SCALE.get(k, (1,))[0]:g}" for k, v in thr.items()) + " (msl in hPa)\n")
    print(f"{'day':>3} {'main':>5} {'max|d| main':>11} {'thr':>5} {'cells':>5} {'reach km':>8} {'area kkm2':>9}  {'max|d| t2m':>10}  top states")
    for o in rows:
        m = o["main_variable"] or "t2m"; sc = UNIT_SCALE.get(m, (1,))[0]
        top = ", ".join(f"{s['state']} {s['mean_change'] * sc:+.2f}" for s in o["top_states"][:3])
        print(f"{o['day']:>3} {o['main_variable'] or '-':>5} {o['max_abs_change'][m] * sc:>11.2f} {thr[m] * sc:>5.1f} {o['cells']:>5} "
              f"{o['reach_km']:>8.0f} {o['affected_area_kkm2']:>9.1f}  {o['max_abs_change']['t2m']:>10.2f}  {top}")
    f = r["fade"]
    print(f"\nlast affected day: {f['last_affected_day']}, faded by day: {f['faded_by_day']}")


if __name__ == "__main__":
    main()
