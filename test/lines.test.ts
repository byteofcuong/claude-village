import { describe, expect, it } from 'vitest';
import { CHATS, lineFor, type LineKey } from '../src/client/lines.js';

const KEYS: LineKey[] = ['thinking', 'talking', 'reading', 'building', 'running', 'exploring', 'delegating', 'working', 'resting', 'asleep', 'error', 'long'];
const ROLLS = Array.from({ length: 50 }, (_, i) => i / 50);

describe('lineFor', () => {
  it('has something to say for every kind of work', () => {
    for (const key of KEYS) for (const roll of ROLLS) expect(lineFor(key, null, roll).length).toBeGreaterThan(0);
  });

  it('names the current task only through its short label', () => {
    expect(ROLLS.map((r) => lineFor('reading', 'notes.md', r)).some((l) => l.includes('notes.md'))).toBe(true);
    expect(ROLLS.map((r) => lineFor('thinking', 'notes.md', r)).some((l) => l.includes('notes.md'))).toBe(false);
  });

  it('keeps a long label short enough to read', () => {
    for (const roll of ROLLS) expect(lineFor('running', 'x'.repeat(300), roll).length).toBeLessThanOrEqual(38);
  });

  it('never goes out of range at the top of the roll', () => {
    for (const key of KEYS) expect(lineFor(key, 'a', 0.999999)).toBeTruthy();
  });
});

describe('CHATS', () => {
  it('pairs every question with an answer', () => {
    for (const [ask, reply] of CHATS) { expect(ask).toBeTruthy(); expect(reply).toBeTruthy(); }
  });
});
