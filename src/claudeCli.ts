import type { Config } from './config.ts';

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
