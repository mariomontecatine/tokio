import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeInvocation, WSL_LAUNCHER } from '../src/claudeCli.ts';
import { loadConfig, type Config } from '../src/config.ts';

const cfg = (over: Partial<Config> = {}): Config => ({ ...loadConfig(), ...over });

test('with nothing configured, the command is the binary and nothing else', () => {
  const { cmd, argv } = claudeInvocation(cfg(), ['-p', '/usage']);
  assert.equal(cmd, 'claude');
  assert.deepEqual(argv, ['-p', '/usage']);
});

test('a launcher runs the binary through it, arguments intact', () => {
  // Claude Code inside WSL, tokio on Windows: there is no `claude` on the
  // Windows PATH and there never will be.
  const { cmd, argv } = claudeInvocation(
    cfg({ claudeLauncher: WSL_LAUNCHER }),
    ['-p', '/usage', '--output-format', 'json'],
  );
  assert.equal(cmd, 'wsl.exe');
  assert.deepEqual(argv, ['--', 'claude', '-p', '/usage', '--output-format', 'json']);
});

test('a named distribution is just a longer launcher', () => {
  const { cmd, argv } = claudeInvocation(
    cfg({ claudeLauncher: ['wsl.exe', '-d', 'Ubuntu', '--'], claudeBin: '/home/me/.local/bin/claude' }),
    ['-p'],
  );
  assert.equal(cmd, 'wsl.exe');
  assert.deepEqual(argv, ['-d', 'Ubuntu', '--', '/home/me/.local/bin/claude', '-p']);
});

test('nothing is ever handed to a shell to be re-split', () => {
  // The launcher is a vector, so a value with a metacharacter in it stays one
  // argument instead of becoming two commands.
  const { argv } = claudeInvocation(cfg({ claudeLauncher: ['ssh', 'box'] }), ['--model', 'a; rm -rf /']);
  assert.deepEqual(argv, ['box', 'claude', '--model', 'a; rm -rf /']);
});

test('empty parts of a launcher are dropped rather than spawned', () => {
  const { cmd, argv } = claudeInvocation(cfg({ claudeLauncher: ['', 'wsl.exe', '', '--'] }), ['-p']);
  assert.equal(cmd, 'wsl.exe');
  assert.deepEqual(argv, ['--', 'claude', '-p']);
});

test('an empty launcher is the same as no launcher', () => {
  assert.equal(claudeInvocation(cfg({ claudeLauncher: [] }), []).cmd, 'claude');
});
