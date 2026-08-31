import type { Db } from '../db.ts';
import type { Cap, PlanId } from '../types.ts';
import type { Config } from '../config.ts';
import profiles from './profiles.json' with { type: 'json' };

export type WindowKind = 'block' | 'week' | 'weekOpus';

interface Profile { label: string; priceUsd: number; block: number; week: number; weekOpus: number | null }
// The file carries a `_note` documenting where the numbers came from.
const PROFILES = profiles as unknown as Record<string, Profile>;

export function planLabel(plan: PlanId): string {
  return PROFILES[plan]?.label ?? 'Custom';
}

/**
 * Shipped starting point for a cap, in USD-equivalent credits.
 *
 * Anthropic does not publish these numbers, so they are deliberately coarse:
 * they exist to give a new install something to draw, and are meant to be
 * replaced by calibration as soon as the user reads a real percentage off
 * Claude Code's own `/usage`.
 */
export function defaultCap(cfg: Config, kind: WindowKind): number | null {
  if (cfg.plan === 'custom' && cfg.customCaps) {
    return kind === 'block' ? cfg.customCaps.block : kind === 'week' ? cfg.customCaps.week : cfg.customCaps.weekOpus;
  }
  const p = PROFILES[cfg.plan] ?? PROFILES.max5!;
  return kind === 'block' ? p.block : kind === 'week' ? p.week : p.weekOpus;
}

const ANCHOR_TTL_MS = 30 * 24 * 3_600_000;

/**
 * Best available cap for a window.
 *
 * Calibration anchors win: each one is a direct reading of "Claude Code says
 * I'm at N%", which pins the cap exactly. The median of recent anchors absorbs
 * the rounding in that displayed percentage. Failing that, a limit we actually
 * hit is a hard lower bound, so the default is raised to meet it.
 */
export function resolveCap(db: Db, cfg: Config, kind: WindowKind): Cap {
  const fallback = defaultCap(cfg, kind) ?? 0;
  const since = Date.now() - ANCHOR_TTL_MS;
  const rows = db
    .prepare('SELECT impliedCap FROM anchors WHERE windowKind = ? AND ts >= ? ORDER BY impliedCap')
    .all(kind, since) as { impliedCap: number }[];

  if (rows.length) {
    const mid = Math.floor(rows.length / 2);
    const median = rows.length % 2 ? rows[mid]!.impliedCap : (rows[mid - 1]!.impliedCap + rows[mid]!.impliedCap) / 2;
    return { credits: median, basis: 'calibrated', anchors: rows.length };
  }

  const ceiling = db
    .prepare('SELECT MAX(credits) AS c FROM ceilings WHERE windowKind = ? AND ts >= ?')
    .get(kind, since) as { c: number | null } | undefined;
  if (ceiling?.c && ceiling.c > fallback) return { credits: ceiling.c, basis: 'calibrated', anchors: 0 };

  return { credits: fallback, basis: 'default' };
}

/** Record "Claude Code currently reports `pct`% used" against the credits we've counted. */
export function addAnchor(db: Db, kind: WindowKind, pct: number, creditsNow: number): number {
  if (pct <= 0 || pct > 100) throw new Error('percentage must be between 0 and 100');
  if (creditsNow <= 0) throw new Error('no usage counted in this window yet — run something first');
  const impliedCap = creditsNow / (pct / 100);
  db.prepare('INSERT INTO anchors (ts, windowKind, pct, credits, impliedCap) VALUES (?,?,?,?,?)')
    .run(Date.now(), kind, pct, creditsNow, impliedCap);
  return impliedCap;
}

export function addCeiling(db: Db, kind: WindowKind, credits: number): void {
  db.prepare('INSERT INTO ceilings (ts, windowKind, credits) VALUES (?,?,?)').run(Date.now(), kind, credits);
}
