import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeDir, type Config } from './config.ts';
import { binaryExists, findBinary } from './codex/cli.ts';
import { codexHome } from './codex/store.ts';

/**
 * Which coding agents are on this machine, as facts.
 *
 * Two kinds of evidence, because either alone misleads. The binary says the CLI
 * is installed; the home directory says it has been used. A Mac application
 * opened from the Finder sees almost nothing on PATH, so a missing binary there
 * is weak evidence — which is why the known install directories are tried as
 * well, and why a `~/.codex` with sessions in it counts on its own.
 */
export interface AgentFacts {
  /** The CLI, when it was found. */
  bin: string | null;
  /** Where its state lives. */
  home: string;
  homeExists: boolean;
  /** Either of the two. What the first-run question ticks by default. */
  found: boolean;
}

export interface Agents {
  claude: AgentFacts;
  codex: AgentFacts;
}

export interface DetectDeps {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  /** Checks each PATH candidate without blocking the daemon. */
  exists: (p: string) => boolean | Promise<boolean>;
  /** Asynchronous, for the state directories, which can sit across the WSL bridge. */
  isDir: (p: string) => Promise<boolean>;
}

const defaults: DetectDeps = {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: binaryExists,
  isDir: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
};

const isPath = (bin: string) => bin.includes('/') || bin.includes('\\');

export async function detectAgents(cfg: Config, deps: Partial<DetectDeps> = {}): Promise<Agents> {
  const d = { ...defaults, ...deps };

  async function locate(bin: string, launcher: string[] | null, legacy?: string): Promise<string | null> {
    if (launcher?.some((part) => part.length > 0)) return bin;
    if (isPath(bin)) return await d.exists(bin) ? bin : null;
    const found = await findBinary(bin, d.env, d.platform, d.exists, d.home);
    return found ?? (legacy && await d.exists(legacy) ? legacy : null);
  }
  const claudeBin = await locate(cfg.claudeBin, cfg.claudeLauncher,
    cfg.claudeBin === 'claude' ? join(d.home, '.claude', 'local', 'claude') : undefined);
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || claudeDir(cfg);
  const claudeHomeExists = await d.isDir(join(claudeHome, 'projects'));
  const codexBin = await locate(cfg.codexBin, cfg.codexLauncher);
  const home = codexHome(cfg, d.env);
  const codexHomeExists = await d.isDir(join(home, 'sessions')) || await d.isDir(join(home, 'archived_sessions'));

  return {
    claude: { bin: claudeBin, home: claudeHome, homeExists: claudeHomeExists, found: Boolean(claudeBin) || claudeHomeExists },
    codex: { bin: codexBin, home, homeExists: codexHomeExists, found: Boolean(codexBin) || codexHomeExists },
  };
}

export interface Providers {
  claude: boolean;
  codex: boolean;
  /** False until the person has answered the first-run question. */
  chosen: boolean;
}

/**
 * Which agents to meter and offer, right now.
 *
 * What the person said always wins. Before they have said anything, what was
 * found is shown, so the first screen is not empty while it asks; with nothing
 * found at all it falls back to Claude, which is what tokio always was. At least
 * one is always on — a dashboard of nothing is not a choice anyone makes.
 */
export function effectiveProviders(cfg: Pick<Config, 'providers'>, agents: Agents | null): Providers {
  if (cfg.providers) {
    const { claude, codex } = cfg.providers;
    return { claude: Boolean(claude) || !codex, codex: Boolean(codex), chosen: true };
  }
  if (!agents) return { claude: true, codex: false, chosen: false };
  const claude = agents.claude.found;
  const codex = agents.codex.found;
  return { claude: claude || !codex, codex, chosen: false };
}
