"""One-off data exploration (laptop only; needs matplotlib, which is NOT used at judging).
  python tools/explore.py   -> prints stats, writes PNGs to tools/plots/
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from monsoon_r1 import contract as C, scoring as S   # noqa: E402
from eval.baselines import load_data, load_std      # noqa: E402

OUT = ROOT / "tools" / "plots"; OUT.mkdir(parents=True, exist_ok=True)
data, dates, static = load_data(); std = load_std()
ext = [C.LON[0] - .5, C.LON[-1] + .5, C.LAT[0] - .5, C.LAT[-1] + .5]
UNITS = ["K", "mm/day", "m/s", "m/s", "Pa", "kg/m2"]

print(f"{len(dates)} days {dates[0]} .. {dates[-1]}\n\nper-channel ranges:")
for c, name in enumerate(C.CHANNELS):
    x = data[:, c]
    print(f"  {name:5s} min {x.min():10.2f}  p1 {np.percentile(x, 1):10.2f}  mean {x.mean():10.2f}  "
          f"p99 {np.percentile(x, 99):10.2f}  max {x.max():10.2f} {UNITS[c]}")
tp = data[:, 1]
print(f"\nrain cells > {S.RAIN_THRESH:g} mm/day: {100 * (tp > S.RAIN_THRESH).mean():.2f}% of all cell-days")

print("\npersistence RMSE (lat-weighted, in std units):")
print("  lead  " + " ".join(f"{n:>6s}" for n in C.CHANNELS))
for lead in (1, 4, 8):
    r = S.rmse_lat(data[:-lead], data[lead:]) / std
    print(f"  day{lead}  " + " ".join(f"{v:6.3f}" for v in r))

# 1. static fields
fig, ax = plt.subplots(1, 2, figsize=(10, 4.5))
for a, k, t, cm in ((ax[0], 1, "orography (m)", "terrain"), (ax[1], 0, "land-sea mask", "Greens")):
    im = a.imshow(static[k], origin="lower", extent=ext, cmap=cm); a.set_title(t); fig.colorbar(im, ax=a, shrink=.8)
fig.tight_layout(); fig.savefig(OUT / "static.png", dpi=110); plt.close(fig)

# 2. seasonal mean rain
m = np.array([d.month for d in dates])
jjas, djf = tp[np.isin(m, [6, 7, 8, 9])].mean(0), tp[np.isin(m, [12, 1, 2])].mean(0)
vmax = float(jjas.max())
fig, ax = plt.subplots(1, 2, figsize=(10, 4.5))
for a, f, t in ((ax[0], jjas, "Jun-Sep mean rain"), (ax[1], djf, "Dec-Feb mean rain")):
    im = a.imshow(f, origin="lower", extent=ext, cmap="Blues", vmin=0, vmax=vmax); a.set_title(t + " (mm/day)")
    fig.colorbar(im, ax=a, shrink=.8)
fig.tight_layout(); fig.savefig(OUT / "rain_seasons.png", dpi=110); plt.close(fig)

# 3. one July day, all 6 channels (mid-July of the last training year)
i = next(k for k, d in enumerate(dates) if d.year == 2018 and d.month == 7 and d.day == 15)
cmaps = ["inferno", "Blues", "RdBu_r", "RdBu_r", "viridis", "YlGnBu"]
fig, ax = plt.subplots(2, 3, figsize=(14, 8))
for c, a in enumerate(ax.flat):
    f = data[i, c]
    kw = {"vmin": -abs(f).max(), "vmax": abs(f).max()} if c in (2, 3) else {}
    im = a.imshow(f, origin="lower", extent=ext, cmap=cmaps[c], **kw)
    a.set_title(f"{C.CHANNELS[c]} ({UNITS[c]})"); fig.colorbar(im, ax=a, shrink=.8)
fig.suptitle(f"All channels on {dates[i]}"); fig.tight_layout(); fig.savefig(OUT / "july_day.png", dpi=110); plt.close(fig)
print(f"\nplots written to {OUT}")
