// End-to-end browser test of the dashboard against the LIVE gateway + serve.py.
// Start serve.py (:8000), the gateway (:8100) and `npm run preview` (:5173), then:  node tests/e2e.mjs
// Uses the installed Microsoft Edge (BROWSER=chrome to switch) through playwright-core. Screenshots -> tests/shots/
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.env.DASH_URL || 'http://127.0.0.1:5173/';
const OUT = fileURLToPath(new globalThis.URL('./shots/', import.meta.url)); fs.mkdirSync(OUT, { recursive: true });
const results = []; const ok = (c, m) => { results.push([c, m]); console.log((c ? '  ok   ' : '  FAIL ') + m); };
const browser = await chromium.launch({ channel: process.env.BROWSER || 'msedge', args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const shot = n => page.screenshot({ path: OUT + n + '.png' });
const body = () => page.innerText('body');
const caption = () => page.getByTestId('caption').innerText();
const at = (la, lo) => page.evaluate(([a, b]) => window.__globe.screenOf(a, b), [la, lo]);
const wxAlpha = (la, lo) => page.evaluate(([a, b]) => { const g = window.__globe, c = g.wxCanvas, x = c.getContext('2d');
  const px = Math.floor((b - 65) / 36 * c.width), py = Math.floor((38 - a) / 32 * c.height); return x.getImageData(px - 4, py - 4, 9, 9).data.filter((_, i) => i % 4 === 3).reduce((s, v) => s + v, 0); }, [la, lo]);
const tile = n => page.getByRole('group', { name: 'Map layers' }).getByRole('button', { name: new RegExp('^' + n) });
const tileOn = n => tile(n).getAttribute('aria-pressed').then(v => v === 'true');
const hdr = n => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: n, exact: true });
const dayBtn = n => page.getByRole('group', { name: 'Forecast day' }).getByRole('button', { name: n, exact: true });
const drop = async (la, lo) => { await page.getByRole('button', { name: /Drop it on the map|Drop point/ }).click(); const p = await at(la, lo); await page.mouse.click(p.x, p.y); await page.waitForTimeout(400); };

const impTiles = () => page.locator('[data-testid^=impact-]:not([data-testid=impact-row])');
const waitImpact = () => page.waitForFunction(() => document.querySelectorAll('[data-testid^=level-]').length >= 4, null, { timeout: 30000 });
const waitDone = () => page.waitForFunction(() => !/running…/.test(document.querySelector('[data-testid=caption]').innerText) && !/Waiting for the model|arrive when all 10 days/.test(document.body.innerText), null, { timeout: 40000 });

await page.goto(URL);
await page.waitForFunction(() => window.__globe && /Start state \(real data\)/.test(document.body.innerText), null, { timeout: 60000 });
await page.waitForTimeout(2000);
ok(true, 'page loaded; start state from /presets + plain forecast from /run');
// ---- header ----
const navBtns = await page.getByRole('navigation', { name: 'Main' }).getByRole('button').allInnerTexts();
ok(JSON.stringify(navBtns) === JSON.stringify(['Earth', 'Weather events', 'Shocks']), 'header has exactly three buttons: ' + navBtns.join(' / '));
let b = await body(); ok(!/Timeline Prime|Branch a universe|Earth-B/.test(b), 'old tabs and "+ Branch a universe" are gone');
ok(/Engine ready/.test(b) && /23 Jul 2019 · start/.test(b), 'header keeps start state, scenario date and engine status');
// ---- sky clock ----
ok(/23 Jul 2019 · 12:00 IST/.test(await page.innerText('header')), 'sky follows the scenario date (Noon by default): ' + (await page.innerText('header')).match(/\d+ \w+ \d{4} · \d\d:\d\d IST[^\n]*/)[0]);
await dayBtn('+3').click(); await page.waitForTimeout(300);
let h = await page.innerText('header'); ok(/26 Jul 2019 · day \+3/.test(h) && /26 Jul 2019 · 12:00 IST/.test(h), 'timeline +3 moves the scenario date and the sky to 26 Jul 2019');
for (const [n, re] of [['Dusk', /26 Jul 2019 · 18:30 IST/], ['Night', /26 Jul 2019 · 00:30 IST/], ['Today (sky only)', /today, sky only/], ['Noon', /26 Jul 2019 · 12:00 IST/]]) {
  await page.getByRole('button', { name: n, exact: true }).click(); await page.waitForTimeout(250); ok(re.test(await page.innerText('header')), 'sky time: ' + n); }
