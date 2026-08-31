import type { UsageEvent } from '../types.ts';
import { creditsFor, familyOf } from '../meter/weights.ts';

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export type ParsedEntry =
  | { kind: 'usage'; event: Omit<UsageEvent, 'turnId'> }
  | { kind: 'turn'; promptId: string; chars: number; ts: number }
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
  // Older transcripts only have the aggregate; attribute it to the 5m tier.
  const total = usage.cache_creation_input_tokens ?? 0;
  const cacheWrite5m = w5 + w1h > 0 ? w5 : total;

  const counts = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWrite5m,
    cacheWrite1h: w1h,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
  const family = familyOf(message.model);
  const ts = Date.parse(entry.timestamp ?? '');

  return {
    kind: 'usage',
    event: {
      messageId: String(message.id),
      requestId: String(entry.requestId ?? message.id),
      ts: Number.isFinite(ts) ? ts : Date.now(),
      model: String(message.model ?? 'unknown'),
      family,
      ...counts,
      credits: creditsFor(counts, family),
      sessionId: String(entry.sessionId ?? ''),
      project: String(entry.cwd || fallbackProject),
      source: 'transcript',
    },
  };
}
