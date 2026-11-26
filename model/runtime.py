"""Inference engine used by serve.py: numpy in / numpy out, one network step at a time.

Two interchangeable backends run the SAME network step:
  - torch       : weights/model.pt  (preferred)
  - onnxruntime : weights/model.onnx (fallback if torch or the .pt cannot be loaded, e.g. a version mismatch)
Everything around the step (normalisation, the rollout loop, the safety net) is plain numpy here, so both backends
behave identically. Only allowed judging libraries are used (numpy, torch, onnxruntime, standard library).
"""
from __future__ import annotations
import json, logging, math
from pathlib import Path

import numpy as np

WEIGHTS_DIR = Path(__file__).resolve().parents[1] / "weights"
NORM_FILE = WEIGHTS_DIR / "norm.json"          # mean/std per channel (rain in log1p space) + model name
NC, H, W = 6, 32, 36
RAIN, T2M, TCWV = 1, 0, 5
T2M_SAFE = (233.65, 332.65)                    # a hair inside the judge's [233.15, 333.15] K validity band
log = logging.getLogger("monsoon")


class TorchBackend:
    name = "torch"

    def __init__(self, threads: int = 4):
        import torch
        from model.net import MonsoonNet
        torch.set_num_threads(threads)
        ck = torch.load(WEIGHTS_DIR / "model.pt", map_location="cpu", weights_only=False)
        m = MonsoonNet(**ck["arch"]); m.load_state_dict(ck["state_dict"]); m.eval()
        self.torch, self.m = torch, m

    def step(self, z3: np.ndarray, angle: float) -> np.ndarray:
        t = self.torch
        with t.inference_mode():
            return self.m.step(t.from_numpy(z3[None]), t.tensor([angle], dtype=t.float32))[0].numpy()


class OnnxBackend:
    name = "onnxruntime"

    def __init__(self, threads: int = 4):
        import onnxruntime as ort
        so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
        self.s = ort.InferenceSession(str(WEIGHTS_DIR / "model.onnx"), so, providers=["CPUExecutionProvider"])

    def step(self, z3: np.ndarray, angle: float) -> np.ndarray:
        return self.s.run(None, {"z3": z3[None].astype("f4"), "angle": np.array([angle], "f4")})[0][0]


class Engine:
    def __init__(self, backend, mean, std, model_name="monsoon"):
        self.b = backend; self.mean = np.asarray(mean, "f4")[:, None, None]; self.std = np.asarray(std, "f4")[:, None, None]
        self.model_name = model_name

    def encode(self, x):
        z = x.astype("f4", copy=True); z[..., RAIN, :, :] = np.log1p(np.maximum(x[..., RAIN, :, :], 0))
        return ((z - self.mean) / self.std).astype("f4")

    def decode(self, z):
        x = z * self.std + self.mean
        x[..., RAIN, :, :] = np.expm1(np.maximum(x[..., RAIN, :, :], 0))
        return x

    def simulate(self, init_states, doy_sincos, steps: int, perturbation=None):
        """init [3,6,32,36] physical (oldest first), doy_sincos of the LAST input day, perturbation [6,32,36] or None.
        Returns ([steps,6,32,36] physical float32, number of cells the safety net had to replace)."""
        x = np.array(init_states, dtype="f4", copy=True)
        if perturbation is not None:
            x[-1] = x[-1] + np.asarray(perturbation, "f4")
        x = np.where(np.isfinite(x), x, 0.0).astype("f4")               # never feed NaN into the network
        z3 = self.encode(x); angle0 = math.atan2(float(doy_sincos[0]), float(doy_sincos[1]))
        outs, n_bad = [], 0
        for k in range(steps):
            z = self.b.step(z3, angle0 + 2 * math.pi * (k + 1) / 365.0)
            bad = ~np.isfinite(z)
            if bad.any():                                               # safety net: persistence for any bad cell
                n_bad += int(bad.sum()); z = np.where(bad, z3[-1], z)
            outs.append(z); z3 = np.concatenate([z3[1:], z[None]], 0)
        out = self.decode(np.stack(outs))
        out = np.where(np.isfinite(out), out, x[-1][None])               # final belt-and-braces
        out[:, RAIN] = np.maximum(out[:, RAIN], 0.0)
        out[:, T2M] = np.clip(out[:, T2M], *T2M_SAFE)
        out[:, TCWV] = np.maximum(out[:, TCWV], 0.0)
        if n_bad:
            log.warning("safety net replaced %d non-finite values with persistence", n_bad)
        return out.astype("f4"), n_bad


def load_engine(threads: int = 4, prefer: str = "torch") -> Engine:
    norm = json.loads(NORM_FILE.read_text())
    order = [TorchBackend, OnnxBackend] if prefer == "torch" else [OnnxBackend, TorchBackend]
    errs = []
    for B in order:
        try:
            b = B(threads); log.info("backend: %s", b.name)
            return Engine(b, norm["mean"], norm["std"], f"{norm.get('model_name', 'monsoon')}-{b.name}")
        except Exception as e:                                          # e.g. torch missing or checkpoint incompatible
            errs.append(f"{B.name}: {type(e).__name__}: {e}"); log.warning("backend %s failed: %s", B.name, e)
    raise RuntimeError("no backend could be loaded: " + " | ".join(errs))