ok(/The weather is never live/.test(await body()), 'note: the weather is never live');
await dayBtn('Now').click();
// ---- tiles ----
for (const n of ['Terrain', 'Borders', 'Heat', 'City lights']) await tile(n).click();
const u = () => page.evaluate(() => ({ disp: window.__globe.uni.disp.value, lights: window.__globe.uni.lightsOn.value, borders: window.__globe.uni.bordersOn.value, flow: window.__globe.flowMesh.visible }));
let s = await u(); ok(s.disp === 0 && s.lights === 0 && s.borders === 0 && await wxAlpha(22, 78) === 0, 'all tiles off: no relief, borders, lights or weather paint');
for (const n of ['Elevation', 'Heat', 'Pressure', 'Moisture']) { await tile(n).click(); await page.waitForTimeout(500);
  const india = await wxAlpha(22.5, 78.5), pak = await wxAlpha(29.5, 69.0), china = await wxAlpha(34, 90); ok(india > 0 && pak === 0 && china === 0, `${n}: over India only (India ${india}, Pakistan ${pak}, China ${china})`); await tile(n).click(); }
for (const n of ['Terrain', 'Borders', 'Heat', 'Rain', 'Wind', 'City lights']) await tile(n).click();
await page.waitForTimeout(1000); s = await u(); ok(s.disp > 0 && s.borders === 1 && s.lights === 1 && s.flow, 'any combination at once (Terrain+Borders+Heat+Rain+Wind+City lights)');
// ---- current conditions ----
let p = await at(23.3, 77.8); await page.mouse.move(p.x, p.y); await page.waitForTimeout(500);
const cc = await page.locator('[aria-label="Current conditions"]').innerText();
ok(/MADHYA PRADESH/.test(cc) && /°N/.test(cc) && ['ELEVATION', 'RAIN', 'TEMPERATURE', 'WIND', 'PRESSURE', 'MOISTURE'].every(k => cc.includes(k)), 'Current conditions under the pointer: place, lat/lon and the six values');
ok(await page.evaluate(() => window.__globe.liftMesh.visible), 'Indian state glow on hover'); await shot('03_current_conditions');
// ---- Earth panel ----
await hdr('Earth').click(); b = await body();
ok((await page.locator('[aria-label="Earth"] button').count()) === 7 && /Bay of Bengal low/.test(b) && /Back to Earth/.test(b), 'Earth panel: 6 start presets with dates + Back to Earth');
await shot('10_earth_panel');
await page.getByRole('button', { name: /^Pre-monsoon heatwave/ }).click();
await page.waitForFunction(() => /Pre-monsoon heatwave/.test(document.querySelector('header').innerText) && /31 May 2019/.test(document.querySelector('header').innerText), null, { timeout: 30000 });
ok(true, 'choosing a preset changes the start data (header: 31 May 2019)');
await hdr('Earth').click(); await page.getByRole('button', { name: /^Heavy-rain spell/ }).click();
await page.waitForFunction(() => /23 Jul 2019/.test(document.querySelector('header').innerText) && /Start state/.test(document.body.innerText), null, { timeout: 30000 });
// ---- Weather events ----
await hdr('Weather events').click(); await page.waitForTimeout(300);
const evCards = await page.getByRole('group', { name: 'Event' }).getByRole('button').count();
b = await body(); ok(evCards === 5 && /Monsoon onset/.test(b) && /Western disturbance/.test(b) && /19 May 2020/.test(b), 'Weather events panel: 5 events with real dates (cyclone = 19 May 2020, Amphan)');
await page.getByRole('button', { name: /^Cyclone/ }).click();
await page.locator('[aria-label="Weather events"] input[type=range]').fill('140'); await page.waitForTimeout(700);
ok(/Stronger than anything in the training data/.test(await body()), 'strength 140% shows the "stronger than anything in the training data" warning');
await page.locator('[aria-label="Weather events"] input[type=range]').fill('100');
await drop(26.5, 72.5); await page.waitForTimeout(600);
ok(/cyclone centred over land is unrealistic/.test(await body()), 'cyclone dropped over Rajasthan: plausibility warning');
await page.getByRole('button', { name: 'Where it really happened' }).click(); await page.waitForTimeout(600);
ok(/16\.5°N 86\.5°E/.test(await body()) && !/over land is unrealistic/.test(await body()), '"Where it really happened" puts it back at 16.5°N 86.5°E');
await shot('11_weather_events_panel');
await page.getByRole('button', { name: 'Run the event' }).click();
await page.waitForFunction(() => /OUTCOME/.test(document.body.innerText), null, { timeout: 30000 }); await waitDone();
b = await body();
ok(!(await page.locator('[aria-label="Current conditions"]').count()), 'while an event runs the top-left readout is hidden');
ok(await tileOn('Pressure') && await tileOn('Wind') && await tileOn('Rain'), 'cyclone switches on Pressure + Wind + Rain');
ok(/With it/.test(b) && /Difference/.test(b) && /Without/.test(b) && /start: Heavy-rain spell, 23 Jul 2019/.test(b), 'outcome: title, location, start preset, 3-way view switch');
ok(/at the centre/.test(b) && /affected-area average/.test(b) && ['Elevation', 'Rain', 'Temperature', 'Wind', 'Pressure', 'Moisture'].every(k => b.includes(k)), 'outcome: six parameters at the centre and over the affected area (with / without / Δ)');
await dayBtn('+3').click(); await page.waitForTimeout(600); b = await body();
ok(/Lowest pressure/.test(b) && /Track: d0/.test(b) && /Strongest wind/.test(b) && /10-DAY RAIN CHANGE BY STATE/.test(b), 'cyclone details: track, lowest pressure, strongest wind, rain by state');
ok(/weakens|round shape|keeps its depth/.test(b), 'cyclone: plain statement about weakening / shape: ' + (b.match(/The vortex[^\n]*/) || [''])[0].slice(0, 110));
ok(await page.evaluate(() => !!window.__globe.trackGrp && window.__globe.trackGrp.children.length >= 2), 'cyclone track drawn on the globe (line + day markers)');
ok(/km reached/.test(b) && /thousand km² affected/.test(b) && /MOST AFFECTED STATES/.test(b), 'outcome: km reached, area, peak, top states');
await page.getByRole('button', { name: 'With it', exact: true }).click(); await page.waitForTimeout(400); ok(/with it/.test(await caption()), 'view switch: With it');
await page.getByRole('button', { name: 'Difference', exact: true }).click(); await page.waitForTimeout(400);
await page.evaluate(() => window.__globe.aim(17, 86)); await page.waitForTimeout(500);
await shot('12_cyclone_outcome_track');
// ---- Shocks ----
await hdr('Shocks').click(); await page.waitForTimeout(300);
const shocks = await page.getByRole('group', { name: 'Shock' }).getByRole('button').allInnerTexts();
ok(JSON.stringify(shocks) === JSON.stringify(['Warm Bay of Bengal', 'Weaker Arabian Sea winds', 'Zero shock', 'Custom']), 'Shocks panel: exactly the four shocks');
ok(await page.evaluate(() => !!window.__globe.boxLine), 'Warm Bay of Bengal shows its fixed box on the globe');
await shot('13_shocks_panel');
await page.getByRole('button', { name: 'Zero shock', exact: true }).click(); ok(/difference: exactly 0/.test(await body()), 'Zero shock panel promises "difference: exactly 0"');
await page.getByRole('button', { name: 'Run the shock' }).click(); await page.waitForFunction(() => /OUTCOME/.test(document.body.innerText), null, { timeout: 30000 }); await waitDone();
await waitImpact(); { const tx = await impTiles().allInnerTexts(), act = tx.filter(x => !/Off season/.test(x));
  ok(act.length >= 4 && act.every(x => /Δ 0\.0 vs plain/.test(x)), 'Zero shock: every impact tile shows Δ 0.0 vs plain (' + act.length + ' tiles)');
  await page.getByTestId('impact-heat').getByRole('button', { name: /Why/ }).click(); await page.waitForTimeout(300);
  ok(/No change/.test(await page.getByTestId('why-heat').innerText()), 'Zero shock: heat "Why?" says No change'); await shot('16_impact_zero_why');
  await page.getByTestId('impact-heat').getByRole('button', { name: /Why/ }).click(); }
