import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createJob, getJob, requeueOrphans, updateJob } from '../src/queue/store.ts';
import { Scheduler, decide } from '../src/queue/scheduler.ts';
import { createClaudeCodeProvider, buildArgs, looksRateLimited } from '../src/providers/claudeCode.ts';
import { computeStatus } from '../src/meter/index.ts';
import type { Job, Status } from '../src/types.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.sh');

function setup(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  const cfg: Config = {
    ...loadConfig(),
    claudeBin: FAKE,
    plan: 'max5',
    reservePct: 10,
    concurrency: 1,
    jobTimeoutMs: 15_000,
    notify: { ...loadConfig().notify, desktop: false, ntfyTopic: null, telegramToken: null, webhook: null },
    ...overrides,
  };
  return { db, cfg, scheduler: new Scheduler(db, cfg, createClaudeCodeProvider(cfg)) };
}

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'j1', provider: 'claude-code', prompt: 'run the tests', cwd: process.cwd(), model: 'opus',
    safety: 'edits', resumeSessionId: null, runPolicy: 'asap-if-headroom', runAt: null, priority: 0,
    urgent: false, status: 'queued', estimateP50: 1, estimateP90: 2, estimateBasis: 'test',
    actualCredits: null, resultSessionId: null, output: null, error: null, attempts: 0,
    createdAt: Date.now(), startedAt: null, finishedAt: null, ...over,
  }) as Job;

const statusWith = (remaining: number, cap = 100): Status =>
  ({
    now: Date.now(),
    block: { window: { start: Date.now() - 1000, end: Date.now() + 3_600_000, credits: cap - remaining, opusCredits: 0, events: 1, lastActivity: null, active: true },
      cap: { credits: cap, basis: 'default' }, usedPct: ((cap - remaining) / cap) * 100, remainingCredits: remaining, resetsAt: Date.now() + 3_600_000, rolling: false },
    week: { window: { start: 0, end: 0, credits: 0, opusCredits: 0, events: 0, lastActivity: null, active: true },
      cap: { credits: 1000, basis: 'default' }, usedPct: 0, remainingCredits: 1000, resetsAt: 0, rolling: true },
  }) as unknown as Status;

test('a finished job records what it really cost and teaches the estimator', async () => {
  const { db, scheduler } = setup();
  const queued = createJob(db, { prompt: 'run the tests', cwd: process.cwd(), safety: 'edits', model: 'opus', runPolicy: 'manual', estimateP50: 1, estimateP90: 2 });
  await scheduler.run(queued);

  const done = getJob(db, queued.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.actualCredits, 2.5, 'cost comes from the run itself, not the estimate');
  assert.equal(done.resultSessionId, 'fake-session');
  assert.match(done.output!, /tests pass/);

  const learned = db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
  assert.equal(learned.n, 1, 'the outcome feeds back into future estimates');
});

test('hitting the limit postpones the job instead of failing it, and records the ceiling', async () => {
  process.env.TOKIO_FAKE_MODE = 'ratelimit';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { prompt: 'x', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    await scheduler.run(queued);

    const after = getJob(db, queued.id)!;
    assert.equal(after.status, 'deferred');
    assert.equal(after.attempts, 1);
    const ceilings = db.prepare('SELECT COUNT(*) AS n FROM ceilings').get() as { n: number };
    assert.equal(ceilings.n, 1, 'the limit we hit becomes a calibration data point');
  } finally {
    delete process.env.TOKIO_FAKE_MODE;
  }
});

test('a crashing run is reported as failed, with the error kept', async () => {
  process.env.TOKIO_FAKE_MODE = 'crash';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { prompt: 'x', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    await scheduler.run(queued);
    const after = getJob(db, queued.id)!;
    assert.equal(after.status, 'failed');
    assert.match(after.error!, /boom/);
  } finally {
    delete process.env.TOKIO_FAKE_MODE;
  }
});

