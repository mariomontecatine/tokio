import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../config.ts';
import { claudeDir } from '../config.ts';
import type { PlanId } from '../types.ts';

/**
 * Which plan this machine's Claude account is on.
 *
 * Claude Code stores the account profile it fetched from Anthropic in
 * `.claude.json`, and the plan is in there — so the answer does not have to be
 * guessed or asked for. Two fields carry it, and both are needed:
 *
 *   organizationType          claude_pro | claude_max | team | enterprise
 *   organizationRateLimitTier default_claude_ai | default_claude_max_5x
 *                             | default_claude_max_20x
 *
 * The type says Pro or Max; only the tier separates Max 5× from Max 20×, which
 * matters because they differ by a factor of two in both price and limits.
 * Claude Code itself makes the same distinction the same way.
 *
 * This is a read of a file the user already has. Nothing is sent anywhere, and
 * nothing but the plan is taken from it.
 */
export interface DetectedPlan {
  plan: PlanId;
  /** The values it was read from, so the interface can show its work. */
  evidence: string;
}

interface Account {
  organizationType?: unknown;
  organizationRateLimitTier?: unknown;
  userRateLimitTier?: unknown;
}

/**
 * The account file that belongs to a `.claude` directory, one level up.
 *
 * Claude Code writes `.claude.json` into `CLAUDE_CONFIG_DIR` when one is set,
 * which is why the configured directory is looked in first. But a directory can
 * also be configured to point at an installation whose layout nobody changed —
 * transcripts inside WSL, reached from Windows — and there the account file sits
 * in the home directory *beside* `~/.claude`, not inside it. Without this, the
 * plan for that account silently fails to resolve and the payback quietly
 * disappears, which is the failure mode this project least wants.
 *
 * Only for a directory actually named `.claude`, so this cannot wander into the
 * parent of some unrelated path and read an account nobody pointed us at — the
 * rule the single-candidate list exists to keep.
 */
function beside(dir: string): string[] {
  return basename(dir) === '.claude' ? [join(dirname(dir), '.claude.json')] : [];
}

/**
 * Claude Code keeps this in the home directory, or in its config directory when
 * one is set.
 *
 * A configured directory still means we never fall back to *this* machine's
 * home: pointing tokio at one Claude installation and then reading the plan of
 * another would report numbers for an account nobody asked about. `beside` is
 * not that fallback — it stays within the installation that was pointed at.
 */
function accountFile(cfg: Config): Account | null {
  const configured = cfg.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR;
  const dir = claudeDir(cfg);
  const candidates = configured
    ? [join(dir, '.claude.json'), ...beside(dir)]
    : [join(homedir(), '.claude.json'), join(dir, '.claude.json')];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const account = parsed?.oauthAccount;
      if (account && typeof account === 'object') return account as Account;
    } catch {
      // Missing, unreadable or not JSON: try the next, then give up quietly.
      // Failing to detect a plan is a normal state, not an error.
    }
  }
  return null;
}

export function detectPlan(cfg: Config): DetectedPlan | null {
  const account = accountFile(cfg);
  if (!account) return null;

  const type = String(account.organizationType ?? '').toLowerCase();
  const tier = String(account.organizationRateLimitTier ?? account.userRateLimitTier ?? '').toLowerCase();
  const evidence = [type, tier].filter(Boolean).join(' · ');
  const says = (needle: string) => type.includes(needle) || tier.includes(needle);

  if (says('max')) {
    if (says('20x')) return { plan: 'max20', evidence };
    if (says('5x')) return { plan: 'max5', evidence };
    // Max, but nothing says which. The two differ by half, so guessing would
    // put a wrong price on every figure that follows. Better to admit it.
    return null;
  }
  if (says('pro')) return { plan: 'pro', evidence };

  // Team, Enterprise, an API key, or a shape we have not seen. None of them
  // maps onto a personal plan's price.
  return null;
}

export type PlanBasis = 'detected' | 'configured' | 'unknown';

export interface ResolvedPlan {
  plan: PlanId;
  basis: PlanBasis;
  evidence: string | null;
}

/**
 * The plan every other figure is computed against.
 *
 * `basis` travels with it all the way to the interface, because a detected plan
 * and a fallback are not the same claim. When nothing can be determined the
 * gauges still work — they come from Anthropic's own percentages and never
 * needed the plan — but the price is withheld rather than invented, so no
 * payback figure is built on a plan the user never confirmed.
 */
export function resolvePlan(cfg: Config): ResolvedPlan {
  if (cfg.plan !== 'auto') return { plan: cfg.plan, basis: 'configured', evidence: null };

  const found = detectPlan(cfg);
  if (found) return { plan: found.plan, basis: 'detected', evidence: found.evidence };

  // Something has to be drawn on the gauges before the first /usage reading.
  // Pro is the floor, so an unknown plan errs towards under-promising.
  return { plan: 'pro', basis: 'unknown', evidence: null };
}
