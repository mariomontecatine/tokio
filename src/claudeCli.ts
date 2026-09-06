import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Config } from './config.ts';

/** The shipped default, and the marker for "nobody has chosen". */
export const DEFAULT_BIN = 'claude';

/**
 * How to run Claude Code — as a command and its arguments, not as a name.
 *
 * A single binary name describes only one of the places Claude Code actually
 * lives. There are three, and they are all ordinary:
 *
 *   - Installed natively, on the same system as tokio. `claude` is on PATH and
 *     the transcripts are under this user's home. Nothing to configure.
 *   - Installed natively, but reached through a wrapper — a version manager, a
 *     container, `ssh` to a workstation that has the subscription.
 *   - Installed inside WSL while tokio runs on Windows. Windows can run it, but
 *     only as `wsl.exe -- claude`; there is no `claude` on the Windows PATH at
 *     all, and never will be.
 *
 * `claudeBin` alone cannot say the last two, because a command is a vector and
 * it is a string: there is nowhere to put `--`, a distro name, or a host. So a
 * launcher goes in front of it, and everything downstream builds its arguments
 * exactly as before.
 *
 * The launcher is a prefix rather than a shell string on purpose. Handing a
 * command line to a shell to be re-split is how a model name or a session id
 * with a metacharacter in it becomes something else — and while the prompt
 * itself is safe, since it goes over stdin rather than argv, that is a property
 * of today's `buildArgs` and not a guarantee anyone should build on.
 */
export function claudeInvocation(cfg: Config, args: string[]): { cmd: string; argv: string[] } {
  const launcher = (cfg.claudeLauncher ?? []).filter((part) => part.length > 0);
  if (launcher.length === 0) return { cmd: cfg.claudeBin, argv: args };
  return { cmd: launcher[0]!, argv: [...launcher.slice(1), cfg.claudeBin, ...args] };
}

/**
 * A launcher that reaches Claude Code inside WSL from Windows.
 *
 * Offered rather than assumed. `wsl.exe -- claude` runs in the default
 * distribution, which is right for the common case of one; naming a
 * distribution is `['wsl.exe', '-d', 'Ubuntu', '--']` and belongs in config,
 * because guessing which of someone's distributions holds their subscription is
 * not something this can get right.
 */
export const WSL_LAUNCHER: string[] = ['wsl.exe', '--'];

/**
 * Where Claude Code is, worked out rather than assumed.
 *
 * `claudeBin: 'claude'` is a fine default on a system where it is on PATH and
 * PATH means what POSIX says it means. Windows is not that system twice over:
 * an executable is only found by trying the extensions in PATHEXT, and the one
 * npm installs is a `.cmd` shim, which Node has refused to spawn directly since
 * the argument-injection fix in 18.20 — it has to go through a command
 * processor. And on a machine where Claude Code lives in WSL there is no
 * `claude` on the Windows PATH at all, at any extension.
 *
 * So discovery answers with an invocation, not a path: the binary *and* the
 * launcher needed to reach it. A configured `claudeBin` always wins, exactly as
 * a configured plan wins over a detected one — see `plans/detect.ts`.
 */
export interface Discovery {
  bin: string;
  launcher: string[] | null;
  /** How it was found, for the interface to say so rather than imply it. */
  how: 'path' | 'path-shim' | 'wsl';
}

/** `.CMD;.BAT;.EXE…` — what Windows appends to a bare name when looking. */
export function pathExtensions(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...raw.split(';').map((e) => e.trim()).filter(Boolean)];
}

/**
 * A shim has to be run by a command processor; a real executable does not.
 *
 * `cmd.exe /d /s /c` is the launcher rather than `shell: true`, because the
 * arguments stay separate entries in an argv the way they do everywhere else.
 * `shell: true` would flatten them into one string for Windows to re-split, and
 * re-splitting a string somebody else composed is the whole class of bug.
 */
const SHIM = /\.(cmd|bat)$/i;

export function invocationFor(file: string, platform: string): Discovery {
  if (platform === 'win32' && SHIM.test(file)) {
    return { bin: file, launcher: ['cmd.exe', '/d', '/s', '/c'], how: 'path-shim' };
  }
  return { bin: file, launcher: null, how: 'path' };
}

/**
 * Walk PATH for the command, honouring PATHEXT.
 *
 * `exists` is injected so this can be tested against a filesystem that is not
 * the one the test is running on — the whole point is behaviour on a platform
 * the suite is not executing on.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  exists: (p: string) => boolean,
): string | null {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathExtensions(env, platform)) {
      // Windows separators, on Windows. `join` from `node:path` would use the
      // host's, and this has to reason about a platform it may not be on.
      const slash = platform === 'win32' ? '\\' : '/';
      const candidate = `${dir.replace(/[\\/]$/, '')}${slash}${name}${ext}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Find Claude Code, natively first and inside WSL only as a fallback.
 *
 * The order is not arbitrary. A native install is faster, sees the Windows
 * filesystem the transcripts would also be read from, and needs no bridge; WSL
 * is the answer only when there is nothing on this side to find. Someone who
 * has both gets the native one, which is the same one their terminal gets.
 *
 * Returning `null` is a real answer and the caller must keep it: it means the
 * gauges cannot be read at all, which is worth saying out loud rather than
 * discovering through a spawn that fails every three minutes.
 */
