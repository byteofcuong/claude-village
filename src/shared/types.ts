// What the browser receives. Nothing here may carry prompts, thinking, commands or full paths.

export type VillagerState = 'active' | 'idle' | 'asleep' | 'error' | 'long-running';

export type Activity = 'thinking' | 'talking' | 'reading' | 'building' | 'running' | 'exploring' | 'delegating' | 'working' | 'resting';

export interface ToolEventDTO {
  at: number;
  tool: string;
  label: string | null;
  activity: Activity;
  failed: boolean;
}

export interface VillagerDTO {
  id: string;
  kind: 'session' | 'helper';
  parentId: string | null;
  title: string;
  branch: string | null;
  state: VillagerState;
  activity: Activity;
  currentTool: string | null;
  currentLabel: string | null;
  lastActivityAt: number;
  timeline: ToolEventDTO[];
}

export interface HouseDTO {
  id: string;
  name: string;
  slot: number;
  villagers: VillagerDTO[];
  hiddenVillagers: number;
}

export interface TentDTO {
  villagers: VillagerDTO[];
  hiddenVillagers: number;
}

export interface VillageSnapshot {
  at: number;
  houses: HouseDTO[];
  tent: TentDTO | null;
  hiddenHouses: number;
}
