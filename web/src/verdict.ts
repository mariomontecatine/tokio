// Relative imports carry the .ts extension here, unlike the rest of web/src:
// this module is the one piece of the dashboard with arithmetic worth testing,
// and `npm test` runs it through Node's type stripping, which resolves nothing
// implicitly. Vite is happy either way.
import type { Status } from './api.ts';
import type { Translate } from './i18n.ts';
import { clock, pct, until } from './format.ts';

const HOUR = 3_600_000;

export type Pressure = 'ease' | 'tight' | 'over';

/** Green while there's room, amber when it's close, red once it won't fit. */
export function pressureOf(usedPct: number): Pressure {
  if (usedPct >= 90) return 'over';
  if (usedPct >= 65) return 'tight';
  return 'ease';
}

export interface Verdict {
  line: string;
  detail: string | null;
  pressure: Pressure;
  /** Where this pace lands by the reset, for the ring's second arc. */
  projectedPct: number | null;
}

/**
 * "9–24", "≤3" when even one expensive turn would not fit, or a single figure
 * when both ends agree.
 *
 * A range, not one number: a turn's cost varies by an order of magnitude with
 * what you ask for, and a single figure would hide that. The low end assumes
 * expensive turns, the high end typical ones.
 */
export function turnCount(few: number, many: number): string {
  if (few >= many) return String(many);
  if (few <= 0) return `≤${many}`;
  return `${few}–${many}`;
}

/**
 * Do I make it to the reset?
 *
 * The whole tool exists because that question used to be answerable only by
 * cross-reading a percentage, a burn rate and a clock. It is one sentence, and
 * it is the first thing on the page.
 */
export function readVerdict(status: Status, t: Translate): Verdict {
  const { block, burnRate, now, exhaustionAt } = status;
  const cap = block.cap.credits;

  // Spent is checked before anything else, because it is not a forecast.
  // Running out is no longer a future event, so `exhaustionAt` is null and the
  // pace branches below used to answer for it: a full window came out as
  // "It'll be close. At this pace you end the window at 133%", in amber, beside
  // a ring reading 100%. It is neither close nor a projection, and the only
  // thing left to say about the window is when it lifts.
  //
  // Two tests because the percentage is the authority and the credits only
  // restate it: with no cap to divide by, `remainingCredits` is zero for a
  // window that has barely started, which is why it is asked second and only
  // once a cap is known.
  if (block.usedPct >= 100 || (cap > 0 && block.remainingCredits <= 0)) {
    return {
      line: t('verdict.spent'),
      detail: t('verdict.spent.detail', { time: clock(block.resetsAt) }),
      pressure: 'over',
      projectedPct: null,
    };
  }

  if (burnRate <= 0 || cap <= 0) {
    // Idle: the useful thing is not how many dollars are left — nobody buys
    // dollars — but how much more work fits. Counted in your own prompts, with
    // the percentage as the fallback when there is too little history to say.
    const room = status.headroom;
    const line =
      room === null
        ? t('verdict.idle.pct', { pct: pct(100 - block.usedPct) })
        : room.many <= 0
          ? t('verdict.idle.none')
          : t('verdict.idle.turns', { count: turnCount(room.few, room.many) });
    return { line, detail: null, pressure: pressureOf(block.usedPct), projectedPct: null };
  }

  const hoursLeft = Math.max(0, (block.resetsAt - now) / HOUR);
  // The forecast starts from the percentage on screen, not from a second one
  // computed behind it. Reconstructing the base from local credits meant the
  // ring showed Anthropic's reported figure while the sentence under it
  // extrapolated from our estimate — two numbers that can sit tens of points
  // apart, presented as one story.
  const projectedPct = block.usedPct + ((burnRate * hoursLeft) / cap) * 100;

  if (exhaustionAt && exhaustionAt < block.resetsAt) {
    return {
      line: t('verdict.dry', { time: clock(exhaustionAt) }),
      detail: t('verdict.dry.detail', { until: until(block.resetsAt, exhaustionAt) }),
      pressure: 'over',
      projectedPct,
    };
  }
  if (projectedPct >= 65) {
    return {
      line: t('verdict.tight'),
      detail: t('verdict.tight.detail', { pct: pct(projectedPct) }),
      // A pace that ends past the cap is never amber, whatever route it took to
      // get here.
      pressure: projectedPct >= 100 ? 'over' : 'tight',
      projectedPct,
    };
  }
  return {
    line: t('verdict.clear'),
    detail: t('verdict.clear.detail', { pct: pct(projectedPct) }),
    pressure: 'ease',
    projectedPct,
  };
}
