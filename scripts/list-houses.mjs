// Read-only sanity check on real data. Prints only counts and classes, never names or paths.
// Needs `npx tsc -p tsconfig.server.json` first.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Scanner } from '../dist/server/scanner.js';

const scanner = new Scanner({ claudeHome: process.env.CV_CLAUDE_HOME ?? join(homedir(), '.claude') });
const t0 = performance.now();
const first = await scanner.poll();
const t1 = performance.now();
const second = await scanner.poll();
const t2 = performance.now();
const count = (list, key) => list.reduce((m, v) => ({ ...m, [v[key]]: (m[v[key]] ?? 0) + 1 }), {});
const people = second.houses.flatMap((h) => h.villagers).concat(second.tent?.villagers ?? []);
console.log(JSON.stringify({
  firstPollMs: Math.round(t1 - t0),
  secondPollMs: Math.round(t2 - t1),
  houses: first.houses.length,
  hiddenHouses: first.hiddenHouses,
  tent: second.tent?.villagers.length ?? 0,
  villagersPerHouse: second.houses.map((h) => h.villagers.length),
  states: count(people, 'state'),
  activities: count(people, 'activity'),
  kinds: count(people, 'kind'),
  snapshotBytes: JSON.stringify(second).length,
  memMB: Math.round(process.memoryUsage().rss / 1048576),
}));
