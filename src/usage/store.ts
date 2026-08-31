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

/** The most recent attempt, successful or not, so failures can be surfaced. */
export function latestAttempt(db: Db): UsageProbe | null {
  const row = db.prepare('SELECT * FROM probes ORDER BY at DESC LIMIT 1').get() as unknown as UsageProbe | undefined;
  return row ?? null;
}

export function pruneProbes(db: Db, keep = 500): void {
  db.prepare('DELETE FROM probes WHERE at NOT IN (SELECT at FROM probes ORDER BY at DESC LIMIT ?)').run(keep);
}
