// Measures how even the frames are, not just how many there are: average FPS hides a hitch.
// Usage: npm run build, then node scripts/frames.mjs [seconds per view]
// Set UNCAPPED=1 to turn vsync off and compare raw speed, DGPU=1 to ask for the discrete GPU.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const seconds = Number(process.argv[2] ?? 20);
const home = mkdtempSync(join(tmpdir(), 'cv-frames-'));
const PORT = 4797;
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env: { ...process.env, CV_CLAUDE_HOME: home, CV_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=40,40', '--disable-background-timer-throttling', ...(process.env.UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), ...(process.env.DGPU ? ['--force_high_performance_gpu'] : [])] });
// A 1920x1080 screen at 125%, which is what this game is really played on.
const page = await browser.newPage({ viewport: { width: 1536, height: 730 }, deviceScaleFactor: 1.25 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
for (const [name, query] of [['wide', 'demo=stress&hour=12&cam=wide'], ['hero', 'demo=stress&hour=18&cam=hero'], ['close', 'demo=stress&hour=21&cam=close']]) {
  await page.goto(`http://127.0.0.1:${PORT}/?still&hud&${query}`);
  await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 45000 });
  await page.waitForTimeout(3000);
  if (name === 'wide') console.log('gpu', await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); return g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL); }));
  const r = await page.evaluate((ms) => new Promise((done) => {
    const gaps = [], longTasks = [];
    const watcher = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
    watcher.observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    const start = last;
    const step = (now) => {
      gaps.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(step);
      else { watcher.disconnect(); done({ gaps, longTasks, heap: performance.memory?.usedJSHeapSize ?? 0 }); }
    };
    requestAnimationFrame(step);
  }), seconds * 1000);
  const sorted = [...r.gaps].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const hitches = sorted.filter((g) => g > mean * 1.75).length;
  console.log(name, `${(1000 / mean).toFixed(0)} FPS`, `p50 ${pct(sorted, 0.5).toFixed(1)} ms`, `p95 ${pct(sorted, 0.95).toFixed(1)} ms`, `p99 ${pct(sorted, 0.99).toFixed(1)} ms`, `max ${sorted[sorted.length - 1].toFixed(1)} ms`, `hitches ${hitches}/${sorted.length}`, `long tasks ${r.longTasks.length} (max ${Math.max(0, ...r.longTasks)} ms)`);
}
console.log('errors', JSON.stringify(errors.slice(0, 8)));
await browser.close();
server.kill();
rmSync(home, { recursive: true, force: true });
process.exit(errors.length ? 1 : 0);
