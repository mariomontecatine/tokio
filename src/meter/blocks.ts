import type { ModelFamily, Window } from '../types.ts';

export interface BlockInput {
  ts: number;
  credits: number;
  family: ModelFamily;
}

export const HOUR = 3_600_000;

/** Claude's 5-hour windows are anchored to the hour the first message landed in. */
export function floorToHour(ts: number): number {
  return ts - (ts % HOUR);
}

/**
 * Reconstruct the rolling usage blocks from a chronological event list.
 *
 * A block opens with an event, is anchored to that event's hour, and closes
 * `blockHours` later. An idle gap needs no separate rule: going quiet for a
 * whole window's length necessarily pushes the next message past the window's
 * end, so it opens a new block on its own.
 */
export function buildBlocks(events: BlockInput[], blockHours = 5): Window[] {
  const span = blockHours * HOUR;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const blocks: Window[] = [];
  let current: Window | null = null;

  for (const e of sorted) {
    if (!current || e.ts >= current.end) {
      const start = floorToHour(e.ts);
      current = { start, end: start + span, credits: 0, opusCredits: 0, events: 0, lastActivity: null, active: false };
      blocks.push(current);
    }
    current.credits += e.credits;
    if (e.family === 'opus') current.opusCredits += e.credits;
    current.events += 1;
    current.lastActivity = e.ts;
  }
  return blocks;
}

/** The block `now` falls inside, or an empty block starting now if the last one has expired. */
export function activeBlock(blocks: Window[], now: number, blockHours = 5): Window {
  const span = blockHours * HOUR;
  const last = blocks[blocks.length - 1];
  if (last && now < last.end) return { ...last, active: true };
  const start = floorToHour(now);
  return { start, end: start + span, credits: 0, opusCredits: 0, events: 0, lastActivity: null, active: false };
}
