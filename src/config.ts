import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { PlanSetting, Safety } from './types.ts';

export interface NotifyConfig {
  /**
   * ntfy.sh topic, e.g. "tokio-4f9c2a1b". Anyone who knows a topic name can
   * read it, so pick an unguessable one — it is a shared secret, not a label.
   */
  ntfyTopic: string | null;
  ntfyServer: string;
  telegramToken: string | null;
  telegramChatId: string | null;
  webhook: string | null;
  desktop: boolean;
}

export interface Config {
  /** 'auto' reads the plan off your Claude account; see plans/detect.ts. */
  plan: PlanSetting;
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
  plan: 'auto',
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

/**
 * The config can hold an access token, a Telegram bot token and a webhook URL,
 * so it is written owner-only. `mode` on writeFileSync applies to a file it
 * creates; chmod covers the file that already existed with looser permissions.
 */
export function saveConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX permissions (a Windows mount) will refuse.
  }
}

/** Config keys that are credentials rather than settings. */
const SECRETS = ['token'] as const;
const NOTIFY_SECRETS = ['telegramToken', 'ntfyTopic', 'webhook'] as const;

/**
 * A copy safe to print or serve.
 *
 * `tokio config` output ends up in bug reports and screen shares, and
 * `/api/config` is read by a dashboard that may be open on a LAN. Neither has
 * any use for the secrets themselves — only for whether one is set — and a
 * webhook URL or an ntfy topic is a credential in its own right: knowing it is
 * all it takes to read or forge notifications.
 */
export function redactConfig(cfg: Config): Config {
  const mask = <T,>(value: T) => (value ? ('\u2022'.repeat(8) as unknown as T) : value);
  const out: Config = { ...cfg, notify: { ...cfg.notify } };
  for (const key of SECRETS) out[key] = mask(out[key]);
  for (const key of NOTIFY_SECRETS) out.notify[key] = mask(out.notify[key]);
  return out;
}

export { DEFAULTS as defaultConfig };
