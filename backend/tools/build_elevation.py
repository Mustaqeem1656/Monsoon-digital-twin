"""Build backend/gateway/static/elevation.json: ETOPO1 10-arcmin land height + sea depth over the model domain.
  python backend/tools/build_elevation.py <earth-topography-10arcmin.nc>
Source: ETOPO1 via fatiando-data (github.com/fatiando-data/earth-topography-10arcmin). Fixed geography, not weather.
Grid: cell centres from 6 to 38 N and 65 to 101 E every 1/6 deg, rows SOUTH to NORTH, metres (int16, base64).
"""
from __future__ import annotations
import base64, json, sys
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "backend" / "gateway" / "static" / "elevation.json"
RES = 1 / 6


def main(src):
    t = xr.open_dataset(src)["topography"]
    lat = np.arange(6 + RES / 2, 38, RES); lon = np.arange(65 + RES / 2, 101, RES)
    z = t.interp(latitude=lat, longitude=lon).values.round().astype("<i2")
    meta = {"lat0": 6.0, "lon0": 65.0, "res": RES, "rows": len(lat), "cols": len(lon), "row_order": "south_to_north",
            "units": "m", "dtype": "int16", "b64": base64.b64encode(z.tobytes()).decode("ascii"),
            "source": "ETOPO1 10-arcmin via fatiando-data (earth-topography-10arcmin)"}
    OUT.write_text(json.dumps(meta, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB), {z.shape}, min {z.min()} max {z.max()} m")


if __name__ == "__main__":
    main(sys.argv[1])
