import type { Estimate, Job } from '../types.ts';

export interface RunResult {
  ok: boolean;
  /** True when the run failed specifically because the plan's limit was reached. */
  rateLimited: boolean;
  /** USD-equivalent cost actually incurred, when the provider reports it. */
  credits: number | null;
  sessionId: string | null;
  output: string;
  error: string | null;
}

export interface RunContext {
  timeoutMs: number;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * A backend that can run a queued job.
 *
 * v1 ships only `claude-code`, which spends a subscription rather than money.
 * The interface exists so pay-per-token backends (Anthropic, OpenAI-compatible)
 * can be added without touching the queue or the scheduler.
 */
export interface Provider {
  id: string;
  label: string;
  /** Whether the provider can run right now, and why not if it can't. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  estimate(job: Job): Estimate | null;
  execute(job: Job, ctx: RunContext): Promise<RunResult>;
}
