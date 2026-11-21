import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CodexReading } from './parse.ts';
import { codexCredits, OPENAI_PRICES, pricingKey, type PriceRow } from './prices.ts';

type Db = DatabaseSync;

/**
 * Where Codex keeps its state: `$CODEX_HOME`, or `~/.codex`.
 *
 * A configured `codexHome` wins over the variable, the same rule `claudeDir`
 * follows: a value set by hand is a decision, the environment is a default.
 */
export function codexHome(cfg: { codexHome?: string | null }, env: NodeJS.ProcessEnv = process.env): string {
  return cfg.codexHome || env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Codex's tables, kept apart from Claude's on purpose.
 *
 * `events` feeds the five-hour window's credits, the cap tokio derives from
 * Anthropic's percentage, the burn rate, the payback and the estimator. A Codex
 * response in there would be spend against Anthropic's window that Anthropic
 * never saw, and the reprice there would put a GPT model on Claude's fallback
 * tier — an invented price. Nothing about the two meters is shared except the
 * idea, so nothing about their storage is either.
 */
const SCHEMA = `
-- One row per Codex model response, keyed on OpenAI's response id. Token counts
-- are stored as reported: input includes cached input, output includes
-- reasoning. serviceTier is the tier Codex recorded for the thread at that
-- point, null when it recorded none. credits is null when no published price
-- was in force, or the response did not run at Standard.
CREATE TABLE IF NOT EXISTS codex_events (
  responseId            TEXT PRIMARY KEY,
  ts                    INTEGER NOT NULL,
  model                 TEXT NOT NULL,
  inputTokens           INTEGER NOT NULL,
  cachedInputTokens     INTEGER NOT NULL,
  cacheWriteInputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens          INTEGER NOT NULL,
  reasoningOutputTokens INTEGER NOT NULL DEFAULT 0,
  credits               REAL,
  serviceTier           TEXT,
  threadId              TEXT NOT NULL,
  turnId                TEXT NOT NULL DEFAULT '',
  project               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS codex_events_ts ON codex_events (ts);
CREATE INDEX IF NOT EXISTS codex_events_thread ON codex_events (threadId);

-- Read offsets, plus what a usage record does not carry and a restart would
-- otherwise lose: the thread's directory, the model of the turn in progress,
-- and the service tier in force ('' while none has been recorded).
CREATE TABLE IF NOT EXISTS codex_files (
  path        TEXT PRIMARY KEY,
  offset      INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL DEFAULT 0,
  seenAt      INTEGER NOT NULL,
  threadId    TEXT NOT NULL DEFAULT '',
  cwd         TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  turnId      TEXT NOT NULL DEFAULT '',
  startedAt   INTEGER,
  subagent    INTEGER NOT NULL DEFAULT 0,
  serviceTier TEXT NOT NULL DEFAULT ''
);

-- What OpenAI said about the limits, and when. 'rollout' readings came with a
-- Codex turn; 'app-server' ones were asked for. Kept as a history, not pruned.
CREATE TABLE IF NOT EXISTS codex_limits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  via             TEXT NOT NULL,
  limitId         TEXT NOT NULL DEFAULT '',
  sessionPct      REAL,
  sessionResetsAt INTEGER,
  sessionMinutes  INTEGER,
  weekPct         REAL,
  weekResetsAt    INTEGER,
  weekMinutes     INTEGER,
  planType        TEXT,
  limitReached    TEXT,
  error           TEXT,
  UNIQUE (via, at, limitId)
);
CREATE INDEX IF NOT EXISTS codex_limits_at ON codex_limits (at);
`;

export function ensureCodexSchema(db: Db, table: readonly PriceRow[] = OPENAI_PRICES): void {
  db.exec(SCHEMA);
  const has = (tableName: string, column: string) =>
    Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${tableName}') WHERE name = ?`).get(column));
  if (!has('codex_files', 'identity')) db.exec("ALTER TABLE codex_files ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
  if (!has('codex_files', 'serviceTier')) db.exec("ALTER TABLE codex_files ADD COLUMN serviceTier TEXT NOT NULL DEFAULT ''");
  if (!has('codex_events', 'serviceTier')) db.exec('ALTER TABLE codex_events ADD COLUMN serviceTier TEXT');
  repriceCodexEvents(db, table);
}

function kvGet(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * Price every stored Codex response again, whenever the table has changed.
 *
 * The stamp is `pricingKey`, which covers the rows themselves, so a row added,
 * dated or corrected is picked up without anyone remembering a version. A
 * response stored before its model had a row gets its price this way. Each
 * one is priced at the row in force on its own date, so a correction fixes the
 * numbers and a real price change leaves earlier responses at the old price.
 */
export function repriceCodexEvents(db: Db, table: readonly PriceRow[] = OPENAI_PRICES, force = false): number {
  const key = 'codexPricingVersion';
  const stamp = pricingKey(table);
  if (!force && kvGet(db, key) === stamp) return 0;
  const rows = db
    .prepare('SELECT responseId, ts, model, inputTokens, cachedInputTokens, outputTokens, serviceTier FROM codex_events')
    .all() as unknown as {
      responseId: string; ts: number; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number;
      serviceTier: string | null;
    }[];
  const update = db.prepare('UPDATE codex_events SET credits = ? WHERE responseId = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) update.run(codexCredits(r, r.model, r.ts, r.serviceTier, table), r.responseId);
    kvSet(db, key, stamp);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function saveCodexReading(db: Db, r: CodexReading): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO codex_limits
        (at, via, limitId, sessionPct, sessionResetsAt, sessionMinutes, weekPct, weekResetsAt, weekMinutes, planType, limitReached, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      r.at, r.via, r.limitId, r.sessionPct, r.sessionResetsAt, r.sessionMinutes,
      r.weekPct, r.weekResetsAt, r.weekMinutes, r.planType, r.limitReached, r.error,
    );
  return Number(res.changes) > 0;
}

/**
 * Only the general Codex limit is drawn.
 *
 * A rollout's reading describes the bucket that turn was charged to, and a model
 * with an allowance of its own would report that one instead. Mixing them would
 * put one bucket's percentage on another's ring, so readings from any other
 * limit are stored and left alone. An empty id is an older Codex that did not
 * name its limit at all, which can only have been the general one.
 */
const GENERAL = "limitId IN ('codex', '')";

export function latestCodexRead(db: Db, which: 'session' | 'week', now = Date.now()): CodexReading | null {
  const column = which === 'session' ? 'sessionPct' : 'weekPct';
  const row = db
    .prepare(`SELECT * FROM codex_limits WHERE error IS NULL AND ${column} IS NOT NULL AND ${GENERAL} AND at <= ? ORDER BY at DESC LIMIT 1`)
    .get(now) as unknown as CodexReading | undefined;
  return row ?? null;
}

/** The newest reading of any kind that worked, for the plan name and the limit flag. */
export function latestCodexReading(db: Db, now = Date.now()): CodexReading | null {
  const row = db
    .prepare(`SELECT * FROM codex_limits WHERE error IS NULL AND ${GENERAL} AND at <= ? ORDER BY at DESC LIMIT 1`)
    .get(now) as unknown as CodexReading | undefined;
  return row ?? null;
}

/** The latest five-hour reset any reading announced that is now in the past. */
export function lastCodexReset(db: Db, now: number): number | null {
  const row = db
    .prepare(`SELECT MAX(sessionResetsAt) AS at FROM codex_limits WHERE error IS NULL AND ${GENERAL} AND sessionPct > 0 AND at <= ? AND sessionResetsAt > at AND sessionResetsAt <= ?`)
    .get(now, now) as { at: number | null };
  return row.at ?? null;
}

/** The last time the app server was asked, whether or not it answered. */
export function latestCodexAttempt(db: Db, now = Date.now()): CodexReading | null {
  const row = db
    .prepare("SELECT * FROM codex_limits WHERE via = 'app-server' AND at <= ? ORDER BY at DESC LIMIT 1")
    .get(now) as unknown as CodexReading | undefined;
  return row ?? null;
}
