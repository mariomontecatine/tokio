import type { ModelFamily } from '../types.ts';

/**
 * USD per million tokens, by model family. Subscription plans don't bill in
 * dollars, but their limits scale with the cost of what you run, so pricing is
 * the only sane common unit: one "credit" here is one USD-equivalent of API
 * usage. That makes an Opus turn count roughly five times a Sonnet one, which
 * is what actually drains a plan.
 */
export const PRICES: Record<ModelFamily, {
  input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
}> = {
  opus:    { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  sonnet:  { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6,  cacheRead: 0.3 },
  haiku:   { input: 1,  output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2,  cacheRead: 0.1 },
  // Unknown models are priced as Sonnet: the mid tier keeps the error bounded
  // in both directions rather than wildly over- or under-counting.
  unknown: { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6,  cacheRead: 0.3 },
};

export function familyOf(model: string | undefined | null): ModelFamily {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export function creditsFor(t: TokenCounts, family: ModelFamily): number {
  const p = PRICES[family];
  return (
    t.inputTokens * p.input +
    t.outputTokens * p.output +
    t.cacheWrite5m * p.cacheWrite5m +
    t.cacheWrite1h * p.cacheWrite1h +
    t.cacheRead * p.cacheRead
  ) / 1_000_000;
}
