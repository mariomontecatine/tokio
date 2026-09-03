import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.ok(Math.abs(v.paidUsd! - 100 * (10 / 30.437)) < 1, 'ten days of a $100 plan');
  assert.ok(v.multiple! > 10);
});

test('the fee is pro-rated, so a month boundary does not halve the answer', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 30, credits: 1000 }, { daysAgo: 1, credits: 0.01 }]);
  const justUnder = computeValue(db, cfg());

  const db2 = openDb(':memory:');
  seed(db2, [{ daysAgo: 32, credits: 1000 }, { daysAgo: 1, credits: 0.01 }]);
  const justOver = computeValue(db2, cfg());

  // Rounding up to whole months used to drop this from ~10x to ~5x overnight.
  assert.ok(Math.abs(justUnder.multiple! - justOver.multiple!) < 1);
});

test('longer histories are charged for the days they cover', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 100, credits: 100 }, { daysAgo: 1, credits: 100 }]);
  const v = computeValue(db, cfg());
  assert.ok(Math.abs(v.elapsedDays - 100) < 1);
  assert.ok(Math.abs(v.paidUsd! - 100 * (100 / 30.437)) < 1);
});

test('a couple of hours of history is not enough to claim a multiple', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 0.05, credits: 40 }]);
  const v = computeValue(db, cfg());
  assert.equal(v.multiple, null, 'dividing by an afternoon would flatter the plan');
  assert.equal(v.equivalentUsd, 40, 'the usage total is still worth showing');
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
  seed(db, [{ daysAgo: 30, credits: 60 }]);
  const standard = computeValue(db, cfg()).multiple!;
  const cheaper = computeValue(db, cfg({ planPriceUsd: 30 })).multiple!;
  assert.ok(Math.abs(cheaper / standard - 100 / 30) < 0.1);
});

test('an unpriced plan reports usage without inventing a multiple', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 20, credits: 60 }]);
  const v = computeValue(db, cfg({ plan: 'custom' }));
  assert.equal(v.equivalentUsd, 60);
  assert.equal(v.paidUsd, null);
  assert.equal(v.multiple, null);
});

test('an empty history reports nothing rather than a zero payback', () => {
  const v = computeValue(openDb(':memory:'), cfg());
  assert.equal(v.equivalentUsd, 0);
  assert.equal(v.multiple, null, 'no history is unknown, not "the plan returned nothing"');
  assert.deepEqual(v.byMonth, []);
});

test("the report says how our total compares with Claude Code's own", () => {
  const db = openDb(':memory:');
  const cfg = loadConfig();
  db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES ('m1','r1',?, 'claude-opus-5','opus',0,0,0,0,0,9.6,'s-1','/repo','', 'transcript')`,
  ).run(Date.now() - DAY);
  db.prepare('INSERT INTO session_costs (sessionId, usd, seenAt) VALUES (?,?,?)').run('s-1', 10, Date.now());

  const r = computeValue(db, cfg).reconciliation!;
  assert.equal(r.sessions, 1);
  assert.equal(r.reportedUsd, 10);
  assert.ok(Math.abs(r.ratio - 0.96) < 1e-9);
});

test('with nothing to compare against, no comparison is invented', () => {
  const db = openDb(':memory:');
  assert.equal(computeValue(db, loadConfig()).reconciliation, null);
});

test('a price correction is applied to history, not just to new events', () => {
  // A real database on disk, so it can be closed and reopened the way a restart
  // does — that reopen is what runs the migration.
  const file = join(mkdtempSync(join(tmpdir(), 'tokio-reprice-')), 'tokio.db');
  const first = openDb(file);
  // An Opus event priced at the old $15/Mtok input rate, as an install made
  // before the correction would have stored it.
  first.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES ('m1','r1',?, 'claude-opus-5','opus',1000000,0,0,0,0,15,'s-1','/repo','', 'transcript')`,
  ).run(Date.now());
  first.prepare("DELETE FROM kv WHERE key = 'pricingVersion'").run();
  assert.equal((first.prepare('SELECT credits FROM events').get() as { credits: number }).credits, 15);
  first.close();

  const reopened = openDb(file);
  assert.equal(
    (reopened.prepare('SELECT credits FROM events').get() as { credits: number }).credits,
    5,
    'Opus 5 input is $5/Mtok, and the stored history now says so',
  );
  reopened.close();
});

