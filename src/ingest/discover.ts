import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/** All Claude Code transcripts under `<claudeDir>/projects/<slug>/<sessionId>.jsonl`. */
export function discoverTranscripts(claudeDir: string): string[] {
  const root = join(claudeDir, 'projects');
  let slugs: string[];
  try {
    slugs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const slug of slugs) {
    try {
      for (const entry of readdirSync(join(root, slug), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(root, slug, entry.name));
      }
    } catch {
      // A project directory can vanish mid-scan; skip it.
    }
  }
  return files;
}

/**
 * `-home-alice-repos-widget` -> `/home/alice/repos/widget`.
 *
 * Lossy: a directory whose own name contains a hyphen (`mininet-agents`) comes
 * back with that hyphen turned into a slash, because the slug throws the
 * distinction away. Only for events that carry no `cwd`; prefer
 * `projectPathOf`, which reads the real path out of the transcript.
 */
export function unslugProject(slug: string): string {
  return slug.startsWith('-') ? '/' + slug.slice(1).replace(/-/g, '/') : slug;
}

/** The real working directory of a project, read from its newest transcript. */
export function projectPathOf(projectDir: string, slug: string): string {
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(projectDir, entry.name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return unslugProject(slug);
  }
  if (!newest) return unslugProject(slug);

  try {
    const fd = openSync(newest.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(65_536);
      const read = readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, read).toString('utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = JSON.parse(line).cwd;
          if (typeof cwd === 'string' && cwd) return cwd;
        } catch {
          // Truncated final line of the window we read; keep looking.
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable transcript; fall back to the slug.
  }
  return unslugProject(slug);
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
