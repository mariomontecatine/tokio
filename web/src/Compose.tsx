import { useEffect, useMemo, useState } from 'react';
import { composeTarget, dashboardProviders } from './providers';
import { api, type Project, type Session, type Status } from './api';
import type { Translate } from './i18n';
import { Expand } from './Expand';
import { PromptField } from './PromptField';
import { emptyDraft, toPrompt, type Draft } from './pasted';
import { money, pct } from './format';

interface Props {
  status: Status;
  onQueued: () => void;
  t: Translate;
}

type Forecast = Awaited<ReturnType<typeof api.estimate>>;

const SAFETY = ['plan', 'edits', 'full'] as const;
const WHEN = [
  ['on-reset', 'compose.when.onReset'],
  ['asap-if-headroom', 'compose.when.asap'],
  ['at', 'compose.when.at'],
  ['manual', 'compose.when.manual'],
] as const;

/** `datetime-local` wants wall-clock text, and it means the user's own zone. */
function toLocalInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(`tokio.compose.${key}`);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`tokio.compose.${key}`, value);
  } catch {
    // Private mode can refuse storage. Losing the preference is not worth an error.
  }
}

/**
 * Leave a prompt for later.
 *
 * Four things are on show, and they are the four you actually touch: the
 * prompt, the folder, the session, and the button. Model, permissions and
 * timing are folded away because their defaults are right nearly every time —
 * and a control you never change is not a choice, it is furniture.
 *
 * The forecast appears only once there is something to forecast. An empty box
 * has nothing to say about cost, and saying it anyway is how a page fills up
 * with numbers nobody asked for.
 */
