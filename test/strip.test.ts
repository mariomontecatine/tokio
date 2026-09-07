import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectionOf, tracePaths, underlayPath, xOf, yOf, type Box, type StripInput } from '../web/src/strip.ts';

const BOX: Box = { x0: 8, x1: 592, yTop: 16, yBottom: 124 };
const HOUR = 3_600_000;

const input = (over: Partial<StripInput> = {}): StripInput => ({
  trace: [],
  traceSource: 'reported',
  start: 0,
  end: 5 * HOUR,
  now: 4 * HOUR,
  usedPct: 40,
  burnRate: 0,
  cap: 0,
  ...over,
});

const coords = (d: string) => d.split(/[ML]\s*/).slice(1).map((pair) => pair.trim().split(/\s+/).map(Number));

test('a coordinate that is not a number cannot truncate the path', () => {
  // The exact shape a page served by an older daemon produces: the payload has
  // no `pct`, so every height arrives undefined. One NaN in an SVG path stops
  // the browser drawing at that point, with no error anywhere.
  const broken = [{ t: HOUR, pct: undefined }, { t: 2 * HOUR, pct: undefined }] as unknown as StripInput['trace'];
  const { line, area } = tracePaths(input({ trace: broken, traceSource: 'estimated' }), BOX);
  assert.ok(!/NaN|undefined/.test(line), line);
  assert.ok(!/NaN|undefined/.test(area), area);
  assert.ok(coords(line).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test('nothing is ever drawn outside the box', () => {
  const wild = [{ t: -50 * HOUR, pct: -40 }, { t: 900 * HOUR, pct: 4000 }];
  const { line } = tracePaths(input({ trace: wild }), BOX);
  for (const [x, y] of coords(line)) {
    assert.ok(x >= BOX.x0 && x <= BOX.x1, `x ${x} outside the box`);
    assert.ok(y >= BOX.yTop && y <= BOX.yBottom, `y ${y} outside the box`);
  }
});

test('a reconstruction from transcripts starts on the floor, because it knows it', () => {
  const { line } = tracePaths(
    input({ traceSource: 'estimated', trace: [{ t: 4 * HOUR, pct: 40 }] }),
    BOX,
  );
  const [firstX, firstY] = coords(line)[0]!;
  assert.equal(firstX, BOX.x0, 'from the window edge');
  assert.equal(firstY, BOX.yBottom, 'at zero — every event on this machine is in the transcripts');
});

test('a reported trace does not claim the hours before its first reading were empty', () => {
  // tokio installed, or the daemon restarted, four hours into a window: the
  // first thing it ever saw was 40%. Running flat along the floor to get there
  // would be stating a measurement nobody took.
  const { line, area } = tracePaths(input({ trace: [{ t: 4 * HOUR, pct: 40 }] }), BOX);
  const [firstX, firstY] = coords(line)[0]!;
  assert.ok(firstX > BOX.x0, 'the line starts where the record does');
  assert.equal(firstY, yOf(40, BOX), 'at the height it was first told');
  assert.ok(!coords(line).some(([x, y]) => x < firstX && y === BOX.yBottom), 'no invented flat run');
  assert.ok(area.trimEnd().endsWith('Z'), 'and the fill still closes');
});

test('with a cap nobody has pinned down, no pace is projected', () => {
  // `cap || 1` used to turn an unknown cap into thousands of percent an hour
  // and fire the projection off the top of the window.
  assert.equal(projectionOf(input({ burnRate: 3, cap: 0 }), BOX), null);
});

test('a spent window is not forecast backwards', () => {
  assert.equal(projectionOf(input({ usedPct: 100, burnRate: 3, cap: 10 }), BOX), null);
  assert.equal(projectionOf(input({ usedPct: 40, burnRate: 3, cap: 10, now: 5 * HOUR }), BOX), null);
});

test('a projection that runs out early stops at the cap, and says so', () => {
  const p = projectionOf(input({ usedPct: 40, burnRate: 12, cap: 10, now: 4 * HOUR }), BOX)!;
  assert.equal(p.hitsCap, true, '120%/h against 60% left, with an hour to go');

  const slow = projectionOf(input({ usedPct: 40, burnRate: 1, cap: 10, now: 4 * HOUR }), BOX)!;
  assert.equal(slow.hitsCap, false, '10%/h gets nowhere near it');
  assert.ok(p.atX <= BOX.x1 && p.atY >= BOX.yTop);
});

test('a window of zero length collapses to the left edge instead of dividing by it', () => {
  assert.equal(xOf(5, input({ start: 7, end: 7 }), BOX), BOX.x0);
});

// ---------- the stretch that ran before anyone was watching ----------

test('a reported line that starts late is underlaid from the transcripts', () => {
  // Open the application four hours into a window and the reported line begins
  // at the first reading, leaving an empty field to its left. The transcripts
  // were written the whole time, so that stretch is known — from elsewhere.
  const d = underlayPath(input({
    trace: [{ t: 4 * HOUR, pct: 40 }],
    traceLocal: [{ t: HOUR, pct: 10 }, { t: 2 * HOUR, pct: 25 }],
  }), BOX);
  assert.ok(d, 'expected an underlay');
  const points = coords(d!);
  // Starts on the floor at the window's edge: unlike /usage, transcripts do
  // know the window opened empty.
  assert.deepEqual(points[0], [BOX.x0, BOX.yBottom]);
  assert.ok(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(points.every(([x]) => x <= xOf(4 * HOUR, input(), BOX) + 0.05), 'never past the first reading');
});

test('the underlay is not stretched to meet the reported line', () => {
  // Where the local shape stops short, the gap is work done with no transcript
  // here — a browser, another machine. Scaling one to touch the other would
  // erase exactly that.
  const d = underlayPath(input({
    trace: [{ t: 4 * HOUR, pct: 90 }],
    traceLocal: [{ t: 2 * HOUR, pct: 10 }],
  }), BOX)!;
  const heights = coords(d).map(([, y]) => y);
  assert.ok(!heights.includes(yOf(90, BOX)), 'the underlay must not reach the reported level');
  assert.ok(heights.includes(yOf(10, BOX)), 'it stops at what the transcripts actually say');
});

test('nothing is underlaid when there is nothing honest to draw', () => {
  // An estimated trace already covers the window from the floor.
  assert.equal(underlayPath(input({ traceSource: 'estimated', trace: [{ t: HOUR, pct: 5 }], traceLocal: [{ t: HOUR, pct: 5 }] }), BOX), null);
  // No transcripts for the stretch.
  assert.equal(underlayPath(input({ trace: [{ t: 4 * HOUR, pct: 40 }], traceLocal: [] }), BOX), null);
  // No reported reading at all: `tracePaths` already draws from the floor.
  assert.equal(underlayPath(input({ trace: [], traceLocal: [{ t: HOUR, pct: 5 }] }), BOX), null);
  // Local points that all fall after the first reading say nothing about before it.
  assert.equal(underlayPath(input({ trace: [{ t: HOUR, pct: 40 }], traceLocal: [{ t: 3 * HOUR, pct: 50 }] }), BOX), null);
});

test('the reported line itself is untouched by the underlay', () => {
  // The whole point: what was measured keeps its own shape, and the
  // reconstruction goes behind it.
  const withLocal = input({ trace: [{ t: 4 * HOUR, pct: 40 }], traceLocal: [{ t: HOUR, pct: 10 }] });
  const without = input({ trace: [{ t: 4 * HOUR, pct: 40 }] });
  assert.equal(tracePaths(withLocal, BOX).line, tracePaths(without, BOX).line);
  assert.equal(tracePaths(withLocal, BOX).area, tracePaths(without, BOX).area);
});
