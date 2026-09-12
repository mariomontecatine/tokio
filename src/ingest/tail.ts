import { open } from 'node:fs/promises';

export interface TailResult {
  lines: string[];
  offset: number;
  size: number;
  /** When the file was last written, so a sweep can tell a live transcript from a finished one. */
  mtimeMs: number;
}

/**
 * Read whole lines appended since `offset`.
 *
 * Stops at the last newline so a half-written line is re-read on the next pass
 * instead of being parsed as truncated JSON. If the file shrank it was rotated
 * or replaced, so start over from zero.
 *
 * Asynchronous, and that is not style. Across the WSL bridge every open, stat
 * and close is a round trip of ~15ms, so a sweep of a thousand transcripts done
 * with the synchronous calls held the event loop for twelve to fifteen seconds
 * at a time — measured, from Windows, against a 1058-file history. Whatever else
 * lived on that loop stopped with it: the daemon's HTTP server, and inside the
 * application, the window itself.
 */
export async function tailFile(path: string, offset: number): Promise<TailResult> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { lines: [], offset, size: 0, mtimeMs: 0 };
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    let from = offset;
    if (size < offset) from = 0;
    if (size === from) return { lines: [], offset: from, size, mtimeMs };

    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, from);
    const chunk = buf.subarray(0, bytesRead);

    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], offset: from, size, mtimeMs };

    const complete = chunk.subarray(0, lastNewline).toString('utf8');
    const lines = complete.split('\n').filter((l) => l.length > 0);
    return { lines, offset: from + lastNewline + 1, size, mtimeMs };
  } finally {
    await handle.close();
  }
}
