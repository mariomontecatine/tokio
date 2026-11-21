import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// CommonJS, like the rest of desktop/, so it is loaded the way daemon-host.js loads it.
const require = createRequire(import.meta.url);
const { parseMarked, mergePath, loginShellPath, adoptLoginShellPath, MARKER } = require('../desktop/shell-path.js');

// What launchd hands an application started from the Finder.
const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';

test('the PATH is read from between the markers, whatever the shell printed around it', () => {
  const noisy = `Last login: Fri\n[oh-my-zsh] update available\n${MARKER}/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin${MARKER}% `;
  assert.equal(parseMarked(noisy), '/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin');
});

test('output without both markers is not an answer', () => {
  assert.equal(parseMarked(''), null);
  assert.equal(parseMarked(`${MARKER}/usr/bin`), null);
  assert.equal(parseMarked(`${MARKER}${MARKER}`), null);
});

test("the shell's entries come first and nothing the process had is lost or repeated", () => {
  assert.equal(
    mergePath('/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin:/bin', LAUNCHD),
    '/Users/a/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  );
  assert.equal(mergePath(null, LAUNCHD), LAUNCHD);
});

test('a login shell is asked, and its answer reaches the environment', async () => {
  const calls: { shell: string; args: string[] }[] = [];
  const capture = async (shell: string, args: string[]) => {
    calls.push({ shell, args });
    return `motd\n${MARKER}/Users/a/.local/bin:/usr/bin${MARKER}`;
  };
  const env: Record<string, string> = { SHELL: '/bin/zsh', PATH: LAUNCHD };
  const found = await adoptLoginShellPath(env, { platform: 'darwin', capture });
  assert.equal(found, '/Users/a/.local/bin:/usr/bin');
  assert.equal(env.PATH, '/Users/a/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(calls[0]!.shell, '/bin/zsh');
  // Interactive and login, so both .zprofile and .zshrc have their say.
  assert.equal(calls[0]!.args[0], '-ilc');
});

test('a shell that fails or hangs leaves the PATH exactly as it was', async () => {
  const env: Record<string, string> = { SHELL: '/bin/zsh', PATH: LAUNCHD };
  assert.equal(await adoptLoginShellPath(env, { platform: 'darwin', capture: async () => null }), null);
  assert.equal(env.PATH, LAUNCHD);
});

test('Windows is left alone: applications there already inherit the PATH', async () => {
  let asked = false;
  const capture = async () => { asked = true; return `${MARKER}/x${MARKER}`; };
  assert.equal(await loginShellPath({ env: {}, platform: 'win32', capture }), null);
  assert.equal(asked, false);
});

test('with no SHELL set, macOS falls back to its default shell', async () => {
  let used = '';
  const capture = async (shell: string) => { used = shell; return null; };
  await loginShellPath({ env: {}, platform: 'darwin', capture });
  assert.equal(used, '/bin/zsh');
});
