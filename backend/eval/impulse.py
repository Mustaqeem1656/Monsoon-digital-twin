"""Impulse test: poke ONE grid cell and measure how far the day-1 response reaches (locality / speed-limit check).
  python -m backend.eval.impulse            (uses backend/weights/model.pt)
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.eval.baselines import load_data, load_std  # noqa: E402


@torch.inference_mode()
def report(model, i0=16, j0=18, tol=1e-3):
    data, _, _ = load_data(); std = load_std()
    init = data[200:203].copy()                                    # any real 3-day window
    from backend.model.inference import simulate
    sc = [float(np.sin(2 * np.pi * 180 / 365)), float(np.cos(2 * np.pi * 180 / 365))]
    base = simulate(init, sc, 3, None, model=model)
    pert = np.zeros(init.shape[1:], "f4"); pert[:, i0, j0] = std           # +1 std in every channel at one cell
    shock = simulate(init, sc, 3, pert, model=model)
    ii, jj = np.indices(base.shape[-2:]); dist = np.maximum(abs(ii - i0), abs(jj - j0))   # Chebyshev distance (3x3 convs)
    print("\n================ IMPULSE TEST (one cell poked by +1 std) ================")
    print(f"  theoretical reach per day: {model.receptive_radius} cells")
    for k in range(3):
        e = (((shock[k] - base[k]) / std[:, None, None]) ** 2).sum(0)
        z = np.abs((shock[k] - base[k]) / std[:, None, None]).max(0)
        reach = int(dist[z > tol].max()) if (z > tol).any() else 0
        near = e[dist <= 3].sum() / max(e.sum(), 1e-12)
        print(f"  day {k + 1}: response reaches {reach:2d} cells (|delta|>{tol} std); {100 * near:5.1f}% of energy within 3 cells")
    return reach


if __name__ == "__main__":
    from backend.model.inference import get_model
    report(get_model())
