// Reads what was appended to a growing JSONL file, one complete line at a time.
// @see docs/herdr-reader.md

import { open, stat } from "node:fs/promises";

const NEWLINE = 0x0a;

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function splitLines(buffer: Buffer): string[] {
  return buffer.length === 0 ? [] : buffer.toString("utf8").split("\n").filter(Boolean);
}

/**
 * The complete lines in the last maxBytes of a file. offset is just past the last newline,
 * so a TailReader started there picks up a line that was still being written.
 */
export async function readLastLines(path: string, maxBytes: number): Promise<{ lines: string[]; offset: number; whole: boolean }> {
  const { size } = await stat(path);
  const start = Math.max(0, size - maxBytes);
  const buffer = await readRange(path, start, size);
  const from = start === 0 ? 0 : buffer.indexOf(NEWLINE) + 1;
  const to = buffer.lastIndexOf(NEWLINE) + 1;
  if (to <= from) return { lines: [], offset: start + from, whole: start === 0 };
  return { lines: splitLines(buffer.subarray(from, to - 1)), offset: start + to, whole: start === 0 };
}

export interface TailChunk {
  lines: string[];
  /** The file was truncated or replaced: lines start from its beginning again. */
  reset: boolean;
}

export class TailReader {
  private carry: Buffer = Buffer.alloc(0);
  private inode: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private offset: number,
  ) {}

  /** Complete lines appended since the last read. Calls are serialized. */
  read(): Promise<TailChunk> {
    const next = this.queue.then(() => this.readOnce());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readOnce(): Promise<TailChunk> {
    const info = await stat(this.path);
    let reset = false;
    if (info.size < this.offset || (this.inode !== null && info.ino !== this.inode)) {
      this.offset = 0;
      this.carry = Buffer.alloc(0);
      reset = true;
    }
    this.inode = info.ino;
    if (info.size === this.offset) return { lines: [], reset };
    const appended = await readRange(this.path, this.offset, info.size);
    this.offset += appended.length;
    const buffer = Buffer.concat([this.carry, appended]);
    const end = buffer.lastIndexOf(NEWLINE);
    if (end < 0) {
      this.carry = buffer;
      return { lines: [], reset };
    }
    this.carry = Buffer.from(buffer.subarray(end + 1));
    return { lines: splitLines(buffer.subarray(0, end)), reset };
  }
}
