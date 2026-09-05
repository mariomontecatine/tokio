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
 * How long to let file events pile up before reading anything.
 *
 * A live transcript is appended to several times a second, and every append is
 * an event. Acting on each one meant a full pass over every transcript on the
 * machine several times a second while you were working — the one moment it
 * could least afford to. A tenth of a second of patience turns a burst into a
 * single read, and is imperceptible next to the seconds a response takes.
 */
const SETTLE_MS = 100;

/**
 * The safety net, for the file events that never arrive.
 *
 * inotify is unreliable on WSL and on network mounts, which is why there is a
 * sweep at all. It runs often while there is usage landing — that is when a
 * stale number is worth something to you — and backs off to a slow tick when
 * the machine has been quiet, where a sweep is work nobody asked for.
 */
const SWEEP_BUSY_MS = 5_000;
const SWEEP_IDLE_MS = 30_000;
const BUSY_FOR_MS = 2 * 60_000;

/**
 * Watches Claude Code's transcripts and mirrors billable usage into SQLite.
 *
 * Emits `usage` whenever new events land, so the dashboard can push an update
 * instead of polling.
 */
export class Ingestor extends EventEmitter {
  private sweepTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private watcher: { close(): Promise<void> } | null = null;
  private scanning = false;
  /** A change arrived mid-scan; whatever it was, it has not been read yet. */
  private again = false;
  /** Transcripts the watcher named. Empty with `sweepAll` set means "look at everything". */
  private touched = new Set<string>();
  private sweepAll = true;
  private lastUsageAt = 0;
  private stopped = false;
  private db: Db;
  private cfg: Config;
  /** Last seen turn per transcript, so a turn survives across incremental reads. */
  private turns = new Map<string, string>();

  constructor(db: Db, cfg: Config) {
    super();
    this.db = db;
    this.cfg = cfg;
  }

  /**
   * Read what has been appended.
   *
   * With no argument this is a full pass over every transcript, which stays
   * cheap after the first run because the stored offsets mean each byte is only
   * ever read once. With one, it reads just the files the watcher named — the
   * common case while you are working, and the difference between touching one
   * file and stat-ing every session you have ever had.
   */
  scan(only?: string[]): number {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const files = only ?? discoverTranscripts(claudeDir(this.cfg));
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
      if (inserted > 0) {
        this.lastUsageAt = Date.now();
        this.emit('usage', inserted);
      }
      return inserted;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Note that something changed, and read it once the burst is over.
   *
   * A file event during a scan is not lost: the scan already in flight may have
   * passed that file, so the change is remembered and read on the next pass
   * rather than waiting for the sweep to notice it minutes later.
   */
  private request(path?: string): void {
    if (this.stopped) return;
    if (path && path.endsWith('.jsonl')) this.touched.add(path);
    else this.sweepAll = true;

    if (this.scanning) {
      this.again = true;
      return;
    }
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.drain();
    }, SETTLE_MS);
    this.settleTimer.unref();
  }

  private drain(): void {
    const all = this.sweepAll;
    const files = [...this.touched];
    this.sweepAll = false;
    this.touched.clear();
    this.again = false;

    this.scan(all || !files.length ? undefined : files);

    if (this.again) this.request();
  }

  private sweepDelay(): number {
    return Date.now() - this.lastUsageAt < BUSY_FOR_MS ? SWEEP_BUSY_MS : SWEEP_IDLE_MS;
  }

  private sweep = (): void => {
    if (this.stopped) return;
    this.sweepAll = true;
    this.request();
    this.sweepTimer = setTimeout(this.sweep, this.sweepDelay());
    this.sweepTimer.unref();
  };

  async start(): Promise<void> {
    this.stopped = false;
    this.scan();
    // chokidar catches the common case within a tenth of a second; the sweep is
    // the safety net for WSL and network mounts, where inotify events are
    // unreliable. No awaitWriteFinish: a transcript is appended to for as long
    // as a response takes, so waiting for the writing to stop would hold every
    // update back until the answer was over — and a half-written last line is
    // already handled by reading only as far as the last newline.
    try {
      const { watch } = await import('chokidar');
      this.watcher = watch(join(claudeDir(this.cfg), 'projects'), {
        ignoreInitial: true,
        depth: 2,
      }).on('all', (_event: string, path?: string) => this.request(path)) as unknown as { close(): Promise<void> };
    } catch {
      // chokidar is optional; the sweep is enough on its own.
    }
    this.sweepTimer = setTimeout(this.sweep, this.sweepDelay());
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.sweepTimer = null;
    this.settleTimer = null;
    await this.watcher?.close();
    this.watcher = null;
  }
}
