import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVerdict, pressureOf } from '../web/src/verdict.ts';
import type { Status } from '../web/src/api.ts';

/** The key back, so these assertions read as the sentence that was chosen. */
const t = (key: string) => key;

const HOUR = 3_600_000;
const now = Date.parse('2026-09-04T19:00:00');

const status = (over: {
  usedPct: number;
  remainingCredits?: number;
  cap?: number;
  burnRate?: number;
  exhaustionAt?: number | null;
  resetsAt?: number;
}): Status => {
  const cap = over.cap ?? 100;
  return {
    now,
    burnRate: over.burnRate ?? 0,
    exhaustionAt: over.exhaustionAt ?? null,
    headroom: null,
    block: {
      window: { start: now - 3 * HOUR, end: now + 2 * HOUR, credits: (cap * over.usedPct) / 100, opusCredits: 0, events: 4, lastActivity: null, active: true },
      cap: { credits: cap, basis: 'reported' },
      usedPct: over.usedPct,
      remainingCredits: over.remainingCredits ?? Math.max(0, cap * (1 - over.usedPct / 100)),
      resetsAt: over.resetsAt ?? now + 2 * HOUR,
      rolling: false,
      source: 'reported',
    },
  } as unknown as Status;
};

test('a window with nothing left is spent, not "close"', () => {
  // The one that made the dashboard look broken: 100% on the ring, and beside
  // it "It'll be close. At this pace you end the window at 133%", in amber.
  const v = readVerdict(status({ usedPct: 100, burnRate: 20 }), t);
  assert.equal(v.line, 'verdict.spent');
  assert.equal(v.pressure, 'over', 'a full window is never amber');
  assert.equal(v.projectedPct, null, 'there is nothing left to project');
});

test('a pace that ends past the cap is red, whichever branch it lands in', () => {
  // Under the cap now, but the pace overshoots it and the burn is too slow for
  // the exhaustion clock to name a moment before the reset.
  const v = readVerdict(status({ usedPct: 80, burnRate: 20, exhaustionAt: null }), t);
  assert.equal(v.line, 'verdict.tight');
  assert.ok(v.projectedPct! >= 100, `projected ${v.projectedPct}`);
  assert.equal(v.pressure, 'over');
});

test('the forecast starts from the percentage the ring is showing', () => {
  // Anthropic reports 60% while local credits only account for 20 of the 100.
  // The sentence must extrapolate from the 60 on screen, not from the 20
  // behind it — otherwise the ring and its own caption tell different stories.
  const s = status({ usedPct: 60, cap: 100, burnRate: 5 });
  s.block.window.credits = 20;
  const v = readVerdict(s, t);
  assert.ok(Math.abs(v.projectedPct! - 70) < 0.01, `projected ${v.projectedPct}, expected 70`);
});

test('an idle window reports room rather than a pace', () => {
  const v = readVerdict(status({ usedPct: 30, burnRate: 0 }), t);
  assert.equal(v.line, 'verdict.idle.pct');
  assert.equal(v.projectedPct, null);
  assert.equal(v.pressure, pressureOf(30));
});
