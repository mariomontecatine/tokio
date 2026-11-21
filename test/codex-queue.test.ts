import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CodexService } from '../src/codex/service.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createJob, getJob } from '../src/queue/store.ts';
import { Scheduler, decideCodex, nextWakeMs } from '../src/queue/scheduler.ts';
import { buildCodexArgs, createCodexProvider } from '../src/providers/codex.ts';
import { createClaudeCodeProvider } from '../src/providers/claudeCode.ts';
import { probeCodexLimits } from '../src/codex/limits.ts';
import { computeCodexStatus, type CodexStatus } from '../src/codex/meter.ts';
import { saveCodexReading } from '../src/codex/store.ts';
import { resolveCodex } from '../src/codex/cli.ts';
import type { CodexReading } from '../src/codex/parse.ts';
import type { Job, Status } from '../src/types.ts';

const configHome = await mkdtemp(join(tmpdir(), 'tokio-codex-test-'));
process.env.XDG_CONFIG_HOME = configHome;
process.env.CLAUDE_CONFIG_DIR = join(configHome, 'claude');
after(() => rm(configHome, { recursive: true, force: true }));

const FAKE = join(import.meta.dirname, 'fake-codex.mjs');
const HOUR = 3_600_000;

function setup(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  const cfg: Config = {
    ...loadConfig(),
    codexBin: FAKE,
    codexLauncher: [process.execPath],
    claudeBin: join(import.meta.dirname, 'fake-claude.mjs'),
    claudeLauncher: [process.execPath],
    reservePct: 10,
    concurrency: 1,
    jobTimeoutMs: 15_000,
    notify: { ...loadConfig().notify, desktop: false, ntfyTopic: null, telegramToken: null, webhook: null },
    ...overrides,
  };
  const scheduler = new Scheduler(db, cfg, [createClaudeCodeProvider(cfg), createCodexProvider(cfg)]);
  return { db, cfg, scheduler };
}

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'c1', provider: 'codex', prompt: 'run the tests', cwd: process.cwd(), model: null,
    safety: 'edits', resumeSessionId: null, runPolicy: 'asap-if-headroom', runAt: null, priority: 0,
    urgent: false, status: 'queued', estimateP50: null, estimateP90: null, estimateBasis: null,
    actualCredits: null, resultSessionId: null, output: null, error: null, attempts: 0,
    createdAt: Date.now() - HOUR, startedAt: null, finishedAt: null, ...over,
  }) as Job;

const reading = (over: Partial<CodexReading> = {}): CodexReading => ({
  at: Date.now(), via: 'app-server', limitId: 'codex', sessionPct: 20, sessionResetsAt: Date.now() + 2 * HOUR,
  sessionMinutes: 300, weekPct: 5, weekResetsAt: Date.now() + 4 * 24 * HOUR, weekMinutes: 10080,
  planType: 'plus', limitReached: null, error: null, ...over,
});

test('each safety level maps to its own sandbox, and resume keeps every option before the subcommand', () => {
  assert.deepEqual(buildCodexArgs(job({ safety: 'plan', cwd: '/w' })), ['exec', '--json', '--sandbox', 'read-only', '--cd', '/w', '-']);
  assert.deepEqual(
    buildCodexArgs(job({ safety: 'edits', cwd: '/w', model: 'gpt-test-large', resumeSessionId: 'thread-9' })),
    ['exec', '--json', '--sandbox', 'workspace-write', '--cd', '/w', '--model', 'gpt-test-large', 'resume', 'thread-9', '-'],
  );
  assert.equal(buildCodexArgs(job({ safety: 'full' }))[3], 'danger-full-access');
  assert.ok(!buildCodexArgs(job()).includes('--skip-git-repo-check'), 'Codex keeps its own safeguard');
});

test('a Codex job runs through codex exec, with the prompt on stdin', async () => {
  const { db, scheduler } = setup();
  // A model the shipped table prices, so a figure built from the turn's total
  // — which the 272K rule makes wrong — would have something to show.
  const queued = createJob(db, { provider: 'codex', prompt: 'add a test', cwd: process.cwd(), safety: 'plan', runPolicy: 'manual', model: 'gpt-6.1-sol' });
  await scheduler.run(queued);
  const done = getJob(db, queued.id)!;
  assert.equal(done.status, 'done', done.error ?? '');
  assert.equal(done.resultSessionId, 'fake-thread');
  assert.match(done.output ?? '', /--sandbox read-only/);
  assert.match(done.output ?? '', /prompt: add a test/);
  assert.equal(done.actualCredits, null, 'a Codex job carries no dollar figure of its own');
  // The estimator learns Claude turns only.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM observations').get() as any).n, 0);
});

