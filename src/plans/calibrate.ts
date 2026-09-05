import type { Db } from '../db.ts';
import { resolvePlan } from './detect.ts';
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
  const { plan } = resolvePlan(cfg);
  if (plan === 'custom' && cfg.customCaps) {
    return kind === 'block' ? cfg.customCaps.block : kind === 'week' ? cfg.customCaps.week : cfg.customCaps.weekOpus;
  }
  const p = PROFILES[plan] ?? PROFILES.pro!;
  return kind === 'block' ? p.block : kind === 'week' ? p.week : p.weekOpus;
}

const ANCHOR_TTL_MS = 30 * 24 * 3_600_000;

/**
 * An anchor is a floor, not a measurement.
 *
 * It divides the credits *this machine* counted by a percentage covering
 * *the whole account*. Every prompt sent from claude.ai, from a phone, or from
 * another laptop moves the percentage and leaves no credits here, so the
 * division comes out small — and it can only ever come out small, because this
 * machine's spend is a subset of the account's. Contamination has a direction.
 *
 * So the estimator is the top of the distribution rather than its middle. The
 * median asks "what does a typical window imply", and every window shared with
 * a browser drags it down; the top asks "how large has this window ever had to
 * be", which is the question with an answer. The real damage was not a slightly
 * low cap: `advanceReported` divides live spend by it, so a cap four times too
 * small turned twelve minutes of Opus into fifty-three points and reported a
 * window as spent while Anthropic was still reporting 75%.
 *
 * The ninetieth percentile rather than the outright maximum, so that one freak
 * reading — a mispriced model, a reset landing mid-division — cannot set the
 * cap for a month on its own.
 */
function highAnchor(caps: number[]): number {
  const at = Math.min(caps.length - 1, Math.max(0, Math.ceil(caps.length * 0.9) - 1));
  return caps[at]!;
}

/**
 * Best available cap for a window.
 *
 * Calibration anchors win: each one is a direct reading of "Claude Code says
 * I'm at N%" against the spend we counted. Failing that, a limit we actually
 * hit is a hard lower bound, so the default is raised to meet it.
 */
export function resolveCap(db: Db, cfg: Config, kind: WindowKind): Cap {
  const fallback = defaultCap(cfg, kind) ?? 0;
  const since = Date.now() - ANCHOR_TTL_MS;
  const rows = db
    .prepare('SELECT impliedCap FROM anchors WHERE windowKind = ? AND ts >= ? ORDER BY impliedCap')
    .all(kind, since) as { impliedCap: number }[];

  if (rows.length) {
    return { credits: highAnchor(rows.map((r) => r.impliedCap)), basis: 'calibrated', anchors: rows.length };
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

/** Don't record more often than this: the percentage barely moves in between. */
const AUTO_ANCHOR_EVERY_MS = 30 * 60_000;
/** Keep the recent ones; the median of a few dozen is already stable. */
const KEEP_ANCHORS = 40;

/**
 * Below this, dividing by the percentage is unstable.
 *
 * The reported figure is a whole number, so at 2% the true value is anywhere in
 * a half-point band — a 25% error on the cap. By 15% that band is under 4%.
 */
const STABLE_PCT = 15;

/**
 * Turn a reported percentage into a remembered cap, without being asked.
 *
 * `/usage` states a real percentage several times an hour, and each one pins
 * the cap exactly: spend so far divided by the fraction used. Not recording
 * them meant that the moment a window was too young for the division to be
 * stable, the gauge fell back to a shipped guess — after hundreds of perfectly
 * good readings had already gone past. One bad guess is then dividing every
 * figure downstream of it.
 *
 * Recording them makes the shipped numbers matter only in the first busy window
 * of a fresh install, which is what a default is for.
 */
export function rememberReading(
  db: Db,
  kind: WindowKind,
  pct: number | null,
  credits: number,
  now = Date.now(),
): void {
  if (pct === null || pct < STABLE_PCT || pct > 100 || credits <= 0) return;

  const last = db
    .prepare('SELECT MAX(ts) AS at FROM anchors WHERE windowKind = ?')
    .get(kind) as { at: number | null };
  if (last.at !== null && now - last.at < AUTO_ANCHOR_EVERY_MS) return;

  db.prepare('INSERT INTO anchors (ts, windowKind, pct, credits, impliedCap) VALUES (?,?,?,?,?)')
    .run(now, kind, pct, credits, credits / (pct / 100));
  db.prepare(
    `DELETE FROM anchors WHERE windowKind = ? AND ts NOT IN
     (SELECT ts FROM anchors WHERE windowKind = ? ORDER BY ts DESC LIMIT ?)`,
  ).run(kind, kind, KEEP_ANCHORS);
}

export function addCeiling(db: Db, kind: WindowKind, credits: number): void {
  db.prepare('INSERT INTO ceilings (ts, windowKind, credits) VALUES (?,?,?)').run(Date.now(), kind, credits);
}
