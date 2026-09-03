import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.ts';
import { creditsFor } from './meter/weights.ts';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  messageId     TEXT NOT NULL,
  requestId     TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  model         TEXT NOT NULL,
  family        TEXT NOT NULL,
  inputTokens   INTEGER NOT NULL,
  outputTokens  INTEGER NOT NULL,
  cacheWrite5m  INTEGER NOT NULL,
  cacheWrite1h  INTEGER NOT NULL,
  cacheRead     INTEGER NOT NULL,
  webSearches   INTEGER NOT NULL DEFAULT 0,
  speed         TEXT NOT NULL DEFAULT 'standard',
  inferenceGeo  TEXT NOT NULL DEFAULT '',
  credits       REAL NOT NULL,
  sessionId     TEXT NOT NULL,
  project       TEXT NOT NULL,
  turnId        TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'transcript',
  PRIMARY KEY (messageId, requestId)
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_project ON events (project);
CREATE INDEX IF NOT EXISTS events_turn ON events (turnId);

-- Byte offsets so each transcript is only ever read forward.
CREATE TABLE IF NOT EXISTS files (
  path   TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  size   INTEGER NOT NULL,
  seenAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'claude-code',
  prompt          TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  model           TEXT,
  safety          TEXT NOT NULL,
  resumeSessionId TEXT,
  runPolicy       TEXT NOT NULL,
  runAt           INTEGER,
  priority        INTEGER NOT NULL DEFAULT 0,
  urgent          INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  estimateP50     REAL,
  estimateP90     REAL,
  estimateBasis   TEXT,
  actualCredits   REAL,
  resultSessionId TEXT,
  output          TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  createdAt       INTEGER NOT NULL,
  startedAt       INTEGER,
  finishedAt      INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, priority DESC, createdAt);

-- User-supplied readings of Claude Code's own /usage percentage.
CREATE TABLE IF NOT EXISTS anchors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  windowKind TEXT NOT NULL,
  pct        REAL NOT NULL,
  credits    REAL NOT NULL,
  impliedCap REAL NOT NULL
);

-- Lower bounds on a cap, recorded when a run actually hit the limit.
CREATE TABLE IF NOT EXISTS ceilings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  windowKind TEXT NOT NULL,
  credits    REAL NOT NULL
);

-- Historical cost of finished work, bucketed for the estimator.
CREATE TABLE IF NOT EXISTS observations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  bucket  TEXT NOT NULL,
  credits REAL NOT NULL,
  promptChars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS observations_bucket ON observations (bucket, ts);

-- One row per user prompt, so the estimator can relate prompt length to cost.
CREATE TABLE IF NOT EXISTS turns (
  turnId  TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  project TEXT NOT NULL,
  chars   INTEGER NOT NULL
);

-- The real numbers, as reported by Claude Code's own /usage command.
CREATE TABLE IF NOT EXISTS probes (
  at              INTEGER PRIMARY KEY,
  sessionPct      REAL,
  sessionResetsAt INTEGER,
  weekPct         REAL,
  weekResetsAt    INTEGER,
  opusPct         REAL,
  opusResetsAt    INTEGER,
  error           TEXT
);

-- Claude Code's own total for a session, lifted from the transcript. Not our
-- arithmetic, so it is kept apart from the events table and used only to check it.
CREATE TABLE IF NOT EXISTS session_costs (
  sessionId TEXT PRIMARY KEY,
  usd       REAL NOT NULL,
  seenAt    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Bump this whenever the price table changes.
 *
 * Credits are stored per event, so a correction to the rates would otherwise
 * only apply to future transcripts and leave months of history priced at the
 * old numbers — with nothing on screen to say which was which.
 */
const PRICING_VERSION = '3';

let cached: Db | null = null;

export function openDb(path?: string): Db {
  if (!path && cached) return cached;
  const file = path ?? join(dataDir(), 'tokio.db');
  if (file !== ':memory:') mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  addMissingColumns(db);
  repriceEvents(db);
  if (!path) cached = db;
  return db;
}

/** Columns added after the first release, for databases that predate them. */
function addMissingColumns(db: Db): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(events)').all() as unknown as { name: string }[]).map((c) => c.name),
  );
  const wanted: [string, string][] = [
    ['webSearches', "INTEGER NOT NULL DEFAULT 0"],
    ['speed', "TEXT NOT NULL DEFAULT 'standard'"],
    ['inferenceGeo', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, decl] of wanted) {
    if (!columns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${decl}`);
  }
}

/**
 * Re-price every stored event when the rates change.
 *
 * Token counts come from the API and never change; only what a token costs
 * does. Recomputing from the counts we already hold is exact, so history stops
 * being a museum of whatever the price table said the week it was ingested.
 */
function repriceEvents(db: Db): void {
  if (getKv(db, 'pricingVersion') === PRICING_VERSION) return;

  const rows = db
    .prepare(
      `SELECT messageId, requestId, model, inputTokens, outputTokens,
              cacheWrite5m, cacheWrite1h, cacheRead, webSearches, speed, inferenceGeo
       FROM events`,
    )
    .all() as unknown as (Omit<RepricedRow, 'credits'>)[];

  const update = db.prepare('UPDATE events SET credits = ? WHERE messageId = ? AND requestId = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const credits = creditsFor(
        {
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheWrite5m: r.cacheWrite5m,
          cacheWrite1h: r.cacheWrite1h,
          cacheRead: r.cacheRead,
          webSearches: r.webSearches,
        },
        r.model,
        { speed: r.speed, inferenceGeo: r.inferenceGeo },
      );
      update.run(credits, r.messageId, r.requestId);
    }
    // Calibration is recorded as "this many credits was that percentage", so a
    // change of rates leaves the stored cap describing money that no longer
    // exists. It cannot be converted — the error depends on which models the
    // window happened to use — so the anchors go, and the interface falls back
    // to saying the cap is a default until you calibrate again. Keeping them
    // would be keeping a wrong number that looks like a measured one.
    const stale = db.prepare('SELECT COUNT(*) AS n FROM anchors').get() as { n: number };
    if (stale.n > 0) {
      db.prepare('DELETE FROM anchors').run();
      db.prepare('DELETE FROM ceilings').run();
      console.error(`tokio: prices were corrected, so ${stale.n} calibration anchor(s) no longer mean anything and were cleared. Run "tokio calibrate <pct>" to set it again.`);
    }
    setKv(db, 'pricingVersion', PRICING_VERSION);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

interface RepricedRow {
  messageId: string;
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  webSearches: number;
  speed: string;
  inferenceGeo: string;
  credits: number;
}

export function getKv(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
