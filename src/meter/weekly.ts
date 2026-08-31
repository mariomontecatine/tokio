import type { Window } from '../types.ts';
import type { BlockInput } from './blocks.ts';
import { HOUR } from './blocks.ts';

const DAY = 24 * HOUR;

/**
 * Start of the current weekly window.
 *
 * With an anchor (weekday 0-6, hour 0-23) it's the most recent occurrence of
 * that local weekday and hour; without one it falls back to a rolling 7 days,
 * which is pessimistic but never under-reports.
 */
export function weekStart(now: number, anchor: { weekday: number; hour: number } | null): number {
  if (!anchor) return now - 7 * DAY;
  const d = new Date(now);
  d.setHours(anchor.hour, 0, 0, 0);
  const daysBack = (d.getDay() - anchor.weekday + 7) % 7;
  d.setDate(d.getDate() - daysBack);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

export function weekEnd(start: number, anchor: { weekday: number; hour: number } | null): number {
  if (!anchor) return start + 7 * DAY;
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

export function buildWeek(events: BlockInput[], now: number, anchor: { weekday: number; hour: number } | null): Window {
  const start = weekStart(now, anchor);
  const end = weekEnd(start, anchor);
  const w: Window = { start, end, credits: 0, opusCredits: 0, events: 0, lastActivity: null, active: true };
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    w.credits += e.credits;
    if (e.family === 'opus') w.opusCredits += e.credits;
    w.events += 1;
    if (w.lastActivity === null || e.ts > w.lastActivity) w.lastActivity = e.ts;
  }
  return w;
}
