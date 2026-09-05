import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { loadConfig, saveConfig, claudeDir, redactConfig } from '../config.ts';
import { computeStatus } from '../meter/index.ts';
import { computeValue } from '../meter/value.ts';
import { predict } from '../estimator/predict.ts';
import { accuracy } from '../estimator/learn.ts';
import { addAnchor, planLabel, type WindowKind } from '../plans/calibrate.ts';
import { resolvePlan } from '../plans/detect.ts';
import { createJob, deleteJob, getJob, listJobs, updateJob } from '../queue/store.ts';
import { SAFETIES, changesTheEstimate, readJobFields } from '../queue/validate.ts';
import type { Scheduler } from '../queue/scheduler.ts';
import { recentSessions, knownProjects } from './projects.ts';
import { effectiveModel } from '../models.ts';
import type { JobStatus, Safety } from '../types.ts';

/** Statuses a job can be started from. Anything else has already had its turn. */
const RUNNABLE = new Set<JobStatus>(['queued', 'deferred', 'cancelled']);

/** And the ones whose row is a record of an attempt rather than a plan for one. */
const HAS_RUN = new Set<JobStatus>(['done', 'failed']);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Constant-time token comparison.
 *
 * `===` on a secret leaks its prefix through timing, and this endpoint is
 * reachable from the LAN whenever the token exists at all. Lengths are compared
 * first because timingSafeEqual throws on a mismatch, and the length of a token
 * is not the secret.
 */
function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strip out values that are just the redaction mark coming back to us. */
function dropMasked(patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (typeof value === 'string' && /^\u2022+$/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Settings the dashboard may write, and what each will accept.
 *
 * These are not cosmetic. `reservePct` decides how much of your window an
 * unattended queue is allowed to eat, and `concurrency` how many CLIs run at
 * once; a string where a number belongs used to be written straight through to
 * disk, where it stayed wrong until someone opened the file. A rejected value
 * is better than a saved one nobody can see.
 */
const REJECTED = Symbol('rejected');

const oneOf = <T,>(values: readonly T[]) => (v: unknown) => (values.includes(v as T) ? v : REJECTED);

const between = (low: number, high: number) => (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= low && n <= high ? n : REJECTED;
};

const nullableText = (v: unknown) => (v === null || v === '' ? null : typeof v === 'string' ? v : REJECTED);

const nullableAmount = (v: unknown) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : REJECTED;
};

const CONFIG_FIELDS: Record<string, (value: unknown) => unknown> = {
  plan: oneOf(['auto', 'pro', 'max5', 'max20', 'custom']),
  defaultSafety: oneOf(SAFETIES),
  defaultModel: nullableText,
  reservePct: between(0, 90),
  concurrency: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : REJECTED;
  },
  weeklyAnchor: (v) => {
    if (v === null) return null;
    if (typeof v !== 'object') return REJECTED;
    const { weekday, hour } = v as Record<string, unknown>;
    const okDay = Number.isInteger(weekday) && (weekday as number) >= 0 && (weekday as number) <= 6;
    const okHour = Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23;
    return okDay && okHour ? { weekday, hour } : REJECTED;
  },
  customCaps: (v) => {
    if (v === null) return null;
    if (typeof v !== 'object') return REJECTED;
    const { block, week, weekOpus } = v as Record<string, unknown>;
    const positive = (n: unknown) => Number.isFinite(Number(n)) && Number(n) > 0;
    if (!positive(block) || !positive(week)) return REJECTED;
    if (weekOpus !== null && weekOpus !== undefined && !positive(weekOpus)) return REJECTED;
    return { block: Number(block), week: Number(week), weekOpus: weekOpus == null ? null : Number(weekOpus) };
  },
  subscriptionStartedAt: (v) => {
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return REJECTED;
    return v;
  },
  planPriceUsd: nullableAmount,
};

export interface ServerDeps {
  db: Db;
  cfg: Config;
  scheduler: Scheduler;
  onChange: (listener: () => void) => () => void;
  /** Re-reads the real percentages from Claude Code. */
  refresh?: () => Promise<{ error: string | null }>;
}

