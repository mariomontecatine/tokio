import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { pathExtensions, invocationFor, type Discovery } from '../claudeCli.ts';

/** The shipped default, and the marker for "nobody has chosen". */
export const DEFAULT_CODEX_BIN = 'codex';

/** How to run Codex: the same launcher-in-front shape as `claudeInvocation`. */
export function codexInvocation(cfg: Pick<Config, 'codexBin' | 'codexLauncher'>, args: string[]): { cmd: string; argv: string[] } {
  const launcher = (cfg.codexLauncher ?? []).filter((part) => part.length > 0);
  if (launcher.length === 0) return { cmd: cfg.codexBin, argv: args };
  return { cmd: launcher[0]!, argv: [...launcher.slice(1), cfg.codexBin, ...args] };
}

/**
 * Where command-line tools get installed when PATH does not say.
 *
 * An application opened from the Finder or the Dock does not get the shell's
 * PATH: it gets `/usr/bin:/bin:/usr/sbin:/sbin`, which holds neither Homebrew
 * nor anything npm put in place. Looking only on PATH would answer "not
 * installed" for a CLI that is sitting in `/opt/homebrew/bin` — the ordinary
 * install on a Mac. So the usual places are tried as well, after PATH, which
 * still wins when it has an answer.
 */
export function knownBinDirs(platform: string, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [env.APPDATA ? join(env.APPDATA, 'npm') : '', join(home, '.bun', 'bin'), join(home, '.volta', 'bin')].filter(Boolean);
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    '/usr/bin',
  ];
}

/** Look on PATH, then in the usual install directories. */
export async function binaryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function findBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  exists: (p: string) => boolean | Promise<boolean>,
  home: string,
): Promise<string | null> {
  const windows = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
  for (const dir of new Set([...dirs, ...knownBinDirs(platform, home, env)])) {
    for (const ext of pathExtensions(env, platform)) {
      const file = dir.replace(/[\\/]$/, '') + (windows ? '\\' : '/') + name + ext;
      if (await exists(file)) return file;
    }
  }
  return null;
}

/**
 * The config with the Codex CLI filled in where nobody chose one.
 *
 * Same rule as `resolveClaude`: a configured `codexBin` or launcher is a
 * decision and is left alone; discovery only replaces the default, and with an
 * absolute path, so the spawn does not depend on whatever PATH the daemon
 * happened to inherit.
 */
export async function resolveCodex(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean | Promise<boolean> = binaryExists,
  home: string = homedir(),
): Promise<{ cfg: Config; how: Discovery['how'] | 'configured' | 'unknown' }> {
  const chosen = cfg.codexBin !== DEFAULT_CODEX_BIN || (cfg.codexLauncher ?? []).length > 0;
  if (chosen) return { cfg, how: 'configured' };
  const file = await findBinary('codex', env, platform, exists, home);
  if (!file) return { cfg, how: 'unknown' };
  const found = invocationFor(file, platform);
  return { cfg: { ...cfg, codexBin: found.bin, codexLauncher: found.launcher }, how: found.how };
}
