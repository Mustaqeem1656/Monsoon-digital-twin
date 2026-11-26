"""Build gateway/static/regions.json: a 0.05 deg region raster (Indian states + neighbouring countries) as compact RLE.
  python backend/tools/build_geography.py <download_dir>
<download_dir> must hold DataMeet `states.geojson` (github.com/datameet/maps) and the Natural Earth India point-of-view
admin-0 shapefile `ne/ne_10m_admin_0_countries_ind.*` (naturalearthdata.com). Laptop only (needs matplotlib + pyshp).
Codes: 0 = sea / outside, 1..N = Indian states (DataMeet), then neighbouring countries (Natural Earth, India POV).
"""
from __future__ import annotations
import json, sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MPath

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "backend" / "gateway" / "static" / "regions.json"
LAT0, LON0, RES, NR, NCOL = 6.0, 65.0, 0.05, 640, 720        # covers the model grid 6..38 N, 65..101 E exactly
NEIGHBOURS = ["Pakistan", "China", "Nepal", "Bhutan", "Bangladesh", "Myanmar", "Sri Lanka", "Afghanistan", "India"]
FIX = {"Arunanchal Pradesh": "Arunachal Pradesh", "Andaman & Nicobar Island": "Andaman & Nicobar Islands",
       "Dadara & Nagar Havelli": "Dadra & Nagar Haveli"}


def rings_of(geom_type, coords):
    polys = [coords] if geom_type == "Polygon" else coords
    for poly in polys:
        for k, ring in enumerate(poly):
            yield np.asarray(ring, float)[:, :2], k > 0            # (ring, is_hole)


def paint(grid, rings, code, lon, lat):
    """Even-odd fill of all rings of one region (holes flip back), bbox-limited for speed."""
    mask = np.zeros_like(grid, bool)
    for ring, _ in rings:
        x0, y0 = ring.min(0); x1, y1 = ring.max(0)
        j0, j1 = max(int((x0 - LON0) / RES), 0), min(int((x1 - LON0) / RES) + 1, NCOL)
        i0, i1 = max(int((y0 - LAT0) / RES), 0), min(int((y1 - LAT0) / RES) + 1, NR)
        if j0 >= j1 or i0 >= i1:
            continue
        pts = np.column_stack([lon[i0:i1, j0:j1].ravel(), lat[i0:i1, j0:j1].ravel()])
        inside = MPath(ring).contains_points(pts).reshape(i1 - i0, j1 - j0)
        mask[i0:i1, j0:j1] ^= inside
    grid[mask & (grid == 0)] = code


def main(src: Path):
    import shapefile
    lat = LAT0 + RES * (np.arange(NR) + 0.5); lon = LON0 + RES * (np.arange(NCOL) + 0.5)
    lon, lat = np.meshgrid(lon, lat)
    grid = np.zeros((NR, NCOL), np.int16); names = {0: "Sea / outside"}
    gj = json.loads((src / "states.geojson").read_text(encoding="utf-8"))
    for code, f in enumerate(sorted(gj["features"], key=lambda f: f["properties"]["ST_NM"]), start=1):
        nm = FIX.get(f["properties"]["ST_NM"], f["properties"]["ST_NM"]); names[code] = nm
        g = f["geometry"]; paint(grid, list(rings_of(g["type"], g["coordinates"])), code, lon, lat)
    n_states = len(gj["features"])
    r = shapefile.Reader(str(src / "ne" / "ne_10m_admin_0_countries_ind"))
    fld = [x[0] for x in r.fields[1:]]; ni = fld.index("NAME")
    for sr in r.shapeRecords():
        nm = sr.record[ni]
        if nm not in NEIGHBOURS:
            continue
        code = n_states + 1 + NEIGHBOURS.index(nm); names[code] = nm if nm != "India" else "India (unassigned)"
        geo = sr.shape.__geo_interface__
        paint(grid, list(rings_of(geo["type"], geo["coordinates"])), code, lon, lat)
    flat = grid.ravel(); change = np.flatnonzero(np.diff(flat)) + 1
    starts = np.r_[0, change]; lens = np.diff(np.r_[starts, flat.size])
    rle = np.column_stack([flat[starts], lens]).ravel().tolist()
    meta = {"lat0": LAT0, "lon0": LON0, "res": RES, "nrows": NR, "ncols": NCOL, "row_order": "south_to_north",
            "indian_state_codes": list(range(1, n_states + 1)), "names": {str(k): v for k, v in names.items()},
            "rle": rle, "sources": ["DataMeet India state boundaries (github.com/datameet/maps), CC BY 4.0",
                                    "Natural Earth admin-0 countries, India point of view (naturalearthdata.com), public domain"]}
    OUT.parent.mkdir(parents=True, exist_ok=True); OUT.write_text(json.dumps(meta, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e3:.0f} kB, {len(rle) // 2} runs, {len(names)} regions)")
    vals, cnt = np.unique(grid, return_counts=True)
    for v, c in zip(vals, cnt):
        if c < 400: print(f"  small region: {names.get(int(v))} ({c} px)")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
