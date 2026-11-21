import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type Db = DatabaseSync;

export interface CodexProject {
  path: string;
  credits: null;
  lastUsed: number | null;
}

/**
 * The directories Codex has worked in, most recent first.
 *
 * Read from what the ingestor already stored rather than from the rollouts:
 * the directory of every thread is on its row, and walking a few hundred
 * megabytes of transcripts to rebuild a picker is the kind of work the compose
 * panel must never cause.
 */
export function codexProjects(db: Db): CodexProject[] {
  return db
    .prepare(
      `SELECT cwd AS path, NULL AS credits, MAX(mtime) AS lastUsed FROM codex_files
       WHERE cwd <> '' AND subagent = 0 GROUP BY cwd ORDER BY lastUsed DESC`,
    )
    .all() as unknown as CodexProject[];
}

export interface CodexSession {
  sessionId: string;
  title: string;
  updatedAt: number;
}

/**
 * The names Codex gave its threads.
 *
 * `session_index.jsonl` is one line per rename, so the last line for an id is
 * its name now. A missing or unreadable index is not an error — the picker
 * labels a thread by when it was last used, which is what Claude's does for an
 * untitled session.
 */
async function threadNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let text = '';
  try {
    text = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id === 'string' && typeof entry.thread_name === 'string') names.set(entry.id, entry.thread_name);
    } catch {
      // A line being written; skip it.
    }
  }
  return names;
}

/** Threads that ran in a directory, newest first, for "continue this one". */
export async function codexSessions(db: Db, home: string, cwd: string, limit = 15): Promise<CodexSession[]> {
  const rows = db
    .prepare(
      `SELECT threadId AS sessionId, MAX(mtime) AS updatedAt FROM codex_files
       WHERE cwd = ? AND threadId <> '' AND subagent = 0 GROUP BY threadId ORDER BY updatedAt DESC LIMIT ?`,
    )
    .all(cwd, limit) as unknown as { sessionId: string; updatedAt: number }[];
  if (!rows.length) return [];
  const names = await threadNames(home);
  return rows.map((r) => ({ sessionId: r.sessionId, title: names.get(r.sessionId) ?? '', updatedAt: r.updatedAt }));
}
