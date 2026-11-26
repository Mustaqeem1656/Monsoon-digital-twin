"""One-time: extra STATIC (time-invariant geography) fields for the model, bundled next to the weights.

    <venv with zarr+gcsfs>/python backend/tools/build_static_extra.py
Reads the same ERA5 archive and the same half_degree regrid the team kit uses (imported from monsoon_r1, not
re-implemented), plus distance-to-coast derived from the kit's land_sea_mask. Writes backend/weights/static_extra.npz
([8,32,36] float32, z-scored per field). These are geography constants (no dates, no weather), ~40 KB.
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ["standard_deviation_of_orography", "slope_of_sub_gridscale_orography", "high_vegetation_cover",
          "low_vegetation_cover", "soil_type", "lake_cover"]
NAMES = ["sdor", "slor", "cvh", "cvl", "soil_type", "lake_cover", "coast_dist"]


def coast_distance(lsm: np.ndarray) -> np.ndarray:
    """Signed distance (grid cells, 1 cell = 1 deg) to the nearest coast: + over land, - over sea."""
    land = lsm >= 0.5
    yy, xx = np.mgrid[:lsm.shape[0], :lsm.shape[1]]
    pts = np.stack([yy.ravel(), xx.ravel()], 1).astype("f4")
    def dist_to(mask):                                          # distance from every cell to the nearest cell in mask
        q = pts[mask.ravel()]
        return np.sqrt(((pts[:, None] - q[None]) ** 2).sum(-1)).min(1).reshape(lsm.shape)
    return (np.where(land, dist_to(~land), 0) - np.where(~land, dist_to(land), 0)).astype("f4")


def main() -> int:
    from monsoon_r1 import build_dataset as K                   # the kit's archive address + regrid
    g = K._open(K.WB2); lat_i = K.INT_LAT + 90; lon_i = K.INT_LON % 360
    out = []
    for f in FIELDS:
        a = np.asarray(g[f][lon_i[0]:lon_i[-1] + 1, lat_i[0]:lat_i[-1] + 1], dtype="f4")
        out.append(K.half_degree(a.T)); print(f, float(out[-1].min()), float(out[-1].max()))
    lsm = np.clip(K.half_degree(np.asarray(g["land_sea_mask"][lon_i[0]:lon_i[-1] + 1, lat_i[0]:lat_i[-1] + 1], "f4").T), 0, 1)
    out.append(coast_distance(lsm))
    raw = np.stack(out).astype("f4")
    mu, sd = raw.mean((1, 2), keepdims=True), raw.std((1, 2), keepdims=True)
    z = ((raw - mu) / np.where(sd > 1e-6, sd, 1)).astype("f4")
    dst = ROOT / "backend" / "weights" / "static_extra.npz"
    np.savez(dst, fields=z, names=np.array(NAMES[:len(out)]), lsm=lsm.astype("f4"))
    print("wrote", dst, z.shape); return 0


if __name__ == "__main__":
    sys.exit(main())
