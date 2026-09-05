// Relative imports carry the .ts extension here, for the same reason verdict.ts
// does: this module is arithmetic, `npm test` runs it through Node's type
// stripping, and that resolves nothing implicitly.
import type { TracePoint } from './api.ts';

const HOUR = 3_600_000;

/** The drawable rectangle, in the SVG's own units. */
export interface Box {
  x0: number;
  x1: number;
  yTop: number;
  yBottom: number;
}

export interface StripInput {
  trace: TracePoint[];
  /** Where the trace came from. It decides what the chart may claim about time it did not see. */
  traceSource: 'reported' | 'estimated';
  start: number;
  end: number;
  now: number;
  /** The percentage the ring is showing. */
  usedPct: number;
  /** Credits per hour. */
  burnRate: number;
  /** Credits in a full window, or 0 when nothing has pinned it down. */
  cap: number;
}

/**
 * Time to an x coordinate, clamped to the box.
 *
 * A chart must not be able to draw outside itself, whatever the arithmetic
 * hands it — a window boundary that moved between the reading and the render is
 * enough to put a point a few pixels past the edge.
 */
export function xOf(ts: number, input: StripInput, box: Box): number {
  const span = input.end - input.start;
  if (!(span > 0)) return box.x0;
  const at = box.x0 + ((ts - input.start) / span) * (box.x1 - box.x0);
  return Number.isFinite(at) ? Math.min(box.x1, Math.max(box.x0, at)) : box.x0;
}

/**
 * Percent to a y coordinate, with anything non-finite pinned to the floor.
 *
 * An SVG path is one string, and a browser that meets `NaN` in it stops drawing
 * there and reports no error — so a single bad point does not spoil its own
 * segment, it silently truncates the chart from that point on. That is exactly
 * what a page served by a daemon still running an older build produces, and a
 * chart that quietly draws two thirds of the truth is worse than one that draws
 * a floor.
 */
export function yOf(percent: number, box: Box): number {
  const share = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : 0;
  return box.yBottom - share * (box.yBottom - box.yTop);
}

/**
 * The window's line, and the area under it.
 *
 * Stepped, because spend jumps when a response lands and is flat in between.
 * Smoothing it would draw activity that never happened.
 *
 * Where the line *begins* is the part worth reading twice. A reconstruction
 * from transcripts genuinely knows the window opened empty: every response this
 * machine made is in them, so there is nothing missing before the first event
 * and the line starts on the floor at the window's edge. A reported trace knows
 * no such thing. `/usage` answers what the window is at when you ask it, never
 * what it was at before tokio first asked — so a line running flat along the
 * floor from the window's start to the first reading would be stating a
 * measurement nobody took. Install tokio four hours into a window, or leave the
 * daemon down for an afternoon, and that invented flat run is most of the chart.
 * It starts at the first thing it actually knows instead, and the gap to the
 * left of it is the honest shape of not having been watching.
 */
export function tracePaths(input: StripInput, box: Box): { line: string; area: string } {
  const x = (ts: number) => xOf(ts, input, box).toFixed(1);
  const y = (percent: number) => yOf(percent, box).toFixed(1);
  const nowX = x(input.now);

  const first = input.trace[0];
  const fromFloor = input.traceSource === 'estimated' || first === undefined;
  const rest = fromFloor ? input.trace : input.trace.slice(1);

  const steps = fromFloor ? [`M ${box.x0} ${box.yBottom}`] : [`M ${x(first!.t)} ${y(first!.pct)}`];
  let last = fromFloor ? 0 : first!.pct;

  for (const point of rest) {
    steps.push(`L ${x(point.t)} ${y(last)}`);
    steps.push(`L ${x(point.t)} ${y(point.pct)}`);
    last = point.pct;
  }
  steps.push(`L ${nowX} ${y(last)}`);

  const line = steps.join(' ');
  const openedAt = fromFloor ? box.x0 : x(first!.t);
  return { line, area: `${line} L ${nowX} ${box.yBottom} L ${openedAt} ${box.yBottom} Z` };
}

export interface Projection {
  d: string;
  hitsCap: boolean;
  atX: number;
  atY: number;
}

/**
 * Where the current pace lands: the cap, or the reset, whichever comes first.
 *
 * The pace is converted into the same percent-of-window the rest of the chart is
 * drawn in, through the cap — the identical conversion the verdict makes to say
 * where this pace lands, so the line and the sentence cannot disagree.
 *
 * Nothing is drawn without a cap to convert through. The old `cap || 1` guard
 * turned an unpinned cap into a burn rate of thousands of percent an hour and
 * fired the projection off the top of the window on the first response of a
 * fresh install. Nothing is drawn once the window is spent either: past the cap
 * the arithmetic gives a crossing that already happened, and the line is drawn
 * backwards, off the left of the chart. There is nothing to forecast at that
 * point anyway — the verdict says so in words.
 */
export function projectionOf(input: StripInput, box: Box): Projection | null {
  const spent = input.usedPct;
  const burnPct = input.cap > 0 ? (input.burnRate / input.cap) * 100 : 0;
  if (!(burnPct > 0) || !Number.isFinite(spent) || spent >= 100) return null;

  const hoursToCap = (100 - spent) / burnPct;
  const hoursToEnd = (input.end - input.now) / HOUR;
  if (!(hoursToEnd > 0)) return null;

  const hitsCap = hoursToCap < hoursToEnd;
  const endT = input.now + Math.min(hoursToCap, hoursToEnd) * HOUR;
  const endPct = spent + burnPct * ((endT - input.now) / HOUR);

  const nowX = xOf(input.now, input, box);
  const atX = Math.max(nowX, xOf(endT, input, box));
  const atY = yOf(endPct, box);
  return { d: `M ${nowX.toFixed(1)} ${yOf(spent, box).toFixed(1)} L ${atX.toFixed(1)} ${atY.toFixed(1)}`, hitsCap, atX, atY };
}
