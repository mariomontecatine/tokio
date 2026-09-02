#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { openDb } from './db.ts';
import { loadConfig, saveConfig, configPath, claudeDir, redactConfig } from './config.ts';
import { Ingestor } from './ingest/index.ts';
import { computeStatus } from './meter/index.ts';
import { computeValue } from './meter/value.ts';
import { probeUsage } from './usage/probe.ts';
import { saveProbe, latestProbe } from './usage/store.ts';
import { predict } from './estimator/predict.ts';
import { addAnchor, planLabel } from './plans/calibrate.ts';
import { createJob, deleteJob, getJob, listJobs, updateJob } from './queue/store.ts';
import { recentSessions } from './server/projects.ts';
import { effectiveModel } from './models.ts';
import { daemonRunning, dashboardUrl, openInBrowser } from './net.ts';
import type { RunPolicy, Safety } from './types.ts';

const HELP = `tokio — queue prompts for your coding agent and watch your subscription quota

Usage
  tokio [--no-open]                          Open the dashboard, starting it if needed
  tokio start [--port <n>] [--host <addr>]   Run the daemon and dashboard (no browser)
  tokio open                                 Open the dashboard in your browser
  tokio status [--refresh]                   Show quota, burn rate and queue
  tokio refresh                              Re-read the real numbers and show them
  tokio value                                What the subscription has been worth
  tokio add <prompt...>                      Queue a prompt
  tokio ls [--all]                           List jobs
  tokio show <id>                            Show a job and its output
  tokio run <id>                             Run a job now, in the foreground
  tokio rm <id>                              Remove a job
  tokio calibrate <percent>                  Teach tokio your real limit
  tokio sessions [--cwd <dir>]               List resumable sessions
  tokio config                               Show config file path and values

Options for "add"
  --cwd <dir>        Project directory                  (default: current dir)
  --model <name>     opus | sonnet | haiku | full id    (default: config)
  --safety <mode>    plan | edits | full                (default: config)
  --resume <id|last> Continue an existing session
  --when <policy>    on-reset | asap | manual | <ISO time>   (default: on-reset)
  --priority <n>     Higher runs first                  (default: 0)
  --urgent           Ignore the reserve floor

Options for "calibrate"
  --window <kind>    block | week | weekOpus            (default: block)
`;

const money = (n: number) => `$${n.toFixed(2)}`;
const clock = (ts: number | null) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

