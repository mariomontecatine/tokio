import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { parseCodexLine, worthParsing, type CodexReading, type CodexUsage } from './parse.ts';
import { readChunk, CHUNK_BYTES } from './tail.ts';
import { codexCredits } from './prices.ts';
import { saveCodexReading } from './store.ts';
import { sweepTargets } from '../ingest/index.ts';

type Db = DatabaseSync;

/**
 * Every rollout Codex has written, active and archived.
 *
 * `sessions/YYYY/MM/DD/rollout-*.jsonl` is where threads live; archiving one
 * moves its file to `archived_sessions/`. An archived thread's usage still
 * happened, so both are read. A file that moves is read again under its new
 * path, and the `response_id` key is what keeps that from counting twice.
 *
 * Asynchronous, as everything that walks the disk on the daemon's path has to
 * be — see CLAUDE.md.
 */
export async function discoverRollouts(home: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) await walk(path, depth - 1);
      // `.jsonl.zst` is a rollout Codex compressed once it was finished.
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))) files.push(path);
    }
  };
  await walk(join(home, 'sessions'), 3);
  await walk(join(home, 'archived_sessions'), 3);
  // Oldest first, by the timestamp each name starts with, rather than in
  // whatever order the filesystem lists them. A fork copies its parent's
  // records into its own file without the turn that says which model made
  // them, so the parent should be read first — and when it is not, the insert
  // below lets the parent's better row replace the fork's.
  return files.sort((a, b) => basename(a).localeCompare(basename(b)));
}

interface FileState {
  identity: string;
  size: number;
  mtime: number;
  offset: number;
  threadId: string;
  cwd: string;
  model: string;
  turnId: string;
  startedAt: number | null;
  subagent: number;
  /** The service tier the latest settings line named; '' while none has. */
  serviceTier: string;
}

const EMPTY_FILE: FileState = {
  identity: '', size: 0, mtime: 0, offset: 0, threadId: '', cwd: '', model: '', turnId: '', startedAt: null, subagent: 0, serviceTier: '',
};

/**
 * One row per response, and the first copy wins — unless it did not know its
 * model and a later copy does. That is the fork case: the copied record sits in
 * a file with no `turn_context` for it, so it arrives as `unknown` with the
 * fork's directory and whatever tier the fork had named by then; the parent's
 * copy carries the turn's own, and replaces it. Counts are the same in every
 * copy, so nothing else is touched.
 */
const INSERT = `INSERT INTO codex_events
  (responseId, ts, model, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
   reasoningOutputTokens, credits, serviceTier, threadId, turnId, project)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(responseId) DO UPDATE SET model = excluded.model, credits = excluded.credits,
    serviceTier = excluded.serviceTier, threadId = excluded.threadId, project = excluded.project
  WHERE codex_events.model = 'unknown' AND excluded.model <> 'unknown'`;

const SAVE_FILE = `INSERT INTO codex_files (path, identity, offset, size, mtime, seenAt, threadId, cwd, model, turnId, startedAt, subagent, serviceTier)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET identity = excluded.identity, offset = excluded.offset, size = excluded.size, mtime = excluded.mtime,
    seenAt = excluded.seenAt, threadId = excluded.threadId, cwd = excluded.cwd, model = excluded.model,
    turnId = excluded.turnId, startedAt = excluded.startedAt, subagent = excluded.subagent, serviceTier = excluded.serviceTier`;

/** Said once per process, not on every sweep. */
let warnedNoZstd = false;
const warnedBadZst = new Set<string>();

/** The same pacing the Claude ingestor uses, for the same reasons; see there. */
const SETTLE_MS = 100;
const SWEEP_BUSY_MS = 5_000;
const SWEEP_IDLE_MS = 30_000;
const BUSY_FOR_MS = 2 * 60_000;
const FULL_SWEEP_MS = 10 * 60_000;

