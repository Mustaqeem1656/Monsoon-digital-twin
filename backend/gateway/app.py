"""Dashboard gateway (separate from serve.py):   python -m backend.gateway.app      (port 8100, see gateway/config.json)

It never runs the model itself: it forwards requests to the inference server over HTTP (address and endpoint paths
come from config.json), builds shocks, and turns the two rollouts (Prime = no shock, Branch = with shock) into
outcomes and impact indicators for the 3D dashboard.

GET  /health               gateway status + whether the inference server is ready
GET  /presets              list of start windows
GET  /presets/{id}         one preset: 3 input days + the 10 real days that followed (for comparison)
GET  /geography            region raster (RLE), names, land mask, orography, model grid
GET  /shocks               shock types and their parameters
POST /shock/preview        build a shock without running the model (perturbation + size in std units)
POST /run                  Prime + Branch rollouts, difference, outcome per day, impacts
WS   /stream               same as /run, sent day by day for the animation
"""
from __future__ import annotations
import asyncio, json, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from backend.gateway import geo, impact, presets_builder, shocks

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "config.json").read_text())
app = FastAPI(title="Monsoon digital twin gateway")
app.add_middleware(CORSMiddleware, allow_origins=CFG["cors_origins"], allow_origin_regex=CFG["cors_origin_regex"],
                   allow_methods=["*"], allow_headers=["*"])
POOL = ThreadPoolExecutor(4)
MAX_STEPS = 30


def _json(obj, status=200):
    return Response(json.dumps(obj, separators=(",", ":"), allow_nan=False), status_code=status, media_type="application/json")


def _r(a):
    return np.round(np.asarray(a, "f8"), CFG["round_decimals"]).tolist()


# ---- inference server client (stdlib only) --------------------------------------------------------------------
def _post(path: str, payload: dict | None):
    data = b"{}" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(CFG["serve_url"].rstrip("/") + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=CFG["serve_timeout_s"]) as r:
        return json.loads(r.read())


def run_model(init: np.ndarray, doy_sincos, steps: int, pert: np.ndarray | None) -> tuple[np.ndarray, float]:
    body = {"init_states": init.tolist(), "doy_sincos": list(doy_sincos), "steps": int(steps),
            "perturbation": None if pert is None else pert.tolist()}
    try:
        js = _post(CFG["simulate_path"], body)
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"inference server returned HTTP {e.code}: {e.read()[:200].decode(errors='ignore')}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(503, f"inference server not reachable at {CFG['serve_url']}: {e}")
    out = np.asarray(js["rollout"], "f4")
    if not np.isfinite(out).all():
        raise HTTPException(502, "inference server returned non-finite values")
    return out, float(js.get("inference_ms", 0.0))


# ---- presets ---------------------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def presets_meta():
    idx = json.loads((presets_builder.CACHE / "presets_index.json").read_text())
    return {p["id"]: {**p, **idx[p["id"]]} for p in json.loads((HERE / "presets" / "presets.json").read_text())}


@lru_cache(maxsize=16)
def preset_arrays(pid: str):
    if pid not in presets_meta():
        raise HTTPException(404, f"unknown preset {pid!r}; see GET /presets")
    z = np.load(presets_builder.CACHE / f"{pid}.npz"); return z["init"].astype("f4"), z["truth"].astype("f4")


# ---- outcome of a shock per day --------------------------------------------------------------------------------
def outcomes(diff: np.ndarray, lat0: float, lon0: float) -> list[dict]:
    thr = CFG["affected_threshold_std"]; z = diff / geo.STD[None, :, None, None]
    dist = geo.distance_km(lat0, lon0); area = geo.cell_area_km2(); res = []
    for d in range(diff.shape[0]):
        zm = np.abs(z[d]).max(0); hit = zm >= thr
        if not hit.any():
            res.append({"day": d + 1, "affected_area_kkm2": 0.0, "reach_km": 0.0, "main_variable": None,
                        "peak_change": 0.0, "units": None, "peak_at": None, "top_states": []}); continue
        energy = [(z[d, c][hit] ** 2).sum() for c in range(6)]; c = int(np.argmax(energy))
        k = int(np.abs(diff[d, c]).argmax()); i, j = divmod(k, geo.NLON)
        res.append({"day": d + 1, "affected_area_kkm2": round(float(area[hit].sum()) / 1e3, 1),
                    "reach_km": round(float(dist[hit].max()), 0), "main_variable": geo.CHANNELS[c],
                    "peak_change": round(float(diff[d, c, i, j]), 3), "units": geo.UNITS[c],
                    "peak_at": {"lat": float(geo.LAT[i]), "lon": float(geo.LON[j]),
                                "region": geo.region_at(float(geo.LAT[i]), float(geo.LON[j]))},
                    "top_states": geo.top_states(diff[d, c], hit.astype("f4"))})
    return res


def _prepare(req: dict):
    pid = req.get("preset_id"); steps = int(req.get("steps", 10))
    if not (1 <= steps <= MAX_STEPS):
        raise HTTPException(422, f"steps must be between 1 and {MAX_STEPS}")
    init, truth = preset_arrays(pid); meta = presets_meta()[pid]
    spec = req.get("shock")
    if spec is None:
        pert, info = None, None
    else:
        try:
            pert, info = shocks.build(spec, init[-1])
        except ValueError as e:
            raise HTTPException(422, str(e))
    return pid, steps, init, truth, meta, pert, info


