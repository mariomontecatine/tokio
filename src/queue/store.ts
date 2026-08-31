import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Job, JobStatus, RunPolicy, Safety } from '../types.ts';

export interface NewJob {
  prompt: string;
  cwd: string;
  model?: string | null;
  safety: Safety;
  resumeSessionId?: string | null;
  runPolicy?: RunPolicy;
  runAt?: number | null;
  priority?: number;
  urgent?: boolean;
  provider?: string;
  estimateP50?: number | null;
  estimateP90?: number | null;
  estimateBasis?: string | null;
}

const COLUMNS = `id, provider, prompt, cwd, model, safety, resumeSessionId, runPolicy, runAt,
  priority, urgent, status, estimateP50, estimateP90, estimateBasis, actualCredits,
  resultSessionId, output, error, attempts, createdAt, startedAt, finishedAt`;

function hydrate(row: any): Job {
  return { ...row, urgent: Boolean(row.urgent) } as Job;
}

export function createJob(db: Db, input: NewJob): Job {
  const id = randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO jobs (id, provider, prompt, cwd, model, safety, resumeSessionId, runPolicy, runAt,
      priority, urgent, status, estimateP50, estimateP90, estimateBasis, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.provider ?? 'claude-code',
    input.prompt,
    input.cwd,
    input.model ?? null,
    input.safety,
    input.resumeSessionId ?? null,
    input.runPolicy ?? 'on-reset',
    input.runAt ?? null,
    input.priority ?? 0,
    input.urgent ? 1 : 0,
    'queued',
    input.estimateP50 ?? null,
    input.estimateP90 ?? null,
    input.estimateBasis ?? null,
    Date.now(),
  );
  return getJob(db, id)!;
}

export function getJob(db: Db, id: string): Job | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

export function listJobs(db: Db, status?: JobStatus[]): Job[] {
  const sql = status?.length
    ? `SELECT ${COLUMNS} FROM jobs WHERE status IN (${status.map(() => '?').join(',')})
       ORDER BY priority DESC, createdAt`
    : `SELECT ${COLUMNS} FROM jobs ORDER BY
       CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END,
       priority DESC, createdAt DESC`;
  return (db.prepare(sql).all(...((status ?? []) as [])) as any[]).map(hydrate);
}

/** Jobs eligible to be considered by the scheduler, most important first. */
export function pendingJobs(db: Db): Job[] {
  return listJobs(db, ['queued', 'deferred']);
}

export function updateJob(db: Db, id: string, patch: Partial<Job>): Job | null {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (!keys.length) return getJob(db, id);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const v = (patch as any)[k];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
  db.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(...(values as []), id);
  return getJob(db, id);
}

export function deleteJob(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes) > 0;
}

/** Anything left mid-flight by a daemon that died goes back in the queue. */
export function requeueOrphans(db: Db): number {
  return Number(
    db.prepare("UPDATE jobs SET status = 'queued', startedAt = NULL WHERE status = 'running'").run().changes,
  );
}