test('a transient reconnect is not a failure', async () => {
  process.env.TOKIO_FAKE_CODEX = 'reconnect';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'plan', runPolicy: 'manual' });
    await scheduler.run(queued);
    assert.equal(getJob(db, queued.id)!.status, 'done');
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
});

test('hitting the Codex limit defers the job and records nothing against Claude', async () => {
  process.env.TOKIO_FAKE_CODEX = 'ratelimit';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    await scheduler.run(queued);
    const after = getJob(db, queued.id)!;
    assert.equal(after.status, 'deferred');
    assert.match(after.error ?? '', /usage limit/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ceilings').get() as any).n, 0, 'Claude has the only cap, and this was not it');
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
});

test("a workspace's limit is a limit too, though its code has no word boundary in front", async () => {
  process.env.TOKIO_FAKE_CODEX = 'ratelimit-workspace';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    await scheduler.run(queued);
    assert.equal(getJob(db, queued.id)!.status, 'deferred');
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
});

test('a crash fails the job with what Codex printed', async () => {
  process.env.TOKIO_FAKE_CODEX = 'crash';
  try {
    const { db, scheduler } = setup();
    const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
    await scheduler.run(queued);
    const after = getJob(db, queued.id)!;
    assert.equal(after.status, 'failed');
    assert.match(after.error ?? '', /boom/);
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
});

test('a job whose provider is not there fails instead of running on another agent', async () => {
  const { db, cfg } = setup();
  const onlyClaude = new Scheduler(db, cfg, createClaudeCodeProvider(cfg));
  const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'edits', runPolicy: 'manual' });
  await onlyClaude.run(queued);
  const after = getJob(db, queued.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error ?? '', /no codex provider/);
  assert.equal(after.output, null, 'nothing ran');
});

test('the app server is asked for the limits, and the account id is not kept', async () => {
  const { db, cfg } = setup();
  process.env.TOKIO_FAKE_PCT = '37';
  try {
    const r = await probeCodexLimits(cfg, 10_000);
    assert.equal(r.error, null);
    assert.equal(r.via, 'app-server');
    assert.equal(r.sessionPct, 37);
    assert.equal(r.weekPct, 9);
    assert.equal(r.planType, 'plus');
    saveCodexReading(db, r);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM codex_limits').all()), /acct-fake/);
  } finally {
    delete process.env.TOKIO_FAKE_PCT;
  }
});

