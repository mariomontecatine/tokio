import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { predict, bucketKey } from '../src/estimator/predict.ts';
import { accuracy, recordOutcome } from '../src/estimator/learn.ts';
import { createJob } from '../src/queue/store.ts';
import type { Job } from '../src/types.ts';

function withTurns(db: ReturnType<typeof openDb>, project: string, family: string, costs: number[], chars = 100) {
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,?,?,0,0,0,0,0,?,?,?,?,'transcript')`,
  );
  const turn = db.prepare('INSERT INTO turns (turnId, ts, project, chars) VALUES (?,?,?,?)');
  // Ids must include the project: two projects with the same model would
  // otherwise collide on the primary key and silently drop rows.
  costs.forEach((c, i) => {
    const id = `${project}-${family}-${i}`;
    insert.run(`m${id}`, `r${id}`, Date.now() - i * 60_000, family, family, c, 's1', project, `t${id}`);
    turn.run(`t${id}`, Date.now() - i * 60_000, project, chars);
  });
}

const req = (over = {}) => ({ prompt: 'run the tests', cwd: '/repo/a', model: 'opus', safety: 'edits' as const, ...over });

test('with no history at all it says so rather than inventing precision', () => {
  const db = openDb(':memory:');
  const e = predict(db, req());
  assert.match(e.basis, /no history/);
  assert.ok(e.p90 > e.p50);
});

test('it prefers the project you are actually queueing into', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [1, 1, 1, 1, 1, 1]);
  withTurns(db, '/repo/b', 'opus', [50, 50, 50, 50, 50, 50]);
  const e = predict(db, req({ cwd: '/repo/a' }));
  assert.match(e.basis, /this project/);
  assert.ok(e.p50 < 5, `expected the cheap project's history, got ${e.p50}`);
});

test('an unfamiliar project still gets the right ballpark from the same model', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [3, 3, 3, 3, 3, 3]);
  const e = predict(db, req({ cwd: '/somewhere/new' }));
  assert.match(e.basis, /past opus turns/);
  assert.ok(e.p50 > 1);
});

test('an unresolved model falls back to the family you actually run', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [4, 4, 4, 4, 4, 4]);
  const e = predict(db, req({ model: null }));
  // Without the fallback this lands on the "unknown" family, which has no
  // sample here and would quietly answer with the shipped Sonnet-ish default.
  // The shipped default for an unresolved model is well under a dollar, so
  // landing in Opus territory proves the fallback fired.
  assert.ok(e.p50 > 1.5, `expected the opus history, got ${e.p50}`);
  assert.doesNotMatch(e.basis, /no history/);
});

test('a longer prompt raises the estimate, but only gently', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [2, 2, 2, 2, 2, 2], 100);
  const short = predict(db, req({ prompt: 'x'.repeat(100) }));
  const long = predict(db, req({ prompt: 'x'.repeat(10_000) }));
  assert.ok(long.p50 > short.p50);
  assert.ok(long.p50 < short.p50 * 3, 'a 100x longer prompt must not mean a 100x estimate');
});

test('plan mode is estimated below a full run', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [2, 2, 2, 2, 2, 2]);
  assert.ok(predict(db, req({ safety: 'plan' })).p50 < predict(db, req({ safety: 'edits' })).p50);
});

test('finished jobs override transcript history for the same bucket', () => {
  const db = openDb(':memory:');
  withTurns(db, '/repo/a', 'opus', [20, 20, 20, 20, 20, 20]);
  const base: Job = { cwd: '/repo/a', model: 'opus', safety: 'edits', resumeSessionId: null, prompt: 'run the tests' } as Job;
  for (const c of [0.5, 0.6, 0.7]) recordOutcome(db, base, c);

  const e = predict(db, req());
  assert.match(e.basis, /previous job/);
  assert.ok(e.p50 < 2, `real outcomes should win over old turns, got ${e.p50}`);
});

test('buckets keep resumed and fresh sessions apart', () => {
  assert.notEqual(bucketKey('/a', 'opus', 'edits', true), bucketKey('/a', 'opus', 'edits', false));
});

test('accuracy reports how often reality landed inside the range', () => {
  const db = openDb(':memory:');
  const a = createJob(db, { prompt: 'x', cwd: '/repo/a', safety: 'edits', estimateP50: 1, estimateP90: 2 });
  const b = createJob(db, { prompt: 'y', cwd: '/repo/a', safety: 'edits', estimateP50: 1, estimateP90: 2 });
  db.prepare("UPDATE jobs SET status='done', actualCredits=1 WHERE id=?").run(a.id);
  db.prepare("UPDATE jobs SET status='done', actualCredits=9 WHERE id=?").run(b.id);
  const acc = accuracy(db);
  assert.equal(acc.n, 2);
  assert.equal(acc.withinP90, 0.5);
});
