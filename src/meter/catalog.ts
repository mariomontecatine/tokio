/**
 * List prices per model, in USD per million tokens.
 *
 * These are not invented. Claude Code ships a hand-maintained model catalog —
 * the same one behind `/cost` and the per-Mtok labels in `/model` — and this
 * file mirrors it: the same tiers, the same model-to-tier mapping, the same
 * surcharges. Matching it is the point: it makes tokio's dollar figures agree
 * with Claude Code's own, rather than being a second opinion.
 *
 * Two things follow from that, and both matter for honesty:
 *
 *   - Pricing is per *model*, not per family. Opus 4.1 costs three times Opus
 *     4.5 and everything after it; Sonnet 5 is a third cheaper than Sonnet 4.6.
 *     Charging a family-wide rate silently misprices most transcripts.
 *   - A subscription is not billed in dollars at all. Every figure here answers
 *     "what would this have cost on the API at list price", which is a
 *     counterfactual, not a receipt. See README.
 *
 * When Anthropic ships a new model, add one row to MODEL_TIER. Until then an
 * unknown model falls back to its family's newest tier (see FAMILY_FALLBACK),
 * which keeps the error small and in a known direction.
 */
import type { ModelFamily } from '../types.ts';

export interface Rates {
  /** USD per million input tokens. */
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** USD per server-side web search request. */
  webSearch: number;
}

const tier = (
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
): Rates => ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead, webSearch: 0.01 });

export const TIERS = {
  tier_2_10: tier(2, 10, 2.5, 4, 0.2),
  tier_3_15: tier(3, 15, 3.75, 6, 0.3),
  tier_5_25: tier(5, 25, 6.25, 10, 0.5),
  tier_10_50: tier(10, 50, 12.5, 20, 1),
  tier_10_50_cache_read_0_25: tier(10, 50, 12.5, 20, 0.25),
  tier_15_75: tier(15, 75, 18.75, 30, 1.5),
  haiku_35: tier(0.8, 4, 1, 1.6, 0.08),
  haiku_45: tier(1, 5, 1.25, 2, 0.1),
} satisfies Record<string, Rates>;

export type TierName = keyof typeof TIERS;

/** Normalised model id -> tier. */
export const MODEL_TIER: Record<string, TierName> = {
  'claude-3-5-haiku': 'haiku_35',
  'claude-haiku-4-5': 'haiku_45',
  'claude-3-5-sonnet': 'tier_3_15',
  'claude-3-7-sonnet': 'tier_3_15',
  'claude-sonnet-4-0': 'tier_3_15',
  'claude-sonnet-4-5': 'tier_3_15',
  'claude-sonnet-4-6': 'tier_3_15',
  'claude-sonnet-5': 'tier_2_10',
  'claude-opus-4-0': 'tier_15_75',
  'claude-opus-4-1': 'tier_15_75',
  'claude-opus-4-5': 'tier_5_25',
  'claude-opus-4-6': 'tier_5_25',
  'claude-opus-4-7': 'tier_5_25',
  'claude-opus-4-8': 'tier_5_25',
  'claude-opus-5': 'tier_5_25',
  'claude-fable-5': 'tier_10_50',
  'claude-fable-5-1': 'tier_10_50_cache_read_0_25',
  'claude-mythos-5': 'tier_10_50',
  'claude-mythos-5-1': 'tier_10_50_cache_read_0_25',
};

/** Fast mode on Opus 4.6/4.7 predates the current rates and is priced apart. */
const OPUS_46_47_FAST: Rates = tier(30, 150, 37.5, 60, 3);

/**
 * Fast mode is the same model served faster, at its own premium rates, so it
 * cannot be read off the model id alone — the transcript's `speed` field
 * decides. Only these models offer it; anything else ignores the flag.
 */
export function fastModeRates(normalizedId: string): Rates | null {
  if (normalizedId === 'claude-opus-4-8' || normalizedId === 'claude-opus-5') return TIERS.tier_10_50;
  if (normalizedId === 'claude-opus-4-6' || normalizedId === 'claude-opus-4-7') return OPUS_46_47_FAST;
  return null;
}

/**
 * What an unrecognised model costs.
 *
 * A model we've never heard of is newer than this file, so its family's newest
 * tier is the closest honest guess. An unrecognised *family* gets the middle
 * tier, which bounds the error in both directions instead of wildly over- or
 * under-counting.
 */
export const FAMILY_FALLBACK: Record<ModelFamily, TierName> = {
  opus: 'tier_5_25',
  sonnet: 'tier_2_10',
  haiku: 'haiku_45',
  unknown: 'tier_3_15',
};

/** Serving inference in the US costs 10% more. Reported as `inference_geo`. */
export const US_INFERENCE_SURCHARGE = 1.1;

/**
 * Strip a model id down to the key this catalog uses.
 *
 * Transcripts carry whatever the provider called the model: a dated snapshot
 * (`claude-opus-4-5-20251101`), a Bedrock id (`us.anthropic.claude-…-v1:0`), a
 * Vertex id (`claude-opus-4-5@20251101`), or a `[1m]` long-context suffix. They
 * are all the same model at the same price.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/\[[12]m\]$/, '');
  id = id.replace(/^(?:us|eu|apac|global)\./, '');
  id = id.replace(/^anthropic\./, '');
  id = id.replace(/-v\d+:\d+$/, '');
  id = id.replace(/@\d{8}$/, '');
  id = id.replace(/-\d{8}$/, '');
  return id;
}
