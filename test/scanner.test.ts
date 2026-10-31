import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTempCwd } from '../src/server/model.js';
import { isUnc, Scanner } from '../src/server/scanner.js';
import { rec, treeHash, uuid, writeHelper, writeLive, writeSession } from './helpers.js';

let root: string, home: string, real: string, gone: string, scratch: string;
const NOW = Date.now();
const opts = (extra = {}) => ({ claudeHome: home, tempRoots: [], now: () => NOW, alive: () => true, bootTime: () => 0, ...extra });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cv-scan-'));
  home = join(root, 'home');
  real = join(root, 'projects', 'my-app');
  gone = join(root, 'projects', 'deleted');
  scratch = join(root, 'scratch-workspaces', 'abc');
  await mkdir(real, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await mkdir(join(home, 'projects'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const age = (path: string, days: number) => utimes(path, new Date(NOW - days * 86_400_000), new Date(NOW - days * 86_400_000));

describe('junk houses', () => {
  it('shows a real project and rejects every kind of junk', async () => {
    await writeSession(home, 'real', uuid(1), [rec.prompt(NOW - 1000, real), rec.tool(NOW - 900, 'a', 'Read', { file_path: 'x.ts' })]);
    await writeSession(home, 'deleted-cwd', uuid(2), [rec.prompt(NOW - 1000, gone)]);
    await writeSession(home, 'scratch', uuid(3), [rec.prompt(NOW - 1000, scratch)]);
    await writeSession(home, 'no-prompt', uuid(4), [rec.tool(NOW - 1000, 'a', 'Read')]);
    await mkdir(join(home, 'projects', 'empty-dir', uuid(9), 'subagents'), { recursive: true });
    const old = await writeSession(home, 'too-old', uuid(5), [rec.prompt(NOW - 40 * 86_400_000, real)]);
    await age(old, 40);
    await writeSession(home, 'bad-name', 'not-a-uuid', [rec.prompt(NOW, real)]);
    const snap = await new Scanner(opts()).poll();
    expect(snap.houses.map((h) => h.name)).toEqual(['my-app']);
    expect(snap.tent).toBeNull();
  });

  it('keeps a project alive past 14 days only while a session runs', async () => {
    const p = await writeSession(home, 'old-live', uuid(6), [rec.prompt(NOW - 30 * 86_400_000, real)]);
    await age(p, 30);
    await writeLive(home, 111, uuid(6), 'idle', NOW);
    const snap = await new Scanner(opts()).poll();
    expect(snap.houses).toHaveLength(1);
    expect(snap.houses[0]?.villagers[0]?.state).toBe('idle');
  });

  describe('a session that moved into another project', () => {
    const folderOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
    let other: string;
    beforeEach(async () => {
      other = join(root, 'projects', 'other-app');
      await mkdir(other, { recursive: true });
    });

    it('does not rename the house it started in', async () => {
      await writeSession(home, folderOf(real), uuid(1), [rec.prompt(NOW - 9000, real)]);
      await age(await writeSession(home, folderOf(other), uuid(2), [rec.prompt(NOW - 8000, other)]), 1);
      const moved = await writeSession(home, folderOf(other), uuid(3), [rec.prompt(NOW - 1000, real)]);
      await utimes(moved, new Date(NOW), new Date(NOW));
      const snap = await new Scanner(opts()).poll();
      expect(snap.houses.map((h) => h.name).sort()).toEqual(['my-app', 'other-app']);
    });

    it('joins the real house when its folder has no session of its own', async () => {
      await writeSession(home, folderOf(real), uuid(1), [rec.prompt(NOW - 9000, real)]);
      await writeSession(home, 'folder-of-a-deleted-project', uuid(2), [rec.prompt(NOW - 1000, real)]);
      const snap = await new Scanner(opts()).poll();
      expect(snap.houses.map((h) => h.name)).toEqual(['my-app']);
      expect(snap.houses[0]?.villagers).toHaveLength(2);
    });
  });

  it('never reads a UNC cwd', () => {
    expect(isUnc('\\\\server\\share')).toBe(true);
    expect(isUnc('//server/share')).toBe(true);
    expect(isUnc('/\\server\\share')).toBe(true);
    expect(isUnc('\\/server/share')).toBe(true);
    expect(isUnc('C:\\work')).toBe(false);
  });

  it('classifies temp folders on Windows paths', () => {
    expect(isTempCwd('C:\\Home\\X\\AppData\\Local\\Temp\\a', ['c:/home/x/appdata/local/temp'])).toBe(true);
    expect(isTempCwd('D:\\code\\scratch-workspaces\\x', [])).toBe(true);
    expect(isTempCwd('D:\\code\\tempest', ['d:\\code\\temp'])).toBe(false);
  });
});

describe('guest tent', () => {
  it('appears only while a temp session lives', async () => {
    await writeSession(home, 'scratch', uuid(3), [rec.prompt(NOW - 1000, scratch)]);
    await writeLive(home, 222, uuid(3), 'busy', NOW);
    const snap = await new Scanner(opts()).poll();
    expect(snap.houses).toHaveLength(0);
    expect(snap.tent?.villagers).toHaveLength(1);
    const after = await new Scanner(opts({ alive: () => false })).poll();
    expect(after.tent).toBeNull();
  });
});

describe('live state and helpers', () => {
  it('derives states from the registry and pending tools', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 90_000, real), rec.title('My title'), rec.tool(NOW - 60_000, 't', 'Bash', { command: 'CANARY-run', description: 'Run tests' })]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const v = (await new Scanner(opts()).poll()).houses[0]?.villagers[0];
    expect(v).toMatchObject({ state: 'long-running', activity: 'running', currentTool: 'Bash', currentLabel: 'Run tests', title: 'My title', branch: 'main' });
  });

  it('shows an error briefly, then recovers', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real), rec.tool(NOW - 3000, 't', 'Edit'), rec.result(NOW - 2000, 't', true)]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const s = new Scanner(opts());
    const v = (await s.poll()).houses[0]?.villagers[0];
    expect(v?.state).toBe('error');
    expect(v?.timeline[0]?.failed).toBe(true);
    const later = await new Scanner(opts({ now: () => NOW + 20_000 })).poll();
    expect(later.houses[0]?.villagers[0]?.state).toBe('active');
  });

  it('puts an asleep label on recent sessions without a process', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    expect((await new Scanner(opts()).poll()).houses[0]?.villagers[0]).toMatchObject({ state: 'asleep', activity: 'resting' });
  });

  it('ignores a registry entry older than the boot, since its PID was reused', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    await writeLive(home, 1, uuid(1), 'busy', NOW - 86_400_000);
    const s = new Scanner(opts({ bootTime: () => NOW - 3_600_000 }));
    expect((await s.poll()).houses[0]?.villagers[0]?.state).toBe('asleep');
  });

  it('links helpers to their parent', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    await writeHelper(home, 'a', uuid(1), 'agent-abc', [rec.tool(NOW - 1000, 'h', 'Write', { file_path: 'a/b/c.ts' })]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const vs = (await new Scanner(opts()).poll()).houses[0]?.villagers ?? [];
    const parent = vs.find((v) => v.kind === 'session');
    const helper = vs.find((v) => v.kind === 'helper');
    expect(helper).toMatchObject({ parentId: parent?.id, title: 'implementer: Fix it', activity: 'building', currentLabel: 'c.ts', state: 'active' });
  });

  it('marks a finished helper asleep', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    await writeHelper(home, 'a', uuid(1), 'agent-abc', [rec.think(NOW - 1000)], { finished: true });
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const vs = (await new Scanner(opts()).poll()).houses[0]?.villagers ?? [];
    expect(vs.find((v) => v.kind === 'helper')?.state).toBe('asleep');
  });

  it('follows new lines between polls', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const s = new Scanner(opts());
    await s.poll();
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real), rec.tool(NOW - 100, 'x', 'WebFetch')]);
    expect((await s.poll()).houses[0]?.villagers[0]?.activity).toBe('exploring');
  });
});

