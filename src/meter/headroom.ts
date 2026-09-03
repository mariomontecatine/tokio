import type { Db } from '../db.ts';

const DAY = 24 * 3_600_000;

/** Below this there is not enough history to say anything worth saying. */
const MIN_TURNS = 8;

export interface Headroom {
  /** What one of your turns typically costs, and what an expensive one costs. */
  turnP50: number;
  turnP90: number;
  /** Prompts the remaining credits cover: `few` if they run expensive, `many` if typical. */
  few: number;
  many: number;
  /** Turns the figures are drawn from. */
  sample: number;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index]!;
}

/**
 * What is left, counted in prompts instead of dollars.
 *
 * "$72 left" is unreadable to someone on a subscription: nobody buys dollars,
 * so the figure gives no sense of whether that is a lot. The same headroom
 * expressed as "room for another 9 to 24 prompts like yours" answers the actual
 * question, and it does it from the user's own turns rather than a shipped
 * constant.
 *
 * It stays a range on purpose. One number would hide that a turn's cost varies
 * by an order of magnitude depending on what you ask for — the low end assumes
 * expensive turns, the high end typical ones.
 */
export function headroom(db: Db, remainingCredits: number, now = Date.now()): Headroom | null {
  const rows = db
    .prepare(
      `SELECT SUM(credits) AS credits FROM events
       WHERE ts >= ? AND turnId <> '' GROUP BY turnId`,
    )
    .all(now - 14 * DAY) as unknown as { credits: number }[];

  const costs = rows.map((r) => r.credits).filter((c) => c > 0).sort((a, b) => a - b);
  if (costs.length < MIN_TURNS) return null;

  const turnP50 = quantile(costs, 0.5);
  const turnP90 = quantile(costs, 0.9);
  if (turnP50 <= 0 || turnP90 <= 0) return null;

  const left = Math.max(0, remainingCredits);
  return {
    turnP50,
    turnP90,
    few: Math.floor(left / turnP90),
    many: Math.floor(left / turnP50),
    sample: costs.length,
  };
}
