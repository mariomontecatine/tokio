import { EventEmitter } from 'node:events';
import { openDb } from './db.ts';
import { loadConfig, type Config } from './config.ts';
import { Ingestor } from './ingest/index.ts';
import { Scheduler } from './queue/scheduler.ts';
import { createClaudeCodeProvider } from './providers/claudeCode.ts';
import { createServer } from './server/index.ts';
import { computeStatus } from './meter/index.ts';
import { notify } from './notify/index.ts';
import { probeUsage } from './usage/probe.ts';
import { saveProbe, pruneProbes } from './usage/store.ts';

export interface DaemonOptions {
  host?: string;
  port?: number;
}

export async function startDaemon(options: DaemonOptions = {}) {
  const cfg: Config = loadConfig();
  if (options.host) cfg.host = options.host;
  if (options.port) cfg.port = options.port;
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && !cfg.token) {
    throw new Error(`refusing to listen on ${cfg.host} without a token — set "token" in your config first`);
  }

  const db = openDb();
  const provider = createClaudeCodeProvider(cfg);
  const availability = await provider.available();
  if (!availability.ok) console.error(`tokio: warning — ${availability.reason}`);

  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const onChange = (listener: () => void) => {
    bus.on('change', listener);
    return () => bus.off('change', listener);
  };

  const ingestor = new Ingestor(db, cfg);
  const scheduler = new Scheduler(db, cfg, provider);

  ingestor.on('usage', () => {
    bus.emit('change');
    // New usage can free nothing, but it can flip a job from "doesn't fit" to
    // "fits" once a window rolls over, so re-evaluate on every batch.
    void scheduler.tick();
  });
  scheduler.on('change', () => bus.emit('change'));

  await ingestor.start();
  scheduler.start();
  watchForReset(db, cfg, bus);

  /** Ask Claude Code for the real percentages and tell the dashboard. */
  const refresh = async () => {
    const probe = await probeUsage(cfg);
    saveProbe(db, probe);
    pruneProbes(db);
    bus.emit('change');
    return probe;
  };
  const first = await refresh();
  if (first.error) console.error(`tokio: warning — ${first.error}`);
  const poller = setInterval(() => void refresh(), cfg.usagePollMs);
  poller.unref();

  const app = await createServer({ db, cfg, scheduler, onChange, refresh });
  await app.listen({ host: cfg.host, port: cfg.port });

  const url = `http://${cfg.host}:${cfg.port}`;
  const status = computeStatus(db, cfg);
  console.log(`tokio listening on ${url}`);
  console.log(`  5h window: ${status.block.usedPct.toFixed(0)}% used (${status.block.source}), resets ${new Date(status.block.resetsAt).toLocaleTimeString()}`);
  console.log(`  queue: ${status.queued} job(s)`);

  const shutdown = async () => {
    clearInterval(poller);
    await ingestor.stop();
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, db, cfg, ingestor, scheduler, url };
}

/** Announce a fresh window, which is the moment queued work becomes runnable. */
function watchForReset(db: ReturnType<typeof openDb>, cfg: Config, bus: EventEmitter): void {
  let lastStart = computeStatus(db, cfg).block.window.start;
  const timer = setInterval(() => {
    const status = computeStatus(db, cfg);
    if (status.block.window.start !== lastStart) {
      lastStart = status.block.window.start;
      bus.emit('change');
      if (status.queued > 0) {
        void notify(cfg, {
          title: 'tokio: window reset',
          body: `Your 5h window rolled over. ${status.queued} queued job(s) will start now.`,
        });
      }
    }
  }, 60_000);
  timer.unref();
}
