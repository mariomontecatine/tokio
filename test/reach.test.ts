import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDirs, loadConfig, type Config } from '../src/config.ts';
import { computeReach } from '../src/reach.ts';

const cfg = (over: Partial<Config> = {}): Config => ({ ...loadConfig(), ...over });

/** Restores whatever the environment had, so the suite stays reentrant. */
function withoutClaudeConfigDir<T>(fn: () => T): T {
  const had = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return fn();
  } finally {
    if (had !== undefined) process.env.CLAUDE_CONFIG_DIR = had;
  }
}

test('a second installation is read as well as the first', () => {
  // The fault this exists for: Claude Code installed twice — inside WSL and
  // natively — writes two sets of transcripts, and reading one silently drops
  // the other's spend. Measured before the fix: 29% of a window reported by
  // Anthropic against $0 of priced work, because the session being worked in
  // was the one not being read.
  withoutClaudeConfigDir(() => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'tokio-elsewhere-'));
    const dirs = claudeDirs(cfg({ claudeConfigDir: elsewhere }));

    assert.equal(dirs[0], elsewhere, 'the configured directory is read first');
    assert.ok(dirs.length <= 2, 'this machine has at most its own home to add');
    assert.equal(new Set(dirs).size, dirs.length, 'never the same directory twice');
  });
});

test('the home directory is not added to itself', () => {
  withoutClaudeConfigDir(() => {
    const home = join(homedir(), '.claude');
    assert.deepEqual(claudeDirs(cfg({ claudeConfigDir: home })), [home]);
  });
});

test('CLAUDE_CONFIG_DIR is a statement, so nothing is read beside it', () => {
  // Claude Code's own variable means "my configuration is here". Quietly
  // reading somewhere else as well would override something set on purpose.
  const had = process.env.CLAUDE_CONFIG_DIR;
  const only = mkdtempSync(join(tmpdir(), 'tokio-only-'));
  mkdirSync(join(only, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = only;
  try {
    assert.deepEqual(claudeDirs(cfg()), [only]);
  } finally {
    if (had === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = had;
  }
});

test('a plan nobody established is not reported as a plan', () => {
  // `resolvePlan` still answers 'pro' when the basis is unknown, because the
  // gauges need something to divide by. Passing that on would put "Pro" in
  // front of someone whose plan has never been read.
  const empty = mkdtempSync(join(tmpdir(), 'tokio-noplan-'));
  const reach = computeReach(cfg({ claudeConfigDir: empty, plan: 'auto' }), 'unknown');
  assert.equal(reach.plan.basis, 'unknown');
  assert.equal(reach.plan.id, null);
});

test('nothing found is reported as nothing, not as a default binary', () => {
  const reach = computeReach(cfg(), 'unknown');
  assert.equal(reach.claude.bin, null);
});

test('every directory reported carries whether it is across a boundary', () => {
  const reach = computeReach(cfg({ claudeConfigDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude' }), 'wsl');
  assert.equal(reach.transcripts[0]?.remote, true, 'a UNC path is another filesystem');
  assert.equal(reach.transcripts[0]?.projects, 0, 'a path that is not there has no projects');
});
