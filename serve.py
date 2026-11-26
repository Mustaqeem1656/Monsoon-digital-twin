"""Inference server for Round 1:   python serve.py --port 8000   (listens on 0.0.0.0)

POST /health    -> {"status":"ready","model_name":...} only after the model is loaded AND warmed up (503 "loading" before)
POST /simulate  -> {"rollout":[steps,6,32,36], "inference_ms":float}, physical units, finite floats only

The model (model/runtime.py) loads once on CPU with 4 threads in a background thread, so /health answers immediately
while loading. Torch weights are preferred; ONNX (onnxruntime) is the fallback. JSON is parsed and written by hand
(no FastAPI encoders) to keep each call fast. Nothing is written to disk.
"""
import argparse, json, logging, threading, time

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response

from model.runtime import load_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("monsoon")
app = FastAPI()
STATE = {"engine": None, "ready": False, "error": ""}
SHAPE_IN, SHAPE_PERT = (3, 6, 32, 36), (6, 32, 36)
MAX_STEPS = 1000


def _startup():
    try:
        eng = load_engine(threads=4)
        rng = np.random.default_rng(0)                                  # warm-up on a plausible synthetic state
        base = np.array([295.0, 4.0, 2.0, 1.0, 100800.0, 35.0], "f4")[None, :, None, None]
        x = (base + rng.normal(0, 1, SHAPE_IN).astype("f4")).astype("f4"); x[:, 1] = np.abs(x[:, 1])
        for _ in range(2):
            eng.simulate(x, [0.0, 1.0], 10, None)
        STATE["engine"] = eng; STATE["ready"] = True
        log.info("ready: %s", eng.model_name)
    except Exception as e:
        STATE["error"] = f"{type(e).__name__}: {e}"; log.exception("startup failed")


threading.Thread(target=_startup, daemon=True).start()


def _json(obj, status=200):
    return Response(json.dumps(obj, separators=(",", ":")), status_code=status, media_type="application/json")


def _array(x, shape, name):
    """Nested lists (the contract) or {'b64','shape'} (tolerated) -> float32 array of exactly `shape`."""
    if isinstance(x, dict):
        import base64
        a = np.frombuffer(base64.b64decode(x["b64"]), dtype="<f4").reshape(x["shape"])
    else:
        a = np.asarray(x, dtype="f4")
    if a.shape != shape:
        raise ValueError(f"{name} has shape {a.shape}, expected {shape}")
    return a.astype("f4")


@app.post("/health")
@app.get("/health")
def health():
    if STATE["ready"]:
        return _json({"status": "ready", "model_name": STATE["engine"].model_name})
    return _json({"status": "error" if STATE["error"] else "loading", "detail": STATE["error"]}, 503)


@app.post("/simulate")
async def simulate_endpoint(request: Request):
    t0 = time.perf_counter()
    if not STATE["ready"]:
        return _json({"error": "model not ready"}, 503)
    try:
        body = json.loads(await request.body())
        init = _array(body["init_states"], SHAPE_IN, "init_states")
        sc = [float(v) for v in body["doy_sincos"]]
        steps = int(body.get("steps", 10))
        if len(sc) != 2 or not (1 <= steps <= MAX_STEPS):
            raise ValueError("doy_sincos must be [sin, cos] and steps a positive integer")
        p = body.get("perturbation")
        pert = None if p is None else _array(p, SHAPE_PERT, "perturbation")
    except Exception as e:
        return _json({"error": f"bad request: {e}"}, 422)
    out, _ = STATE["engine"].simulate(init, sc, steps, pert)
    # compact, fast serialisation: 3 decimals is far below every channel's noise level and keeps JSON ~40% smaller
    rollout = np.round(out.astype("f8"), 3).tolist()
    ms = (time.perf_counter() - t0) * 1000.0
    return Response('{"rollout":' + json.dumps(rollout, separators=(",", ":")) + f',"inference_ms":{ms:.3f}}}',
                    media_type="application/json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8000)
    uvicorn.run(app, host="0.0.0.0", port=ap.parse_args().port, log_level="warning")