describe('review fixes', () => {
  it('counts a session in two project folders once, in the newest copy', async () => {
    const oldFile = await writeSession(home, 'old', uuid(1), [rec.prompt(NOW - 20 * 86_400_000, real)]);
    await age(oldFile, 20);
    await writeSession(home, 'new', uuid(1), [rec.prompt(NOW - 1000, scratch), rec.prompt(NOW - 900, real)]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const snap = await new Scanner(opts()).poll();
    expect(snap.houses).toHaveLength(1);
    expect(snap.houses[0]?.villagers.filter((v) => v.state === 'active')).toHaveLength(1);
  });

  it('does not rename a project when a shell moves into a subfolder', async () => {
    const sub = join(real, 'src');
    await mkdir(sub);
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real), rec.prompt(NOW - 4000, sub)]);
    expect((await new Scanner(opts()).poll()).houses[0]?.name).toBe('my-app');
  });

  it('follows a session that moves to another folder', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, scratch), rec.prompt(NOW - 4000, real)]);
    expect((await new Scanner(opts()).poll()).houses[0]?.name).toBe('my-app');
  });

  it('clears orphaned tools on a new prompt and with age', async () => {
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 90_000, real), rec.tool(NOW - 80_000, 'x', 'Bash'), rec.prompt(NOW - 1000, real)]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    expect((await new Scanner(opts()).poll()).houses[0]?.villagers[0]).toMatchObject({ state: 'active', currentTool: null });
    await writeSession(home, 'b', uuid(2), [rec.prompt(NOW - 3_600_000, real), rec.tool(NOW - 3_500_000, 'x', 'Bash')]);
    await writeLive(home, 2, uuid(2), 'busy', NOW);
    const all = (await new Scanner(opts()).poll()).houses.flatMap((h) => h.villagers);
    expect(all.filter((v) => v.state === 'long-running')).toHaveLength(0);
  });

  it('finds the cwd after a first line larger than the normal head window', async () => {
    const big = rec.prompt(NOW - 3 * 86_400_000, real, 'x'.repeat(400 * 1024));
    const p = await writeSession(home, 'a', uuid(1), [big]);
    await age(p, 3);
    expect((await new Scanner(opts()).poll()).houses.map((h) => h.name)).toEqual(['my-app']);
  });

  it('rebuilds a project whose folder vanished and came back', async () => {
    let t = NOW;
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    const s = new Scanner(opts({ now: () => t }));
    await s.poll();
    await rm(join(home, 'projects', 'a'), { recursive: true });
    t += 120_000;
    expect((await s.poll()).houses).toHaveLength(0);
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    t += 1_000;
    expect((await s.poll()).houses.map((h) => h.name)).toEqual(['my-app']);
  });

  it('keeps villagers while a house lingers', async () => {
    let t = NOW;
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    const s = new Scanner(opts({ now: () => t }));
    expect((await s.poll()).houses[0]?.villagers).toHaveLength(1);
    await rm(join(home, 'projects', 'a'), { recursive: true });
    t += 10_000;
    expect((await s.poll()).houses[0]?.villagers).toHaveLength(1);
  });
});

