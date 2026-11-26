import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GlobeEngine } from './engine/globe.js';
import { api, prepGeo, toFrame, addDelta, diffFrame, LAYERS, TILES, TIMES, SHOCKS, CVARS, EVENT_TILES, shockSpec, eventSpec, fmtSigned, cloudNormal, cloudProxy } from './data.js';

const RAD = Math.PI / 180;
const fmt = (x, d) => Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (x, d) => (x > 0 ? '+' : '') + fmt(x, d);
const chip = (on, acc) => ({ border: '1px solid ' + (on ? 'var(--accent-edge)' : 'var(--card-border)'), background: on ? 'var(--accent-soft)' : 'var(--card-bg)' });
const btn = { minHeight: 36, borderRadius: 10, color: 'var(--text)', fontSize: 12, cursor: 'pointer' };
const primary = { border: 'none', background: 'var(--accent)', color: '#FFFFFF' };              // flat primary button
const TEAL = '121,135,110', AMBER = '121,135,110';   // accents now come from the tokens (sage)
const VAR = { t2m: ['temperature', '°C', 1], tp: ['rain', 'mm/day', 1], ws: ['wind speed', 'm/s', 1], msl: ['pressure', 'hPa', 0.01], tcwv: ['moisture', 'kg/m²', 1] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const nice = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return d + ' ' + MONTHS[m - 1] + ' ' + y; };
const inDomain = (la, lo) => la >= 6 && la <= 38 && lo >= 65 && lo <= 101;

/** Bilinear value of a flat north-first 32x36 grid at (lat, lon). */
function gridAt(a, la, lo) {
  let gy = 37.5 - la, gx = lo - 65.5; gy = Math.max(0, Math.min(31, gy)); gx = Math.max(0, Math.min(35, gx));
  const y0 = Math.floor(gy), x0 = Math.floor(gx), y1 = Math.min(31, y0 + 1), x1 = Math.min(35, x0 + 1), fy = gy - y0, fx = gx - x0, v = (r, c) => a[r * 36 + c];
  return (v(y0, x0) * (1 - fx) + v(y0, x1) * fx) * (1 - fy) + (v(y1, x0) * (1 - fx) + v(y1, x1) * fx) * fy;
}
/** The six core parameters: at a point, and averaged over the affected cells (area-weighted). */
function sixAt(fr, la, lo, elev) { return { elev, tp: gridAt(fr.tp, la, lo), t2m: gridAt(fr.t2m, la, lo), ws: gridAt(fr.ws, la, lo), msl: gridAt(fr.msl, la, lo), tcwv: gridAt(fr.tcwv, la, lo) }; }
function affectedMask(p, b, thr) {
  const m = new Uint8Array(1152);
  for (let i = 0; i < 1152; i++) m[i] = (Math.abs(b.t2m[i] - p.t2m[i]) >= thr.t2m || Math.abs(b.tp[i] - p.tp[i]) >= thr.tp || Math.abs(b.ws[i] - p.ws[i]) >= thr.ws
    || Math.abs(b.msl[i] - p.msl[i]) >= thr.msl / 100 || Math.abs(b.tcwv[i] - p.tcwv[i]) >= thr.tcwv) ? 1 : 0;
  return m;
}
function sixAvg(fr, mask, elevOf) {
  let w = 0; const s = { elev: 0, tp: 0, t2m: 0, ws: 0, msl: 0, tcwv: 0 };
  for (let i = 0; i < 1152; i++) if (mask[i]) { const la = 37.5 - Math.floor(i / 36), lo = 65.5 + i % 36, c = Math.cos(la * RAD); w += c;
    s.elev += c * elevOf(la, lo); ['tp', 't2m', 'ws', 'msl', 'tcwv'].forEach(k => (s[k] += c * fr[k][i])); }
  if (!w) return null; Object.keys(s).forEach(k => (s[k] /= w)); return s;
}
const SIX = [['elev', 'Elevation', 'm', 0], ['tp', 'Rain', 'mm/day', 1], ['t2m', 'Temperature', '°C', 1], ['ws', 'Wind', 'm/s', 1], ['msl', 'Pressure', 'hPa', 1], ['tcwv', 'Moisture', 'kg/m²', 0]];

const Panel = ({ title, acc, children, label }) => <section aria-label={label} className="panel">
  <h2 className="fred" style={{ margin: 0, fontWeight: 600, fontSize: 18, color: 'var(--text-strong)' }}>{title}</h2>{children}</section>;
const Warn = ({ list }) => list.map((w, i) => <p key={i} style={{ margin: 0, fontSize: 11, color: 'var(--warn)' }}>{w}</p>);

