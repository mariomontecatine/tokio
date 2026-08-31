import type { Db } from '../db.ts';
import type { Job } from '../types.ts';
import { familyOf } from '../meter/weights.ts';
import { bucketKey } from './predict.ts';

/** Feed a finished job's real cost back into the sample the estimator draws from. */
export function recordOutcome(db: Db, job: Job, actualCredits: number): void {
  const bucket = bucketKey(job.cwd, familyOf(job.model), job.safety, Boolean(job.resumeSessionId));
  db.prepare('INSERT INTO observations (ts, bucket, credits, promptChars) VALUES (?,?,?,?)')
    .run(Date.now(), bucket, actualCredits, job.prompt.length);
}

export interface Accuracy {
  n: number;
  /** Median of actual/estimated. 1.0 means the p50 estimate is unbiased. */
  medianRatio: number;
  /** Share of jobs that came in under their p90 estimate. */
  withinP90: number;
}

export function accuracy(db: Db): Accuracy {
  const rows = db
    .prepare(
      `SELECT estimateP50, estimateP90, actualCredits FROM jobs
       WHERE status = 'done' AND actualCredits IS NOT NULL AND estimateP50 > 0`,
    )
    .all() as { estimateP50: number; estimateP90: number; actualCredits: number }[];
  if (!rows.length) return { n: 0, medianRatio: 1, withinP90: 1 };
  const ratios = rows.map((r) => r.actualCredits / r.estimateP50).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return {
    n: rows.length,
    medianRatio: ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2,
    withinP90: rows.filter((r) => r.actualCredits <= r.estimateP90).length / rows.length,
  };
}
