import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

export interface TailResult {
  lines: string[];
  offset: number;
  size: number;
}

/**
 * Read whole lines appended since `offset`.
 *
 * Stops at the last newline so a half-written line is re-read on the next pass
 * instead of being parsed as truncated JSON. If the file shrank it was rotated
 * or replaced, so start over from zero.
 */
export function tailFile(path: string, offset: number): TailResult {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { lines: [], offset, size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    let from = offset;
    if (size < offset) from = 0;
    if (size === from) return { lines: [], offset: from, size };

    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, from);
    const chunk = buf.subarray(0, read);

    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], offset: from, size };

    const complete = chunk.subarray(0, lastNewline).toString('utf8');
    const lines = complete.split('\n').filter((l) => l.length > 0);
    return { lines, offset: from + lastNewline + 1, size };
  } finally {
    closeSync(fd);
  }
}
