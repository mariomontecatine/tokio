import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import type { Job, Status } from '../types.ts';
import type { Provider } from '../providers/types.ts';
import { computeStatus } from '../meter/index.ts';
import { listJobs, pendingJobs, requeueOrphans, updateJob } from './store.ts';
import { predict } from '../estimator/predict.ts';
import { recordOutcome } from '../estimator/learn.ts';
import { addCeiling } from '../plans/calibrate.ts';
import { notify } from '../notify/index.ts';

const MAX_ATTEMPTS = 5;
const OUTPUT_LIMIT = 40_000;

export interface Decision {
  job: Job;
  run: boolean;
  reason: string;
}

/** When the job's own policy says it may start, ignoring quota. */
function policyAllows(job: Job, status: Status, now: number): { ok: boolean; reason: string } {
  const lastAttempt = job.startedAt ?? job.createdAt;
  switch (job.status === 'deferred' ? 'on-reset' : job.runPolicy) {
    case 'manual':
      return { ok: false, reason: 'waiting for you to run it' };
    case 'at':
      return job.runAt && now >= job.runAt
        ? { ok: true, reason: 'scheduled time reached' }
        : { ok: false, reason: `scheduled for ${new Date(job.runAt ?? 0).toLocaleString()}` };
    case 'asap-if-headroom':
      return { ok: true, reason: 'runs as soon as it fits' };
    case 'on-reset':
    default:
      return status.block.window.start > lastAttempt
        ? { ok: true, reason: 'a new window has opened' }
        : { ok: false, reason: `waiting for the window that opens at ${new Date(status.block.resetsAt).toLocaleTimeString()}` };
  }
}

/**
 * Decide whether a job may start now.
 *
 * The reserve exists so an unattended queue can't quietly eat the quota you
 * were saving for yourself: a job only starts if the *pessimistic* p90 estimate
 * still leaves the floor intact. Marking a job urgent opts out of that.
 */
export function decide(db: Db, cfg: Config, job: Job, status: Status, now = Date.now()): Decision {
  const policy = policyAllows(job, status, now);
  if (!policy.ok) return { job, run: false, reason: policy.reason };

  const estimate = job.estimateP90 ?? predict(db, job).p90;
  const reserve = job.urgent ? 0 : (status.block.cap.credits * cfg.reservePct) / 100;

  if (status.block.remainingCredits - estimate < reserve) {
    return { job, run: false, reason: `not enough headroom in the 5h window (needs ~$${estimate.toFixed(2)}, $${status.block.remainingCredits.toFixed(2)} left)` };
  }
  if (status.week.remainingCredits - estimate < 0) {
    return { job, run: false, reason: 'not enough headroom in the weekly window' };
  }
  return { job, run: true, reason: policy.reason };
}

export class Scheduler extends EventEmitter {
  private db: Db;
  private cfg: Config;
  private provider: Provider;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(db: Db, cfg: Config, provider: Provider) {
    super();
    this.db = db;
    this.cfg = cfg;
    this.provider = provider;
  }

  /** Why each pending job is or isn't running — this is what the dashboard shows. */
  explain(): Decision[] {
    const status = computeStatus(this.db, this.cfg);
    return pendingJobs(this.db).map((job) => decide(this.db, this.cfg, job, status));
  }

  async tick(): Promise<void> {
    if (this.running.size >= this.cfg.concurrency) return;
    const status = computeStatus(this.db, this.cfg);
    for (const job of pendingJobs(this.db)) {
      if (this.running.size >= this.cfg.concurrency) break;
      if (this.running.has(job.id)) continue;
      const decision = decide(this.db, this.cfg, job, status, status.now);
      if (decision.run) void this.run(job);
    }
  }

  async run(job: Job): Promise<void> {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    const startedAt = Date.now();
    const before = computeStatus(this.db, this.cfg, startedAt);
    updateJob(this.db, job.id, { status: 'running', startedAt, attempts: job.attempts + 1 });
    this.emit('change', job.id);

    try {
      const result = await this.provider.execute(job, { timeoutMs: this.cfg.jobTimeoutMs });

      if (result.rateLimited) {
        // The limit we just hit is a hard lower bound on the real cap, which is
        // the most reliable calibration signal there is.
        addCeiling(this.db, 'block', before.block.window.credits);
        const giveUp = job.attempts + 1 >= MAX_ATTEMPTS;
        updateJob(this.db, job.id, {
          status: giveUp ? 'failed' : 'deferred',
          error: result.error ?? 'usage limit reached',
          finishedAt: giveUp ? Date.now() : null,
        });
        await notify(this.cfg, {
          title: giveUp ? `tokio: job ${job.id} gave up` : `tokio: job ${job.id} postponed`,
          body: giveUp ? 'Hit the usage limit too many times.' : 'Hit the usage limit; it will retry when the window resets.',
          level: giveUp ? 'high' : 'low',
        });
        return;
      }

      const credits = result.credits ?? this.creditsForSession(result.sessionId, startedAt);
      updateJob(this.db, job.id, {
        status: result.ok ? 'done' : 'failed',
        actualCredits: credits,
        resultSessionId: result.sessionId,
        output: result.output.slice(0, OUTPUT_LIMIT),
        error: result.error,
        finishedAt: Date.now(),
      });
      if (result.ok && credits != null) recordOutcome(this.db, job, credits);

      await notify(this.cfg, {
        title: result.ok ? `tokio: job ${job.id} done` : `tokio: job ${job.id} failed`,
        body: result.ok
          ? `${job.prompt.slice(0, 80)}\nCost ≈ $${(credits ?? 0).toFixed(2)}`
          : (result.error ?? 'unknown error').slice(0, 200),
        level: result.ok ? 'normal' : 'high',
      });
    } catch (err) {
      updateJob(this.db, job.id, { status: 'failed', error: (err as Error).message, finishedAt: Date.now() });
    } finally {
      this.running.delete(job.id);
      this.emit('change', job.id);
    }
  }

  /** Fall back to the usage our own ingestor recorded for the session the job created. */
  private creditsForSession(sessionId: string | null, since: number): number | null {
    if (!sessionId) return null;
    const row = this.db
      .prepare('SELECT SUM(credits) AS c FROM events WHERE sessionId = ? AND ts >= ?')
      .get(sessionId, since - 60_000) as { c: number | null } | undefined;
    return row?.c ?? null;
  }

  start(): void {
    requeueOrphans(this.db);
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get busy(): string[] {
    return [...this.running];
  }
}

export { listJobs };
