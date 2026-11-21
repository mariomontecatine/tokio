import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { CodexReading } from './parse.ts';
import { lastCodexReset, latestCodexAttempt, latestCodexRead, latestCodexReading } from './store.ts';

type Db = DatabaseSync;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * One Codex window as OpenAI reported it.
 *
 * There is no estimated counterpart, unlike Claude's `WindowStatus`. tokio can
 * reconstruct a Claude window because it has a cap to divide by — shipped,
 * calibrated, or implied by a reading — and it has nothing of the sort for
 * Codex. So a Codex window is either a reading or absent, and absent is shown
 * as absent.
 */
export interface CodexWindowStatus {
  expiresAt?: number;
  usedPct: number;
  resetsAt: number | null;
  windowMinutes: number | null;
  /** When the window opened, where the reset and the length say so. */
  start: number | null;
  source: 'reported';
  /** Which of the two ways it was read: asked for, or carried by a Codex turn. */
  via: CodexReading['via'];
  readAt: number;
  ageMs: number;
  /**
   * Older than `usageMaxAgeMs`. Still shown, and still true as a floor: within
   * a window the percentage only goes up, so an old reading can be behind but
   * never above. A rollout reading is exactly as old as the last Codex turn.
   */
  stale: boolean;
}

export interface CodexTokenTotals {
  responses: number;
  /** As reported: includes cached input. */
  inputTokens: number;
  cachedInputTokens: number;
  /** As reported: includes reasoning. */
  outputTokens: number;
  reasoningOutputTokens: number;
  /** At OpenAI's list price, or null when any response in the span has none. */
  usd: number | null;
  /** Responses in the span with no published price. */
  unpriced: number;
}

export interface CodexStatus {
  session: CodexWindowStatus | null;
  week: CodexWindowStatus | null;
  /** As OpenAI names it — `plus`, `pro`. Reported, never assumed. */
  planType: string | null;
  /** Set while OpenAI says a limit is reached. */
  limitReached: string | null;
  /**
   * The latest five-hour reset a reading announced that has since passed. It
   * is how the queue knows a window turned over even before anything has read
   * the new one.
   */
  lastResetAt: number | null;
  /** The last time the app server was asked, and whether it answered. */
  probe: { at: number; ageMs: number; error: string | null } | null;
  /** What this machine's rollouts show, counted locally. */
  tokens: { session: CodexTokenTotals; week: CodexTokenTotals; today: CodexTokenTotals };
  /**
   * The models Codex actually ran here in the last month, most used first —
   * the choices a queued job is offered, rather than a list typed in from
   * memory that would be out of date by the next release.
   */
  models: string[];
}

/**
 * A reading only speaks for the window it was taken in.
 *
 * Past the reset it named, it describes a window that is over, and the honest
 * thing to show is no reading at all — not the old figure carried forward, and
 * not a zero, which would be a guess about a window nobody has read yet. A
 * reading that named no reset falls back to the age limit Claude's readings use.
 */
function current(
  read: CodexReading | null,
  pct: number | null,
  resetsAt: number | null,
  minutes: number | null,
  now: number,
  maxAgeMs: number,
): CodexWindowStatus | null {
  // Below zero is not a reading of anything. Above a hundred is: it is a window
  // spent past its limit, and hiding it would draw the one window that is full
  // as if nothing were known about it. The ring itself stops at 100.
  if (!read || pct === null || pct < 0) return null;
  const ageMs = Math.max(0, now - read.at);
  if (resetsAt !== null && resetsAt <= now) return null;
  if (resetsAt === null && ageMs > maxAgeMs) return null;
  return {
    expiresAt: resetsAt ?? read.at + maxAgeMs + 1,
    usedPct: pct,
    resetsAt,
    windowMinutes: minutes,
    start: resetsAt !== null && minutes !== null ? resetsAt - minutes * 60_000 : null,
    source: 'reported',
    via: read.via,
    readAt: read.at,
    ageMs,
    stale: ageMs > maxAgeMs,
  };
}

export function codexTokens(db: Db, since: number, until: number): CodexTokenTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS responses,
              COALESCE(SUM(inputTokens), 0) AS inputTokens,
              COALESCE(SUM(cachedInputTokens), 0) AS cachedInputTokens,
              COALESCE(SUM(outputTokens), 0) AS outputTokens,
              COALESCE(SUM(reasoningOutputTokens), 0) AS reasoningOutputTokens,
              COALESCE(SUM(credits), 0) AS priced,
              SUM(CASE WHEN credits IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM codex_events WHERE ts >= ? AND ts <= ?`,
    )
    .get(since, until) as unknown as {
      responses: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
      reasoningOutputTokens: number; priced: number; unpriced: number | null;
    };
  const unpriced = row.unpriced ?? 0;
  return {
    responses: row.responses,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens,
    // A partial sum would read as the whole: null unless every response is priced.
    usd: row.responses > 0 && unpriced === 0 ? row.priced : null,
    unpriced,
  };
}

/** Local midnight, so "today" is the day lived rather than a UTC one. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeCodexStatus(db: Db, cfg: Pick<Config, 'usageMaxAgeMs'>, now = Date.now()): CodexStatus {
  const sessionRead = latestCodexRead(db, 'session', now);
  const weekRead = latestCodexRead(db, 'week', now);
  const session = current(sessionRead, sessionRead?.sessionPct ?? null, sessionRead?.sessionResetsAt ?? null, sessionRead?.sessionMinutes ?? null, now, cfg.usageMaxAgeMs);
  const week = current(weekRead, weekRead?.weekPct ?? null, weekRead?.weekResetsAt ?? null, weekRead?.weekMinutes ?? null, now, cfg.usageMaxAgeMs);

  // The plan and the limit flag come with every reading; take them from the
  // newest one, but only while the window it described is still open.
  const latest = latestCodexReading(db, now);
  const latestOpen = latest && (latest.sessionPct !== null ? session?.readAt === latest.at : week?.readAt === latest.at) ? latest : null;
  const attempt = latestCodexAttempt(db, now);

  return {
    session,
    week,
    planType: latest?.planType ?? null,
    limitReached: latestOpen?.limitReached ?? null,
    lastResetAt: lastCodexReset(db, now),
    probe: attempt ? { at: attempt.at, ageMs: now - attempt.at, error: attempt.error } : null,
    tokens: {
      session: codexTokens(db, session?.start ?? now - 5 * HOUR, now),
      week: codexTokens(db, week?.start ?? now - 7 * DAY, now),
      today: codexTokens(db, startOfDay(now), now),
    },
    models: (
      db
        .prepare("SELECT model FROM codex_events WHERE ts BETWEEN ? AND ? AND model <> 'unknown' GROUP BY model ORDER BY COUNT(*) DESC LIMIT 8")
        .all(now - 30 * DAY, now) as unknown as { model: string }[]
    ).map((r) => r.model),
  };
}
