import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import profiles from '../plans/profiles.json' with { type: 'json' };

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
  /** Days of history the comparison covers. */
  elapsedDays: number;
  /** equivalentUsd / paidUsd. Null when we can't price the plan. */
  multiple: number | null;
  thisWeekUsd: number;
  thisBlockUsd: number;
  /** Newest first, for the chart. */
  byMonth: { month: string; usd: number }[];
}

function sum(db: Db, since: number, until = Date.now()): number {
  const row = db.prepare('SELECT COALESCE(SUM(credits), 0) AS c FROM events WHERE ts >= ? AND ts < ?').get(since, until) as { c: number };
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

  const price = cfg.planPriceUsd ?? PROFILES[cfg.plan]?.priceUsd ?? null;

  // Pro-rate rather than counting whole billing periods. Rounding up made the
  // figure halve the moment a month ticked over — two months billed against one
  // month of usage — which said nothing about the day before.
  const elapsedDays = Math.max(1, (now - since) / (24 * 3_600_000));
  const paidUsd = price === null ? null : price * (elapsedDays / 30.437);

  // Under a few days the denominator is too small to divide by honestly: a
  // fresh install would boast a spectacular multiple off an afternoon's work.
  const enoughHistory = elapsedDays >= 3;

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
    elapsedDays,
    multiple: enoughHistory && paidUsd && paidUsd > 0 ? equivalentUsd / paidUsd : null,
    thisWeekUsd: sum(db, now - 7 * 24 * 3_600_000, now),
    thisBlockUsd: sum(db, now - 5 * 3_600_000, now),
    byMonth,
  };
}
