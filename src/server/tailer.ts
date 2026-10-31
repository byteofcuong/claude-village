// Follows an append-only jsonl file by byte offset. Lines are split on 0x0A before decoding, so a
// read that ends inside a multi-byte character can never corrupt text.
import { open, stat } from 'node:fs/promises';

export const TAIL_WINDOW = 256 * 1024;
export const MAX_LINE = 8 * 1024 * 1024;
const CHUNK = 256 * 1024;

export class FileTail {
  private offset: number | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skippingLine = false;
  private dropFirstPartial = false;

  constructor(
    readonly path: string,
    private readonly window = TAIL_WINDOW,
    private readonly maxLine = MAX_LINE,
  ) {}

  /** Returns complete lines appended since the last call. A missing file yields none. */
  async poll(): Promise<Buffer[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return [];
    }
    if (this.offset === null || size < this.offset) this.reset(size);
    if (size === this.offset) return [];
    const offset = this.offset ?? 0;
    const handle = await open(this.path, 'r');
    const lines: Buffer[] = [];
    try {
      let at = offset;
      while (at < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - at));
        const { bytesRead } = await handle.read(buf, 0, buf.length, at);
        if (bytesRead === 0) break;
        this.feed(buf.subarray(0, bytesRead), lines);
        at += bytesRead;
      }
      this.offset = at;
    } finally {
      await handle.close();
    }
    return lines;
  }

  private reset(size: number): void {
    const start = Math.max(0, size - this.window);
    this.offset = start;
    this.pending = [];
    this.pendingBytes = 0;
    this.skippingLine = false;
    this.dropFirstPartial = start > 0;
  }

  private feed(chunk: Buffer, out: Buffer[]): void {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl < 0) break;
      const piece = chunk.subarray(from, nl);
      from = nl + 1;
      if (this.dropFirstPartial) {
        this.dropFirstPartial = false;
        continue;
      }
      if (this.skippingLine) {
        this.skippingLine = false;
        continue;
      }
      const line = this.pendingBytes ? Buffer.concat([...this.pending, piece]) : Buffer.from(piece);
      this.pending = [];
      this.pendingBytes = 0;
      if (line.length > 0 && line.length <= this.maxLine) out.push(line);
    }
    const rest = chunk.subarray(from);
    if (rest.length === 0 || this.dropFirstPartial || this.skippingLine) return;
    if (this.pendingBytes + rest.length > this.maxLine) {
      this.pending = [];
      this.pendingBytes = 0;
      this.skippingLine = true;
      return;
    }
    this.pending.push(Buffer.from(rest));
    this.pendingBytes += rest.length;
  }
}

export const HEAD_RETRY = 4 * 1024 * 1024;

/** Reads complete lines from the start of a file, up to a byte limit. Null when it cannot be opened. */
export async function readHead(path: string, limit = TAIL_WINDOW): Promise<Buffer[] | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(limit);
    const { bytesRead } = await handle.read(buf, 0, limit, 0);
    const data = buf.subarray(0, bytesRead);
    const lines: Buffer[] = [];
    let from = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, from);
      if (nl < 0) break;
      if (nl > from) lines.push(Buffer.from(data.subarray(from, nl)));
      from = nl + 1;
    }
    return lines;
  } finally {
    await handle.close();
  }
}
