// Leaves the village running with busy demo data and reports whether memory keeps growing.
// Usage: node scripts/soak.mjs [minutes]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const minutes = Number(process.argv[2] ?? 15);
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'cv-soak-'));
const PORT = 4797;
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env: { ...process.env, CV_CLAUDE_HOME: home, CV_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--disable-background-timer-throttling', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?still&hud&demo=stress`);
await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 60000 });
await page.waitForTimeout(30000);
const sample = () => page.evaluate(() => ({ mb: Math.round(performance.memory.usedJSHeapSize / 1048576), fps: window.__stats.fps }));
const samples = [await sample()];
const steps = Math.max(1, Math.round(minutes));
for (let i = 0; i < steps; i++) {
  await page.waitForTimeout(60000);
  samples.push(await sample());
}
console.log(JSON.stringify(samples));
const first = samples[0], last = samples[samples.length - 1];
console.log(`heap ${first.mb} MB -> ${last.mb} MB over ${steps} min, fps ${first.fps} -> ${last.fps}, errors ${errors.length}`);
await browser.close();
server.kill();
rmSync(home, { recursive: true, force: true });
process.exit(errors.length || last.mb > first.mb * 1.5 ? 1 : 0);
