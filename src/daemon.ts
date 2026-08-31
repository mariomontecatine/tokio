import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from './db.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { Ingestor } from './ingest/index.ts';
import { Scheduler } from './queue/scheduler.ts';
import { createClaudeCodeProvider } from './providers/claudeCode.ts';
import { createServer } from './server/index.ts';
import { computeStatus } from './meter/index.ts';
import { notify } from './notify/index.ts';
import { networkInterfaces } from 'node:os';
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
  // Listening beyond loopback needs a token. Refusing outright used to be the
  // answer, but that leaves WSL users — where Windows often cannot reach WSL's
  // loopback at all — with no way in, so mint one and hand back a URL that
  // carries it.
  if (!isLoopback(cfg.host) && !cfg.token) {
    cfg.token = randomBytes(16).toString('hex');
    saveConfig(cfg);
    console.log('tokio: generated an access token for non-local access (saved to your config)');
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

  const url = dashboardUrl(cfg);
  const status = computeStatus(db, cfg);
  console.log(`tokio listening on ${url}`);
  for (const hint of accessHints(cfg)) console.log(hint);
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

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function dashboardUrl(cfg: Config): string {
  const host = cfg.host === '0.0.0.0' ? lanAddress() ?? '127.0.0.1' : cfg.host;
  const query = cfg.token && !isLoopback(host) ? `/?token=${cfg.token}` : '';
  return `http://${host}:${cfg.port}${query}`;
}

/** This machine's first non-loopback IPv4, for the URL another host would use. */
function lanAddress(): string | null {
  const nets = Object.values(networkInterfaces()).flat();
  for (const net of nets) {
    if (net && net.family === 'IPv4' && !net.internal) return net.address;
  }
  return null;
}

function onWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * WSL is the case worth calling out: the daemon runs in a separate network
 * namespace, and Windows cannot always reach its loopback, so the dashboard
 * looks broken through no fault of its own.
 */
function accessHints(cfg: Config): string[] {
  if (!onWsl() || !isLoopback(cfg.host)) return [];
  return [
    '  On WSL? If Windows cannot open that address, restart with:',
    '    tokio start --host 0.0.0.0',
    '  and use the URL it prints.',
  ];
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
