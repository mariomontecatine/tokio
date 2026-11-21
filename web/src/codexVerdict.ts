// `.ts` extensions, as in verdict.ts: this is arithmetic worth a test, and the
// suite runs it through Node's type stripping.
import type { CodexStatus, CodexWindow } from './api.ts';
import type { Translate } from './i18n.ts';
import { pressureOf, type Pressure } from './verdict.ts';
import { clock, pct } from './format.ts';

export interface CodexVerdict {
  line: string;
  detail: string | null;
  pressure: Pressure;
}

/**
 * Codex's one sentence.
 *
 * Shorter than Claude's on purpose. Claude's verdict projects a pace because
 * tokio has the transcripts and a cap to run that pace into; for Codex it has a
 * reported percentage and nothing to divide by, so the sentence says where the
 * window stands and when it lifts, and does not pretend to know when it runs out.
 */
export function readCodexVerdict(codex: CodexStatus, t: Translate): CodexVerdict {
  const session = codex.session;
  const resets = session?.resetsAt ? t('codex.verdict.resets', { time: clock(session.resetsAt) }) : null;
  if (codex.limitReached) return { line: t('codex.verdict.limit'), detail: resets, pressure: 'over' };
  if (codex.week && codex.week.usedPct >= 100) {
    const reset = codex.week.resetsAt;
    return { line: t('codex.verdict.weekFull'), detail: reset ? t('codex.verdict.resets', { time: clock(reset) }) : null, pressure: 'over' };
  }
  if (!session) return { line: t('codex.verdict.none'), detail: codex.probe?.error ?? null, pressure: 'ease' };
  const pressure = pressureOf(session.usedPct);
  return { line: t(session.stale ? 'codex.verdict.floor' : `codex.verdict.${pressure}`, { pct: pct(session.usedPct) }), detail: resets, pressure };
}

/** "1.24M", "860k", "312": enough to compare, never a column of digits. */
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** A disconnected dashboard still expires each reading on the server's clock. */
export function expireCodexWindows(codex: CodexStatus, now: number): CodexStatus {
  const current = (w: CodexWindow | null) => w && (w.expiresAt ?? w.resetsAt ?? Infinity) > now ? w : null;
  const session = current(codex.session);
  const week = current(codex.week);
  const latest = (codex.session?.readAt ?? -Infinity) >= (codex.week?.readAt ?? -Infinity) ? session : week;
  return { ...codex, session, week, limitReached: latest ? codex.limitReached : null };
}

export function codexSources(codex: CodexStatus) {
  return ([['session', codex.session], ['week', codex.week]] as const)
    .flatMap(([kind, reading]) => reading ? [{ kind, reading }] : []);
}
