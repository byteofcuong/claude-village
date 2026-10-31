// Builds a synthetic ~/.claude tree. No real transcript data is ever used in tests.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const iso = (t: number) => new Date(t).toISOString();

export const rec = {
  prompt: (t: number, cwd: string, text = 'hello') => JSON.stringify({ type: 'user', timestamp: iso(t), cwd, gitBranch: 'main', message: { content: text } }),
  tool: (t: number, id: string, name: string, input: unknown = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(t), message: { content: [{ type: 'tool_use', id, name, input }] } }),
  result: (t: number, id: string, isError = false, content = 'output') => JSON.stringify({ type: 'user', timestamp: iso(t), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } }),
  think: (t: number, text = 'thought') => JSON.stringify({ type: 'assistant', timestamp: iso(t), message: { content: [{ type: 'thinking', thinking: text }] } }),
  title: (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t }),
};

export async function writeSession(home: string, dir: string, id: string, lines: string[]): Promise<string> {
  const p = join(home, 'projects', dir, `${id}.jsonl`);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${lines.join('\n')}\n`);
  return p;
}

export async function writeHelper(home: string, dir: string, sessionId: string, agent: string, lines: string[], meta: unknown = { agentType: 'implementer', description: 'Fix it', finished: false }) {
  const base = join(home, 'projects', dir, sessionId, 'subagents');
  await mkdir(base, { recursive: true });
  await writeFile(join(base, `${agent}.jsonl`), `${lines.join('\n')}\n`);
  await writeFile(join(base, `${agent}.meta.json`), JSON.stringify(meta));
}

export async function writeLive(home: string, pid: number, sessionId: string, status: string, startedAt: number) {
  const dir = join(home, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, status, startedAt, cwd: 'x', messagingSocketPath: 'never-used' }));
}

export async function treeHash(root: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else h.update(p).update(await readFile(p));
    }
  };
  await walk(root);
  return h.digest('hex');
}