describe('limits', () => {
  it('caps houses at 14 and people at 30, live first, with stable unique slots', async () => {
    for (let i = 0; i < 20; i++) {
      const cwd = join(root, 'projects', `p${i}`);
      await mkdir(cwd, { recursive: true });
      for (let j = 0; j < 3; j++) await writeSession(home, `d${i}`, uuid(i * 10 + j + 100), [rec.prompt(NOW - 1000 - i, cwd)]);
    }
    await writeLive(home, 7, uuid(19 * 10 + 100), 'busy', NOW);
    const s = new Scanner(opts());
    const snap = await s.poll();
    expect(snap.houses).toHaveLength(14);
    expect(snap.hiddenHouses).toBe(6);
    expect(snap.houses.flatMap((h) => h.villagers).length).toBeLessThanOrEqual(30);
    expect(snap.houses[0]?.name).toBe('p19');
    expect(snap.houses[0]?.villagers.some((v) => v.state === 'active')).toBe(true);
    const slots = snap.houses.map((h) => h.slot);
    expect(new Set(slots).size).toBe(14);
    const again = await s.poll();
    expect(Object.fromEntries(again.houses.map((h) => [h.id, h.slot]))).toEqual(Object.fromEntries(snap.houses.map((h) => [h.id, h.slot])));
  });

  it('keeps a house through a grace period, then removes it', async () => {
    let t = NOW;
    await writeSession(home, 'a', uuid(1), [rec.prompt(NOW - 5000, real)]);
    const s = new Scanner(opts({ now: () => t }));
    expect((await s.poll()).houses).toHaveLength(1);
    await rm(join(home, 'projects', 'a'), { recursive: true });
    t += 10_000;
    expect((await s.poll()).houses).toHaveLength(1);
    t += 120_000;
    expect((await s.poll()).houses).toHaveLength(0);
  });
});

describe('read-only and privacy', () => {
  it('changes nothing on disk and sends no private text or paths', async () => {
    const canary = 'CANARY-secret-9';
    await writeSession(home, 'a', uuid(1), [
      rec.prompt(NOW - 5000, real, canary), rec.think(NOW - 4000, canary),
      rec.tool(NOW - 3000, 't', 'Bash', { command: canary, description: 'Harmless' }), rec.result(NOW - 2000, 't', false, canary),
      rec.tool(NOW - 1000, 'r', 'Read', { file_path: join(real, 'secret-dir', 'f.ts') }),
    ]);
    await writeLive(home, 1, uuid(1), 'busy', NOW);
    const before = await treeHash(home);
    const s = new Scanner(opts());
    await s.poll();
    const text = JSON.stringify(await s.poll());
    expect(await treeHash(home)).toBe(before);
    expect(text).not.toContain(canary);
    expect(text).not.toContain('secret-dir');
    expect(text).not.toContain(root.replace(/\\/g, '\\\\'));
    expect(text).not.toContain(uuid(1));
    expect(text).not.toContain('never-used');
    expect(text).toContain('f.ts');
  });

  it('survives a missing ~/.claude', async () => {
    const snap = await new Scanner({ claudeHome: join(root, 'nope'), tempRoots: [] }).poll();
    expect(snap).toMatchObject({ houses: [], tent: null, hiddenHouses: 0 });
  });
});
