import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { computeStatus } from '../src/meter/index.ts';
import { saveProbe } from '../src/usage/store.ts';

const HOUR = 3_600_000;

function seed(db: ReturnType<typeof openDb>, entries: { minutesAgo: number; credits: number }[], now: number) {
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,'claude-opus-5','opus',0,0,0,0,0,?,'s','/repo/a','t','transcript')`,
  );
  entries.forEach((e, i) => insert.run(`m${i}`, `r${i}`, now - e.minutesAgo * 60_000, e.credits));
}

const cfg = (): Config => ({ ...loadConfig(), plan: 'max5', blockHours: 5 });

test('a reported percentage wins over anything reconstructed locally', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seed(db, [{ minutesAgo: 30, credits: 10 }], now);
  saveProbe(db, {
    at: now - 60_000, sessionPct: 73, sessionResetsAt: now + 2 * HOUR,
    weekPct: 27, weekResetsAt: now + 4 * 24 * HOUR, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.block.usedPct, 73);
  assert.equal(s.block.source, 'reported');
  assert.equal(s.block.cap.basis, 'reported');
  assert.equal(s.block.resetsAt, now + 2 * HOUR, 'the real reset, not an hour-aligned guess');
});

test('the window is the five hours ending at the reported reset', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetsAt = now + 2 * HOUR;
  // The window runs from 3h ago to 2h from now, so 100 minutes ago is inside
  // it and 260 minutes ago is before it opened.
  seed(db, [{ minutesAgo: 260, credits: 99 }, { minutesAgo: 100, credits: 5 }], now);
  saveProbe(db, {
    at: now, sessionPct: 50, sessionResetsAt: resetsAt, weekPct: null,
    weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.block.window.start, resetsAt - 5 * HOUR);
  assert.equal(s.block.window.credits, 5, 'spend from before the window must not count');
});

test('a stale reading is not trusted and the display falls back to estimates', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seed(db, [{ minutesAgo: 10, credits: 10 }], now);
  saveProbe(db, {
    at: now - 60 * 60_000, sessionPct: 73, sessionResetsAt: now + HOUR,
    weekPct: null, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.block.source, 'estimated');
  assert.equal(s.probe!.stale, true);
});

test('silence about Opus means no Opus gauge', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seed(db, [{ minutesAgo: 10, credits: 10 }], now);
  saveProbe(db, {
    at: now, sessionPct: 40, sessionResetsAt: now + HOUR, weekPct: 20,
    weekResetsAt: now + 3 * 24 * HOUR, opusPct: null, opusResetsAt: null, error: null,
  });
  assert.equal(computeStatus(db, cfg(), now).weekOpus, null);
});

test('a failed reading is surfaced rather than swallowed', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  saveProbe(db, {
    at: now, sessionPct: null, sessionResetsAt: null, weekPct: null,
    weekResetsAt: null, opusPct: null, opusResetsAt: null, error: 'claude not logged in',
  });
  const s = computeStatus(db, cfg(), now);
  assert.equal(s.probe!.error, 'claude not logged in');
  assert.equal(s.block.source, 'estimated');
});

test('remaining credits agree with the percentage on screen', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seed(db, [{ minutesAgo: 30, credits: 30 }], now);
  saveProbe(db, {
    at: now, sessionPct: 75, sessionResetsAt: now + HOUR, weekPct: null,
    weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });
  const s = computeStatus(db, cfg(), now);
  // 30 credits is 75%, so the cap is 40 and a quarter of it is left.
  assert.ok(Math.abs(s.block.cap.credits - 40) < 0.01);
  assert.ok(Math.abs(s.block.remainingCredits - 10) < 0.01);
});

test('a minute of wobble in the reported reset is not a new window', async () => {
  const { isRealReset } = await import('../src/meter/index.ts');
  const start = Date.now();
  // Observed in practice: the reported reset moved by 60s between two readings.
  assert.equal(isRealReset(start, start + 60_000), false);
  assert.equal(isRealReset(start, start - 60_000), false);
  assert.equal(isRealReset(start, start + 5 * HOUR), true, 'a real reset moves it by hours');
});

test('a reply with no session line does not displace the last good one', () => {
  // What actually happens at a reset: for a minute or so /usage returns the
  // weekly line and nothing about the session. Taking that reply wholesale used
  // to drop the block to local reconstruction and put an estimate on screen
  // where Anthropic's own number had been.
  const db = openDb(':memory:');
  const cfg = { ...loadConfig(), plan: 'max5' as const };
  const now = Date.parse('2026-09-02T13:34:00');

  saveProbe(db, {
    at: now - 4 * 60_000,
    sessionPct: 1, sessionResetsAt: Date.parse('2026-09-02T18:30:00'),
    weekPct: 12, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });
  saveProbe(db, {
    at: now - 60_000,
    sessionPct: null, sessionResetsAt: null,
    weekPct: 12, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg, now);
  assert.equal(s.block.source, 'reported', 'the good session reading still governs');
  assert.equal(s.block.usedPct, 1);
  assert.equal(s.block.resetsAt, Date.parse('2026-09-02T18:30:00'));
});

test('a reconstruction never counts spend from before a reset it was told about', () => {
  // The reset landed at 13:30. Spend at 13:08 belongs to the window that ended
  // there; counting it against the new one reported 9% where the truth was 1%.
  const db = openDb(':memory:');
  const cfg = { ...loadConfig(), plan: 'max5' as const };
  const now = Date.parse('2026-09-02T13:34:00');

  seed(db, [
    { minutesAgo: 26, credits: 7.74 },  // 13:08 — the old window
    { minutesAgo: 2, credits: 0.5 },    // 13:32 — the new one
  ], now);

  // A reading that knew about the 13:30 reset, but is now too stale to drive
  // the gauge — so the fallback runs, which is the case under test.
  saveProbe(db, {
    at: now - 60 * 60_000,
    sessionPct: 86, sessionResetsAt: Date.parse('2026-09-02T13:30:00'),
    weekPct: 12, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg, now);
  assert.equal(s.block.source, 'estimated');
  assert.equal(s.block.window.start, Date.parse('2026-09-02T13:30:00'), 'the window starts at the reset, not at 13:00');
  assert.ok(Math.abs(s.block.window.credits - 0.5) < 0.001, 'only spend after the reset counts');
});

test('a reported percentage is carried forward by what was spent since it was read', () => {
  // /usage is read every few minutes. In between, the ring used to show the
  // stale figure while the verdict next to it used a burn rate measured
  // seconds ago — the two halves of one picture at different ages.
  const db = openDb(':memory:');
  const now = Date.parse('2026-09-04T15:00:00');

  // $20 in the window, of which $10 landed after the reading.
  seed(db, [{ minutesAgo: 60, credits: 10 }, { minutesAgo: 1, credits: 10 }], now);
  saveProbe(db, {
    at: now - 3 * 60_000,
    sessionPct: 20, sessionResetsAt: now + 2 * HOUR,
    weekPct: 5, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  // The cap divides like with like: $10 had been spent when 20% was reported,
  // so the window holds $50 — not $100, which is what dividing the $20 counted
  // now by the percentage read three minutes ago would have said.
  assert.ok(Math.abs(s.block.cap.credits - 50) < 0.01, `cap came out ${s.block.cap.credits}`);
  // 20% reported, plus the $10 spent since against a $50 window: 40%.
  assert.ok(Math.abs(s.block.usedPct - 40) < 0.01, `showed ${s.block.usedPct}%, not 40%`);
  assert.equal(s.block.source, 'reported', 'the reading is still the authority');
});

test('spend from before a reset is not carried into the new window', () => {
  // The narrow case the guard exists for: Anthropic has already rolled the
  // window, so a reading taken a couple of minutes earlier reports the *new*
  // reset while still predating it. Spend in that sliver belongs to the window
  // that just ended.
  const db = openDb(':memory:');
  const now = Date.parse('2026-09-04T15:00:00');
  const readAt = Date.parse('2026-09-04T14:48:00');
  const resetsAt = Date.parse('2026-09-04T19:50:00'); // so the window opens at 14:50

  seed(db, [
    { minutesAgo: 11, credits: 40 }, // 14:49 — after the reading, before the window
    { minutesAgo: 5, credits: 5 },   // 14:55 — inside the new window
  ], now);
  saveProbe(db, {
    at: readAt,
    sessionPct: 10, sessionResetsAt: resetsAt,
    weekPct: 5, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.block.window.start, Date.parse('2026-09-04T14:50:00'));
  // 10% reported plus the $5 since, against the window. Without the guard the
  // $40 from the old window would come too, and the figure would triple.
  const expected = 10 + (5 / s.block.cap.credits) * 100;
  assert.ok(Math.abs(s.block.usedPct - expected) < 0.01, `showed ${s.block.usedPct.toFixed(1)}%, expected ${expected.toFixed(1)}%`);
});

test('a reading whose reset has already passed is not about the current window', () => {
  // The failure as it was seen: quota ran out at 100%, `/usage` then printed no
  // session line at all because nothing was running, and so the last reading
  // taken *before* the reset stayed the newest one there was. At 19:00 the page
  // still described a window that had ended at 18:49 — full, counting down to a
  // moment in the past, and a queue politely waiting for a window that had
  // already opened.
  const db = openDb(':memory:');
  const now = Date.parse('2026-09-04T19:00:00');
  const sessionResetsAt = Date.parse('2026-09-04T18:49:00');
  const weekResetsAt = Date.parse('2026-09-05T20:59:00');

  seed(db, [{ minutesAgo: 90, credits: 40 }], now); // 17:30, in the window that ended
  saveProbe(db, {
    at: Date.parse('2026-09-04T18:48:00'), // fresh by age; the window closed a minute later
    sessionPct: 100, sessionResetsAt,
    weekPct: 33, weekResetsAt, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.ok(s.block.window.start >= sessionResetsAt, 'the current window starts no earlier than the reset');
  assert.ok(s.block.resetsAt > now, 'a window cannot reset in the past and still be the current one');
  assert.equal(s.block.source, 'estimated', 'a figure about a finished window is not a figure about this one');
  assert.equal(s.block.window.credits, 0, 'the finished window keeps its own spend');
  assert.ok(s.block.remainingCredits > 0, 'the new window has room in it');

  // The weekly reading is untouched: its own reset is still a day away, so
  // retiring the session figure must not take it down with it.
  assert.equal(s.week.source, 'reported');
  assert.ok(Math.abs(s.week.usedPct - 33) < 0.01, `week showed ${s.week.usedPct}%`);
});

test('the window has a shape even when none of the work was done on this machine', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetsAt = now + 3 * HOUR;
  // Nothing seeded: every prompt of this window was typed into claude.ai, so
  // no transcript on this machine ever saw it.
  for (const [minutesAgo, pct] of [[90, 2], [60, 5], [30, 8], [5, 10]] as const) {
    saveProbe(db, {
      at: now - minutesAgo * 60_000, sessionPct: pct, sessionResetsAt: resetsAt,
      weekPct: 42, weekResetsAt: now + 3 * 24 * HOUR, opusPct: null, opusResetsAt: null, error: null,
    });
  }

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.traceSource, 'reported');
  assert.equal(s.block.window.credits, 0, 'and still no local spend to report');
  assert.deepEqual(s.trace.map((p) => p.pct), [2, 5, 8, 10, 10], 'the readings, closed at now');
  assert.equal(s.trace[s.trace.length - 1]!.t, now);
  assert.ok(s.trace.every((p) => p.t >= s.block.window.start && p.t <= now));
});

test('readings from the window before this one are not drawn in it', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetsAt = now + HOUR;
  saveProbe(db, {
    at: now - 6 * HOUR, sessionPct: 88, sessionResetsAt: now - 4 * HOUR,
    weekPct: null, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });
  saveProbe(db, {
    at: now - 60_000, sessionPct: 12, sessionResetsAt: resetsAt,
    weekPct: null, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.deepEqual(s.trace.map((p) => p.pct), [12, 12], 'the spent window stays behind');
});

test('with no reading to draw from, the strip falls back to local transcripts', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  seed(db, [{ minutesAgo: 40, credits: 4 }, { minutesAgo: 10, credits: 6 }], now);

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.traceSource, 'estimated');
  assert.ok(s.trace.length >= 2);
  assert.ok(s.trace[s.trace.length - 1]!.pct > s.trace[0]!.pct, 'cumulative, as a share of the cap');
});

test('the strip never estimates while the ring reports', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  // A clock that stepped backwards leaves the only reading of this window
  // stamped in the future. It still wins `latestSessionRead`, so the ring shows
  // it; the strip must not quietly fall back to local credits underneath it.
  saveProbe(db, {
    at: now + 2 * 60_000, sessionPct: 55, sessionResetsAt: now + 2 * HOUR,
    weekPct: null, weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
  });

  const s = computeStatus(db, cfg(), now);
  assert.equal(s.block.source, 'reported');
  assert.equal(s.traceSource, 'reported', 'the two sources are one decision');
  assert.equal(s.trace.at(-1)!.pct, s.block.usedPct, 'and the line reaches the dot');
  assert.ok(s.trace.every((p) => p.t <= now), 'nothing is plotted past now');
});

test('a reading from the future is pinned to now, not thrown away', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const resetsAt = now + 2 * HOUR;
  for (const [at, pct] of [[now - 20 * 60_000, 20], [now - 10 * 60_000, 30], [now + 60_000, 55]] as const) {
    saveProbe(db, {
      at, sessionPct: pct, sessionResetsAt: resetsAt, weekPct: null,
      weekResetsAt: null, opusPct: null, opusResetsAt: null, error: null,
    });
  }

  const s = computeStatus(db, cfg(), now);
  assert.deepEqual(s.trace.map((p) => p.pct), [20, 30, 55], 'the history survives the clock');
  assert.equal(s.trace.at(-1)!.t, now);
});
