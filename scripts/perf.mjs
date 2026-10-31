// Runs the built game on an empty home folder and checks the budgets in headed Edge (real GPU).
// Usage: npm run build, then npm run perf
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'test-output');
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cv-perf-'));
const PORT = 4799;
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env: { ...process.env, CV_CLAUDE_HOME: home, CV_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'wide-morning=demo=stress&hour=8&cam=wide', 'wide-noon=demo=stress&hour=12.5&cam=wide', 'wide-sunset=demo=stress&hour=18.2&cam=wide', 'wide-night=demo=stress&hour=22&cam=wide',
  'hero-dawn=demo=small&hour=6.2&cam=hero', 'close-noon=demo=small&hour=11&cam=close', 'close-night=demo=small&hour=21&cam=close',
];
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=40,40', '--disable-background-timer-throttling'] });
// A 1920x1080 screen at 125%, which is what this game is really played on.
const page = await browser.newPage({ viewport: { width: 1536, height: 730 }, deviceScaleFactor: 1.25 });
const errors = [], outside = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1:4799|blob:|data:)/.test(r.url())) outside.push(r.url()); });
let failed = false;
for (const spec of SHOTS) {
  const cut = spec.indexOf('=');
  const name = spec.slice(0, cut), query = spec.slice(cut + 1);
  await page.goto(`http://127.0.0.1:${PORT}/?still&hud&${query}`);
  try {
    await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 45000 });
  } catch (err) {
    console.error('page never became ready', JSON.stringify(errors.slice(0, 8)));
    await browser.close();
    server.kill();
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }
  await page.waitForTimeout(7000);
  const s = await page.evaluate(() => window.__stats);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const stressed = query.includes('stress');
  const over = stressed && (s.fps < 30 || s.calls > 300 || s.triangles > 300000);
  if (over) failed = true;
  console.log(name, JSON.stringify(s), over ? 'OVER BUDGET' : 'ok');
  if (over) console.log('  largest:', JSON.stringify(await page.evaluate(() => window.__triangles?.())));
}
console.log('errors', JSON.stringify(errors.slice(0, 8)));
console.log('outside requests', outside.length);
await browser.close();
server.kill();
rmSync(home, { recursive: true, force: true });
process.exit(failed || errors.length || outside.length ? 1 : 0);
