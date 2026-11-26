"""Reference forecasts the judge compares us against, plus a shared data loader.

- persistence: tomorrow (and every later day) looks exactly like the last day we saw.
- climatology: each day looks like the long-term average for that calendar day, computed from TRAINING years only
  (2005-2018) using the kit's own monsoon_r1.stats.climatology (15-day smoothed calendar-day mean).

Both have the same signature as serve.simulate, so the local grader can score them like any model.
"""
from __future__ import annotations
import datetime as dt
import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from monsoon_r1 import stats as KS

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("MONSOON_DATA", ROOT / "data"))   # override, e.g. to share one copy across worktrees
DATA_NC = DATA_DIR / "india_climate_train.nc"
TRAIN_YEARS = range(2005, 2019)
VAL_YEARS = range(2019, 2022)
REF_YEAR = 2001                      # a non-leap year, used only to turn day-of-year into a month/day
CACHE_DIR = ROOT / "cache"          # git-ignored: every .npy/.npz cache goes here, NEVER elsewhere in the repo


@lru_cache(maxsize=1)
def load_data():
    """-> data [N,6,32,36] float32 (physical units), dates list[datetime.date], static [2,32,36] (lsm, orography m)."""
    import xarray as xr
    ds = xr.open_dataset(DATA_NC)
    data = ds["data"].values.astype("f4")
    dates = [dt.date(t.year, t.month, t.day) for t in ds["time"].to_index()]
    static = ds["static"].values.astype("f4")
    ds.close()
    return data, dates, static


def load_std() -> np.ndarray:
    return np.array(json.loads((DATA_DIR / "stats.json").read_text())["std"], "f4")


def _yyyymmdd(d: dt.date) -> int:
    return d.year * 10000 + d.month * 100 + d.day


@lru_cache(maxsize=1)
def train_climatology() -> np.ndarray:
    """[366,6,32,36] calendar-day climatology from the training years only."""
    f = CACHE_DIR / "train_climatology.npy"
    if f.exists():
        return np.load(f)
    data, dates, _ = load_data()
    idx = [i for i, d in enumerate(dates) if d.year in TRAIN_YEARS]
    clim = KS.climatology(data[idx], np.array([_yyyymmdd(dates[i]) for i in idx]))
    CACHE_DIR.mkdir(exist_ok=True); np.save(f, clim)
    return clim


def doy_from_sincos(doy_sincos) -> int:
    """Invert monsoon_r1.contract.doy_sincos (angle = 2*pi*doy/365) back to an integer day of year 1..365."""
    s, c = float(doy_sincos[0]), float(doy_sincos[1])
    doy = int(round((np.arctan2(s, c) % (2 * np.pi)) * 365.0 / (2 * np.pi)))
    return 365 if doy == 0 else doy


def persistence(init_states, doy_sincos, steps, perturbation):
    last = np.asarray(init_states[-1], "f4").copy()
    if perturbation is not None:
        last = last + perturbation
    return np.repeat(last[None], steps, axis=0)


def climatology(init_states, doy_sincos, steps, perturbation):
    """Climatology for the `steps` days after the last input day. Ignores the shock (climatology has no memory)."""
    clim = train_climatology()
    doy = doy_from_sincos(doy_sincos)
    base = dt.date(REF_YEAR, 1, 1) + dt.timedelta(days=doy - 1)    # any non-leap reference year
    return np.stack([KS.clim_for(clim, base + dt.timedelta(days=k + 1)) for k in range(steps)]).astype("f4")
