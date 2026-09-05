import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createJob, getJob, requeueOrphans, updateJob } from '../src/queue/store.ts';
import { Scheduler, decide, nextWakeMs } from '../src/queue/scheduler.ts';
import { checkPromptBlocks } from '../src/queue/blocks.ts';
import { readJobFields } from '../src/queue/validate.ts';
import { createClaudeCodeProvider, buildArgs, looksRateLimited } from '../src/providers/claudeCode.ts';
import { computeStatus } from '../src/meter/index.ts';
import { saveProbe } from '../src/usage/store.ts';
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

test('a job queued for the reset starts once that reset has passed', () => {
  // The whole point of the queue, and it sat there: at 19:00 the job still read
  // "waiting for the window that opens at 18:49". `/usage` prints no session
  // line while nothing is running, so the reading taken just before the reset
  // stayed the newest one and kept the finished window looking current — full,
  // and therefore with no room for the job that was waiting on it.
  const { db, cfg } = setup();
  const queuedAt = Date.parse('2026-09-04T13:50:00');
  saveProbe(db, {
    at: Date.parse('2026-09-04T18:48:00'),
    sessionPct: 100, sessionResetsAt: Date.parse('2026-09-04T18:49:00'),
    weekPct: 33, weekResetsAt: Date.parse('2026-09-05T20:59:00'),
    opusPct: null, opusResetsAt: null, error: null,
  });
  const waiting = job({ runPolicy: 'on-reset', createdAt: queuedAt });

  const before = Date.parse('2026-09-04T18:48:30');
  assert.equal(decide(db, cfg, waiting, computeStatus(db, cfg, before), before).run, false, 'not while the window it was queued in is still open');

  const after = Date.parse('2026-09-04T19:00:00');
  const now = decide(db, cfg, waiting, computeStatus(db, cfg, after), after);
  assert.equal(now.run, true, now.reason);
});

test('a prompt keeps a record of what was pasted into it, and only what really is', () => {
  const paste = 'Traceback:\n' + 'at frame\n'.repeat(40);
  const prompt = `${paste}\n\nfix this`;
  const { db } = setup();
  const created = createJob(db, { prompt, promptBlocks: [paste], cwd: process.cwd(), safety: 'edits' });
  assert.deepEqual(getJob(db, created.id)!.promptBlocks, [paste]);

  // A block that is not in the prompt would fold away text the job does not
  // contain, so the whole set goes rather than half of it.
  assert.equal(checkPromptBlocks(prompt, ['something else']), null);
  assert.equal(checkPromptBlocks(prompt, [paste, 'nor this']), null);
  assert.deepEqual(checkPromptBlocks(prompt, [paste]), [paste]);
  assert.equal(checkPromptBlocks(prompt, []), null);
});

test('the queue refuses instructions it cannot carry out', () => {
  // Each of these used to be stored as given and then quietly change what ran:
  // an unknown safety mode dropped --permission-mode altogether, and a job
  // scheduled for no particular time waited for 1970.
  assert.equal(readJobFields({ safety: 'yolo' }).ok, false);
  assert.equal(readJobFields({ runPolicy: 'whenever' }).ok, false);
  assert.equal(readJobFields({ runPolicy: 'at' }).ok, false);
  assert.equal(readJobFields({ prompt: '   ' }).ok, false);
  assert.equal(readJobFields({ status: 'done' }).ok, false, 'only the scheduler says a job is done');

  const scheduled = readJobFields({ runPolicy: 'at', runAt: '2026-09-05T10:00:00Z' });
  assert.ok(scheduled.ok && scheduled.value.runAt === Date.parse('2026-09-05T10:00:00Z'));

  // Changing only the time of an already-scheduled job is enough on its own.
  const timeOnly = readJobFields({ runAt: 1 }, { runPolicy: 'at', runAt: 2 });
  assert.ok(timeOnly.ok && timeOnly.value.runAt === 1);

  // And moving off "at a time" takes the time with it.
  const relaxed = readJobFields({ runPolicy: 'on-reset' }, { runPolicy: 'at', runAt: 2 });
  assert.ok(relaxed.ok && relaxed.value.runAt === null);
});

test('the scheduler waits for the next thing that matters, not for a fixed beat', () => {
  const now = Date.now();
  const status = statusWith(90);
  const soon = job({ runPolicy: 'at', runAt: now + 4_000 });

  assert.equal(nextWakeMs(status, [], now), 30_000, 'nothing queued, nothing to hurry for');
  assert.equal(nextWakeMs(status, [soon], now), 4_000, 'a job with a time is woken for at its time');
  // The reset is an hour out in this fixture, so the heartbeat still wins.
  assert.equal(nextWakeMs(status, [job()], now), 30_000);

  const resetting = statusWith(90);
  resetting.block.resetsAt = now + 9_000;
  assert.equal(nextWakeMs(resetting, [job()], now), 10_000, 'a second past the reset');
  // A time a hundred milliseconds out still gets a whole second: the job it is
  // waiting for cannot start any sooner, and a queue must never spin.
  assert.equal(nextWakeMs(status, [job({ runPolicy: 'at', runAt: now + 100 })], now), 1_000);
});

test('a run in flight cannot be edited out from under itself', async () => {
  const { db, cfg, scheduler } = setup();
  const created = createJob(db, { prompt: 'first', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });

  // Editing before it starts is the point of the queue: the run picks up the
  // row as it stands, not the copy whoever scheduled it was holding.
  updateJob(db, created.id, { prompt: 'second' });
  await scheduler.run(created);
  assert.equal(getJob(db, created.id)!.prompt, 'second');
  assert.equal(cfg.claudeBin, FAKE);
});