for (const d of ['Now', '+1', '+10']) { await dayBtn(d).click(); await page.waitForTimeout(250); ok(/difference: exactly 0/.test(await body()), 'Zero shock outcome day ' + d + ': "difference: exactly 0"'); }
ok(/Zero shock/.test(await body()) && !/Cyclone details/i.test(await body()), 'running a new shock replaced the cyclone (one at a time)');
await hdr('Shocks').click(); await page.getByRole('button', { name: 'Weaker Arabian Sea winds', exact: true }).click(); await page.getByRole('button', { name: 'Run the shock' }).click();
await page.waitForFunction(() => /OUTCOME[\s\S]*Weaker Arabian Sea winds/.test(document.body.innerText), null, { timeout: 30000 }); await waitDone();
await dayBtn('+1').click(); await page.waitForTimeout(300); { const bb = await body(), w = await tileOn('Wind'), oc = /km reached/.test(bb); ok(oc && w, 'Weaker Arabian Sea winds runs; Wind layer on' + (w ? '' : ' [wind tile off]') + (oc ? '' : ' [no outcome numbers]')); }
await hdr('Shocks').click(); await page.getByRole('button', { name: 'Custom', exact: true }).click();
await page.getByRole('group', { name: 'Variable to change' }).getByRole('button', { name: 'Temp' }).click();
await page.locator('[aria-label="Shocks"] input[type=range]').first().fill('2'); await page.locator('[aria-label="Shocks"] input[type=range]').nth(1).fill('4');
await drop(15.0, 77.0); await page.getByRole('button', { name: 'Run the shock' }).click();
await page.waitForFunction(() => /OUTCOME[\s\S]*Custom/.test(document.body.innerText), null, { timeout: 30000 }); await waitDone();
for (const d of ['Now', '+1']) { await dayBtn(d).click(); await page.waitForTimeout(400); b = await body();
  const m = b.match(/([\d,]+)\s*km reached\s*([\d,]+)\s*thousand km² affected[\s\S]*?MOST AFFECTED STATES[^\n]*\n([^\n]+)/);
  ok(!!m && +m[1].replace(/,/g, '') > 0 && +m[2].replace(/,/g, '') > 0 && /^Karnataka/.test(m[3]), `custom +2 °C at 15°N 77°E, ${d}: ` + (m ? `${m[1]} km, ${m[2]} thousand km², first ${m[3].trim()}` : 'missing')); }
