import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeInvocation, discoverClaude, findOnPath, resolveClaude, WSL_LAUNCHER } from '../src/claudeCli.ts';
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

// ---------- finding it, on a platform the suite is not running on ----------

/**
 * A filesystem that contains only what a case says it contains, and compares
 * paths the way Windows does.
 *
 * Case-insensitively, which is not a detail here: PATHEXT is conventionally
 * upper case (`.CMD`) and npm writes the shim in lower (`claude.cmd`), so a
 * case-sensitive model of Windows finds nothing and reports a bug that does not
 * exist on the platform it is pretending to be.
 */
const fs = (...present: string[]) => {
  const set = present.map((p) => p.toLowerCase());
  return (p: string) => set.includes(p.toLowerCase());
};

const WIN = {
  PATH: 'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

test('on Windows the shim is only found by trying PATHEXT', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';

  // With no extensions to try, the search is what `spawn('claude')` itself
  // does: look for a file called exactly that. There is none — which is the
  // whole reason a bare name works on every other platform and not this one.
  assert.equal(findOnPath('claude', { ...WIN, PATHEXT: '' }, 'win32', fs(shim)), null);

  // Trying them finds it. Compared case-insensitively because that is what a
  // Windows path comparison is: PATHEXT is conventionally upper case and npm
  // writes the file in lower, and the platform does not care.
  assert.equal(findOnPath('claude', WIN, 'win32', fs(shim))?.toLowerCase(), shim.toLowerCase());

  // And PATHEXT is defaulted rather than required, so a stripped environment —
  // a service, a scheduled task — does not silently stop finding it.
  assert.ok(findOnPath('claude', { PATH: WIN.PATH }, 'win32', fs(shim)));
});

test('an npm shim is run through a command processor, not a shell', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const found = discoverClaude(WIN, 'win32', fs(shim))!;
  assert.equal(found.how, 'path-shim');
  assert.deepEqual(found.launcher, ['cmd.exe', '/d', '/s', '/c']);

  // And the arguments stay separate entries, which is the entire reason this is
  // a launcher rather than `shell: true`.
  const { cmd, argv } = claudeInvocation(
    cfg({ claudeBin: found.bin, claudeLauncher: found.launcher }),
    ['-p', '/usage'],
  );
  assert.equal(cmd, 'cmd.exe');
  assert.deepEqual(
    argv.map((a) => a.toLowerCase()),
    ['/d', '/s', '/c', shim.toLowerCase(), '-p', '/usage'],
  );
});

test('a real executable needs no launcher', () => {
  const exe = 'C:\\Program Files\\claude\\claude.exe';
  const found = discoverClaude({ ...WIN, PATH: 'C:\\Program Files\\claude' }, 'win32', fs(exe))!;
  assert.equal(found.how, 'path');
  assert.equal(found.launcher, null);
});

test('native wins over WSL when both are there', () => {
  // Someone with Claude Code on Windows and in WSL gets the one their own
  // terminal gets, not a bridge into another filesystem.
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const found = discoverClaude(WIN, 'win32', fs(shim, 'C:\\Windows\\system32\\wsl.exe'))!;
  assert.equal(found.how, 'path-shim');
});

test('WSL is the fallback, and only when WSL is installed', () => {
  const wsl = 'C:\\Windows\\system32\\wsl.exe';
  const found = discoverClaude(WIN, 'win32', fs(wsl))!;
  assert.equal(found.how, 'wsl');
  assert.deepEqual(found.launcher, WSL_LAUNCHER);
  assert.equal(discoverClaude(WIN, 'win32', fs()), null, 'nothing to find is a real answer');
});

test('a configured binary is a decision and discovery does not touch it', () => {
  const set = cfg({ claudeBin: '/opt/claude/bin/claude' });
  const out = resolveClaude(set, WIN, 'win32', fs('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'));
  assert.equal(out.how, 'configured');
  assert.equal(out.cfg.claudeBin, '/opt/claude/bin/claude');
  assert.equal(out.cfg.claudeLauncher, null);
});

test('nothing found leaves the config alone and says so', () => {
  const out = resolveClaude(cfg(), { PATH: '/usr/bin' }, 'linux', fs());
  assert.equal(out.how, 'unknown');
  assert.equal(out.cfg.claudeBin, 'claude');
});
