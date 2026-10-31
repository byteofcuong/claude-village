import { describe, expect, it } from 'vitest';
import { activityOfTool, cleanLabel, parseLine } from '../src/server/parser.js';

const line = (o: unknown) => JSON.stringify(o);

describe('parseLine', () => {
  it('returns null for broken JSON and non-objects', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(parseLine('[1,2]')).toBeNull();
    expect(parseLine('42')).toBeNull();
  });

  it('keeps unknown record types as empty records', () => {
    const r = parseLine(line({ type: 'brand-new-kind', sessionId: 's', cwd: 'x', anything: { deep: true } }));
    expect(r).toMatchObject({ sessionId: 's', cwd: 'x', blocks: [], isRealPrompt: false, title: null });
  });

  it('survives malformed blocks', () => {
    const r = parseLine(line({ type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }, { type: 'future' }, { type: 'text', text: 'x' }] } }));
    expect(r?.blocks).toEqual([{ kind: 'text' }]);
  });

  it('reads tool use and tool result, including errors', () => {
    const r = parseLine(line({
      type: 'assistant', timestamp: '2026-01-02T03:04:05.000Z', sessionId: 's', gitBranch: 'main', message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'secret thought' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\a\\b\\file.ts' } }] },
    }));
    expect(r?.at).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(r?.stopReason).toBe('tool_use');
    expect(r?.blocks).toEqual([{ kind: 'thinking' }, { kind: 'tool_use', id: 't1', name: 'Read', label: 'file.ts' }]);
    const u = parseLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'output' }] } }));
    expect(u?.blocks).toEqual([{ kind: 'tool_result', toolUseId: 't1', isError: true }]);
    expect(u?.isRealPrompt).toBe(false);
  });

  it('never carries prompt text, thinking, commands or tool output', () => {
    const canary = 'CANARY-7f3a';
    const records = [
      { type: 'user', message: { content: `hello ${canary}` } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: canary }, { type: 'text', text: canary }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: `curl ${canary}`, description: 'List files' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: canary } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: canary }] } },
    ];
    for (const rec of records) expect(JSON.stringify(parseLine(line(rec)))).not.toContain(canary);
    expect(parseLine(line(records[2]))?.blocks[0]).toMatchObject({ label: 'List files' });
  });

  it('recognises real prompts only', () => {
    expect(parseLine(line({ type: 'user', message: { content: 'hi' } }))?.isRealPrompt).toBe(true);
    expect(parseLine(line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }))?.isRealPrompt).toBe(true);
    expect(parseLine(line({ type: 'user', isMeta: true, message: { content: 'hi' } }))?.isRealPrompt).toBe(false);
    expect(parseLine(line({ type: 'user', isSidechain: true, message: { content: 'hi' } }))?.isRealPrompt).toBe(false);
    expect(parseLine(line({ type: 'user', message: { content: '   ' } }))?.isRealPrompt).toBe(false);
    for (const noise of ['<command-name>/clear</command-name>', '<local-command-stdout>x</local-command-stdout>', 'Caveat: messages below', '[Request interrupted by user]']) {
      expect(parseLine(line({ type: 'user', message: { content: noise } }))?.isRealPrompt).toBe(false);
      expect(parseLine(line({ type: 'user', message: { content: [{ type: 'text', text: noise }] } }))?.isRealPrompt).toBe(false);
    }
  });

  it('limits branch names to harmless characters', () => {
    expect(parseLine(line({ type: 'user', gitBranch: 'feat/x-1' }))?.branch).toBe('feat/x-1');
    expect(parseLine(line({ type: 'user', gitBranch: 'a b<c>'.repeat(30) }))?.branch?.length).toBe(60);
  });

  it('reads titles and tolerates a bad timestamp', () => {
    expect(parseLine(line({ type: 'custom-title', customTitle: 'My work', sessionId: 's' }))?.title).toBe('My work');
    expect(parseLine(line({ type: 'agent-name', agentName: 'Agent', sessionId: 's' }))?.title).toBe('Agent');
    expect(parseLine(line({ type: 'user', timestamp: 'nope' }))?.at).toBeNull();
  });
});

describe('cleanLabel', () => {
  it('removes paths and truncates', () => {
    expect(cleanLabel('Open C:\\secret\\dir\\a.txt now')).toBe('Open … now');
    expect(cleanLabel('see /home/me/x.txt and ./a/b.ts')).toBe('see … and …');
    expect(cleanLabel('Copy D:\\My Projects\\acme\\x')).toBe('Copy …');
    expect(cleanLabel('Read /etc/passwd and ~/.ssh')).toBe('Read … and …');
    expect(cleanLabel('C:\\only\\path')).toBeNull();
    expect(cleanLabel('x'.repeat(200))?.length).toBe(60);
    expect(cleanLabel(5)).toBeNull();
    expect(cleanLabel('   ')).toBeNull();
  });
});

describe('activityOfTool', () => {
  it('maps tools and defaults unknown ones', () => {
    expect(activityOfTool('Edit')).toBe('building');
    expect(activityOfTool('PowerShell')).toBe('running');
    expect(activityOfTool('mcp__x__y')).toBe('working');
  });
});
