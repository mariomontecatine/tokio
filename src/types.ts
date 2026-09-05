/** Shared domain types for tokio. */

/** A single billable assistant response, extracted from a Claude Code transcript. */
export interface UsageEvent {
  /** `message.id` — stable per assistant response. */
  messageId: string;
  /** `requestId` — the same response is written to the transcript several times. */
  requestId: string;
  /** Epoch millis. */
  ts: number;
  model: string;
  /** Coarse family used for pricing: opus | sonnet | haiku | unknown. */
  family: ModelFamily;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Server-side web searches, billed per request. */
  webSearches: number;
  /** `standard` or `fast`; fast mode is the same model at premium rates. */
  speed: string;
  /** Where inference ran. "us" carries a surcharge; empty when unreported. */
  inferenceGeo: string;
  /** USD-equivalent cost of this response. See meter/weights.ts. */
  credits: number;
  sessionId: string;
  /** Absolute path of the project the session ran in. */
  project: string;
  /** Groups every API call triggered by one user prompt. Empty when unknown. */
  turnId: string;
  source: 'transcript' | 'job';
}

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'unknown';

/** A rolling usage window (either the 5-hour block or the weekly window). */
export interface Window {
  start: number;
  end: number;
  credits: number;
  /** Credits spent on Opus only — tracked separately because of the weekly Opus cap. */
  opusCredits: number;
  events: number;
  lastActivity: number | null;
  active: boolean;
}

export interface Cap {
  credits: number;
  /** Where the number came from, so the UI never presents a guess as fact. */
  basis: 'default' | 'calibrated' | 'reported';
  /** Number of calibration anchors backing a `calibrated` cap. */
  anchors?: number;
}

export interface WindowStatus {
  window: Window;
  cap: Cap;
  usedPct: number;
  remainingCredits: number;
  /** When the window frees up. For a rolling window this is when its oldest usage ages out. */
  resetsAt: number;
  /** True when there is no fixed reset anchor, so `resetsAt` is a partial release, not a full reset. */
  rolling: boolean;
  /** 'reported' means Anthropic told us; 'estimated' means we reconstructed it. */
  source: 'reported' | 'estimated';
}

/**
 * One sample of how far through the window spend had got.
 *
 * A percentage, not a dollar figure, because the strip is a picture of the
 * window and the window is measured in percent by the only party that knows —
 * and because a percentage is the one thing both sources can express. Spend
 * made on another machine, or in the browser, never reaches this machine's
 * transcripts; Anthropic's reading covers it.
 */
export interface TracePoint {
  t: number;
  pct: number;
}

export interface Status {
  now: number;
  plan: PlanId;
  /** Whether that plan was detected, set by hand, or could not be determined. */
  planBasis: 'detected' | 'configured' | 'unknown';
  /** How far through the window spend had got, sampled across it, for the strip chart. */
  trace: TracePoint[];
  /**
   * Where the strip's shape came from, drawn the same way `WindowStatus.source`
   * draws it: 'reported' is Anthropic's own percentage sampled over the window,
   * 'estimated' is this machine's transcripts against a cap.
   */
  traceSource: 'reported' | 'estimated';
  reservePct: number;
  block: WindowStatus;
  week: WindowStatus;
  weekOpus: WindowStatus | null;
  /** Credits per hour, exponentially weighted over recent activity. */
  burnRate: number;
  /** Epoch millis at which the block runs out at the current burn rate. */
  exhaustionAt: number | null;
  queued: number;
  /** What's left, counted in prompts rather than dollars. Null without enough history. */
  headroom: { turnP50: number; turnP90: number; few: number; many: number; sample: number } | null;
  /** State of the last read of Claude Code's own `/usage`. */
  probe: { at: number; ageMs: number; stale: boolean; error: string | null } | null;
}

export type PlanId = 'pro' | 'max5' | 'max20' | 'custom';

/** What the config may hold. 'auto' means "read it off the Claude account". */
export type PlanSetting = PlanId | 'auto';

export type Safety = 'plan' | 'edits' | 'full';
export type RunPolicy = 'on-reset' | 'asap-if-headroom' | 'at' | 'manual';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'deferred' | 'cancelled';

export interface Job {
  id: string;
  provider: string;
  prompt: string;
  /**
   * The stretches of `prompt` that were pasted in rather than typed.
   *
   * Only ever presentation: what runs is `prompt`, whole. This is what lets the
   * editor fold a two-hundred-line stack trace back down to one line instead of
   * making someone scroll past it to reach the sentence they came to change.
   * Null when nothing was pasted, or when the job came from somewhere that does
   * not track it.
   */
  promptBlocks: string[] | null;
  cwd: string;
  model: string | null;
  safety: Safety;
  /** Resume an existing Claude Code session instead of starting a fresh one. */
  resumeSessionId: string | null;
  runPolicy: RunPolicy;
  /** Epoch millis, only meaningful when runPolicy === 'at'. */
  runAt: number | null;
  priority: number;
  /** Ignore the reserve floor. */
  urgent: boolean;
  status: JobStatus;
  estimateP50: number | null;
  estimateP90: number | null;
  estimateBasis: string | null;
  actualCredits: number | null;
  resultSessionId: string | null;
  output: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Estimate {
  p50: number;
  p90: number;
  basis: string;
}
