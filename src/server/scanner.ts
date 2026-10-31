// Walks ~/.claude read-only and keeps the village model's inputs fresh.
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { VillageSnapshot } from '../shared/types.js';
import { applyActivity, applyMeta, newActor, newSession, VillageModel, HOUSE_DAYS, VILLAGER_HOURS, type Helper, type Project, type Session } from './model.js';
import { cleanLabel, parseLine } from './parser.js';
import { Registry, type RegistryDeps } from './registry.js';
import { FileTail, HEAD_RETRY, readHead } from './tailer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT = /^agent-[\w-]{1,120}$/;
const DAY = 86_400_000;
const STAT_TIMEOUT = 1_000;
const CWD_TTL = 30_000;
const HELPER_WINDOW = 3_600_000;

/** A UNC path could make stat open an SMB connection to another machine, so it never gets one. */
export const isUnc = (p: string) => /^[\\/]{2}/.test(p);

/** TEMP can be an 8.3 short path while transcripts hold the long form, so both are listed. */
function defaultTempRoots(): string[] {
  const roots = [tmpdir()];
  try {
    roots.push(realpathSync.native(tmpdir()));
  } catch {
    // The folder may be missing; the plain path above still applies.
  }
  if (process.env['SystemRoot']) roots.push(join(process.env['SystemRoot'], 'Temp'));
  return roots;
}

export interface ScannerOptions extends RegistryDeps {
  claudeHome: string;
  tempRoots?: string[];
}

export class Scanner {
  private readonly projectsDir: string;
  private readonly registry: Registry;
  private readonly projects = new Map<string, Project>();
  private readonly tails = new Map<string, FileTail>();
  private readonly headRead = new Set<string>();
  private readonly cwdCache = new Map<string, { ok: boolean; at: number }>();
  private readonly cwdPending = new Set<string>();
  private readonly model = new VillageModel();
  private readonly clock: () => number;
  private readonly tempRoots: string[];

  constructor(opts: ScannerOptions) {
    this.projectsDir = join(opts.claudeHome, 'projects');
    this.registry = new Registry(join(opts.claudeHome, 'sessions'), opts);
    this.clock = opts.now ?? Date.now;
    this.tempRoots = opts.tempRoots ?? defaultTempRoots();
  }

  async poll(): Promise<VillageSnapshot> {
    const now = this.clock();
    const live = await this.registry.read();
    const dirs = await listDirs(this.projectsDir);
    const seen = new Set(dirs);
    for (const dir of this.projects.keys()) {
      if (seen.has(dir)) continue;
      this.projects.delete(dir);
      this.forgetUnder(join(this.projectsDir, dir));
    }
    for (const dir of dirs) await this.scanProject(dir, live, now);
    const needed = new Set<string>();
    for (const p of this.projects.values()) for (const s of p.sessions.values()) if (s.cwd && !isUnc(s.cwd)) needed.add(s.cwd);
    for (const c of this.cwdCache.keys()) if (!needed.has(c)) this.cwdCache.delete(c);
    await Promise.all([...needed].map((c) => this.refreshCwd(c, now)));
    return this.model.build({
      projects: this.projects.values(),
      live,
      cwdExists: (c) => !isUnc(c) && (this.cwdCache.get(c)?.ok ?? false),
      tempRoots: this.tempRoots,
      now,
    });
  }

