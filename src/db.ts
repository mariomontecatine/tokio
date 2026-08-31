import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.ts';

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

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let cached: Db | null = null;

export function openDb(path?: string): Db {
  if (!path && cached) return cached;
  const file = path ?? join(dataDir(), 'tokio.db');
  if (file !== ':memory:') mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  if (!path) cached = db;
  return db;
}

export function getKv(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
