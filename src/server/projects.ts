import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { projectPathOf } from '../ingest/discover.ts';

export interface ProjectInfo {
  path: string;
  credits: number;
  lastUsed: number | null;
}

/**
 * Where each project directory really points, once it has been read.
 *
 * Finding out means stat-ing every transcript in the folder to pick the newest,
 * and the compose panel asks on every load of the dashboard. Across the WSL
 * bridge that was a stat per transcript on the machine — about fifteen seconds
 * for a thousand of them, every time the window opened. A slug's directory does
 * not change what it points at, so the answer is kept for the life of the
 * daemon and a new project costs one read.
 */
const pathOfDir = new Map<string, string>();

/** Projects Claude Code knows about, most recently used first. */
export async function knownProjects(db: Db, claudeDir: string): Promise<ProjectInfo[]> {
  const rows = db
    .prepare('SELECT project AS path, ROUND(SUM(credits), 2) AS credits, MAX(ts) AS lastUsed FROM events GROUP BY project')
    .all() as unknown as ProjectInfo[];
  // Projects Claude Code knows about but that have no billable usage yet still
  // belong in the picker.
  const seen = new Set(rows.map((r) => r.path));
  const root = join(claudeDir, 'projects');
  let slugs: string[] = [];
  try {
    slugs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    slugs = [];
  }
  for (const slug of slugs) {
    const dir = join(root, slug);
    let path = pathOfDir.get(dir);
    if (path === undefined) {
      path = await projectPathOf(dir, slug);
      pathOfDir.set(dir, path);
    }
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

/** Titles are near the top; this much is enough to find one. */
const TITLE_WINDOW = 200_000;

/**
 * Recent sessions for a project, with the human-readable titles Claude Code
 * writes into the transcript — so "resume the thing I was doing" is a pick from
 * a list rather than a UUID hunt.
 */
export async function recentSessions(claudeDir: string, cwd: string, limit = 15): Promise<SessionInfo[]> {
  const slug = cwd ? '-' + cwd.replace(/^\//, '').replace(/[/.]/g, '-') : '';
  const dir = join(claudeDir, 'projects', slug);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const dated: { file: string; updatedAt: number }[] = [];
  for (const file of files) {
    try {
      dated.push({ file, updatedAt: (await stat(join(dir, file))).mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  // Only the sessions that will be shown are opened. Reading a title out of
  // every transcript in the folder to then throw all but fifteen away was the
  // bulk of this call's cost, and all of it was the whole file, not its head.
  const newest = dated.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);

  const sessions: SessionInfo[] = [];
  for (const { file, updatedAt } of newest) {
    // Empty when Claude Code has not titled the session yet. Left empty on
    // purpose: a placeholder here would force every caller to show the same
    // useless words, and the timestamp is a far better label in a picker.
    sessions.push({ sessionId: file.replace(/\.jsonl$/, ''), title: await titleOf(join(dir, file)), updatedAt });
  }
  return sessions;
}

async function titleOf(path: string): Promise<string> {
  let title = '';
  try {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(TITLE_WINDOW);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.includes('"ai-title"') && !line.includes('"aiTitle"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.aiTitle) title = String(parsed.aiTitle);
        } catch {
          // Truncated final line; ignore.
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Unreadable transcript; still list the session by id.
  }
  return title;
}
