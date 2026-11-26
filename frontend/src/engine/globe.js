// The 3D globe engine: a plain three.js port of the approved mockup's scene, controls, picking and layer painters.
// React owns the UI; this class owns the WebGL scene. Data comes in through setGeo / setFrames / setView.
import * as T from 'three';
import { sky, helio, toEq, PLANETS, sd, cd } from './ephemeris.js';
import { GLOBE_VS, GLOBE_FS, SHELL_VS, WX_FS, LIFT_FS, SUN_VS, SUN_FS, ATM_VS, AIRGLOW_FS, CLOUD_FS, HI_FS } from './shaders.js';
import { DOM, TEMPP, RAINP, DIV, LAYERS, TIMES } from '../data.js';

const TEX = (import.meta.env.BASE_URL || '/') + 'textures/';
const DISP = 0.022;                                  // terrain exaggeration (fraction of Earth radius at 8 km)
const RAD = Math.PI / 180, AU = 1100;
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export function ramp(stops, t) { t = Math.max(0, Math.min(1, t)); const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n)), f = t * n - i; const a = hex(stops[i]), b = hex(stops[i + 1]); return a.map((x, k) => x + (b[k] - x) * f); }
const LABELS = [['PAKISTAN', 29.6, 69.4], ['AFGHANISTAN', 33.9, 66.2], ['CHINA', 33.2, 92.0], ['NEPAL', 28.2, 83.9], ['BHUTAN', 27.45, 90.45], ['BANGLADESH', 23.9, 90.2], ['MYANMAR', 21.3, 95.9], ['SRI LANKA', 7.7, 80.75], ['IRAN', 32.2, 54.9], ['TAJIKISTAN', 38.7, 71.0], ['THAILAND', 15.5, 101.0], ['OMAN', 21.3, 57.3], ['UAE', 23.6, 54.3, 0.6], ['QATAR', 25.3, 51.2, 0.5], ['BAHRAIN', 26.15, 50.55, 0.42], ['SAUDI ARABIA', 23.8, 44.7], ['YEMEN', 15.6, 47.3], ['KUWAIT', 29.35, 47.6, 0.5], ['IRAQ', 33.1, 43.3], ['JORDAN', 30.9, 36.7, 0.55], ['SYRIA', 35.0, 38.4], ['LEBANON', 34.25, 35.85, 0.45], ['PALESTINE', 32.15, 35.25, 0.45], ['ISRAEL', 30.6, 34.85, 0.45]];

