// Made-up villages for looks and performance runs. Open with ?demo=stress or ?demo=small.
import type { Activity, HouseDTO, VillageSnapshot, VillagerDTO, VillagerState } from '../shared/types.js';

const NAMES = ['claude-village', 'bep-online', 'wireless-lab', 'blog-ca-nhan', 'api-gateway', 'mobile-app', 'data-pipeline', 'design-system', 'thesis', 'portfolio', 'game-jam', 'trading-sim', 'iot-garden', 'notes'];
const ACTIVITIES: Activity[] = ['building', 'reading', 'running', 'thinking', 'exploring', 'talking', 'delegating', 'working'];
const TOOLS: Partial<Record<Activity, [string, string]>> = { building: ['Edit', 'main.ts'], reading: ['Read', 'README.md'], running: ['Bash', 'Run the tests'], exploring: ['WebSearch', ''], delegating: ['Agent', 'Review the change'], working: ['mcp__docs__read', ''] };

export function demoSnapshot(kind: string, tick: number, now: number): VillageSnapshot {
  const houseCount = kind === 'stress' ? 14 : 6, peopleTotal = kind === 'stress' ? 30 : 12;
  const houses: HouseDTO[] = NAMES.slice(0, houseCount).map((name, i) => ({ id: `house-${name}`, name, slot: i, villagers: [], hiddenVillagers: 0 }));
  for (let i = 0; i < peopleTotal; i++) {
    const house = houses[i % houses.length]!;
    const round = Math.floor(tick / (12 + (i % 5))) + i;
    const activity = ACTIVITIES[round % ACTIVITIES.length]!;
    const mode = (i * 7 + Math.floor(tick / 30)) % 11;
    const state: VillagerState = mode === 0 ? 'asleep' : mode === 1 ? 'idle' : mode === 2 ? 'long-running' : mode === 3 ? 'error' : 'active';
    const tool = TOOLS[activity];
    const helper = i % 6 === 5 && house.villagers[0];
    const v: VillagerDTO = {
      id: `person-${i}`,
      kind: helper ? 'helper' : 'session',
      parentId: helper ? house.villagers[0]!.id : null,
      title: helper ? 'implementer: Sửa bug' : `Phiên làm việc ${i + 1}`,
      branch: helper ? null : 'main',
      state,
      activity: state === 'asleep' || state === 'idle' ? 'resting' : activity,
      currentTool: tool?.[0] ?? null,
      currentLabel: tool?.[1] || null,
      lastActivityAt: now - i * 1000,
      timeline: tool ? [{ at: now - 4000, tool: tool[0], label: tool[1] || null, activity, failed: state === 'error' }] : [],
    };
    house.villagers.push(v);
  }
  return { at: now, houses, tent: { villagers: [], hiddenVillagers: 0 }, hiddenHouses: 0 };
}
