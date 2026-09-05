import type { Db } from '../db.ts';
import type { UsageProbe } from './probe.ts';

export function saveProbe(db: Db, probe: UsageProbe): void {
  db.prepare(
    `INSERT OR REPLACE INTO probes (at, sessionPct, sessionResetsAt, weekPct, weekResetsAt, opusPct, opusResetsAt, error)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    probe.at, probe.sessionPct, probe.sessionResetsAt, probe.weekPct,
    probe.weekResetsAt, probe.opusPct, probe.opusResetsAt, probe.error,
  );
}

/** The most recent probe that actually returned numbers. */
export function latestProbe(db: Db): UsageProbe | null {
  const row = db
    .prepare('SELECT * FROM probes WHERE error IS NULL ORDER BY at DESC LIMIT 1')
    .get() as unknown as UsageProbe | undefined;
  return row ?? null;
}

/**
 * The two readings are tracked apart, because `/usage` can return one without
 * the other.
 *
 * It happens right at a reset: for a minute or so the session line is missing
 * while the weekly line is still there. Taking the newest probe wholesale meant
 * a reading with no session figure displaced a perfectly good one, the block
 * silently fell back to local reconstruction, and the number on screen stopped
 * being Anthropic's — at the exact moment a reset makes it matter most.
 */
export function latestSessionRead(db: Db): UsageProbe | null {
  const row = db
    .prepare('SELECT * FROM probes WHERE error IS NULL AND sessionPct IS NOT NULL ORDER BY at DESC LIMIT 1')
    .get() as unknown as UsageProbe | undefined;
  return row ?? null;
}

export function latestWeekRead(db: Db): UsageProbe | null {
  const row = db
    .prepare('SELECT * FROM probes WHERE error IS NULL AND weekPct IS NOT NULL ORDER BY at DESC LIMIT 1')
    .get() as unknown as UsageProbe | undefined;
  return row ?? null;
}

/**
 * The most recent window reset we were actually told about and that has passed.
 *
 * Spend before it belongs to a window that is over, so a local reconstruction
 * must not count it. Without this the first minutes of a new window inherit the
 * tail of the old one.
 */
export function lastKnownReset(db: Db, now: number): number | null {
  const row = db
    .prepare('SELECT MAX(sessionResetsAt) AS at FROM probes WHERE sessionResetsAt IS NOT NULL AND sessionResetsAt <= ?')
    .get(now) as { at: number | null };
  return row.at ?? null;
}

/**
 * Every session reading taken inside one window, oldest first.
 *
 * When the work was not done on this machine there is nothing else to draw. A
 * browser session, or a second laptop, writes no transcript here, so the strip
 * has no local spend to plot even though the window is plainly being used —
 * which is how it came to sit flat at zero beside a ring reading 10%. These
 * readings are the shape of that window, sampled every few minutes.
 *
 * Readings are matched to a window by the reset they name, not by the clock
 * time they were taken at: a probe seconds after a rollover belongs to the new
 * window while its timestamp still sits inside the old one. The reported reset
 * drifts by up to a minute between reads, so the match is a tolerance rather
 * than an equality — the same tolerance that tells a drift from a real reset.
 */
export function sessionReadsIn(db: Db, resetsAt: number, toleranceMs: number): { at: number; pct: number }[] {
  return db
    .prepare(
      `SELECT at, sessionPct AS pct FROM probes
       WHERE error IS NULL AND sessionPct IS NOT NULL AND sessionResetsAt IS NOT NULL
         AND ABS(sessionResetsAt - ?) <= ?
       ORDER BY at`,
    )
    .all(resetsAt, toleranceMs) as unknown as { at: number; pct: number }[];
}

/** The most recent attempt, successful or not, so failures can be surfaced. */
export function latestAttempt(db: Db): UsageProbe | null {
  const row = db.prepare('SELECT * FROM probes ORDER BY at DESC LIMIT 1').get() as unknown as UsageProbe | undefined;
  return row ?? null;
}

export function pruneProbes(db: Db, keep = 500): void {
  db.prepare('DELETE FROM probes WHERE at NOT IN (SELECT at FROM probes ORDER BY at DESC LIMIT ?)').run(keep);
}
