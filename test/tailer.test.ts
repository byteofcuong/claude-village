import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTail, readHead } from '../src/server/tailer.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cv-tail-'));
  file = join(dir, 't.jsonl');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const text = (lines: Buffer[]) => lines.map((l) => l.toString('utf8'));

describe('FileTail', () => {
  it('returns nothing for a missing file', async () => {
    expect(await new FileTail(file).poll()).toEqual([]);
  });

  it('reads whole small files, then only appended lines', async () => {
    await writeFile(file, 'a\nb\n');
    const t = new FileTail(file);
    expect(text(await t.poll())).toEqual(['a', 'b']);
    expect(await t.poll()).toEqual([]);
    await appendFile(file, 'c\n');
    expect(text(await t.poll())).toEqual(['c']);
  });

  it('holds an unfinished line until its newline arrives', async () => {
    await writeFile(file, 'one\ntw');
    const t = new FileTail(file);
    expect(text(await t.poll())).toEqual(['one']);
    await appendFile(file, 'o\n');
    expect(text(await t.poll())).toEqual(['two']);
  });

  it('keeps UTF-8 intact when a write stops inside a character', async () => {
    const bytes = Buffer.from('nhà sàn\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;
    await writeFile(file, bytes.subarray(0, cut));
    const t = new FileTail(file);
    expect(await t.poll()).toEqual([]);
    await appendFile(file, bytes.subarray(cut));
    expect(text(await t.poll())).toEqual(['nhà sàn']);
  });

  it('starts inside a large file and drops the first partial line', async () => {
    await writeFile(file, `${'x'.repeat(100)}\nkeep\n`);
    const t = new FileTail(file, 20);
    expect(text(await t.poll())).toEqual(['keep']);
  });

  it('skips oversized lines and carries on', async () => {
    await writeFile(file, `small\n${'y'.repeat(50)}\nnext\n`);
    const t = new FileTail(file, 1000, 10);
    expect(text(await t.poll())).toEqual(['small', 'next']);
  });

  it('skips an oversized line that spans several polls', async () => {
    await writeFile(file, 'y'.repeat(50));
    const t = new FileTail(file, 1000, 10);
    expect(await t.poll()).toEqual([]);
    await appendFile(file, `${'y'.repeat(50)}\nafter\n`);
    expect(text(await t.poll())).toEqual(['after']);
  });

  it('restarts when the file gets shorter', async () => {
    await writeFile(file, 'old-line-1\nold-line-2\n');
    const t = new FileTail(file);
    await t.poll();
    await truncate(file, 0);
    await appendFile(file, 'new\n');
    expect(text(await t.poll())).toEqual(['new']);
  });
});

describe('readHead', () => {
  it('returns only complete lines within the limit', async () => {
    await writeFile(file, 'aa\nbb\ncccccc\n');
    expect(text((await readHead(file, 8)) ?? [])).toEqual(['aa', 'bb']);
  });
  it('reports a file it cannot open', async () => {
    expect(await readHead(join(dir, 'none'))).toBeNull();
  });
});
