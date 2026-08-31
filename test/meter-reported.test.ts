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
