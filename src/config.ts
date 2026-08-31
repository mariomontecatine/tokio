import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { PlanId, Safety } from './types.ts';

export interface NotifyConfig {
  /** ntfy.sh topic name, e.g. "tokio-mario-7f3a". */
  ntfyTopic: string | null;
  ntfyServer: string;
  telegramToken: string | null;
  telegramChatId: string | null;
  webhook: string | null;
  desktop: boolean;
}

export interface Config {
  plan: PlanId;
  /** Only used when plan === 'custom'; USD-equivalent credits. */
  customCaps: { block: number; week: number; weekOpus: number | null } | null;
  host: string;
  port: number;
  /** Required when host is not loopback. */
  token: string | null;
  /** Defaults to ~/.claude (or $CLAUDE_CONFIG_DIR). */
  claudeConfigDir: string | null;
  claudeBin: string;
  defaultSafety: Safety;
  defaultModel: string | null;
  /** Don't start a job unless this much of the block would survive it. */
  reservePct: number;
  concurrency: number;
  blockHours: number;
  /** Fixed weekly reset anchor; null means a rolling 7-day window. */
  weeklyAnchor: { weekday: number; hour: number } | null;
  jobTimeoutMs: number;
  /** How often to ask Claude Code for the real percentages. */
  usagePollMs: number;
  /** Past this age a reading is treated as stale and the display falls back to estimates. */
  usageMaxAgeMs: number;
  /** ISO date you started paying, so the value report covers the right period. */
  subscriptionStartedAt: string | null;
  /** Monthly price, when it differs from the shipped profile (regional pricing, team seat). */
  planPriceUsd: number | null;
  notify: NotifyConfig;
}

const DEFAULTS: Config = {
  plan: 'max5',
  customCaps: null,
  host: '127.0.0.1',
  port: 4646,
  token: null,
  claudeConfigDir: null,
  claudeBin: 'claude',
  defaultSafety: 'edits',
  defaultModel: null,
  reservePct: 10,
  concurrency: 1,
  blockHours: 5,
  weeklyAnchor: null,
  jobTimeoutMs: 30 * 60 * 1000,
  usagePollMs: 3 * 60 * 1000,
  usageMaxAgeMs: 15 * 60 * 1000,
  subscriptionStartedAt: null,
  planPriceUsd: null,
  notify: {
    ntfyTopic: null,
    ntfyServer: 'https://ntfy.sh',
    telegramToken: null,
    telegramChatId: null,
    webhook: null,
    desktop: true,
  },
};

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tokio');
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'tokio');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function claudeDir(cfg: Config): string {
  return cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    return { ...DEFAULTS, ...raw, notify: { ...DEFAULTS.notify, ...(raw.notify ?? {}) } };
  } catch (err) {
    console.error(`tokio: ignoring malformed ${path}: ${(err as Error).message}`);
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

export { DEFAULTS as defaultConfig };
