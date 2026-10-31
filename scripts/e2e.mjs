// End-to-end check with a made-up ~/.claude: a session appears, changes what it does, can be
// clicked for details, and goes to sleep when its process ends. Run after `npm run build`.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
// Not under the system temp folder: the game would rightly treat that as a temporary session.
mkdirSync(join(root, 'test-output'), { recursive: true });
const base = mkdtempSync(join(root, 'test-output', 'e2e-'));
const home = join(base, 'home'), project = join(base, 'my-project');
const dir = join(home, 'projects', 'proj');
mkdirSync(dir, { recursive: true });
mkdirSync(project);
mkdirSync(join(home, 'sessions'));
const SESSION = '11111111-0000-4000-8000-000000000000', CANARY = 'CANARY-do-not-show';
const file = join(dir, `${SESSION}.jsonl`);
const line = (o) => `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId: SESSION, cwd: project, gitBranch: 'main', ...o })}\n`;
writeFileSync(file, line({ type: 'user', message: { content: `Please help ${CANARY}` } }) + JSON.stringify({ type: 'custom-title', customTitle: 'Làm tính năng mới' }) + '\n');
const registry = join(home, 'sessions', `${process.pid}.json`);
writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: SESSION, status: 'busy', startedAt: Date.now() }));

const PORT = 4798;
const server = spawn(process.execPath, ['dist/server/main.js'], { cwd: root, env: { ...process.env, CV_CLAUDE_HOME: home, CV_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--disable-background-timer-throttling'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [], outside = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1:4798|ws:\/\/127\.0\.0\.1:4798|blob:|data:)/.test(r.url())) outside.push(r.url()); });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const villager = () => page.evaluate(() => window.__snapshot()?.houses[0]?.villagers[0] ?? null);
// Polled from Node: the page's CSP rightly forbids the eval that string predicates need.
const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn).catch(() => false)) { lastWait = Date.now() - t0; return true; }
    await new Promise((r) => setTimeout(r, 200));
  }
  lastWait = ms;
  return false;
};
let lastWait = 0;

try {
  // The wide view: the temp folder's random name puts the island anywhere on the map.
  await page.goto(`http://127.0.0.1:${PORT}/?still&hud&hour=11&cam=wide`);
  await page.waitForFunction(() => window.__stats?.ready, null, { timeout: 45000 });
  const snap = await page.evaluate(() => window.__snapshot());
  check('real project becomes one island', snap.houses.length === 1 && snap.houses[0].name === 'my-project');
  const v0 = await villager();
  check('session appears as a villager with its title', v0?.title === 'Làm tính năng mới', v0?.title);

  const actions = [
    ['Edit', { file_path: join(project, 'a', 'main.ts') }, 'building', 'main.ts', ['Hammering', 'Sawing', 'Working_B']],
    ['Read', { file_path: join(project, 'b', 'notes.md') }, 'reading', 'notes.md', ['Holding_A', 'Holding_B']],
    ['Bash', { command: `rm ${CANARY}`, description: 'Run the tests' }, 'running', 'Run the tests', ['Working_A', 'Pickaxing', 'Chopping']],
    ['WebSearch', { query: CANARY }, 'exploring', null, ['Walking_A', 'Walking_B']],
  ];
  let n = 0;
  for (const [name, input, activity, label, clips] of actions) {
    const id = `t${n++}`;
    appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }));
    const moved = await waitFor(`window.__snapshot()?.houses[0]?.villagers[0]?.activity === '${activity}'`);
    const seenAfter = lastWait;
    const v = await villager();
    check(`${name} shows as ${activity}`, moved && v.currentTool === name && v.currentLabel === label, `${v.currentLabel ?? 'no label'}, ${seenAfter} ms`);
    const acted = await waitFor(`${JSON.stringify(clips)}.includes(window.__clipOf('${v.id}'))`, 15000);
    check(`${name} plays a fitting animation`, acted, await page.evaluate((i) => window.__clipOf(i), v.id));
    appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: CANARY }] } }));
  }

  const v = await villager();
  const box = await page.evaluate((i) => window.__screenOf(i), v.id);
  await page.mouse.click(box.x, box.y);
  check('clicking a villager opens the panel', await waitFor(`!document.querySelector('.panel').hidden && document.querySelector('.panel h2').textContent === 'Làm tính năng mới'`));
  const text = await page.evaluate(() => document.querySelector('.panel').textContent);
  check('panel lists tools and labels', text.includes('Edit') && text.includes('main.ts') && text.includes('Run the tests'));
  const whole = await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify(window.__snapshot()));
  check('private text never reaches the page', !whole.includes(CANARY) && !whole.includes(SESSION) && !whole.includes(base.replace(/\\/g, '\\\\')));
  const shot = join(root, 'test-output');
  mkdirSync(shot, { recursive: true });
  await page.screenshot({ path: join(shot, 'e2e-panel.png') });

  rmSync(registry);
  check('villager sleeps when its process ends', await waitFor(`window.__snapshot()?.houses[0]?.villagers[0]?.state === 'asleep'`));
  check('sleeping villager lies down', await waitFor(`window.__clipOf(window.__snapshot().houses[0].villagers[0].id) === 'Lie_Idle'`));
  check('the panel closes on Escape', await page.keyboard.press('Escape').then(() => waitFor(`document.querySelector('.panel').hidden`)));
  const houseId = snap.houses[0].id;
  check('clicking a villager also flies to their island', await waitFor(`window.__view().focused === ${JSON.stringify(houseId)} && !window.__view().flying`));
  await page.keyboard.press('Escape');
  check('Escape goes back to the whole village', await waitFor(`window.__view().focused === null && !window.__view().flying && !document.querySelector('#home:not([hidden])')`), JSON.stringify(await page.evaluate(() => window.__view())));
  const spot = await page.evaluate((i) => window.__isleOnScreen(i), houseId);
  await page.mouse.click(spot.x, spot.y);
  check('clicking an island focuses it', await waitFor(`window.__view().focused === ${JSON.stringify(houseId)} && !window.__view().flying`));
  const seen = await page.evaluate(() => window.__view());
  check('the camera looks at that island', Math.hypot(seen.x - spot.wx, seen.z - spot.wz) < 0.2, `${seen.x.toFixed(2)}, ${seen.z.toFixed(2)}`);
  await page.click('#home');
  check('the button goes back to the whole village', await waitFor(`window.__view().focused === null`));
  check('no console or CSP errors', errors.length === 0, errors.join(' | '));
  check('no requests leave the machine', outside.length === 0, outside.slice(0, 3).join(' '));
} catch (err) {
  check('run finished', false, String(err).slice(0, 300));
}
await browser.close();
server.kill();
rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
