import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { configPath, loadConfig, type Config } from '../src/config.ts';

// PATCH /api/config writes the config file; point it somewhere disposable first.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tokio-test-config-'));
process.env.CLAUDE_CONFIG_DIR = join(process.env.XDG_CONFIG_HOME, 'claude');
import { createServer } from '../src/server/index.ts';
import { Scheduler } from '../src/queue/scheduler.ts';
import { createClaudeCodeProvider } from '../src/providers/claudeCode.ts';
import { createCodexProvider } from '../src/providers/codex.ts';
import { detectAgents, effectiveProviders, type Agents } from '../src/agents.ts';
import { CodexIngestor } from '../src/codex/ingest.ts';

const facts = (found: boolean) => ({ bin: found ? '/x/bin' : null, home: '/x', homeExists: false, found });
const agents = (claude: boolean, codex: boolean): Agents => ({ claude: facts(claude), codex: facts(codex) });

test('what was said wins; before that, what was found; and never nothing', () => {
  assert.deepEqual(effectiveProviders({ providers: { claude: false, codex: true } }, agents(true, false)), { claude: false, codex: true, chosen: true });
  assert.deepEqual(effectiveProviders({ providers: null }, agents(true, true)), { claude: true, codex: true, chosen: false });
  assert.deepEqual(effectiveProviders({ providers: null }, agents(false, true)), { claude: false, codex: true, chosen: false });
  assert.deepEqual(effectiveProviders({ providers: null }, agents(false, false)), { claude: true, codex: false, chosen: false });
  assert.deepEqual(effectiveProviders({ providers: null }, null), { claude: true, codex: false, chosen: false });
  assert.deepEqual(effectiveProviders({ providers: { claude: false, codex: false } }, null), { claude: true, codex: false, chosen: true });
});

test('detection finds a CLI the Finder PATH cannot see, and a home with sessions in it', async () => {
  const cfg = { ...loadConfig(), claudeConfigDir: '/home/u/.claude', codexHome: '/home/u/.codex' };
  const found = await detectAgents(cfg, {
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    platform: 'darwin',
    home: '/home/u',
    exists: (p) => p === '/opt/homebrew/bin/codex',
    isDir: async (p) => p === '/home/u/.codex/sessions',
  });
  assert.equal(found.codex.bin, '/opt/homebrew/bin/codex');
  assert.equal(found.codex.homeExists, true);
  assert.equal(found.codex.found, true);
  assert.equal(found.claude.found, false);
});

async function serverWith(overrides: Partial<Config> = {}, detected: Agents | undefined = agents(true, true)) {
  const db = openDb(':memory:');
  const cfg: Config = { ...loadConfig(), token: null, providers: null, claudeBin: join(import.meta.dirname, 'fake-claude.mjs'),
    claudeLauncher: [process.execPath], codexBin: join(import.meta.dirname, 'fake-codex.mjs'),
    codexLauncher: [process.execPath], codexHome: join(import.meta.dirname, 'fixtures', 'codex'), ...overrides };
  const scheduler = new Scheduler(db, cfg, [createClaudeCodeProvider(cfg), createCodexProvider(cfg)]);
  let changed = 0;
  const app = await createServer({ db, cfg, scheduler, onChange: () => () => {}, agents: detected, onProvidersChanged: () => (changed += 1) });
  return { app, db, cfg, changed: () => changed };
}