test('gives up after repeated limits instead of retrying forever', async () => {
  process.env.TOKIO_FAKE_MODE = 'ratelimit';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { prompt: 'x', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    updateJob(db, queued.id, { attempts: 4 });
    await scheduler.run(getJob(db, queued.id)!);
    assert.equal(getJob(db, queued.id)!.status, 'failed');
  } finally {
    delete process.env.TOKIO_FAKE_MODE;
  }
});

test('the reserve stops a job that would eat the floor', () => {
  const { db, cfg } = setup();
  // $12 left of a $100 cap, so the 10% floor leaves room for $2 of work.
  const tight = decide(db, cfg, job({ estimateP90: 5 }), statusWith(12));
  assert.equal(tight.run, false);
  assert.match(tight.reason, /headroom/);

  const fits = decide(db, cfg, job({ estimateP90: 1 }), statusWith(12));
  assert.equal(fits.run, true);
});

test('an urgent job may spend into the reserve', () => {
  const { db, cfg } = setup();
  assert.equal(decide(db, cfg, job({ estimateP90: 5, urgent: true }), statusWith(12)).run, true);
});

test('an on-reset job waits for a window that opened after it was queued', () => {
  const { db, cfg } = setup();
  const status = statusWith(90);
  const queuedNow = decide(db, cfg, job({ runPolicy: 'on-reset', createdAt: Date.now() }), status);
  assert.equal(queuedNow.run, false, 'the window it was queued in does not count');

  const queuedEarlier = decide(db, cfg, job({ runPolicy: 'on-reset', createdAt: status.block.window.start - 60_000 }), status);
  assert.equal(queuedEarlier.run, true);
});

test('a manual job never starts on its own', () => {
  const { db, cfg } = setup();
  assert.equal(decide(db, cfg, job({ runPolicy: 'manual' }), statusWith(90)).run, false);
});

test('a scheduled job waits for its time', () => {
  const { db, cfg } = setup();
  assert.equal(decide(db, cfg, job({ runPolicy: 'at', runAt: Date.now() + 60_000 }), statusWith(90)).run, false);
  assert.equal(decide(db, cfg, job({ runPolicy: 'at', runAt: Date.now() - 1000 }), statusWith(90)).run, true);
});

test('a job interrupted by a daemon restart goes back in the queue', () => {
  const { db } = setup();
  const created = createJob(db, { prompt: 'x', cwd: process.cwd(), safety: 'edits' });
  updateJob(db, created.id, { status: 'running' });
  assert.equal(requeueOrphans(db), 1);
  assert.equal(getJob(db, created.id)!.status, 'queued');
});

test('the safety mode chosen is the one passed to the CLI', () => {
  const { cfg } = setup();
  assert.match(buildArgs(job({ safety: 'plan' }), cfg).join(' '), /--permission-mode plan/);
  assert.match(buildArgs(job({ safety: 'edits' }), cfg).join(' '), /--permission-mode acceptEdits/);
  const full = buildArgs(job({ safety: 'full' }), cfg).join(' ');
  assert.match(full, /--dangerously-skip-permissions/);
  assert.doesNotMatch(full, /--permission-mode/);
  assert.match(buildArgs(job({ resumeSessionId: 'abc' }), cfg).join(' '), /--resume abc/);
});

test('a successful job that merely mentions rate limits is not postponed', async () => {
  const { db, scheduler } = setup();
  const queued = createJob(db, {
    prompt: 'explain what a rate limit is',
    cwd: process.cwd(), safety: 'edits', runPolicy: 'manual',
  });
  await scheduler.run(queued);
  // The fake CLI answers successfully; only the error channels may be searched
  // for limit wording, or ordinary answers about limits would defer the job.
  assert.equal(getJob(db, queued.id)!.status, 'done');
});

test('limit messages are told apart from ordinary output', () => {
  assert.ok(looksRateLimited('Claude usage limit reached. Your limit will reset at 11pm'));
  assert.ok(looksRateLimited('429 rate_limit_error'));
  assert.equal(looksRateLimited('the tests pass and nothing is limited about them'), false);
});
