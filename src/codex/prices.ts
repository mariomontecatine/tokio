import { createHash } from 'node:crypto';

/**
 * OpenAI API list prices, for pricing what Codex ran.
 *
 * Codex carries no price table of its own — nothing like the catalog behind
 * Claude Code's `/cost` — so there is nothing to mirror. What there is instead
 * is the price OpenAI publishes on each model's page of its API docs. A row
 * here is a copy of that page, with the page it came from and the day it was
 * read, and nothing else: a model with no row has no price, and a response on
 * it has no dollar figure. Its tokens are still counted and shown.
 *
 * The rows are copied by hand and never update themselves: tokio does not
 * fetch them. A new model, or a new price, is a new row here.
 *
 * What a figure means is what the same responses would have cost at the API's
 * Standard rates — not what a ChatGPT subscription charges. Copying the page
 * rather than the bill has three consequences:
 *
 *   - **The long-context surcharge applies.** Every page below charges a request
 *     with more than 272K input tokens twice the input and cache rates and 1.5
 *     times the output, for the whole request. The GPT-6.1 Sol page adds that
 *     usage drawn from a subscription pays no such surcharge; the API would,
 *     and the API is what this prices.
 *   - **Only Standard is priced.** Codex records each thread's service tier
 *     (`thread_settings_applied`), and the pages price Fast, Flex, Batch and
 *     Ultrafast as multiples of Standard. But `default` is the only tier that
 *     has been seen written, and guessing which label another tier gets would
 *     be guessing which multiple to apply. So a response under any other tier,
 *     or with none recorded, gets no price.
 *   - **A priced figure is a floor.** Web search calls cost a fee per call, cache
 *     writes cost 1.25 times the input rate (30-minute retention) or 2.5 times
 *     (12-hour), and regional processing adds 10%. None of those is priced:
 *     tool calls not at all, cache writes as plain input, and the endpoint is not
 *     recorded. Each can only make the real list price higher, never lower.
 *
 * `from` is the first moment a row applies. None of these pages says when its
 * price took effect, so a model's first row has none: `null`, meaning every
 * response on that model until a later row, rather than an invented date. A
 * launch date is not a price date, and the day the page was read would claim
 * the price began that day and leave everything before it unpriced. What can be
 * said is when the page was read, and `readOn` says it.
 *
 * That choice has a cost, and it is stated rather than hidden: an older
 * response is priced at what the page said on the day it was read. Had a price
 * been lower before then, with no row to say so, that response's figure would
 * be high rather than a floor. A model's price rarely rises once published, and
 * when OpenAI announces a change, its date goes in a new row.
 *
 * Two kinds of change follow, and they are handled apart:
 *
 *   - **OpenAI changes a price.** Add a row with the date of the change as
 *     `from`, and leave the old one where it is. Responses before that date keep
 *     the price they ran at; only later ones get the new one.
 *   - **A row was copied wrong.** Fix the row. A typo is not a price anyone paid.
 *
 * Either edit is enough on its own. `pricingKey` folds the rows into the stamp
 * that decides when stored responses are priced again, so the next start
 * re-prices every one, each at the row in force on its own date — which is why
 * a price change leaves earlier history alone and a correction reaches all of
 * it. `OPENAI_PRICING_VERSION` is for the arithmetic in `codexCredits`, which
 * the rows cannot show. It is Codex's own on purpose: Claude's
 * `PRICING_VERSION` also clears its calibration anchors when it moves, and
 * nothing here has business touching those.
 */

export interface OpenAIRates {
  /** USD per million input tokens that were not served from cache. */
  input: number;
  /** USD per million input tokens served from cache. */
  cachedInput: number;
  /** USD per million output tokens. Reasoning tokens are billed as output. */
  output: number;
}

export interface PriceRow {
  /** The model slug exactly as Codex writes it in a rollout's `turn_context`. */
  model: string;
  /**
   * First moment this price applies, as an ISO date or timestamp (UTC). Null on
   * a model's first row when the page states no date: it then covers every
   * response before the model's next row. At most one per model.
   */
  from: string | null;
  rates: OpenAIRates;
  /**
   * Some models charge the whole request at a higher rate past a prompt size.
   * Absent when the page lists no such rule.
   */
  longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
  /** The page the numbers were copied from. */
  source: string;
  /** When that page was read, ISO date. */
  readOn: string;
}

/**
 * Bump when `codexCredits` changes how it prices. Edits to the rows need no
 * bump; see the comment above.
 */
export const OPENAI_PRICING_VERSION = '1';

/** The service tier Codex writes for Standard processing, and the only one priced. */
export const STANDARD_TIER = 'default';