test('a refused or silent app server is an error reading, not an exception', async () => {
  const { cfg } = setup();
  process.env.TOKIO_FAKE_CODEX = 'noauth';
  try {
    const r = await probeCodexLimits(cfg, 10_000);
    assert.match(r.error ?? '', /not signed in/);
    assert.equal(r.sessionPct, null);
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
  process.env.TOKIO_FAKE_CODEX = 'hang';
  try {
    const r = await probeCodexLimits(cfg, 300);
    assert.match(r.error ?? '', /timed out/);
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
  }
  const missing = await probeCodexLimits({ codexBin: 'tokio-no-such-codex-binary', codexLauncher: null }, 5_000);
  assert.ok(missing.error, 'a missing binary is reported');
});

test('a reading expires at the reset it named, and is never carried forward as zero', () => {
  const { db, cfg } = setup();
  const now = Date.now();
  saveCodexReading(db, reading({ at: now - 10 * 60_000, sessionPct: 64, sessionResetsAt: now + HOUR, via: 'rollout' }));
  let s = computeCodexStatus(db, cfg, now);
  assert.equal(s.session?.usedPct, 64);
  assert.equal(s.session?.source, 'reported');
  assert.equal(s.session?.via, 'rollout');
  assert.equal(s.session?.start, now + HOUR - 300 * 60_000);

  // Past that reset: no reading, not 0% and not the old 64%.
  s = computeCodexStatus(db, cfg, now + HOUR + 1);
  assert.equal(s.session, null);
  assert.equal(s.lastResetAt, now + HOUR);

  // An old reading inside its window is still shown, marked stale.
  s = computeCodexStatus(db, cfg, now + 30 * 60_000);
  assert.equal(s.session?.stale, true);
});

const status = { now: Date.now(), block: { resetsAt: Date.now() + 99 * HOUR } } as unknown as Status;
const codexWith = (over: Partial<CodexStatus> = {}): CodexStatus => {
  const db = openDb(':memory:');
  return { ...computeCodexStatus(db, { usageMaxAgeMs: 15 * 60_000 }), ...over };
};
const window = (usedPct: number, resetsAt = Date.now() + HOUR) => ({
  usedPct, resetsAt, windowMinutes: 300, start: resetsAt - 300 * 60_000, source: 'reported' as const,
  via: 'app-server' as const, readAt: Date.now(), ageMs: 0, stale: false,
});

test('a Codex job waits on the reserve, not on a dollar estimate', () => {
  const cfg = { ...loadConfig(), reservePct: 10 };
  const now = Date.now();
  assert.equal(decideCodex(cfg, job(), codexWith({ session: window(50) }), now).run, true);
  const held = decideCodex(cfg, job(), codexWith({ session: window(92) }), now);
  assert.equal(held.run, false);
  assert.match(held.reason, /reserve keeps the last 10%/);
  assert.equal(decideCodex(cfg, job({ urgent: true }), codexWith({ session: window(92) }), now).run, true, 'urgent spends the reserve');
  assert.equal(decideCodex(cfg, job(), codexWith({ session: window(10), limitReached: 'rate_limit_reached' }), now).run, false);
  assert.equal(decideCodex(cfg, job(), codexWith({ session: window(10), week: window(100) }), now).run, false);
  assert.equal(decideCodex(cfg, job(), codexWith(), now).run, true, 'no reading holds nothing back');
});

test('"when the window resets" means a Codex reset since the job was queued', () => {
  const cfg = { ...loadConfig(), reservePct: 10 };
  const now = Date.now();
  const queuedAt = now - 30 * 60_000;
  const onReset = job({ runPolicy: 'on-reset', createdAt: queuedAt });

  // The window open now started before the job was queued: wait.
  const waiting = decideCodex(cfg, onReset, codexWith({ session: window(30, now + HOUR) }), now);
  assert.equal(waiting.run, false);
  assert.match(waiting.reason, /Codex window that opens/);

  // A window that opened after it: go.
  assert.equal(decideCodex(cfg, onReset, codexWith({ session: window(1, now + 5 * HOUR - 60_000) }), now).run, true);
  // No current reading, but a reset announced earlier has passed since: go.
  assert.equal(decideCodex(cfg, onReset, codexWith({ lastResetAt: now - 60_000 }), now).run, true);
  // Nothing known at all: wait rather than guess.
  assert.equal(decideCodex(cfg, onReset, codexWith(), now).run, false);
});

test('a refused job does not trust a 0% reading taken before it was refused', () => {
  const cfg = { ...loadConfig(), reservePct: 10 };
  const now = Date.now();
  const refused = job({ status: 'deferred', runPolicy: 'on-reset', startedAt: now - 60_000 });
  const before = { ...window(0, now + 5 * HOUR), readAt: now - 5 * 60_000 };
  const after = { ...window(0, now + 5 * HOUR), readAt: now - 1_000 };
  assert.equal(decideCodex(cfg, refused, codexWith({ session: before }), now).run, false, 'that reading is older than the refusal');
  assert.equal(decideCodex(cfg, refused, codexWith({ session: after }), now).run, true, 'a reading since then says the window is open');
});

test('a job for an agent that was switched off waits, and says why', () => {
  const { db, cfg } = setup();
  const scheduler = new Scheduler(db, cfg, [createClaudeCodeProvider(cfg), createCodexProvider(cfg)], () => ({ claude: true, codex: false }));
  createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'edits', runPolicy: 'asap-if-headroom' });
  const [decision] = scheduler.explain();
  assert.equal(decision!.run, false);
  assert.match(decision!.reason, /Codex is switched off/);
});

test('a limited Codex job with nothing to announce the reset retries hourly instead of forever', () => {
  const cfg = { ...loadConfig(), reservePct: 10 };
  const now = Date.now();
  const deferred = (minutesAgo: number) => job({ status: 'deferred', runPolicy: 'asap-if-headroom', startedAt: now - minutesAgo * 60_000 });
  const soon = decideCodex(cfg, deferred(30), codexWith(), now);
  assert.equal(soon.run, false);
  assert.match(soon.reason, /trying again at/);
  assert.equal(decideCodex(cfg, deferred(61), codexWith(), now).run, true);
  // With a reading to go by, it waits for the real reset instead.
  assert.equal(decideCodex(cfg, deferred(61), codexWith({ session: window(100, now + HOUR) }), now).run, false);
});

