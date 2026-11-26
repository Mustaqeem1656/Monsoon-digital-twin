"""Inference wrapper: loads weights/model.pt once (CPU, 4 threads) and exposes the same simulate() signature serve.py uses.
Everything the model needs (geography maps, normalisation) is inside the checkpoint; no data files, no dates."""
from __future__ import annotations
import math
from pathlib import Path

import numpy as np
import torch

from backend.model.net import MonsoonNet

WEIGHTS = Path(__file__).resolve().parents[1] / "weights" / "model.pt"
_MODEL = None


def load(path: Path | None = None, device: str = "cpu") -> MonsoonNet:
    ck = torch.load(path or WEIGHTS, map_location=device, weights_only=False)
    m = MonsoonNet(**ck["arch"]); m.load_state_dict(ck["state_dict"]); m.eval().to(device)
    return m


def get_model() -> MonsoonNet:
    global _MODEL
    if _MODEL is None:
        torch.set_num_threads(4)
        _MODEL = load()
    return _MODEL


@torch.inference_mode()
def simulate(init_states, doy_sincos, steps, perturbation, model: MonsoonNet | None = None) -> np.ndarray:
    """init_states [3,6,32,36] physical, oldest first; doy_sincos of the last input day; perturbation [6,32,36] or None.
    Returns [steps,6,32,36] physical float32."""
    m = model or get_model()
    x = torch.as_tensor(np.asarray(init_states, "f4")).clone()
    if perturbation is not None:
        x[-1] = x[-1] + torch.as_tensor(np.asarray(perturbation, "f4"))
    angle = torch.tensor([math.atan2(float(doy_sincos[0]), float(doy_sincos[1]))], dtype=torch.float32)
    z = m.rollout(m.encode(x)[None], angle, int(steps))[0]
    return m.decode(z).numpy().astype("f4")
