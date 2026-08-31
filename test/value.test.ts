import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { computeValue } from '../src/meter/value.ts';

const DAY = 24 * 3_600_000;

function seed(db: ReturnType<typeof openDb>, entries: { daysAgo: number; credits: number }[]) {
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,?,'opus',0,0,0,0,0,?,'s','/repo/a','t','transcript')`,
  );
  entries.forEach((e, i) => insert.run(`m${i}`, `r${i}`, Date.now() - e.daysAgo * DAY, 'claude-opus-5', e.credits));
}

const cfg = (over: Partial<Config> = {}): Config => ({ ...loadConfig(), plan: 'max5', subscriptionStartedAt: null, planPriceUsd: null, ...over });

test('it totals what the same work would have cost on the API', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 10, credits: 200 }, { daysAgo: 2, credits: 300 }]);
  const v = computeValue(db, cfg());
  assert.equal(v.equivalentUsd, 500);
  assert.equal(v.paidUsd, 100, 'one month of Max 5×');
  assert.equal(v.multiple, 5);
});

test('a partial month still counts as a month billed', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 3, credits: 50 }]);
  assert.equal(computeValue(db, cfg()).months, 1);
});

test('longer histories bill every month they span', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 100, credits: 100 }, { daysAgo: 1, credits: 100 }]);
  const v = computeValue(db, cfg());
  assert.equal(v.months, 4, '100 days is four billing periods');
  assert.equal(v.paidUsd, 400);
});

test('without a start date it says the period came from the transcripts', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 5, credits: 10 }]);
  const v = computeValue(db, cfg());
  assert.equal(v.sinceIsFirstTranscript, true);
  assert.ok(Math.abs(v.since - (Date.now() - 5 * DAY)) < 60_000);
});

test('a configured start date is used instead, and older usage drops out', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 40, credits: 999 }, { daysAgo: 2, credits: 25 }]);
  const started = new Date(Date.now() - 10 * DAY).toISOString();
  const v = computeValue(db, cfg({ subscriptionStartedAt: started }));
  assert.equal(v.sinceIsFirstTranscript, false);
  assert.equal(v.equivalentUsd, 25, 'usage from before you subscribed is not yours to count');
});

test('a custom plan price overrides the shipped one', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 2, credits: 60 }]);
  assert.equal(computeValue(db, cfg({ planPriceUsd: 30 })).multiple, 2);
});

test('an unpriced plan reports usage without inventing a multiple', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 2, credits: 60 }]);
  const v = computeValue(db, cfg({ plan: 'custom' }));
  assert.equal(v.equivalentUsd, 60);
  assert.equal(v.paidUsd, null);
  assert.equal(v.multiple, null);
});

test('an empty history is reported as zero, not as a division by zero', () => {
  const v = computeValue(openDb(':memory:'), cfg());
  assert.equal(v.equivalentUsd, 0);
  assert.equal(v.multiple, 0);
  assert.deepEqual(v.byMonth, []);
});