test('the fee is reported with the rate it was pro-rated from', () => {
  const db = openDb(':memory:');
  const cfg: Config = { ...loadConfig(), plan: 'max5', subscriptionStartedAt: null };
  seed(db, [{ daysAgo: 32, credits: 400 }, { daysAgo: 1, credits: 38 }]);

  const v = computeValue(db, cfg);
  assert.equal(v.monthlyUsd, 100, 'the price behind the figure is stated, not left to be reverse-engineered');
  // The pro-rated fee must be exactly the rate times the months elapsed, so the
  // arithmetic shown on screen ("32 days at $100/month") actually checks out.
  assert.ok(Math.abs(v.paidUsd! - v.monthlyUsd! * (v.elapsedDays / 30.437)) < 1e-9);
});

test('a day is judged against a day of the fee, not a month of it', () => {
  const db = openDb(':memory:');
  const cfg: Config = { ...loadConfig(), plan: 'max5', subscriptionStartedAt: null };
  seed(db, [{ daysAgo: 0, credits: 33 }, { daysAgo: 40, credits: 500 }]);

  const v = computeValue(db, cfg);
  assert.ok(Math.abs(v.dailyUsd! - 100 / 30.437) < 1e-9, '$100/month is $3.29/day');
  // Today's $33 against one day's $3.29 is ten times over — the point of the
  // figure is that it answers "was today worth it", not "was the month".
  assert.ok(Math.abs(v.periods.today.multiple! - 33 / v.dailyUsd!) < 1e-9);
  assert.equal(v.periods.today.usd, 33);
  // The 30-day window is charged for thirty days, and the 40-day-old spend is
  // outside it.
  assert.ok(Math.abs(v.periods.month.paidUsd! - v.dailyUsd! * 30) < 1e-9);
  assert.equal(v.periods.month.usd, 33);
});

test('a quiet day reports nothing rather than a zero payback', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 3, credits: 10 }]);
  const v = computeValue(db, { ...loadConfig(), plan: 'max5' });
  assert.equal(v.periods.today.usd, 0);
  assert.equal(v.periods.today.multiple, 0, 'zero usage is zero, never a division by nothing');
  assert.ok(v.periods.week.usd > 0);
});

test('the calendar has one entry per day that had usage, oldest first', () => {
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 2, credits: 5 }, { daysAgo: 2, credits: 5 }, { daysAgo: 1, credits: 3 }]);
  const v = computeValue(db, { ...loadConfig(), plan: 'max5' });
  assert.equal(v.byDay.length, 2, 'two events on one day are one day');
  assert.equal(v.byDay[0]!.usd, 10, 'and their costs are summed');
  assert.ok(v.byDay[0]!.day < v.byDay[1]!.day, 'oldest first');
});

test('an undetermined plan yields no payback rather than a plausible one', () => {
  // The gauges never needed the plan — they come from Anthropic's percentages —
  // so an unknown plan withholds the price instead of inventing one.
  const db = openDb(':memory:');
  seed(db, [{ daysAgo: 2, credits: 40 }]);
  const dir = mkdtempSync(join(tmpdir(), 'tokio-noplan-'));
  const cfg: Config = { ...loadConfig(), claudeConfigDir: dir, plan: 'auto', planPriceUsd: null };

  const v = computeValue(db, cfg);
  assert.equal(v.monthlyUsd, null);
  assert.equal(v.paidUsd, null);
  assert.equal(v.multiple, null);
  assert.equal(v.dailyUsd, null);
  assert.ok(v.equivalentUsd > 0, 'usage is still counted, it just is not divided by a guess');
});