export default function App() {
  const canvasRef = useRef(null), eng = useRef(null);
  const [G, setG] = useState(null), [presets, setPresets] = useState([]), [pid, setPid] = useState(null), [events, setEvents] = useState([]);
  const [prime, setPrime] = useState(null), [primeMs, setPrimeMs] = useState(null), [health, setHealth] = useState(null), [err, setErr] = useState('');
  const [on, setOn] = useState({ terrain: true, elev: false, borders: true, lights: true, heat: true, rain: false, wind: false, pressure: false, moisture: false, clouds: false });
  const [focus, setFocus] = useState('heat'), [time, setTime] = useState('noon'), [clock, setClock] = useState(''), [day, setDay] = useState(0);
  const [showPins, setShowPins] = useState(true), [showCells, setShowCells] = useState(false), [hov, setHov] = useState(null);
  const [panel, setPanel] = useState(null), [view, setView] = useState('diff'), [playing, setPlaying] = useState(false);
  const [placeFor, setPlaceFor] = useState(null);                                   // 'event' | 'shock' while the drop pointer is active
  const [evId, setEvId] = useState('cyclone'), [evStrength, setEvStrength] = useState(100), [evCenter, setEvCenter] = useState(null), [evWarn, setEvWarn] = useState([]);
  const [shId, setShId] = useState('judge_warm'), [cvar, setCvar] = useState('t2m'), [camt, setCamt] = useState(2), [crad, setCrad] = useState(4), [shCenter, setShCenter] = useState(null), [shWarn, setShWarn] = useState([]);
  const [run, setRun] = useState(null), [busy, setBusy] = useState(false);
  const [impPlain, setImpPlain] = useState(null), [impRun, setImpRun] = useState(null), [impSel, setImpSel] = useState(null), [why, setWhy] = useState(null);

  // ---- engine + static data ----
  useEffect(() => {
    const e = eng.current = new GlobeEngine(canvasRef.current, { onClock: setClock, onHover: setHov, onPlace: (la, lo) => placeCb.current(la, lo) });
    window.__globe = e;                                       // handle for the browser tests (frontend/tests)
    api.geography().then(g => { const pg = prepGeo(g); pg.thr = g.affected_thresholds; setG(pg); e.setGeo(pg); }).catch(x => setErr('Gateway geography: ' + x.message));
    api.presets().then(p => { setPresets(p); setPid((p.find(x => x.id === 'heavy-rain') || p[0]).id); }).catch(x => setErr('Gateway not reachable at ' + (import.meta.env.VITE_GATEWAY || 'http://127.0.0.1:8100') + ': ' + x.message));
    api.events().then(setEvents).catch(() => {});
    const ph = () => api.health().then(setHealth).catch(() => setHealth(null)); ph(); const hi = setInterval(ph, 10000);
    return () => { clearInterval(hi); e.dispose(); };
  }, []);
  useEffect(() => {                                        // labels on the globe must not sit under panels
    const sel = 'header, .panel, [aria-label="Current conditions"], [aria-label="Layers and view"], [aria-label="Globe view"], [aria-label="Impact dashboard"], [data-keepout]';
    const t = setInterval(() => { const e = eng.current; if (!e || !canvasRef.current) return; const c = canvasRef.current.getBoundingClientRect();
      e.setKeepOut([...document.querySelectorAll(sel)].map(el => el.getBoundingClientRect()).filter(r => r.width > 0).map(r => ({ x: r.left - c.left - 6, y: r.top - c.top - 6, w: r.width + 12, h: r.height + 12 }))); }, 250);
    return () => clearInterval(t);
  }, []);
  const impSeq = useRef(0);                                 // only the latest run may set the impact tiles
  const placeCb = useRef(() => {});
  placeCb.current = (la, lo) => { if (placeFor === 'event') setEvCenter([la, lo]); if (placeFor === 'shock') setShCenter([la, lo]); setPlaceFor(null); };
  // ---- start preset -> plain forecast (live /run with nothing added) ----
  useEffect(() => {
    if (!pid) return; setPrime(null); setRun(null); setDay(0); setImpPlain(null); setImpRun(null); setImpSel(null);
    Promise.all([api.preset(pid), api.run(pid, null)]).then(([p, r]) => {
      setPrime({ frames: [toFrame(p.init_states[2]), ...r.prime.map(toFrame)], meta: p, normal: cloudNormal(p.init_states) }); setPrimeMs(r.timing.server_ms_prime);
      return api.impact({ preset_id: pid }).then(x => { if (x.preset_id === pid) setImpPlain(x); });
    }).catch(x => setErr('Forecast failed: ' + x.message));
  }, [pid]);

  const ev = events.find(e => e.id === evId), sh = SHOCKS.find(s => s.id === shId), cv = CVARS.find(c => c.id === cvar);
  useEffect(() => { if (ev && !evCenter) setEvCenter([ev.centre.lat, ev.centre.lon]); }, [ev]);
  const mode = !run ? 'without' : view;
  const frame = useMemo(() => {
    if (!prime) return null; const p = prime.frames[day]; if (mode === 'without') return p;
    const b = run.frames[day]; if (!b) return p; return mode === 'with' ? b : diffFrame(p, b);
  }, [prime, run, day, mode]);
  const flow = !prime ? null : (run && mode !== 'without' && run.frames[day]) ? run.frames[day] : prime.frames[day];
  useEffect(() => { eng.current && eng.current.setLayers(on); }, [on]);
  useEffect(() => { if (eng.current && on.clouds && flow && prime) eng.current.setClouds(cloudProxy(flow, prime.normal)); }, [on.clouds, flow, prime]);
  const imp = run ? impRun : impPlain;
  useEffect(() => { const t = imp && impSel && imp.tiles.find(x => x.id === impSel); eng.current && eng.current.setHighlight(t && t.active ? t.highlight : null); }, [imp, impSel]);
  const pickImpact = t => { if (!t.active) return; if (impSel === t.id) { setImpSel(null); return; } setImpSel(t.id);
    const L = TILES.find(x => x.id === t.layer); setOn(o => ({ ...o, [t.layer]: true })); if (L && L.w) setFocus(t.layer); };
  useEffect(() => { eng.current && eng.current.setView({ frame, flow, mode: mode === 'diff' ? 'diff' : 'prime', showCells, showPins }); }, [frame, flow, mode, showCells, showPins]);
  useEffect(() => { eng.current && eng.current.setSky({ mode: time, dateIso: prime ? prime.meta.last_input_day : null, day }); }, [time, prime, day]);
  useEffect(() => { eng.current && eng.current.setPlacing(!!placeFor); }, [placeFor]);
  // marker / box / track on the globe
  useEffect(() => {
    const e = eng.current; if (!e) return;
    let show = false, center = null, radiusDeg = 3, box = null;
    if (panel === 'events' && evCenter) { show = true; center = evCenter; radiusDeg = 8; }
    else if (panel === 'shocks') { if (sh.box) box = sh.box; else if (shId === 'custom' && shCenter) { show = true; center = shCenter; radiusDeg = crad; } }
    else if (run && !panel) { if (run.box) box = run.box; else { show = run.kind !== 'zero'; center = run.center; radiusDeg = run.radiusDeg; } }
    e.setMarker({ show: show || !!placeFor, center, radiusDeg }); e.setBox(box);
    e.setTrack(run && run.metrics && run.metrics.track ? run.metrics.track.slice(0, day + 1) : null);
  }, [panel, evCenter, shCenter, crad, shId, run, placeFor, day, sh]);
  // live previews: warnings from the gateway
  useEffect(() => {
    if (panel !== 'events' || !pid || !evCenter || !ev) return;
    const t = setTimeout(() => api.eventPreview(pid, eventSpec(evId, evStrength, evCenter)).then(r => setEvWarn(r.event.warnings)).catch(x => setEvWarn([x.message])), 200);
    return () => clearTimeout(t);
  }, [panel, pid, evId, evStrength, evCenter]);
  useEffect(() => {
    if (panel !== 'shocks' || !pid || (shId === 'custom' && !shCenter)) { setShWarn([]); return; }
    const t = setTimeout(() => api.preview(pid, shockSpec(shId, cvar, camt, crad, shCenter)).then(r => setShWarn(r.shock.warnings)).catch(x => setShWarn([x.message])), 200);
    return () => clearTimeout(t);
  }, [panel, pid, shId, cvar, camt, crad, shCenter]);
  useEffect(() => { if (!playing) return; const t = setInterval(() => setDay(d => { if (d >= 10) { setPlaying(false); return d; } return d + 1; }), 1100); return () => clearInterval(t); }, [playing]);

  const regionName = (la, lo) => { if (!G || !eng.current) return ''; const id = eng.current.regionAt(la, lo); return id > 0 ? G.names[id].replace('Sea / outside', 'the sea') : 'the sea'; };
  const elevAt = (la, lo) => (eng.current ? eng.current.elevAt(la, lo) : 0);

  /** Run one event or shock (replaces whatever was running). */
  async function start(kind) {
    if (!prime) return; setBusy(true); setErr(''); setPlaceFor(null);
    try {
      let pv, body, r;
      if (kind === 'event') { const spec = eventSpec(evId, evStrength, evCenter); pv = await api.eventPreview(pid, spec); body = { preset_id: pid, event: spec };
        const info = pv.event;
        r = { kind: 'event', id: evId, title: info.name + ' · ' + evStrength + '%', sub: `Real event: ${nice(info.source_date)} at ${info.real_centre.lat}°N ${info.real_centre.lon}°E`,
          center: [info.centre.lat, info.centre.lon], radiusDeg: 8, where: info.centre.region, warnings: info.warnings, tiles: EVENT_TILES[evId] };
      } else { const spec = shockSpec(shId, cvar, camt, crad, shCenter); pv = await api.preview(pid, spec); body = { preset_id: pid, shock: spec };
        const info = pv.shock;
        r = { kind: shId === 'zero' ? 'zero' : 'shock', id: shId, title: sh.name + (shId === 'custom' ? ' · ' + cv.name.toLowerCase() + ' ' + fmtSigned(camt, cv.unit) : ''),
          sub: info.description, center: [info.centre.lat, info.centre.lon], radiusDeg: crad, box: sh.box || null, where: info.centre.region, warnings: info.warnings,
          tiles: shId === 'custom' ? [cv.tile] : (sh.tile ? [sh.tile] : []) };
      }
      r = { ...r, frames: [addDelta(prime.frames[0], pv.perturbation)], outcome: [pv.outcome_day0], thr: pv.thresholds, metrics: null, ms: null, pert: pv.perturbation };
      setRun({ ...r }); setPanel(null); setView('diff'); setDay(0); setImpRun(null); const seq = ++impSeq.current;
      if (r.tiles.length) { setOn(o => { const n = { ...o }; r.tiles.forEach(t => (n[t] = true)); return n; }); setFocus(r.tiles[0]); }
      const done = await api.stream(body, m => { if (m.type === 'day') { r.frames[m.day] = toFrame(m.branch); r.outcome[m.day] = m.outcome; setRun({ ...r, frames: [...r.frames], outcome: [...r.outcome] }); } });
      setRun({ ...r, frames: [...r.frames], outcome: [...r.outcome], metrics: done.event_metrics, fade: done.fade, ms: done.timing.server_ms_branch });
      api.impact(body).then(x => { if (seq === impSeq.current) setImpRun(x); }).catch(x => setErr('Impacts failed: ' + x.message));
    } catch (x) { setErr('Run failed: ' + x.message); } finally { setBusy(false); }
  }
  const backToEarth = () => { impSeq.current++; setRun(null); setImpRun(null); setPanel(null); setPlaceFor(null); setDay(0); };

  // ---- top-left: Current conditions (nothing running) ----
  const FT = TILES.find(t => t.id === focus), L = LAYERS.find(l => l.id === ((FT && FT.w && on[focus]) ? FT.w : 'terrain'));
  let cond = null, tip = null;
  if (G && prime) {
    const fr = prime.frames[day];
    if (hov) {
      const ns = hov.la.toFixed(2) + '°N', ew = hov.lo.toFixed(2) + '°E';
      if (hov.inDom) {
        const name = hov.id > 0 ? G.names[hov.id].replace('Sea / outside', 'Sea') : 'Sea', el = Math.round(hov.elev);
        tip = { x: hov.px, y: hov.py, region: name.toUpperCase(), ll: ns + '  ' + ew, elev: el > 0 ? fmt(el, 0) + ' m above sea level' : (el < 0 ? fmt(-el, 0) + ' m below sea level' : 'At sea level') };
        const v = sixAt(fr, hov.la, hov.lo, el);
        cond = { place: name.toUpperCase(), ll: ns + ' ' + ew, rows: [['ELEVATION', fmt(el, 0), 'm'], ['RAIN', fmt(v.tp, 1), 'mm/day'], ['TEMPERATURE', fmt(v.t2m, 1), '°C'], ['WIND', fmt(v.ws, 1), 'm/s'], ['PRESSURE', fmt(v.msl, 0), 'hPa'], ['MOISTURE', fmt(v.tcwv, 0), 'kg/m²']] };
      } else tip = { x: hov.px, y: hov.py, region: 'OUTSIDE THE STUDY AREA', ll: ns + '  ' + ew, elev: 'No model data here' };
    }
  }
  const focusName = (FT && FT.w && on[focus]) ? FT.name : 'Elevation';
  const pickTile = t => { const o = !!on[t.id], n = { ...on, [t.id]: !o }; let f = focus; if (t.w && !o) f = t.id; else if (t.w && o && focus === t.id) { const nx = TILES.find(x => x.w && n[x.id]); f = nx ? nx.id : 'terrain'; } setOn(n); setFocus(f); };

  // ---- outcome panel ----
  let oc = null;
  if (run && prime) {
    const o = run.outcome[day], p = prime.frames[day], b = run.frames[day];
    const firstZero = run.outcome.findIndex((x, k) => k > 0 && x && x.cells === 0 && run.outcome.slice(0, k).some(y => y && y.cells > 0));
    let six = null;
    if (b && run.thr) {
      const [la, lo] = run.center, el = elevAt(la, lo), mask = affectedMask(p, b, run.thr);
      six = { c: [sixAt(b, la, lo, el), sixAt(p, la, lo, el)], a: [sixAvg(b, mask, elevAt), sixAvg(p, mask, elevAt)] };
    }
    const gv = o && o.main_variable ? VAR[o.main_variable] : null;
    oc = { o, six, gv, firstZero, faded: o && o.cells === 0 && firstZero > 0 && day >= firstZero,
      states: o ? (o.top_states || []).map(s => ({ name: s.state, m: s.mean_change * (gv ? gv[2] : 1) })) : [] };
  }
  const ready = health && health.inference_server && health.inference_server.ready;
  const scenDate = prime ? nice(addDays(prime.meta.last_input_day, day)) + ' · ' + (day === 0 ? 'start' : 'day +' + day) : '';
  const caption = !prime ? 'Loading the forecast from the model…' : !run ? (day === 0 ? 'Start state (real data)' : 'Plain forecast · day +' + day)
    : run.title + ' · ' + { with: 'with it', diff: 'difference', without: 'without it' }[view] + (busy || !run.frames[day] ? ' · running…' : '');

  const placer = (center, who) => <button type="button" aria-pressed={placeFor === who} onClick={() => setPlaceFor(placeFor === who ? null : who)}
    style={{ ...btn, minHeight: 40, border: '1px solid var(--accent-edge)', background: 'var(--accent-soft)', color: 'var(--text-strong)', fontWeight: 600 }}>
    {placeFor === who ? 'Click the globe to drop it…' : center ? `Drop point: ${center[0].toFixed(1)}°N ${center[1].toFixed(1)}°E · ${regionName(center[0], center[1])} (click to move)` : 'Drop it on the map'}</button>;
  const hbtn = (id, name, acc) => <button type="button" aria-pressed={panel === id} onClick={() => setPanel(panel === id ? null : id)}
    style={{ ...btn, minHeight: 40, padding: '0 14px', borderRadius: 0, fontSize: 13, fontWeight: 600, border: 'none', borderBottom: '2px solid ' + (panel === id ? 'var(--accent)' : 'transparent'), background: 'transparent', color: panel === id ? 'var(--text-strong)' : 'var(--text)' }}>{name}</button>;

  return (
    <div style={{ position: 'relative', height: '100vh', minHeight: 680, overflow: 'hidden', background: '#02050A' }}>
      <canvas ref={canvasRef} aria-label="Interactive 3D Earth centred on India with the Sun, Moon and planets in their real directions. Drag to orbit, scroll to zoom, shift-drag or right-drag to roll."
        role="img" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }} />
      {tip && <div className="glass" style={{ position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(18px,18px)', pointerEvents: 'none', minWidth: 200, padding: '10px 12px', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 3 }}>
        <span className="fred" style={{ fontWeight: 600, fontSize: 14, letterSpacing: '0.05em', color: 'var(--text-strong)' }}>{tip.region}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tip.ll}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-strong)' }}>{tip.elev}</span></div>}
      {placeFor && <div role="status" className="glass" style={{ position: 'absolute', left: '50%', top: 92, transform: 'translateX(-50%)', zIndex: 4, pointerEvents: 'none', padding: '10px 16px', borderRadius: 999, border: '1px solid var(--accent-edge)', color: 'var(--text-strong)', fontSize: 13 }}>Click anywhere in the study area (6–38°N, 65–101°E) · the ring shows the size</div>}

      {panel === 'earth' && <Panel title="Earth · starting data" acc="121,135,110" label="Earth">
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>Choose the real start state. The model then forecasts the next 10 days from it.</p>
        {presets.map(p => <button key={p.id} type="button" aria-pressed={p.id === pid} onClick={() => { setPid(p.id); setPanel(null); }}
          style={{ ...btn, textAlign: 'left', padding: '8px 10px', ...chip(p.id === pid) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span className="fred" style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</span><span className="mono" style={{ color: 'var(--text-faint)' }}>{nice(p.last_input_day)}</span></div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{p.description}</div></button>)}
        <button type="button" onClick={backToEarth} disabled={!run} style={{ ...btn, minHeight: 40, fontWeight: 600, ...chip(true), opacity: run ? 1 : 0.45 }}>Back to Earth (clear the event or shock)</button>
      </Panel>}

      {panel === 'events' && <Panel title="Weather events" acc={TEAL} label="Weather events">
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>Real events from 2019–2021, cut out of the data. Place one anywhere and watch it play out over 10 days.</p>
        <div role="group" aria-label="Event" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {events.map(e => <button key={e.id} type="button" aria-pressed={e.id === evId} onClick={() => { setEvId(e.id); setEvCenter([e.centre.lat, e.centre.lon]); }}
            style={{ ...btn, textAlign: 'left', padding: '7px 10px', ...chip(e.id === evId, TEAL) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span className="fred" style={{ fontSize: 14, fontWeight: 600 }}>{e.name}</span><span className="mono" style={{ color: 'var(--text-faint)' }}>{nice(e.source_date)}</span></div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{e.description}</div></button>)}
        </div>
        {ev && <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>Real centre {ev.centre.lat}°N {ev.centre.lon}°E · {ev.signature.msl_anomaly_hPa} hPa · wind up to +{ev.signature.max_wind_anomaly_m_s} m/s · rain up to +{ev.signature.max_rain_anomaly_mm_day} mm/day</span>}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Strength: <span className="mono" style={{ color: 'var(--text-strong)' }}>{evStrength}% of the real event</span>
          <input type="range" min="50" max="150" step="5" value={evStrength} onChange={e => setEvStrength(Number(e.target.value))} style={{ '--fill': (evStrength - 50) + '%' }} /></label>
        {placer(evCenter, 'event')}
        <button type="button" onClick={() => ev && setEvCenter([ev.centre.lat, ev.centre.lon])} style={{ ...btn, border: '1px solid var(--accent-edge)', background: 'transparent', color: 'var(--text-muted)' }}>Where it really happened</button>
        <Warn list={evWarn} />
        <button type="button" onClick={() => start('event')} disabled={busy || !prime || !evCenter} style={{ ...btn, minHeight: 40, fontSize: 13, fontWeight: 600, ...primary, opacity: busy ? 0.5 : 1 }}>{busy ? 'Running…' : 'Run the event'}</button>
      </Panel>}

      {panel === 'shocks' && <Panel title="Shocks" acc={AMBER} label="Shocks">
        <div role="group" aria-label="Shock" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 4 }}>
          {SHOCKS.map(s => <button key={s.id} type="button" aria-pressed={s.id === shId} onClick={() => setShId(s.id)} style={{ ...btn, minHeight: 44, ...chip(s.id === shId, AMBER) }}>{s.name}</button>)}
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>{sh.text}</p>
        {sh.box && <span className="mono" style={{ fontSize: 11, color: 'var(--text-strong)' }}>Fixed box {sh.box[0]}–{sh.box[1]}°N, {sh.box[2]}–{sh.box[3]}°E (dashed on the globe)</span>}
        {shId === 'zero' && <span className="mono" style={{ fontSize: 12, color: 'var(--text-strong)' }}>Expected — difference: exactly 0, everywhere, every day.</span>}
        {shId === 'custom' && <>
          <div role="group" aria-label="Variable to change" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 4 }}>
            {CVARS.map(c => <button key={c.id} type="button" aria-pressed={c.id === cvar} onClick={() => { setCvar(c.id); setCamt(c.def); }} style={{ ...btn, fontSize: 11, ...chip(c.id === cvar, AMBER) }}>{c.name}</button>)}</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Amount: <span className="mono" style={{ color: 'var(--text-strong)' }}>{fmtSigned(camt, cv.unit)}</span>
            <input type="range" min={cv.min} max={cv.max} step={cv.step} value={camt} onChange={e => setCamt(Number(e.target.value))} style={{ '--fill': (100 * (camt - cv.min) / (cv.max - cv.min)) + '%' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Size: <span className="mono" style={{ color: 'var(--text-strong)' }}>{'radius ' + crad + ' cells (about ' + Math.round(crad * 111) + ' km)'}</span>
            <input type="range" min="1" max="10" step="1" value={crad} onChange={e => setCrad(Number(e.target.value))} style={{ '--fill': (100 * (crad - 1) / 9) + '%' }} /></label>
          {placer(shCenter, 'shock')}</>}
        <Warn list={shWarn} />
        <button type="button" onClick={() => start('shock')} disabled={busy || !prime || (shId === 'custom' && !shCenter)} style={{ ...btn, minHeight: 40, fontSize: 13, fontWeight: 600, ...primary, opacity: busy || (shId === 'custom' && !shCenter) ? 0.45 : 1 }}>{busy ? 'Running…' : 'Run the shock'}</button>
      </Panel>}

      {oc && !panel && <section aria-label="Outcome" className="panel" style={{ width: 400 }}>
        <div><span className="cap">OUTCOME · {day === 0 ? 'NOW (THE MOMENT IT HITS)' : 'DAY +' + day}</span>
          <h2 className="fred" style={{ margin: '4px 0 0', fontWeight: 600, fontSize: 18, color: 'var(--text-strong)' }}>{run.title}</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>At {run.center[0].toFixed(1)}°N {run.center[1].toFixed(1)}°E · {regionName(...run.center)} · start: {prime.meta.name}, {nice(prime.meta.last_input_day)}</p>
          {run.kind === 'event' && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-faint)' }}>{run.sub}</p>}</div>
        <Warn list={run.warnings} />
        <div role="group" aria-label="View" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 4 }}>
          {[['with', 'With it'], ['diff', 'Difference'], ['without', 'Without']].map(([id, n]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} style={{ ...btn, ...chip(view === id) }}>{n}</button>)}</div>
        {run.kind === 'zero' && oc.o && <span className="mono" style={{ fontSize: 13, color: 'var(--text-strong)' }}>difference: {oc.o.cells === 0 && Object.values(oc.o.max_abs_change).every(v => v === 0) ? 'exactly 0' : 'NOT zero (' + JSON.stringify(oc.o.max_abs_change) + ')'}</span>}
        {oc.o ? <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8 }}>
            {[[fmt(Math.round(oc.o.reach_km), 0), 'km reached'], [fmt(Math.round(oc.o.affected_area_kkm2), 0), 'thousand km² affected'],
              [oc.gv ? sgn(oc.o.peak_change * oc.gv[2], 1) : '0', oc.gv ? 'peak Δ ' + oc.gv[0] + ' ' + oc.gv[1] : 'no change above thresholds']].map(([v, k], i) =>
              <div key={i}><div className="fred" style={{ fontWeight: 500, fontSize: 24 }}>{v}</div><div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{k}</div></div>)}</div>
          {oc.faded && <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>Faded by day +{oc.firstZero}: every change is now below the thresholds.</p>}
          {oc.six && <table aria-label="Six core parameters" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr style={{ color: 'var(--text-faint)' }}><th style={{ textAlign: 'left', fontWeight: 400 }}></th><th colSpan="3" style={{ fontWeight: 400 }}>at the centre</th><th colSpan="3" style={{ fontWeight: 400 }}>affected-area average</th></tr>
              <tr style={{ color: 'var(--text-faint)' }}><th></th>{['with', 'without', 'Δ', 'with', 'without', 'Δ'].map((h, i) => <th key={i} style={{ fontWeight: 400, textAlign: 'right' }}>{h}</th>)}</tr></thead>
            <tbody>{SIX.map(([k, n, u, d]) => <tr key={k}><td style={{ color: 'var(--text)' }}>{n} <span style={{ color: 'var(--text-faint)' }}>{u}</span></td>
              {[oc.six.c, oc.six.a].map((pair, j) => pair[0] ? [pair[0][k], pair[1][k], pair[0][k] - pair[1][k]].map((v, i) => <td key={j + '' + i} className="mono" style={{ textAlign: 'right', color: i === 2 ? 'var(--text-strong)' : 'var(--text)' }}>{i === 2 ? sgn(v, d) : fmt(v, d)}</td>)
                : [0, 1, 2].map(i => <td key={j + '' + i} style={{ textAlign: 'right', color: 'var(--text-faint)' }}>—</td>))}</tr>)}</tbody></table>}
          <span className="cap">MOST AFFECTED STATES{oc.gv ? ' · Δ ' + oc.gv[0].toUpperCase() + ' ' + oc.gv[1] : ''}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {oc.states.length ? oc.states.map(st => <div key={st.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{st.name}</span><span className="mono" style={{ color: 'var(--text-strong)' }}>{sgn(st.m, 2)}</span></div>)
              : <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{oc.faded ? 'None: the effect has faded.' : 'No Indian state is affected above the thresholds on this day.'}</span>}</div>
          <EventMetrics run={run} day={day} />
        </> : <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Waiting for the model…</span>}
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)' }}>Thresholds: {run.thr ? `${run.thr.t2m} °C, ${run.thr.tp} mm/day, ${run.thr.ws} m/s, ${run.thr.msl / 100} hPa, ${run.thr.tcwv} kg/m²` : ''}{run.ms ? ' · model time ' + run.ms.toFixed(0) + ' ms' : ''}</p>
        <button type="button" onClick={backToEarth} style={{ ...btn, minHeight: 38, border: '1px solid var(--accent-edge)', background: 'transparent', color: 'var(--text-muted)' }}>Back to Earth</button>
      </section>}

      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', flexDirection: 'column', zIndex: 2 }}>
        <header className="glass" style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 22px', padding: '10px 20px', margin: '8px 12px 0', borderRadius: 'var(--panel-radius)', color: 'var(--text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true" style={{ color: 'var(--accent)' }}><circle cx="13" cy="13" r="11.5" stroke="currentColor" strokeWidth="1.4" /><ellipse cx="13" cy="13" rx="5" ry="11.5" stroke="currentColor" strokeOpacity="0.55" /><path d="M2 13h22" stroke="currentColor" strokeOpacity="0.55" /></svg>
            <div><div className="fred" style={{ fontWeight: 600, fontSize: 16, letterSpacing: '0.16em', color: 'var(--text-strong)' }}>MONSOON DIGITAL TWIN</div>
              <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--text-faint)' }}>INDIA STUDY AREA · 6–38°N · 65–101°E</div></div>
          </div>
          <nav aria-label="Main" style={{ display: 'flex', gap: 8 }}>
            {hbtn('earth', 'Earth', '121,135,110')}{hbtn('events', 'Weather events', TEAL)}{hbtn('shocks', 'Shocks', AMBER)}
          </nav>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: ready ? 'var(--accent)' : '#E07A4F' }} />{ready ? 'Engine ready' : 'Engine offline'}</span>
            <span className="mono" style={{ color: 'var(--text-faint)' }}>10-day rollout · {primeMs ? primeMs.toFixed(0) + ' ms' : '…'}</span>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'space-between', gap: 24, padding: '4px 24px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16, maxWidth: 'min(560px, 48vw)', minWidth: 0 }}>
            {!run ? <div aria-live="polite" aria-label="Current conditions" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="cap" style={{ color: '#9FC2B6' }}>CURRENT CONDITIONS · {scenDate.toUpperCase()}</span>
              {cond ? <>
                <span className="fred" style={{ fontWeight: 500, fontSize: 'clamp(34px, 3.6vw, 56px)', lineHeight: 1, color: 'rgba(231,242,238,0.75)' }}>{cond.place}</span>
                <span className="mono" style={{ fontSize: 12, letterSpacing: '0.08em', color: '#BFD9D0' }}>{cond.ll}</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '10px 26px', marginTop: 6, justifyContent: 'start' }}>
                  {cond.rows.map(([k, v, u]) => <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 10, letterSpacing: '0.18em', color: '#9FC2B6' }}>{k}</span>
                    <span className="fred" style={{ fontWeight: 500, fontSize: 'clamp(24px, 2.4vw, 36px)', lineHeight: 1, color: 'rgba(231,242,238,0.78)' }}>{v}<span style={{ fontSize: '0.45em', fontWeight: 400, marginLeft: 4, color: 'rgba(231,242,238,0.55)' }}>{u}</span></span></div>)}
                </div></> : <span className="fred" style={{ fontSize: 22, color: 'rgba(231,242,238,0.6)' }}>{err || 'Point at India to read the weather there'}</span>}
              <span className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: '#9FC2B6', marginTop: 4 }}>DRAG TO ORBIT · SCROLL TO ZOOM · HOVER INDIA</span>
            </div> : <div />}

            <section aria-label="Layers and view" className="glass" style={{ pointerEvents: 'auto', width: 300, maxWidth: '100%', padding: 12, borderRadius: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cap">MAP LAYERS · TURN ON ANY COMBINATION</span>
              <div role="group" aria-label="Map layers" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
                {TILES.map(t => { const o = !!on[t.id]; return <button key={t.id} type="button" aria-pressed={o} onClick={() => pickTile(t)} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4, borderRadius: 10, border: '2px solid ' + (o ? 'var(--accent)' : 'var(--card-border)'), background: o ? 'var(--accent-soft)' : 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                  <span aria-hidden="true" style={{ display: 'block', height: 38, borderRadius: 7, background: t.thumb, opacity: o ? 1 : 0.45 }} />
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, fontSize: 11, padding: '0 2px' }}><span>{t.name}</span><span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{o ? 'ON' : ''}</span></span></button>; })}
              </div>
              <span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-faint)' }}>Colour scale: <span style={{ color: 'var(--text)' }}>{focusName}</span> · the last weather layer you turned on.</span>
              <span className="cap" style={{ marginTop: 4 }}>SKY (SUN, MOON, PLANETS, DAY/NIGHT)</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.6fr', gap: 4 }}>
                {TIMES.map(m => <button key={m.id} type="button" aria-pressed={time === m.id} onClick={() => setTime(m.id)} style={{ ...btn, fontSize: 11, ...chip(time === m.id) }}>{m.name}</button>)}</div>
              <span style={{ fontSize: 10, lineHeight: 1.4, color: 'var(--text-faint)' }}>The sky follows the scenario date ({scenDate}). The weather is never live.</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}><input type="checkbox" checked={showPins} onChange={() => setShowPins(!showPins)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />Test-shock pins</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}><input type="checkbox" checked={showCells} onChange={() => setShowCells(!showCells)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />Model cells (1°)</label>
              </div>
            </section>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div role="group" aria-label="Globe view" className="glass" style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: 6, borderRadius: 14, marginTop: 40 }}>
              {[['Zoom in', '+', () => eng.current.zoomIn(), 22], ['Zoom out', '−', () => eng.current.zoomOut(), 22], ['Turn north up', 'N↑', () => eng.current.northUp(), 12]].map(([l, t, f, fs]) =>
                <button key={l} type="button" aria-label={l} onClick={f} style={{ width: 44, height: 44, borderRadius: 10, border: 'none', background: 'var(--accent-soft)', color: 'var(--text-strong)', fontSize: fs, fontWeight: fs === 12 ? 600 : 400, cursor: 'pointer' }}>{t}</button>)}
              <button type="button" aria-label="Reset view to India" onClick={() => eng.current.resetView()} style={{ width: 44, height: 44, borderRadius: 10, border: 'none', background: 'var(--accent-soft)', color: 'var(--text-strong)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 9a6 6 0 1 0 2-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 2.5V5h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
            </div>
          </div>
        </div>

        <ImpactRow imp={imp} run={run} day={day} sel={impSel} pick={pickImpact} why={why} setWhy={setWhy} />
        <div data-keepout className="glass" style={{ pointerEvents: 'auto', alignSelf: 'center', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 999, maxWidth: 'calc(100% - 48px)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" aria-label={playing ? 'Pause the 10-day rollout' : 'Play the 10-day rollout'} onClick={() => { if (!playing && day >= 10) setDay(0); setPlaying(!playing); }}
            style={{ width: 44, height: 44, borderRadius: '50%', ...primary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {playing ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 2.5v9M10 2.5v9" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" /></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 2v10l8.5-5z" stroke="#FFFFFF" strokeWidth="1.4" strokeLinejoin="round" /></svg>}</button>
          <div role="group" aria-label="Forecast day" style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {Array.from({ length: 11 }, (_, k) => <button key={k} type="button" aria-pressed={k === day} onClick={() => setDay(k)} className="mono"
              style={{ minWidth: 44, minHeight: 40, borderRadius: 999, border: 'none', background: k === day ? 'var(--accent-soft)' : 'transparent', color: k === day ? 'var(--text-strong)' : 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>{k === 0 ? 'Now' : '+' + k}</button>)}
          </div>
          <span data-testid="caption" style={{ fontSize: 12, color: 'var(--text-faint)', padding: '0 8px' }}>{caption}</span>
        </div>
      </div>
    </div>
  );
}

/** Event-specific numbers for the selected day (from the gateway's event_metrics). */
function EventMetrics({ run, day }) {
  const m = run.metrics; if (run.kind !== 'event') return null;
  if (!m) return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Event details arrive when all 10 days are done…</span>;
  const Row = ({ k, v }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}><span style={{ color: 'var(--text-muted)' }}>{k}</span><span className="mono" style={{ color: 'var(--text)', textAlign: 'right' }}>{v}</span></div>;
  const d1 = Math.max(0, day - 1);
  let body = null;
  if (run.id === 'cyclone') { const t = m.track[day];
    body = <>{t && <><Row k="Centre (msl minimum)" v={`${t.lat}°N ${t.lon}°E · ${t.region.replace('Sea / outside', 'sea')}`} /><Row k="Lowest pressure" v={t.lowest_pressure_hPa + ' hPa'} /><Row k="Depth below plain forecast" v={t.depth_hPa + ' hPa'} /><Row k="Strongest wind near centre" v={t.strongest_wind_m_s + ' m/s'} /></>}
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>Track: {m.track.map(x => `d${x.day} ${x.lat}°N ${x.lon}°E`).join(' → ')}</span>
      {m.notes.map((n, i) => <p key={i} style={{ margin: 0, fontSize: 11, color: i < m.notes.length - 1 ? 'var(--warn)' : 'var(--text-faint)' }}>{n}</p>)}
      <span className="cap">10-DAY RAIN CHANGE BY STATE</span>{m.rain_change_by_state_mm.map(s => <Row key={s.state} k={s.state} v={sgn(s.change_mm, 0) + ' mm'} />)}</>;
  } else if (run.id === 'heavy_rain') { const p = day > 0 ? m.per_day[d1] : null;
    body = <>{p && <><Row k="Largest 3-day total" v={p.max_3day_total_mm + ' mm'} /><Row k="Largest 3-day change" v={sgn(p.max_3day_change_mm, 1) + ' mm'} />
      {Object.entries(p.area_kkm2_by_category).map(([k, v]) => <Row key={k} k={'IMD ' + k.replace('_', ' ')} v={v + ' thousand km²'} />)}</>}
      <span className="cap">STATES BY LARGEST 3-DAY TOTAL</span>{m.states_by_max_3day_total_mm.map(s => <Row key={s.state} k={s.state} v={fmt(s.max_3day_total_mm, 0) + ' mm'} />)}
      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{m.categories}</span></>;
  } else if (run.id === 'heatwave') {
    body = <>{day > 0 && <Row k="Heat-stress area (≥ 3 °C above normal)" v={m.heat_stress_area_kkm2_per_day[d1] + ' thousand km²'} />}<Row k="Days it persists" v={m.days_it_persists + ' of 10'} />
      <span className="cap">HOTTEST STATES (10-DAY MEAN)</span>{m.hottest_states_mean_C.map(s => <Row key={s.state} k={s.state} v={s.mean_C + ' °C'} />)}</>;
  } else if (run.id === 'monsoon_onset') { const p = day > 0 ? m.per_day[d1] : null;
    body = <>{p && <Row k="Monsoon reaches (rain ≥ 5 mm/day)" v={`with ${p.with ?? '—'}°N · without ${p.without ?? '—'}°N`} />}
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{m.per_day.map(x => `+${x.day}: ${x.with}`).join(' · ')}</span></>;
  } else if (run.id === 'western_disturbance') {
    body = <>{day > 0 && m.states.map(s => <Row key={s.state} k={s.state} v={`rain ${s.rain_with_mm_per_day[d1]} vs ${s.rain_without_mm_per_day[d1]} mm · ${sgn(s.temperature_change_K[d1], 1)} °C`} />)}
      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{m.note}</span></>;
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="cap">{run.title.split(' · ')[0].toUpperCase()} DETAILS</span>{body}</div>;
}

// ---- Impact dashboard ------------------------------------------------------------------------------------------
const LEVEL_C = { Low: '121,135,110', Moderate: '233,215,138', High: '242,178,107', Severe: '224,122,79' };
const tfmt = (x, u) => (u === '%' ? fmt(x, 1) + '%' : fmt(x, 1) + ' ' + u);
/** headline value + what it means, per tile */
function tval(t) { const b = t.branch;
  if (t.id === 'heat') return [(b.value > 0 ? '+' : '') + fmt(b.value, 1) + ' °C', 'above normal for this date · hottest India cell'];
  if (t.id === 'solar') return [fmt(b.value, 1) + '%', `clear, dry India land · normal ${fmt(t.normal, 1)}%`];
  if (t.id === 'wind') return [fmt(b.value, 1) + ' W/m²', `India-land mean · ${b.pct_of_normal}% of normal`];
  if (t.id === 'flood') return [fmt(b.value, 1) + ' mm/day', 'wettest India cell (IMD scale)'];
  return [fmt(b.value, 1) + '%', 'of cropland under half its normal rain']; }
const dunit = t => (t.id === 'heat' ? ' °C' : t.unit === '%' ? ' pts' : ' ' + t.unit);

function Spark({ t, day }) {
  const W = 236, H = 50, a = t.prime.series, b = t.branch.series, all = [...a, ...b], lo = Math.min(...all), hi = Math.max(...all), r = hi - lo || 1;
  const pt = (s, k) => [(k / (s.length - 1)) * (W - 8) + 4, H - 12 - ((s[k] - lo) / r) * (H - 18)];
  const line = s => s.map((_, k) => pt(s, k).join(',')).join(' '), c = `rgb(${LEVEL_C[t.branch.level]})`;
  const [x, y] = pt(b, Math.min(day, b.length - 1));
  return <svg width={W} height={H} role="img" aria-label={`${t.name} over days 0 to 10`} style={{ display: 'block', color: 'var(--text-faint)' }}>
    <polyline points={line(a)} fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 3" />
    <polyline points={line(b)} fill="none" stroke={c} strokeWidth="1.8" />
    <circle cx={x} cy={y} r="3" fill={c} />
    <text x="4" y={H - 1} fontSize="9" fill="currentColor">day 0</text><text x={W - 34} y={H - 1} fontSize="9" fill="currentColor">day 10</text></svg>;
}

/** Docked "Impact" strip just above the timeline (left edge never under the Map layers panel); Hide/Show collapses it. */
const DOCK = { position: 'absolute', left: 'max(362px, calc(50% - 480px))', bottom: 88, maxWidth: 'calc(100% - 386px)', zIndex: 3, pointerEvents: 'auto',
  padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 };
function ImpactRow({ imp, run, day, sel, pick, why, setWhy }) {
  const [open, setOpen] = useState(true);
  const head = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <h2 className="fred" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-strong)' }}>Impact</h2>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, textDecoration: 'underline', cursor: 'pointer', padding: '2px 4px' }}>{open ? 'Hide' : 'Show'}</button></div>;
  if (!imp) return <section aria-label="Impact dashboard" data-testid="impact-row" className="glass" style={DOCK}>{head}{open && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Computing impacts (16 live model runs)…</span>}</section>;
  return <section aria-label="Impact dashboard" data-testid="impact-row" className="glass" style={DOCK}>{head}
    {open && <><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    {imp.tiles.map(t => { const c = t.active ? LEVEL_C[t.branch.level] : '121,135,110', on = sel === t.id, cf = t.confidence;
      const agree = !cf ? '' : imp.has_change ? `${cf.same_direction}/${cf.members} agree` : `${cf.same_level}/${cf.members} agree`;
      return <div key={t.id} style={{ position: 'relative' }}>
        <div role="button" tabIndex={0} aria-pressed={on} data-testid={'impact-' + t.id} onClick={() => pick(t)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && pick(t)}
          style={{ width: 156, padding: '8px 10px', borderRadius: 12, cursor: t.active ? 'pointer' : 'default', border: '1px solid ' + (on ? 'var(--accent-edge)' : 'var(--card-border)'), borderLeft: `3px solid rgb(${c})`, background: on ? 'var(--accent-soft)' : 'var(--card-bg)', display: 'flex', flexDirection: 'column', gap: 3, opacity: t.active ? 1 : 0.55 }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}><span className="cap" style={{ letterSpacing: '0.08em' }}>{t.name.toUpperCase()}</span>
            {t.active && <span data-testid={'level-' + t.id} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: `rgba(${c},0.3)`, color: 'var(--text-strong)' }}>{t.branch.level}</span>}</span>
          {t.active ? <>
            <span className="fred" style={{ fontSize: 20, fontWeight: 500, color: 'var(--text-strong)' }}>{tval(t)[0]}</span>
            <span data-testid={'meaning-' + t.id} style={{ fontSize: 10, lineHeight: 1.3, color: 'var(--text-muted)' }}>{tval(t)[1]}</span>
            <span className="mono" style={{ fontSize: 11, color: imp.has_change && t.delta !== 0 ? 'var(--text-strong)' : 'var(--text-faint)' }}>{imp.has_change ? 'Δ ' + (t.delta > 0 ? '+' : '') + fmt(t.delta, 1) + dunit(t) + ' vs plain' : 'plain forecast'}</span>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-faint)' }}><span title="ensemble members agreeing">{agree}</span>
              <button type="button" aria-expanded={why === t.id} onClick={e => { e.stopPropagation(); setWhy(why === t.id ? null : t.id); }} style={{ ...btn, minHeight: 22, padding: '0 8px', fontSize: 10, border: '1px solid var(--accent-edge)', background: 'transparent' }}>Why? {why === t.id ? '▴' : '▾'}</button></span>
          </> : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Off season (Jun–Sep only)</span>}
        </div>
        {why === t.id && t.active && <div role="region" aria-label={t.name + ' explanation'} data-testid={'why-' + t.id} className="glass" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)', width: 260, padding: 12, borderRadius: 12, zIndex: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Spark t={t} day={day} />
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{imp.has_change ? 'solid: with the change · dashed: plain forecast' : 'daily value, day 0 (start) to day 10'}</span>
          {t.explanation.map((x, i) => <p key={i} style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--text)' }}>{x}</p>)}
        </div>}
      </div>; })}</div>
    <span style={{ width: '100%', textAlign: 'center', fontSize: 10, color: 'var(--text-faint)' }}>Screening proxies from live model runs, not official warnings · click a tile to show its layer and area{sel === 'solar' ? ' · clouds = cloud proxy from moisture and rain' : ''}</span></>}
  </section>;
}