export async function createServer(deps: ServerDeps) {
  const { db, cfg, scheduler } = deps;
  const app = Fastify({ logger: false });

  // Loopback needs no auth; anything else must present the configured token.
  //
  // The token normally travels in a header. EventSource cannot set one, so
  // /api/stream — and only /api/stream — also accepts it as a query parameter:
  // query strings end up in proxy logs and Referer headers, so the exception is
  // kept to the single endpoint that has no alternative.
  app.addHook('onRequest', async (req, reply) => {
    if (!cfg.token) return;
    if (!req.url.startsWith('/api')) return;

    const header = req.headers.authorization;
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const path = req.url.split('?')[0];
    const fromQuery = path === '/api/stream' ? (req.query as any)?.token : undefined;

    if (!tokenMatches(cfg.token, fromHeader ?? fromQuery)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/api/value', async () => computeValue(db, cfg));

  app.post('/api/refresh', async () => {
    if (!deps.refresh) return { ok: false, error: 'no daemon is running to refresh from' };
    const probe = await deps.refresh();
    return { ok: !probe.error, error: probe.error };
  });

  app.get('/api/status', async () => {
    // One reading, shared. The status and the scheduler's reasoning have to
    // agree — a job explained against a second, slightly later window is a job
    // whose reason contradicts the gauge above it — and building it once is
    // also half the work.
    const status = computeStatus(db, cfg);
    return {
      ...status,
      value: computeValue(db, cfg),
      planLabel: planLabel(resolvePlan(cfg).plan),
      accuracy: accuracy(db),
      decisions: scheduler.explain(status).map((d) => ({ id: d.job.id, run: d.run, reason: d.reason })),
    };
  });

  app.get('/api/jobs', async () => listJobs(db));

  app.get('/api/jobs/:id', async (req, reply) => {
    const job = getJob(db, (req.params as any).id);
    return job ?? reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/estimate', async (req) => {
    const b = req.body as any;
    const estimate = predict(db, {
      prompt: String(b.prompt ?? ''),
      cwd: String(b.cwd ?? process.cwd()),
      model: b.model ?? effectiveModel(cfg),
      safety: (b.safety ?? cfg.defaultSafety) as Safety,
      resumeSessionId: b.resumeSessionId ?? null,
    });
    const status = computeStatus(db, cfg);
    return {
      estimate,
      // What the block looks like after this job, so the answer to "and what am
      // I left with?" is on screen before you commit to queuing anything.
      afterP50: Math.max(0, status.block.remainingCredits - estimate.p50),
      afterP90: Math.max(0, status.block.remainingCredits - estimate.p90),
      blockCap: status.block.cap.credits,
      remaining: status.block.remainingCredits,
    };
  });

  app.post('/api/jobs', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const fields = readJobFields(b);
    if (!fields.ok) return reply.code(400).send({ error: fields.error });
    if (!fields.value.prompt) return reply.code(400).send({ error: 'prompt is required' });
    const cwd = String(b.cwd ?? process.cwd());
    if (!existsSync(cwd)) return reply.code(400).send({ error: `no such directory: ${cwd}` });

    const prompt = fields.value.prompt;
    const safety = fields.value.safety ?? (cfg.defaultSafety as Safety);
    const model = fields.value.model ?? effectiveModel(cfg);
    const resumeSessionId = fields.value.resumeSessionId ?? null;
    const estimate = predict(db, { prompt, cwd, model, safety, resumeSessionId });
    const job = createJob(db, {
      prompt,
      promptBlocks: fields.value.promptBlocks ?? null,
      cwd,
      model,
      safety,
      resumeSessionId,
      runPolicy: fields.value.runPolicy ?? 'on-reset',
      runAt: fields.value.runAt ?? null,
      priority: fields.value.priority ?? 0,
      urgent: fields.value.urgent ?? false,
      estimateP50: estimate.p50,
      estimateP90: estimate.p90,
      estimateBasis: estimate.basis,
    });
    void scheduler.tick();
    return reply.code(201).send(job);
  });

  /**
   * Change a job that hasn't started.
   *
   * A queued prompt is a draft: you wrote it on the way out of the door, and by
   * the time the window comes back you have thought of the thing you left out.
   * Two rules keep that from becoming a lie. A run in flight is not editable —
   * the CLI already has the old prompt — and any edit that changes what will be
   * run re-prices it, so the estimate beside a job never describes a prompt that
   * is no longer there.
   */
  app.patch('/api/jobs/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const existing = getJob(db, id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.status === 'running' || scheduler.busy.includes(id)) {
      return reply.code(409).send({ error: 'that job is running — stop it or wait for it to finish' });
    }

    const fields = readJobFields(req.body, { runPolicy: existing.runPolicy, runAt: existing.runAt });
    if (!fields.ok) return reply.code(400).send({ error: fields.error });

    // A job that has run is a record of what ran. Editing its prompt would put
    // a cost and an output next to something that never produced them — unless
    // the same request puts it back in the queue, which clears both.
    if (HAS_RUN.has(existing.status) && fields.value.status !== 'queued') {
      return reply.code(409).send({ error: `a ${existing.status} job records what it ran — queue it again to change it` });
    }

    const patch: Record<string, unknown> = { ...fields.value };
    if (changesTheEstimate(fields.value)) {
      const estimate = predict(db, {
        prompt: fields.value.prompt ?? existing.prompt,
        cwd: existing.cwd,
        model: 'model' in fields.value ? (fields.value.model ?? effectiveModel(cfg)) : existing.model,
        safety: fields.value.safety ?? existing.safety,
        resumeSessionId: 'resumeSessionId' in fields.value ? fields.value.resumeSessionId : existing.resumeSessionId,
      });
      patch.estimateP50 = estimate.p50;
      patch.estimateP90 = estimate.p90;
      patch.estimateBasis = estimate.basis;
    }
    // Putting a job back in the queue means putting it back as it was: the error
    // and output of the attempt that failed belong to that attempt, and leaving
    // them attached makes a waiting job look like it has already gone wrong.
    if (fields.value.status === 'queued' && existing.status !== 'queued') {
      Object.assign(patch, { error: null, output: null, finishedAt: null, startedAt: null, attempts: 0 });
    }

    const job = updateJob(db, id, patch as any);
    if (!job) return reply.code(404).send({ error: 'not found' });
    void scheduler.tick();
    return job;
  });

  app.delete('/api/jobs/:id', async (req, reply) => {
    return deleteJob(db, (req.params as any).id) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/jobs/:id/run', async (req, reply) => {
    const job = getJob(db, (req.params as any).id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    // "Run now" on something already finished would start a second run against
    // a row that still holds the first one's cost and output.
    if (!RUNNABLE.has(job.status) || scheduler.busy.includes(job.id)) {
      return reply.code(409).send({ error: `a ${job.status} job cannot be started` });
    }
    void scheduler.run(job);
    return { ok: true };
  });

  app.post('/api/calibrate', async (req, reply) => {
    const b = req.body as any;
    const kind = (b.window ?? 'block') as WindowKind;
    const status = computeStatus(db, cfg);
    const credits =
      kind === 'block' ? status.block.window.credits
      : kind === 'week' ? status.week.window.credits
      : status.week.window.opusCredits;
    try {
      const cap = addAnchor(db, kind, Number(b.pct), credits);
      return { ok: true, impliedCap: cap };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/config', async () => redactConfig(cfg));

  app.patch('/api/config', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const changes: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(CONFIG_FIELDS)) {
      if (!(key in b)) continue;
      const value = check(b[key]);
      if (value === REJECTED) return reply.code(400).send({ error: `${key} is not a value this setting takes` });
      changes[key] = value;
    }

    // GET hands back masked secrets, so a client that reads the config, edits
    // one field and writes the whole thing back would otherwise save the mask
    // over the real credential and silently break notifications.
    if ('notify' in b) changes.notify = { ...cfg.notify, ...dropMasked(b.notify) };

    // The file, not the running config. `--host` and `--port` are answers to
    // "where should this one run", and writing them back would turn a flag
    // typed once into a setting that outlives the reason for it.
    const persisted = loadConfig();
    Object.assign(persisted, changes);
    saveConfig(persisted);
    Object.assign(cfg, changes);
    return { ok: true };
  });

  app.get('/api/projects', async () => knownProjects(db, claudeDir(cfg)));
  app.get('/api/sessions', async (req) => recentSessions(claudeDir(cfg), String((req.query as any)?.cwd ?? '')));

  app.get('/api/history', async () => {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:00', ts/1000, 'unixepoch') AS hour,
                ROUND(SUM(credits), 4) AS credits
         FROM events WHERE ts >= ? GROUP BY hour ORDER BY hour`,
      )
      .all(Date.now() - 14 * 24 * 3_600_000);
    const byProject = db
      .prepare(
        `SELECT project, ROUND(SUM(credits), 2) AS credits, COUNT(*) AS calls
         FROM events WHERE ts >= ? GROUP BY project ORDER BY credits DESC LIMIT 10`,
      )
      .all(Date.now() - 30 * 24 * 3_600_000);
    return { hourly: rows, byProject };
  });

  // Server-sent events: the dashboard subscribes once and gets pushed updates
  // whenever usage lands or a job changes state.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = () => {
      try {
        reply.raw.write(`data: ${JSON.stringify({ at: Date.now() })}\n\n`);
      } catch {
        // Client went away between the change event and this write.
      }
    };
    send();
    const unsubscribe = deps.onChange(send);
    const keepAlive = setInterval(send, 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  const webRoot = join(HERE, '..', 'web');
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
