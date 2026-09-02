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

export interface Status {
  now: number;
  plan: PlanId;
  /** Cumulative spend through the current 5h window, for the strip chart. */
  trace: { t: number; c: number }[];
  reservePct: number;
  block: WindowStatus;
  week: WindowStatus;
  weekOpus: WindowStatus | null;
  /** Credits per hour, exponentially weighted over recent activity. */
  burnRate: number;
  /** Epoch millis at which the block runs out at the current burn rate. */
  exhaustionAt: number | null;
  queued: number;
  /** State of the last read of Claude Code's own `/usage`. */
  probe: { at: number; ageMs: number; stale: boolean; error: string | null } | null;
}

export type PlanId = 'pro' | 'max5' | 'max20' | 'custom';

export type Safety = 'plan' | 'edits' | 'full';
export type RunPolicy = 'on-reset' | 'asap-if-headroom' | 'at' | 'manual';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'deferred' | 'cancelled';

export interface Job {
  id: string;
  provider: string;
  prompt: string;
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
