import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import type { Status, Window, WindowStatus } from '../types.ts';
import { activeBlock, buildBlocks, HOUR, type BlockInput } from './blocks.ts';
import { buildWeek } from './weekly.ts';
import { resolveCap } from '../plans/calibrate.ts';
import { latestAttempt, latestSessionRead, latestWeekRead, lastKnownReset } from '../usage/store.ts';
import { headroom } from './headroom.ts';
import { resolvePlan } from '../plans/detect.ts';
import type { UsageProbe } from '../usage/probe.ts';

export { buildBlocks, activeBlock, floorToHour, HOUR } from './blocks.ts';
export { buildWeek, weekStart } from './weekly.ts';
export { creditsFor, familyOf, ratesFor, resolveRates, TIERS } from './weights.ts';
export { computeValue } from './value.ts';
export { headroom } from './headroom.ts';

const BURN_SAMPLE_MS = 30 * 60_000;

/**
 * How far the window start must move to count as a real reset.
 *
 * Anthropic's reported reset time is rolling and rounded to the minute, so it
 * drifts by up to a minute between readings. A genuine reset moves it by hours.
 */
export const RESET_JUMP_MS = 30 * 60_000;

export function isRealReset(previousStart: number, currentStart: number): boolean {
  return currentStart - previousStart > RESET_JUMP_MS;
}
const TRACE_BUCKET_MS = 5 * 60_000;
const DAY = 24 * HOUR;

export interface TracePoint { t: number; c: number }

/** Cumulative spend through the current window, for the dashboard's strip chart. */
export function blockTrace(events: BlockInput[], start: number, end: number): TracePoint[] {
  const points: TracePoint[] = [];
  let cumulative = 0;
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    const slot = Math.floor((e.ts - start) / TRACE_BUCKET_MS);
    cumulative += e.credits;
    const t = start + slot * TRACE_BUCKET_MS;
    const last = points[points.length - 1];
    if (last && last.t === t) last.c = cumulative;
    else points.push({ t, c: cumulative });
  }
  return points;
}

function loadEvents(db: Db, since: number): BlockInput[] {
  return db.prepare('SELECT ts, credits, family FROM events WHERE ts >= ? ORDER BY ts').all(since) as unknown as BlockInput[];
}

function creditsIn(events: BlockInput[], start: number, end: number): { credits: number; opusCredits: number; events: number; lastActivity: number | null } {
  let credits = 0;
  let opusCredits = 0;
  let count = 0;
  let lastActivity: number | null = null;
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    credits += e.credits;
    if (e.family === 'opus') opusCredits += e.credits;
    count += 1;
    lastActivity = e.ts;
  }
  return { credits, opusCredits, events: count, lastActivity };
}

/**
 * Turn a reported percentage into a credit cap.
 *
 * The gauge no longer needs this — Anthropic's own percentage drives that — but
 * the forecast does: to say "this job leaves you at 38%" we must express a
 * dollar estimate as a share of the window. A low percentage makes the division
 * unstable, so early readings are ignored rather than trusted.
 */
function capFromProbe(credits: number, pct: number | null): number | null {
  if (pct === null || pct < 15 || credits <= 0) return null;
  return credits / (pct / 100);
}

function toStatus(
  window: Window,
  cap: { credits: number; basis: 'default' | 'calibrated' | 'reported'; anchors?: number },
  used: number,
  resetsAt: number,
  reportedPct: number | null,
  rolling = false,
): WindowStatus {
  const estimatedPct = cap.credits > 0 ? Math.min(100, (used / cap.credits) * 100) : 0;
  const usedPct = reportedPct ?? estimatedPct;
  return {
    window,
    cap,
    usedPct,
    // Remaining follows whichever percentage we are showing, so the two can
    // never disagree on screen.
    remainingCredits: Math.max(0, cap.credits * (1 - usedPct / 100)),
    resetsAt,
    rolling,
    source: reportedPct === null ? 'estimated' : 'reported',
  };
}

