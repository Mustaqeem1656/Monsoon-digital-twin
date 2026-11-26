"""Score a model on a fixed split of validation windows, for comparing training tweaks.

  tune    = event + random windows whose last input day is in 2019-2020 (used to pick tweaks / checkpoints)
  confirm = the same kind of windows in 2021 (looked at once, for the final yes/no)
The three judge shocks run on EVERY event window of the split, so causality is a pass rate, not a single coin flip.
Built entirely on local_grader.grade (which is built on monsoon_r1.scoring).
"""
from __future__ import annotations
import time

import numpy as np
import torch

from backend.eval import local_grader as LG
from backend.eval.baselines import load_data
from backend.model import inference

SPLITS = {"tune": (2019, 2020), "confirm": (2021,)}
CHECKS = ("nonzero", "localized", "propagates", "stable")


def windows(split):
    _, dates, _ = load_data()
    yrs = SPLITS[split]
    w = [x for x in LG.pick_windows(n_random=60, seed=0) if dates[x[1]].year in yrs]
    ev = [x for x in w if x[0] != "random"]
    return ev + [x for x in w if x[0] == "random"], len(ev)


def cpu_call_seconds(model, reps=3):
    torch.set_num_threads(4)
    x = np.abs(np.random.default_rng(0).normal(1, 0.1, (3, 6, 32, 36))).astype("f4") * \
        np.array([290, 3, 2, 1, 101000, 30], "f4")[None, :, None, None]
    inference.simulate(x, [0.0, 1.0], 10, None, model=model)
    t = time.perf_counter()
    for _ in range(reps):
        inference.simulate(x, [0.0, 1.0], 10, None, model=model)
    return (time.perf_counter() - t) / reps


def evaluate(model, split="tune"):
    """model: MonsoonNet (any device; scored on a CPU copy, the way serve.py runs it). Returns a flat metrics dict."""
    import copy
    m = copy.deepcopy(model).cpu().eval()
    wins, n_ev = windows(split)
    call = lambda init, sc, pert: _timed(m, init, sc, pert)
    r = LG.grade(call, verbose=False, wins=wins, shock_bases=n_ev)
    sh = [x for _, x in r["shocks"]]
    out = {"total": r["model_pts"] if r["gate"] else 0.0, "gate": r["gate"], "mean_ss": r["forecast"]["mean_ss"],
           "csi_skill": r["forecast"]["mean_csi_skill"], "fc_pts": r["forecast"]["points"], "blur_pts": r["blur_pts"],
           "caus_pts": r["caus_pts"], "blur": [round(float(v), 2) for v in r["blur_ratios"]],
           "null_ok": r["null_ok"], "null_dev": r["null_dev"], "cpu_s": cpu_call_seconds(m), "n_windows": len(wins)}
    for c in CHECKS:
        out["p_" + c] = float(np.mean([s[c] for s in sh]))
    out["key"] = (out["total"], out["mean_ss"] + out["csi_skill"])       # selection: total, then raw skill margin
    return out


def _timed(m, init, sc, pert):
    t = time.perf_counter()
    try:
        return inference.simulate(init, sc, LG.STEPS, pert, model=m), time.perf_counter() - t, ""
    except Exception as e:
        return None, time.perf_counter() - t, f"{type(e).__name__}: {e}"


def fmt(name, r):
    b = "/".join(f"{v:.2f}" for v in r["blur"])
    pr = " ".join(f"{r['p_' + c]:.2f}" for c in CHECKS)
    return (f"| {name} | {r['total']:.2f} | {r['mean_ss']:+.4f} | {r['csi_skill']:+.4f} | {r['blur_pts']:.2f} | {b} | "
            f"{r['caus_pts']:.2f} | {pr} | {'yes' if r['null_ok'] else 'NO'} ({r['null_dev']:.1e}) | {r['cpu_s']:.2f} |")


HEADER = ("| variant | total /70 | mean SS | CSI skill | blur pts | day-8 var ratio t2m/tp/u10/v10/msl/tcwv | caus pts | "
          "pass rate nonzero/local/propag/stable | null exact (max dev, std) | CPU s/call |\n|" + "---|" * 10)
