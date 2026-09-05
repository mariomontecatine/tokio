import type { JobStatus, RunPolicy, Safety } from '../types.ts';
import { checkPromptBlocks } from './blocks.ts';

/**
 * What a client is allowed to say about a job.
 *
 * The queue runs a real CLI against a real directory while nobody is watching,
 * so the fields that decide *what* it runs and *when* are worth reading
 * strictly. A bad value used to be taken at face value and then quietly change
 * the behaviour: an unknown safety mode dropped `--permission-mode` from the
 * command line altogether, and `runPolicy: "at"` with no time waited for the
 * first of January 1970 — a job that says "queued" on screen and will never
 * start.
 *
 * Kept apart from the HTTP layer so the rules can be tested as rules.
 */

export const SAFETIES: readonly Safety[] = ['plan', 'edits', 'full'];
export const RUN_POLICIES: readonly RunPolicy[] = ['on-reset', 'asap-if-headroom', 'at', 'manual'];

/** Statuses a person may set by hand. The rest are the scheduler's to write. */
export const SETTABLE_STATUS: readonly JobStatus[] = ['queued', 'cancelled'];

export interface JobFields {
  prompt?: string;
  promptBlocks?: string[] | null;
  model?: string | null;
  safety?: Safety;
  resumeSessionId?: string | null;
  runPolicy?: RunPolicy;
  runAt?: number | null;
  priority?: number;
  urgent?: boolean;
  status?: JobStatus;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The current shape a patch is being applied to, so the pair can be checked together. */
export interface JobBaseline {
  runPolicy: RunPolicy;
  runAt: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A time as a number of millis or as anything `Date.parse` understands. */
function readTime(value: unknown): number | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

/** An optional string field that also accepts null and "" for "not set". */
function readNullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * Read the job fields out of a request body, keeping only what was actually sent.
 *
 * `baseline` is the job as it stands (absent when one is being created). It
 * matters for the one rule that spans two fields: "at a time I choose" needs a
 * time, and changing only one half of that pair must still leave a job that can
 * run.
 */
export function readJobFields(body: unknown, baseline?: JobBaseline): Checked<JobFields> {
  if (!isObject(body)) return { ok: false, error: 'expected a JSON object' };
  const out: JobFields = {};

  if ('prompt' in body) {
    if (typeof body.prompt !== 'string') return { ok: false, error: 'prompt must be text' };
    const prompt = body.prompt.trim();
    if (!prompt) return { ok: false, error: 'prompt is required' };
    out.prompt = prompt;
  }

  // Only meaningful next to a prompt, and only ever as much of it as really is
  // in there — checkPromptBlocks throws away anything that has drifted.
  if ('promptBlocks' in body && 'prompt' in out) {
    out.promptBlocks = checkPromptBlocks(out.prompt!, body.promptBlocks);
  }

  if ('model' in body) {
    const model = readNullableText(body.model);
    if (model === undefined) return { ok: false, error: 'model must be a name or null' };
    out.model = model;
  }

  if ('resumeSessionId' in body) {
    const session = readNullableText(body.resumeSessionId);
    if (session === undefined) return { ok: false, error: 'resumeSessionId must be an id or null' };
    out.resumeSessionId = session;
  }

  if ('safety' in body) {
    if (!SAFETIES.includes(body.safety as Safety)) {
      return { ok: false, error: `safety must be one of ${SAFETIES.join(', ')}` };
    }
    out.safety = body.safety as Safety;
  }

  if ('runPolicy' in body) {
    if (!RUN_POLICIES.includes(body.runPolicy as RunPolicy)) {
      return { ok: false, error: `runPolicy must be one of ${RUN_POLICIES.join(', ')}` };
    }
    out.runPolicy = body.runPolicy as RunPolicy;
  }

  if ('runAt' in body) {
    const at = readTime(body.runAt);
    if (at === undefined) return { ok: false, error: 'runAt must be a time' };
    out.runAt = at;
  }

  if ('priority' in body) {
    const priority = Number(body.priority);
    if (!Number.isFinite(priority)) return { ok: false, error: 'priority must be a number' };
    out.priority = Math.trunc(priority);
  }

  if ('urgent' in body) out.urgent = Boolean(body.urgent);

  if ('status' in body) {
    if (!SETTABLE_STATUS.includes(body.status as JobStatus)) {
      return { ok: false, error: `status may only be set to ${SETTABLE_STATUS.join(' or ')}` };
    }
    out.status = body.status as JobStatus;
  }

  const policy = out.runPolicy ?? baseline?.runPolicy ?? 'on-reset';
  if (policy === 'at') {
    const at = out.runAt ?? baseline?.runAt ?? null;
    if (at === null) return { ok: false, error: 'a job scheduled for a time needs one' };
    out.runAt = at;
  } else if (out.runPolicy) {
    // Dropping the time with the policy keeps the two from disagreeing later,
    // when nothing on screen would explain a leftover date.
    out.runAt = null;
  }

  return { ok: true, value: out };
}

/** Whether a change of these fields makes the stored estimate describe the old job. */
export function changesTheEstimate(fields: JobFields): boolean {
  return 'prompt' in fields || 'model' in fields || 'safety' in fields || 'resumeSessionId' in fields;
}
