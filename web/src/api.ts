import { useCallback, useEffect, useRef, useState } from 'react';

export interface Status {
  now: number;
  plan: string;
  planLabel: string;
  trace: { t: number; c: number }[];
  reservePct: number;
  block: WindowStatus;
  week: WindowStatus;
  weekOpus: WindowStatus | null;
  burnRate: number;
  exhaustionAt: number | null;
  queued: number;
  accuracy: { n: number; medianRatio: number; withinP90: number };
  value: ValueReport;
  probe: { at: number; ageMs: number; stale: boolean; error: string | null } | null;
  decisions: { id: string; run: boolean; reason: string }[];
}

export interface ValueReport {
  since: number;
  sinceIsFirstTranscript: boolean;
  equivalentUsd: number;
  paidUsd: number | null;
  elapsedDays: number;
  multiple: number | null;
  thisWeekUsd: number;
  thisBlockUsd: number;
  byMonth: { month: string; usd: number }[];
}

export interface WindowStatus {
  window: { start: number; end: number; credits: number; opusCredits: number; events: number };
  cap: { credits: number; basis: 'default' | 'calibrated'; anchors?: number };
  usedPct: number;
  remainingCredits: number;
  source: 'reported' | 'estimated';
  resetsAt: number;
  rolling: boolean;
}

export interface Job {
  id: string;
  prompt: string;
  cwd: string;
  model: string | null;
  safety: 'plan' | 'edits' | 'full';
  resumeSessionId: string | null;
  runPolicy: string;
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

/**
 * Everything the dashboard shows, refreshed when the daemon says something
 * changed. The interval is a fallback for when the event stream drops.
 */
export function useDashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
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
    const poll = setInterval(refresh, 20_000);
    return () => {
      source.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return { status, jobs, live, error, refresh };
}