export function computeStatus(db: Db, cfg: Config, now = Date.now()): Status {
  const attempt = latestAttempt(db);
  // Session and week are read separately: `/usage` can return one without the
  // other around a reset, and a reply missing the session line must not throw
  // away a good session figure. See usage/store.ts.
  const sessionRead = latestSessionRead(db);
  const weekRead = latestWeekRead(db);
  const session: UsageProbe | null = sessionRead && now - sessionRead.at <= cfg.usageMaxAgeMs ? sessionRead : null;
  const fresh: UsageProbe | null = weekRead && now - weekRead.at <= cfg.usageMaxAgeMs ? weekRead : null;

  const events = loadEvents(db, now - 15 * DAY);

  // The real window is the five hours ending at the reset Anthropic reports.
  // Reconstructing it from transcripts is only a fallback: sessions do not
  // start on the hour, so the guessed boundary can be hours off — and the
  // fallback still honours the last reset we were told about, so it cannot
  // count spend that a finished window already accounted for.
  const resetFloor = lastKnownReset(db, now);
  let block: Window;
  if (session?.sessionResetsAt) {
    const start = session.sessionResetsAt - cfg.blockHours * HOUR;
    block = { start, end: session.sessionResetsAt, ...creditsIn(events, start, session.sessionResetsAt), active: true };
  } else {
    block = activeBlock(buildBlocks(events, cfg.blockHours, resetFloor), now, cfg.blockHours, resetFloor);
  }

  const weekAnchored = fresh?.weekResetsAt ?? null;
  const week: Window = weekAnchored
    ? { start: weekAnchored - 7 * DAY, end: weekAnchored, ...creditsIn(events, weekAnchored - 7 * DAY, weekAnchored), active: true }
    : buildWeek(events, now, cfg.weeklyAnchor);

  const blockCap = capFromProbe(block.credits, session?.sessionPct ?? null);
  const weekCap = capFromProbe(week.credits, fresh?.weekPct ?? null);
  const opusCapReported = capFromProbe(week.opusCredits, fresh?.opusPct ?? null);

  const blockCapInfo = blockCap !== null
    ? { credits: blockCap, basis: 'reported' as const }
    : resolveCap(db, cfg, 'block');
  const weekCapInfo = weekCap !== null
    ? { credits: weekCap, basis: 'reported' as const }
    : resolveCap(db, cfg, 'week');
  const opusCapInfo = opusCapReported !== null
    ? { credits: opusCapReported, basis: 'reported' as const }
    : resolveCap(db, cfg, 'weekOpus');

  const recent = events.filter((e) => e.ts >= now - BURN_SAMPLE_MS);
  const burnRate = recent.reduce((s, e) => s + e.credits, 0) / (BURN_SAMPLE_MS / HOUR);

  const blockStatus = toStatus(block, blockCapInfo, block.credits, block.end, session?.sessionPct ?? null);

  let exhaustionAt: number | null = null;
  if (burnRate > 0 && blockStatus.remainingCredits > 0) {
    const at = now + (blockStatus.remainingCredits / burnRate) * HOUR;
    exhaustionAt = at < block.end ? at : null;
  }

  const oldestInWeek = events.find((e) => e.ts >= week.start)?.ts ?? now;
  const weekResetsAt = weekAnchored ?? (cfg.weeklyAnchor ? week.end : oldestInWeek + 7 * DAY);
  const weekRolling = !weekAnchored && !cfg.weeklyAnchor;

  // With a fresh probe, silence about Opus means the plan has no separate Opus
  // allowance — better to show nothing than a gauge nobody is metering.
  const showOpus = fresh ? fresh.opusPct !== null : opusCapInfo.credits > 0;

  const queued = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','deferred')").get() as { n: number }).n;

  const plan = resolvePlan(cfg);

  return {
    now,
    plan: plan.plan,
    planBasis: plan.basis,
    trace: blockTrace(events, block.start, block.end),
    reservePct: cfg.reservePct,
    block: blockStatus,
    week: toStatus(week, weekCapInfo, week.credits, weekResetsAt, fresh?.weekPct ?? null, weekRolling),
    weekOpus: showOpus
      ? toStatus(week, opusCapInfo, week.opusCredits, weekResetsAt, fresh?.opusPct ?? null, weekRolling)
      : null,
    burnRate,
    exhaustionAt,
    queued,
    headroom: headroom(db, blockStatus.remainingCredits, now),
    probe: attempt
      ? { at: attempt.at, ageMs: now - attempt.at, stale: now - attempt.at > cfg.usageMaxAgeMs, error: attempt.error }
      : null,
  };
}
