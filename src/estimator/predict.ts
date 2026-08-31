import type { Db } from '../db.ts';
import type { Estimate, Safety } from '../types.ts';
import { familyOf } from '../meter/weights.ts';
import { dominantFamily } from '../models.ts';

export interface EstimateRequest {
  prompt: string;
  cwd: string;
  model: string | null;
  safety: Safety;
  resumeSessionId?: string | null;
}

/** Cold-start costs per turn, in USD-equivalent credits, when there is no history at all. */
const COLD_START: Record<string, { p50: number; p90: number }> = {
  opus: { p50: 2.5, p90: 12 },
  sonnet: { p50: 0.6, p90: 3 },
  haiku: { p50: 0.1, p90: 0.5 },
  unknown: { p50: 0.6, p90: 3 },
};

/** Plan mode reads and proposes but never edits or re-runs tests, so it lands well under a normal turn. */
const PLAN_MODE_FACTOR = 0.6;

const MIN_SAMPLE = 5;

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

export function bucketKey(project: string, family: string, safety: Safety, resume: boolean): string {
  return `${project}|${family}|${safety}|${resume ? 'resume' : 'fresh'}`;
}

interface Sample {
  credits: number[];
  chars: number[];
  basis: string;
}

/**
 * Find the most specific usable sample of past costs.
 *
 * Finished jobs are the best evidence because they were produced under the same
 * conditions we're predicting for. Failing that, the user's own transcript
 * history for the project is far better than any shipped constant — which is
 * why this is useful on the very first run, before any job has ever executed.
 */
function findSample(db: Db, req: EstimateRequest, family: string): Sample | null {
  const resume = Boolean(req.resumeSessionId);
  const observed = db
    .prepare('SELECT credits, promptChars FROM observations WHERE bucket = ? ORDER BY ts DESC LIMIT 40')
    .all(bucketKey(req.cwd, family, req.safety, resume)) as { credits: number; promptChars: number }[];
  if (observed.length >= 3) {
    return {
      credits: observed.map((o) => o.credits),
      chars: observed.map((o) => o.promptChars),
      basis: `${observed.length} previous job${observed.length === 1 ? '' : 's'} here`,
    };
  }

  const perTurn = (where: string, params: unknown[]): { credits: number; chars: number }[] =>
    db
      .prepare(
        `SELECT SUM(e.credits) AS credits, COALESCE(MAX(t.chars), 0) AS chars
         FROM events e LEFT JOIN turns t ON t.turnId = e.turnId
         WHERE e.turnId <> '' AND ${where}
         GROUP BY e.turnId ORDER BY MAX(e.ts) DESC LIMIT 200`,
      )
      .all(...(params as [])) as { credits: number; chars: number }[];

  const scoped = perTurn('e.project = ? AND e.family = ?', [req.cwd, family]);
  if (scoped.length >= MIN_SAMPLE) {
    return {
      credits: scoped.map((r) => r.credits),
      chars: scoped.map((r) => r.chars),
      basis: `${scoped.length} past turns in this project`,
    };
  }

  const global = perTurn('e.family = ?', [family]);
  if (global.length >= MIN_SAMPLE) {
    return {
      credits: global.map((r) => r.credits),
      chars: global.map((r) => r.chars),
      basis: `${global.length} past ${family} turns`,
    };
  }
  return null;
}

/**
 * Scale the estimate by how long the prompt is relative to past ones.
 *
 * Heavily damped on purpose: prompt length correlates with the size of the job
 * but very loosely — a one-line "now run the tests" can trigger a long agentic
 * run — so this nudges the number rather than driving it.
 */
function lengthFactor(promptChars: number, sampleChars: number[]): number {
  const known = sampleChars.filter((c) => c > 0).sort((a, b) => a - b);
  if (known.length < MIN_SAMPLE || promptChars <= 0) return 1;
  const median = quantile(known, 0.5);
  if (median <= 0) return 1;
  const raw = (promptChars / median) ** 0.25;
  return Math.min(2, Math.max(0.6, raw));
}

export function predict(db: Db, req: EstimateRequest): Estimate {
  // An unresolved model would be priced as the mid tier and matched against a
  // near-empty "unknown" sample, so borrow the family the user actually runs.
  const family = familyOf(req.model) === 'unknown' ? (dominantFamily(db) ?? 'unknown') : familyOf(req.model);
  const sample = findSample(db, req, family);

  let p50: number;
  let p90: number;
  let basis: string;

  if (sample) {
    const sorted = [...sample.credits].sort((a, b) => a - b);
    const factor = lengthFactor(req.prompt.length, sample.chars);
    p50 = quantile(sorted, 0.5) * factor;
    p90 = quantile(sorted, 0.9) * factor;
    basis = sample.basis;
  } else {
    const cold = COLD_START[family] ?? COLD_START.unknown!;
    p50 = cold.p50;
    p90 = cold.p90;
    basis = 'no history yet — shipped default';
  }

  // Job observations already encode the safety mode; transcript history doesn't.
  if (req.safety === 'plan' && !basis.startsWith('no history') && basis.includes('turns')) {
    p50 *= PLAN_MODE_FACTOR;
    p90 *= PLAN_MODE_FACTOR;
  }

  return { p50: Math.max(0.01, p50), p90: Math.max(0.02, Math.max(p50, p90)), basis };
}
