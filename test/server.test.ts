import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';

// PATCH /api/config saves to disk, and configDir() reads XDG_CONFIG_HOME every
// time, so point it at a throwaway directory before anything can write. Without
// this the suite edits the config of whoever runs it.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tokio-test-config-'));
import { createServer } from '../src/server/index.ts';
import { Scheduler } from '../src/queue/scheduler.ts';
import { createClaudeCodeProvider } from '../src/providers/claudeCode.ts';

async function serverWith(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  const cfg: Config = { ...loadConfig(), ...overrides };
  const scheduler = new Scheduler(db, cfg, createClaudeCodeProvider(cfg));
  const app = await createServer({ db, cfg, scheduler, onChange: () => () => {} });
  return { app, db, cfg };
}

test('without a token configured the API is open, as on loopback', async () => {
  const { app } = await serverWith({ token: null });
  assert.equal((await app.inject({ method: 'GET', url: '/api/status' })).statusCode, 200);
  await app.close();
});

test('with a token, the API refuses requests that lack it', async () => {
  const { app } = await serverWith({ token: 'secret' });
  assert.equal((await app.inject({ method: 'GET', url: '/api/status' })).statusCode, 401);
  await app.close();
});

test('the token is accepted as a header', async () => {
  const { app } = await serverWith({ token: 'secret' });
  const header = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer secret' } });
  assert.equal(header.statusCode, 200);
  await app.close();
});

test('the query form of the token works only on the stream, which cannot send headers', async () => {
  const { app } = await serverWith({ token: 'secret' });
  // Query strings leak into proxy logs and Referer headers, so the exception is
  // confined to the one endpoint EventSource forces it on.
  const elsewhere = await app.inject({ method: 'GET', url: '/api/status?token=secret' });
  assert.equal(elsewhere.statusCode, 401);
  await app.close();
});

test('secrets are masked on the way out and a mask is never written back', async () => {
  const { app } = await serverWith({ token: 'secret' });
  const auth = { authorization: 'Bearer secret' };

  const shown = (await app.inject({ method: 'GET', url: '/api/config', headers: auth })).json();
  assert.notEqual(shown.token, 'secret');
  assert.doesNotMatch(JSON.stringify(shown), /secret/, 'no credential survives redaction');

  // Reading the config and writing it straight back must not save the mask
  // over the real value.
  await app.inject({
    method: 'PATCH', url: '/api/config', headers: auth,
    payload: { notify: { ...shown.notify, desktop: false } },
  });
  const after = (await app.inject({ method: 'GET', url: '/api/config', headers: auth })).json();
  assert.equal(after.notify.desktop, false, 'the real edit lands');
  assert.equal(after.notify.telegramToken, shown.notify.telegramToken, 'the masked one does not');
  await app.close();
});

test('a wrong token is refused', async () => {
  const { app } = await serverWith({ token: 'secret' });
  const res = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer nope' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('queueing rejects a directory that does not exist', async () => {
  const { app } = await serverWith({ token: null });
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'do a thing', cwd: '/definitely/not/here', safety: 'edits' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no such directory/);
  await app.close();
});

test('an empty prompt is rejected', async () => {
  const { app } = await serverWith({ token: null });
  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: '   ', cwd: process.cwd() } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('a queued job comes back with an estimate attached', async () => {
  const { app } = await serverWith({ token: null });
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'run the tests', cwd: process.cwd(), safety: 'plan', runPolicy: 'manual' },
  });
  assert.equal(res.statusCode, 201);
  const job = res.json();
  assert.ok(job.estimateP50 > 0);
  assert.ok(job.estimateP90 >= job.estimateP50);
  assert.ok(job.estimateBasis);
  await app.close();
});

test('the daemon check says no when nothing is listening', async () => {
  const { daemonRunning, apiBase, dashboardUrl } = await import('../src/net.ts');
  const cfg: Config = { ...loadConfig(), host: '127.0.0.1', port: 45999, token: null };
  // Port 45999 has nothing on it; this must fail fast rather than hang.
  const started = Date.now();
  assert.equal(await daemonRunning(cfg, 800), false);
  assert.ok(Date.now() - started < 3000, 'the check has to be quick — it runs before every bare `tokio`');
  assert.equal(apiBase(cfg), 'http://127.0.0.1:45999');
  assert.equal(dashboardUrl(cfg), 'http://127.0.0.1:45999');
});

