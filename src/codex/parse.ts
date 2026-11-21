/**
 * Reading Codex's rollouts.
 *
 * Codex writes one JSONL file per thread under `$CODEX_HOME/sessions/YYYY/MM/DD/`.
 * Five kinds of line matter here, and everything else — the conversation itself,
 * tool calls and their output, reasoning — is passed over unread:
 *
 *   - `token_usage_record`: one per model response, with its own `response_id`.
 *     This is the only thing counted. `usage` is that response alone; the
 *     `turn_token_usage` and `thread_token_usage` beside it are running totals
 *     and adding them up would count everything several times over.
 *   - `event_msg` / `token_count`: carries `rate_limits`, the percentages OpenAI
 *     reported with that response. A reading, as recent as the turn it came with.
 *   - `turn_context`: the model and directory of a turn. A usage record does not
 *     say which model produced it, so this is where the model comes from — by
 *     `turn_id`, because one thread can switch models halfway through.
 *   - `session_meta`: the thread's directory, for the project list.
 *   - `event_msg` / `thread_settings_applied`: the thread's settings, written
 *     before the turns they apply to. Only `service_tier` is read from it: a
 *     response is priced only when it ran at Standard, so the tier in force at
 *     its line goes with it.
 *
 * Only the top-level `type` counts. A `compacted` line embeds a copy of the last
 * usage record, and reading it as one would count that response twice — which
 * the `response_id` key would catch, but there is no reason to lean on it.
 *
 * OpenAI's usage semantics, which decide the arithmetic: `input_tokens` includes
 * `cached_input_tokens`, and `output_tokens` includes `reasoning_output_tokens`.
 * The total is input plus output. They are stored as reported.
 */

