import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectionOf, tracePaths, xOf, yOf, type Box, type StripInput } from '../web/src/strip.ts';

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
