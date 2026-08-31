import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { claudeDir } from './config.ts';
import type { Db } from './db.ts';
import type { ModelFamily } from './types.ts';

/**
 * The model a job will actually run on when none was given.
 *
 * Leaving this null makes every estimate fall into the "unknown" family, which
 * quietly produces nonsense (a Sonnet-priced guess for an Opus run), so fall
 * back to whatever Claude Code itself is configured to use.
 */
export function effectiveModel(cfg: Config): string | null {
  if (cfg.defaultModel) return cfg.defaultModel;
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir(cfg), 'settings.json'), 'utf8'));
    if (typeof settings.model === 'string' && settings.model) return settings.model;
  } catch {
    // No settings file, or not readable — fall through.
  }
  return null;
}

/** The family the user actually runs, used when the model is still unresolved. */
export function dominantFamily(db: Db, days = 7): ModelFamily | null {
  const row = db
    .prepare(
      `SELECT family FROM events WHERE ts >= ? AND family <> 'unknown'
       GROUP BY family ORDER BY SUM(credits) DESC LIMIT 1`,
    )
    .get(Date.now() - days * 24 * 3_600_000) as { family: ModelFamily } | undefined;
  return row?.family ?? null;
}
