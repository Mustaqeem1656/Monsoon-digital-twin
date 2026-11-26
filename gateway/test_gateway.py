"""End-to-end gateway test. Start the inference server (port 8000) and the gateway (port 8100) first, then:
  python -m gateway.test_gateway
Checks: every shock type through /run, finite outputs, zero-amount shock -> zero difference, judge shocks identical to
the kit's make_shock, bad centres rejected, region lookup, WebSocket stream, and timing of a full /run."""
from __future__ import annotations
import asyncio, json, sys, time, urllib.error, urllib.request

import numpy as np

GW = "http://127.0.0.1:8100"
FAIL = []


def call(path, body=None):
    req = urllib.request.Request(GW + path, data=None if body is None else json.dumps(body).encode(),
                                 method="GET" if body is None else "POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(ok, msg):
    print(("  ok   " if ok else "  FAIL ") + msg)
    if not ok: FAIL.append(msg)


def main():
    s, h = call("/health"); check(s == 200 and h["inference_server"]["ready"], f"/health: inference server ready ({h})")
    s, pres = call("/presets"); check(s == 200 and len(pres) >= 6, f"/presets lists {len(pres)} presets")
    pid = next(p["id"] for p in pres if p["id"] == "heavy-rain")
    from gateway import geo
    for (la, lo), want in {(19.07, 72.88): "Maharashtra", (28.61, 77.21): "NCT of Delhi", (22.57, 88.36): "West Bengal",
                           (31.55, 74.34): "Pakistan", (13.08, 80.27): "Tamil Nadu", (15.0, 85.0): "Sea / outside"}.items():
        got = geo.region_at(la, lo); check(got == want, f"region at {la},{lo} = {got} (expect {want})")

    centre = {"lat": 15.0, "lon": 87.0, "radius": 4}
    cases = {"judge_warm": {}, "judge_stall": {}, "heatwave": {"lat": 26.0, "lon": 78.0}, "warm_sea": centre,
             "cyclone": centre, "monsoon_stall": {"lat": 14.0, "lon": 70.0}, "rain_burst": {"lat": 20.0, "lon": 80.0},
             "dry_spell": {"lat": 22.0, "lon": 78.0}, "custom": {"lat": 20.0, "lon": 80.0, "variable": "msl", "amount": -800}}
    times = []
    for kind, extra in cases.items():
        t0 = time.perf_counter(); s, r = call("/run", {"preset_id": pid, "shock": {"type": kind, **extra}, "steps": 10})
        dt = time.perf_counter() - t0; times.append(dt)
        if s != 200:
            check(False, f"{kind}: HTTP {s} {r}"); continue
        P, B, D = (np.asarray(r[k], "f4") for k in ("prime", "branch", "difference"))
        fin = all(np.isfinite(x).all() for x in (P, B, D)) and P.shape == (10, 6, 32, 36)
        o1, o8 = r["outcome"][0], r["outcome"][7]
        check(fin and np.abs(D).max() > 0, f"{kind:13s} finite, responds | day1 {o1['affected_area_kkm2']:7.1f} kkm2 "
              f"reach {o1['reach_km']:5.0f} km main {o1['main_variable']} | day8 reach {o8['reach_km']:5.0f} km | "
              f"top {[x['state'] for x in o1['top_states'][:2]]} | {dt:.2f}s | warn {len(r['shock']['warnings'])}")
    s, r = call("/run", {"preset_id": pid, "shock": {"type": "custom", "lat": 20, "lon": 80, "variable": "t2m", "amount": 0}})
    check(s == 200 and np.abs(np.asarray(r["difference"])).max() == 0.0, "zero-amount shock -> difference exactly 0")
    s, r = call("/run", {"preset_id": pid, "shock": None})
    check(s == 200 and np.abs(np.asarray(r["difference"])).max() == 0.0, "no shock -> difference exactly 0")
    s, r = call("/run", {"preset_id": pid, "shock": {"type": "heatwave", "lat": 45.0, "lon": 80.0}})
    check(s == 422 and "outside the model domain" in r.get("detail", ""), f"bad centre rejected: {r.get('detail')}")
    s, r = call("/shock/preview", {"preset_id": pid, "shock": {"type": "rain_burst", "lat": 20, "lon": 80, "strength": 3}})
    check(s == 200 and r["shock"]["warnings"], f"strong shock warns: {r['shock']['warnings'][:1]}")
    # judge shocks identical to the kit
    from monsoon_r1.scoring import make_shock
    init = np.asarray(call(f"/presets/{pid}")[1]["init_states"], "f4")
    for kind, name in (("judge_warm", "warm_ocean"), ("judge_stall", "monsoon_stall")):
        _, r = call("/shock/preview", {"preset_id": pid, "shock": {"type": kind}})
        kit = make_shock(name, init[-1], geo.STD)
        check(np.abs(np.asarray(r["perturbation"]) - kit).max() < 2e-3, f"{kind} matches kit make_shock('{name}')")
    _, r = call("/run", {"preset_id": "cyclone", "shock": {"type": "warm_sea", **centre}, "include_fields": False})
    im = r["impacts"]
    print(f"  impacts (cyclone preset, warm_sea): heat elevated peak {im['branch']['heat_stress']['peak_area_elevated_kkm2']} kkm2,"
          f" heavy rain peak {im['branch']['heavy_rain']['peak_area_heavy_or_worse_kkm2']} kkm2 "
          f"(diff {im['difference']['heavy_rain']['peak_area_heavy_or_worse_kkm2']}), crop {im['branch']['crop_water'].get('active')},"
          f" solar {im['branch']['solar']['mean_good_pct']}%, wind land {im['branch']['wind']['mean_land_index']}")
    _, r = call("/run", {"preset_id": "heavy-rain", "shock": {"type": "dry_spell", "lat": 22, "lon": 80, "radius": 6},
                         "include_fields": False})
    c = r["impacts"]
    print(f"  crop-water (heavy-rain preset, dry_spell): prime {c['prime']['crop_water']['cropland_stressed_pct']}% "
          f"-> branch {c['branch']['crop_water']['cropland_stressed_pct']}% stressed")
    asyncio.run(ws_test(pid))
    print(f"\n/run wall time (2 model calls + analysis + ~2.5 MB JSON): mean {np.mean(times):.2f}s max {np.max(times):.2f}s")
    print("RESULT:", "all checks passed" if not FAIL else f"{len(FAIL)} FAILED")
    return 1 if FAIL else 0


async def ws_test(pid):
    import websockets
    async with websockets.connect(GW.replace("http", "ws") + "/stream", max_size=2 ** 26) as ws:
        await ws.send(json.dumps({"preset_id": pid, "shock": {"type": "cyclone", "lat": 15, "lon": 87}, "steps": 10}))
        kinds = []
        while True:
            m = json.loads(await ws.recv()); kinds.append(m["type"])
            if m["type"] in ("done", "error"): break
    check(kinds == ["start"] + ["day"] * 10 + ["done"], f"WebSocket /stream sent {kinds.count('day')} day messages then '{kinds[-1]}'")


if __name__ == "__main__":
    sys.exit(main())