// ---- back to Earth ----
await hdr('Earth').click(); await page.getByRole('button', { name: /^Back to Earth/ }).click(); await page.waitForTimeout(400);
ok(!/OUTCOME/.test(await body()) && (await page.locator('[aria-label="Current conditions"]').count()) === 1, 'Back to Earth clears the run and brings back Current conditions');
// ---- Impact dashboard on the plain forecast ----
await waitImpact(); { const tx = await impTiles().allInnerTexts();
  ok(tx.length === 5 && ['FLOOD RISK', 'HEAT STRESS', 'CROP-WATER STRESS', 'SOLAR', 'WIND POWER'].every((n, i) => tx[i].startsWith(n)) && tx.filter(x => /plain forecast/.test(x)).length >= 4,
    'Impact dashboard: 5 KPI tiles on the plain forecast (' + tx.map(x => x.split('\n')[0]).join(' / ') + ')');
  ok(tx.filter(x => /\d+\/16 agree/.test(x)).length >= 4, 'Impact tiles show ensemble agreement out of 16 members'); }
await page.getByTestId('impact-flood').getByRole('button', { name: /Why/ }).click(); await page.waitForTimeout(300);
{ const w = page.getByTestId('why-flood'), t = await w.innerText(), n = await w.locator('svg polyline').count();
  ok(/Flood risk on the plain forecast/.test(t) && /Confidence: \d+ of 16/.test(t) && n === 2, '"Why?" shows the explanation and a day 0–10 sparkline'); }
await shot('15_impact_plain_why');
await page.getByTestId('impact-flood').getByRole('button', { name: /Why/ }).click();
await page.getByTestId('impact-heat').click(); await page.waitForTimeout(700);
ok(await page.evaluate(() => window.__globe.hiOn && window.__globe.hiMesh.visible) && await tileOn('Heat'), 'clicking Heat stress turns on the Heat layer and highlights the affected cells');
await shot('17_impact_heat_highlight');
await page.getByTestId('impact-heat').click(); await page.waitForTimeout(500);
ok(await page.evaluate(() => !window.__globe.hiOn), 'clicking the tile again clears the highlight');
await page.getByTestId('impact-solar').click(); await page.waitForTimeout(1200);
ok(await tileOn('Clouds') && await page.evaluate(() => window.__globe.cloudMesh.visible && window.__globe.cData.some((v, i) => i % 4 === 0 && v > 60)),
  'clicking Solar turns on the Clouds layer (cloud proxy shell drawn, cover > 0)');
ok(/cloud proxy from moisture and rain/.test(await body()), 'Clouds layer labelled "cloud proxy from moisture and rain"');
for (const k of ['Rain', 'Heat']) if (await tileOn(k)) await tile(k).click();
await page.waitForTimeout(800); await shot('18_clouds_layer');
await page.getByTestId('impact-solar').click();
// ---- Moon ----
const moon = await page.evaluate(() => { const g = window.__globe, m = g.bodies.Moon.grp; return { d: m.position.length(), r: m.children[0].geometry.parameters.radius, ring: !!g.moonRing }; });
ok(Math.abs(moon.d - 12) < 1e-6 && Math.abs(moon.r - 0.35) < 1e-6 && moon.ring, `Moon at ${moon.d.toFixed(1)} Earth radii, radius ${moon.r}, orbit ring`);
await page.evaluate(() => { const g = window.__globe, m = g.bodies.Moon.grp.position.clone(); const side = m.clone().normalize(); g.lookFrom(side); g.dist = 15.5; });
await page.waitForTimeout(800); await shot('14_moon');
ok(errors.length === 0, 'no browser console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
const fails = results.filter(r => !r[0]).length;
console.log(`\nRESULT: ${results.length - fails}/${results.length} passed`); process.exit(fails ? 1 : 0);