def _compute(req: dict):
    pid, steps, init, truth, meta, pert, info = _prepare(req)
    t0 = time.perf_counter()
    fp = POOL.submit(run_model, init, meta["doy_sincos"], steps, None)
    fb = POOL.submit(run_model, init, meta["doy_sincos"], steps, pert) if pert is not None else None
    prime, ms_p = fp.result(); branch, ms_b = fb.result() if fb else (prime.copy(), 0.0)
    model_s = time.perf_counter() - t0
    diff = branch - prime
    centre = (info["centre"]["lat"], info["centre"]["lon"]) if info else (20.0, 80.0)
    doys = meta.get("forecast_doys", [])
    doys = (doys + [doys[-1] + k for k in range(1, steps + 1)])[:steps] if doys else [meta["doy"] + k for k in range(1, steps + 1)]
    doys = [((d - 1) % 365) + 1 for d in doys]
    return {"pid": pid, "meta": meta, "steps": steps, "shock": info, "prime": prime, "branch": branch, "diff": diff,
            "truth": truth[:steps], "outcome": outcomes(diff, *centre),
            "impacts": impact.impacts(prime, branch, doys, meta.get("forecast_months", [])),
            "timing": {"model_calls_s": round(model_s, 3), "server_ms_prime": ms_p, "server_ms_branch": ms_b}}


# ---- endpoints -------------------------------------------------------------------------------------------------
@app.get("/health")
def health():
    try:
        s = _post(CFG["health_path"], None); ok = s.get("status") == "ready"
    except Exception as e:
        s, ok = {"error": f"{type(e).__name__}"}, False
    return _json({"status": "ok", "inference_server": {"url": CFG["serve_url"], "ready": ok, "detail": s}})


@app.get("/presets")
def list_presets():
    return _json([{k: p[k] for k in ("id", "name", "description", "selection_rule", "last_input_day", "first_forecast_day", "doy",
                                     "doy_sincos", "forecast_months")} for p in presets_meta().values()])


@app.get("/presets/{pid}")
def get_preset(pid: str):
    init, truth = preset_arrays(pid)
    return _json({**presets_meta()[pid], "init_states": _r(init), "truth": _r(truth)})


@app.get("/geography")
def geography():
    r = geo.regions(); g = geo.grid(); m = r["meta"]
    major = r["frac"].argmax(-1)
    return _json({"grid": {"lat": geo.LAT.tolist(), "lon": geo.LON.tolist(), "channels": geo.CHANNELS, "units": geo.UNITS,
                           "std": geo.STD.tolist()},
                  "land_sea_mask": _r(g["lsm"]), "orography_m": _r(g["orography_m"]),
                  "regions": {k: m[k] for k in ("lat0", "lon0", "res", "nrows", "ncols", "row_order", "names", "rle",
                                                "indian_state_codes", "sources")},
                  "cell_region": major.tolist(), "elevation": _elevation()})


@lru_cache(maxsize=1)
def _elevation():
    p = HERE / "static" / "elevation.json"
    return json.loads(p.read_text()) if p.exists() else None


@app.get("/shocks")
def shock_types():
    return _json({"types": shocks.TYPES, "parameters": {
        "lat": "centre latitude, 6-38 N", "lon": "centre longitude, 65-101 E", "radius": "cells (1 cell = 1 deg), 0.5-15, default 4",
        "strength": "multiplier on the default amplitude, default 1", "variable": f"custom only: one of {geo.CHANNELS}",
        "amount": "custom only: peak change in physical units"}, "judge_types_ignore_centre": list(shocks.JUDGE_CENTRES)})


@app.post("/shock/preview")
def shock_preview(req: dict):
    init, _ = preset_arrays(req.get("preset_id"))
    try:
        d, info = shocks.build(req.get("shock") or {}, init[-1])
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _json({"shock": info, "perturbation": _r(d)})


@app.post("/run")
def run(req: dict):
    t0 = time.perf_counter(); res = _compute(req)
    res["timing"]["total_s"] = round(time.perf_counter() - t0, 3)
    fields = bool(req.get("include_fields", True))
    out = {"preset": res["meta"], "steps": res["steps"], "shock": res["shock"], "outcome": res["outcome"],
           "impacts": res["impacts"], "timing": res["timing"]}
    if fields:
        out.update(prime=_r(res["prime"]), branch=_r(res["branch"]), difference=_r(res["diff"]), truth=_r(res["truth"]))
    return _json(out)


@app.websocket("/stream")
async def stream(ws: WebSocket):
    """Client sends one JSON request like POST /run (+ optional interval_ms). Server replies: a 'start' message, one
    'day' message per forecast day (prime, branch, difference, truth, outcome), then 'done' with the impacts."""
    await ws.accept()
    try:
        while True:
            req = json.loads(await ws.receive_text())
            try:
                res = await asyncio.get_running_loop().run_in_executor(None, _compute, req)
            except HTTPException as e:
                await ws.send_text(json.dumps({"type": "error", "status": e.status_code, "detail": e.detail})); continue
            await ws.send_text(json.dumps({"type": "start", "preset": res["meta"], "steps": res["steps"], "shock": res["shock"]}))
            gap = max(0.0, float(req.get("interval_ms", 0)) / 1000.0)
            for d in range(res["steps"]):
                await ws.send_text(json.dumps({"type": "day", "day": d + 1, "prime": _r(res["prime"][d]),
                                               "branch": _r(res["branch"][d]), "difference": _r(res["diff"][d]),
                                               "truth": _r(res["truth"][d]) if d < len(res["truth"]) else None,
                                               "outcome": res["outcome"][d]}, separators=(",", ":")))
                if gap: await asyncio.sleep(gap)
            await ws.send_text(json.dumps({"type": "done", "impacts": res["impacts"], "timing": res["timing"]}))
    except WebSocketDisconnect:
        return


try:                                                     # build presets + climatology from data/ (cached in cache/)
    presets_builder.build()
except FileNotFoundError as e:
    raise SystemExit("\n" + str(e)) from None

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=CFG["port"], log_level="warning")
