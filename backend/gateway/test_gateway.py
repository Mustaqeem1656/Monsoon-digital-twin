"""End-to-end gateway test. Start the inference server (port 8000) and the gateway (port 8100) first, then:
  python -m backend.gateway.test_gateway
Checks: the 4 shocks and 5 weather events through /run (real centre + a moved centre), finite outputs, zero shock and
0% event -> difference exactly 0, judge shocks identical to the kit, cyclone track, plausibility warnings, bad centres
rejected, region lookup, WebSocket stream, physical thresholds, fading, and timing."""
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


def fin(r):
    return all(np.isfinite(np.asarray(r[k], "f4")).all() for k in ("prime", "branch", "difference")) and np.asarray(r["prime"]).shape == (10, 6, 32, 36)


def main():
    s, h = call("/health"); check(s == 200 and h["inference_server"]["ready"], "/health: inference server ready")
    s, pres = call("/presets"); check(s == 200 and len(pres) == 6, f"/presets lists {len(pres)} presets")
    pid = "heavy-rain"
    from backend.gateway import geo
    for (la, lo), want in {(19.07, 72.88): "Maharashtra", (28.61, 77.21): "NCT of Delhi", (22.57, 88.36): "West Bengal",
                           (31.55, 74.34): "Pakistan", (13.08, 80.27): "Tamil Nadu", (15.0, 85.0): "Sea / outside"}.items():
        got = geo.region_at(la, lo); check(got == want, f"region at {la},{lo} = {got}")
    s, st = call("/shocks"); check(s == 200 and sorted(st["types"]) == ["custom", "judge_stall", "judge_warm", "zero"], f"/shocks has exactly 4 shocks: {sorted(st['types'])}")

    # ---- shocks ----
    times = []
    for kind, extra in {"judge_warm": {}, "judge_stall": {}, "custom": {"lat": 20.0, "lon": 80.0, "variable": "msl", "amount": -800}}.items():
        t0 = time.perf_counter(); s, r = call("/run", {"preset_id": pid, "shock": {"type": kind, **extra}}); times.append(time.perf_counter() - t0)
        check(s == 200 and fin(r) and np.abs(np.asarray(r["difference"])).max() > 0, f"shock {kind}: finite, responds, day1 {r['outcome'][0]['affected_area_kkm2']} kkm2 ({times[-1]:.2f}s)")
    s, r = call("/run", {"preset_id": pid, "shock": {"type": "zero"}})
    check(s == 200 and np.abs(np.asarray(r["difference"])).max() == 0.0 and r["outcome_day0"]["cells"] == 0, "zero shock -> difference exactly 0")
    s, r = call("/run", {"preset_id": pid, "shock": None})
    check(s == 200 and np.abs(np.asarray(r["difference"])).max() == 0.0, "no shock -> difference exactly 0")
    s, r = call("/run", {"preset_id": pid, "shock": {"type": "heatwave", "lat": 20, "lon": 80}})
    check(s == 422, "old shock type 'heatwave' is rejected (it is a weather event now)")
    s, r = call("/run", {"preset_id": pid, "shock": {"type": "custom", "lat": 45.0, "lon": 80.0, "variable": "t2m", "amount": 2}})
    check(s == 422 and "outside the model domain" in r.get("detail", ""), "bad centre rejected")
    from monsoon_r1.scoring import make_shock
    init = np.asarray(call(f"/presets/{pid}")[1]["init_states"], "f4")
    for kind, name in (("judge_warm", "warm_ocean"), ("judge_stall", "monsoon_stall")):
        _, r = call("/shock/preview", {"preset_id": pid, "shock": {"type": kind}})
        check(np.abs(np.asarray(r["perturbation"]) - make_shock(name, init[-1], geo.STD)).max() < 2e-3, f"{kind} matches kit make_shock('{name}')")
    s, r = call("/run", {"preset_id": pid, "include_fields": False, "shock": {"type": "custom", "lat": 15, "lon": 77, "radius": 3.75, "variable": "t2m", "amount": 2}})
    o0, o1 = r["outcome_day0"], r["outcome"][0]
    check(o0["cells"] > 0 and o1["cells"] > 0, f"+2 C custom at 15N 77E: day0 {o0['affected_area_kkm2']} kkm2, day1 {o1['affected_area_kkm2']} kkm2 / {o1['reach_km']:.0f} km")

    # ---- weather events ----
    s, evs = call("/events"); check(s == 200 and [e["id"] for e in evs] == ["monsoon_onset", "heavy_rain", "heatwave", "cyclone", "western_disturbance"], "/events lists the 5 events")
    cyc = next(e for e in evs if e["id"] == "cyclone")
    check(cyc["source_date"].startswith("2020-05"), f"cyclone template is Amphan: {cyc['source_date']} at {cyc['centre']}")
    moved = {"monsoon_onset": (16.0, 72.0), "heavy_rain": (23.0, 85.0), "heatwave": (27.0, 75.0), "cyclone": (13.0, 84.0), "western_disturbance": (31.0, 78.0)}
    for e in evs:
        for label, where in (("real centre", {}), ("moved", dict(zip(("lat", "lon"), moved[e["id"]])))):
            t0 = time.perf_counter(); s, r = call("/run", {"preset_id": pid, "event": {"event_id": e["id"], "strength": 100, **where}}); times.append(time.perf_counter() - t0)
            em = r.get("event_metrics", {}) if s == 200 else {}
            check(s == 200 and fin(r) and np.abs(np.asarray(r["difference"])).max() > 0 and bool(em),
                  f"event {e['id']:20s} {label:11s}: finite, responds, metrics {sorted(em)[:3]}, warnings {len(r['shock']['warnings']) if s == 200 else '-'} ({times[-1]:.2f}s)")
        s, r = call("/run", {"preset_id": pid, "event": {"event_id": e["id"], "strength": 0}})
        check(s == 200 and np.abs(np.asarray(r["difference"])).max() == 0.0, f"event {e['id']} at 0% -> difference exactly 0")
    s, r = call("/run", {"preset_id": "cyclone", "include_fields": False, "event": {"event_id": "cyclone"}})
    tr = r["event_metrics"]["track"]
    check(len(tr) == 11 and tr[0]["depth_hPa"] > 5, "cyclone track: " + " -> ".join(f"d{t['day']} {t['lat']:.1f}N {t['lon']:.1f}E {t['lowest_pressure_hPa']:.0f}hPa" for t in tr[::3]))
    print("        notes: " + " | ".join(r["event_metrics"]["notes"]))
    s, r = call("/event/preview", {"preset_id": pid, "event": {"event_id": "cyclone", "lat": 26.5, "lon": 72.5}})
    check(s == 200 and any("over land" in w for w in r["event"]["warnings"]), f"cyclone over Rajasthan warns: {r['event']['warnings'][:1]}")
    s, r = call("/event/preview", {"preset_id": pid, "event": {"event_id": "heatwave", "strength": 140}})
    check(any("Stronger than anything" in w for w in r["event"]["warnings"]), "strength 140% warns")
    s, r = call("/run", {"preset_id": pid, "event": {"event_id": "cyclone"}, "shock": {"type": "zero"}})
    check(s == 422, "event and shock together are rejected (one at a time)")
    s, r = call("/run", {"preset_id": pid, "include_fields": False, "shock": {"type": "custom", "lat": 15, "lon": 77, "radius": 3.75, "variable": "t2m", "amount": 0.8}})
    check(r["fade"]["faded_by_day"] is not None or r["fade"]["last_affected_day"] is not None, f"fade summary present: {r['fade']}")
    asyncio.run(ws_test(pid))
    print(f"\n/run wall time: mean {np.mean(times):.2f}s max {np.max(times):.2f}s")
    print("RESULT:", "all checks passed" if not FAIL else f"{len(FAIL)} FAILED")
    return 1 if FAIL else 0


async def ws_test(pid):
    import websockets
    async with websockets.connect(GW.replace("http", "ws") + "/stream", max_size=2 ** 26) as ws:
        await ws.send(json.dumps({"preset_id": pid, "event": {"event_id": "cyclone"}, "steps": 10}))
        kinds, done = [], None
        while True:
            m = json.loads(await ws.recv()); kinds.append(m["type"])
            if m["type"] in ("done", "error"): done = m; break
    check(kinds == ["start"] + ["day"] * 10 + ["done"] and "track" in done.get("event_metrics", {}),
          f"WebSocket /stream: {kinds.count('day')} day messages, then '{kinds[-1]}' with the cyclone track")


if __name__ == "__main__":
    sys.exit(main())
