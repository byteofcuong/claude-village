// Pure village rules: which projects become houses, who appears, and what they are doing.
import { createHash } from 'node:crypto';
import type { Activity, HouseDTO, ToolEventDTO, VillageSnapshot, VillagerDTO, VillagerState } from '../shared/types.js';
import { activityOfTool, type ParsedRecord } from './parser.js';
import type { LiveEntry } from './registry.js';

export const MAX_HOUSES = 14;
export const MAX_PEOPLE = 30;
export const HOUSE_DAYS = 14;
export const VILLAGER_HOURS = 24;
export const ERROR_MS = 8_000;
export const LONG_TOOL_MS = 30_000;
export const HOUSE_GRACE_MS = 60_000;
export const HELPER_QUIET_MS = 5 * 60_000;
export const PENDING_MAX_MS = 30 * 60_000;
const TIMELINE = 12;
const DAY = 86_400_000;

interface Pending { name: string; label: string | null; at: number }

export interface Actor {
  branch: string | null;
  title: string | null;
  lastAt: number;
  lastKind: Activity;
  pending: Map<string, Pending>;
  timeline: ToolEventDTO[];
  byTool: Map<string, ToolEventDTO>;
  lastErrorAt: number;
}

export interface Helper extends Actor { agentId: string; finished: boolean }

export interface Session extends Actor {
  sessionId: string;
  cwd: string | null;
  hasPrompt: boolean;
  mtime: number;
  helpers: Map<string, Helper>;
}

export interface Project {
  dir: string;
  sessions: Map<string, Session>;
}

