import { useEffect, useMemo, useState } from 'react';
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
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [safety, setSafety] = useState('edits');
  const [when, setWhen] = useState('on-reset');
  // Defaults to an hour out, so choosing "at a time" never starts on a moment
  // that has already gone.
  const [runAt, setRunAt] = useState(() => toLocalInput(Date.now() + 3_600_000));
  const [resume, setResume] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.projects().then((list) => {
      setProjects(list);
      setCwd((current) => {
        if (current) return current;
        const saved = remembered('cwd');
        if (saved && list.some((p) => p.path === saved)) return saved;
        return list[0]?.path ?? '';
      });
    });
  }, []);

  // The session you were last continuing is remembered per folder, because
  // "the last session" only means anything inside one project.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void api
      .sessions(cwd)
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const saved = remembered(`session:${cwd}`);
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
  }, [cwd]);

  function chooseCwd(next: string) {
    setCwd(next);
    remember('cwd', next);
  }

  function chooseResume(next: string) {
    setResume(next);
    remember(`session:${cwd}`, next);
  }

  // The whole prompt, folded blocks and all — which is what the estimate is
  // priced on, so the forecast can never quietly ignore the largest part of it.
  const fullPrompt = useMemo(() => toPrompt(draft), [draft]);
  const ready = fullPrompt.length > 0;

  useEffect(() => {
    if (!cwd || !ready) {
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
  }, [fullPrompt, ready, cwd, model, safety, resume]);

  const afterPct = useMemo(() => {
    if (!forecast || !forecast.blockCap) return null;
    return (forecast.afterP50 / forecast.blockCap) * 100;
  }, [forecast]);

  const tight = Boolean(forecast && forecast.afterP90 <= 0);

  const scheduledFor = when === 'at' ? Date.parse(runAt) : null;
  const schedulePassed = scheduledFor !== null && (!Number.isFinite(scheduledFor) || scheduledFor <= Date.now());

  async function submit() {
    if (!ready || busy || schedulePassed) return;
    setBusy(true);
    setError(null);
    try {
      await api.queue({
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
        <button className="btn" onClick={submit} disabled={!ready || busy || schedulePassed}>
          {busy ? t('compose.submitting') : t('compose.submit')}
        </button>
      </div>

      <Expand open={showOptions}>
        <div className="compose-options">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            <option value="">{t('compose.defaultModel')}</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
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

      <Expand open={Boolean(error) || Boolean(ready && forecast)}>
        {error ? (
          <p className="compose-forecast bad">{error}</p>
        ) : (
          <p className={`compose-forecast${tight ? ' bad' : ''}`}>
            {forecast &&
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
