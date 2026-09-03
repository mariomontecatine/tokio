import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.ts';
import type { Config } from '../config.ts';
import { saveConfig, claudeDir, redactConfig } from '../config.ts';
import { computeStatus } from '../meter/index.ts';
import { computeValue } from '../meter/value.ts';
import { predict } from '../estimator/predict.ts';
import { accuracy } from '../estimator/learn.ts';
import { addAnchor, planLabel, type WindowKind } from '../plans/calibrate.ts';
import { resolvePlan } from '../plans/detect.ts';
import { createJob, deleteJob, getJob, listJobs, updateJob } from '../queue/store.ts';
import type { Scheduler } from '../queue/scheduler.ts';
import { recentSessions, knownProjects } from './projects.ts';
import { effectiveModel } from '../models.ts';
import type { Safety } from '../types.ts';

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

  app.get('/api/status', async () => ({
    ...computeStatus(db, cfg),
    value: computeValue(db, cfg),
    planLabel: planLabel(resolvePlan(cfg).plan),
    accuracy: accuracy(db),
    decisions: scheduler.explain().map((d) => ({ id: d.job.id, run: d.run, reason: d.reason })),
  }));

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
    const b = req.body as any;
    const prompt = String(b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' });
    const cwd = String(b.cwd ?? process.cwd());
    if (!existsSync(cwd)) return reply.code(400).send({ error: `no such directory: ${cwd}` });

    const safety = (b.safety ?? cfg.defaultSafety) as Safety;
    const model = b.model ?? effectiveModel(cfg);
    const estimate = predict(db, { prompt, cwd, model, safety, resumeSessionId: b.resumeSessionId ?? null });
    const job = createJob(db, {
      prompt,
      cwd,
      model,
      safety,
      resumeSessionId: b.resumeSessionId ?? null,
      runPolicy: b.runPolicy ?? 'on-reset',
      runAt: b.runAt ?? null,
      priority: Number(b.priority ?? 0),
      urgent: Boolean(b.urgent),
      estimateP50: estimate.p50,
      estimateP90: estimate.p90,
      estimateBasis: estimate.basis,
    });
    void scheduler.tick();
    return reply.code(201).send(job);
  });

  app.patch('/api/jobs/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const allowed = ['prompt', 'priority', 'runPolicy', 'runAt', 'safety', 'model', 'urgent', 'status'] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in (req.body as any)) patch[key] = (req.body as any)[key];
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

  app.patch('/api/config', async (req) => {
    const b = req.body as any;
    const allowed = ['plan', 'defaultSafety', 'defaultModel', 'reservePct', 'weeklyAnchor',
      'concurrency', 'notify', 'customCaps', 'subscriptionStartedAt', 'planPriceUsd'] as const;
    for (const key of allowed) {
      if (!(key in b)) continue;
      // GET hands back masked secrets, so a client that reads the config,
      // edits one field and writes the whole thing back would otherwise save
      // the mask over the real credential and silently break notifications.
      if (key === 'notify') {
        cfg.notify = { ...cfg.notify, ...dropMasked(b.notify) };
        continue;
      }
      (cfg as any)[key] = b[key];
    }
    saveConfig(cfg);
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
