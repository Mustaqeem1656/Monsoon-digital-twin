"""Ensemble confidence for the impact tiles. Every member is a LIVE /simulate call (through app.run_model).

Members = the real start window plus a small, smooth, seeded random nudge (same nudge on all 3 input days):
  t2m, u10, v10, msl, tcwv: + noise_std_frac x channel std x z     tp: x (1 + noise_std_frac x z), kept >= 0
  z = Gaussian white noise smoothed with a Gaussian of `smooth_cells` cells, rescaled to unit std; seed = seed + member.
So the ensemble is deterministic (same request -> same members -> same confidence).

The inference server answers one call at a time (~0.2 s each), so the gateway budget is 16 calls (< 5 s):
  plain forecast:   16 members, each one rollout          -> confidence = share of members with the same LEVEL
  with a change:     8 members, each rolled out without AND with the change (16 calls) -> each member has its own
                     delta; confidence = share of members whose delta has the same DIRECTION (up / down / none),
                     plus the share with the same with-change level.
"""
from __future__ import annotations
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy.ndimage import gaussian_filter

from backend.gateway import geo, impact


def nudged_inits(init: np.ndarray, n: int, cfg: dict) -> list[np.ndarray]:
    out = []
    for m in range(n):
        rng = np.random.default_rng(int(cfg["seed"]) + m)
        z = np.stack([gaussian_filter(rng.standard_normal((geo.NLAT, geo.NLON)), cfg["smooth_cells"], mode="nearest")
                      for _ in range(6)])
        z /= z.std(axis=(1, 2), keepdims=True) + 1e-9
        a = cfg["noise_std_frac"]; x = init.copy()
        for c in (0, 2, 3, 4, 5):
            x[:, c] += a * geo.STD[c] * z[c]
        x[:, 1] = np.maximum(x[:, 1] * (1 + a * z[1]), 0.0)
        out.append(x.astype("f4"))
    return out


def _direction(tid, d):
    return "none" if abs(d) < impact.NO_CHANGE[tid] else ("up" if d > 0 else "down")


def confidence(run_model, init, doy_sincos, steps, pert, has_change: bool, central: list[dict], doys, start_doy, months,
               cfg: dict) -> dict:
    t0 = time.perf_counter()
    n = cfg["pairs_with_change"] if has_change else cfg["members_plain"]
    inits = nudged_inits(init, n, cfg)
    jobs = [(x, None) for x in inits] + ([(x, pert) for x in inits] if has_change else [])
    with ThreadPoolExecutor(len(jobs)) as pool:
        res = list(pool.map(lambda j: run_model(j[0], doy_sincos, steps, j[1])[0], jobs))
    prim = res[:n]; bran = res[n:] if has_change else prim
    stats = []
    for m in range(n):
        ps = impact.scalar_tiles(np.concatenate([inits[m][-1][None], prim[m]]), doys, start_doy, months)
        bs = ps if not has_change else impact.scalar_tiles(np.concatenate([(inits[m][-1] + pert)[None], bran[m]]),
                                                          doys, start_doy, months)
        stats.append((ps, bs))
    conf = {}
    for t in central:
        if not t["active"]:
            continue
        tid = t["id"]
        lv = [s[1][tid][1] for s in stats]
        same_level = sum(x == t["branch"]["level"] for x in lv)
        c = {"members": n, "same_level": same_level, "same_level_pct": round(100.0 * same_level / n),
             "member_values": [round(s[1][tid][0], 1) for s in stats]}
        if has_change:
            dirs = [_direction(tid, s[1][tid][0] - s[0][tid][0]) for s in stats]
            agree = sum(d == t["direction"] for d in dirs)
            c.update(same_direction=agree, same_direction_pct=round(100.0 * agree / n))
        conf[tid] = c
    return {"by_tile": conf, "members": n, "calls": len(jobs), "seconds": round(time.perf_counter() - t0, 2),
            "mode": "paired" if has_change else "plain"}
