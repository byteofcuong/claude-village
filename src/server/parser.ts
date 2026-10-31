// Turns one transcript line into a small record. Prompts, thinking, tool output and Bash commands
// are dropped here, so nothing downstream can leak them.
import { basename } from 'node:path';
import type { Activity } from '../shared/types.js';

export type Block =
  | { kind: 'thinking' }
  | { kind: 'text' }
  | { kind: 'tool_use'; id: string; name: string; label: string | null }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean };

export interface ParsedRecord {
  at: number | null;
  sessionId: string | null;
  agentId: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  isRealPrompt: boolean;
  stopReason: string | null;
  blocks: Block[];
}

const MAX_LABEL = 60;
const PATHISH = /[\\/]|^[A-Za-z]:/;

/** Removes path-like tokens and shortens free text before it can reach a client. */
export function cleanLabel(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // Any token with a slash goes, which also catches the tail of a path that contains spaces.
  const words: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (!PATHISH.test(word)) words.push(word);
    else if (words[words.length - 1] !== '…') words.push('…');
  }
  const flat = words.join(' ');
  if (!flat || flat === '…') return null;
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Branch names may hold slashes, but not arbitrary text. */
export function cleanBranch(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return text.replace(/[^\w./-]/g, '').slice(0, 60) || null;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const DESCRIBED_TOOLS = new Set(['Bash', 'PowerShell', 'Agent', 'Task']);

function toolLabel(name: string, input: unknown): string | null {
  const args = obj(input);
  if (!args) return null;
  if (FILE_TOOLS.has(name)) {
    const path = str(args['file_path']) ?? str(args['notebook_path']);
    return path ? cleanLabel(basename(path.replace(/\\/g, '/'))) : null;
  }
  if (DESCRIBED_TOOLS.has(name)) return cleanLabel(args['description']);
  return null;
}

const ACTIVITIES: Record<string, Activity> = {
  Read: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading',
  Edit: 'building', Write: 'building', NotebookEdit: 'building', MultiEdit: 'building',
  Bash: 'running', PowerShell: 'running',
  WebSearch: 'exploring', WebFetch: 'exploring',
  Agent: 'delegating', Task: 'delegating',
};

export const activityOfTool = (name: string): Activity => ACTIVITIES[name] ?? 'working';

/** Tool names are shown to the user; odd ones are reduced to something harmless. */
function cleanToolName(name: string): string {
  return name.replace(/[^\w.:-]/g, '').slice(0, 60) || 'tool';
}

function parseBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const raw of content) {
    const b = obj(raw);
    if (!b) continue;
    if (b['type'] === 'thinking') out.push({ kind: 'thinking' });
    else if (b['type'] === 'text') out.push({ kind: 'text' });
    else if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
      out.push({ kind: 'tool_use', id: b['id'], name: cleanToolName(b['name']), label: toolLabel(b['name'], b['input']) });
    } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      out.push({ kind: 'tool_result', toolUseId: b['tool_use_id'], isError: b['is_error'] === true });
    }
  }
  return out;
}

// Slash commands and interruptions are recorded as user text, though nobody asked for anything.
const NOT_A_PROMPT = /^\s*(<command-|<local-command|Caveat:|\[Request interrupted)/;
const realText = (t: unknown) => typeof t === 'string' && t.trim().length > 0 && !NOT_A_PROMPT.test(t);

function isPromptContent(content: unknown): boolean {
  if (typeof content === 'string') return realText(content);
  if (!Array.isArray(content) || content.some((b) => obj(b)?.['type'] === 'tool_result')) return false;
  return content.some((b) => obj(b)?.['type'] === 'text' && realText(obj(b)?.['text']));
}

/** Returns null for anything that is not a JSON object. Unknown record types yield an empty record. */
export function parseLine(line: Buffer | string): ParsedRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'));
  } catch {
    return null;
  }
  const r = obj(raw);
  if (!r) return null;
  const type = r['type'];
  const message = obj(r['message']);
  const ts = typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : NaN;
  const blocks = type === 'assistant' || type === 'user' ? parseBlocks(message?.['content']) : [];
  const sidechain = r['isSidechain'] === true;
  return {
    at: Number.isNaN(ts) ? null : ts,
    sessionId: str(r['sessionId']),
    agentId: str(r['agentId']),
    cwd: str(r['cwd']),
    branch: cleanBranch(r['gitBranch']),
    title: type === 'custom-title' ? cleanLabel(r['customTitle']) : type === 'agent-name' ? cleanLabel(r['agentName']) : null,
    isRealPrompt: type === 'user' && !sidechain && r['isMeta'] !== true && isPromptContent(message?.['content']),
    stopReason: type === 'assistant' ? str(message?.['stop_reason']) : null,
    blocks,
  };
}
