import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { projectPathOf } from '../ingest/discover.ts';

export interface ProjectInfo {
  path: string;
  credits: number;
  lastUsed: number | null;
}

/** Projects Claude Code knows about, most recently used first. */
export function knownProjects(db: Db, claudeDir: string): ProjectInfo[] {
  const rows = db
    .prepare('SELECT project AS path, ROUND(SUM(credits), 2) AS credits, MAX(ts) AS lastUsed FROM events GROUP BY project')
    .all() as unknown as ProjectInfo[];
  // Projects Claude Code knows about but that have no billable usage yet still
  // belong in the picker.
  const seen = new Set(rows.map((r) => r.path));
  const root = join(claudeDir, 'projects');
  let slugs: string[] = [];
  try {
    slugs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    slugs = [];
  }
  for (const slug of slugs) {
    const path = projectPathOf(join(root, slug), slug);
    if (path && !seen.has(path)) {
      seen.add(path);
      rows.push({ path, credits: 0, lastUsed: null });
    }
  }
  return rows.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  updatedAt: number;
}

/**
 * Recent sessions for a project, with the human-readable titles Claude Code
 * writes into the transcript — so "resume the thing I was doing" is a pick from
 * a list rather than a UUID hunt.
 */
export function recentSessions(claudeDir: string, cwd: string, limit = 15): SessionInfo[] {
  const slug = cwd ? '-' + cwd.replace(/^\//, '').replace(/[/.]/g, '-') : '';
  const dir = join(claudeDir, 'projects', slug);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    const full = join(dir, file);
    let updatedAt = 0;
    try {
      updatedAt = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    let title = '';
    try {
      // Titles are near the top; reading the whole file for every session would
      // be wasteful, so cap it.
      const head = readFileSync(full, 'utf8').slice(0, 200_000);
      for (const line of head.split('\n')) {
        if (!line.includes('"ai-title"') && !line.includes('"aiTitle"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.aiTitle) title = String(parsed.aiTitle);
        } catch {
          // Truncated final line; ignore.
        }
      }
    } catch {
      // Unreadable transcript; still list the session by id.
    }
    sessions.push({ sessionId: file.replace(/\.jsonl$/, ''), title: title || '(untitled session)', updatedAt });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