function bar(pct: number, width = 24): string {
  const filled = Math.round((Math.min(100, pct) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function freshDb() {
  const cfg = loadConfig();
  const db = openDb();
  // Pick up anything Claude Code wrote since the last daemon pass, so one-shot
  // commands are accurate even with no daemon running.
  new Ingestor(db, cfg).scan();
  return { db, cfg };
}

async function cmdStatus(refresh: boolean): Promise<void> {
  const { db, cfg } = freshDb();

  // Reading /usage costs nothing and takes a few seconds, so do it whenever the
  // last one has gone stale — a wrong percentage is worse than a slow command.
  const last = latestProbe(db);
  if (refresh || !last || Date.now() - last.at > cfg.usageMaxAgeMs) {
    const probe = await probeUsage(cfg);
    saveProbe(db, probe);
    if (probe.error) console.error(`\n  Could not read /usage: ${probe.error}`);
  }

  const s = computeStatus(db, cfg);
  const caveat =
    s.block.source === 'reported'
      ? '  (reported by Claude Code)'
      : s.block.cap.basis === 'default'
        ? '  (estimated — run "tokio calibrate <pct>")'
        : `  (calibrated, ${s.block.cap.anchors} anchor(s))`;

  console.log(`\n  Plan: ${planLabel(cfg.plan)}${caveat}\n`);
  console.log(`  5h window  ${bar(s.block.usedPct)} ${s.block.usedPct.toFixed(0).padStart(3)}%   ${money(s.block.window.credits)} of ${money(s.block.cap.credits)}`);
  console.log(`             resets at ${clock(s.block.resetsAt)}`);
  console.log(`  Week       ${bar(s.week.usedPct)} ${s.week.usedPct.toFixed(0).padStart(3)}%   ${money(s.week.window.credits)} of ${money(s.week.cap.credits)}`);
  if (s.weekOpus) {
    console.log(`  Week Opus  ${bar(s.weekOpus.usedPct)} ${s.weekOpus.usedPct.toFixed(0).padStart(3)}%   ${money(s.weekOpus.window.opusCredits)} of ${money(s.weekOpus.cap.credits)}`);
  }
  console.log('');
  if (s.burnRate > 0) {
    console.log(`  Burning ${money(s.burnRate)}/h` + (s.exhaustionAt ? ` — window runs dry around ${clock(s.exhaustionAt)}` : ' — the window resets before you run dry'));
  } else {
    console.log('  Idle.');
  }

  const v = computeValue(db, cfg);
  if (v.multiple !== null) {
    console.log(`  Worth ${money(v.equivalentUsd)} at API prices for ${money(v.paidUsd!)} paid — ${v.multiple.toFixed(1)}× your subscription`);
  }

  const pending = listJobs(db, ['queued', 'deferred', 'running']);
  if (pending.length) {
    console.log(`\n  Queue (${pending.length}):`);
    for (const j of pending) {
      const est = j.estimateP50 != null ? `~${money(j.estimateP50)}` : '?';
      console.log(`    ${j.id}  ${j.status.padEnd(8)} ${est.padStart(7)}  ${j.prompt.slice(0, 46).replace(/\n/g, ' ')}`);
    }
  }
  console.log('');
}

function resolvePolicy(when: string | undefined): { runPolicy: RunPolicy; runAt: number | null } {
  if (!when || when === 'on-reset') return { runPolicy: 'on-reset', runAt: null };
  if (when === 'asap') return { runPolicy: 'asap-if-headroom', runAt: null };
  if (when === 'manual') return { runPolicy: 'manual', runAt: null };
  const at = Date.parse(when);
  if (Number.isNaN(at)) throw new Error(`could not read a time from "${when}"`);
  return { runPolicy: 'at', runAt: at };
}

function cmdAdd(prompt: string, opts: Record<string, any>): void {
  const { db, cfg } = freshDb();
  if (!prompt.trim()) throw new Error('give me a prompt to queue');

  const cwd = opts.cwd ? String(opts.cwd) : process.cwd();
  const safety = (opts.safety ?? cfg.defaultSafety) as Safety;
  if (!['plan', 'edits', 'full'].includes(safety)) throw new Error(`unknown safety mode "${safety}"`);

  let resumeSessionId: string | null = opts.resume ?? null;
  if (resumeSessionId === 'last') {
    const [latest] = recentSessions(claudeDir(cfg), cwd, 1);
    if (!latest) throw new Error(`no previous session found for ${cwd}`);
    resumeSessionId = latest.sessionId;
    console.log(`  resuming "${latest.title}"`);
  }

  const model = opts.model ?? effectiveModel(cfg);
  const estimate = predict(db, { prompt, cwd, model, safety, resumeSessionId });
  const { runPolicy, runAt } = resolvePolicy(opts.when);
  const status = computeStatus(db, cfg);

  const job = createJob(db, {
    prompt, cwd, model, safety, resumeSessionId, runPolicy, runAt,
    priority: Number(opts.priority ?? 0),
    urgent: Boolean(opts.urgent),
    estimateP50: estimate.p50, estimateP90: estimate.p90, estimateBasis: estimate.basis,
  });

  const after = Math.max(0, status.block.remainingCredits - estimate.p50);
  const afterPct = status.block.cap.credits > 0 ? (after / status.block.cap.credits) * 100 : 0;
  console.log(`\n  Queued ${job.id}: ${prompt.slice(0, 60).replace(/\n/g, ' ')}`);
  console.log(`  Estimate  ${money(estimate.p50)} (up to ${money(estimate.p90)})  — ${estimate.basis}`);
  console.log(`  Leaves    ~${afterPct.toFixed(0)}% of the 5h window`);
  console.log(`  Runs      ${runPolicy === 'at' ? `at ${new Date(runAt!).toLocaleString()}` : runPolicy === 'on-reset' ? `when the window resets (${clock(status.block.resetsAt)})` : runPolicy === 'manual' ? 'only when you say so' : 'as soon as it fits'}`);
  console.log(`  Safety    ${safety}${safety === 'full' ? '  ⚠ unrestricted: it can edit and run anything in that directory' : ''}\n`);
}

function cmdLs(all: boolean): void {
  const { db } = freshDb();
  const jobs = all ? listJobs(db) : listJobs(db, ['queued', 'deferred', 'running']);
  if (!jobs.length) return console.log('  Nothing queued.');
  console.log('');
  for (const j of jobs) {
    const cost = j.actualCredits != null ? money(j.actualCredits) : j.estimateP50 != null ? `~${money(j.estimateP50)}` : '—';
    console.log(`  ${j.id}  ${j.status.padEnd(9)} ${cost.padStart(8)}  ${j.safety.padEnd(5)}  ${j.prompt.slice(0, 44).replace(/\n/g, ' ')}`);
  }
  console.log('');
}

function cmdShow(id: string): void {
  const { db } = freshDb();
  const job = getJob(db, id);
  if (!job) throw new Error(`no job ${id}`);
  console.log(`\n  ${job.id} — ${job.status}`);
  console.log(`  ${job.cwd}${job.resumeSessionId ? ` (resuming ${job.resumeSessionId.slice(0, 8)})` : ''}`);
  console.log(`  estimated ${job.estimateP50 != null ? money(job.estimateP50) : '—'}, actual ${job.actualCredits != null ? money(job.actualCredits) : '—'}`);
  console.log(`\n  ${job.prompt}\n`);
  if (job.error) console.log(`  error: ${job.error}\n`);
  if (job.output) console.log(job.output);
}

async function cmdRun(id: string): Promise<void> {
  const { db, cfg } = freshDb();
  const job = getJob(db, id);
  if (!job) throw new Error(`no job ${id}`);
  const { Scheduler } = await import('./queue/scheduler.ts');
  const { createClaudeCodeProvider } = await import('./providers/claudeCode.ts');
  const scheduler = new Scheduler(db, cfg, createClaudeCodeProvider(cfg));
  console.log(`  running ${job.id}…`);
  await scheduler.run(job);
  const done = getJob(db, id)!;
  console.log(`  ${done.status}${done.actualCredits != null ? ` — cost ${money(done.actualCredits)}` : ''}`);
  if (done.error) console.log(`  ${done.error}`);
  if (done.output) console.log(`\n${done.output}`);
}

function cmdCalibrate(pctRaw: string, window: string): void {
  const { db, cfg } = freshDb();
  const pct = Number(pctRaw);
  const s = computeStatus(db, cfg);
  const credits = window === 'week' ? s.week.window.credits : window === 'weekOpus' ? s.week.window.opusCredits : s.block.window.credits;
  const cap = addAnchor(db, window as any, pct, credits);
  console.log(`\n  Counted ${money(credits)} in this ${window} window, which you say is ${pct}%.`);
  console.log(`  So your ${window} cap is about ${money(cap)}. Saved.\n`);
}

function cmdValue(): void {
  const { db, cfg } = freshDb();
  const v = computeValue(db, cfg);
  const from = new Date(v.since).toLocaleDateString();

  console.log(`\n  Since ${from}${v.sinceIsFirstTranscript ? ' (your oldest transcript)' : ''}\n`);
  console.log(`  Run on the API this would have cost   ${money(v.equivalentUsd).padStart(10)}`);
  if (v.paidUsd !== null) {
    console.log(`  Subscription over the same period     ${money(v.paidUsd).padStart(10)}  (${Math.round(v.elapsedDays)} days at ${money(v.paidUsd / (v.elapsedDays / 30.437))}/month)`);
    if (v.multiple !== null) {
      console.log(`  So the plan is paying back            ${(v.multiple.toFixed(1) + '×').padStart(10)}`);
    } else {
      console.log('  Too little history yet to divide one by the other.');
    }
  }
  console.log(`\n  Last 7 days   ${money(v.thisWeekUsd)}`);
  console.log(`  Last 5 hours  ${money(v.thisBlockUsd)}`);

  if (v.byMonth.length > 1) {
    console.log('\n  By month');
    const peak = Math.max(...v.byMonth.map((m) => m.usd));
    for (const m of v.byMonth) {
      const width = peak > 0 ? Math.round((m.usd / peak) * 28) : 0;
      console.log(`    ${m.month}  ${'█'.repeat(width).padEnd(28)} ${money(m.usd)}`);
    }
  }
  console.log('\n  Counted from the transcripts on this machine, at list API prices.');
  console.log('  Work done elsewhere is not in here, so treat it as a floor.');
  if (v.reconciliation) {
    const r = v.reconciliation;
    console.log(
      `  Checked against Claude Code's own total on ${r.sessions} session(s): ` +
        `${money(r.ourUsd)} here vs ${money(r.reportedUsd)} there (${(r.ratio * 100).toFixed(0)}%).`,
    );
  }
  console.log('');
}

function cmdSessions(cwd: string): void {
  const cfg = loadConfig();
  const sessions = recentSessions(claudeDir(cfg), cwd);
  if (!sessions.length) return console.log(`  No sessions found for ${cwd}`);
  console.log('');
  for (const s of sessions) {
    console.log(`  ${s.sessionId}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title}`);
  }
  console.log('');
}

/**
 * Show the dashboard, and say so when we couldn't.
 *
 * A browser is not a given — servers, containers and bare WSL images have
 * none — so a failure to open one prints the URL instead of pretending.
 */
async function showDashboard(url: string): Promise<void> {
  if (await openInBrowser(url)) {
    console.log(`  Opened ${url}`);
    return;
  }
  console.log(`  Couldn't open a browser here. The dashboard is at ${url}`);
}

/**
 * What plain `tokio` does.
 *
 * Typing the name of a tool should get you the tool, not a page of syntax, and
 * for this one the tool is the dashboard — so open it. If nothing is running,
 * start it first; if something already is, don't fail on a busy port, just go
 * to the page that's already there.
 *
 * `tokio start` deliberately does not do this: it's the form that goes in a
 * systemd unit, where launching a browser would be nonsense.
 */
async function cmdDefault(open: boolean): Promise<void> {
  const cfg = loadConfig();
  if (await daemonRunning(cfg)) {
    const url = dashboardUrl(cfg);
    console.log(`\n  Already running — ${url}`);
    if (open) await showDashboard(url);
    await cmdStatus(false);
    console.log('  Run "tokio help" for everything else.\n');
    return;
  }
  const { startDaemon } = await import('./daemon.ts');
  const started = await startDaemon({});
  if (open) await showDashboard(started.url);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  // Bare `tokio`, with or without its one flag. An option in the command slot
  // is still the default command, not an unknown one.
  if (!command || command.startsWith('-')) {
    return cmdDefault(!argv.includes('--no-open'));
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      cwd: { type: 'string' }, model: { type: 'string' }, safety: { type: 'string' },
      resume: { type: 'string' }, when: { type: 'string' }, priority: { type: 'string' },
      urgent: { type: 'boolean' }, all: { type: 'boolean' }, window: { type: 'string' },
      refresh: { type: 'boolean' },
      port: { type: 'string' }, host: { type: 'string' },
    },
  });

  switch (command) {
    case 'start': {
      const { startDaemon } = await import('./daemon.ts');
      await startDaemon({
        host: values.host as string | undefined,
        port: values.port ? Number(values.port) : undefined,
      });
      return;
    }
    case 'status': return cmdStatus(Boolean(values.refresh));
    case 'refresh': return cmdStatus(true);
    case 'value': return cmdValue();
    case 'add': return cmdAdd(positionals.join(' '), values);
    case 'ls': return cmdLs(Boolean(values.all));
    case 'show': return cmdShow(String(positionals[0] ?? ''));
    case 'run': return cmdRun(String(positionals[0] ?? ''));
    case 'rm': {
      const { db } = freshDb();
      console.log(deleteJob(db, String(positionals[0] ?? '')) ? '  removed' : '  no such job');
      return;
    }
    case 'pause': {
      const { db } = freshDb();
      updateJob(db, String(positionals[0] ?? ''), { runPolicy: 'manual' });
      console.log('  job will not start on its own');
      return;
    }
    case 'calibrate': return cmdCalibrate(String(positionals[0] ?? ''), String(values.window ?? 'block'));
    case 'sessions': return cmdSessions(values.cwd ? String(values.cwd) : process.cwd());
    case 'config': {
      const cfg = loadConfig();
      saveConfig(cfg);
      console.log(`\n  ${configPath()}\n`);
      // Redacted, because this is the command people paste into bug reports.
      console.log(JSON.stringify(redactConfig(cfg), null, 2));
      console.log('\n  Secrets are shown masked. The real values are in the file above.\n');
      return;
    }
    case 'open': {
      const cfg = loadConfig();
      // dashboardUrl, not host:port: it resolves a 0.0.0.0 bind to an address a
      // browser can actually reach, and carries the access token when one is needed.
      const url = dashboardUrl(cfg);
      if (!(await daemonRunning(cfg))) {
        console.log('  Nothing is running yet — start it with "tokio".');
        return;
      }
      console.log('');
      await showDashboard(url);
      console.log('');
      return;
    }
    default:
      console.error(`tokio: unknown command "${command}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n  tokio: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