test('the queue wakes at the Codex reset only for Codex jobs', () => {
  const now = Date.now();
  const later = codexWith({ session: window(95, now + 10 * 60_000) });
  assert.equal(nextWakeMs(status, [job()], now, later), 30_000, 'the heartbeat comes first');
  const soon = codexWith({ session: window(95, now + 5_000) });
  assert.equal(nextWakeMs(status, [job()], now, soon), 6_000);
  assert.equal(nextWakeMs(status, [job({ provider: 'claude-code' })], now, soon), 30_000, 'a Claude job does not care');
});

test('discovery looks past a bare PATH, as an application opened from the Finder has', async () => {
  const cfg = { ...loadConfig() };
  const exists = (p: string) => p === '/opt/homebrew/bin/codex';
  const found = await resolveCodex(cfg, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, 'darwin', exists, '/Users/someone');
  assert.equal(found.how, 'path');
  assert.equal(found.cfg.codexBin, '/opt/homebrew/bin/codex');
  assert.equal((await resolveCodex(cfg, { PATH: '/usr/bin' }, 'darwin', () => false, '/Users/someone')).how, 'unknown');
  assert.equal((await resolveCodex({ ...cfg, codexBin: '/opt/codex' }, {}, 'darwin', () => false, '/x')).how, 'configured');
});

test('a future snapshot cannot replace a current reading, reset, or probe', () => {
  const { cfg, db } = setup();
  const now = Date.now();
  saveCodexReading(db, reading({ at: now - 10, via: 'rollout', sessionPct: 35 }));
  saveCodexReading(db, reading({ at: now + HOUR, sessionPct: 90, sessionResetsAt: now - 1, limitReached: 'limited' }));
  const s = computeCodexStatus(db, cfg, now);
  assert.equal(s.session?.usedPct, 35);
  assert.equal(s.session?.via, 'rollout');
  assert.equal(s.lastResetAt, null);
  assert.equal(s.limitReached, null);
  assert.equal(s.probe, null);
});

test('a negative percentage is not a reading, but one past 100 is a full window, not an unknown one', () => {
  const { cfg, db } = setup();
  saveCodexReading(db, reading({ sessionPct: -1, weekPct: 101 }));
  const s = computeCodexStatus(db, cfg);
  assert.equal(s.session, null);
  assert.equal(s.week?.usedPct, 101, 'spent past the limit is still spent');
});

test('an undated reset flag expires with the window it was read from', () => {
  const { cfg, db } = setup();
  const now = Date.now();
  saveCodexReading(db, reading({ at: now - cfg.usageMaxAgeMs - 1, sessionResetsAt: null, limitReached: 'limited' }));
  assert.equal(computeCodexStatus(db, cfg, now).limitReached, null);
});

test('an idle rolling deadline is not a reset, but an untouched window is an open one', () => {
  const { cfg, db } = setup();
  const now = Date.now();
  const queued = job({ runPolicy: 'on-reset', createdAt: now - HOUR });
  // What OpenAI reports for a window nobody has started: 0%, reset five hours out.
  saveCodexReading(db, reading({ at: now, sessionPct: 0, sessionResetsAt: now + 5 * HOUR }));
  const s = computeCodexStatus(db, cfg, now);
  assert.equal(s.lastResetAt, null, 'a deadline that only moves forward is not a reset');
  const go = decideCodex(cfg, queued, s, now);
  assert.equal(go.run, true, 'the quota is already back: there is nothing to wait for');
  assert.match(go.reason, /untouched/);
  // Once that reading has expired there is nothing current to go by, and it waits for one.
  const later = computeCodexStatus(db, cfg, now + 5 * HOUR);
  assert.equal(later.lastResetAt, null);
  assert.equal(decideCodex(cfg, queued, later, now + 5 * HOUR).run, false);
});

test('an obsolete reset does not disable the hourly retry', () => {
  const { cfg } = setup();
  const now = Date.now();
  const deferred = job({ status: 'deferred', startedAt: now - HOUR });
  assert.equal(decideCodex(cfg, deferred, codexWith({ lastResetAt: now - 2 * HOUR }), now).run, true);
  assert.equal(decideCodex(cfg, job({ runPolicy: 'at', runAt: 0 }), codexWith(), now).run, true);
});

