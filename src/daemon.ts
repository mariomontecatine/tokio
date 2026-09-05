import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { Ingestor } from './ingest/index.ts';
import { Scheduler } from './queue/scheduler.ts';
import { createClaudeCodeProvider } from './providers/claudeCode.ts';
import { createServer } from './server/index.ts';
import { computeStatus, isRealReset } from './meter/index.ts';
import { rememberReading } from './plans/calibrate.ts';
import { notify } from './notify/index.ts';
import { nextProbeDelay, probeUsage } from './usage/probe.ts';
import { dashboardUrl, isLoopback, onWsl } from './net.ts';
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

  let lastUsageAt: number | null = null;
  ingestor.on('usage', () => {
    lastUsageAt = Date.now();
    bus.emit('change');
    // New usage can free nothing, but it can flip a job from "doesn't fit" to
    // "fits" once a window rolls over, so re-evaluate on every batch.
    void scheduler.tick();
  });
  scheduler.on('change', () => bus.emit('change'));

  await ingestor.start();
  scheduler.start();

  /**
   * The last percentage we were told, so that work done off this machine still
   * counts as work.
   *
   * `lastUsageAt` is set from the transcripts, which only ever see prompts typed
   * into a terminal here. Someone working in the browser is idle by that
   * measure, so the poll drops to its slow beat exactly while the number they
   * care about is moving fastest. A percentage that went up is the same
   * evidence, from the only source that has it.
   */
  let lastReportedPct: number | null = null;

  /** Ask Claude Code for the real percentages and tell the dashboard. */
  const refresh = async () => {
    const probe = await probeUsage(cfg);
    saveProbe(db, probe);
    pruneProbes(db);
    if (probe.sessionPct !== null) {
      if (lastReportedPct !== null && probe.sessionPct > lastReportedPct) lastUsageAt = Date.now();
      lastReportedPct = probe.sessionPct;
    }
    // Every usable reading also pins the cap, so the shipped guesses stop being
    // consulted after the first busy window. See plans/calibrate.ts.
    const status = computeStatus(db, cfg);
    rememberReading(db, 'block', probe.sessionPct, status.block.window.credits);
    rememberReading(db, 'week', probe.weekPct, status.week.window.credits);
    bus.emit('change');
    return probe;
  };

  // Self-scheduling rather than a fixed beat: see nextProbeDelay. The next read
  // is chosen after each one, from what the last one said and what the queue is
  // waiting for.
  let poller: NodeJS.Timeout | null = null;
  const pollAgain = (probe: { sessionResetsAt: number | null }) => {
    // One chain, always. A reset triggers its own read, and without this that
    // read would start a second chain alongside the first — a daemon that has
    // been up a week would be polling a dozen times over.
    if (poller) clearTimeout(poller);
    const now = Date.now();
    const queued = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','deferred')").get() as { n: number }).n;
    const delay = nextProbeDelay({ now, baseMs: cfg.usagePollMs, lastUsageAt, queued, resetsAt: probe.sessionResetsAt });
    poller = setTimeout(() => void refresh().then(pollAgain), delay);
    poller.unref();
  };

  const first = await refresh();
  if (first.error) console.error(`tokio: warning — ${first.error}`);
  pollAgain(first);

  // A reset is the one moment queued work becomes runnable, so it starts the
  // job, reads the real numbers again and says so — rather than waiting for
  // whichever timer happened to be next.
  watchForReset(db, cfg, bus, () => {
    void scheduler.tick();
    void refresh().then(pollAgain);
  });

  const app = await createServer({ db, cfg, scheduler, onChange, refresh });
  await app.listen({ host: cfg.host, port: cfg.port });

  const url = dashboardUrl(cfg);
  const status = computeStatus(db, cfg);
  console.log(`tokio listening on ${url}`);
  for (const hint of accessHints(cfg)) console.log(hint);
  console.log(`  5h window: ${status.block.usedPct.toFixed(0)}% used (${status.block.source}), resets ${new Date(status.block.resetsAt).toLocaleTimeString()}`);
  console.log(`  queue: ${status.queued} job(s)`);

  const shutdown = async () => {
    if (poller) clearTimeout(poller);
    await ingestor.stop();
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, db, cfg, ingestor, scheduler, url };
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

/**
 * Announce a fresh window, which is the moment queued work becomes runnable.
 *
 * The reported reset is a rolling figure rounded to the minute, so it wobbles
 * by up to a minute between readings. Comparing it exactly would announce a
 * reset several times an hour; a real one moves the window by hours.
 */
function watchForReset(
  db: ReturnType<typeof openDb>,
  cfg: Config,
  bus: EventEmitter,
  onReset: () => void,
): void {
  let lastStart = computeStatus(db, cfg).block.window.start;
  const timer = setInterval(() => {
    const status = computeStatus(db, cfg);
    if (isRealReset(lastStart, status.block.window.start)) {
      lastStart = status.block.window.start;
      bus.emit('change');
      onReset();
      if (status.queued > 0) {
        void notify(cfg, {
          title: 'tokio: window reset',
          body: `Your 5h window rolled over. ${status.queued} queued job(s) will start now.`,
        });
      }
    } else if (status.block.window.start < lastStart) {
      // Minute-level wobble backwards; track it without calling it a reset.
      lastStart = status.block.window.start;
    }
  }, 60_000);
  timer.unref();
}
