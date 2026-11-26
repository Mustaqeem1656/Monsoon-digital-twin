// End-to-end browser test of the dashboard against the LIVE gateway + serve.py.
// Start serve.py (:8000), the gateway (:8100) and `npm run preview` (:5173), then:  node tests/e2e.mjs
// Uses the installed Microsoft Edge or Chrome through playwright-core (no browser download). Screenshots -> tests/shots/
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.DASH_URL || 'http://127.0.0.1:5173/';
import { fileURLToPath } from 'node:url';
const OUT = fileURLToPath(new globalThis.URL('./shots/', import.meta.url)); fs.mkdirSync(OUT, { recursive: true });
const results = []; const ok = (c, m) => { results.push([c, m]); console.log((c ? '  ok   ' : '  FAIL ') + m); };
const channel = process.env.BROWSER || 'msedge';
const browser = await chromium.launch({ channel, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const shot = n => page.screenshot({ path: OUT + n + '.png' });
const caption = () => page.locator('text=/^(Prime|Earth-B)/').last().innerText();
const at = (la, lo) => page.evaluate(([a, b]) => window.__globe.screenOf(a, b), [la, lo]);
const wxAlpha = (la, lo) => page.evaluate(([a, b]) => { const g = window.__globe, c = g.wxCanvas, x = c.getContext('2d');
  const px = Math.floor((b - 65) / 36 * c.width), py = Math.floor((38 - a) / 32 * c.height); return x.getImageData(px - 4, py - 4, 9, 9).data.filter((_, i) => i % 4 === 3).reduce((s, v) => s + v, 0); }, [la, lo]);
const tile = n => page.getByRole('group', { name: 'Map layers' }).getByRole('button', { name: new RegExp('^' + n) });

await page.goto(URL);
await page.waitForFunction(() => document.body.innerText.includes('Prime · start state'), null, { timeout: 60000 });
await page.waitForTimeout(2500);
ok(true, 'page loaded; Prime start state from /presets + /run: "' + await caption() + '"');
ok(await page.locator('text=Engine ready').count() === 1, 'header shows "Engine ready" from gateway /health');
await shot('01_start');

// ---- tiles: each one independently, then a combination ----
const offAll = ['Terrain', 'Borders', 'Heat', 'City lights'];
for (const n of offAll) await tile(n).click();
const u = () => page.evaluate(() => ({ disp: window.__globe.uni.disp.value, lights: window.__globe.uni.lightsOn.value, borders: window.__globe.uni.bordersOn.value, flow: window.__globe.flowMesh.visible }));
let s = await u(); ok(s.disp === 0 && s.lights === 0 && s.borders === 0, 'all globe tiles off: terrain relief, borders and city lights off');
ok(await wxAlpha(22, 78) === 0, 'no weather paint with every weather tile off');
for (const [n, check] of [['Terrain', s => s.disp > 0], ['Borders', s => s.borders === 1], ['City lights', s => s.lights === 1]]) {
  await tile(n).click(); await page.waitForTimeout(300); ok(check(await u()), n + ' tile switches its globe layer on'); await shot('tile_' + n.replace(' ', '_')); await tile(n).click(); }
for (const n of ['Elevation', 'Heat', 'Rain', 'Pressure', 'Moisture']) {
  await tile(n).click(); await page.waitForTimeout(600);
  const [pla, plo] = n === 'Rain' ? await page.evaluate(() => { const g = window.__globe, a = g.view.frame.tp; let best = -1, bi = 0; for (let i = 0; i < a.length; i++) { const la = 37.5 - Math.floor(i / 36), lo = 65.5 + i % 36; if (g.isIndian(g.regionAt(la, lo)) && a[i] > best) { best = a[i]; bi = i; } } return [37.5 - Math.floor(bi / 36), 65.5 + bi % 36]; }) : [22.5, 78.5];
  const india = await wxAlpha(pla, plo), pak = await wxAlpha(29.5, 69.0), china = await wxAlpha(34, 90), sea = await wxAlpha(15, 69);
  ok(india > 0 && pak === 0 && china === 0, `${n}: painted over India (${india}), nothing over Pakistan/China (${pak}/${china}), nearby sea ${sea}`);
  await shot('tile_' + n); await tile(n).click();
}
await tile('Wind'); await tile('Wind').click(); await page.waitForTimeout(1500); ok((await u()).flow, 'Wind tile shows animated wind particles'); await shot('tile_Wind'); await tile('Wind').click();
for (const n of ['Terrain', 'Borders', 'Heat', 'Rain', 'Wind', 'City lights']) await tile(n).click();
await page.waitForTimeout(1200); s = await u();
ok(s.disp > 0 && s.borders === 1 && s.lights === 1 && s.flow && await wxAlpha(22.5, 78.5) > 0, 'any combination at once: Terrain+Borders+Heat+Rain+Wind+City lights together');
await shot('02_combo');

// ---- hover ----
let p = await at(23.3, 77.8); await page.mouse.move(p.x, p.y); await page.waitForTimeout(500);
let body = await page.innerText('body');
ok(/MADHYA PRADESH/.test(body) && /°N/.test(body) && /m above sea level/.test(body), 'hover Madhya Pradesh: tooltip with place, lat/lon, elevation');
ok(await page.evaluate(() => window.__globe.liftMesh.visible && window.__globe.fadeTo === 1), 'hover on an Indian state: soft glow outline');
ok(/WIND SPEED/.test(body) && body.includes('m/s'), 'big Fredoka readout follows the focused layer (Wind, the last weather tile turned on)');
await shot('03_hover_state');
p = await at(30.0, 70.0); await page.mouse.move(p.x, p.y); await page.waitForTimeout(500);
ok(/PAKISTAN/.test(await page.innerText('body')) && await page.evaluate(() => window.__globe.fadeTo === 0), 'hover Pakistan: tooltip but no glow (Indian states only)');
p = await at(15.0, 87.0); await page.mouse.move(p.x, p.y); await page.waitForTimeout(400);
ok(/m below sea level/.test(await page.innerText('body')), 'hover Bay of Bengal: sea depth from the ETOPO1 grid');

// ---- controls ----
const dist = () => page.evaluate(() => window.__globe.dist);
const d0 = await dist(); await page.getByRole('button', { name: 'Zoom in' }).click(); const d1 = await dist();
await page.getByRole('button', { name: 'Zoom out' }).click(); await page.getByRole('button', { name: 'Zoom out' }).click(); const d2 = await dist();
ok(d1 < d0 && d2 > d1, `zoom buttons (${d0.toFixed(2)} -> ${d1.toFixed(2)} -> ${d2.toFixed(2)})`);
p = await at(22, 80); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -400); await page.waitForTimeout(200); ok(await dist() < d2, 'scroll zooms (to cursor)');
await page.mouse.move(800, 480); await page.mouse.down({ button: 'right' }); await page.mouse.move(900, 480, { steps: 8 }); await page.mouse.up({ button: 'right' });
await page.getByRole('button', { name: 'Turn north up' }).click(); await page.getByRole('button', { name: 'Reset view to India' }).click();
ok(Math.abs(await dist() - 2.3) < 1e-6, 'roll, N-up and reset buttons work (reset distance 2.3)');
for (const [n, re] of [['Noon', /12:0\d IST/], ['Dusk', /18:3\d IST/], ['Night', /00:3\d IST/], ['Live', /LIVE/]]) {
  await page.getByRole('button', { name: n, exact: true }).click(); await page.waitForTimeout(300); ok(re.test(await page.innerText('header')), 'time control ' + n + ' (IST clock)'); if (n === 'Night') await shot('04_night'); }
const sunOK = await page.evaluate(() => { const g = window.__globe; return g.sun.position.length() > 1000 && Object.keys(g.bodies).length === 8 && g.orbits.children.length === 8; });
ok(sunOK, 'Sun, Moon and 7 planets placed by the ephemeris, with 8 orbit lines');

// ---- timeline (Prime) ----
await page.getByRole('button', { name: '+5', exact: true }).click(); await page.waitForTimeout(500);
ok(/Prime · day \+5 · model forecast/.test(await caption()), 'timeline +5 shows the live Prime forecast');
await page.getByRole('button', { name: 'Now', exact: true }).click();

// ---- shock flow ----
await page.getByRole('button', { name: '+ Branch a universe' }).click();
ok(await page.getByRole('group', { name: 'Shock type' }).getByRole('button').count() === 9, 'shock panel lists 9 shock types');
await page.getByRole('button', { name: 'Heatwave', exact: true }).click();
await page.getByRole('button', { name: 'Drop it on the map' }).click();
p = await at(45.0, 80.0); await page.mouse.click(p.x, p.y); await page.waitForTimeout(300);
ok(await page.locator('text=Click the globe to drop it').count() === 1, 'a click outside 6–38°N / 65–101°E is ignored');
p = await at(25.0, 78.0); await page.mouse.click(p.x, p.y); await page.waitForTimeout(500);
ok(/Dropped at 2\d\.\d°N 7\d\.\d°E · (Madhya Pradesh|Uttar Pradesh)/.test(await page.innerText('body')), 'drop-anywhere pointer places the shock inside the domain');
const slider = page.locator('input[type=range]').first(); await slider.fill('6');
ok(/\+6 °C/.test(await page.innerText('body')), 'strength slider');
await page.locator('input[type=range]').nth(1).fill('5'); ok(/about 688 km across/.test(await page.innerText('body')), 'size slider');
await shot('05_shock_panel');
const t0 = Date.now(); await page.getByRole('button', { name: 'Run the shock' }).click();
await page.waitForFunction(() => /Earth-B · heatwave/.test(document.body.innerText), null, { timeout: 30000 });
await page.getByRole('button', { name: '+10', exact: true }).click();
await page.waitForFunction(() => /day \+10 · model forecast/.test(document.body.innerText), null, { timeout: 30000 });
ok(true, `Run -> Earth-B tab, all 10 days streamed over /stream in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.getByRole('button', { name: '+1', exact: true }).click(); await page.waitForTimeout(500);
body = await page.innerText('body');
const m = body.match(/OUTCOME · DAY \+1[\s\S]*?([\d,]+)\s*km reached\s*([\d,]+)\s*thousand km² affected\s*([+−-]?[\d.]+)\s*peak Δ ([a-z ]+)/);
ok(!!m, 'outcome panel day +1: ' + (m ? `${m[1]} km reached, ${m[2]} thousand km², peak ${m[3]} (${m[4].trim()})` : 'missing'));
const st = body.match(/MOST AFFECTED STATES[^\n]*\n([\s\S]*?)Use the timeline/); ok(!!st && /Pradesh|Rajasthan|Bihar|Maharashtra|Gujarat|Delhi|Haryana/.test(st[1]), 'top states listed: ' + (st ? st[1].replace(/\s+/g, ' ').trim().slice(0, 120) : ''));
ok(await wxAlpha(25, 78) > 0, 'Difference view paints the change');
await shot('06_outcome_diff_day1');
await page.getByRole('button', { name: 'Full field' }).click(); await page.waitForTimeout(400); await shot('07_full_field_day1');
await page.getByRole('button', { name: 'Difference' }).click();
const played = Date.now(); await page.getByRole('button', { name: 'Play the 10-day rollout' }).click(); await page.waitForTimeout(2600);
ok(/day \+[2-9]/.test(await caption()), 'play advances the timeline: ' + await caption()); await page.getByRole('button', { name: 'Pause the 10-day rollout' }).click();
await page.getByRole('button', { name: 'Timeline Prime' }).click(); ok(/^Prime/.test(await caption()), 'switch back to the Timeline Prime tab');

// judge shortcut
await page.getByRole('button', { name: '+ Branch a universe' }).click();
await page.getByRole('button', { name: 'Judge test · warm Bay of Bengal' }).click();
ok(/Bay of Bengal \(8–20°N, 82–94°E\)/.test(await page.innerText('body')), 'judge-test shortcut fills the warm Bay box');
await page.getByRole('button', { name: 'Run the shock' }).click();
await page.waitForFunction(() => /Earth-B · warm Bay/.test(document.body.innerText), null, { timeout: 30000 });
await page.getByRole('button', { name: '+4', exact: true }).click();
await page.waitForFunction(() => /OUTCOME · DAY \+4[\s\S]*km reached/.test(document.body.innerText) && !/Waiting for the model/.test(document.body.innerText), null, { timeout: 30000 });
body = await page.innerText('body'); const mj = body.match(/OUTCOME · DAY \+4[\s\S]*?([\d,]+)\s*km reached\s*([\d,]+)\s*thousand km²/);
ok(!!mj, 'judge warm-Bay shock, day +4: ' + (mj ? `${mj[1]} km reached, ${mj[2]} thousand km²` : 'missing')); await shot('08_judge_warm_day4');

// custom
await page.getByRole('button', { name: 'New shock' }).click(); await page.getByRole('button', { name: 'Custom', exact: true }).click();
await page.getByRole('button', { name: 'Pressure', exact: true }).last().click();
await page.getByRole('button', { name: /Drop it on the map|Dropped at/ }).click(); p = await at(16, 86); await page.mouse.click(p.x, p.y); await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Run the shock' }).click();
await page.waitForFunction(() => /Earth-B · custom/.test(document.body.innerText), null, { timeout: 30000 });
ok(true, 'custom pressure shock runs');

ok(errors.length === 0, 'no browser console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
const fails = results.filter(r => !r[0]).length;
console.log(`\nRESULT: ${results.length - fails}/${results.length} passed`); process.exit(fails ? 1 : 0);
