import { EventEmitter } from 'node:events';
import { basename, dirname } from 'node:path';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { claudeDirs } from '../config.ts';
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
 * A sweep reads the transcripts that are live, and all of them only now and then.
 *
 * Finding out whether a file grew costs an open, a stat and a close: nothing on
 * a local disk, a round trip each across the WSL bridge. Paid for a thousand
 * finished sessions on every sweep, that was the whole of the sweep's cost and
 * none of its value — a transcript nobody has written to in hours is not about
 * to change. So a sweep reads what was written recently plus anything it has
 * not seen before, and the full pass, which is what catches an old session
 * being resumed, comes round every ten minutes. Where the directory can be
 * watched, that resume is seen within a tenth of a second anyway.
 */
const FULL_SWEEP_MS = 10 * 60_000;
const LIVE_FOR_MS = 6 * 60 * 60_000;

/** Which transcripts a sweep reads. Exported for the tests: the rule is the point. */
export function sweepTargets(all: string[], mtimes: Map<string, number>, now: number, full: boolean): string[] {
  if (full) return all;
  return all.filter((file) => {
    const mtime = mtimes.get(file);
    return mtime === undefined || now - mtime < LIVE_FOR_MS;
  });
}

/**
 * Watches Claude Code's transcripts and mirrors billable usage into SQLite.
 *
 * Emits `usage` whenever new events land, so the dashboard can push an update
 * instead of polling.
 */
export class Ingestor extends EventEmitter {
  private sweepTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private watchers: { close(): Promise<void> }[] = [];
  private scanning = false;
  /** A change arrived mid-scan; whatever it was, it has not been read yet. */
  private again = false;
  /** Transcripts the watcher named. Empty with `sweepAll` set means "look at everything". */
  private touched = new Set<string>();
  private sweepAll = true;
  private lastUsageAt = 0;
  /** How long the last full pass took, so the sweep can pace itself. */
  private lastSweepMs = 0;
  /** When the last pass over every transcript began; see FULL_SWEEP_MS. */
  private lastFullAt = 0;
  /** Last write time of every transcript read, so a sweep can pass over the finished ones. */
  private mtimes = new Map<string, number>();
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
   * With no argument this is a sweep: every transcript on the first call and
   * every ten minutes after, the live ones in between (see FULL_SWEEP_MS). The
   * stored offsets mean each byte is only ever read once either way. With one,
   * it reads just the files the watcher named — the common case while you are
   * working, and the difference between touching one file and stat-ing every
   * session you have ever had.
   */
  async scan(only?: string[]): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    const startedAt = Date.now();
    try {
      const files = only ?? await this.sweepList();
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
        // A pass yields now, so it can still be running when the daemon shuts
        // down and closes the database; it stops rather than write after that.
        if (this.stopped) break;
        const row = readOffset.get(file) as { offset: number } | undefined;
        // The only await in the loop, and it comes before anything is written:
        // from here to the saved offset everything is synchronous, so nothing
        // else on this event loop can interleave with the transaction below.
        const { lines, offset, size, mtimeMs } = await tailFile(file, row?.offset ?? 0);
        this.mtimes.set(file, mtimeMs);
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
        // One transaction for the whole file, not one per row. These used to sit
        // outside it, so a first scan of a long history was thousands of
        // separate WAL commits -- the cheapest kind of slow, and invisible until
        // someone watched a cold start.
        if (turnRows.length || events.length) {
          this.db.exec('BEGIN');
          try {
            for (const t of turnRows) saveTurn.run(t.turnId, t.ts, t.project, t.chars);
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
      // Only a sweep measures the cost of a sweep; a targeted read of one file
      // the watcher named says nothing about what the next one will take.
      if (!only) this.lastSweepMs = Date.now() - startedAt;
      // Whatever arrived while this pass ran has not been read yet. A pass
      // yields to the event loop now, so changes land *during* one instead of
      // queueing behind it, and this is the one place that sees all of them.
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule();
      }
    }
  }