export function discoverClaude(
  env: NodeJS.ProcessEnv,
  platform: string,
  exists: (p: string) => boolean,
): Discovery | null {
  const native = findOnPath('claude', env, platform, exists);
  if (native) return invocationFor(native, platform);

  if (platform !== 'win32') return null;

  // Only worth suggesting when WSL is actually installed. Whether Claude Code
  // is inside it cannot be answered without running something, so this is a
  // candidate rather than a finding — `available()` on the provider is where a
  // wrong guess surfaces, and it surfaces as a reason rather than a crash.
  const wsl = findOnPath('wsl', env, platform, exists);
  if (wsl) return { bin: 'claude', launcher: WSL_LAUNCHER, how: 'wsl' };

  return null;
}

/** Run something and read its stdout. Injected so no test reaches `wsl.exe`. */
export type Capture = (cmd: string, args: string[]) => Promise<string | null>;

/** `null` for anything that is not a clean exit: a failure is not an answer. */
export const captureStdout: Capture = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });

/**
 * Ask WSL where its Claude Code actually is.
 *
 * `wsl.exe -- claude` looks like it should work and does not: it runs the
 * command without a login shell, so the PATH assembled by `~/.profile` is not
 * there — and `~/.local/bin`, where Claude Code's own installer puts the
 * binary, is on PATH for precisely that reason. Measured on Windows against a
 * working install: `wsl.exe -- claude -p /usage` exits 127 with
 * `claude: command not found`, while the same CLI answers fine from a login
 * shell. Shipping `['wsl.exe', '--']` with a bare `claude` would therefore have
 * failed on the ordinary install and looked like Claude Code was missing.
 *
 * So a login shell is used once, to *locate* it, and the absolute path goes
 * into argv from then on. The shell never sees the caller's arguments: handing
 * a composed command line to something that will re-split it is the bug the
 * launcher exists to avoid, and that reasoning does not stop applying just
 * because the shell is convenient here.
 *
 * A shell function or an alias answers `command -v` with its own name rather
 * than a path, so anything that is not absolute is not an answer.
 */
export async function locateInWsl(capture: Capture = captureStdout): Promise<string | null> {
  const out = await capture('wsl.exe', ['--', 'bash', '-lc', 'command -v claude']);
  const first = (out ?? '').split('\n')[0]?.trim() ?? '';
  return first.startsWith('/') ? first : null;
}

/**
 * The config, with discovery filled in where the user has not spoken.
 *
 * A configured `claudeBin` always wins — the same rule the plan follows, for
 * the same reason: a value somebody set by hand is a decision, and a value we
 * worked out is a guess, however good. Discovery only ever fills the default.
 */
export function resolveClaude(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = (p) => existsSync(p),
): { cfg: Config; how: Discovery['how'] | 'configured' | 'unknown' } {
  const chosen = cfg.claudeBin !== DEFAULT_BIN || (cfg.claudeLauncher ?? []).length > 0;
  if (chosen) return { cfg, how: 'configured' };

  const found = discoverClaude(env, platform, exists);
  if (!found) return { cfg, how: 'unknown' };
  return { cfg: { ...cfg, claudeBin: found.bin, claudeLauncher: found.launcher }, how: found.how };
}

/**
 * The same answer, with the one part of it that cannot be read off a filesystem.
 *
 * `resolveClaude` stays synchronous and pure because everything it decides is
 * decidable from PATH and PATHEXT. The WSL branch is the exception: the presence
 * of `wsl.exe` says a bridge exists, not that Claude Code is on the far side of
 * it, and the only way to learn the difference is to ask. That is why the
 * synchronous version documents its WSL result as a candidate.
 *
 * Asking turns it into a finding, in both directions. When the binary is there
 * the absolute path replaces the bare name, which is what makes the invocation
 * work at all. When it is not, this reports `unknown` and hands back the config
 * untouched — a bridge to a distribution with no Claude Code in it is not a
 * place to run Claude Code, and saying so once at startup is the alternative to
 * a spawn that fails every three minutes.
 */
export async function resolveClaudeAsync(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = (p) => existsSync(p),
  capture: Capture = captureStdout,
): Promise<{ cfg: Config; how: Discovery['how'] | 'configured' | 'unknown' }> {
  const found = resolveClaude(cfg, env, platform, exists);
  if (found.how !== 'wsl') return found;

  const abs = await locateInWsl(capture);
  if (!abs) return { cfg, how: 'unknown' };
  return { cfg: { ...found.cfg, claudeBin: abs }, how: 'wsl' };
}