export class GlobeEngine {
  constructor(canvas, cb) {
    this.cv = canvas; this.cb = cb; this.dist = 2.3; this.curRegion = -1; this.t0 = Date.now(); this.simStart = Date.now();
    this.sky0 = { mode: 'noon', dateIso: null, day: 0 }; this.on = {}; this.view = { frame: null, mode: 'prime', showCells: false, showPins: true };
    this.marker = null; this.mk = { show: false }; this.placing = false; this.parts = []; this.G = null;
    this.init();
  }
  // ---- scene ----------------------------------------------------------------------------------------------
  init() {
    const cv = this.cv;
    const r = this.renderer = new T.WebGLRenderer({ canvas: cv, antialias: true }); r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); r.outputColorSpace = T.LinearSRGBColorSpace;
    const sc = this.scene = new T.Scene(); sc.background = new T.Color(0x02040a);
    this.cam = new T.PerspectiveCamera(35, 1, 0.01, 80000); this.camQ = new T.Quaternion();
    const tl = new T.TextureLoader(), tex = (u, rep) => { const t = tl.load(TEX + u); t.colorSpace = T.NoColorSpace; t.anisotropy = 8; if (rep) t.wrapS = T.RepeatWrapping; return t; };
    this.uni = { elevTex: { value: tex('earth_elevation.png', 1) }, dayTex: { value: tex('earth_day_relief.jpg', 1) }, lightsTex: { value: tex('earth_night_lights.png', 1) },
      borderTex: { value: tex('borders.png', 1) }, disp: { value: DISP }, sunDir: { value: new T.Vector3(1, 0, 0) }, lightsOn: { value: 1 }, bordersOn: { value: 1 }, coastTex: { value: tex('india_coast_glow.png', 1) } };
    this.globe = new T.Group(); sc.add(this.globe);
    this.globe.add(new T.Mesh(new T.SphereGeometry(1, 640, 320), new T.ShaderMaterial({ uniforms: this.uni, vertexShader: GLOBE_VS, fragmentShader: GLOBE_FS })));
    sc.add(new T.Mesh(new T.SphereGeometry(1.03, 128, 64), new T.ShaderMaterial({ vertexShader: ATM_VS, fragmentShader: AIRGLOW_FS, transparent: true, blending: T.AdditiveBlending, depthWrite: false })));
    const sg = new T.BufferGeometry(), sp = []; for (let i = 0; i < 3500; i++) { const v = new T.Vector3().randomDirection().multiplyScalar(52000 + Math.random() * 4000); sp.push(v.x, v.y, v.z); }
    sg.setAttribute('position', new T.Float32BufferAttribute(sp, 3));
    sc.add(new T.Points(sg, new T.PointsMaterial({ color: 0xcfe6ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85 })));
    // Sun: animated photosphere + layered corona
    this.sunU = { sunTex: { value: tl.load(TEX + 'sun.jpg') }, time: { value: 0 } };
    this.sun = new T.Group();
    this.sun.add(new T.Mesh(new T.SphereGeometry(26, 96, 48), new T.ShaderMaterial({ uniforms: this.sunU, vertexShader: SUN_VS, fragmentShader: SUN_FS })));
    const corona = (size, stops) => { const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d'), gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
      stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
      const s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), blending: T.AdditiveBlending, depthWrite: false, transparent: true })); s.scale.set(size, size, 1); return s; };
    this.sun.add(corona(120, [[0, 'rgba(255,236,200,0.55)'], [0.22, 'rgba(255,214,150,0.35)'], [0.45, 'rgba(255,170,90,0.10)'], [1, 'rgba(255,140,60,0)']]));
    this.sun.add(corona(380, [[0, 'rgba(255,220,170,0.16)'], [0.25, 'rgba(255,190,120,0.06)'], [1, 'rgba(255,160,80,0)']]));
    sc.add(this.sun);
    sc.add(new T.Mesh(new T.SphereGeometry(70000, 64, 32), new T.MeshBasicMaterial({ map: tl.load(TEX + 'stars_milky_way.jpg'), side: T.BackSide, color: 0x555a66, depthWrite: false })));
    this.sunLight = new T.DirectionalLight(0xfff4e6, 3.2); sc.add(this.sunLight); sc.add(new T.AmbientLight(0xffffff, 0.04));
    // Moon + planets (real directions; sizes exaggerated)
    const label = txt => { const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d'); x.font = '500 30px Fredoka, Inter, sans-serif'; x.fillStyle = 'rgba(231,242,238,0.9)'; x.textAlign = 'center'; x.fillText(txt, 128, 42);
      return new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false })); };
    this.bodies = {};
    const addBody = (name, radius, texFile, dist, ring) => { const grp = new T.Group(); grp.add(new T.Mesh(new T.SphereGeometry(radius, 64, 32), new T.MeshStandardMaterial({ map: tl.load(TEX + texFile), roughness: 1, metalness: 0 })));
      if (ring) { const r0 = radius * 1.24, r1 = radius * 2.27, rgeo = new T.RingGeometry(r0, r1, 128, 1), pos = rgeo.attributes.position, uvA = rgeo.attributes.uv;
        for (let i = 0; i < pos.count; i++) { const rr = Math.hypot(pos.getX(i), pos.getY(i)); uvA.setXY(i, (rr - r0) / (r1 - r0), 0.5); }
        const rg = new T.Mesh(rgeo, new T.MeshStandardMaterial({ map: tl.load(TEX + 'saturn_rings.png'), side: T.DoubleSide, transparent: true, roughness: 1, depthWrite: false })); grp.add(rg); grp.ring = rg; }
      const lb = label(name); lb.scale.set(dist * 0.09, dist * 0.0225, 1); lb.position.set(0, radius + dist * 0.02, 0); grp.add(lb);
      sc.add(grp); this.bodies[name] = { grp, dist }; };
    // MOON — DECORATION ONLY. Real direction and real phase (lit by the Sun light), but drawn at an exaggerated close
    // distance (12 Earth radii, radius 0.35) so it is visible. It has zero effect on the gateway, the events, the shocks
    // or the model: nothing here is ever sent anywhere, and the model has no Moon input.
    addBody('Moon', 0.35, 'moon.jpg', 12);
    { const B = this.bodies.Moon, lb = B.grp.children[1]; lb.scale.set(1.4, 0.35, 1); lb.position.set(0, 0.62, 0);
      const ob = 23.43928 * RAD, pole = new T.Vector3(0, Math.cos(ob), -(-Math.sin(ob)));  // ecliptic pole: ECI (0,-sin ob, cos ob) -> scene (x, z, -y)
      const ring = new T.Mesh(new T.RingGeometry(11.97, 12.03, 256), new T.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.16, side: T.DoubleSide, depthWrite: false }));
      ring.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), pole.normalize()); sc.add(ring); this.moonRing = ring; }
    PLANETS.forEach(pl => addBody(pl.n, pl.r * 2.2, pl.t, 700, pl.ring));
    this.orbits = new T.Group(); sc.add(this.orbits);
    // India-domain shells: weather, wind flow, hover glow
    const domGeo = () => new T.SphereGeometry(1, 220, 200, (DOM.lon0 + 180) * RAD, (DOM.lon1 - DOM.lon0) * RAD, (90 - DOM.lat1) * RAD, (DOM.lat1 - DOM.lat0) * RAD);
    const domElev = tex('india_domain_elevation.png');
    this.wxCanvas = document.createElement('canvas'); this.wxCanvas.width = 1440; this.wxCanvas.height = 1280; this.wxTex = new T.CanvasTexture(this.wxCanvas); this.wxTex.colorSpace = T.NoColorSpace;
    this.globe.add(new T.Mesh(domGeo(), new T.ShaderMaterial({ uniforms: { domElev: { value: domElev }, disp: { value: DISP }, lift: { value: 0.0035 }, wxTex: { value: this.wxTex } }, vertexShader: SHELL_VS, fragmentShader: WX_FS, transparent: true, depthWrite: false })));
    this.maskCanvas = document.createElement('canvas'); this.maskCanvas.width = 720; this.maskCanvas.height = 640; this.maskTex = new T.CanvasTexture(this.maskCanvas);
    this.hlU = { maskTex: { value: this.maskTex }, fade: { value: 0 }, domElev: { value: domElev }, disp: { value: DISP }, lift: { value: 0.0045 } };
    this.liftMesh = new T.Mesh(domGeo(), new T.ShaderMaterial({ uniforms: this.hlU, vertexShader: SHELL_VS, fragmentShader: LIFT_FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    this.liftMesh.visible = false; this.globe.add(this.liftMesh); this.fadeTo = 0;
    const pinTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.strokeStyle = 'rgba(233,215,138,0.95)'; x.lineWidth = 5; x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke(); return new T.CanvasTexture(c); })();
    const dotTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,240,190,1)'); g.addColorStop(0.35, 'rgba(233,215,138,0.9)'); g.addColorStop(1, 'rgba(233,215,138,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c); })();
    this.marker = new T.Group(); this.globe.add(this.marker); this.marker.visible = false;
    const mkr = (r0, r1, op) => new T.Mesh(new T.RingGeometry(r0, r1, 96), new T.MeshBasicMaterial({ color: 0xe9d78a, transparent: true, opacity: op, side: T.DoubleSide, depthWrite: false }));
    this.markerRing = mkr(0.93, 1.0, 0.95); this.markerFill = new T.Mesh(new T.CircleGeometry(1, 96), new T.MeshBasicMaterial({ color: 0xe9d78a, transparent: true, opacity: 0.12, side: T.DoubleSide, depthWrite: false }));
    this.markerPulse = mkr(0.97, 1.0, 0.8); this.markerDot = new T.Mesh(new T.CircleGeometry(0.08, 32), new T.MeshBasicMaterial({ color: 0xfff2c4, side: T.DoubleSide }));
    [this.markerFill, this.markerRing, this.markerPulse, this.markerDot].forEach(m => this.marker.add(m));
    this.flowCanvas = document.createElement('canvas'); this.flowCanvas.width = 1080; this.flowCanvas.height = 960; this.flowTex = new T.CanvasTexture(this.flowCanvas); this.flowTex.colorSpace = T.NoColorSpace;
    this.flowMesh = new T.Mesh(domGeo(), new T.ShaderMaterial({ uniforms: { domElev: { value: domElev }, disp: { value: DISP }, lift: { value: 0.004 }, wxTex: { value: this.flowTex } }, vertexShader: SHELL_VS, fragmentShader: WX_FS, transparent: true, depthWrite: false }));
    this.flowMesh.visible = false; this.globe.add(this.flowMesh);
    // cloud-proxy shell slightly above the surface (fed by setClouds) + impact highlight shell (setHighlight)
    this.cData = new Uint8Array(36 * 32 * 4); this.cTex = new T.DataTexture(this.cData, 36, 32, T.RGBAFormat); this.cTex.magFilter = this.cTex.minFilter = T.LinearFilter; this.cTex.needsUpdate = true;
    this.cloudU = { cTex: { value: this.cTex }, maskTex: { value: null }, sunDir: this.uni.sunDir, time: { value: 0 }, fade: { value: 0 }, domElev: { value: domElev }, disp: { value: 0 }, lift: { value: 0.012 } };
    this.cloudMesh = new T.Mesh(domGeo(), new T.ShaderMaterial({ uniforms: this.cloudU, vertexShader: SHELL_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false }));
    this.cloudMesh.visible = false; this.cloudMesh.renderOrder = 3; this.globe.add(this.cloudMesh);
    this.hiCanvas = document.createElement('canvas'); this.hiCanvas.width = 720; this.hiCanvas.height = 640; this.hiTex = new T.CanvasTexture(this.hiCanvas);
    this.hiU = { hiTex: { value: this.hiTex }, time: { value: 0 }, fade: { value: 0 }, domElev: { value: domElev }, disp: { value: DISP }, lift: { value: 0.005 } };
    this.hiMesh = new T.Mesh(domGeo(), new T.ShaderMaterial({ uniforms: this.hiU, vertexShader: SHELL_VS, fragmentShader: HI_FS, transparent: true, depthWrite: false }));
    this.hiMesh.visible = false; this.hiMesh.renderOrder = 5; this.globe.add(this.hiMesh);
    this.pins = new T.Group(); this.globe.add(this.pins); this.pinRings = []; this.labelSprites = [];
    [['WARM-OCEAN TEST', 14, 88], ['MONSOON-STALL TEST', 14, 70]].forEach(([t, la, lo]) => { const at = this.vec(la, lo).multiplyScalar(1.012);
      const dot = new T.Sprite(new T.SpriteMaterial({ map: dotTex, transparent: true, depthWrite: false })); dot.scale.set(0.028, 0.028, 1); dot.position.copy(at); this.pins.add(dot);
      const ring = new T.Sprite(new T.SpriteMaterial({ map: pinTex, transparent: true, depthWrite: false })); ring.position.copy(at); this.pins.add(ring); this.pinRings.push(ring);
      const c = document.createElement('canvas'); c.width = 512; c.height = 80; const x = c.getContext('2d'); x.font = '600 34px Inter, sans-serif'; x.textAlign = 'center'; x.shadowColor = 'rgba(0,0,0,0.9)'; x.shadowBlur = 8; x.fillStyle = 'rgba(245,235,192,0.95)'; x.fillText(t, 256, 50);
      const lb = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false })); lb.scale.set(0.16, 0.025, 1); lb.position.copy(this.vec(la - 1.6, lo).multiplyScalar(1.012)); this.pins.add(lb);
      this.labelSprites.push({ s: lb, alts: [[la - 1.6, lo], [la, lo + 6.2], [la + 1.6, lo], [la, lo - 6.2]].map(([a, o]) => this.vec(a, o).multiplyScalar(1.012)) }); });
    // neighbouring-country names written on the surface (none on India)
    LABELS.forEach(([n, la, lo, k]) => { k = k || 1;
      const c = document.createElement('canvas'); c.width = 512; c.height = 96; const x = c.getContext('2d'); x.font = '500 40px Fredoka, Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.shadowColor = 'rgba(0,0,0,0.85)'; x.shadowBlur = 10; x.fillStyle = 'rgba(236,246,242,0.82)'; x.fillText(n.split('').join(String.fromCharCode(8202)), 256, 48);
      const s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false })); s.scale.set(0.17 * k, 0.032 * k, 1); s.position.copy(this.vec(la, lo).multiplyScalar(1.03)); this.globe.add(s); this.labelSprites.push({ s }); });
    this.shellDisp = []; this.globe.traverse(o => { if (o.material && o.material.uniforms && o.material.uniforms.domElev) this.shellDisp.push(o.material.uniforms.disp); });
    this.updateSky(); this.aim(20, 80);
    this.tick = setInterval(() => this.updateSky(), 5000);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(cv.parentElement); this.resize();
    this.bindInput();
    const loop = () => { if (this.dead) return;
      this.sunU.time.value = performance.now() / 1000;
      this.stepFlow();
      const now = performance.now() / 1000; this.cloudU.time.value = now; this.hiU.time.value = now;
      this.cloudU.fade.value += (((this.on && this.on.clouds) ? 1 : 0) - this.cloudU.fade.value) * 0.08; this.cloudMesh.visible = this.cloudU.fade.value > 0.01 && !!this.cloudU.maskTex.value;
      this.hiU.fade.value += ((this.hiOn ? 1 : 0) - this.hiU.fade.value) * 0.15; this.hiMesh.visible = this.hiU.fade.value > 0.01;
      if (this.marker.visible) { const q = (performance.now() / 1200) % 1; this.markerPulse.scale.setScalar(1 + 0.6 * q); this.markerPulse.material.opacity = 0.8 * (1 - q); }
      const ph = (performance.now() / 1400) % 1; this.pinRings.forEach(rr => { const sz = 0.03 + 0.05 * ph; rr.scale.set(sz, sz, 1); rr.material.opacity = 1 - ph; }); this.pins.visible = this.view.showPins;
      this.hlU.fade.value += (this.fadeTo - this.hlU.fade.value) * 0.22; if (this.fadeTo === 0 && this.hlU.fade.value < 0.01) this.liftMesh.visible = false;
      this.cam.position.set(0, 0, this.dist).applyQuaternion(this.camQ); this.cam.quaternion.copy(this.camQ);
      this.globe.updateMatrixWorld(); this.placeLabels();
      r.render(sc, this.cam); requestAnimationFrame(loop); };
    loop();
  }
  dispose() { this.dead = true; clearInterval(this.tick); if (this.ro) this.ro.disconnect(); this.renderer.dispose(); }

  // ---- time + sky -----------------------------------------------------------------------------------------
  /** Sky clock. mode 'noon'|'dusk'|'night': the scenario date (start preset day + timeline day) at that IST time;
   *  'today': today's real sky, ticking. The weather never follows this clock; it is decoration and lighting only. */
  setSky({ mode, dateIso, day }) { const o = this.sky0, changed = mode !== o.mode || dateIso !== o.dateIso; this.sky0 = { mode, dateIso, day: day || 0 };
    if (changed && o.dateIso !== undefined) { this.updateSky(); if (mode !== o.mode) this.aim(20, 80); } else this.updateSky(); }
  now() { const { mode, dateIso, day } = this.sky0, t = TIMES.find(x => x.id === mode);
    if (!t || mode === 'today' || !dateIso) return new Date();
    const [y, m, d] = dateIso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, t.h, t.m) - 5.5 * 3600000 + day * 86400000); }
  w(v) { return new T.Vector3(v[0], v[2], -v[1]); }   // ECI (x, y, z-north) -> scene (x, y-up, z)
  updateSky() {
    const d = this.now(), k = sky(d); this.sky = k;
    const sdir = this.w(k.Sun).normalize(); this.uni.sunDir.value.copy(sdir); this.sunLight.position.copy(sdir);
    this.globe.rotation.set(0, k.gmst * RAD, 0);
    this.sun.position.copy(this.w(k.Sun).multiplyScalar(AU));
    Object.entries(this.bodies).forEach(([n, b]) => { if (n === 'Moon') b.grp.position.copy(this.w(k[n]).normalize().multiplyScalar(b.dist));
      else { const v = this.w(k[n]).multiplyScalar(AU); b.grp.position.copy(v); b.grp.scale.setScalar(v.length() / 700); }
      if (b.grp.ring) { const pole = this.w([cd(83.54) * cd(40.59), cd(83.54) * sd(40.59), sd(83.54)]); b.grp.ring.lookAt(b.grp.position.clone().add(pole)); } });
    if (!this.orbitT || Math.abs(this.orbitT - k.T) > 0.0005) { this.orbitT = k.T; while (this.orbits.children.length) { const c = this.orbits.children.pop(); c.geometry.dispose(); }
      ['EM', ...PLANETS.map(p => p.n)].forEach(nm => { const pts = []; for (let m = -180; m <= 180; m += 1) { const h = helio(nm, k.T, m); pts.push(this.w(toEq(h.map((x, j) => x - k.em[j]))).multiplyScalar(AU)); }
        const earth = nm === 'EM'; this.orbits.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: earth ? 0x7fd8be : 0x9fc2b6, transparent: true, opacity: earth ? 0.55 : 0.28, depthWrite: false }))); }); }
    const ist = new Date(d.getTime() + 5.5 * 3600000), mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][ist.getUTCMonth()];
    this.cb.onClock && this.cb.onClock(ist.getUTCDate() + ' ' + mo + ' ' + ist.getUTCFullYear() + ' · ' + String(ist.getUTCHours()).padStart(2, '0') + ':' + String(ist.getUTCMinutes()).padStart(2, '0') + ' IST' + (this.sky0.mode === 'today' ? ' · today, sky only' : ''));
  }
  resize() { const el = this.cv.parentElement, w = el.clientWidth, h = el.clientHeight; this.renderer.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }

  // ---- camera ---------------------------------------------------------------------------------------------
  vec(lat, lon) { return new T.Vector3(Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.sin(lat * RAD), -Math.cos(lat * RAD) * Math.sin(lon * RAD)); }
  worldOf(lat, lon) { return this.vec(lat, lon).applyAxisAngle(new T.Vector3(0, 1, 0), this.globe.rotation.y); }
  lookFrom(dir, up) { const m = new T.Matrix4().lookAt(dir.clone().normalize(), new T.Vector3(0, 0, 0), up || new T.Vector3(0, 1, 0)); this.camQ.setFromRotationMatrix(m); }
  aim(lat, lon) { if (this.sky) this.globe.rotation.y = this.sky.gmst * RAD; this.lookFrom(this.worldOf(lat, lon)); }
  northUp() { this.lookFrom(new T.Vector3(0, 0, 1).applyQuaternion(this.camQ)); }
  resetView() { this.aim(20, 80); this.dist = 2.3; }
  zoomIn() { this.dist = Math.max(1.12, this.dist * 0.85); }
  zoomOut() { this.dist = Math.min(8.1, this.dist * 1.18); }
  /** Screen position (CSS px, relative to the canvas) of a surface point; used by the browser tests. */
  screenOf(lat, lon) { this.cam.position.set(0, 0, this.dist).applyQuaternion(this.camQ); this.cam.quaternion.copy(this.camQ); this.cam.updateMatrixWorld();
    const p = this.worldOf(lat, lon).project(this.cam), rc = this.cv.getBoundingClientRect(); return { x: rc.left + (p.x + 1) / 2 * rc.width, y: rc.top + (1 - p.y) / 2 * rc.height }; }
  pick(cx, cy) { const rc = this.cv.getBoundingClientRect(); const nd = new T.Vector2((cx - rc.left) / rc.width * 2 - 1, -((cy - rc.top) / rc.height) * 2 + 1);
    this.cam.updateMatrixWorld(); const ray = new T.Raycaster(); ray.setFromCamera(nd, this.cam);
    const o = ray.ray.origin, d = ray.ray.direction, b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c; if (disc < 0) return null;
    const p = o.clone().add(d.clone().multiplyScalar(-b - Math.sqrt(disc)));
    const l = p.clone().applyAxisAngle(new T.Vector3(0, 1, 0), -this.globe.rotation.y);
    return { world: p, lat: Math.asin(Math.max(-1, Math.min(1, l.y))) / RAD, lon: Math.atan2(-l.z, l.x) / RAD, px: cx - rc.left, py: cy - rc.top }; }
  bindInput() {
    const cv = this.cv; let drag = null;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, roll: e.shiftKey || e.button === 2 }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
    cv.addEventListener('pointerup', e => { const moved = drag ? Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) : 99; drag = null; cv.style.cursor = this.placing ? 'crosshair' : 'grab';
      if (this.placing && moved < 5) { const h = this.pick(e.clientX, e.clientY); if (h && h.lat >= DOM.lat0 && h.lat <= DOM.lat1 && h.lon >= DOM.lon0 && h.lon <= DOM.lon1) this.cb.onPlace && this.cb.onPlace(h.lat, h.lon); } });
    cv.addEventListener('pointermove', e => {
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        const k = 0.0016 * Math.min(1.5, Math.max(0.12, this.dist - 1.0)); const q = new T.Quaternion();
        if (drag.roll) q.setFromAxisAngle(new T.Vector3(0, 0, 1), dx * 0.0025);
        else { const ax = new T.Vector3(dy, dx, 0); const len = ax.length(); if (len < 1e-6) return; q.setFromAxisAngle(ax.normalize(), -len * k); }
        this.camQ.multiply(q); return; }
      this.hover(e.clientX, e.clientY); });
    cv.addEventListener('pointerleave', () => { this.clearLift(); this.cb.onHover && this.cb.onHover(null); });
    cv.addEventListener('wheel', e => { e.preventDefault(); const f = Math.exp(e.deltaY * 0.0006), nd = Math.max(1.12, Math.min(8.1, this.dist * f));
      if (nd < this.dist) { const h = this.pick(e.clientX, e.clientY); if (h) { const cd0 = new T.Vector3(0, 0, 1).applyQuaternion(this.camQ); const q = new T.Quaternion().setFromUnitVectors(cd0, h.world.clone().normalize()); const qi = new T.Quaternion().slerp(q, Math.min(0.25, (this.dist - nd) / this.dist * 0.9)); this.camQ.premultiply(qi); } }
      this.dist = nd; }, { passive: false });
    cv.addEventListener('dblclick', e => { const h = this.pick(e.clientX, e.clientY); if (h) { this.lookFrom(h.world); this.dist = Math.max(1.3, this.dist * 0.7); } });
  }

  // ---- geography ------------------------------------------------------------------------------------------
  setGeo(G) { this.G = G; this.buildMask(); this.paintWx(); }
  isIndian(id) { return this.G && (this.G.indian.has(id) || id === this.G.unassigned); }
  regionAt(la, lo) { const g = this.G; if (!g) return 0; const r = Math.floor((DOM.lat1 - la) / g.res), c = Math.floor((lo - DOM.lon0) / g.res); if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return 0; return g.reg[r * g.cols + c]; }
  elevAt(la, lo) { const e = this.G && this.G.elev; if (!e) return 0; let r = (DOM.lat1 - la) / e.res - 0.5, c = (lo - DOM.lon0) / e.res - 0.5; r = Math.max(0, Math.min(e.rows - 1, r)); c = Math.max(0, Math.min(e.cols - 1, c));
    const r0 = Math.floor(r), c0 = Math.floor(c), r1 = Math.min(e.rows - 1, r0 + 1), c1 = Math.min(e.cols - 1, c0 + 1), fr = r - r0, fc = c - c0, z = (i, j) => e.z[i * e.cols + j];
    return (z(r0, c0) * (1 - fc) + z(r0, c1) * fc) * (1 - fr) + (z(r1, c0) * (1 - fc) + z(r1, c1) * fc) * fr; }
  buildMask() {
    // India + nearby seas (fading with distance from the coast); other countries' land is always 0
    const g = this.G, W = g.cols, H = g.rows, f = 1, inI = new Uint8Array(W * H), foreign = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let ni = 0, nf = 0; for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const id = g.reg[(y * f + dy) * g.cols + (x * f + dx)]; if (this.isIndian(id)) ni++; else if (id > 0) nf++; } inI[y * W + x] = 2 * ni >= f * f ? 1 : 0; foreign[y * W + x] = 2 * nf >= f * f ? 1 : 0; }
    const D = new Float32Array(W * H).fill(1e9); for (let i = 0; i < W * H; i++) if (inI[i]) D[i] = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (x > 0) D[i] = Math.min(D[i], D[i - 1] + 1); if (y > 0) D[i] = Math.min(D[i], D[i - W] + 1); if (x > 0 && y > 0) D[i] = Math.min(D[i], D[i - W - 1] + 1.414); if (x < W - 1 && y > 0) D[i] = Math.min(D[i], D[i - W + 1] + 1.414); }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (x < W - 1) D[i] = Math.min(D[i], D[i + 1] + 1); if (y < H - 1) D[i] = Math.min(D[i], D[i + W] + 1); if (x < W - 1 && y < H - 1) D[i] = Math.min(D[i], D[i + W + 1] + 1.414); if (x > 0 && y < H - 1) D[i] = Math.min(D[i], D[i + W - 1] + 1.414); }
    const M = new Float32Array(W * H), c = document.createElement('canvas'); c.width = W; c.height = H; const cx = c.getContext('2d'), img = cx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const v = inI[i] ? 1 : (foreign[i] ? 0 : Math.max(0, Math.min(1, 1 - (D[i] * g.res - 2.5) / 3.5))); M[i] = v; img.data[i * 4 + 3] = Math.round(255 * v); }
    cx.putImageData(img, 0, 0); this.mask = c; this.maskA = M; this.cloudU.maskTex.value = new T.CanvasTexture(c); }
  maskAt(la, lo) { const W = this.mask.width, H = this.mask.height, x = Math.floor((lo - DOM.lon0) / 36 * W), y = Math.floor((DOM.lat1 - la) / 32 * H); if (x < 0 || y < 0 || x >= W || y >= H) return 0; return this.maskA[y * W + x]; }

  // ---- layers ---------------------------------------------------------------------------------------------
  setLayers(on) { this.on = on; const d = on.terrain ? DISP : 0; this.uni.disp.value = d; this.uni.lightsOn.value = on.lights ? 1 : 0; this.uni.bordersOn.value = on.borders ? 1 : 0; this.shellDisp.forEach(u => (u.value = d)); this.paintWx(); }
  /** view = {frame: {t2m,tp,u,v,msl,tcwv,ws} in display units, flow: frame for wind particles, mode: 'prime'|'branch'|'diff', showCells, showPins} */
  setView(view) { this.view = { ...this.view, ...view }; this.paintWx(); }
  /** cloud proxy for the shown day: {cover, rain} 0..1 and wind {u, v} m/s, flat north-first 32x36 arrays */
  setClouds(c) { if (!c) return; const D = this.cData, enc = x => Math.max(0, Math.min(255, Math.round((0.5 + x / 30) * 255)));
    for (let r = 0; r < 32; r++) for (let k = 0; k < 36; k++) { const i = r * 36 + k, o = ((31 - r) * 36 + k) * 4;
      D[o] = Math.round(255 * c.cover[i]); D[o + 1] = Math.round(255 * c.rain[i]); D[o + 2] = enc(c.u[i]); D[o + 3] = enc(c.v[i]); }
    this.cTex.needsUpdate = true; }
  /** highlight the area covered by cells [[lat, lon], ...] as a smooth glowing outline + light fill (null clears).
   *  The 1 deg cells are blurred into a smooth field, cut at half height on the fine 0.05 deg grid, clipped to the mask. */
  setHighlight(cells, rgb = '233,215,138') { this.hiOn = !!(cells && cells.length && this.maskA); if (!this.hiOn) return;
    const W = this.mask.width, H = this.mask.height, sm = document.createElement('canvas'); sm.width = 36; sm.height = 32; const sx = sm.getContext('2d');
    sx.fillStyle = '#fff'; cells.forEach(([la, lo]) => sx.fillRect(Math.round(lo - 65.5), Math.round(37.5 - la), 1, 1));
    const bl = document.createElement('canvas'); bl.width = W; bl.height = H; const bx = bl.getContext('2d'); bx.imageSmoothingEnabled = true;
    bx.filter = `blur(${Math.round(W / 36 * 0.45)}px)`; bx.drawImage(sm, 0, 0, W, H); const A = bx.getImageData(0, 0, W, H).data;
    const inside = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) inside[i] = A[i * 4 + 3] > 100 && this.maskA[i] > 0.5 ? 1 : 0;
    const fill = new ImageData(W, H), edge = new ImageData(W, H), [r, g, b] = rgb.split(',').map(Number);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (!inside[i]) continue;
      fill.data.set([r, g, b, 60], i * 4);
      let e = false; for (let k = 1; k <= 2 && !e; k++) e = !inside[i - k] || !inside[i + k] || !inside[i - k * W] || !inside[i + k * W];
      if (e) edge.data.set([r, g, b, 255], i * 4); }
    const ec = document.createElement('canvas'); ec.width = W; ec.height = H; ec.getContext('2d').putImageData(edge, 0, 0);
    const fc = document.createElement('canvas'); fc.width = W; fc.height = H; fc.getContext('2d').putImageData(fill, 0, 0);
    const CW = this.hiCanvas.width, CH = this.hiCanvas.height, x = this.hiCanvas.getContext('2d'); x.clearRect(0, 0, CW, CH); x.imageSmoothingEnabled = true;
    x.drawImage(fc, 0, 0, CW, CH);
    x.filter = 'blur(6px)'; x.drawImage(ec, 0, 0, CW, CH); x.drawImage(ec, 0, 0, CW, CH);
    x.filter = 'blur(1.5px)'; x.drawImage(ec, 0, 0, CW, CH); x.filter = 'none'; x.drawImage(ec, 0, 0, CW, CH);
    x.save(); x.globalCompositeOperation = 'destination-in'; x.drawImage(this.mask, 0, 0, CW, CH); x.restore();
    this.hiTex.needsUpdate = true; }
  /** screen rectangles (canvas pixels) that labels must not sit under: [{x, y, w, h}] */
  setKeepOut(rects) { this.keepOut = rects || []; }
  /** place labels: country names hide under panels; test-pin labels move to a free side of the pin */
  placeLabels() { if (!this.labelSprites) return; const ko = this.keepOut || [], h = this.cv.clientHeight, w = this.cv.clientWidth;
    const v = new T.Vector3(), cp = this.cam.position, tf = 2 * Math.tan(this.cam.fov * RAD / 2);
    const box = (sp, pos) => { v.copy(pos).applyMatrix4(this.globe.matrixWorld); const d = v.distanceTo(cp), ppu = h / (tf * d); v.project(this.cam);
      const cx = (v.x + 1) / 2 * w, cy = (1 - v.y) / 2 * h, hw = sp.scale.x * ppu / 2 * 0.8, hh = sp.scale.y * ppu / 2 * 0.8; return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh }; };
    const hit = b => ko.some(r => b.x1 > r.x && b.x0 < r.x + r.w && b.y1 > r.y && b.y0 < r.y + r.h);
    for (const L of this.labelSprites) { L.s.renderOrder = 10; if (!L.alts) { L.s.visible = !hit(box(L.s, L.s.position)); continue; }
      const free = L.alts.find(a => !hit(box(L.s, a))); if (free) { L.s.position.copy(free); L.s.visible = true; } else L.s.visible = false; } }
  grid(key, la, lo) { const a = this.view.frame && this.view.frame[key]; if (!a) return 0; let gy = 37.5 - la, gx = lo - 65.5; gy = Math.max(0, Math.min(31, gy)); gx = Math.max(0, Math.min(35, gx));
    const y0 = Math.floor(gy), x0 = Math.floor(gx), y1 = Math.min(31, y0 + 1), x1 = Math.min(35, x0 + 1), fy = gy - y0, fx = gx - x0, v = (r, c) => a[r * 36 + c];
    return (v(y0, x0) * (1 - fx) + v(y0, x1) * fx) * (1 - fy) + (v(y1, x0) * (1 - fx) + v(y1, x1) * fx) * fy; }
  paintElev(ctx, W, H) { const w = 720, h = 640, s = document.createElement('canvas'); s.width = w; s.height = h; const sc = s.getContext('2d'), img = sc.createImageData(w, h), Z = new Float32Array(w * h);
    const LANDR = [[0, '#2E6B4F'], [200, '#5E8F57'], [500, '#9DAA62'], [1000, '#C9B26B'], [2000, '#B07A4F'], [3500, '#8C6E5E'], [5000, '#E6E6E2']], SEAR = [[-6000, '#0B2238'], [-3000, '#12385A'], [-1000, '#1C5577'], [-150, '#2F7C93'], [0, '#4B9AA6']];
    const rp = (st, z) => { for (let k = 1; k < st.length; k++) if (z <= st[k][0]) { const t = (z - st[k - 1][0]) / (st[k][0] - st[k - 1][0]); const a = hex(st[k - 1][1]), b = hex(st[k][1]); return a.map((x, j) => x + (b[j] - x) * t); } return hex(st[st.length - 1][1]); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const la = DOM.lat1 - (y + 0.5) / h * 32, lo = DOM.lon0 + (x + 0.5) / w * 36; Z[y * w + x] = this.elevAt(la, lo); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, z = Z[i], c = z >= 0 ? rp(LANDR, Math.min(z, 5000)) : rp(SEAR, Math.max(z, -6000));
      const band = k => Math.floor(k / 500); const edge = (x < w - 1 && band(Z[i + 1]) !== band(z)) || (y < h - 1 && band(Z[i + w]) !== band(z));
      const o = edge ? c.map(v => v * 0.55 + 255 * 0.45 * (z >= 0 ? 0.6 : 0.3)) : c; img.data[i * 4] = o[0]; img.data[i * 4 + 1] = o[1]; img.data[i * 4 + 2] = o[2]; img.data[i * 4 + 3] = Math.round(255 * 0.86); }
    sc.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(s, 0, 0, W, H); }
  paintField(ctx, W, H, key, colorAt) { const sw = 360, sh = 320, c = document.createElement('canvas'); c.width = sw; c.height = sh; const x2 = c.getContext('2d'), img = x2.createImageData(sw, sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const la = DOM.lat1 - (y + 0.5) / sh * 32, lo = DOM.lon0 + (x + 0.5) / sw * 36, v = this.grid(key, la, lo), o = colorAt(v), i = (y * sw + x) * 4;
      const edge = Math.min(la - DOM.lat0, DOM.lat1 - la, lo - DOM.lon0, DOM.lon1 - lo), fade = Math.min(1, edge / 1.2);
      img.data[i] = o[0]; img.data[i + 1] = o[1]; img.data[i + 2] = o[2]; img.data[i + 3] = 255 * o[3] * fade; }
    x2.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(c, 0, 0, W, H); }
  paintWx() {
    if (!this.wxCanvas || !this.mask) return;
    const W = 1440, H = 1280, ctx = this.wxCanvas.getContext('2d'), on = this.on, fr = this.view.frame; ctx.clearRect(0, 0, W, H);
    const X = lo => (lo - DOM.lon0) / 36 * W, Y = la => (DOM.lat1 - la) / 32 * H, diff = this.view.mode === 'diff';
    const dv = (R, amax) => v => { const c = ramp(DIV, 0.5 + v / (2 * R)); return [c[0], c[1], c[2], Math.min(1, Math.pow(Math.abs(v) / R, 0.7)) * amax]; };
    if (on.elev) this.paintElev(ctx, W, H);
    if (fr) {
      if (on.heat) { const L = LAYERS.find(l => l.id === 't2m'); this.paintField(ctx, W, H, 't2m', diff ? dv(3, 0.7) : v => { const c = ramp(TEMPP, (v - L.lo) / (L.hi - L.lo)); return [c[0], c[1], c[2], on.elev ? 0.38 : 0.5]; }); }
      if (on.moisture) this.paintField(ctx, W, H, 'tcwv', diff ? dv(10, 0.6) : v => [236, 250, 255, Math.min(0.55, Math.max(0, (v - 38) / 45))]);
      if (on.rain) this.paintField(ctx, W, H, 'tp', diff ? dv(15, 0.75) : v => { const c = ramp(RAINP, Math.min(1, v / 60)); return [c[0], c[1], c[2], Math.min(0.85, Math.max(0, (v - 1) / 30))]; });
      if (on.pressure) { const sw = 720, sh = 640, c = document.createElement('canvas'); c.width = sw; c.height = sh; const x2 = c.getContext('2d'), img = x2.createImageData(sw, sh), Pz = new Float32Array(sw * sh), step = diff ? 0.5 : 2;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) Pz[y * sw + x] = this.grid('msl', DOM.lat1 - (y + 0.5) / sh * 32, DOM.lon0 + (x + 0.5) / sw * 36);
        for (let y = 0; y < sh - 1; y++) for (let x = 0; x < sw - 1; x++) { const i = y * sw + x, b0 = Math.floor(Pz[i] / step); if (b0 !== Math.floor(Pz[i + 1] / step) || b0 !== Math.floor(Pz[i + sw] / step)) { img.data[i * 4] = 240; img.data[i * 4 + 1] = 246; img.data[i * 4 + 2] = 243; img.data[i * 4 + 3] = 200; } }
        x2.putImageData(img, 0, 0); ctx.drawImage(c, 0, 0, W, H);
        const A = fr.msl; let mi = 0, ma = 0; for (let i = 0; i < 1152; i++) { if (A[i] < A[mi]) mi = i; if (A[i] > A[ma]) ma = i; }
        ctx.font = '700 40px Fredoka, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
        [[mi, diff ? '−' : 'L', '#9FD3FF'], [ma, diff ? '+' : 'H', '#FFD27A']].forEach(([i, t, col]) => { const r = Math.floor(i / 36), cc = i % 36; ctx.fillStyle = col; ctx.fillText(t, X(65.5 + cc), Y(37.5 - r) + 14);
          ctx.font = '500 22px Inter, sans-serif'; ctx.fillText((diff && A[i] > 0 ? '+' : '') + A[i].toFixed(diff ? 1 : 0), X(65.5 + cc), Y(37.5 - r) + 40); ctx.font = '700 40px Fredoka, Inter, sans-serif'; }); ctx.shadowBlur = 0; }
    }
    if (this.view.showCells) { ctx.strokeStyle = 'rgba(231,242,238,0.3)'; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let lo = DOM.lon0; lo <= DOM.lon1; lo++) { ctx.moveTo(X(lo), 0); ctx.lineTo(X(lo), H); } for (let la = DOM.lat0; la <= DOM.lat1; la++) { ctx.moveTo(0, Y(la)); ctx.lineTo(W, Y(la)); } ctx.stroke(); }
    // weather only over India + nearby seas, never over other countries
    ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.filter = 'blur(0.6px)'; ctx.imageSmoothingEnabled = true; ctx.drawImage(this.mask, 0, 0, W, H); ctx.restore();
    this.wxTex.needsUpdate = true; }
  stepFlow() {
    const fl = this.view.flow, on = this.on.wind && fl; this.flowMesh.visible = !!on; if (!on || !this.maskA) return;
    const W = 1080, H = 960, ctx = this.flowCanvas.getContext('2d'), U = fl.u, V = fl.v;
    const g = (A, la, lo) => { let gy = 37.5 - la, gx = lo - 65.5; gy = Math.max(0, Math.min(31, gy)); gx = Math.max(0, Math.min(35, gx)); const y0 = Math.floor(gy), x0 = Math.floor(gx), y1 = Math.min(31, y0 + 1), x1 = Math.min(35, x0 + 1), fy = gy - y0, fx = gx - x0;
      return (A[y0 * 36 + x0] * (1 - fx) + A[y0 * 36 + x1] * fx) * (1 - fy) + (A[y1 * 36 + x0] * (1 - fx) + A[y1 * 36 + x1] * fx) * fy; };
    if (this.parts.length === 0) for (let i = 0; i < 2600; i++) this.parts.push({ la: DOM.lat0 + Math.random() * 32, lo: DOM.lon0 + Math.random() * 36, age: Math.random() * 120 });
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.09)'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    const X = lo => (lo - DOM.lon0) / 36 * W, Y = la => (DOM.lat1 - la) / 32 * H;
    for (const p of this.parts) { const u = g(U, p.la, p.lo), v = g(V, p.la, p.lo), sp = Math.hypot(u, v), k = 0.006;
      const la2 = p.la + v * k, lo2 = p.lo + u * k / Math.cos(p.la * RAD); const a = Math.min(1, 0.25 + sp / 8);
      ctx.strokeStyle = 'rgba(' + Math.round(200 + 55 * Math.min(1, sp / 10)) + ',' + Math.round(235 - 30 * Math.min(1, sp / 10)) + ',225,' + a + ')';
      const mA = this.maskAt(p.la, p.lo); if (mA > 0.05) { ctx.globalAlpha = mA; ctx.beginPath(); ctx.moveTo(X(p.lo), Y(p.la)); ctx.lineTo(X(lo2), Y(la2)); ctx.stroke(); ctx.globalAlpha = 1; } p.la = la2; p.lo = lo2; p.age++;
      if (p.age > 140 || la2 < DOM.lat0 || la2 > DOM.lat1 || lo2 < DOM.lon0 || lo2 > DOM.lon1) { p.la = DOM.lat0 + Math.random() * 32; p.lo = DOM.lon0 + Math.random() * 36; p.age = 0; } }
    ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(this.mask, 0, 0, W, H); ctx.restore();
    this.flowTex.needsUpdate = true; }

  // ---- marker, placing, hover --------------------------------------------------------------------------
  setPlacing(on) { this.placing = on; this.cv.style.cursor = on ? 'crosshair' : 'grab'; }
  /** show a drop marker of radius radiusDeg (degrees) at center */
  setMarker({ show, center, radiusDeg }) { this.mk = { show, center, radiusDeg }; this.placeMarker(); }
  /** outline a lat/lon box [lat0, lat1, lon0, lon1] on the globe (judge shocks), or null */
  setBox(box) { if (this.boxLine) { this.globe.remove(this.boxLine); this.boxLine.geometry.dispose(); this.boxLine = null; } if (!box) return;
    const [a0, a1, b0, b1] = box, pts = [], e = 1.011;
    for (let lo = b0; lo <= b1; lo += 0.5) pts.push(this.vec(a0, lo).multiplyScalar(e)); for (let la = a0; la <= a1; la += 0.5) pts.push(this.vec(la, b1).multiplyScalar(e));
    for (let lo = b1; lo >= b0; lo -= 0.5) pts.push(this.vec(a1, lo).multiplyScalar(e)); for (let la = a1; la >= a0; la -= 0.5) pts.push(this.vec(la, b0).multiplyScalar(e));
    this.boxLine = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineDashedMaterial({ color: 0xe9d78a, dashSize: 0.01, gapSize: 0.006, transparent: true, opacity: 0.95 }));
    this.boxLine.computeLineDistances(); this.globe.add(this.boxLine); }
  /** cyclone track [{day, lat, lon}] as a line with day markers, or null */
  setTrack(track) { if (this.trackGrp) { this.globe.remove(this.trackGrp); this.trackGrp = null; } if (!track || !track.length) return;
    const g = this.trackGrp = new T.Group(), e = 1.014;
    g.add(new T.Line(new T.BufferGeometry().setFromPoints(track.map(t => this.vec(t.lat, t.lon).multiplyScalar(e))), new T.LineBasicMaterial({ color: 0xff8a5b, transparent: true, opacity: 0.95, depthWrite: false })));
    const seen = new Set();
    track.forEach(t => { const key = t.lat + ',' + t.lon; const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d');
      x.fillStyle = 'rgba(255,138,91,0.95)'; x.beginPath(); x.arc(48, 48, 15, 0, Math.PI * 2); x.fill();
      if (!seen.has(key)) { x.font = '600 34px Inter, sans-serif'; x.fillStyle = '#fff'; x.textAlign = 'center'; x.shadowColor = '#000'; x.shadowBlur = 6; x.fillText(String(t.day), 48, 30); }
      seen.add(key); const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
      sp.scale.set(0.03, 0.03, 1); sp.position.copy(this.vec(t.lat, t.lon).multiplyScalar(e)); g.add(sp); });
    this.globe.add(g); }
  placeMarker(at) { const m = this.mk, c = at || m.center;
    if (!(m.show || at) || !c) { this.marker.visible = false; return; } const n = this.vec(c[0], c[1]);
    this.marker.position.copy(n.clone().multiplyScalar(1.009)); this.marker.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), n); this.marker.scale.setScalar((m.radiusDeg || 3) * RAD); this.marker.visible = true; }
  clearLift() { this.fadeTo = 0; this.curRegion = -1; }
  lift(id) {
    if (id === this.curRegion) return; this.curRegion = id;
    if (!id || !this.G.indian.has(id)) { this.fadeTo = 0; return; }            // only Indian states react
    const W = 720, H = 640, reg = this.G.reg, edge = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c; if (reg[i] !== id) continue;
      if (r === 0 || c === 0 || r === H - 1 || c === W - 1 || reg[i - 1] !== id || reg[i + 1] !== id || reg[i - W] !== id || reg[i + W] !== id) edge[i] = 1; }
    const mc = this.maskCanvas.getContext('2d'); mc.clearRect(0, 0, W, H);
    const fill = mc.createImageData(W, H); for (let i = 0; i < W * H; i++) if (reg[i] === id) { fill.data[i * 4] = 255; fill.data[i * 4 + 1] = 255; fill.data[i * 4 + 2] = 245; fill.data[i * 4 + 3] = 34; }
    mc.putImageData(fill, 0, 0);
    const ec = document.createElement('canvas'); ec.width = W; ec.height = H; const ex = ec.getContext('2d'), ed = ex.createImageData(W, H);
    for (let i = 0; i < W * H; i++) if (edge[i]) { ed.data[i * 4] = 127; ed.data[i * 4 + 1] = 230; ed.data[i * 4 + 2] = 200; ed.data[i * 4 + 3] = 255; } ex.putImageData(ed, 0, 0);
    mc.save(); mc.filter = 'blur(4px)'; mc.globalAlpha = 0.9; mc.drawImage(ec, 0, 0); mc.drawImage(ec, 0, 0); mc.restore(); mc.drawImage(ec, 0, 0);
    this.maskTex.needsUpdate = true; this.liftMesh.visible = true; this.hlU.fade.value = 0; this.fadeTo = 1; }
  hover(cx, cy) {
    if (!this.G) return; const h = this.pick(cx, cy); if (!h) { this.clearLift(); this.cb.onHover && this.cb.onHover(null); return; }
    const inDom = h.lat >= DOM.lat0 && h.lat <= DOM.lat1 && h.lon >= DOM.lon0 && h.lon <= DOM.lon1, id = inDom ? this.regionAt(h.lat, h.lon) : 0;
    if (this.placing && inDom) this.placeMarker([h.lat, h.lon]);
    this.lift(id);
    const now = performance.now(); if (this.lastSet && now - this.lastSet < 30) return; this.lastSet = now;
    const vals = inDom && this.view.frame ? Object.fromEntries(['t2m', 'tp', 'ws', 'msl', 'tcwv'].map(k => [k, this.grid(k, h.lat, h.lon)])) : null;
    this.cb.onHover && this.cb.onHover({ la: h.lat, lo: h.lon, inDom, id, px: h.px, py: h.py, elev: inDom ? this.elevAt(h.lat, h.lon) : null, vals });
  }
}
