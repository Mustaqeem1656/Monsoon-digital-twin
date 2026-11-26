// Shared constants, the gateway client, and conversions from gateway arrays to the dashboard's flat grids.
// Flat grids are Float32Array(32*36) indexed r*36+c with r = 0 at the NORTH (lat 37.5), as in the mockup painters.
// Display units: t2m in degC, msl in hPa (gateway sends K and Pa).

export const GATEWAY = (import.meta.env.VITE_GATEWAY || 'http://127.0.0.1:8100').replace(/\/$/, '');
export const DOM = { lat0: 6, lat1: 38, lon0: 65, lon1: 101 };
export const NLAT = 32, NLON = 36, NCELL = NLAT * NLON;
export const CH = ['t2m', 'tp', 'u', 'v', 'msl', 'tcwv'];

export const TEMPP = ['#3B6FB6', '#6FA8D6', '#BFE3C8', '#F1E29A', '#F2B26B', '#E07A4F', '#B9473A'];
export const RAINP = ['#BFE6F2', '#7CC3E6', '#3E8FD6', '#3557C2', '#5B3FB3', '#9B4FC4'];
export const HEAT = ['#F3E6B8', '#EBC67E', '#DDA066', '#C97B57', '#A8574A', '#7E3F3B'];
export const DIV = ['#4A7896', '#9DBBCB', '#EFEAE0', '#D7A48C', '#A8574A'];

export const LAYERS = [
  { id: 'terrain', name: 'Terrain', unit: 'm', label: 'ELEVATION' },
  { id: 'tp', name: 'Rain', unit: 'mm/day', label: 'RAINFALL', key: 'tp', lo: 0, hi: 60, dec: 0, stops: RAINP },
  { id: 't2m', name: 'Temp', unit: '°C', label: 'AIR TEMPERATURE', key: 't2m', lo: -5, hi: 42, dec: 1, stops: TEMPP },
  { id: 'ws', name: 'Wind', unit: 'm/s', label: 'WIND SPEED', key: 'ws', lo: 0, hi: 10, dec: 1, stops: HEAT },
  { id: 'msl', name: 'Pressure', unit: 'hPa', label: 'SEA-LEVEL PRESSURE', key: 'msl', lo: 995, hi: 1015, dec: 0, stops: HEAT },
  { id: 'tcwv', name: 'Moisture', unit: 'kg/m²', label: 'WATER VAPOUR', key: 'tcwv', lo: 5, hi: 70, dec: 0, stops: HEAT },
];

export const TILES = [
  { id: 'terrain', name: 'Terrain', thumb: 'linear-gradient(135deg,#2F5A3B 0%,#6F8B55 45%,#BDB9A4 75%,#EEF1F2 100%)' },
  { id: 'elev', name: 'Elevation', thumb: 'repeating-linear-gradient(160deg,#2E6B4F 0 6px,#9DAA62 6px 7px,#C9B26B 7px 13px,#B07A4F 13px 14px)' },
  { id: 'borders', name: 'Borders', thumb: 'linear-gradient(115deg,#0B2C48 0 46%,#6BE6FF 46% 50%,#2F5A3B 50% 72%,#FFD66B 72% 75%,#3A6A45 75%)' },
  { id: 'heat', name: 'Heat', w: 't2m', thumb: 'linear-gradient(90deg,#3B6FB6,#BFE3C8,#F1E29A,#E07A4F,#B9473A)' },
  { id: 'rain', name: 'Rain', w: 'tp', thumb: 'radial-gradient(circle at 30% 40%,#5B3FB3 0 12%,#3E8FD6 22%,transparent 42%),radial-gradient(circle at 72% 65%,#3557C2 0 10%,#7CC3E6 26%,transparent 44%),#1A3346' },
  { id: 'wind', name: 'Wind', w: 'ws', thumb: 'repeating-linear-gradient(170deg,#0E2230 0 5px,#CFEFE6 5px 6px,#0E2230 6px 11px)' },
  { id: 'pressure', name: 'Pressure', w: 'msl', thumb: 'repeating-radial-gradient(circle at 40% 55%,#12303F 0 6px,#E7F2EE 6px 7px)' },
  { id: 'moisture', name: 'Moisture', w: 'tcwv', thumb: 'radial-gradient(circle at 50% 50%,#E6FBFF 0 18%,#8FD6E6 38%,#10303F 70%)' },
  { id: 'lights', name: 'City lights', thumb: 'radial-gradient(circle at 25% 40%,#FFD27A 0 4%,transparent 9%),radial-gradient(circle at 60% 30%,#FFC25A 0 3%,transparent 8%),radial-gradient(circle at 70% 70%,#FFD27A 0 5%,transparent 11%),radial-gradient(circle at 40% 75%,#FFB347 0 3%,transparent 8%),#05090F' },
];
export const TILE_KEY = { heat: 't2m', rain: 'tp', wind: 'ws', pressure: 'msl', moisture: 'tcwv' };
export const KEY_TILE = { t2m: 'heat', tp: 'rain', ws: 'wind', msl: 'pressure', tcwv: 'moisture', u: 'wind', v: 'wind' };
export const TIMES = [{ id: 'live', name: 'Live' }, { id: 'noon', name: 'Noon', h: 12, m: 0 }, { id: 'dusk', name: 'Dusk', h: 18, m: 30 }, { id: 'night', name: 'Night', h: 0, m: 30 }];

