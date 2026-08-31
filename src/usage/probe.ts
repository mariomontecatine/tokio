import { spawn } from 'node:child_process';
import type { Config } from '../config.ts';

export interface UsageProbe {
  at: number;
  sessionPct: number | null;
  sessionResetsAt: number | null;
  weekPct: number | null;
  weekResetsAt: number | null;
  opusPct: number | null;
  opusResetsAt: number | null;
  /** Null when the probe worked. */
  error: string | null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Read "Sep 1, 1:19am (Europe/Madrid)" as a timestamp.
 *
 * The year is absent, so it's inferred: a date that lands in the past belongs
 * to next year. The zone is printed for the reader's benefit and is the same
 * zone this process runs in, so the string is parsed as local time.
 */
export function parseResetTime(text: string, now = Date.now()): number | null {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (month === undefined) return null;

  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const meridiem = m[5]!.toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const ref = new Date(now);
  const at = new Date(ref.getFullYear(), month, Number(m[2]), hour, minute, 0, 0);
  // A reset is always ahead of us; a date in the past means the year rolled over.
  if (at.getTime() < now - 24 * 3_600_000) at.setFullYear(ref.getFullYear() + 1);

  const ts = at.getTime();
  // Limits reset within days, so anything further out is a misparse.
  if (ts < now - 24 * 3_600_000 || ts > now + 32 * 24 * 3_600_000) return null;
  return ts;
}

function line(text: string, label: RegExp): { pct: number | null; resetsAt: number | null } {
  const m = label.exec(text);
  if (!m) return { pct: null, resetsAt: null };
  return { pct: Number(m[1]), resetsAt: parseResetTime(m[2] ?? '') };
}

/** Pull the real percentages out of what `claude -p "/usage"` prints. */
export function parseUsageText(text: string): Omit<UsageProbe, 'at' | 'error'> {
  const session = line(text, /Current session:\s*(\d+(?:\.\d+)?)%\s*used\s*·?\s*resets\s*([^\n]*)/i);
  const week = line(text, /Current week\s*\(all models\):\s*(\d+(?:\.\d+)?)%\s*used\s*·?\s*resets\s*([^\n]*)/i);
  const opus = line(text, /Current week\s*\(Opus[^)]*\):\s*(\d+(?:\.\d+)?)%\s*used\s*·?\s*resets\s*([^\n]*)/i);
  return {
    sessionPct: session.pct,
    sessionResetsAt: session.resetsAt,
    weekPct: week.pct,
    weekResetsAt: week.resetsAt,
    opusPct: opus.pct,
    opusResetsAt: opus.resetsAt,
  };
}

const EMPTY: Omit<UsageProbe, 'at' | 'error'> = {
  sessionPct: null, sessionResetsAt: null, weekPct: null, weekResetsAt: null, opusPct: null, opusResetsAt: null,
};

/**
 * Ask Claude Code for the real numbers.
 *
 * `/usage` is a local command that queries Anthropic directly: it reports no
 * turns and no cost, so this can be polled without spending anything. It is the
 * only source that knows the true percentage and the true reset time — every
 * local reconstruction is a guess next to it.
 */
export function probeUsage(cfg: Config, timeoutMs = 30_000): Promise<UsageProbe> {
  return new Promise((resolve) => {
    const child = spawn(cfg.claudeBin, ['-p', '/usage', '--output-format', 'json'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    const done = (probe: UsageProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ at: Date.now(), ...EMPTY, error: 'timed out asking Claude Code for /usage' });
    }, timeoutMs);

    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => done({ at: Date.now(), ...EMPTY, error: e.message }));

    child.on('close', () => {
      let text = '';
      try {
        text = String(JSON.parse(out).result ?? '');
      } catch {
        text = out;
      }
      const parsed = parseUsageText(text);
      const worked = parsed.sessionPct !== null || parsed.weekPct !== null;
      done({
        at: Date.now(),
        ...parsed,
        error: worked ? null : (err.trim() || 'could not read a percentage from /usage — are you on a subscription plan?'),
      });
    });
  });
}
