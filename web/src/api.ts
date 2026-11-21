import { useCallback, useEffect, useRef, useState } from 'react';
import { expireCodexWindows } from './codexVerdict';
import { desktop } from './desktop';

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
  /** The same window rebuilt from transcripts, for the stretch `trace` cannot speak for. */
  traceLocal: TracePoint[];
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
  /** Which agents are metered and offered, and whether the person has said so. */
  providers: Providers;
  /** Null while Codex is not in use. */
  codex: CodexStatus | null;
}

export interface Providers {
  claude: boolean;
  codex: boolean;
  chosen: boolean;
}

/** A Codex window as OpenAI reported it. There is no estimated kind. */
export interface CodexWindow {
  expiresAt?: number;
  usedPct: number;
  resetsAt: number | null;
  windowMinutes: number | null;
  start: number | null;
  source: 'reported';
  via: 'app-server' | 'rollout';
  readAt: number;
  ageMs: number;
  stale: boolean;
}

export interface CodexTokens {
  responses: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  usd: number | null;
  unpriced: number;
}

export interface CodexStatus {
  session: CodexWindow | null;
  week: CodexWindow | null;
  planType: string | null;
  limitReached: string | null;
  lastResetAt: number | null;
  probe: { at: number; ageMs: number; error: string | null } | null;
  tokens: { session: CodexTokens; week: CodexTokens; today: CodexTokens };
  /** Models Codex ran here recently, most used first. */
  models: string[];
  /** Whether any OpenAI price has been copied in. Until then Codex is in tokens. */
  priced: boolean;
  /** The day the OpenAI pages behind those prices were read, ISO date. */
  pricesReadOn: string | null;
}

export interface AgentFacts {
  bin: string | null;
  home: string;
  homeExists: boolean;
  found: boolean;
}

export interface Agents {
  claude: AgentFacts;
  codex: AgentFacts;
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
  /** `claude-code` or `codex`. */
  provider: string;
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

export interface Project { path: string; credits: number | null; lastUsed: number | null }
export interface Session { sessionId: string; title: string; updatedAt: number }

/**
 * Access token for a dashboard served beyond loopback.
 *
 * In a browser the daemon hands it over once, in the URL it prints. Keeping it
 * in sessionStorage means a reload or an in-page link doesn't lock you out, and
 * stripping it from the address bar keeps it out of screenshots and history.
 *
 * In the application there is a bridge, so it never goes through the address at
 * all — and that source is checked first, because a window told the token
 * directly should not depend on a query string having survived a reload.
 */
function accessToken(): string | null {
  const fromBridge = desktop()?.token;
  if (fromBridge) return fromBridge;

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

export interface Reach {
  claude: { how: string; bin: string | null; launched: boolean };
  transcripts: { dir: string; exists: boolean; projects: number; remote: boolean }[];
  plan: { id: string | null; basis: 'detected' | 'configured' | 'unknown' };
  providers?: Providers;
  codex?: {
    how: string; bin: string | null; home: string; homeExists: boolean; threads: number;
    priced: boolean; pricesReadOn: string | null;
  } | null;
}

/** `codex` for Codex's folders and threads; anything else is Claude's. */
const forProvider = (provider?: string) => (provider === 'codex' ? 'provider=codex' : '');

export const api = {
  status: () => request<Status>('/api/status'),
  reach: () => request<Reach>('/api/reach'),
  agents: () => request<{ agents: Agents | null; providers: Providers }>('/api/agents'),
  saveProviders: (providers: { claude: boolean; codex: boolean }) =>
    request<{ ok: true }>('/api/config', { method: 'PATCH', body: JSON.stringify({ providers }) }),
  jobs: () => request<Job[]>('/api/jobs'),
  projects: (provider?: string) => request<Project[]>(`/api/projects?${forProvider(provider)}`),
  sessions: (cwd: string, provider?: string) =>
    request<Session[]>(`/api/sessions?cwd=${encodeURIComponent(cwd)}&${forProvider(provider)}`),
  estimate: (body: unknown) =>
    request<{
      estimate: { p50: number; p90: number; basis: string } | null;
      afterP50: number | null; afterP90: number | null; blockCap: number | null; remaining: number | null;
    }>('/api/estimate', { method: 'POST', body: JSON.stringify(body) }),
  queue: (body: unknown) => request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: unknown) => request<Job>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => request<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  runNow: (id: string) => request<{ ok: true }>(`/api/jobs/${id}/run`, { method: 'POST' }),
  refresh: () => request<{ ok: boolean; error: string | null; codexError?: string | null }>('/api/refresh', { method: 'POST' }),
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
  const receivedAt = useRef(0);

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
      receivedAt.current = Date.now();
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

  useEffect(() => {
    const codex = status?.codex;
    if (!status || !codex) return;
    const deadlines = [codex.session, codex.week].flatMap((w) => w?.expiresAt ?? w?.resetsAt ?? []);
    if (!deadlines.length) return;
    const now = () => status.now + Date.now() - receivedAt.current;
    const timer = setTimeout(() => {
      setStatus((prev) => prev === status ? { ...prev, codex: expireCodexWindows(codex, now()) } : prev);
      void refresh();
    }, Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - now())));
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, jobs, live, error, refresh };
}