test('a loopback dashboard URL carries no token, a remote one does', async () => {
  const { dashboardUrl } = await import('../src/net.ts');
  const base = loadConfig();
  assert.equal(
    dashboardUrl({ ...base, host: '127.0.0.1', port: 4646, token: 'secret' }),
    'http://127.0.0.1:4646',
    'no point pasting a token into a URL only this machine can open',
  );
  const remote = dashboardUrl({ ...base, host: '0.0.0.0', port: 4646, token: 'secret' });
  assert.match(remote, /\?token=secret$/);
  assert.doesNotMatch(remote, /0\.0\.0\.0/, 'nobody can open 0.0.0.0 — show a real address');
});

test('a queued prompt can be rewritten, and is re-priced when it is', async () => {
  const { app, db } = await serverWith({ token: null });
  const created = (await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'tidy the changelog', cwd: process.cwd(), model: 'sonnet', safety: 'plan', runPolicy: 'manual' },
  })).json();

  // Give the estimator something to say about jobs run this way, so the re-price
  // has somewhere to move to rather than landing back on the same default.
  const { bucketKey } = await import('../src/estimator/predict.ts');
  const bucket = bucketKey(process.cwd(), 'sonnet', 'edits', false);
  for (let i = 0; i < 5; i++) {
    db.prepare('INSERT INTO observations (ts, bucket, credits, promptChars) VALUES (?,?,?,0)')
      .run(Date.now(), bucket, 9);
  }

  const long = 'x'.repeat(4000);
  const edited = await app.inject({
    method: 'PATCH', url: `/api/jobs/${created.id}`,
    payload: { prompt: `${long}\n\nand fix the tests`, promptBlocks: [long], safety: 'edits' },
  });
  assert.equal(edited.statusCode, 200);
  const job = edited.json();
  assert.match(job.prompt, /fix the tests/);
  assert.equal(job.safety, 'edits');
  assert.deepEqual(job.promptBlocks, [long], 'what was pasted stays folded away next time');
  // The estimate has to describe the job as it is now, not as it was queued.
  assert.notEqual(job.estimateP50, created.estimateP50);
  assert.equal(job.estimateP50, 9);
  assert.match(job.estimateBasis, /previous job/);
  await app.close();
});

test('an edit that would leave a job unable to run is refused', async () => {
  const { app } = await serverWith({ token: null });
  const created = (await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'x', cwd: process.cwd(), runPolicy: 'manual' },
  })).json();

  for (const payload of [{ prompt: '  ' }, { safety: 'yolo' }, { runPolicy: 'at' }]) {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/jobs/nope', payload: { prompt: 'x' } })).statusCode, 404);
  await app.close();
});

test('a finished job cannot be started again over the top of its own result', async () => {
  const { app, db } = await serverWith({ token: null });
  const created = (await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'x', cwd: process.cwd(), runPolicy: 'manual' },
  })).json();
  const { updateJob } = await import('../src/queue/store.ts');
  updateJob(db, created.id, { status: 'done', actualCredits: 1.5 });

  const res = await app.inject({ method: 'POST', url: `/api/jobs/${created.id}/run` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /done/);
  await app.close();
});

test('a setting the daemon cannot act on is refused rather than saved', async () => {
  const { app, cfg } = await serverWith({ token: null });
  const before = cfg.reservePct;
  for (const payload of [{ reservePct: 'lots' }, { concurrency: 0 }, { plan: 'platinum' }, { defaultSafety: 'yolo' }]) {
    const res = await app.inject({ method: 'PATCH', url: '/api/config', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(cfg.reservePct, before);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/config', payload: { reservePct: 25 } })).statusCode, 200);
  assert.equal(cfg.reservePct, 25);
  await app.close();
});

test('a job that has already run is a record, not a draft', async () => {
  const { app, db } = await serverWith({ token: null });
  const created = (await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { prompt: 'x', cwd: process.cwd(), runPolicy: 'manual' },
  })).json();
  const { updateJob } = await import('../src/queue/store.ts');
  updateJob(db, created.id, { status: 'failed', error: 'it blew up', output: 'half an answer' });

  // Rewriting the prompt alone would leave that error sitting under a prompt
  // that never produced it.
  const refused = await app.inject({ method: 'PATCH', url: `/api/jobs/${created.id}`, payload: { prompt: 'y' } });
  assert.equal(refused.statusCode, 409);

  // Putting it back in the queue in the same breath is the honest way to retry:
  // new prompt, and the last attempt's leavings cleared with it.
  const retried = await app.inject({
    method: 'PATCH', url: `/api/jobs/${created.id}`,
    payload: { prompt: 'y', status: 'queued' },
  });
  assert.equal(retried.statusCode, 200);
  const job = retried.json();
  assert.equal(job.status, 'queued');
  assert.equal(job.error, null);
  assert.equal(job.output, null);
  assert.equal(job.attempts, 0);
  await app.close();
});
