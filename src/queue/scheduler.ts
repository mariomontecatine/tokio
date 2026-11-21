import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import type { Job, Status } from '../types.ts';
import type { Provider } from '../providers/types.ts';
import { computeStatus } from '../meter/index.ts';
import { getJob, listJobs, pendingJobs, requeueOrphans, updateJob } from './store.ts';
import { predict } from '../estimator/predict.ts';
import { recordOutcome } from '../estimator/learn.ts';
import { addCeiling } from '../plans/calibrate.ts';
import { notify } from '../notify/index.ts';
import { resolvePlanAsync, type ResolvedPlan } from '../plans/detect.ts';
import { computeCodexStatus, type CodexStatus } from '../codex/meter.ts';

const MAX_ATTEMPTS = 5;

/** The provider every job had before there was a choice, and still the default. */
export const CLAUDE_PROVIDER_ID = 'claude-code';

const isCodex = (job: Job) => job.provider === 'codex';

/** How long a Codex job held back by a limit waits when no reading will ever say the window reset. */
const BLIND_RETRY_MS = 60 * 60_000;

/** Which agents the person has switched on. */
export type Enabled = () => { claude: boolean; codex: boolean };
const OUTPUT_LIMIT = 40_000;

/** How long the scheduler will ever sleep with nothing else to wait for. */
const HEARTBEAT_MS = 30_000;
/** And the shortest, so a queue can never spin. */
const MIN_WAKE_MS = 1_000;

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
export function decide(db: Db, cfg: Config, job: Job, status: Status, now = Date.now(), codex: CodexStatus | null = null): Decision {
  if (isCodex(job)) return decideCodex(cfg, job, codex ?? computeCodexStatus(db, cfg, now), now);
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

/**
 * Whether a Codex job may start now.
 *
 * Codex's windows are percentages OpenAI reports, with no cap behind them that
 * tokio could put a job's cost against, so the rule is coarser than Claude's
 * and says so: a job starts when the five-hour window is below the reserve
 * line — 90% used with the default 10% reserve, 100% if the job is urgent —
 * the weekly one is not full, and OpenAI has not flagged the limit as reached.
 *
 * "When the window resets" means the window is open again since the job was
 * queued or last tried. That is known in three ways: a current reading of an
 * untouched window (0% — OpenAI reports one with a reset that keeps moving five
 * hours ahead, because nothing has started it), a reading of a window that
 * opened after then, or a reset an earlier reading announced that has since
 * passed. The first matters most: a window nobody has used is already the
 * quota coming back, and waiting for it to reset would be waiting for a reset
 * that only usage can start.
 *
 * With no current reading at all, nothing holds a job back: running one costs
 * nothing if the limit has been reached, because Codex refuses and the job
 * waits for the reset like any other limited run.
 */
export function decideCodex(cfg: Config, job: Job, codex: CodexStatus, now: number): Decision {
  const lastAttempt = job.startedAt ?? job.createdAt;
  const session = codex.session;
  const policy = job.status === 'deferred' ? 'on-reset' : job.runPolicy;

  if (policy === 'manual') return { job, run: false, reason: 'waiting for you to run it' };
  if (policy === 'at' && !(job.runAt != null && now >= job.runAt)) {
    return { job, run: false, reason: `scheduled for ${new Date(job.runAt ?? 0).toLocaleString()}` };
  }
  let reason = policy === 'at' ? 'scheduled time reached' : 'runs as soon as it fits';
  if (policy === 'on-reset') {
    // After a refused attempt, only a reading taken since counts: a 0% read
    // before Codex said no is contradicted by that no, and trusting it would
    // re-run the job on every tick until its attempts ran out.
    const untouched = session !== null && session.usedPct === 0 && (job.startedAt == null || session.readAt > job.startedAt);
    const opened = (session?.start != null && session.usedPct > 0 && session.start <= now && session.start > lastAttempt) || (codex.lastResetAt != null && codex.lastResetAt > lastAttempt);
    if (untouched) {
      reason = 'the Codex window is untouched, so there is no reset to wait for';
    } else if (opened) {
      reason = 'a new Codex window has opened';
    } else if (job.status === 'deferred' && !session) {
      // Held back by a limit, with nothing that will ever announce the reset —
      // no app server to ask, no reading in any rollout. Waiting for news that
      // cannot come would be forever, so it tries again hourly: a refused run
      // costs nothing, and MAX_ATTEMPTS still bounds it.
      const retryAt = lastAttempt + BLIND_RETRY_MS;
      if (now < retryAt) {
        return { job, run: false, reason: `no reading of the Codex window to wait for; trying again at ${new Date(retryAt).toLocaleTimeString()}` };
      }
      reason = 'no reading of the Codex window, so trying again an hour after the limit';
    } else {
      return {
        job,
        run: false,
        reason: session?.resetsAt
          ? `waiting for the Codex window that opens at ${new Date(session.resetsAt).toLocaleTimeString()}`
          : 'waiting for the Codex window to reset',
      };
    }
  }

  if (codex.limitReached) return { job, run: false, reason: 'OpenAI reports the Codex limit as reached' };
  const ceiling = job.urgent ? 100 : 100 - cfg.reservePct;
  if (session && session.usedPct >= ceiling) {
    return {
      job,
      run: false,
      reason: job.urgent
        ? `the Codex 5h window is full (${Math.round(session.usedPct)}%)`
        : `the Codex 5h window is at ${Math.round(session.usedPct)}%, and the reserve keeps the last ${cfg.reservePct}% for you`,
    };
  }
  if (codex.week && codex.week.usedPct >= 100) return { job, run: false, reason: 'the Codex weekly window is full' };
  return { job, run: true, reason };
}

/**
 * How long to wait before looking again.
 *
 * Exported because it is the whole of the queue's timing, and timing is the one
 * thing a queue is judged on.
 */
export function nextWakeMs(status: Status, pending: Job[], now: number, codex: CodexStatus | null = null): number {
  let at = now + HEARTBEAT_MS;
  if (pending.length) {
    // The reset is the moment the queue exists for. A second past it, so the
    // window that gets recomputed is unambiguously the new one.
    if (pending.some((job) => !isCodex(job)) && status.block.resetsAt > now) at = Math.min(at, status.block.resetsAt + 1_000);
    // Codex's reset is its own, and only matters to its own jobs.
    if (pending.some(isCodex)) {
      for (const reset of [codex?.session?.resetsAt, codex?.week?.resetsAt]) {
        if (reset != null && reset > now) at = Math.min(at, reset + 1_000);
      }
    }
    for (const job of pending) {
      if (isCodex(job) && job.status === 'deferred' && !codex?.session) {
        const retryAt = (job.startedAt ?? job.createdAt) + BLIND_RETRY_MS;
        if (retryAt > now) at = Math.min(at, retryAt);
      }
      if (job.runPolicy === 'at' && job.runAt && job.runAt > now) at = Math.min(at, job.runAt);
    }
  }
  return Math.max(MIN_WAKE_MS, at - now);
}

export class Scheduler extends EventEmitter {
  private db: Db;
  private cfg: Config;
  /** By id. A job names its provider; one whose provider is missing fails rather than running elsewhere. */
  private providers: Map<string, Provider>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = new Set<string>();

  private enabled: Enabled;

  constructor(db: Db, cfg: Config, providers: Provider | Provider[], enabled: Enabled = () => ({ claude: true, codex: true })) {
    super();
    this.db = db;
    this.cfg = cfg;
    this.providers = new Map((Array.isArray(providers) ? providers : [providers]).map((p) => [p.id, p]));
    this.enabled = enabled;
  }

  /**
   * A job for an agent that has been switched off waits.
   *
   * Someone who said they no longer use Codex has not asked for the Codex job
   * still in the queue to go off unattended — and with Codex's half stopped
   * there are no fresh readings to hold it back either. "Run now" is still a
   * person deciding, and is not gated.
   */
  private gate(job: Job): Decision | null {
    const on = this.enabled();
    const codex = isCodex(job);
    if (codex ? on.codex : on.claude) return null;
    return { job, run: false, reason: `${codex ? 'Codex' : 'Claude'} is switched off in tokio — switch it back on, or run this one by hand` };
  }

  /** Codex's status, computed only when some pending job needs it. */
  private codexFor(pending: Job[], now: number): CodexStatus | null {
    return pending.some(isCodex) ? computeCodexStatus(this.db, this.cfg, now) : null;
  }

  /**
   * Why each pending job is or isn't running — this is what the dashboard shows.
   *
   * Takes the status the caller already has where there is one. `/api/status`
   * asks for both in the same breath, and rebuilding it here meant every load
   * of the dashboard replayed a fortnight of events twice over.
   */
  explain(status = computeStatus(this.db, this.cfg), codex: CodexStatus | null = null): Decision[] {
    const pending = pendingJobs(this.db);
    const codexNow = codex ?? this.codexFor(pending, status.now);
    return pending.map((job) => this.gate(job) ?? decide(this.db, this.cfg, job, status, status.now, codexNow));
  }

  async tick(): Promise<void> {
    const plan = await resolvePlanAsync(this.cfg);
    if (this.stopped) return;
    const status = computeStatus(this.db, this.cfg, Date.now(), plan);
    const pending = pendingJobs(this.db);
    const codex = this.codexFor(pending, status.now);
    try {
      for (const job of pending) {
        if (this.running.size >= this.cfg.concurrency) break;
        if (this.running.has(job.id)) continue;
        const decision = this.gate(job) ?? decide(this.db, this.cfg, job, status, status.now, codex);
        if (decision.run) void this.run(job, plan);
      }
    } finally {
      this.rearm(status, pending, codex);
    }
  }

  async run(job: Job, plan?: ResolvedPlan): Promise<void> {
    if (this.running.has(job.id)) return;
    // The row, not the copy the caller was holding. Between a decision and this
    // line the prompt can have been edited from the dashboard, and running the
    // version that was on screen a moment ago is exactly the surprise the edit
    // was meant to avoid.
    const startedAt = Date.now();
    const claimed = this.db.prepare(`UPDATE jobs SET status = 'running', startedAt = ?, attempts = attempts + 1
      WHERE id = ? AND status = ? AND status IN ('queued','deferred','cancelled')`).run(startedAt, job.id, job.status);
    if (!claimed.changes) return;
    job = getJob(this.db, job.id)!;
    const providerId = job.provider || CLAUDE_PROVIDER_ID;
    const provider = this.providers.get(providerId);
    const claude = providerId === CLAUDE_PROVIDER_ID;
    this.running.add(job.id);
    this.emit('change', job.id);

    try {
      // A job for an agent this daemon cannot run fails and says which. Handing
      // it to whichever provider is there would run a Codex prompt on Claude.
      const before = claude ? computeStatus(this.db, this.cfg, startedAt, plan ?? await resolvePlanAsync(this.cfg)) : null;
      if (!provider) throw new Error(`no ${providerId} provider is available to run this job`);
      const result = await provider.execute(job, { timeoutMs: this.cfg.jobTimeoutMs });

      if (result.rateLimited) {
        // The limit we just hit is a hard lower bound on the real cap, which is
        // the most reliable calibration signal there is. Claude's only: the cap
        // is Claude's, and Codex has none to bound.
        if (before) addCeiling(this.db, 'block', before.block.window.credits);
        const giveUp = job.attempts >= MAX_ATTEMPTS;
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

      // A Codex job gets no dollar figure of its own. Its responses are priced
      // from the rollout, which the reader may not have finished when the run
      // ends, and the priced part of a run would read as the cost of all of it.
      // They still count in Codex's totals once read.
      const credits = result.credits ?? (claude ? this.creditsForSession(result.sessionId, startedAt) : null);
      updateJob(this.db, job.id, {
        status: result.ok ? 'done' : 'failed',
        actualCredits: credits,
        resultSessionId: result.sessionId,
        output: result.output.slice(0, OUTPUT_LIMIT),
        error: result.error,
        finishedAt: Date.now(),
      });
      // The estimator learns Claude turns priced in Claude's catalog; a Codex
      // run in its history would teach it a different currency.
      if (claude && result.ok && credits != null) recordOutcome(this.db, job, credits);

      await notify(this.cfg, {
        title: result.ok ? `tokio: job ${job.id} done` : `tokio: job ${job.id} failed`,
        body: result.ok
          ? `${job.prompt.slice(0, 80)}${credits != null ? `\nCost ≈ $${credits.toFixed(2)}` : ''}`
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
    this.stopped = false;
    requeueOrphans(this.db);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Sleep until the next thing that could change an answer.
   *
   * A fixed thirty-second beat is fine as a floor and wrong as a ceiling: a job
   * asked to start at 21:00 would start somewhere in the following half minute,
   * and the reset the whole queue is waiting for would land whenever the beat
   * next happened to fall. Both are moments we know in advance, so they are
   * waited for exactly, and the heartbeat stays as the backstop for everything
   * we don't know about.
   */
  private rearm(status: Status, pending: Job[], codex: CodexStatus | null = null): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), nextWakeMs(status, pending, Date.now(), codex));
    this.timer.unref();
  }

  get busy(): string[] {
    return [...this.running];
  }
}

export { listJobs };