/**
 * Mirrors Codex usage and limit readings into SQLite.
 *
 * The counting rule is one row per `response_id`, from `token_usage_record`
 * lines only — never the running totals beside them. Each response's model is
 * the model of the turn it belongs to, from that turn's `turn_context`; the
 * model of the latest turn is kept with the file's offset, so a restart that
 * resumes halfway through a turn still knows what it was. So is the service
 * tier in force, which decides whether a response can be priced at all.
 *
 * Emits `usage` whenever rows or readings land.
 */
export class CodexIngestor extends EventEmitter {
  private db: Db;
  private home: string;
  private chunkBytes: number;
  private scanning = false;
  private again = false;
  private stopped = false;
  private touched = new Set<string>();
  private sweepAll = true;
  private settleTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private watchers: { close(): Promise<void> }[] = [];
  private lastUsageAt = 0;
  private lastSweepMs = 0;
  private lastFullAt = 0;
  private mtimes = new Map<string, number>();

  constructor(db: Db, home: string, chunkBytes = CHUNK_BYTES) {
    super();
    this.db = db;
    this.home = home;
    this.chunkBytes = chunkBytes;
  }

  /** Read what has been appended: everything named, or a sweep. Returns rows inserted. */
  async scan(only?: string[]): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    const startedAt = Date.now();
    let inserted = 0;
    let readings = 0;
    try {
      const files = only ?? (await this.sweepList());
      for (const file of files) {
        if (this.stopped) break;
        const result = await this.readFile(file);
        inserted += result.inserted;
        readings += result.readings;
      }
      if (inserted > 0 || readings > 0) {
        this.lastUsageAt = Date.now();
        this.emit('usage', inserted);
      }
      return inserted;
    } finally {
      this.scanning = false;
      if (!only) this.lastSweepMs = Date.now() - startedAt;
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule();
      }
    }
  }

  private loadState(file: string): FileState {
    const row = this.db
      .prepare('SELECT identity, size, mtime, offset, threadId, cwd, model, turnId, startedAt, subagent, serviceTier FROM codex_files WHERE path = ?')
      .get(file) as unknown as FileState | undefined;
    return row ? { ...row } : { ...EMPTY_FILE };
  }

  /**
   * Parse a batch of lines in file order and store what they hold, in one
   * transaction. `state` is advanced as it goes; `finish` writes the file row.
   */
  private ingestLines(
    lines: string[],
    state: FileState,
    models: Map<string, string>,
    finish: (() => void) | null,
  ): { inserted: number; readings: number } {
    // Each response is resolved where it sits in the file: the model, tier and
    // directory in force at its own line, not whatever the batch ended on.
    const usage: { u: CodexUsage; model: string; tier: string | null; project: string }[] = [];
    const limits: CodexReading[] = [];
    for (const line of lines) {
      const entry = parseCodexLine(line);
      if (!entry) continue;
      if (entry.kind === 'meta') {
        // The first one names the thread; later ones (a fork, a resume) do
        // not change whose file this is.
        if (!state.threadId) {
          state.threadId = entry.threadId;
          state.subagent = entry.subagent ? 1 : 0;
        }
        if (entry.cwd && !state.cwd) state.cwd = entry.cwd;
        if (state.startedAt === null) state.startedAt = entry.ts;
      } else if (entry.kind === 'context') {
        if (entry.model) models.set(entry.turnId, entry.model);
        state.turnId = entry.turnId;
        state.model = models.get(entry.turnId) ?? '';
        if (entry.cwd) state.cwd = entry.cwd;
      } else if (entry.kind === 'usage') {
        const u = entry.usage;
        // Its own turn's model. The file's last model only stands in for the
        // turn that model belongs to — the one a restart resumed halfway
        // through. A record from any other turn (a fork's copy of its
        // parent's) is left unknown, and the parent's copy replaces it.
        const model = models.get(u.turnId) ?? (u.turnId && u.turnId === state.turnId ? state.model : '');
        usage.push({ u, model: model || 'unknown', tier: state.serviceTier || null, project: state.cwd });
      } else if (entry.kind === 'settings') {
        // Settings say nothing about the turns before them, and a line that
        // names no tier leaves the next ones without one, not with the last.
        state.serviceTier = entry.serviceTier ?? '';
      } else if (entry.kind === 'limits') {
        limits.push(entry.reading);
      }
    }

    const insert = this.db.prepare(INSERT);
    let inserted = 0;
    let readings = 0;
    this.db.exec('BEGIN');
    try {
      for (const { u, model, tier, project } of usage) {
        const res = insert.run(
          u.responseId, u.ts, model, u.inputTokens, u.cachedInputTokens, u.cacheWriteInputTokens,
          u.outputTokens, u.reasoningOutputTokens, codexCredits(u, model, u.ts, tier), tier,
          u.threadId || state.threadId, u.turnId, project,
        );
        inserted += Number(res.changes);
      }
      for (const r of limits) if (saveCodexReading(this.db, r)) readings += 1;
      finish?.();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { inserted, readings };
  }

  private saveFile(file: string, state: FileState, size: number, mtimeMs: number): void {
    this.db.prepare(SAVE_FILE).run(
      file, state.identity, state.offset, size, mtimeMs, Date.now(), state.threadId, state.cwd,
      state.model, state.turnId, state.startedAt, state.subagent, state.serviceTier,
    );
  }

  /** One file, a chunk at a time, each chunk in its own transaction. */
  private async readFile(file: string): Promise<{ inserted: number; readings: number }> {
    if (file.endsWith('.zst')) return this.readCompressed(file);
    const state = this.loadState(file);
    // Models by turn, for this pass. A turn's context always precedes its
    // records, so within a pass this is exact; across a restart the stored
    // model of the latest turn stands in, which is the turn being resumed.
    const models = new Map<string, string>();
    if (state.turnId && state.model) models.set(state.turnId, state.model);
    let inserted = 0;
    let readings = 0;

    for (;;) {
      if (this.stopped) break;
      const chunk = await readChunk(file, state.offset, this.chunkBytes, state);
      if (this.stopped || !chunk.identity) break;
      if (chunk.restarted) {
        Object.assign(state, EMPTY_FILE);
        models.clear();
      }
      state.identity = chunk.identity;
      state.mtime = chunk.mtimeMs;
      state.size = chunk.size;
      this.mtimes.set(file, chunk.mtimeMs);
      if (!chunk.lines.length && chunk.offset === state.offset && !chunk.restarted) break;
      const got = this.ingestLines(chunk.lines, state, models, () => {
        state.offset = chunk.offset;
        this.saveFile(file, state, chunk.size, chunk.mtimeMs);
      });
      inserted += got.inserted;
      readings += got.readings;
      if (!chunk.more) break;
    }
    return { inserted, readings };
  }

  /**
   * A rollout Codex has compressed: `rollout-….jsonl.zst`.
   *
   * Codex zstd-compresses its older sessions in place. On the machine this was
   * written on that was most of the history, including a thread that had been
   * a 128 MB `.jsonl` the day before. Reading only `.jsonl` silently dropped
   * the bulk of it. A compressed file is finished, so it is read once, whole,
   * as a stream — decompressed and split into lines piece by piece, never held
   * in memory — and recorded as read at its compressed size. A file that is
   * still being written by the compressor fails to decode and is tried again on
   * a later sweep; whatever was stored from it is not counted twice, because
   * rows are keyed on the response id.
   *
   * zstd arrived in `node:zlib` in 22.15. On an older Node these files are
   * skipped, and the daemon says so once.
   */
  private async readCompressed(file: string): Promise<{ inserted: number; readings: number }> {
    let identity: string;
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(file);
      ({ size, mtimeMs } = info);
      identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    } catch {
      return { inserted: 0, readings: 0 };
    }
    this.mtimes.set(file, mtimeMs);
    if (this.stopped) return { inserted: 0, readings: 0 };
    const known = this.loadState(file);
    if (known.identity === identity && known.mtime === mtimeMs && known.offset === size && size > 0) return { inserted: 0, readings: 0 };
    const decompress = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
    if (!decompress) {
      if (!warnedNoZstd) {
        warnedNoZstd = true;
        console.error(`tokio: warning — Codex has compressed some of its sessions (.jsonl.zst) and this Node (${process.version}) cannot read zstd; they are skipped. Node 22.15 or later reads them.`);
      }
      return { inserted: 0, readings: 0 };
    }

    // From the beginning, every time: a compressed file is read whole or not
    // at all, and only a finished read is recorded.
    const state = { ...EMPTY_FILE, identity };
    const models = new Map<string, string>();
    let inserted = 0;
    let readings = 0;
    let batch: string[] = [];
    let batchBytes = 0;
    let rest = '';
    const flush = (finish: (() => void) | null) => {
      const got = this.ingestLines(batch, state, models, finish);
      inserted += got.inserted;
      readings += got.readings;
      batch = [];
      batchBytes = 0;
    };

    const source = createReadStream(file);
    const stream = decompress();
    source.on('error', (err) => stream.destroy(err));
    source.pipe(stream);
    stream.setEncoding('utf8');
    try {
      for await (const piece of stream as AsyncIterable<string>) {
        if (this.stopped) {
          stream.destroy();
          return { inserted, readings };
        }
        rest += piece;
        // Walked with an index and cut once at the end, so a piece holding many
        // lines costs one pass rather than a copy of the remainder per line.
        let start = 0;
        let newline: number;
        while ((newline = rest.indexOf('\n', start)) >= 0) {
          const line = rest.slice(start, newline);
          start = newline + 1;
          if (!line) continue;
          // The cheap test first: most lines are conversation, and only the
          // ones that might matter are worth holding until the batch is stored.
          if (!worthParsing(line)) continue;
          batch.push(line);
          batchBytes += line.length;
          if (batchBytes >= this.chunkBytes || batch.length >= 5_000) flush(null);
        }
        rest = rest.slice(start);
      }
    } catch (err) {
      if (!warnedBadZst.has(file)) {
        warnedBadZst.add(file);
        console.error(`tokio: warning — could not decompress ${file}: ${(err as Error).message}`);
      }
      return { inserted, readings };
    } finally {
      source.destroy();
    }
    if (this.stopped) return { inserted, readings };
    // A finished file's last line needs no newline after it.
    if (rest.trim() && worthParsing(rest)) batch.push(rest);
    flush(() => {
      state.offset = size;
      this.saveFile(file, state, size, mtimeMs);
    });
    return { inserted, readings };
  }

  private async sweepList(): Promise<string[]> {
    const all = await discoverRollouts(this.home);
    const now = Date.now();
    const full = now - this.lastFullAt >= FULL_SWEEP_MS;
    if (full) this.lastFullAt = now;
    return sweepTargets(all, this.mtimes, now, full);
  }

  private request(path?: string): void {
    if (this.stopped) return;
    if (path && (path.endsWith('.jsonl') || path.endsWith('.jsonl.zst'))) this.touched.add(path);
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
      void this.drain().catch((err) => console.error(`tokio: reading Codex rollouts failed — ${err?.message ?? err}`));
    }, SETTLE_MS);
    this.settleTimer.unref();
  }

  private async drain(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return;
    }
    const all = this.sweepAll;
    const files = [...this.touched];
    this.sweepAll = false;
    this.touched.clear();
    this.again = false;
    if (files.length) await this.scan(files);
    if (all) await this.scan();
  }

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

  /** Watch where the filesystem allows it; the sweep covers the rest. See the Claude ingestor. */
  private async startWatching(dir: string): Promise<void> {
    try {
      const { watch } = await import('chokidar');
      const watcher = watch(dir, { ignoreInitial: true, depth: 4 });
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
    // Codex can be switched off while the first scan runs; a watcher started
    // after that would outlive the stop that was meant to end it.
    if (this.stopped) return;
    await this.startWatching(join(this.home, 'sessions'));
    if (this.stopped) {
      await Promise.all(this.watchers.map((w) => w.close().catch(() => {})));
      this.watchers = [];
      return;
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