test('exec distinguishes noisy stderr, empty failures, and termination by signal', async () => {
  const provider = createCodexProvider(setup().cfg);
  try {
    for (const [mode, message] of [['noisy-crash', /invalid directory/], ['empty-failure', /turn failed/i], ['signal', /signal|exit/i]] as const) {
      process.env.TOKIO_FAKE_CODEX = mode;
      const r = await provider.execute(job(), { timeoutMs: 5000 });
      assert.equal(r.ok, false, mode);
      assert.equal(r.rateLimited, false, mode);
      assert.match(r.error ?? '', message);
    }
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('the probe waits for its outstanding request and accepts split replies', async () => {
  process.env.TOKIO_FAKE_CODEX = 'disordered';
  try {
    const r = await probeCodexLimits(setup().cfg, 5000);
    assert.equal(r.sessionPct, 42);
    assert.equal(r.error, null);
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('the probe and exec use the configured Codex home', async () => {
  const { cfg } = setup({ codexHome: '/fixture/configured-home' });
  process.env.TOKIO_FAKE_CODEX = 'check-home';
  try {
    assert.equal((await probeCodexLimits(cfg)).error, null);
    assert.equal((await createCodexProvider(cfg).execute(job(), { timeoutMs: 5000 })).ok, true);
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('stop during startup cancels the old probe without losing the restarted service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokio-service-'));
  const { cfg, db } = setup({ codexHome: home });
  const service = new CodexService(db, cfg, () => {});
  try {
    process.env.TOKIO_FAKE_CODEX = 'hang';
    const first = service.start();
    const stopped = service.stop();
    delete process.env.TOKIO_FAKE_CODEX;
    const restarted = service.start();
    assert.equal(service.start(), restarted, 'both callers await the same startup');
    await Promise.all([first, stopped, restarted]);
    assert.equal(service.running, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM codex_limits').get()?.n, 1);
    assert.equal(db.prepare('SELECT sessionPct FROM codex_limits').get()?.sessionPct, 42);
  } finally {
    delete process.env.TOKIO_FAKE_CODEX;
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('a timed-out app-server cannot survive by ignoring stdin and SIGTERM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokio-probe-'));
  const pidFile = join(dir, 'pid');
  process.env.TOKIO_FAKE_CODEX = 'stubborn';
  process.env.TOKIO_FAKE_PID_FILE = pidFile;
  let pid: number | undefined;
  try {
    const r = await probeCodexLimits(setup().cfg, 1200);
    assert.match(r.error ?? '', /timed out/);
    pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    delete process.env.TOKIO_FAKE_CODEX;
    delete process.env.TOKIO_FAKE_PID_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test('two schedulers claiming the same Codex job run it once', async () => {
  const { db, cfg, scheduler } = setup();
  const second = new Scheduler(db, cfg, createCodexProvider(cfg));
  const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'plan', runPolicy: 'manual' });
  await Promise.all([scheduler.run(queued), second.run(queued)]);
  assert.equal(getJob(db, queued.id)?.attempts, 1);
  assert.equal(getJob(db, queued.id)?.status, 'done');
});

test('a disabled higher-priority agent leaves the single slot to the other agent', async () => {
  const { db, cfg } = setup();
  const scheduler = new Scheduler(db, cfg, [createClaudeCodeProvider(cfg), createCodexProvider(cfg)], () => ({ claude: false, codex: true }));
  const params = { prompt: 'p', cwd: process.cwd(), safety: 'plan' as const, runPolicy: 'asap-if-headroom' as const };
  const claude = createJob(db, { ...params, provider: 'claude-code', priority: 10 });
  const codex = createJob(db, { ...params, provider: 'codex' });
  try {
    const finished = new Promise<void>((resolve) => scheduler.on('change', () => {
      if (!scheduler.busy.length) resolve();
    }));
    await scheduler.tick();
    assert.deepEqual(scheduler.busy, [codex.id]);
    await finished;
    assert.equal(getJob(db, codex.id)?.status, 'done');
    assert.equal(getJob(db, claude.id)?.attempts, 0);
  } finally { scheduler.stop(); }
});

test('Codex gives up on its fifth actual limit refusal', async () => {
  const { db, scheduler } = setup();
  const j = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'plan', runPolicy: 'manual' });
  db.prepare('UPDATE jobs SET attempts = 4 WHERE id = ?').run(j.id);
  process.env.TOKIO_FAKE_CODEX = 'ratelimit';
  try {
    await scheduler.run(j);
    assert.equal(getJob(db, j.id)?.status, 'failed');
    assert.equal(getJob(db, j.id)?.attempts, 5);
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('a turn can complete without a thread id, but an empty stream completes no job', async () => {
  const provider = createCodexProvider(setup().cfg);
  try {
    process.env.TOKIO_FAKE_CODEX = 'no-thread';
    const success = await provider.execute(job(), { timeoutMs: 5000 });
    assert.equal(success.ok, true);
    assert.equal(success.sessionId, null);
    process.env.TOKIO_FAKE_CODEX = 'silent';
    const failure = await provider.execute(job(), { timeoutMs: 5000 });
    assert.equal(failure.ok, false);
    assert.match(failure.error ?? '', /without completing/);
    const cancelled = await provider.execute(job(), { timeoutMs: 5000, signal: AbortSignal.abort() });
    assert.match(cancelled.error ?? '', /aborted/);
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('an early app-server exit reports its last diagnostic', async () => {
  process.env.TOKIO_FAKE_CODEX = 'exit-early';
  try {
    const r = await probeCodexLimits(setup().cfg, 5000);
    assert.equal(r.error, 'connection closed');
    assert.equal(r.sessionPct, null);
  } finally { delete process.env.TOKIO_FAKE_CODEX; }
});

test('CLI add resolves a relative folder and status labels a stale app-server reading', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'tokio-cli-'));
  const env = { ...process.env, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const run = (...args: string[]) => execFileSync(process.execPath, [
    '--no-warnings', '--experimental-strip-types', join(import.meta.dirname, '../src/cli.ts'), ...args,
  ], { cwd: dir, env, encoding: 'utf8' });
  try {
    await mkdir(join(dir, 'tokio'));
    await mkdir(join(dir, 'project'));
    await writeFile(join(dir, 'tokio/config.json'), JSON.stringify({
      providers: { claude: false, codex: true }, codexBin: FAKE, codexLauncher: [process.execPath], usageMaxAgeMs: 60_000,
    }));
    run('add', 'p', '--provider', 'codex', '--cwd', 'project', '--when', 'manual');
    const db = new DatabaseSync(join(dir, 'tokio/tokio.db'));
    try {
      assert.equal(db.prepare('SELECT cwd FROM jobs').get()?.cwd, join(dir, 'project'));
      saveCodexReading(db, reading({ at: Date.now() - 120_000, sessionPct: 27 }));
      saveCodexReading(db, reading({ error: 'offline' }));
    } finally { db.close(); }
    const status = run('status');
    assert.match(status, /27%.*read by app-server, 2 min ago/);
    assert.doesNotMatch(status, /\$[0-9]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local today includes both occurrences of the repeated hour at the DST change', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Madrid';
  try {
    const { cfg, db } = setup();
    const insert = db.prepare(`INSERT INTO codex_events(responseId,ts,model,inputTokens,cachedInputTokens,outputTokens,threadId)
      VALUES(?,?,'m',1,0,0,'t')`);
    for (const timestamp of ['2026-10-24T21:59:59Z', '2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      insert.run(timestamp, Date.parse(timestamp));
    }
    const s = computeCodexStatus(db, cfg, Date.parse('2026-10-25T22:59:59Z'));
    assert.equal(s.tokens.today.responses, 3);
    assert.equal(s.tokens.today.usd, null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('a weekly reset and a blind retry wake before the next heartbeat', () => {
  const now = Date.now();
  const s = codexWith({ week: window(100, now + 3000) });
  assert.equal(nextWakeMs(status, [job()], now, s), 4000);
  assert.equal(nextWakeMs(status, [job({ status: 'deferred', startedAt: now - HOUR + 2000 })], now, codexWith()), 2000);
});

test('a stale queue decision cannot claim a job cancelled by another client', async () => {
  const { db, scheduler } = setup();
  const queued = createJob(db, { provider: 'codex', prompt: 'p', cwd: process.cwd(), safety: 'plan' });
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(queued.id);
  await scheduler.run(queued);
  assert.equal(getJob(db, queued.id)?.status, 'cancelled');
  assert.equal(getJob(db, queued.id)?.attempts, 0);
});
