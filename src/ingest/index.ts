import { EventEmitter } from 'node:events';
import { basename, dirname } from 'node:path';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { claudeDir } from '../config.ts';
import { discoverTranscripts, unslugProject } from './discover.ts';
import { tailFile } from './tail.ts';
import { parseEntry } from './parse.ts';
import type { UsageEvent } from '../types.ts';

const INSERT = `INSERT OR IGNORE INTO events
  (messageId, requestId, ts, model, family, inputTokens, outputTokens,
   cacheWrite5m, cacheWrite1h, cacheRead, webSearches, speed, inferenceGeo,
   credits, sessionId, project, turnId, source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Watches Claude Code's transcripts and mirrors billable usage into SQLite.
 *
 * Emits `usage` whenever new events land, so the dashboard can push an update
 * instead of polling.
 */
export class Ingestor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private watcher: { close(): Promise<void> } | null = null;
  private scanning = false;
  private db: Db;
  private cfg: Config;
  /** Last seen turn per transcript, so a turn survives across incremental reads. */
  private turns = new Map<string, string>();

  constructor(db: Db, cfg: Config) {
    super();
    this.db = db;
    this.cfg = cfg;
  }

  /** Full pass over every transcript. Cheap after the first run: offsets mean each byte is read once. */
  scan(): number {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const files = discoverTranscripts(claudeDir(this.cfg));
      const readOffset = this.db.prepare('SELECT offset FROM files WHERE path = ?');
      const saveOffset = this.db.prepare(
        `INSERT INTO files (path, offset, size, seenAt) VALUES (?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, seenAt = excluded.seenAt`,
      );
      const insert = this.db.prepare(INSERT);
      const saveTurn = this.db.prepare('INSERT OR IGNORE INTO turns (turnId, ts, project, chars) VALUES (?,?,?,?)');
      // Cost-state lines are cumulative snapshots, so the largest one wins.
      const saveSessionCost = this.db.prepare(
        `INSERT INTO session_costs (sessionId, usd, seenAt) VALUES (?,?,?)
         ON CONFLICT(sessionId) DO UPDATE SET usd = MAX(usd, excluded.usd), seenAt = excluded.seenAt`,
      );
      let inserted = 0;

      for (const file of files) {
        const row = readOffset.get(file) as { offset: number } | undefined;
        const { lines, offset, size } = tailFile(file, row?.offset ?? 0);
        if (!lines.length && offset === (row?.offset ?? 0)) continue;

        const fallback = unslugProject(basename(dirname(file)));
        // Lines arrive in order, so the most recent user prompt owns every
        // assistant call that follows it — that's what makes a turn.
        let turnId = this.turns.get(file) ?? '';
        const turnRows: { turnId: string; ts: number; project: string; chars: number }[] = [];
        const events: UsageEvent[] = [];
        for (const line of lines) {
          const parsed = parseEntry(line, fallback);
          if (!parsed) continue;
          if (parsed.kind === 'turn') {
            turnId = parsed.promptId;
            turnRows.push({ turnId, ts: parsed.ts, project: fallback, chars: parsed.chars });
            continue;
          }
          if (parsed.kind === 'session-cost') {
            saveSessionCost.run(parsed.sessionId, parsed.usd, Date.now());
            continue;
          }
          events.push({ ...parsed.event, turnId });
        }
        this.turns.set(file, turnId);
        for (const t of turnRows) saveTurn.run(t.turnId, t.ts, t.project, t.chars);
        if (events.length) {
          this.db.exec('BEGIN');
          try {
            for (const e of events) {
              const res = insert.run(
                e.messageId, e.requestId, e.ts, e.model, e.family, e.inputTokens, e.outputTokens,
                e.cacheWrite5m, e.cacheWrite1h, e.cacheRead, e.webSearches, e.speed, e.inferenceGeo,
                e.credits, e.sessionId, e.project, e.turnId, e.source,
              );
              inserted += Number(res.changes);
            }
            this.db.exec('COMMIT');
          } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
          }
        }
        saveOffset.run(file, offset, size, Date.now());
      }
      if (inserted > 0) this.emit('usage', inserted);
      return inserted;
    } finally {
      this.scanning = false;
    }
  }

  async start(): Promise<void> {
    this.scan();
    // chokidar catches the common case fast; the interval is the safety net for
    // WSL and network mounts where inotify events are unreliable.
    try {
      const { watch } = await import('chokidar');
      this.watcher = watch(join(claudeDir(this.cfg), 'projects'), {
        ignoreInitial: true,
        depth: 2,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      }).on('all', () => this.scan()) as unknown as { close(): Promise<void> };
    } catch {
      // chokidar is optional; the poll below is enough on its own.
    }
    this.timer = setInterval(() => this.scan(), 15_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
  }
}
