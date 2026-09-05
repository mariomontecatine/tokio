import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import type { Cap, Status, TracePoint, Window, WindowStatus } from '../types.ts';
import { activeBlock, buildBlocks, HOUR, type BlockInput } from './blocks.ts';
import { buildWeek } from './weekly.ts';
import { resolveCap } from '../plans/calibrate.ts';
import { latestAttempt, latestSessionRead, latestWeekRead, lastKnownReset, sessionReadsIn } from '../usage/store.ts';
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

export type { TracePoint } from '../types.ts';

/**
 * The window's shape reconstructed from this machine's transcripts.
 *
 * The fallback, used only when no reading covers the window. It can only ever
 * show work done here, and it is expressed as a share of a cap that is itself a
 * guess when nothing has been reported — which is exactly why it yields to
 * `reportedTrace` the moment there is a reading to yield to.
 */
export function blockTrace(events: BlockInput[], start: number, end: number, cap: number): TracePoint[] {
  const points: TracePoint[] = [];
  let cumulative = 0;
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    const slot = Math.floor((e.ts - start) / TRACE_BUCKET_MS);
    cumulative += e.credits;
    const t = start + slot * TRACE_BUCKET_MS;
    const pct = cap > 0 ? Math.min(100, (cumulative / cap) * 100) : 0;
    const last = points[points.length - 1];
    if (last && last.t === t) last.pct = pct;
    else points.push({ t, pct });
  }
  return points;
}

/**
 * The window's shape as Anthropic reported it, sample by sample.
 *
 * This is what makes a window readable on a machine that did none of the work.
 * Every few minutes `/usage` is asked what the session is at, and the answers,
 * laid out in time, are the window — no transcript required, and no dependence
 * on where the prompts were typed.
 *
 * The samples are left exactly as they came back, dips included. A reading is
 * rounded to a whole percent and can land a point below the one before it;
 * flattening that would be smoothing over the only measurement there is, and
 * the strip draws steps precisely so a coarse sample reads as a coarse sample.
 *
 * `usedPct` closes the series at `now` — the same reading carried forward with
 * whatever this machine has spent since, which is the figure the ring shows.
 * Without it the line would stop at the last probe and the strip would trail
 * the ring by up to a poll. It is appended unconditionally, so a caller that
 * has a percentage to show always gets a series that reaches it: the series was
 * once allowed to come back empty, the caller read that emptiness as "nothing
 * reported" and fell back to local credits, and the chart went back to drawing
 * a line at 0% under a dot at 55%.
 *
 * A reading stamped ahead of `now` is pinned to `now` rather than dropped for
 * the same reason. A clock that steps backwards — a laptop resuming, a VM
 * rejoining the host — leaves readings in the future for as long as it takes to
 * catch up, and losing the window's whole history to that is a far worse answer
 * than plotting them at the moment we noticed them.
 */
