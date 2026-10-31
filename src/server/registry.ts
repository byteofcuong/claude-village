// Reads ~/.claude/sessions/<pid>.json to learn which sessions are alive. Read-only: the
// messagingSocketPath in those files is ignored on purpose, this app never talks to a session.
import { readFile, readdir } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';

export interface LiveEntry {
  sessionId: string;
  status: string;
  pid: number;
  startedAt: number;
}

/** Signal 0 only tests for existence. This wrapper is the only process.kill call in the app. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RegistryDeps {
  alive?: (pid: number) => boolean;
  now?: () => number;
  bootTime?: () => number;
}

export class Registry {
  private lastGood = new Map<string, LiveEntry>();

  constructor(private readonly dir: string, private readonly deps: RegistryDeps = {}) {}

  /** Live entries by session id. A file caught mid-write keeps its last good value. */
  async read(): Promise<Map<string, LiveEntry>> {
    const alive = this.deps.alive ?? processAlive;
    const now = this.deps.now ?? Date.now;
    const boot = (this.deps.bootTime ?? (() => now() - uptime() * 1000))();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      this.lastGood.clear();
      return new Map();
    }
    const files = new Set(names.filter((n) => n.endsWith('.json')));
    for (const key of this.lastGood.keys()) if (!files.has(key)) this.lastGood.delete(key);
    await Promise.all([...files].map(async (name) => {
      const parsed = await readEntry(join(this.dir, name));
      if (parsed) this.lastGood.set(name, parsed);
    }));
    const live = new Map<string, LiveEntry>();
    for (const entry of this.lastGood.values()) {
      // A process cannot predate the boot: such an entry is a stale file whose PID was reused.
      if (entry.startedAt && entry.startedAt < boot - 60_000) continue;
      if (alive(entry.pid)) live.set(entry.sessionId, entry);
    }
    return live;
  }
}

async function readEntry(path: string): Promise<LiveEntry | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const o = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>;
    if (typeof o['pid'] !== 'number' || !Number.isInteger(o['pid']) || o['pid'] <= 0 || typeof o['sessionId'] !== 'string') return null;
    return {
      pid: o['pid'],
      sessionId: o['sessionId'],
      status: typeof o['status'] === 'string' ? o['status'] : 'unknown',
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : 0,
    };
  } catch {
    return null;
  }
}
