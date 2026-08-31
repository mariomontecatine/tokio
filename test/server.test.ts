import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
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

test('the token is accepted as a header or as a query parameter', async () => {
  const { app } = await serverWith({ token: 'secret' });
  const header = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer secret' } });
  assert.equal(header.statusCode, 200);
  // EventSource cannot set headers, so the query form has to work too.
  const query = await app.inject({ method: 'GET', url: '/api/status?token=secret' });
  assert.equal(query.statusCode, 200);
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
