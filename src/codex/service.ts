import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { nextProbeDelay } from '../usage/probe.ts';
import { CodexIngestor } from './ingest.ts';
import { probeCodexLimits } from './limits.ts';
import { computeCodexStatus } from './meter.ts';
import type { CodexReading } from './parse.ts';
import { codexHome, saveCodexReading } from './store.ts';

type Db = DatabaseSync;

/**
 * Everything the daemon does for Codex, startable and stoppable as one.
 *
 * Someone can turn Codex on or off from the dashboard, so this is not wired in
 * once at startup like Claude's half: it reads the rollouts, asks the app
 * server for the limits on the same self-scheduling beat `/usage` gets, and
 * stops all of it when Codex is switched off — a daemon told someone does not
 * use Codex has no business spawning it every few minutes.
 */
export class CodexService {
  private db: Db;
  private cfg: Config;
  private onChange: () => void;
  private ingestor: CodexIngestor | null = null;
  private poller: NodeJS.Timeout | null = null;
  private lastUsageAt: number | null = null;
  private probes = new AbortController();
  private startup: Promise<void> | null = null;

  constructor(db: Db, cfg: Config, onChange: () => void) {
    this.db = db;
    this.cfg = cfg;
    this.onChange = onChange;
  }

  get running(): boolean {
    return this.ingestor !== null;
  }

  /** Ask now. Saved, announced, and handed back. */
  async refresh(): Promise<CodexReading> {
    const signal = this.probes.signal;
    const reading = await probeCodexLimits(this.cfg, undefined, signal);
    if (signal.aborted) return reading;
    saveCodexReading(this.db, reading);
    this.onChange();
    return reading;
  }

  private pollAgain(): void {
    if (this.poller) clearTimeout(this.poller);
    if (!this.ingestor) return;
    const now = Date.now();
    const queued = (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE provider = 'codex' AND status IN ('queued','deferred')").get() as { n: number }).n;
    const resetsAt = computeCodexStatus(this.db, this.cfg, now).session?.resetsAt ?? null;
    const delay = nextProbeDelay({ now, baseMs: this.cfg.usagePollMs, lastUsageAt: this.lastUsageAt, queued, resetsAt });
    const ingestor = this.ingestor;
    this.poller = setTimeout(() => void this.refresh().finally(() => {
      if (this.ingestor === ingestor) this.pollAgain();
    }), delay);
    this.poller.unref();
  }

  start(): Promise<void> {
    if (this.startup) return this.startup;
    const ingestor = new CodexIngestor(this.db, codexHome(this.cfg));
    this.ingestor = ingestor;
    this.startup = this.startIngestor(ingestor).catch(async (err) => {
      if (this.ingestor === ingestor) await this.stop();
      throw err;
    });
    return this.startup;
  }

  private async startIngestor(ingestor: CodexIngestor): Promise<void> {
    ingestor.on('usage', () => {
      if (ingestor !== this.ingestor) return;
      this.lastUsageAt = Date.now();
      this.onChange();
    });
    // The rings first: asking takes under a second, while a first read of a
    // long, partly compressed history can take tens of them, and the window
    // should not sit empty waiting for the past.
    const [first] = await Promise.all([this.refresh(), ingestor.start()]);
    if (ingestor !== this.ingestor) return;
    if (first.error) console.error(`tokio: warning — Codex limits: ${first.error}`);
    this.pollAgain();
  }

  async stop(): Promise<void> {
    this.startup = null;
    this.probes.abort();
    this.probes = new AbortController();
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    const ingestor = this.ingestor;
    this.ingestor = null;
    await ingestor?.stop();
  }

  /** For a one-shot command: read what the rollouts hold, without watching. */
  async scanOnce(): Promise<number> {
    return new CodexIngestor(this.db, codexHome(this.cfg)).scan();
  }
}
