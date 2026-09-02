import type { ModelFamily } from '../types.ts';
import {
  FAMILY_FALLBACK,
  MODEL_TIER,
  TIERS,
  US_INFERENCE_SURCHARGE,
  fastModeRates,
  normalizeModelId,
  type Rates,
} from './catalog.ts';

export type { Rates } from './catalog.ts';
export { TIERS, normalizeModelId, US_INFERENCE_SURCHARGE } from './catalog.ts';

/**
 * One "credit" is one USD-equivalent of API usage at list price.
 *
 * Subscription plans don't bill in dollars, but their limits scale with the
 * cost of what you run, so pricing is the only sane common unit: it makes an
 * Opus turn count five times a Sonnet one, which is what actually drains a
 * plan. The rates themselves live in catalog.ts and mirror Claude Code's.
 */

export function familyOf(model: string | undefined | null): ModelFamily {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

/** How a set of rates was arrived at, so callers can tell a match from a guess. */
export type RateBasis = 'model' | 'fast-mode' | 'family';

export interface ResolvedRates {
  rates: Rates;
  basis: RateBasis;
}

/**
 * The list rates for a model.
 *
 * `model` may be a full id from a transcript, a provider-flavoured id, or a
 * bare family name ("opus"), which resolves to that family's newest tier.
 */
export function resolveRates(model: string | undefined | null, speed?: string | null): ResolvedRates {
  const id = normalizeModelId(model ?? '');

  if (speed === 'fast') {
    const fast = fastModeRates(id);
    if (fast) return { rates: fast, basis: 'fast-mode' };
  }

  const tier = MODEL_TIER[id];
  if (tier) return { rates: TIERS[tier], basis: 'model' };

  return { rates: TIERS[FAMILY_FALLBACK[familyOf(model)]], basis: 'family' };
}

export function ratesFor(model: string | undefined | null, speed?: string | null): Rates {
  return resolveRates(model, speed).rates;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Server-side web searches, billed per request rather than per token. */
  webSearches?: number;
}

export interface BillingContext {
  /** `standard` or `fast`, from the transcript's `usage.speed`. */
  speed?: string | null;
  /** `usage.inference_geo`; "us" carries a surcharge. */
  inferenceGeo?: string | null;
}

/**
 * What one assistant response would have cost on the API.
 *
 * Mirrors Claude Code's own arithmetic, including the two parts that are easy
 * to miss: the US inference surcharge multiplies the token cost but not the
 * per-request web-search charge, and cache writes are split across their 5m and
 * 1h tiers, which are priced differently.
 */
export function creditsFor(t: TokenCounts, model: string | ModelFamily, billing: BillingContext = {}): number {
  const p = ratesFor(model, billing.speed);

  const tokens =
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead) /
    1_000_000;

  const multiplier = billing.inferenceGeo === 'us' ? US_INFERENCE_SURCHARGE : 1;
  return tokens * multiplier + (t.webSearches ?? 0) * p.webSearch;
}
