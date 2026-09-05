import { useCallback, useEffect, useRef, useState } from 'react';

export interface TracePoint {
  t: number;
  pct: number;
}

export interface Status {
  now: number;
  plan: string;
  planLabel: string;
  planBasis: 'detected' | 'configured' | 'unknown';
  trace: TracePoint[];
  traceSource: 'reported' | 'estimated';
  reservePct: number;
  block: WindowStatus;
  week: WindowStatus;
  weekOpus: WindowStatus | null;
  burnRate: number;
  exhaustionAt: number | null;
  queued: number;
  accuracy: { n: number; medianRatio: number; withinP90: number };
  value: ValueReport;
  headroom: { turnP50: number; turnP90: number; few: number; many: number; sample: number } | null;
  probe: { at: number; ageMs: number; stale: boolean; error: string | null } | null;
  decisions: { id: string; run: boolean; reason: string }[];
}

export type PeriodName = 'today' | 'yesterday' | 'week' | 'month';

export interface PeriodValue {
  usd: number;
  paidUsd: number | null;
  multiple: number | null;
}

export interface ValueReport {
  since: number;
  sinceIsFirstTranscript: boolean;
  equivalentUsd: number;
  paidUsd: number | null;
  monthlyUsd: number | null;
  elapsedDays: number;
  multiple: number | null;
  thisWeekUsd: number;
  thisBlockUsd: number;
  byMonth: { month: string; usd: number }[];
  dailyUsd: number | null;
  periods: Record<PeriodName, PeriodValue>;
  byDay: { day: string; usd: number }[];
  reconciliation: { sessions: number; reportedUsd: number; ourUsd: number; ratio: number } | null;
}

export interface WindowStatus {
  window: { start: number; end: number; credits: number; opusCredits: number; events: number };
  cap: { credits: number; basis: 'default' | 'calibrated' | 'reported'; anchors?: number };
  usedPct: number;
  remainingCredits: number;
  source: 'reported' | 'estimated';
  resetsAt: number;
  rolling: boolean;
}

export interface Job {
  id: string;
  prompt: string;
  /** Which stretches of the prompt were pasted, so they stay folded when it is reopened. */
  promptBlocks: string[] | null;
  cwd: string;
  model: string | null;
  safety: 'plan' | 'edits' | 'full';
  resumeSessionId: string | null;
  runPolicy: string;
  runAt: number | null;
  urgent: boolean;
  status: string;
  estimateP50: number | null;
  estimateP90: number | null;
  estimateBasis: string | null;
  actualCredits: number | null;
  error: string | null;
  output: string | null;
  createdAt: number;
}

export interface Project { path: string; credits: number; lastUsed: number | null }
export interface Session { sessionId: string; title: string; updatedAt: number }

/**
 * Access token for a dashboard served beyond loopback.
 *
 * The daemon hands it over once, in the URL it prints. Keeping it in
 * sessionStorage means a reload or an in-page link doesn't lock you out, and
 * stripping it from the address bar keeps it out of screenshots and history.
 */
function accessToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try {
      sessionStorage.setItem('tokio.token', fromUrl);
      history.replaceState(null, '', location.pathname);
    } catch {
      // Private mode can refuse storage; the in-memory copy below still works.
    }
    cachedToken = fromUrl;
    return fromUrl;
  }
  if (cachedToken) return cachedToken;
  try {
    cachedToken = sessionStorage.getItem('tokio.token');
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

let cachedToken: string | null = null;

/** EventSource cannot set headers, so the token rides along as a query param. */
export function withToken(url: string): string {
  const token = accessToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = accessToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    throw new Error('This dashboard needs the access token. Open the URL the daemon printed.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(detail.error ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<Status>('/api/status'),
  jobs: () => request<Job[]>('/api/jobs'),
  projects: () => request<Project[]>('/api/projects'),
  sessions: (cwd: string) => request<Session[]>(`/api/sessions?cwd=${encodeURIComponent(cwd)}`),
  estimate: (body: unknown) =>
    request<{ estimate: { p50: number; p90: number; basis: string }; afterP50: number; afterP90: number; blockCap: number; remaining: number }>(
      '/api/estimate', { method: 'POST', body: JSON.stringify(body) },
    ),
  queue: (body: unknown) => request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: unknown) => request<Job>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => request<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  runNow: (id: string) => request<{ ok: true }>(`/api/jobs/${id}/run`, { method: 'POST' }),
  refresh: () => request<{ ok: boolean; error: string | null }>('/api/refresh', { method: 'POST' }),
  calibrate: (window: string, pct: number) =>
    request<{ impliedCap: number }>('/api/calibrate', { method: 'POST', body: JSON.stringify({ window, pct }) }),
};

/** How often to ask anyway: rarely while the stream is delivering, often when it isn't. */
const POLL_LIVE_MS = 60_000;
const POLL_DEAD_MS = 5_000;

/**
 * Everything the dashboard shows, refreshed when the daemon says something
 * changed. The interval is a fallback for when the event stream drops.
 */
export function useDashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Null until the event stream has said something either way. Starting at
  // `false` would flash a "reconnecting" warning on every fresh load.
  const [live, setLive] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const missed = useRef(false);

  // A change that lands mid-request is not dropped, it is taken next. The old
  // guard returned silently, which meant the very updates that arrive in a
  // burst — a job finishing, usage landing — were the ones most likely to be
  // thrown away, leaving the page a version behind until the next poll.
  const refresh = useCallback(async function again(): Promise<void> {
    if (inFlight.current) {
      missed.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const [s, j] = await Promise.all([api.status(), api.jobs()]);
      setStatus(s);
      setJobs(j);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (missed.current) {
        missed.current = false;
        void again();
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const source = new EventSource(withToken('/api/stream'));
    source.onmessage = () => {
      setLive(true);
      void refresh();
    };
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [refresh]);

  // The stream is the update mechanism; this is the fallback for when it isn't
  // one. While it is delivering, a minute is plenty — polling on top of a push
  // is the same page fetched twice.
  useEffect(() => {
    const poll = setInterval(refresh, live === false ? POLL_DEAD_MS : POLL_LIVE_MS);
    return () => clearInterval(poll);
  }, [refresh, live]);

  return { status, jobs, live, error, refresh };
}
