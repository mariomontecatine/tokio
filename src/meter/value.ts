import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import profiles from '../plans/profiles.json' with { type: 'json' };
import { resolvePlan } from '../plans/detect.ts';

interface Profile { label: string; priceUsd: number }
const PROFILES = profiles as unknown as Record<string, Profile>;

export interface ValueReport {
  /** Start of the period being totalled, epoch millis. */
  since: number;
  /** True when `since` is the oldest transcript rather than a date you gave us. */
  sinceIsFirstTranscript: boolean;
  /** List-price API cost of everything run in the period. */
  equivalentUsd: number;
  /** Subscription fees over the same period, or null when the price is unknown. */
  paidUsd: number | null;
  /** The monthly price those fees were pro-rated from. */
  monthlyUsd: number | null;
  /** Days of history the comparison covers. */
  elapsedDays: number;
  /** equivalentUsd / paidUsd. Null when we can't price the plan. */
  multiple: number | null;
  thisWeekUsd: number;
  thisBlockUsd: number;
  /** Newest first, for the chart. */
  byMonth: { month: string; usd: number }[];
  /** What one day of the subscription costs, so a single day can be judged. */
  dailyUsd: number | null;
  /** Payback over shorter horizons than the whole period. */
  periods: Record<PeriodName, PeriodValue>;
  /** One entry per day with usage, oldest first, for the calendar. */
  byDay: { day: string; usd: number }[];
  /** How our arithmetic compares with Claude Code's own, where both exist. */
  reconciliation: Reconciliation | null;
}

export type PeriodName = 'today' | 'yesterday' | 'week' | 'month';

export interface PeriodValue {
  /** List-price API cost of the work done in the period. */
  usd: number;
  /** Subscription fee covering the same span. */
  paidUsd: number | null;
  /** usd / paidUsd. Null when the plan has no price. */
  multiple: number | null;
}

export interface Reconciliation {
  /** Sessions where Claude Code left its own total in the transcript. */
  sessions: number;
  /** Claude Code's figure for those sessions. */
  reportedUsd: number;
  /** Ours for the same sessions. */
  ourUsd: number;
  /** ourUsd / reportedUsd. Below 1 means we are counting a floor. */
  ratio: number;
}

/**
 * Check our sums against Claude Code's own.
 *
 * Claude Code occasionally writes a `cost-state` line into a transcript with
 * the total it computed for that session. Where it did, we can compare like
 * with like — and the honest expectation is that we come in slightly under,
 * because a few calls (the Haiku that titles a session, compaction, retries)
 * never appear in the transcript as assistant messages for us to count.
 *
 * Null when no session has both figures, which is the common case: this is a
 * cross-check when one is available, never a number we invent.
 */
