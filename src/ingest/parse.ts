import type { UsageEvent } from '../types.ts';
import { creditsFor, familyOf } from '../meter/weights.ts';

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** Server-side tools are billed per request, not per token. */
  server_tool_use?: { web_search_requests?: number };
  /** "fast" costs more than "standard" on the models that offer it. */
  speed?: string | null;
  /** "us" carries a 10% surcharge. */
  inference_geo?: string | null;
}

export type ParsedEntry =
  | { kind: 'usage'; event: Omit<UsageEvent, 'turnId'> }
  | { kind: 'turn'; promptId: string; chars: number; ts: number }
  | { kind: 'session-cost'; sessionId: string; usd: number }
  | null;

/** A user entry that is a real prompt, not the transcript's record of a tool result. */
function isUserPrompt(entry: any): boolean {
  if (entry?.type !== 'user' || !entry.promptId) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.some((part: any) => part?.type !== 'tool_result');
}

function promptChars(entry: any): number {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n: number, p: any) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0);
}

/**
 * Turn one transcript line into either a usage event or a marker for the start
 * of a new user turn.
 *
 * Claude Code appends the *same* assistant response to the transcript several
 * times as it streams (identical `requestId` and `usage` on every copy), so the
 * caller must deduplicate on `messageId` + `requestId`. The events table's
 * primary key does that; counting raw lines inflates usage roughly threefold.
 */
export function parseEntry(line: string, fallbackProject: string): ParsedEntry {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  // Claude Code's own running total for the session, which it writes to the
  // transcript itself. It is the one figure here that we did not compute, so it
  // is worth keeping purely to check our arithmetic against — see meter/value.ts.
  // Sessions it could not price are skipped rather than compared against.
  if (entry?.type === 'cost-state') {
    const usd = entry.totalCostUSD;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
    if (entry.hasUnknownModelCost) return null;
    if (!entry.sessionId) return null;
    return { kind: 'session-cost', sessionId: String(entry.sessionId), usd };
  }

  if (isUserPrompt(entry)) {
    const at = Date.parse(entry.timestamp ?? '');
    return {
      kind: 'turn',
      promptId: String(entry.promptId),
      chars: promptChars(entry),
      ts: Number.isFinite(at) ? at : Date.now(),
    };
  }
  if (entry?.type !== 'assistant') return null;

  const message = entry.message;
  const usage: RawUsage | undefined = message?.usage;
  if (!usage || !message?.id) return null;

  const cacheCreation = usage.cache_creation ?? {};
  const w5 = cacheCreation.ephemeral_5m_input_tokens ?? 0;
  const w1h = cacheCreation.ephemeral_1h_input_tokens ?? 0;
  // The aggregate is authoritative — the per-tier breakdown is absent in older
  // transcripts and can undercount in newer ones — so take the 1h tier from the
  // breakdown and leave the remainder on the cheaper 5m tier, as Claude Code does.
  const total = usage.cache_creation_input_tokens ?? w5 + w1h;
  const cacheWrite1h = Math.min(w1h, total);

  const counts = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWrite5m: total - cacheWrite1h,
    cacheWrite1h,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
  const model = String(message.model ?? 'unknown');
  const family = familyOf(model);
  const speed = typeof usage.speed === 'string' ? usage.speed : 'standard';
  const inferenceGeo = typeof usage.inference_geo === 'string' ? usage.inference_geo : '';
  const ts = Date.parse(entry.timestamp ?? '');

  return {
    kind: 'usage',
    event: {
      messageId: String(message.id),
      requestId: String(entry.requestId ?? message.id),
      ts: Number.isFinite(ts) ? ts : Date.now(),
      model,
      family,
      ...counts,
      speed,
      inferenceGeo,
      // Priced off the model id, not the family: Opus 4.1 costs three times
      // Opus 4.5 and everything since.
      credits: creditsFor(counts, model, { speed, inferenceGeo }),
      sessionId: String(entry.sessionId ?? ''),
      project: String(entry.cwd || fallbackProject),
      source: 'transcript',
    },
  };
}