export const newActor = (): Actor => ({ branch: null, title: null, lastAt: 0, lastKind: 'resting', pending: new Map(), timeline: [], byTool: new Map(), lastErrorAt: 0 });
export const newSession = (sessionId: string): Session => ({ ...newActor(), sessionId, cwd: null, hasPrompt: false, mtime: 0, helpers: new Map() });

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** A shell cd into a subfolder must not rename the project; moving elsewhere should. */
function isInside(child: string, parent: string | null): boolean {
  if (!parent) return false;
  const c = normPath(child), p = normPath(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** Identity and title only. Used for the start of an old file, whose activity is long over. */
export function applyMeta(s: Session, r: ParsedRecord): void {
  if (r.cwd && !isInside(r.cwd, s.cwd)) s.cwd = r.cwd;
  if (r.branch) s.branch = r.branch;
  if (r.title) s.title = r.title;
  if (r.isRealPrompt) s.hasPrompt = true;
}

export function applyActivity(a: Actor, r: ParsedRecord): void {
  if (r.branch) a.branch = r.branch;
  if (r.title) a.title = r.title;
  const at = r.at;
  if (at === null) return;
  if (r.blocks.length || r.isRealPrompt) a.lastAt = Math.max(a.lastAt, at);
  // A new prompt means earlier tools are over, even if their results were never recorded.
  if (r.isRealPrompt) a.pending.clear();
  for (const b of r.blocks) {
    if (b.kind === 'thinking') a.lastKind = 'thinking';
    else if (b.kind === 'text') a.lastKind = 'talking';
    else if (b.kind === 'tool_use') {
      const activity = activityOfTool(b.name);
      a.lastKind = activity;
      a.pending.set(b.id, { name: b.name, label: b.label, at });
      const ev: ToolEventDTO = { at, tool: b.name, label: b.label, activity, failed: false };
      a.timeline.push(ev);
      a.byTool.set(b.id, ev);
      if (a.timeline.length > TIMELINE) {
        const gone = a.timeline.shift();
        for (const [id, e] of a.byTool) if (e === gone) a.byTool.delete(id);
      }
    } else {
      a.pending.delete(b.toolUseId);
      const ev = a.byTool.get(b.toolUseId);
      if (b.isError) {
        a.lastErrorAt = at;
        if (ev) ev.failed = true;
      }
      a.byTool.delete(b.toolUseId);
    }
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const houseId = (dir: string) => hash(`house:${dir}`);

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
/** What Claude Code would name the project folder for this path, in lower case since Windows mixes the drive letter's. */
const folderKey = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

/** Compared case-insensitively with unified slashes, as Windows paths must be. */
export function isTempCwd(cwd: string, tempRoots: string[]): boolean {
  const norm = cwd.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/scratch-workspaces/')) return true;
  return tempRoots.some((root) => {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm === r || norm.startsWith(`${r}/`);
  });
}

/** Tools with no result for this long were orphaned, by a crash for instance. */
function expirePending(a: Actor, now: number): void {
  for (const [id, p] of a.pending) if (now - p.at > PENDING_MAX_MS) a.pending.delete(id);
}
function newest(a: Actor): Pending | null {
  let best: Pending | null = null;
  for (const p of a.pending.values()) if (!best || p.at >= best.at) best = p;
  return best;
}
function oldest(a: Actor): Pending | null {
  let best: Pending | null = null;
  for (const p of a.pending.values()) if (!best || p.at < best.at) best = p;
  return best;
}

export function sessionState(s: Actor, live: LiveEntry | undefined, now: number): VillagerState {
  expirePending(s, now);
  if (!live) return 'asleep';
  const busy = live.status === 'busy' || (live.status !== 'idle' && now - s.lastAt < 60_000);
  if (!busy) return 'idle';
  if (now - s.lastErrorAt < ERROR_MS) return 'error';
  const old = oldest(s);
  if (old && now - old.at > LONG_TOOL_MS) return 'long-running';
  return 'active';
}

function helperState(h: Helper, parentAlive: boolean, now: number): VillagerState {
  expirePending(h, now);
  if (h.finished || !parentAlive || now - h.lastAt > HELPER_QUIET_MS) return 'asleep';
  if (now - h.lastErrorAt < ERROR_MS) return 'error';
  const old = oldest(h);
  return old && now - old.at > LONG_TOOL_MS ? 'long-running' : 'active';
}

function toDTO(a: Actor, id: string, kind: VillagerDTO['kind'], parentId: string | null, state: VillagerState, fallbackTitle: string): VillagerDTO {
  const current = state === 'asleep' || state === 'idle' ? null : newest(a);
  return {
    id,
    kind,
    parentId,
    title: a.title ?? fallbackTitle,
    branch: a.branch,
    state,
    activity: state === 'asleep' || state === 'idle' ? 'resting' : current ? activityOfTool(current.name) : a.lastKind,
    currentTool: current?.name ?? null,
    currentLabel: current?.label ?? null,
    lastActivityAt: a.lastAt,
    timeline: a.timeline.map((e) => ({ ...e })),
  };
}

export interface VillageInput {
  projects: Iterable<Project>;
  live: Map<string, LiveEntry>;
  cwdExists: (cwd: string) => boolean;
  tempRoots: string[];
  now: number;
}

interface Candidate { dto: VillagerDTO; rank: number; at: number; house: string | null }
const RANK: Record<string, number> = { liveSession: 0, liveHelper: 1, recentSession: 2, recentHelper: 3 };

export class VillageModel {
  private slots = new Map<string, number>();
  private lastEligible = new Map<string, { at: number; name: string; villagers: VillagerDTO[] }>();

  build({ projects, live, cwdExists, tempRoots, now }: VillageInput): VillageSnapshot {
    const candidates: Candidate[] = [];
    const eligible: { id: string; name: string; at: number; live: boolean }[] = [];
    let tentUsed = false;
    const projectList = [...projects];

    // A resumed session can have a file in two project folders. Only the newest copy is the live one.
    const liveCopy = new Map<string, { dir: string; mtime: number }>();
    for (const p of projectList) for (const s of p.sessions.values()) {
      const best = liveCopy.get(s.sessionId);
      if (live.has(s.sessionId) && (!best || s.mtime > best.mtime)) liveCopy.set(s.sessionId, { dir: p.dir, mtime: s.mtime });
    }
    const liveOf = (p: Project, s: Session) => (liveCopy.get(s.sessionId)?.dir === p.dir ? live.get(s.sessionId) : undefined);

    // A session can move into another project, so its cwd alone does not say whose folder this is.
    // The folder's own name does, and a session working where the folder says wins over a newer one.
    const folders = new Map(projectList.map((p) => [p.dir.toLowerCase(), p.dir] as const));

    for (const p of projectList) {
      const sessions = [...p.sessions.values()];
      const atHome = (s: Session) => !!s.cwd && folderKey(s.cwd) === p.dir.toLowerCase();
      const latest = sessions.reduce<Session | null>((m, s) => {
        if (!s.cwd) return m;
        if (!m) return s;
        if (atHome(s) !== atHome(m)) return atHome(s) ? s : m;
        return s.mtime > m.mtime ? s : m;
      }, null);
      const id = houseId(p.dir);
      const lastAt = sessions.reduce((m, s) => Math.max(m, s.mtime, s.lastAt), 0);
      const anyLive = sessions.some((s) => liveOf(p, s));
      const cwd = latest?.cwd ?? null;
      const temp = cwd ? isTempCwd(cwd, tempRoots) : false;
      // Nobody here works at home and the work is in a project that has its own folder: they live there.
      const owner = cwd && !temp && latest && !atHome(latest) ? folders.get(folderKey(cwd)) : undefined;
      const isHouse = !!cwd && !temp && !owner && sessions.some((s) => s.hasPrompt) && cwdExists(cwd) && (anyLive || now - lastAt < HOUSE_DAYS * DAY);
      if (isHouse && cwd) {
        const name = baseName(cwd) || 'project';
        eligible.push({ id, name, at: lastAt, live: anyLive });
        this.lastEligible.set(id, { at: now, name, villagers: this.lastEligible.get(id)?.villagers ?? [] });
      }
      for (const s of sessions) {
        const entry = liveOf(p, s);
        const sessionTemp = s.cwd ? isTempCwd(s.cwd, tempRoots) : temp;
        const recent = now - Math.max(s.lastAt, s.mtime) < VILLAGER_HOURS * 3_600_000;
        if (sessionTemp && !entry) continue;
        if (!sessionTemp && !isHouse && !owner) continue;
        if (!entry && !recent) continue;
        if (!s.hasPrompt && !entry) continue;
        const home = sessionTemp ? null : owner ? houseId(owner) : id;
        if (sessionTemp) tentUsed = true;
        const sid = hash(`session:${p.dir}/${s.sessionId}`);
        const dto = toDTO(s, sid, 'session', null, sessionState(s, entry, now), s.cwd && !sessionTemp ? baseName(s.cwd) : 'Session tạm');
        candidates.push({ dto, rank: entry ? RANK['liveSession']! : RANK['recentSession']!, at: Math.max(s.lastAt, s.mtime), house: home });
        for (const h of s.helpers.values()) {
          const state = helperState(h, !!entry, now);
          if (state === 'asleep' && now - h.lastAt > 3_600_000) continue;
          if (state === 'asleep' && !entry) continue;
          const hd = toDTO(h, hash(`helper:${sid}/${h.agentId}`), 'helper', sid, state, 'Agent phụ');
          candidates.push({ dto: hd, rank: state === 'asleep' ? RANK['recentHelper']! : RANK['liveHelper']!, at: h.lastAt, house: home });
        }
      }
    }

    // A house that just stopped qualifying lingers a moment, so a brief failure cannot make it blink.
    const eligibleIds = new Set(eligible.map((e) => e.id));
    for (const [id, seen] of this.lastEligible) {
      if (eligibleIds.has(id)) continue;
      if (now - seen.at < HOUSE_GRACE_MS) eligible.push({ id, name: seen.name, at: 0, live: false });
      else this.lastEligible.delete(id);
    }

    eligible.sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at || a.id.localeCompare(b.id));
    const shown = eligible.slice(0, MAX_HOUSES);
    const shownIds = new Set(shown.map((h) => h.id));
    this.assignSlots(shownIds);

    candidates.sort((a, b) => a.rank - b.rank || b.at - a.at);
    const reachable = candidates.filter((c) => c.house === null || shownIds.has(c.house));
    const kept = new Set<string>();
    const present: Candidate[] = [];
    for (const c of reachable) {
      if (present.length >= MAX_PEOPLE) break;
      if (c.dto.parentId && !kept.has(c.dto.parentId)) continue;
      kept.add(c.dto.id);
      present.push(c);
    }

    const count = (house: string | null, list: Candidate[]) => list.filter((c) => c.house === house).length;
    const houses: HouseDTO[] = shown.map((h) => {
      const seen = this.lastEligible.get(h.id);
      const fresh = present.filter((c) => c.house === h.id).map((c) => c.dto);
      // While a house lingers its people stay too, for the same reason.
      const villagers = eligibleIds.has(h.id) ? fresh : (seen?.villagers ?? []);
      if (seen && eligibleIds.has(h.id)) seen.villagers = fresh;
      return { id: h.id, name: h.name, slot: this.slots.get(h.id) ?? 0, villagers, hiddenVillagers: count(h.id, reachable) - count(h.id, present) };
    });
    const inTent = present.filter((c) => c.house === null);
    return {
      at: now,
      houses,
      tent: tentUsed && count(null, reachable) > 0 ? { villagers: inTent.map((c) => c.dto), hiddenVillagers: count(null, reachable) - inTent.length } : null,
      hiddenHouses: eligible.length - shown.length,
    };
  }

  /** Slots survive across rebuilds, so an island never jumps while its project stays. */
  private assignSlots(ids: Set<string>): void {
    for (const id of this.slots.keys()) if (!ids.has(id)) this.slots.delete(id);
    const used = new Set(this.slots.values());
    for (const id of [...ids].sort()) {
      if (this.slots.has(id)) continue;
      let slot = Number.parseInt(id.slice(0, 8), 16) % MAX_HOUSES;
      while (used.has(slot)) slot = (slot + 1) % MAX_HOUSES;
      used.add(slot);
      this.slots.set(id, slot);
    }
  }
}