/** As every page below states it, in the same words or near enough. */
const OVER_272K = { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 };

/**
 * Standard tier, USD per million tokens, each read on the model's own page. A
 * model Codex offers that is not here — a newer one, say — is counted in tokens
 * until its row is added.
 */
export const OPENAI_PRICES: PriceRow[] = [
  {
    model: 'gpt-6.2-astra',
    from: null,
    rates: { input: 8, cachedInput: 0.4, output: 40 },
    longContext: OVER_272K,
    source: 'https://developers.openai.com/api/docs/models/gpt-6.2-astra',
    readOn: '2026-11-21',
  },
  {
    model: 'gpt-6.1-sol',
    from: null,
    rates: { input: 2, cachedInput: 0.1, output: 10 },
    longContext: OVER_272K,
    source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    readOn: '2026-11-21',
  },
  {
    model: 'gpt-6.1-terra',
    from: null,
    rates: { input: 1, cachedInput: 0.05, output: 5 },
    longContext: OVER_272K,
    source: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra',
    readOn: '2026-11-21',
  },
  {
    model: 'gpt-6-astra',
    from: null,
    rates: { input: 10, cachedInput: 1, output: 50 },
    longContext: OVER_272K,
    source: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    readOn: '2026-11-21',
  },
  {
    model: 'gpt-6-sol',
    from: null,
    rates: { input: 2, cachedInput: 0.2, output: 10 },
    longContext: OVER_272K,
    source: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
    readOn: '2026-11-21',
  },
];

export interface CodexTokens {
  /** As reported: includes the cached tokens. */
  inputTokens: number;
  cachedInputTokens: number;
  /** As reported: includes the reasoning tokens. */
  outputTokens: number;
}

/** The row in force for a model at an instant, or null when there is none. */
export function priceRowAt(model: string, ts: number, table: readonly PriceRow[] = OPENAI_PRICES): PriceRow | null {
  const slug = model.trim().toLowerCase();
  let best: PriceRow | null = null;
  let bestFrom = -Infinity;
  for (const row of table) {
    if (row.model.toLowerCase() !== slug) continue;
    // An open start sorts before every dated row, so any of them supersedes it.
    const from = row.from === null ? -Infinity : Date.parse(row.from);
    if (Number.isNaN(from) || from > ts) continue;
    if (best === null || from > bestFrom) {
      best = row;
      bestFrom = from;
    }
  }
  return best;
}

/**
 * What one Codex response would have cost on OpenAI's API, or null.
 *
 * Null is an answer, not a zero: it means no published Standard price was in
 * force for that model on that day, or the response did not run at Standard. A
 * total that quietly counted it as free would be the plausible-looking wrong
 * number this project exists not to show.
 */
export function codexCredits(
  t: CodexTokens,
  model: string,
  ts: number,
  tier: string | null,
  table: readonly PriceRow[] = OPENAI_PRICES,
): number | null {
  if (tier !== STANDARD_TIER) return null;
  const row = priceRowAt(model, ts, table);
  if (!row) return null;
  const cached = Math.min(Math.max(0, t.cachedInputTokens), Math.max(0, t.inputTokens));
  const fresh = Math.max(0, t.inputTokens - cached);
  let inMul = 1;
  let outMul = 1;
  if (row.longContext && t.inputTokens > row.longContext.aboveInputTokens) {
    inMul = row.longContext.inputMultiplier;
    outMul = row.longContext.outputMultiplier;
  }
  const usd =
    ((fresh * row.rates.input + cached * row.rates.cachedInput) * inMul + Math.max(0, t.outputTokens) * row.rates.output * outMul) /
    1_000_000;
  return usd;
}

/** Whether the shipped table prices anything at all, so the interface can say so. */
export function hasPrices(table: readonly PriceRow[] = OPENAI_PRICES): boolean {
  return table.length > 0;
}

/** The most recent day a page behind the table was read, for the interface to show. */
export function pricesReadOn(table: readonly PriceRow[] = OPENAI_PRICES): string | null {
  let latest: string | null = null;
  for (const row of table) if (latest === null || row.readOn > latest) latest = row.readOn;
  return latest;
}

/**
 * What stored prices were worked out against: the arithmetic's version and
 * the rows themselves. When it differs from the stamp in the database, every
 * stored response is priced again. Where each row came from and when it was
 * read do not change a price, so they are left out.
 */
export function pricingKey(table: readonly PriceRow[] = OPENAI_PRICES): string {
  const rows = table.map((r) => [r.model, r.from, r.rates.input, r.rates.cachedInput, r.rates.output, r.longContext ?? null]);
  return `${OPENAI_PRICING_VERSION}:${createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)}`;
}
