"""Equirectangular textures for the 3D globe: day (earthy relief), elevation, borders, night lights, India-domain crops."""
import json, numpy as np, xarray as xr, shapefile
from PIL import Image, ImageDraw
from scipy import ndimage
from global_land_mask import globe
OUT = '/home/claude/monsoon-design/build/'
TW, TH = 8192, 4096
topo = xr.open_dataset('/tmp/geo/topo.nc')['topography'].values.astype(np.float32)   # lat -90..90
d = 1 / 6

# relief shading on the topo grid (light from NW), compressed so plains AND Himalaya both read
zc = np.sign(topo) * np.abs(topo) ** 0.7 * 9.0
zc = ndimage.gaussian_filter(zc, 0.6)
gy, gx = np.gradient(zc)
glat = np.linspace(-90, 90, topo.shape[0])[:, None]
dy = d * 111000.0; dx = dy * np.maximum(np.cos(np.radians(glat)), 0.05)
sx, sy = gx / dx, gy / dy
az, alt = np.radians(315), np.radians(40)
lx, ly, lz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
hs = (-sx * lx - sy * ly + lz) / np.sqrt(sx ** 2 + sy ** 2 + 1)

def ramp(stops, v):
    xs = np.array([s[0] for s in stops], float); cols = np.array([[int(s[1][i:i+2], 16) for i in (1, 3, 5)] for s in stops], float)
    return np.stack([np.interp(v, xs, cols[:, k]) for k in range(3)], -1)
LAND = [(0, '#3A6A45'), (150, '#4C7D4B'), (500, '#668C55'), (1000, '#83995F'), (2000, '#9FA27D'), (3500, '#BEBFAE'), (5000, '#E6EBEA'), (6500, '#F6F8F8')]
SEA = [(-8000, '#061A2E'), (-4500, '#0A2A45'), (-2000, '#11395A'), (-500, '#18506F'), (-120, '#22677F'), (0, '#3A8C97')]

day = np.zeros((TH, TW, 3), np.uint8); elev = np.zeros((TH // 2, TW // 2), np.uint8); landm = np.zeros((TH, TW), bool)
lons = (np.arange(TW) + 0.5) / TW * 360 - 180
for r0 in range(0, TH, 256):
    lat = 90 - (np.arange(r0, r0 + 256) + 0.5) / TH * 180
    LA, LO = np.meshgrid(lat, lons, indexing='ij')
    ti, tj = (LA + 90) / d, (LO + 180) / d
    z = ndimage.map_coordinates(topo, [ti, tj], order=1, mode='nearest')
    h = ndimage.map_coordinates(hs, [ti, tj], order=3, mode='nearest')
    land = globe.is_land(np.clip(LA, -89.99, 89.99), LO); landm[r0:r0 + 256] = land
    ls = ndimage.gaussian_filter(land.astype(np.float32), 0.7)
    lc = ramp(LAND, np.maximum(z, 0)) * np.clip(0.35 + 0.8 * h, 0.5, 1.3)[..., None]
    sc = ramp(SEA, np.minimum(z, 0)) * np.clip(0.9 + 0.15 * h, 0.8, 1.05)[..., None]
    col = lc * ls[..., None] + sc * (1 - ls[..., None])
    edge = np.clip(1 - np.abs(ls - 0.5) * 2.6, 0, 1)[..., None]
    col = col * (1 - 0.3 * edge) + np.array([160, 215, 205]) * 0.3 * edge
    day[r0:r0 + 256] = np.clip(col, 0, 255).astype(np.uint8)
Image.fromarray(day).save(OUT + 'tex_day.jpg', quality=84, optimize=True)

# elevation (land only, 0..8000 m -> 0..255), half resolution is plenty for 10' data
lat = 90 - (np.arange(TH // 2) + 0.5) / (TH // 2) * 180; lon2 = (np.arange(TW // 2) + 0.5) / (TW // 2) * 360 - 180
LA, LO = np.meshgrid(lat, lon2, indexing='ij')
z = ndimage.map_coordinates(topo, [(LA + 90) / d, (LO + 180) / d], order=1, mode='nearest')
lm2 = landm[::2, ::2]
elev = (np.clip(z, 0, 8000) / 8000 * 255 * lm2).astype(np.uint8)
Image.fromarray(elev).save(OUT + 'tex_elev.png', optimize=True)

# borders (supersampled 2x for anti-aliasing), coast segments removed
B = 2; bl = Image.new('LA', (TW * B, TH * B), (0, 0)); dr = ImageDraw.Draw(bl)
def ring(pts, a, w):
    pts = np.asarray(pts, float); x = (pts[:, 0] + 180) / 360 * TW * B; y = (90 - pts[:, 1]) / 180 * TH * B
    seg = [(x[0], y[0])]
    for i in range(1, len(pts)):
        if abs(x[i] - x[i - 1]) > TW * B / 2:
            if len(seg) > 1: dr.line(seg, fill=(255, a), width=w)
            seg = []
        seg.append((x[i], y[i]))
    if len(seg) > 1: dr.line(seg, fill=(255, a), width=w)
gj = json.load(open('/tmp/geo/countries_ind.geojson'))
near = ('Pakistan', 'Nepal', 'Bhutan', 'Bangladesh', 'Myanmar', 'Sri Lanka', 'China', 'Afghanistan')
for f in gj['features']:
    n = f['properties']['NAME']; g = f['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    a, w = (250, 4) if n == 'India' else ((175, 3) if n in near else (80, 2))
    for p in polys:
        for rg in p: ring(rg, a, w)
sr = shapefile.Reader('/tmp/geo/Admin2')
for shp in sr.shapes():
    pts = np.asarray(shp.points); parts = list(shp.parts) + [len(pts)]
    for a0, b0 in zip(parts[:-1], parts[1:]):
        rg = pts[a0:b0]
        if len(rg) > 6: rg = rg[::2]
        ring(rg, 120, 2)
bl = bl.resize((TW, TH), Image.LANCZOS)
ba = np.asarray(bl).copy()
inland = ndimage.binary_erosion(landm, iterations=2)
ba[..., 1] = (ba[..., 1] * inland).astype(np.uint8)
Image.fromarray(ba, 'LA').save(OUT + 'tex_borders.png', optimize=True)

# night lights: Black Marble-derived 4096x2048, boosted and warmed
nl = np.asarray(Image.open('/tmp/geo/earth-night.jpg').convert('L')).astype(np.float32) / 255
nl = np.clip((nl - 0.06) / 0.94, 0, 1) ** 1.1
Image.fromarray((nl * 255).astype(np.uint8)).save(OUT + 'tex_lights.png', optimize=True)

# India study-domain crops for the weather + emboss shells
def crop(img, w, h, lon0=65, lon1=101, lat0=6, lat1=38):
    x0, x1 = int((lon0 + 180) / 360 * w), int((lon1 + 180) / 360 * w); y0, y1 = int((90 - lat1) / 180 * h), int((90 - lat0) / 180 * h)
    return img[y0:y1, x0:x1]
Image.fromarray(crop(day, TW, TH)).save(OUT + 'dom_day.jpg', quality=88)
Image.fromarray(crop(elev, TW // 2, TH // 2)).save(OUT + 'dom_elev.png')
print('ok')