  private async scanProject(dir: string, live: Map<string, unknown>, now: number): Promise<void> {
    const root = join(this.projectsDir, dir);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    let project = this.projects.get(dir);
    if (!project) {
      project = { dir, sessions: new Map() };
      this.projects.set(dir, project);
    }
    const kept = new Set<string>();
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -6);
      if (!UUID.test(sessionId)) continue;
      const path = join(root, name);
      const info = await safeFile(path);
      if (!info) continue;
      const isLive = live.has(sessionId);
      if (!isLive && now - info.mtimeMs > HOUSE_DAYS * DAY) continue;
      kept.add(sessionId);
      let s = project.sessions.get(sessionId);
      if (!s) {
        s = newSession(sessionId);
        project.sessions.set(sessionId, s);
      }
      s.mtime = info.mtimeMs;
      if (!this.headRead.has(path)) await this.readSessionHead(path, s);
      if (isLive || now - info.mtimeMs < VILLAGER_HOURS * 3_600_000) {
        await this.tailInto(path, s);
        await this.scanHelpers(join(root, sessionId, 'subagents'), s, now);
      }
    }
    for (const sessionId of project.sessions.keys()) {
      if (kept.has(sessionId)) continue;
      project.sessions.delete(sessionId);
      this.forgetUnder(join(root, sessionId));
      this.forget(join(root, `${sessionId}.jsonl`));
    }
  }

  private async readSessionHead(path: string, s: Session): Promise<void> {
    for (const limit of [undefined, HEAD_RETRY]) {
      const lines = await readHead(path, limit);
      // A file that could not be opened, a lock for instance, gets another try on the next poll.
      if (lines === null) return;
      for (const line of lines) {
        const r = parseLine(line);
        if (r) applyMeta(s, r);
      }
      if (s.cwd && s.hasPrompt) break;
    }
    this.headRead.add(path);
  }

  private forget(path: string): void {
    this.tails.delete(path);
    this.headRead.delete(path);
  }

  private forgetUnder(folder: string): void {
    const prefix = folder + sep;
    for (const path of this.tails.keys()) if (path.startsWith(prefix)) this.tails.delete(path);
    for (const path of this.headRead) if (path.startsWith(prefix)) this.headRead.delete(path);
  }

  private async tailInto(path: string, s: Session): Promise<void> {
    let tail = this.tails.get(path);
    if (!tail) {
      tail = new FileTail(path);
      this.tails.set(path, tail);
    }
    for (const line of await tail.poll()) {
      const r = parseLine(line);
      if (!r) continue;
      applyMeta(s, r);
      applyActivity(s, r);
    }
  }

  private async scanHelpers(dir: string, s: Session, now: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const agentId of s.helpers.keys()) {
      const path = join(dir, `${agentId}.jsonl`);
      const info = names.includes(`${agentId}.jsonl`) ? await safeFile(path) : null;
      if (!info || now - info.mtimeMs > HELPER_WINDOW) {
        s.helpers.delete(agentId);
        this.tails.delete(path);
      }
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const agentId = name.slice(0, -6);
      if (!AGENT.test(agentId)) continue;
      const path = join(dir, name);
      const info = await safeFile(path);
      if (!info || now - info.mtimeMs > HELPER_WINDOW) continue;
      let h = s.helpers.get(agentId);
      if (!h) {
        h = { ...newActor(), agentId, finished: false } satisfies Helper;
        s.helpers.set(agentId, h);
      }
      let tail = this.tails.get(path);
      if (!tail) {
        tail = new FileTail(path);
        this.tails.set(path, tail);
      }
      for (const line of await tail.poll()) {
        const r = parseLine(line);
        if (r) applyActivity(h, r);
      }
      await readMeta(join(dir, `${agentId}.meta.json`), h);
    }
  }

  private async refreshCwd(cwd: string, now: number): Promise<void> {
    const c = this.cwdCache.get(cwd);
    if ((c && now - c.at < CWD_TTL) || this.cwdPending.has(cwd)) return;
    // stat cannot be cancelled: a hung network drive must not collect more of them.
    this.cwdPending.add(cwd);
    const check = stat(cwd).then((i) => i.isDirectory(), () => false);
    void check.finally(() => this.cwdPending.delete(cwd));
    this.cwdCache.set(cwd, { ok: await withTimeout(check), at: now });
  }
}

async function readMeta(path: string, h: Helper): Promise<void> {
  try {
    const o = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
    if (o['finished']) h.finished = true;
    const parts = [cleanLabel(o['agentType']), cleanLabel(o['description'])].filter(Boolean);
    if (parts.length) h.title = parts.join(': ').slice(0, 80);
  } catch {
    // The meta file is optional, and may be caught mid-write.
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeFile(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function withTimeout(check: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((ok) => { timer = setTimeout(() => ok(false), STAT_TIMEOUT); });
  const result = await Promise.race([check, timeout]);
  clearTimeout(timer);
  return result;
}