export interface CodexUsage {
  responseId: string;
  ts: number;
  threadId: string;
  turnId: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/**
 * One reading of the Codex limits, from either place it can come from.
 *
 * Rollouts write it in snake_case and the app server answers in camelCase; both
 * end up here, with `via` saying which. Windows are told apart by their length
 * rather than by being "primary" or "secondary", since nothing promises the
 * order — the five-hour one is `session`, the seven-day one `week`.
 */
export interface CodexReading {
  at: number;
  via: 'app-server' | 'rollout';
  limitId: string;
  sessionPct: number | null;
  sessionResetsAt: number | null;
  sessionMinutes: number | null;
  weekPct: number | null;
  weekResetsAt: number | null;
  weekMinutes: number | null;
  /** As OpenAI names it: `plus`, `pro`, `team`… Null when not reported. */
  planType: string | null;
  /** Set when OpenAI says a limit has been reached, and which. */
  limitReached: string | null;
  /** Null when the read worked. */
  error: string | null;
}

export type CodexEntry =
  | { kind: 'usage'; usage: CodexUsage }
  | { kind: 'limits'; reading: CodexReading }
  | { kind: 'context'; turnId: string; model: string | null; cwd: string | null }
  | { kind: 'meta'; threadId: string; cwd: string | null; ts: number | null; subagent: boolean }
  /** The service tier the thread's settings name from here on; null when they name none. */
  | { kind: 'settings'; serviceTier: string | null }
  | null;

/**
 * How much of a line to look at before deciding to parse it.
 *
 * Tool output can put ten megabytes on one line, and parsing it to find out it
 * is not wanted is the whole cost of a scan. The `type` sits within the first
 * hundred-odd characters of every line Codex writes.
 */
const HEAD = 400;
const WANTED = /"type"\s*:\s*"(?:token_usage_record|turn_context|session_meta|token_count|thread_settings_applied)"/;
const EVENT = /"type"\s*:\s*"event_msg"/;
const PAYLOAD_TYPE = /"payload"\s*:\s*\{\s*"type"\s*:\s*"[^"]+"/;

export function worthParsing(line: string): boolean {
  const head = line.slice(0, HEAD);
  // Some writers place token_count after the (potentially long) usage totals.
  return WANTED.test(head) || (EVENT.test(head) && !PAYLOAD_TYPE.test(head));
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A window as either source spells it, normalised to milliseconds. */
interface RawWindow {
  pct: number | null;
  minutes: number | null;
  resetsAt: number | null;
}

function readWindow(w: any, at: number): RawWindow | null {
  if (!w || typeof w !== 'object') return null;
  const pct = numOrNull(w.used_percent ?? w.usedPercent);
  const minutes = numOrNull(w.window_minutes ?? w.windowDurationMins);
  const resetsAtSec = numOrNull(w.resets_at ?? w.resetsAt);
  // Older releases said how long until the reset rather than when.
  const resetsIn = numOrNull(w.resets_in_seconds);
  const resetsAt = resetsAtSec !== null ? resetsAtSec * 1000 : resetsIn !== null ? at + resetsIn * 1000 : null;
  if (pct === null && resetsAt === null) return null;
  return { pct, minutes, resetsAt };
}

/** A day or less is the short window; anything longer is the weekly one. */
const SHORT_WINDOW_MAX_MIN = 24 * 60;

/**
 * Turn a `rate_limits` / `rateLimits` snapshot into a reading.
 *
 * Exported because the app server returns the same object, camel-cased.
 */
export function readingFromSnapshot(snapshot: any, at: number, via: CodexReading['via']): CodexReading | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const first = readWindow(snapshot.primary, at);
  const second = readWindow(snapshot.secondary, at);
  let session: RawWindow | null = null;
  let week: RawWindow | null = null;
  // By length when it is stated, and by position only when it is not: the
  // order is Codex's convention, the length is the fact.
  for (const [w, position] of [[first, 'short'], [second, 'long']] as const) {
    if (!w) continue;
    const short = w.minutes !== null ? w.minutes <= SHORT_WINDOW_MAX_MIN : position === 'short';
    if (short && !session) session = w;
    else if (!short && !week) week = w;
  }
  if (!session && !week) return null;
  return {
    at,
    via,
    limitId: str(snapshot.limit_id ?? snapshot.limitId) ?? '',
    sessionPct: session?.pct ?? null,
    sessionResetsAt: session?.resetsAt ?? null,
    sessionMinutes: session?.minutes ?? null,
    weekPct: week?.pct ?? null,
    weekResetsAt: week?.resetsAt ?? null,
    weekMinutes: week?.minutes ?? null,
    planType: str(snapshot.plan_type ?? snapshot.planType),
    limitReached: str(snapshot.rate_limit_reached_type ?? snapshot.rateLimitReachedType),
    error: null,
  };
}

/** Parse one rollout line. Anything not wanted, or not well formed, is null. */
export function parseCodexLine(line: string): CodexEntry {
  if (!worthParsing(line)) return null;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const p = entry?.payload;
  if (!p || typeof p !== 'object') return null;

  switch (entry.type) {
    case 'token_usage_record': {
      const id = str(p.response_id);
      const u = p.usage;
      if (!Number.isFinite(ts) || !id || !u || typeof u !== 'object') return null;
      return {
        kind: 'usage',
        usage: {
          responseId: id,
          ts,
          threadId: str(p.thread_id) ?? str(p.session_id) ?? '',
          turnId: str(p.turn_id) ?? '',
          inputTokens: num(u.input_tokens),
          cachedInputTokens: num(u.cached_input_tokens),
          cacheWriteInputTokens: num(u.cache_write_input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningOutputTokens: num(u.reasoning_output_tokens),
        },
      };
    }
    case 'event_msg': {
      // Not a measurement of anything, so it needs no time of its own: what
      // matters is which records follow it in the file.
      if (p.type === 'thread_settings_applied') {
        const s = p.thread_settings;
        return { kind: 'settings', serviceTier: s && typeof s === 'object' ? str(s.service_tier) : null };
      }
      if (!Number.isFinite(ts) || p.type !== 'token_count' || !p.rate_limits) return null;
      const reading = readingFromSnapshot(p.rate_limits, ts, 'rollout');
      return reading ? { kind: 'limits', reading } : null;
    }
    case 'turn_context': {
      const turnId = str(p.turn_id);
      if (!turnId) return null;
      return { kind: 'context', turnId, model: str(p.model), cwd: str(p.cwd) };
    }
    case 'session_meta': {
      const threadId = str(p.id) ?? str(p.session_id);
      if (!threadId) return null;
      const started = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
      // A thread another thread spawned. Its usage counts like any other; it is
      // just not something a person would pick to continue.
      const subagent = typeof p.source === 'object' && p.source !== null && 'subagent' in p.source;
      return { kind: 'meta', threadId, cwd: str(p.cwd), ts: Number.isFinite(started) ? started : Number.isFinite(ts) ? ts : null, subagent };
    }
    default:
      return null;
  }
}
