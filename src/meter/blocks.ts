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
 *
 * `notBefore` is a reset we were actually told about. Everything before it
 * belongs to a window that is over, and both halves of the rule matter: those
 * events are dropped, and a block that would otherwise be anchored to an hour
 * before the reset starts at the reset instead. Without it, the first minutes
 * of a fresh window inherit the tail of the previous one — a reset at 13:30
 * with spend at 13:08 anchors the new block to 13:00 and counts it twice.
 */
export function buildBlocks(events: BlockInput[], blockHours = 5, notBefore: number | null = null): Window[] {
  const span = blockHours * HOUR;
  const sorted = [...events]
    .filter((e) => notBefore === null || e.ts >= notBefore)
    .sort((a, b) => a.ts - b.ts);
  const blocks: Window[] = [];
  let current: Window | null = null;

  for (const e of sorted) {
    if (!current || e.ts >= current.end) {
      const anchored = floorToHour(e.ts);
      const start = notBefore !== null ? Math.max(anchored, notBefore) : anchored;
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

/**
 * The block `now` falls inside, or an empty one when the last has expired.
 *
 * The empty block is a guess either way — Anthropic's window opens with your
 * next message, not on a schedule — so it is anchored to the last reset we were
 * actually told about while that reset is still within a window's reach, and
 * only falls back to the current hour when it is not. Anchoring it to the hour
 * regardless made the guess *move*: an idle machine's window start crept
 * forward every hour, dragging the reset time on screen with it and tripping
 * the reset watcher into announcing a rollover once an hour.
 */
export function activeBlock(blocks: Window[], now: number, blockHours = 5, notBefore: number | null = null): Window {
  const span = blockHours * HOUR;
  const last = blocks[blocks.length - 1];
  if (last && now < last.end) return { ...last, active: true };
  let start = floorToHour(now);
  if (notBefore !== null) {
    start = notBefore <= now && now < notBefore + span ? notBefore : Math.max(start, notBefore);
  }
  return { start, end: start + span, credits: 0, opusCredits: 0, events: 0, lastActivity: null, active: false };
}
