import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GlobeEngine } from './engine/globe.js';
import { api, prepGeo, toFrame, addDelta, diffFrame, shockSpec, LAYERS, TILES, TILE_KEY, KEY_TILE, TIMES, SCENS, CVARS, DOM, fmtSigned } from './data.js';

const RAD = Math.PI / 180;
const fmt = (x, d) => Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const chip = on => ({ border: '1px solid ' + (on ? 'rgba(127,216,190,0.6)' : 'rgba(159,194,182,0.25)'), background: on ? 'rgba(127,216,190,0.16)' : 'rgba(255,255,255,0.03)' });
const btn = { minHeight: 36, borderRadius: 10, color: '#E7F2EE', fontSize: 12, cursor: 'pointer' };
const GW_VAR = { t2m: ['t2m', '°C', 1], tp: ['tp', 'mm/day', 1], ws: ['ws', 'm/s', 1], msl: ['msl', 'hPa', 0.01], tcwv: ['tcwv', 'kg/m²', 1] };
const VAR_NAME = { t2m: 'temperature', tp: 'rain', ws: 'wind speed', msl: 'pressure', tcwv: 'moisture' };
const THR_TXT = t => t ? `≥ ${t.t2m} °C, ${t.tp} mm/day, ${t.ws} m/s, ${t.msl / 100} hPa or ${t.tcwv} kg/m²` : '';
/** Bilinear value of a flat north-first 32x36 grid at (lat, lon). */
function gridAt(a, la, lo) {
  let gy = 37.5 - la, gx = lo - 65.5; gy = Math.max(0, Math.min(31, gy)); gx = Math.max(0, Math.min(35, gx));
  const y0 = Math.floor(gy), x0 = Math.floor(gx), y1 = Math.min(31, y0 + 1), x1 = Math.min(35, x0 + 1), fy = gy - y0, fx = gx - x0, v = (r, c) => a[r * 36 + c];
  return (v(y0, x0) * (1 - fx) + v(y0, x1) * fx) * (1 - fy) + (v(y1, x0) * (1 - fx) + v(y1, x1) * fx) * fy;
}
const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export default function App() {
  const canvasRef = useRef(null), eng = useRef(null);
  const [G, setG] = useState(null), [presets, setPresets] = useState([]), [pid, setPid] = useState(null);
  const [prime, setPrime] = useState(null), [primeMs, setPrimeMs] = useState(null), [health, setHealth] = useState(null), [err, setErr] = useState('');
  const [on, setOn] = useState({ terrain: true, elev: false, borders: true, lights: true, heat: true, rain: false, wind: false, pressure: false, moisture: false });
  const [focus, setFocus] = useState('heat'), [time, setTime] = useState('live'), [clock, setClock] = useState(''), [day, setDay] = useState(0);
  const [showPins, setShowPins] = useState(true), [showCells, setShowCells] = useState(false), [hov, setHov] = useState(null);
  const [uni, setUni] = useState('prime'), [view, setView] = useState('diff'), [panel, setPanel] = useState(null), [playing, setPlaying] = useState(false);
  const [scen, setScen] = useState('heatwave'), [cvar, setCvar] = useState('t2m'), [camt, setCamt] = useState(4), [crad, setCrad] = useState(3);
  const [center, setCenter] = useState(null), [placing, setPlacing] = useState(false), [warn, setWarn] = useState([]);
  const [branch, setBranch] = useState(null), [running, setRunning] = useState(false);

  // ---- engine + static data ----
  useEffect(() => {
    const e = eng.current = new GlobeEngine(canvasRef.current, { onClock: setClock, onHover: setHov, onPlace: (la, lo) => { setCenter([la, lo]); setPlacing(false); } });
    window.__globe = e;                                      // handle for the browser tests (frontend/tests)
    api.geography().then(g => { const pg = prepGeo(g); setG(pg); e.setGeo(pg); }).catch(x => setErr('Gateway geography: ' + x.message));
    api.presets().then(p => { setPresets(p); setPid((p.find(x => x.id === 'heavy-rain') || p[0]).id); }).catch(x => setErr('Gateway not reachable at ' + (import.meta.env.VITE_GATEWAY || 'http://127.0.0.1:8100') + ': ' + x.message));
    const ph = () => api.health().then(setHealth).catch(() => setHealth(null)); ph(); const hi = setInterval(ph, 10000);
    return () => { clearInterval(hi); e.dispose(); };
  }, []);
  // ---- preset -> Prime (live /run with no shock) ----
  useEffect(() => {
    if (!pid) return; setPrime(null); setBranch(null); setUni('prime'); setDay(0); setPanel(null);
    Promise.all([api.preset(pid), api.run(pid, null)]).then(([p, r]) => {
      const frames = [toFrame(p.init_states[2]), ...r.prime.map(toFrame)];
      setPrime({ frames, meta: p }); setPrimeMs(r.timing.server_ms_prime);
    }).catch(x => setErr('Prime run failed: ' + x.message));
  }, [pid]);

  const mode = uni === 'prime' || !branch ? 'prime' : view;
  const frame = useMemo(() => {
    if (!prime) return null; const p = prime.frames[day]; if (mode === 'prime') return p;
    const b = branch.frames[day]; if (!b) return null; return mode === 'branch' ? b : diffFrame(p, b);
  }, [prime, branch, day, mode]);
  const flow = !prime ? null : (mode === 'prime' ? prime.frames[day] : (branch.frames[day] || prime.frames[day]));
  useEffect(() => { eng.current && eng.current.setLayers(on); }, [on]);
  useEffect(() => { eng.current && eng.current.setView({ frame, flow, mode, showCells, showPins }); }, [frame, flow, mode, showCells, showPins]);
  useEffect(() => { eng.current && eng.current.setTime(time); }, [time]);
  useEffect(() => { eng.current && eng.current.setPlacing(placing); }, [placing]);
  const sc = SCENS.find(s => s.id === scen), cv = CVARS.find(c => c.id === cvar), isC = scen === 'custom';
  const mcenter = sc.judge ? sc.center : center;
  useEffect(() => { eng.current && eng.current.setMarker({ show: (placing || panel === 'build' || panel === 'outcome' || uni === 'b') && !!mcenter, center: mcenter, crad: sc.judge ? 5 : crad }); }, [placing, panel, uni, mcenter, crad, sc]);
  // live shock preview: size in std units and warnings, straight from the gateway
  useEffect(() => {
    if (panel !== 'build' || !pid || (!sc.judge && !center)) { setWarn([]); return; }
    const t = setTimeout(() => api.preview(pid, shockSpec(scen, cvar, camt, crad, center)).then(r => setWarn(r.shock.warnings)).catch(x => setWarn([x.message])), 250);
    return () => clearTimeout(t);
  }, [panel, pid, scen, cvar, camt, crad, center]);
  // play
  useEffect(() => { if (!playing) return; const t = setInterval(() => setDay(d => { if (d >= 10) { setPlaying(false); return d; } return d + 1; }), 1100); return () => clearInterval(t); }, [playing]);

  const regionName = (la, lo) => { if (!G || !eng.current) return ''; const id = eng.current.regionAt(la, lo); return id > 0 ? G.names[id] : 'over the sea'; };
  const where = sc.judge ? (scen === 'judge_warm' ? 'Judge test box · Bay of Bengal (8–20°N, 82–94°E)' : 'Judge test box · Arabian Sea (8–20°N, 65–75°E)')
    : center ? 'Dropped at ' + center[0].toFixed(1) + '°N ' + center[1].toFixed(1) + '°E · ' + regionName(center[0], center[1]) : '';
  const amtFmt = isC ? (v => fmtSigned(v, cv.unit)) : sc.fmt;

  async function runBranch() {
    if (!prime || (!sc.judge && !center)) return;
    const spec = shockSpec(scen, cvar, camt, crad, center); setRunning(true); setErr('');
    try {
      const pv = await api.preview(pid, spec);
      const frames = [addDelta(prime.frames[0], pv.perturbation)], outcome = [pv.outcome_day0];
      const name = sc.judge ? (scen === 'judge_warm' ? 'Earth-B · warm Bay' : 'Earth-B · Arabian stall') : 'Earth-B · ' + sc.name.toLowerCase();
      const key = isC ? cv.key : sc.key, tile = KEY_TILE[key];
      const b = { frames, outcome, name, info: pv.shock, thr: pv.thresholds, title: sc.judge ? sc.name.replace('Judge:', 'Judge test:') : sc.name + ' · ' + amtFmt(camt), where, ms: null };
      setBranch({ ...b }); setUni('b'); setView('diff'); setPanel('outcome'); setPlacing(false); setDay(0);
      setOn(o => ({ ...o, [tile]: true })); setFocus(tile);
      const done = await api.stream(pid, spec, m => { if (m.type === 'day') { b.frames[m.day] = toFrame(m.branch); b.outcome[m.day] = m.outcome; setBranch({ ...b, frames: [...b.frames], outcome: [...b.outcome] }); } });
      setBranch({ ...b, frames: [...b.frames], outcome: [...b.outcome], ms: done.timing.server_ms_branch, impacts: done.impacts });
    } catch (x) { setErr('Shock run failed: ' + x.message); } finally { setRunning(false); }
  }

  // ---- big readout ----
  const FT = TILES.find(t => t.id === focus), L = LAYERS.find(l => l.id === ((FT && FT.w && on[focus]) ? FT.w : 'terrain'));
  let ghost = { big: '—', label: L.label, unit: L.unit, where: err || 'Loading the globe…', row: [] }, tip = null;
  if (G && frame) {
    const dvm = mode === 'diff', sgn = (x, d) => (dvm && x > 0 ? '+' : '') + fmt(x, d);
    if (hov) {
      const ns = hov.la >= 0 ? hov.la.toFixed(2) + '°N' : (-hov.la).toFixed(2) + '°S', ew = hov.lo >= 0 ? hov.lo.toFixed(2) + '°E' : (-hov.lo).toFixed(2) + '°W';
      if (hov.inDom) {
        const name = hov.id > 0 ? G.names[hov.id] : 'Sea', el = Math.round(hov.elev), elTxt = el > 0 ? fmt(el, 0) + ' m above sea level' : (el < 0 ? fmt(-el, 0) + ' m below sea level' : 'At sea level');
        tip = { x: hov.px, y: hov.py, region: name.replace('Sea / outside', 'Sea').toUpperCase(), ll: ns + '  ' + ew, elev: elTxt };
        const g = k => gridAt(frame[k], hov.la, hov.lo);
        ghost = { big: L.key ? sgn(g(L.key), L.dec) : fmt(el, 0), label: (dvm && L.key ? 'Δ ' : '') + L.label, unit: L.key ? L.unit : (el >= 0 ? 'm above sea level' : 'm below sea level'),
          where: (mode === 'prime' ? '' : (dvm ? 'EARTH-B MINUS PRIME · ' : 'EARTH-B · ')) + tip.region + ' · ' + ns + ' ' + ew,
          row: [{ k: 'ELEVATION', v: fmt(el, 0), u: 'm' }, { k: (dvm ? 'Δ ' : '') + 'RAIN', v: sgn(g('tp'), 1), u: 'mm/day' }, { k: (dvm ? 'Δ ' : '') + 'TEMP', v: sgn(g('t2m'), 1), u: '°C' },
            { k: (dvm ? 'Δ ' : '') + 'WIND', v: sgn(g('ws'), 1), u: 'm/s' }, { k: (dvm ? 'Δ ' : '') + 'PRESSURE', v: sgn(g('msl'), dvm ? 1 : 0), u: 'hPa' }, { k: (dvm ? 'Δ ' : '') + 'MOISTURE', v: sgn(g('tcwv'), 0), u: 'kg/m²' }] };
      } else { tip = { x: hov.px, y: hov.py, region: 'OUTSIDE THE STUDY AREA', ll: ns + '  ' + ew, elev: 'No model data here' }; ghost = { big: '—', label: L.label, unit: '', where: 'OUTSIDE THE STUDY AREA · ' + ns + ' ' + ew, row: [] }; }
    } else {
      const A = k => Array.from(frame[k]), mx = k => Math.max(...A(k)), mn = k => Math.min(...A(k));
      const pick = { tp: [dvm ? 'BIGGEST RAIN CHANGE' : 'PEAK RAINFALL', mx('tp'), 0], t2m: [dvm ? 'BIGGEST WARMING' : 'HOTTEST CELL', mx('t2m'), 1], ws: [dvm ? 'BIGGEST WIND CHANGE' : 'STRONGEST WIND', mx('ws'), 1],
        msl: [dvm ? 'BIGGEST PRESSURE DROP' : 'DEEPEST LOW', mn('msl'), dvm ? 1 : 0], tcwv: [dvm ? 'BIGGEST MOISTENING' : 'MOST MOIST', mx('tcwv'), 0] };
      const st = L.key ? pick[L.id] : ['HIGHEST POINT', G.elev ? Math.max(...G.elev.z) : 0, 0];
      ghost = { big: sgn(st[1], st[2]), label: st[0], unit: L.key ? L.unit : 'm', where: 'DRAG TO ORBIT · SCROLL TO ZOOM · SHIFT-DRAG TO ROLL · SUN, MOON & PLANETS IN REAL DIRECTIONS (SIZES EXAGGERATED)', row: [] };
    }
  }
  const focusName = (FT && FT.w && on[focus]) ? FT.name : 'Elevation';
  const pickTile = t => { const o = !!on[t.id], n = { ...on, [t.id]: !o }; let f = focus; if (t.w && !o) f = t.id; else if (t.w && o && focus === t.id) { const nx = TILES.find(x => x.w && n[x.id]); f = nx ? nx.id : 'terrain'; } setOn(n); setFocus(f); };

  // ---- outcome panel ----
  let oc = null;
  if (panel === 'outcome' && branch) {
    const o = branch.outcome[day];
    const peakDay = branch.outcome.reduce((b, x, k) => (x && x.reach_km > (branch.outcome[b] ? branch.outcome[b].reach_km : -1) ? k : b), 0);
    const firstZero = branch.outcome.findIndex((x, k) => k > 0 && x && x.cells === 0 && branch.outcome.slice(0, k).some(y => y && y.cells > 0));
    if (o) {
      const gv = o.main_variable ? GW_VAR[o.main_variable] : null, peak = gv ? o.peak_change * gv[2] : 0;
      const states = (o.top_states || []).map(s => ({ name: s.state, m: s.mean_change * (gv ? gv[2] : 1), n: s.cells }));
      const mxs = Math.max(1e-6, ...states.map(s => Math.abs(s.m)));
      oc = { dayLabel: day === 0 ? 'THE MOMENT IT HITS' : 'DAY +' + day, spread: fmt(Math.round(o.reach_km), 0), area: fmt(Math.round(o.affected_area_kkm2), 0),
        peak: (peak > 0 ? '+' : '') + peak.toFixed(1), peakUnit: gv ? 'peak Δ ' + VAR_NAME[o.main_variable] + ' ' + gv[1] : (firstZero > 0 && day >= firstZero ? 'shock faded by day +' + firstZero : 'below thresholds'),
        metric: gv ? ('Δ ' + VAR_NAME[o.main_variable] + ' ' + gv[1]).toUpperCase() : '', states: states.map(s => ({ ...s, w: Math.round(100 * Math.abs(s.m) / mxs), v: (s.m > 0 ? '+' : '') + s.m.toFixed(2) })),
        none: o.cells > 0 ? (states.length ? '' : 'Only sea cells are affected on this day.')
          : (firstZero > 0 && day >= firstZero ? `Shock faded by day +${firstZero}: every change is now below the thresholds (${THR_TXT(branch.thr)}).`
            : `No cell changes by ${THR_TXT(branch.thr)} on this day.`),
        faded: o.cells === 0 && firstZero > 0 && day >= firstZero,
        peakDay: peakDay === 0 ? 'at the start' : 'day +' + peakDay };
    } else oc = { dayLabel: 'DAY +' + day, spread: '…', area: '…', peak: '…', peakUnit: 'model running', metric: '', states: [], none: 'Waiting for the model…', peakDay: '…' };
  }
  const caption = !prime ? 'Loading Prime from the model…' : uni === 'prime'
    ? (day === 0 ? 'Prime · start state · ' + prime.meta.last_input_day : 'Prime · day +' + day + ' · model forecast for ' + addDays(prime.meta.first_forecast_day, day - 1))
    : branch.name + ' · day +' + day + (branch.frames[day] ? ' · model forecast' : ' · running…');
  const ready = health && health.inference_server && health.inference_server.ready;
  const unis = [{ id: 'prime', name: 'Timeline Prime' }].concat(branch ? [{ id: 'b', name: branch.name }] : []);

  return (
    <div style={{ position: 'relative', height: '100vh', minHeight: 680, overflow: 'hidden', background: '#02050A' }}>
      <canvas ref={canvasRef} aria-label="Interactive 3D Earth centred on India with the Sun, Moon and planets in their real directions. Drag to orbit, scroll to zoom, shift-drag or right-drag to roll."
        role="img" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }} />
      {tip && <div style={{ position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(18px,18px)', pointerEvents: 'none', minWidth: 200, padding: '10px 12px', borderRadius: 12, background: 'rgba(5,16,20,0.8)', border: '1px solid rgba(127,216,190,0.3)', backdropFilter: 'blur(10px)', display: 'flex', flexDirection: 'column', gap: 4, zIndex: 3 }}>
        <span className="fred" style={{ fontWeight: 600, fontSize: 14, letterSpacing: '0.05em', color: '#F2FBF7' }}>{tip.region}</span>
        <span className="mono" style={{ fontSize: 12, color: '#BFD9D0' }}>{tip.ll}</span>
        <span className="mono" style={{ fontSize: 12, color: '#9FE3CF' }}>{tip.elev}</span></div>}
      {placing && <div role="status" style={{ position: 'absolute', left: '50%', top: 84, transform: 'translateX(-50%)', zIndex: 4, pointerEvents: 'none', padding: '10px 16px', borderRadius: 999, background: 'rgba(233,215,138,0.16)', border: '1px solid rgba(233,215,138,0.7)', color: '#F5EBC0', fontSize: 13 }}>Click anywhere in the study area (6–38°N, 65–101°E) to drop the shock · the ring shows its size</div>}

      {panel === 'build' && <section aria-label="Create a shock" className="panel">
        <div><h2 className="fred" style={{ margin: 0, fontWeight: 600, fontSize: 18, color: '#F5EBC0' }}>Create a shock</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: '#BFD9D0' }}>Pick what happens, drop it anywhere on the map, and watch how far it spreads over 10 days compared with Timeline Prime.</p></div>
        <span className="cap">1 · WHAT HAPPENS</span>
        <div role="group" aria-label="Shock type" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 4 }}>
          {SCENS.map(x => <button key={x.id} type="button" aria-pressed={x.id === scen} onClick={() => { setScen(x.id); if (!x.judge && x.id !== 'custom') setCamt(x.def); if (x.id === 'custom') setCamt(cv.def); }}
            style={{ ...btn, minHeight: 44, padding: '2px 4px', lineHeight: 1.2, ...chip(x.id === scen), ...(x.judge ? { borderStyle: 'dashed' } : {}) }}>{x.name}</button>)}
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>{sc.text}</p>
        {isC && <div role="group" aria-label="Variable to change" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 4 }}>
          {CVARS.map(c => <button key={c.id} type="button" aria-pressed={c.id === cvar} onClick={() => { setCvar(c.id); setCamt(c.def); }} style={{ ...btn, fontSize: 11, ...chip(c.id === cvar) }}>{c.name}</button>)}</div>}
        {!sc.judge && <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#BFD9D0' }}>Strength: <span className="mono" style={{ color: '#F5EBC0' }}>{amtFmt(camt)}</span>
            <input type="range" min={isC ? cv.min : sc.min} max={isC ? cv.max : sc.max} step={isC ? cv.step : sc.step} value={camt} onChange={e => setCamt(Number(e.target.value))} style={{ accentColor: '#E9D78A' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#BFD9D0' }}>Size: <span className="mono" style={{ color: '#F5EBC0' }}>{'about ' + Math.round(crad * 1.25 * 110) + ' km across the core'}</span>
            <input type="range" min="1" max="8" step="1" value={crad} onChange={e => setCrad(Number(e.target.value))} style={{ accentColor: '#E9D78A' }} /></label>
          <span className="cap">2 · WHERE</span>
          <button type="button" aria-pressed={placing} onClick={() => setPlacing(!placing)} style={{ minHeight: 44, borderRadius: 10, border: '1px solid rgba(233,215,138,0.7)', background: 'rgba(233,215,138,0.14)', color: '#F5EBC0', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {placing ? 'Click the globe to drop it…' : (where || 'Drop it on the map')}</button>
        </>}
        {sc.judge && <p className="mono" style={{ margin: 0, fontSize: 12, color: '#F5EBC0' }}>{where}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[['Judge test · warm Bay of Bengal', 'judge_warm'], ['Judge test · Arabian Sea stall', 'judge_stall']].map(([n, id]) =>
            <button key={id} type="button" onClick={() => { setScen(id); setPlacing(false); }} style={{ minHeight: 36, padding: '0 10px', borderRadius: 999, border: '1px solid rgba(159,194,182,0.35)', background: 'transparent', color: '#BFD9D0', fontSize: 11, cursor: 'pointer' }}>{n}</button>)}
        </div>
        {warn.map((w, i) => <p key={i} style={{ margin: 0, fontSize: 11, color: '#F2B26B' }}>⚠ {w}</p>)}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => { setPanel(null); setPlacing(false); }} style={{ ...btn, minHeight: 40, padding: '0 14px', border: '1px solid rgba(159,194,182,0.35)', background: 'transparent', color: '#BFD9D0', fontSize: 13 }}>Cancel</button>
          <button type="button" onClick={runBranch} disabled={running || !prime || (!sc.judge && !center)} style={{ ...btn, minHeight: 40, padding: '0 16px', border: '1px solid rgba(233,215,138,0.8)', background: 'rgba(233,215,138,0.2)', color: '#F5EBC0', fontSize: 13, fontWeight: 600, opacity: running || !prime || (!sc.judge && !center) ? 0.45 : 1 }}>{running ? 'Running…' : 'Run the shock'}</button>
        </div>
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: '#9FC2B6' }}>Runs live: the gateway builds the shock and the model server rolls Prime and Earth-B forward 10 days.</p>
      </section>}

      {oc && <section aria-label="Shock outcome" className="panel" style={{ width: 340 }}>
        <div><span className="cap" style={{ color: '#E9D78A' }}>OUTCOME · {oc.dayLabel}</span>
          <h2 className="fred" style={{ margin: '4px 0 0', fontWeight: 600, fontSize: 18, color: '#F5EBC0' }}>{branch.title}</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#BFD9D0' }}>{branch.where}</p></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8 }}>
          {[[oc.spread, 'km reached'], [oc.area, 'thousand km² affected'], [oc.peak, oc.peakUnit]].map(([v, k], i) =>
            <div key={i}><div className="fred" style={{ fontWeight: 500, fontSize: 24 }}>{v}</div><div style={{ fontSize: 11, color: '#9FC2B6' }}>{k}</div></div>)}
        </div>
        <span className="cap">MOST AFFECTED STATES · {oc.metric}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {oc.states.map(st => <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ flex: 1 }}>{st.name}</span>
            <span style={{ width: 90, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: st.w + '%', background: st.m > 0 ? '#D7A48C' : '#8FB3C9' }} /></span>
            <span className="mono" style={{ width: 64, textAlign: 'right', color: '#F5EBC0' }}>{st.v}</span></div>)}
          <span style={{ fontSize: 12, color: '#9FC2B6' }}>{oc.none}</span>
        </div>
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: '#9FC2B6' }}>Use the timeline below to watch it spread day by day. Furthest reach: {oc.peakDay}.{branch.ms ? ' Model time ' + branch.ms.toFixed(0) + ' ms.' : ''}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => setPanel('build')} style={{ ...btn, minHeight: 40, padding: '0 14px', border: '1px solid rgba(233,215,138,0.7)', background: 'rgba(233,215,138,0.12)', color: '#F5EBC0', fontSize: 13 }}>New shock</button>
          <button type="button" onClick={() => setPanel(null)} style={{ ...btn, minHeight: 40, padding: '0 14px', border: '1px solid rgba(159,194,182,0.35)', background: 'transparent', color: '#BFD9D0', fontSize: 13 }}>Close</button>
        </div>
      </section>}

      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', flexDirection: 'column', zIndex: 2 }}>
        <header style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 24px', padding: '16px 24px', background: 'linear-gradient(rgba(2,5,10,0.9), rgba(2,5,10,0))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><circle cx="13" cy="13" r="11.5" stroke="#7FD8BE" strokeWidth="1.4" /><ellipse cx="13" cy="13" rx="5" ry="11.5" stroke="#7FD8BE" strokeOpacity="0.55" /><path d="M2 13h22" stroke="#7FD8BE" strokeOpacity="0.55" /></svg>
            <div><div className="fred" style={{ fontWeight: 600, fontSize: 16, letterSpacing: '0.16em', color: '#F2FBF7' }}>MONSOON DIGITAL TWIN</div>
              <div style={{ fontSize: 11, letterSpacing: '0.12em', color: '#9FC2B6' }}>INDIA STUDY AREA · 6–38°N · 65–101°E</div></div>
          </div>
          <nav aria-label="Universes" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {unis.map(u => <button key={u.id} type="button" aria-pressed={uni === u.id} onClick={() => setUni(u.id)} style={{ ...btn, minHeight: 40, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 600, ...chip(uni === u.id) }}>{u.name}</button>)}
            {branch && panel !== 'outcome' && <button type="button" onClick={() => setPanel('outcome')} style={{ ...btn, minHeight: 40, padding: '0 14px', borderRadius: 999, border: '1px solid rgba(233,215,138,0.6)', background: 'rgba(233,215,138,0.1)', color: '#F5EBC0', fontSize: 13 }}>Outcome</button>}
            <button type="button" onClick={() => setPanel('build')} style={{ ...btn, minHeight: 40, padding: '0 16px', borderRadius: 999, border: '1px dashed rgba(159,194,182,0.55)', background: 'transparent', color: '#BFD9D0', fontSize: 13 }}>+ Branch a universe</button>
          </nav>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#BFD9D0', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Start
              <select value={pid || ''} onChange={e => setPid(e.target.value)} aria-label="Start state" style={{ background: 'rgba(5,16,20,0.8)', color: '#E7F2EE', border: '1px solid rgba(127,216,190,0.3)', borderRadius: 8, padding: '4px 6px', fontSize: 12 }}>
                {presets.map(p => <option key={p.id} value={p.id}>{p.name} · {p.last_input_day}</option>)}</select></label>
            <span className="mono" style={{ color: '#E7F2EE' }}>{clock}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: ready ? '#7FD8BE' : '#E07A4F', boxShadow: '0 0 10px ' + (ready ? '#7FD8BE' : '#E07A4F') }} />{ready ? 'Engine ready' : 'Engine offline'}</span>
            <span className="mono" style={{ color: '#9FC2B6' }}>10-day rollout · {primeMs ? primeMs.toFixed(0) + ' ms' : '…'}</span>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'space-between', gap: 24, padding: '4px 24px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16, maxWidth: 'min(560px, 48vw)', minWidth: 0 }}>
            <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <span className="fred" style={{ fontWeight: 500, fontSize: 'clamp(72px, 9vw, 150px)', lineHeight: 0.9, letterSpacing: '-0.02em', color: 'rgba(231,242,238,0.5)', textShadow: '0 2px 24px rgba(0,0,0,0.5)' }}>{ghost.big}</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 10 }}>
                  <span className="fred" style={{ fontWeight: 600, fontSize: 18, letterSpacing: '0.14em', color: '#F2FBF7' }}>{ghost.label}</span>
                  <span className="fred" style={{ fontWeight: 400, fontSize: 'clamp(22px, 2.4vw, 36px)', color: 'rgba(231,242,238,0.55)' }}>{ghost.unit}</span></div>
              </div>
              <span className="mono" style={{ fontSize: 12, letterSpacing: '0.08em', color: err ? '#F2B26B' : '#BFD9D0' }}>{ghost.where}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', marginTop: 10 }}>
                {ghost.row.map(g => <div key={g.k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 10, letterSpacing: '0.18em', color: '#9FC2B6' }}>{g.k}</span>
                  <span className="fred" style={{ fontWeight: 500, fontSize: 'clamp(22px, 2.2vw, 32px)', lineHeight: 1, color: 'rgba(231,242,238,0.68)' }}>{g.v}<span style={{ fontSize: '0.48em', fontWeight: 400, marginLeft: 4, color: 'rgba(231,242,238,0.55)' }}>{g.u}</span></span></div>)}
              </div>
            </div>

            <section aria-label="Layers and view" className="glass" style={{ pointerEvents: 'auto', width: 300, maxWidth: '100%', padding: 12, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cap">MAP LAYERS · TURN ON ANY COMBINATION</span>
              <div role="group" aria-label="Map layers" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
                {TILES.map(t => { const o = !!on[t.id]; return <button key={t.id} type="button" aria-pressed={o} onClick={() => pickTile(t)} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4, borderRadius: 10, border: '2px solid ' + (o ? 'rgba(127,216,190,0.85)' : 'rgba(159,194,182,0.18)'), background: 'rgba(255,255,255,0.03)', color: '#E7F2EE', cursor: 'pointer', textAlign: 'left' }}>
                  <span aria-hidden="true" style={{ display: 'block', height: 38, borderRadius: 7, background: t.thumb, opacity: o ? 1 : 0.45 }} />
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, fontSize: 11, padding: '0 2px' }}><span>{t.name}</span><span style={{ color: '#7FD8BE' }}>{o ? 'ON' : ''}</span></span></button>; })}
              </div>
              <span style={{ fontSize: 11, lineHeight: 1.45, color: '#9FC2B6' }}>Big readout follows: <span style={{ color: '#E7F2EE' }}>{focusName}</span> · the last weather layer you turned on.</span>
              {uni === 'b' && branch && <>
                <span className="cap" style={{ color: '#E9D78A', marginTop: 4 }}>EARTH-B SHOWS</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 4 }}>
                  {[['diff', 'Difference'], ['branch', 'Full field']].map(([id, n]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} style={{ ...btn, ...chip(view === id) }}>{n}</button>)}</div></>}
              <span className="cap" style={{ marginTop: 4 }}>TIME OVER INDIA (IST)</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 4 }}>
                {TIMES.map(m => <button key={m.id} type="button" aria-pressed={time === m.id} onClick={() => setTime(m.id)} style={{ ...btn, ...chip(time === m.id) }}>{m.name}</button>)}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 2 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, fontSize: 12, color: '#BFD9D0', cursor: 'pointer' }}><input type="checkbox" checked={showPins} onChange={() => setShowPins(!showPins)} style={{ width: 16, height: 16, accentColor: '#7FD8BE' }} />Test-shock pins</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, fontSize: 12, color: '#BFD9D0', cursor: 'pointer' }}><input type="checkbox" checked={showCells} onChange={() => setShowCells(!showCells)} style={{ width: 16, height: 16, accentColor: '#7FD8BE' }} />Model cells (1°)</label>
              </div>
            </section>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
            <div role="group" aria-label="Globe view" className="glass" style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: 6, borderRadius: 14 }}>
              {[['Zoom in', '+', () => eng.current.zoomIn(), 22], ['Zoom out', '−', () => eng.current.zoomOut(), 22], ['Turn north up', 'N↑', () => eng.current.northUp(), 12]].map(([l, t, f, fs]) =>
                <button key={l} type="button" aria-label={l} onClick={f} style={{ width: 44, height: 44, borderRadius: 10, border: 'none', background: 'rgba(127,216,190,0.1)', color: '#E7F2EE', fontSize: fs, fontWeight: fs === 12 ? 600 : 400, cursor: 'pointer' }}>{t}</button>)}
              <button type="button" aria-label="Reset view to India" onClick={() => eng.current.resetView()} style={{ width: 44, height: 44, borderRadius: 10, border: 'none', background: 'rgba(127,216,190,0.1)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 9a6 6 0 1 0 2-4.5" stroke="#E7F2EE" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 2.5V5h2.5" stroke="#E7F2EE" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
            </div>
          </div>
        </div>

        <div className="glass" style={{ pointerEvents: 'auto', alignSelf: 'center', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 999, maxWidth: 'calc(100% - 48px)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" aria-label={playing ? 'Pause the 10-day rollout' : 'Play the 10-day rollout'} onClick={() => { if (!playing && day >= 10) setDay(0); setPlaying(!playing); }}
            style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid rgba(127,216,190,0.6)', background: 'rgba(127,216,190,0.14)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {playing ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 2.5v9M10 2.5v9" stroke="#E7F2EE" strokeWidth="1.8" strokeLinecap="round" /></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 2v10l8.5-5z" stroke="#E7F2EE" strokeWidth="1.4" strokeLinejoin="round" /></svg>}</button>
          <div role="group" aria-label="Forecast day" style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {Array.from({ length: 11 }, (_, k) => <button key={k} type="button" aria-pressed={k === day} onClick={() => setDay(k)} className="mono"
              style={{ minWidth: 44, minHeight: 40, borderRadius: 999, border: 'none', background: k === day ? 'rgba(127,216,190,0.22)' : 'transparent', color: k === day ? '#F2FBF7' : '#BFD9D0', fontSize: 12, cursor: 'pointer' }}>{k === 0 ? 'Now' : '+' + k}</button>)}
          </div>
          <span style={{ fontSize: 12, color: '#9FC2B6', padding: '0 8px' }}>{caption}</span>
        </div>
      </div>
    </div>
  );
}