  /** Every transcript now and then, the live ones in between. See FULL_SWEEP_MS. */
  private async sweepList(): Promise<string[]> {
    const all = (await Promise.all(claudeDirs(this.cfg).map(discoverTranscripts))).flat();
    const now = Date.now();
    const full = now - this.lastFullAt >= FULL_SWEEP_MS;
    if (full) this.lastFullAt = now;
    return sweepTargets(all, this.mtimes, now, full);
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
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.scanning) {
      this.again = true;
      return;
    }
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.drain().catch((err) => console.error(`tokio: reading transcripts failed — ${err?.message ?? err}`));
    }, SETTLE_MS);
    this.settleTimer.unref();
  }

  private async drain(): Promise<void> {
    // A pass is still running — the tail of the previous drain, or the first
    // scan. It calls back when it ends, and what was asked for stays queued.
    if (this.scanning) {
      this.again = true;
      return;
    }
    const all = this.sweepAll;
    const files = [...this.touched];
    this.sweepAll = false;
    this.touched.clear();
    this.again = false;

    // The named files are read on their own, sweep or not. A sweep only reads
    // live transcripts, and a session resumed after hours is exactly the one it
    // would pass over — while the watcher has just said it changed.
    if (files.length) await this.scan(files);
    if (all) await this.scan();
  }

  /**
   * Never schedule a sweep sooner than the last one took to run.
   *
   * The busy interval assumes a sweep is nearly free, which it is on a local
   * disk and is not across the WSL bridge: 9p charges a round trip per file, so
   * a pass over a 975-file history costs about fourteen seconds whether or not
   * anything changed. Asking for one every five was asking for three at once —
   * the machine never stopped scanning, which is what the fan was reporting.
   *
   * Measuring instead of special-casing the platform: a fast filesystem keeps
   * the fast beat because its sweeps really are fast, and a slow one spaces
   * itself out by exactly as much as it costs. The doubling leaves the disk
   * idle at least half the time rather than merely not overlapping.
   */
  private sweepDelay(): number {
    const wanted = Date.now() - this.lastUsageAt < BUSY_FOR_MS ? SWEEP_BUSY_MS : SWEEP_IDLE_MS;
    return Math.max(wanted, this.lastSweepMs * 2);
  }

  private sweep = (): void => {
    if (this.stopped) return;
    this.sweepAll = true;
    this.request();
    this.sweepTimer = setTimeout(this.sweep, this.sweepDelay());
    this.sweepTimer.unref();
  };

  /**
   * Watch the transcripts where watching is possible, and let the sweep have
   * the rest.
   *
   * Which filesystems support change notification is not something to guess at
   * from a path. Transcripts inside WSL, read from Windows over
   * `\\wsl.localhost`, are on 9p: `fs.watch` there does not merely miss events,
   * it refuses outright with `EISDIR` and reports nothing ever again. So the
   * answer comes from behaviour rather than from a pattern — try the cheap way,
   * and believe the filesystem when it says no.
   *
   * What it must *not* do is answer no with polling. That fallback was here and
   * it cost more than the problem: chokidar's `usePolling` is `fs.watchFile` per
   * file, so a 975-transcript history became 975 stats every 700ms, across the
   * bridge, for as long as the application was open. Permanent load to avoid a
   * delay the sweep already covers — and the sweep now paces itself, so on the
   * filesystem that refuses to be watched it is both the cheaper answer and the
   * only one that scales with the history.
   *
   * The cost of that is latency, and it is worth naming: on a watched directory
   * a new response shows up in a tenth of a second, on an unwatched one within a
   * sweep. Nothing is missed either way.
   *
   * chokidar reports the refusal as an `error` *event*, which is why the
   * `try/catch` around it never saw it. An `error` event with no listener is
   * rethrown by EventEmitter, so what actually happened on Windows was not a
   * degraded watcher: it was the daemon going down at startup.
   */
  private async startWatching(dir: string): Promise<void> {
    try {
      const { watch } = await import('chokidar');
      const watcher = watch(dir, { ignoreInitial: true, depth: 2 });
      watcher.on('all', (_event: string, path?: string) => this.request(path));
      watcher.on('error', () => {
        if (this.stopped) return;
        void watcher.close().catch(() => {});
        this.watchers = this.watchers.filter((w) => w !== (watcher as unknown));
      });
      this.watchers.push(watcher as unknown as { close(): Promise<void> });
    } catch {
      // chokidar is optional; the sweep is enough on its own.
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.scan();
    // chokidar catches the common case within a tenth of a second; the sweep
    // stays the safety net under it, and is what carries the load on any
    // filesystem the watcher cannot read at all. No awaitWriteFinish: a
    // transcript is appended to for as long as a response takes, so waiting for
    // the writing to stop would hold every update back until the answer was
    // over — and a half-written last line is already handled by reading only as
    // far as the last newline.
    for (const dir of claudeDirs(this.cfg)) {
      await this.startWatching(join(dir, 'projects'));
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
    await Promise.all(this.watchers.map((w) => w.close().catch(() => {})));
    this.watchers = [];
  }
}
