/**
 * The PATH a terminal would have, for a process the Finder started.
 *
 * An application opened from the Finder, the Dock or a login item is started by
 * launchd, and launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
 * else. The PATH people actually work with — `~/.local/bin`, where Claude
 * Code's installer puts `claude`, `/opt/homebrew/bin`, a version manager's
 * shims — is assembled by their login shell, which never ran. Measured on a Mac
 * by giving the daemon that environment: discovery reported no Claude Code at
 * all, and a queued job would have run without `node`, `npm` or `brew`. Started
 * from a terminal, as in development, everything worked, which is why it went
 * unnoticed. Windows has no such gap: applications there inherit the PATH the
 * system keeps.
 *
 * So the login shell is asked, once, before the daemon looks for anything. Its
 * answer goes first and whatever the process already had is kept after it.
 * Asked and not assumed, for the same reason `claudeCli.ts` asks WSL: which
 * directories somebody's shell adds is theirs to decide.
 *
 * The shell runs interactive and as a login shell (`-ilc`), because that is the
 * only way to get both `.zprofile` and `.zshrc`, and people put PATH in either.
 * Interactive shells print things — banners, prompts, theme warnings — so the
 * answer is fenced between two markers and everything else is ignored. A shell
 * that hangs or fails leaves the PATH as it was: a slower start is fine, a
 * daemon that never starts is not.
 */
const { spawn } = require('node:child_process');

const MARKER = '__TOKIO_PATH__';
const TIMEOUT_MS = 5000;

/** The PATH between the markers, or null when the output does not hold one. */
function parseMarked(out, marker = MARKER) {
  const start = out.indexOf(marker);
  if (start < 0) return null;
  const end = out.indexOf(marker, start + marker.length);
  if (end < 0) return null;
  const value = out.slice(start + marker.length, end).trim();
  return value || null;
}

/** The shell's entries first, then any the process had that the shell did not. */
function mergePath(shellPath, currentPath, delimiter = ':') {
  const seen = new Set();
  const out = [];
  for (const entry of [...(shellPath ?? '').split(delimiter), ...(currentPath ?? '').split(delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(delimiter);
}

/** Run something and collect its stdout; null on failure or timeout. Injected in tests. */
function captureShell(shell, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

/**
 * The login shell's PATH, or null if it could not be read.
 *
 * `capture` is injected so the suite never runs anybody's real shell: a login
 * shell reads the user's own startup files, and `npm test` must not touch the
 * machine it runs on.
 */
async function loginShellPath({ env = process.env, platform = process.platform, capture = captureShell, timeoutMs = TIMEOUT_MS } = {}) {
  if (platform === 'win32') return null;
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const out = await capture(shell, ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`], timeoutMs);
  return out === null ? null : parseMarked(out);
}

/** Put the login shell's PATH into `env` in place. Returns what it found, for logging. */
async function adoptLoginShellPath(env = process.env, options = {}) {
  const found = await loginShellPath({ env, ...options });
  if (found) env.PATH = mergePath(found, env.PATH);
  return found;
}

module.exports = { parseMarked, mergePath, loginShellPath, adoptLoginShellPath, MARKER };