export function reportedTrace(
  reads: { at: number; pct: number }[],
  start: number,
  now: number,
  usedPct: number,
): TracePoint[] {
  const points: TracePoint[] = [];
  for (const r of reads) {
    if (r.at < start) continue;
    points.push({ t: Math.min(r.at, now), pct: r.pct });
  }
  const last = points[points.length - 1];
  if (last && last.t === now) last.pct = usedPct;
  else points.push({ t: now, pct: usedPct });
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
 * Turn a reported percentage into a credit cap — a floor for one, at least.
 *
 * The gauge no longer needs this — Anthropic's own percentage drives that — but
 * the forecast does: to say "this job leaves you at 38%" we must express a
 * dollar estimate as a share of the window. A low percentage makes the division
 * unstable, so early readings are ignored rather than trusted.
 *
 * What it yields is a lower bound rather than the cap. The numerator is what
 * this machine's transcripts saw; the denominator is a percentage of the whole
 * account. Any work done elsewhere — the browser, a phone, a second laptop —
 * inflates the denominator and leaves the numerator alone, so the answer comes
 * out too small, never too large. See `highAnchor` in plans/calibrate.ts, which
 * is the same division and the same asymmetry.
 */
function capFromProbe(credits: number, pct: number | null): number | null {
  if (pct === null || pct < 15 || credits <= 0) return null;
  return credits / (pct / 100);
}

/**
 * The best cap available, given a floor this window has just implied.
 *
 * The floor wins over a shipped guess, because a guess is not an observation.
 * It does not win over calibration, because those anchors are observations too
 * — the same division taken over weeks — and every one of them is a floor as
 * well, so the larger of the two is the one closer to the truth. Letting the
 * live floor override them meant a single window shared with a browser could
 * shrink the cap to a quarter of its size and take the whole page down with it.
 */
function bestCap(floor: number | null, calibrated: Cap): Cap {
  if (floor === null) return calibrated;
  if (calibrated.basis === 'default' || floor >= calibrated.credits) {
    return { credits: floor, basis: 'reported' };
  }
  return calibrated;
}

/**
 * Anthropic's percentage, carried forward to now.
 *
 * `/usage` is read every few minutes, and in between it is simply out of date —
 * during a busy stretch it can sit ten points behind. That produced a page at
 * odds with itself: the ring showed a low figure read minutes ago while the
 * verdict beside it used a burn rate measured seconds ago, so "16% used" sat
 * next to "you run out at 16:46" and neither half explained the other.
 *
 * The reported figure stays the authority; what is added is only what has been
 * spent since it was read, measured from the same transcripts everything else
 * is measured from, and only within the current window — a reset between the
 * reading and now must not drag the previous window's spend across. A stale
 * reported number is not more honest than this, only older.
 */
function advanceReported(
  pct: number | null,
  events: BlockInput[],
  readAt: number,
  windowStart: number,
  now: number,
  cap: number,
): number | null {
  if (pct === null) return null;
  if (cap <= 0) return pct;
  const from = Math.max(readAt, windowStart);
  let since = 0;
  for (const e of events) if (e.ts > from && e.ts <= now) since += e.credits;
  return Math.min(100, pct + (since / cap) * 100);
}

/**
 * A reading is only ever about the window it was taken in.
 *
 * Two things retire one. Age, which is the ordinary case and was already
 * handled — and the reset it reported having since passed, which was not.
 * `/usage` prints no session line while nothing is running, so once a window
 * closes on an idle machine the last reading taken *before* the close keeps
 * winning `latestSessionRead` for as long as the age test allows it. The whole
 * page then described a window that was over: the ring held the old 100%, the
 * countdown sat at "resets in now", and the scheduler waited for a window that
 * had already opened.
 *
 * Retiring it costs the reported percentage until the next probe lands, and
 * that is the right trade — a reconstruction of the window you are actually in
 * beats Anthropic's own figure for the one you have left.
 */
function inCurrentWindow(
  read: UsageProbe | null,
  resetsAt: number | null | undefined,
  now: number,
  maxAgeMs: number,
): UsageProbe | null {
  if (!read) return null;
  if (now - read.at > maxAgeMs) return null;
  if (resetsAt != null && resetsAt <= now) return null;
  return read;
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
  const session = inCurrentWindow(sessionRead, sessionRead?.sessionResetsAt, now, cfg.usageMaxAgeMs);
  const fresh = inCurrentWindow(weekRead, weekRead?.weekResetsAt, now, cfg.usageMaxAgeMs);

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

  // Both halves of the division must be from the same instant. A percentage
  // read minutes ago against spend counted now inflates the cap by whatever
  // landed in between — during a busy stretch the cap visibly drifts upward,
  // and every figure derived from it drifts with it.
  const atBlockRead = session ? creditsIn(events, block.start, session.at) : null;
  const atWeekRead = fresh ? creditsIn(events, week.start, fresh.at) : null;

  const blockCap = capFromProbe(atBlockRead?.credits ?? 0, session?.sessionPct ?? null);
  const weekCap = capFromProbe(atWeekRead?.credits ?? 0, fresh?.weekPct ?? null);
  const opusCapReported = capFromProbe(atWeekRead?.opusCredits ?? 0, fresh?.opusPct ?? null);

  const blockCapInfo = bestCap(blockCap, resolveCap(db, cfg, 'block'));
  const weekCapInfo = bestCap(weekCap, resolveCap(db, cfg, 'week'));
  const opusCapInfo = bestCap(opusCapReported, resolveCap(db, cfg, 'weekOpus'));

  const recent = events.filter((e) => e.ts >= now - BURN_SAMPLE_MS);
  const burnRate = recent.reduce((s, e) => s + e.credits, 0) / (BURN_SAMPLE_MS / HOUR);

  const blockStatus = toStatus(
    block,
    blockCapInfo,
    block.credits,
    block.end,
    advanceReported(session?.sessionPct ?? null, events, session?.at ?? 0, block.start, now, blockCapInfo.credits),
  );

  // The strip's shape, from the reading rather than the transcripts wherever
  // there is a reading. Anthropic's percentage covers work done anywhere on the
  // account; ours covers only what was typed into a terminal on this machine.
  // Gating the strip on local events meant a window spent entirely in the
  // browser drew nothing at all, next to a ring that knew perfectly well how
  // full it was.
  //
  // The choice is made on `session` alone — the same fact `blockStatus.source`
  // is decided by — and never on how many samples came back. Deciding it on the
  // samples let the two disagree: the ring could be reporting while the strip
  // was estimating, and the chart drew one story under the other.
  const reads = session?.sessionResetsAt ? sessionReadsIn(db, session.sessionResetsAt, RESET_JUMP_MS) : [];
  const traceSource: 'reported' | 'estimated' = session ? 'reported' : 'estimated';
  const trace = session
    ? reportedTrace(reads, block.start, now, blockStatus.usedPct)
    : blockTrace(events, block.start, block.end, blockCapInfo.credits);

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
    trace,
    traceSource,
    reservePct: cfg.reservePct,
    block: blockStatus,
    week: toStatus(
      week,
      weekCapInfo,
      week.credits,
      weekResetsAt,
      advanceReported(fresh?.weekPct ?? null, events, fresh?.at ?? 0, week.start, now, weekCapInfo.credits),
      weekRolling,
    ),
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