export function Compose({ status, onQueued, t }: Props) {
  const on = dashboardProviders(status.providers);
  // Which agent runs it. Offered only when both are in use; otherwise it is
  // whichever one is, and nothing on screen asks.
  const [chosen, setChosen] = useState<string>(() => remembered('provider') ?? 'claude-code');
  const provider = !on.codex ? 'claude-code' : !on.claude ? 'codex' : chosen === 'codex' ? 'codex' : 'claude-code';
  const codex = provider === 'codex';
  // Each agent remembers its own folder and session: a Codex thread is not a
  // Claude session, and the same folder can have both.
  const key = (name: string) => (codex ? `codex.${name}` : name);

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folder, setFolder] = useState({ provider, path: '' });
  const setCwd = (path: string) => setFolder({ provider, path });
  const [modelChoice, setModelChoice] = useState({ provider, name: '' });
  const setModel = (name: string) => setModelChoice({ provider, name });
  const [safety, setSafety] = useState('edits');
  const [when, setWhen] = useState('on-reset');
  // Defaults to an hour out, so choosing "at a time" never starts on a moment
  // that has already gone.
  const [runAt, setRunAt] = useState(() => toLocalInput(Date.now() + 3_600_000));
  const [thread, setThread] = useState({ provider, cwd: '', id: '' });
  const { cwd, model, resume } = composeTarget(provider, folder, modelChoice, thread);
  const setResume = (id: string) => setThread({ provider, cwd, id });
  const [showOptions, setShowOptions] = useState(false);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The folder list is the agent's own: where Claude Code has transcripts, or
  // where Codex has threads. Switching agents re-reads it and re-picks a folder.
  useEffect(() => {
    let cancelled = false;
    setProjects([]);
    void api.projects(provider).then((list) => {
      if (cancelled) return;
      setProjects(list);
      const saved = remembered(key('cwd'));
      setCwd(saved && list.some((p) => p.path === saved) ? saved : list[0]?.path ?? '');
    }).catch(() => {
      if (!cancelled) setProjects([]);
    });
    return () => {
      cancelled = true;
    };
    // `key` follows `provider`, which is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // The session you were last continuing is remembered per folder, because
  // "the last session" only means anything inside one project.
  useEffect(() => {
    setSessions([]);
    if (!cwd) return;
    let cancelled = false;
    void api
      .sessions(cwd, provider)
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const saved = remembered(key(`session:${cwd}`));
        setResume(saved && list.some((s) => s.sessionId === saved) ? saved : '');
      })
      .catch(() => {
        if (cancelled) return;
        setSessions([]);
        setResume('');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, provider]);

  function chooseProvider(next: string) {
    setChosen(next);
    remember('provider', next);
    // A model name belongs to one agent; carrying it across would hand Codex
    // "opus".
    setCwd('');
    setResume('');
    setModel('');
    setForecast(null);
  }

  function chooseCwd(next: string) {
    setCwd(next);
    remember(key('cwd'), next);
  }

  function chooseResume(next: string) {
    setResume(next);
    remember(key(`session:${cwd}`), next);
  }

  // The whole prompt, folded blocks and all — which is what the estimate is
  // priced on, so the forecast can never quietly ignore the largest part of it.
  const fullPrompt = useMemo(() => toPrompt(draft), [draft]);
  const ready = fullPrompt.length > 0;

  useEffect(() => {
    // Codex has no dollar estimate to ask for; the line below says why instead.
    if (!cwd || !ready || codex) {
      setForecast(null);
      return;
    }
    const id = setTimeout(() => {
      void api
        .estimate({ prompt: fullPrompt, cwd, model: model || null, safety, resumeSessionId: resume || null })
        .then(setForecast)
        .catch(() => setForecast(null));
    }, 400);
    return () => clearTimeout(id);
  }, [fullPrompt, ready, cwd, model, safety, resume, codex]);

  const afterPct = useMemo(() => {
    if (!forecast || !forecast.blockCap || forecast.afterP50 === null) return null;
    return (forecast.afterP50 / forecast.blockCap) * 100;
  }, [forecast]);

  const tight = Boolean(forecast && forecast.afterP90 !== null && forecast.afterP90 <= 0);
  const codexUsed = status.codex?.session?.usedPct ?? null;

  const scheduledFor = when === 'at' ? Date.parse(runAt) : null;
  const schedulePassed = scheduledFor !== null && (!Number.isFinite(scheduledFor) || scheduledFor <= Date.now());

  async function submit() {
    if (!cwd || !ready || busy || schedulePassed) return;
    setBusy(true);
    setError(null);
    try {
      await api.queue({
        provider,
        prompt: fullPrompt,
        promptBlocks: draft.pasted.map((p) => p.text),
        cwd,
        model: model || null,
        safety,
        resumeSessionId: resume || null,
        runPolicy: when,
        runAt: scheduledFor,
      });
      setDraft(emptyDraft());
      setForecast(null);
      onQueued();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const projectName = (path: string) => path.replace(/^.*\//, '') || path;

  // An untitled session is still worth picking, so label it by when you last
  // touched it — "Continue: 13:09" tells you which one you mean; five entries
  // all reading "(untitled)" tell you nothing.
  const sessionLabel = (session: Session) =>
    session.title
      ? session.title.slice(0, 38)
      : new Date(session.updatedAt).toLocaleString(undefined, {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });

  return (
    <div className="compose">
      <PromptField
        draft={draft}
        onChange={setDraft}
        placeholder={t('compose.placeholder')}
        onSubmit={() => void submit()}
        t={t}
      />

      <div className="compose-bar">
        {on.claude && on.codex && (
          <select
            className={`compose-agent brand-${codex ? 'codex' : 'claude'}`}
            value={provider}
            onChange={(e) => chooseProvider(e.target.value)}
            aria-label={t('compose.agent')}
          >
            <option value="claude-code">{t('provider.claude')}</option>
            <option value="codex">{t('provider.codex')}</option>
          </select>
        )}
        <select value={cwd} onChange={(e) => chooseCwd(e.target.value)} aria-label="Folder">
          {projects.map((p) => (
            <option key={p.path} value={p.path}>{projectName(p.path)}</option>
          ))}
        </select>
        <select value={resume} onChange={(e) => chooseResume(e.target.value)} aria-label="Session">
          <option value="">{t('compose.newSession')}</option>
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>{t('compose.continue', { title: sessionLabel(s) })}</option>
          ))}
        </select>
        <button className="link" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions}>
          {showOptions ? t('compose.hideOptions') : t('compose.options')}
        </button>
        <div className="spacer" />
        <button className="btn" onClick={submit} disabled={!cwd || !ready || busy || schedulePassed}>
          {busy ? t('compose.submitting') : t('compose.submit')}
        </button>
      </div>

      <Expand open={showOptions}>
        <div className="compose-options">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            {codex ? (
              <>
                <option value="">{t('compose.defaultModel.codex')}</option>
                {(status.codex?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </>
            ) : (
              <>
                <option value="">{t('compose.defaultModel')}</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </>
            )}
          </select>
          <select value={safety} onChange={(e) => setSafety(e.target.value)} aria-label="Permissions">
            {SAFETY.map((s) => <option key={s} value={s}>{t(`compose.safety.${s}`)}</option>)}
          </select>
          <select value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When to run">
            {WHEN.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select>
          {when === 'at' && (
            <input
              type="datetime-local"
              value={runAt}
              min={toLocalInput(Date.now())}
              onChange={(e) => setRunAt(e.target.value)}
              aria-label={t('compose.when.at')}
            />
          )}
          <p className="compose-help">
            {when === 'at'
              ? schedulePassed
                ? <span className="bad">{t('compose.when.at.past')}</span>
                : t('compose.when.at.help')
              : t(`compose.safety.${safety}.help`)}
          </p>
        </div>
      </Expand>

      <Expand open={Boolean(error) || Boolean(ready && (forecast || codex))}>
        {error ? (
          <p className="compose-forecast bad">{error}</p>
        ) : codex ? (
          <p className="compose-forecast">
            {codexUsed === null
              ? t('compose.codex.forecast.none')
              : t('compose.codex.forecast', { pct: pct(codexUsed) })}
          </p>
        ) : (
          <p className={`compose-forecast${tight ? ' bad' : ''}`}>
            {forecast && forecast.estimate &&
              (tight
                ? t('compose.forecastTight', {
                    p50: money(forecast.estimate.p50),
                    p90: money(forecast.estimate.p90),
                  })
                : t('compose.forecast', {
                    p50: money(forecast.estimate.p50),
                    p90: money(forecast.estimate.p90),
                    after: afterPct === null ? '—' : pct(afterPct),
                  }))}
          </p>
        )}
      </Expand>
    </div>
  );
}