// The 9 gateway shock types. `toSpec` turns the slider values into the gateway's {type, strength, radius, ...}.
// Radius: gateway sigma = radius/2 cells; the mockup's core is crad/1.6 cells, so radius = crad * 1.25.
export const SCENS = [
  { id: 'heatwave', name: 'Heatwave', key: 't2m', min: 1, max: 8, step: 0.5, def: 4, fmt: v => '+' + v + ' °C', strength: v => v / 4,
    text: 'Hot air over land: 2 m temperature up. Watch the heat spread with the winds.' },
  { id: 'warm_sea', name: 'Warm sea', key: 't2m', min: 1, max: 6, step: 0.5, def: 3, fmt: v => '+' + v + ' °C', strength: v => v / 3,
    text: 'A marine heatwave: warmer air and more moisture over water, which can feed rain downwind.' },
  { id: 'cyclone', name: 'Cyclone', key: 'tp', min: 4, max: 30, step: 2, def: 14, fmt: v => '−' + v + ' hPa', strength: v => v / 15,
    text: 'Seeds a low-pressure system with spinning winds, extra moisture and rain. Best dropped over the sea.' },
  { id: 'monsoon_stall', name: 'Monsoon stall', key: 'ws', min: 10, max: 80, step: 5, def: 40, fmt: v => '−' + v + ' % wind', strength: v => v / 40,
    text: 'Weakens the winds that carry the monsoon inland.' },
  { id: 'rain_burst', name: 'Rain burst', key: 'tp', min: 10, max: 120, step: 10, def: 60, fmt: v => '+' + v + ' mm/day', strength: v => v / 60,
    text: 'A burst of heavy rain with a surge of moist air.' },
  { id: 'dry_spell', name: 'Dry spell', key: 'tp', min: 10, max: 60, step: 5, def: 20, fmt: v => '−' + v + ' % moisture', strength: v => v / 20,
    text: 'Dry air moves in: rain removed, less moisture, more crop stress.' },
  { id: 'custom', name: 'Custom', key: 't2m', text: 'Change one variable directly. This is what judges may do live.' },
  { id: 'judge_warm', name: 'Judge: warm Bay', key: 't2m', judge: true, center: [14, 88],
    text: "The judge's warm_ocean test, exactly: +3 K and +15% moisture over the Bay of Bengal box (8–20°N, 82–94°E)." },
  { id: 'judge_stall', name: 'Judge: Arabian stall', key: 'ws', judge: true, center: [14, 70],
    text: "The judge's monsoon_stall test, exactly: −40% wind over the Arabian Sea box (8–20°N, 65–75°E)." },
];
export const CVARS = [
  { id: 't2m', name: 'Temp', key: 't2m', unit: '°C', min: -6, max: 6, step: 0.5, def: 2.5, toAmount: v => v },
  { id: 'tp', name: 'Rain', key: 'tp', unit: 'mm/day', min: -40, max: 80, step: 5, def: 30, toAmount: v => v },
  { id: 'u10', name: 'East wind', key: 'ws', unit: 'm/s', min: -8, max: 8, step: 0.5, def: -3, toAmount: v => v },
  { id: 'v10', name: 'North wind', key: 'ws', unit: 'm/s', min: -8, max: 8, step: 0.5, def: 3, toAmount: v => v },
  { id: 'msl', name: 'Pressure', key: 'msl', unit: 'hPa', min: -15, max: 15, step: 1, def: -6, toAmount: v => v * 100 },
  { id: 'tcwv', name: 'Moisture', key: 'tcwv', unit: 'kg/m²', min: -20, max: 20, step: 1, def: 8, toAmount: v => v },
];
export const fmtSigned = (v, u) => (v > 0 ? '+' : '') + v + ' ' + u;

export function shockSpec(scen, cvar, amt, crad, center) {
  const sc = SCENS.find(s => s.id === scen);
  if (sc.judge) return { type: scen };
  const base = { lat: center[0], lon: center[1], radius: crad * 1.25 };
  if (scen === 'custom') { const cv = CVARS.find(c => c.id === cvar); return { type: 'custom', variable: cv.id, amount: cv.toAmount(amt), strength: 1, ...base }; }
  return { type: scen, strength: sc.strength(amt), ...base };
}

