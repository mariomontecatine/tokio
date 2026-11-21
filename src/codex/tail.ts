import { open } from 'node:fs/promises';

export interface Chunk {
  identity?: string;
  restarted?: boolean;
  lines: string[];
  /** Where the next read starts: just past the last whole line returned. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** True when there are whole lines left past `offset` that this read did not reach. */
  more: boolean;
}

/** Enough to make progress on a big file without holding all of it at once. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Read whole lines appended since `offset`, at most about `budget` bytes of them.
 *
 * Codex rollouts are not Claude transcripts in one respect that matters here:
 * they get big. One thread on the machine this was written on is 128 MB, and a
 * single line of tool output in it is 10.6 MB. Reading the remainder of a file
 * in one go — which is what `tailFile` does for Claude, where it is fine —
 * would mean a buffer and a string of that size on every first scan. So this
 * reads a bounded piece, returns the whole lines in it, and says whether there
 * is more; the caller yields between pieces.
 *
 * A line longer than the budget is not split: the read widens until it finds
 * the end of one, because half a line is not something to hand a JSON parser.
 * A last line with no newline yet is left for the next pass, exactly as
 * `tailFile` does, since it is still being written. A file that shrank was
 * replaced, and is read again from the start.
 */
export async function readChunk(path: string, offset: number, budget = CHUNK_BYTES, previous?: { identity: string; size: number; mtime: number }): Promise<Chunk> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { lines: [], offset, size: 0, mtimeMs: 0, more: false };
  }
  try {
    const { size, mtimeMs, dev, ino, birthtimeMs } = await handle.stat();
    const identity = `${dev}:${ino}:${birthtimeMs}`;
    const restarted = size < offset || Boolean(previous && (previous.identity !== identity || size < previous.size
      || (size === previous.size && mtimeMs !== previous.mtime)));
    const from = restarted ? 0 : offset;
    if (size === from) return { lines: [], identity, restarted, offset: from, size, mtimeMs, more: false };

    let length = Math.min(budget, size - from);
    for (;;) {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, from);
      const chunk = buf.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline !== -1) {
        const lines = chunk.subarray(0, lastNewline).toString('utf8').split('\n').filter((l) => l.length > 0);
        const next = from + lastNewline + 1;
        return { lines, identity, restarted, offset: next, size, mtimeMs, more: next < size };
      }
      // No newline in what was read. At the end of the file that is a line
      // still being written; anywhere else it is a line longer than the budget.
      if (from + bytesRead >= size || bytesRead < length) {
        return { lines: [], identity, restarted, offset: from, size, mtimeMs, more: false };
      }
      length = Math.min(length * 2, size - from);
    }
  } finally {
    await handle.close();
  }
}
