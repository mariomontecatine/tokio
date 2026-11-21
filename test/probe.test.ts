import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsageText, parseResetTime, probeUsage, rejectsNoSession } from '../src/usage/probe.ts';
import { defaultConfig, type Config } from '../src/config.ts';

const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 69% used · resets Sep 1, 1:19am (Europe/Madrid)
Current week (all models): 27% used · resets Sep 5, 8:59pm (Europe/Madrid)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 139 requests · 3 sessions
  43% of your usage was at >150k context`;

/**
 * The instant this capture was taken. Pinned on purpose: the reset times in
 * `/usage` carry no year, so they only mean anything relative to a "now", and a
 * test that used the wall clock would pass the day it was written and start
 * failing the day after.
 */
const CAPTURED_AT = Date.parse('2026-08-31T22:00:00Z');

test('it reads the real percentages and resets out of /usage', () => {
  const p = parseUsageText(REAL, CAPTURED_AT);
  assert.equal(p.sessionPct, 69);
  assert.equal(p.weekPct, 27);
  assert.equal(p.opusPct, null, 'this plan reports no separate Opus allowance');
  assert.ok(p.sessionResetsAt && p.weekResetsAt);
  assert.ok(p.weekResetsAt! > p.sessionResetsAt!);
});

test('an Opus allowance is picked up when the plan has one', () => {
  const p = parseUsageText(`${REAL}\nCurrent week (Opus): 41% used · resets Sep 5, 8:59pm (Europe/Madrid)`, CAPTURED_AT);
  assert.equal(p.opusPct, 41);
});

test('output with no percentages parses to nulls rather than guesses', () => {
  const p = parseUsageText('You are using an API key. Usage limits do not apply.');
  assert.equal(p.sessionPct, null);
  assert.equal(p.weekPct, null);
});

test('reset times are read without a year and placed in the future', () => {
  const now = Date.parse('2026-08-31T23:00:00');
  const at = parseResetTime('Sep 1, 1:19am (Europe/Madrid)', now)!;
  const d = new Date(at);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 1);
  assert.equal(d.getMinutes(), 19);
  assert.ok(at > now);
});

test('a reset that crosses new year lands in the following one', () => {
  const now = Date.parse('2026-12-31T23:30:00');
  const at = parseResetTime('Jan 1, 2:00am', now)!;
  assert.equal(new Date(at).getFullYear(), 2027);
});

test('midnight and noon are not confused', () => {
  const now = Date.parse('2026-08-31T10:00:00');
  assert.equal(new Date(parseResetTime('Sep 1, 12:00am', now)!).getHours(), 0);
  assert.equal(new Date(parseResetTime('Sep 1, 12:00pm', now)!).getHours(), 12);
  assert.equal(new Date(parseResetTime('Sep 1, 9pm', now)!).getHours(), 21);
});

test('an unparseable time is refused instead of guessed', () => {
  assert.equal(parseResetTime('sometime soon'), null);
  assert.equal(parseResetTime('Xxx 40, 99:99am'), null);
});

// ---- the read itself, against the fake CLI: no tokens, no real Claude Code ----

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const fakeCfg = (): Config => ({ ...defaultConfig, claudeBin: FAKE, claudeLauncher: [process.execPath] });

async function withFake<T>(mode: string | null, fn: (argsFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-probe-'));
  const argsFile = join(dir, 'args.txt');
  const before = { mode: process.env.TOKIO_FAKE_MODE, file: process.env.TOKIO_FAKE_ARGS_FILE };
  if (mode) process.env.TOKIO_FAKE_MODE = mode; else delete process.env.TOKIO_FAKE_MODE;
  process.env.TOKIO_FAKE_ARGS_FILE = argsFile;
  try {
    return await fn(argsFile);
  } finally {
    if (before.mode === undefined) delete process.env.TOKIO_FAKE_MODE; else process.env.TOKIO_FAKE_MODE = before.mode;
    if (before.file === undefined) delete process.env.TOKIO_FAKE_ARGS_FILE; else process.env.TOKIO_FAKE_ARGS_FILE = before.file;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a read asks Claude Code not to keep a session, so none piles up', async () => {
  await withFake(null, async (argsFile) => {
    const probe = await probeUsage(fakeCfg(), 10_000);
    assert.equal(probe.error, null);
    assert.equal(probe.sessionPct, 42);
    const calls = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /--no-session-persistence/);
  });
});

test('a CLI too old for the flag is asked again without it, rather than losing the gauges', async () => {
  await withFake('old-cli', async (argsFile) => {
    const probe = await probeUsage(fakeCfg(), 10_000);
    assert.equal(probe.error, null);
    assert.equal(probe.sessionPct, 42);
    assert.equal(probe.weekPct, 17);
    const calls = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1]!, /--no-session-persistence/);
  });
});

test('only a complaint about that flag triggers the second attempt', () => {
  assert.equal(rejectsNoSession("error: unknown option '--no-session-persistence'"), true);
  assert.equal(rejectsNoSession("error: unknown option '--frobnicate'"), false);
  assert.equal(rejectsNoSession('Invalid API key'), false);
});