test('the status says which agents are on, and carries Codex only when it is', async () => {
  const { app } = await serverWith({ providers: { claude: true, codex: false } });
  const s = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.deepEqual(s.providers, { claude: true, codex: false, chosen: true });
  assert.equal(s.codex, null);
  await app.close();

  const both = await serverWith();
  const t = (await both.app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(t.providers.chosen, false, 'nobody has answered yet');
  assert.equal(t.codex.session, null, 'no reading, no number');
  assert.equal(t.codex.priced, true, 'OpenAI list prices ship in the table');
  assert.match(t.codex.pricesReadOn, /^\d{4}-\d{2}-\d{2}$/, 'and the interface is told when they were read');
  await both.app.close();
});

test('the providers answer is checked, saved, and handed to the daemon', async () => {
  const { app, cfg, changed } = await serverWith();
  const none = await app.inject({ method: 'PATCH', url: '/api/config', payload: { providers: { claude: false, codex: false } } });
  assert.equal(none.statusCode, 400, 'neither is not a choice');
  const bad = await app.inject({ method: 'PATCH', url: '/api/config', payload: { providers: { claude: 'yes', codex: true } } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'PATCH', url: '/api/config', payload: { providers: { claude: false, codex: true } } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(cfg.providers, { claude: false, codex: true });
  assert.deepEqual(loadConfig().providers, { claude: false, codex: true }, 'written to the (temporary) config file');
  assert.equal(changed(), 1);
  const agentsNow = (await app.inject({ method: 'GET', url: '/api/agents' })).json();
  assert.equal(agentsNow.providers.chosen, true);
  await app.close();
});

test('a Codex job is queued without a Claude model or a dollar estimate', async () => {
  const { app } = await serverWith();
  const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { provider: 'codex', prompt: 'tidy up', cwd: process.cwd(), runPolicy: 'manual' } });
  assert.equal(res.statusCode, 201);
  const job = res.json();
  assert.equal(job.provider, 'codex');
  assert.equal(job.model, null, "Codex's own default, not Claude's");
  assert.equal(job.estimateP50, null);

  const wrong = await app.inject({ method: 'POST', url: '/api/jobs', payload: { provider: 'gemini', prompt: 'x', cwd: process.cwd() } });
  assert.equal(wrong.statusCode, 400);

  const moved = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { provider: 'claude-code' } });
  assert.equal(moved.statusCode, 400, 'a queued job keeps its agent');
  const edited = await app.inject({ method: 'PATCH', url: `/api/jobs/${job.id}`, payload: { prompt: 'tidy up properly' } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().estimateP50, null, 'still nothing invented');

  const estimate = (await app.inject({ method: 'POST', url: '/api/estimate', payload: { provider: 'codex', prompt: 'x', cwd: process.cwd() } })).json();
  assert.equal(estimate.estimate, null);
  await app.close();
});

test('the Codex picker lists the directories and threads Codex worked in', async () => {
  const { app, db, cfg } = await serverWith();
  const home = mkdtempSync(join(tmpdir(), 'tokio-codex-picker-'));
  cpSync(join(import.meta.dirname, 'fixtures', 'codex'), home, { recursive: true });
  cfg.codexHome = home;
  await new CodexIngestor(db, home).scan();

  const projects = (await app.inject({ method: 'GET', url: '/api/projects?provider=codex' })).json();
  assert.ok(projects.every((p: any) => p.credits === null));
  assert.deepEqual(projects.map((p: any) => p.path).sort(), ['/home/test/gadget', '/home/test/widget']);
  const sessions = (await app.inject({ method: 'GET', url: `/api/sessions?provider=codex&cwd=${encodeURIComponent('/home/test/widget')}` })).json();
  assert.deepEqual(sessions.map((s: any) => s.sessionId), ['0f0e0d0c-0000-7000-8000-00000000000a']);
  await app.close();
});

test('detection checks the configured command name and archived-only homes', async () => {
  const cfg = { ...loadConfig(), codexBin: 'codex-custom', codexHome: '/x', claudeBin: '/gone' };
  const facts = await detectAgents(cfg, { env: { PATH: '/bin' }, platform: 'linux', home: '/empty',
    exists: async (path) => path === '/bin/codex-custom', isDir: async (path) => path === '/x/archived_sessions' });
  assert.equal(facts.claude.bin, null);
  assert.equal(facts.codex.bin, '/bin/codex-custom');
  assert.equal(facts.codex.homeExists, true);
});

test('job directories must be directories and an unspecified folder has no resumable threads', async () => {
  const { app, db } = await serverWith();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/jobs', payload: { provider: 'codex', prompt: 'p', cwd: import.meta.filename } });
    assert.equal(r.statusCode, 400);
    db.prepare("INSERT INTO codex_files(path,offset,size,seenAt,threadId) VALUES('unknown',1,1,1,'missing-cwd')").run();
    assert.deepEqual((await app.inject('/api/sessions?provider=codex')).json(), []);
  } finally { await app.close(); }
});

