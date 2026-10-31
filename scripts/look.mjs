// Screenshots the running village (npm start). The image can hold real project names: test-output/ is ignored by git.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const out = join(resolve(import.meta.dirname, '..'), 'test-output');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${process.env.CV_PORT ?? 4717}/?still&hud&cam=wide`);
await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 60000 });
await page.waitForTimeout(8000);
const s = await page.evaluate(() => {
  const snap = window.__snapshot();
  const people = snap.houses.flatMap((h) => h.villagers).concat(snap.tent?.villagers ?? []);
  const tally = (k) => people.reduce((m, v) => ({ ...m, [v[k]]: (m[v[k]] ?? 0) + 1 }), {});
  return { stats: window.__stats, islands: snap.houses.length, tent: !!snap.tent, people: people.length, states: tally('state'), activities: tally('activity') };
});
await page.screenshot({ path: join(out, 'real-village.png') });
console.log(JSON.stringify(s));
console.log('errors', JSON.stringify(errors));
await browser.close();