function reconcile(db: Db): Reconciliation | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(c.usd), 0) AS reportedUsd,
              COALESCE(SUM(e.credits), 0) AS ourUsd
       FROM session_costs c
       JOIN (SELECT sessionId, SUM(credits) AS credits FROM events GROUP BY sessionId) e
         ON e.sessionId = c.sessionId`,
    )
    .get() as { sessions: number; reportedUsd: number; ourUsd: number };

  if (!row.sessions || row.reportedUsd <= 0) return null;
  return { ...row, ratio: row.ourUsd / row.reportedUsd };
}

/**
 * Days the calendar covers.
 *
 * Thirty, not a year. Claude Code deletes transcripts after thirty days by
 * default, so a fresh install has nothing older to draw however far back the
 * grid reaches — a year of empty squares says "you did nothing" when the truth
 * is "nobody kept the record". It also matches the headline figure above it,
 * which is the thirty-day payback.
 */
const CALENDAR_DAYS = 30;

/**
 * Usage per calendar day, in the machine's own timezone.
 *
 * Local days, not UTC ones: "what did I get out of it today" is a question
 * about the day you lived, and a window that starts at 01:00 local would
 * otherwise split every evening across two cells of the calendar.
 */
function usageByDay(db: Db, now: number): { day: string; usd: number }[] {
  return db
    .prepare(
      `SELECT date(ts/1000, 'unixepoch', 'localtime') AS day, ROUND(SUM(credits), 4) AS usd
       FROM events WHERE ts >= ? GROUP BY day ORDER BY day`,
    )
    .all(now - CALENDAR_DAYS * 24 * 3_600_000) as unknown as { day: string; usd: number }[];
}

const isoDay = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Spend in a span, `until` included.
 *
 * Inclusive on purpose: every caller here passes `now` as the upper bound and
 * means "everything up to this moment". A half-open interval drops a response
 * that landed in the current millisecond — invisible in practice, but it is the
 * newest event, the one someone is most likely to be looking for. None of these
 * spans share a boundary with another, so nothing can be counted twice.
 */
function sum(db: Db, since: number, until = Date.now()): number {
  const row = db.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM events WHERE ts >= ? AND ts <= ?').get(since, until) as { c: number };
  return row.c;
}

/**
 * What the subscription has been worth.
 *
 * This is what the same work would have cost at list API prices — not what
 * Anthropic spent serving it, which is their inference cost and much lower.
 * It also only counts what this machine's transcripts contain, so it is a
 * floor, never an overstatement.
 */
export function computeValue(db: Db, cfg: Config, now = Date.now()): ValueReport {
  const oldest = (db.prepare('SELECT MIN(ts) AS t FROM events').get() as { t: number | null }).t ?? now;
  const configured = cfg.subscriptionStartedAt ? Date.parse(cfg.subscriptionStartedAt) : NaN;
  const sinceIsFirstTranscript = !Number.isFinite(configured);
  const since = sinceIsFirstTranscript ? oldest : configured;

  const equivalentUsd = sum(db, since, now);

  // An undetermined plan yields no price, so no payback is built on a plan the
  // user never confirmed. The gauges do not need it: those come from Anthropic.
  const resolved = resolvePlan(cfg);
  const price = cfg.planPriceUsd ?? (resolved.basis === 'unknown' ? null : PROFILES[resolved.plan]?.priceUsd ?? null);

  // Pro-rate rather than counting whole billing periods. Rounding up made the
  // figure halve the moment a month ticked over — two months billed against one
  // month of usage — which said nothing about the day before.
  const elapsedDays = Math.max(1, (now - since) / (24 * 3_600_000));
  const paidUsd = price === null ? null : price * (elapsedDays / 30.437);

  // Under a few days the denominator is too small to divide by honestly: a
  // fresh install would boast a spectacular multiple off an afternoon's work.
  const enoughHistory = elapsedDays >= 3;

  // A day of subscription is what a single day's work has to beat to have paid
  // for itself, which is the only way "was today worth it" means anything.
  const dailyUsd = price === null ? null : price / 30.437;

  const byDay = usageByDay(db, now);
  const usdOn = new Map(byDay.map((d) => [d.day, d.usd]));
  const dayMs = 24 * 3_600_000;

  const over = (usd: number, days: number): PeriodValue => {
    const paid = dailyUsd === null ? null : dailyUsd * days;
    return { usd, paidUsd: paid, multiple: paid && paid > 0 ? usd / paid : null };
  };

  const periods: Record<PeriodName, PeriodValue> = {
    today: over(usdOn.get(isoDay(now)) ?? 0, 1),
    yesterday: over(usdOn.get(isoDay(now - dayMs)) ?? 0, 1),
    week: over(sum(db, now - 7 * dayMs, now), 7),
    month: over(sum(db, now - 30 * dayMs, now), 30),
  };

  const byMonth = (
    db
      .prepare(
        `SELECT strftime('%Y-%m', ts/1000, 'unixepoch') AS month, ROUND(SUM(credits), 2) AS usd
         FROM events WHERE ts >= ? GROUP BY month ORDER BY month DESC LIMIT 12`,
      )
      .all(since) as unknown as { month: string; usd: number }[]
  );

  return {
    since,
    sinceIsFirstTranscript,
    equivalentUsd,
    paidUsd,
    monthlyUsd: price,
    elapsedDays,
    multiple: enoughHistory && paidUsd && paidUsd > 0 ? equivalentUsd / paidUsd : null,
    thisWeekUsd: sum(db, now - 7 * 24 * 3_600_000, now),
    thisBlockUsd: sum(db, now - 5 * 3_600_000, now),
    byMonth,
    dailyUsd,
    periods,
    byDay,
    reconciliation: reconcile(db),
  };
}
