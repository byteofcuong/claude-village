// Watches every villager in a busy made-up village and reports anyone standing inside a solid model.
// It casts rays at the real geometry, so it does not trust the village's own idea of where things are.
// Usage: node scripts/walk.mjs [seconds]. Run after `npm run build`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const seconds = Number(process.argv[2] ?? 90);
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'cv-walk-'));
const PORT = 4796;
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env: { ...process.env, CV_CLAUDE_HOME: home, CV_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--disable-background-timer-throttling'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?still&hud&demo=stress`);
await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 60000 });

const hits = new Map();
let samples = 0, people = 0, crowded = 0, standing = 0, cats = 0;
const until = Date.now() + seconds * 1000;
while (Date.now() < until) {
  const found = await page.evaluate(() => window.__inside());
  samples++;
  people += found.people;
  crowded += found.crowded;
  standing += found.standing;
  cats = Math.max(cats, found.cats);
  for (const { id, assets } of found.hits) for (const a of assets) {
    const key = `${a}`;
    const seen = hits.get(key) ?? { count: 0, who: new Set() };
    seen.count++;
    seen.who.add(id);
    console.log(`round ${samples} ${id} in ${a}`);
    hits.set(key, seen);
  }
  await page.waitForTimeout(250);
}
const total = [...hits.values()].reduce((n, h) => n + h.count, 0);
for (const [asset, h] of hits) console.log(`${asset}: ${h.count} samples, ${h.who.size} people`);
console.log(`${samples} rounds, ${people} person samples, ${total} inside a solid, ${crowded} pairs closer than 0.4 (${standing} both standing), up to ${cats} cats out, errors ${errors.length}`);
await browser.close();
server.kill();
rmSync(home, { recursive: true, force: true });
process.exit(total || standing || errors.length ? 1 : 0);