// ---- gateway -----------------------------------------------------------------------------------------------
async function req(path, body) {
  const r = await fetch(GATEWAY + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(js.detail || ('HTTP ' + r.status));
  return js;
}
export const api = {
  health: () => req('/health'),
  presets: () => req('/presets'),
  preset: id => req('/presets/' + encodeURIComponent(id)),
  geography: () => req('/geography'),
  shocks: () => req('/shocks'),
  preview: (preset_id, shock) => req('/shock/preview', { preset_id, shock }),
  run: (preset_id, shock, steps = 10) => req('/run', { preset_id, shock, steps }),
  stream(preset_id, shock, onMsg, steps = 10) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(GATEWAY.replace(/^http/, 'ws') + '/stream');
      ws.onopen = () => ws.send(JSON.stringify({ preset_id, shock, steps }));
      ws.onmessage = e => { const m = JSON.parse(e.data); onMsg(m); if (m.type === 'done') { ws.close(); resolve(m); } if (m.type === 'error') { ws.close(); reject(new Error(m.detail)); } };
      ws.onerror = () => reject(new Error('stream connection failed'));
    });
  },
};

// ---- conversions ---------------------------------------------------------------------------------------------
/** One state [6][32][36] (south->north, physical) -> {t2m degC, tp, u, v, msl hPa, tcwv, ws} flat north-first. */
export function toFrame(state) {
  const f = {}; CH.forEach(k => (f[k] = new Float32Array(NCELL)));
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) {
    const o = (NLAT - 1 - i) * NLON + j;
    f.t2m[o] = state[0][i][j] - 273.15; f.tp[o] = state[1][i][j]; f.u[o] = state[2][i][j]; f.v[o] = state[3][i][j];
    f.msl[o] = state[4][i][j] / 100; f.tcwv[o] = state[5][i][j];
  }
  f.ws = f.u.map((u, i) => Math.hypot(u, f.v[i]));
  return f;
}
/** Physical delta [6][32][36] -> frame of display-unit deltas (wind speed delta needs the base frame). */
export function addDelta(base, delta) {
  const f = {}; CH.forEach(k => (f[k] = new Float32Array(NCELL)));
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) {
    const o = (NLAT - 1 - i) * NLON + j;
    f.t2m[o] = base.t2m[o] + delta[0][i][j]; f.tp[o] = Math.max(0, base.tp[o] + delta[1][i][j]);
    f.u[o] = base.u[o] + delta[2][i][j]; f.v[o] = base.v[o] + delta[3][i][j];
    f.msl[o] = base.msl[o] + delta[4][i][j] / 100; f.tcwv[o] = Math.max(0, base.tcwv[o] + delta[5][i][j]);
  }
  f.ws = f.u.map((u, i) => Math.hypot(u, f.v[i]));
  return f;
}
export function diffFrame(a, b) { const f = {}; Object.keys(a).forEach(k => (f[k] = b[k].map((x, i) => x - a[k][i]))); return f; }

/** Decode the gateway's geography into north-first rasters for the painters. */
export function prepGeo(g) {
  const R = g.regions, rows = R.nrows, cols = R.ncols, south = new Uint16Array(rows * cols);
  let p = 0; for (let k = 0; k < R.rle.length; k += 2) { south.fill(R.rle[k], p, p + R.rle[k + 1]); p += R.rle[k + 1]; }
  const reg = new Uint16Array(rows * cols);
  for (let r = 0; r < rows; r++) reg.set(south.subarray((rows - 1 - r) * cols, (rows - r) * cols), r * cols);
  const names = {}; Object.entries(R.names).forEach(([k, v]) => (names[+k] = v));
  const indian = new Set(R.indian_state_codes);
  const unassigned = +Object.keys(names).find(k => names[k] === 'India (unassigned)');
  const E = g.elevation; let elev = null;
  if (E) {
    const bin = atob(E.b64), buf = new Int16Array(E.rows * E.cols), dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    for (let i = 0; i < buf.length; i++) buf[i] = dv.getInt16(2 * i, true);
    const z = new Float32Array(E.rows * E.cols);                                  // flip to north-first
    for (let r = 0; r < E.rows; r++) for (let c = 0; c < E.cols; c++) z[r * E.cols + c] = buf[(E.rows - 1 - r) * E.cols + c];
    elev = { res: E.res, rows: E.rows, cols: E.cols, z };
  }
  return { reg, rows, cols, res: R.res, names, indian, unassigned, elev, std: g.grid.std, lsm: g.land_sea_mask };
}