test('malformed provider and urgency inputs cannot select Claude or spend the reserve', async () => {
  const { app, cfg, changed } = await serverWith();
  try {
    for (const provider of [null, [], {}, false, 'other']) {
      for (const url of ['/api/jobs', '/api/estimate']) {
        assert.equal((await app.inject({ method: 'POST', url, payload: { provider, prompt: 'p' } })).statusCode, 400);
      }
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { provider: 'codex', prompt: 'p', urgent: 'false' } })).statusCode, 400);
    for (const payload of ['"invalid"', '[]', '{"providers":null}', '{"providers":[true,false]}']) {
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/config', payload, headers: { 'content-type': 'application/json' } })).statusCode, 400);
    }
    assert.equal(changed(), 0);
    assert.equal(cfg.providers, null);
  } finally { await app.close(); }
});

test('overlapping provider settings and reserve writes both survive a reload', async () => {
  const { app } = await serverWith();
  try {
    const requests = [{ providers: { codex: true, claude: false } }, { reservePct: 17 }];
    const replies = await Promise.all(requests.map((payload) => app.inject({ method: 'PATCH', url: '/api/config', payload })));
    assert.deepEqual(replies.map((r) => r.statusCode), [200, 200]);
    const cfg = loadConfig();
    assert.deepEqual(cfg.providers, requests[0]!.providers);
    assert.equal(cfg.reservePct, 17);
  } finally { await app.close(); }
});

test('the Codex dashboard routes can run with synchronous file reads disabled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-routes-'));
  const { app } = await serverWith({ plan: 'auto', claudeConfigDir: dir });
  const syncCalls: string[] = [];
  try {
    for (const key of ['readFileSync', 'existsSync', 'readdirSync', 'statSync'] as const) {
      const original = fs[key];
      t.mock.method(fs, key, (...args: any[]) => {
        if (typeof args[0] === 'string' && [dir, configPath(), process.cwd()].some((path) => args[0].startsWith(path))) syncCalls.push(key);
        return Reflect.apply(original, fs, args);
      });
    }
    syncBuiltinESMExports();
    for (const url of ['/api/status', '/api/agents', '/api/reach', '/api/projects?provider=codex', '/api/sessions?provider=codex']) {
      assert.equal((await app.inject(url)).statusCode, 200);
    }
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/config', payload: { providers: { codex: true, claude: false } } })).statusCode, 200);
    const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: { prompt: 'p', cwd: '.', provider: 'codex', runPolicy: 'manual' } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().cwd, process.cwd());
    assert.deepEqual(syncCalls, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await app.close();
  }
});

test('subagent work counts in tokens but is never offered as a resumable thread', async () => {
  const { app, cfg, db } = await serverWith();
  const home = mkdtempSync(join(tmpdir(), 'tokio-subagent-'));
  cfg.codexHome = home;
  try {
    const path = join(home, 'sub.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', payload: { id: 'child', cwd: '/sub', source: { subagent: { parent_thread_id: 'parent' } } } },
      { type: 'token_usage_record', timestamp: new Date().toISOString(), payload: { response_id: 'work', usage: { input_tokens: 8 } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await new CodexIngestor(db, home).scan([path]);
    assert.equal(db.prepare('SELECT SUM(inputTokens) AS n FROM codex_events').get()?.n, 8);
    assert.deepEqual((await app.inject('/api/sessions?provider=codex&cwd=/sub')).json(), []);
    assert.deepEqual((await app.inject('/api/projects?provider=codex')).json(), []);
  } finally { await app.close(); }
});

test('refresh asks only enabled providers and returns the Codex error', async () => {
  const { db, cfg, app: first } = await serverWith({ providers: { claude: false, codex: true } });
  await first.close();
  let claude = 0;
  let codex = 0;
  const app = await createServer({ db, cfg, scheduler: new Scheduler(db, cfg, createCodexProvider(cfg)), onChange: () => () => {},
    refresh: async () => { claude++; return { error: null }; },
    refreshCodex: async () => { codex++; return { error: 'offline' }; } });
  try {
    assert.deepEqual((await app.inject({ method: 'POST', url: '/api/refresh' })).json(), { ok: false, error: 'offline', codexError: 'offline' });
    assert.deepEqual([claude, codex], [0, 1]);
  } finally { await app.close(); }
});

test('reach reports a Codex history that appeared after startup detection', async () => {
  const { app } = await serverWith({}, agents(true, true));
  try {
    const facts = (await app.inject('/api/reach')).json();
    assert.ok(facts.codex.threads > 0);
    assert.equal(facts.codex.homeExists, true);
  } finally { await app.close(); }
});
