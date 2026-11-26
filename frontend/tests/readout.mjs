// Reads the dashboard's "Current conditions" panel at given points (used by backend/tools/verify_data.py).
// stdin: {"url": "...", "preset": "<preset name>", "points": [[lat, lon], ...]}  ->  stdout: JSON list of readouts
import { chromium } from 'playwright-core';

const inp = JSON.parse(await new Promise(r => { let s = ''; process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => r(s)); }));
const browser = await chromium.launch({ channel: process.env.BROWSER || 'msedge', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(inp.url);
await page.waitForFunction(() => window.__globe && document.body.innerText.includes('Start state (real data)'), null, { timeout: 60000 });
await page.getByRole('button', { name: 'Earth', exact: true }).click();
await page.getByRole('button', { name: new RegExp('^' + inp.preset) }).click();
await page.waitForFunction(n => document.body.innerText.includes(n) && document.body.innerText.includes('Start state (real data)'), inp.preset, { timeout: 60000 });
await page.waitForTimeout(800);
const out = [];
for (const [la, lo] of inp.points) {
  await page.evaluate(([a, b]) => window.__globe.aim(a, b), [la, lo]); await page.waitForTimeout(150);
  const p = await page.evaluate(([a, b]) => window.__globe.screenOf(a, b), [la, lo]);
  await page.mouse.move(p.x + 1, p.y); await page.mouse.move(p.x, p.y); await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const box = document.querySelector('[aria-label="Current conditions"]'); if (!box) return null;
    const t = box.innerText, num = k => { const m = t.match(new RegExp(k + '\\s*\\n?\\s*([−\\-]?[\\d,]+(?:\\.\\d+)?)')); return m ? Number(m[1].replace(/,/g, '').replace('−', '-')) : null; };
    const ll = t.match(/([\d.]+)°N ([\d.]+)°E/);
    return { lat: ll ? Number(ll[1]) : null, lon: ll ? Number(ll[2]) : null, rain: num('RAIN'), temp: num('TEMPERATURE'), wind: num('WIND'), pressure: num('PRESSURE'), moisture: num('MOISTURE') };
  });
  out.push(r);
}
await browser.close();
process.stdout.write(JSON.stringify(out));
