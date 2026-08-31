import { useEffect, useMemo, useState } from 'react';
import { api, type Project, type Session, type Status } from './api';
import { money, pct } from './format';

interface Props {
  status: Status;
  onQueued: () => void;
}

type Forecast = Awaited<ReturnType<typeof api.estimate>>;

const SAFETY_HELP: Record<string, string> = {
  plan: 'Reads and proposes. Changes nothing.',
  edits: 'Edits files and runs tools, but asks nothing.',
  full: 'No restrictions. It can change and run anything in that folder.',
};

export function Compose({ status, onQueued }: Props) {
  const [prompt, setPrompt] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [safety, setSafety] = useState('edits');
  const [when, setWhen] = useState('on-reset');
  const [resume, setResume] = useState('');
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.projects().then((list) => {
      setProjects(list);
      setCwd((current) => current || list[0]?.path || '');
    });
  }, []);

  useEffect(() => {
    if (!cwd) return;
    setResume('');
    void api.sessions(cwd).then(setSessions).catch(() => setSessions([]));
  }, [cwd]);

  // The forecast is the reason this panel exists, so keep it current as you
  // type — but not on every keystroke.
  useEffect(() => {
    if (!cwd) return;
    const id = setTimeout(() => {
      void api
        .estimate({ prompt, cwd, model: model || null, safety, resumeSessionId: resume || null })
        .then(setForecast)
        .catch(() => setForecast(null));
    }, 400);
    return () => clearTimeout(id);
  }, [prompt, cwd, model, safety, resume]);

  const afterPct = useMemo(() => {
    if (!forecast || !forecast.blockCap) return null;
    return {
      p50: (forecast.afterP50 / forecast.blockCap) * 100,
      p90: (forecast.afterP90 / forecast.blockCap) * 100,
    };
  }, [forecast]);

  const tight = Boolean(forecast && forecast.afterP90 <= 0);

  async function submit() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.queue({
        prompt,
        cwd,
        model: model || null,
        safety,
        resumeSessionId: resume || null,
        runPolicy: when,
      });
      setPrompt('');
      onQueued();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel compose">
      <div className="eyebrow" style={{ marginBottom: 9 }}>Leave a prompt for later</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
        placeholder="The one thing you didn't get to test…"
        aria-label="Prompt to queue"
      />

      <div className="controls">
        <select value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Project">
          {projects.map((p) => (
            <option key={p.path} value={p.path}>{p.path.replace(/^.*\//, '') || p.path}</option>
          ))}
        </select>

        <select value={resume} onChange={(e) => setResume(e.target.value)} aria-label="Session to continue">
          <option value="">new session</option>
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>continue: {s.title.slice(0, 40)}</option>
          ))}
        </select>

        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          <option value="">default model</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
        </select>

        <select value={safety} onChange={(e) => setSafety(e.target.value)} aria-label="What it's allowed to do" title={SAFETY_HELP[safety]}>
          <option value="plan">plan only</option>
          <option value="edits">edit files</option>
          <option value="full">no restrictions</option>
        </select>

        <select value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When to run">
          <option value="on-reset">when the window resets</option>
          <option value="asap-if-headroom">as soon as it fits</option>
          <option value="manual">only when I say</option>
        </select>

        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={submit} disabled={!prompt.trim() || busy}>
          {busy ? 'Queueing…' : 'Queue it'}
        </button>
      </div>

      <div className={`forecast${tight ? ' tight' : ''}`}>
        {forecast ? (
          <>
            Costs about <b>{money(forecast.estimate.p50)}</b>, up to <b>{money(forecast.estimate.p90)}</b>
            {afterPct && (
              <> · leaves you at <b>{pct(afterPct.p50)}</b> of this window{afterPct.p90 !== afterPct.p50 && <>, worst case <b>{pct(afterPct.p90)}</b></>}</>
            )}
            <span className="basis"> · based on {forecast.estimate.basis}</span>
          </>
        ) : (
          <span className="basis">Working out what this will cost…</span>
        )}
      </div>
      <div className="forecast basis" style={{ borderTop: 0, paddingTop: 4, marginTop: 0 }}>
        {SAFETY_HELP[safety]}{safety === 'full' && ' It runs while you are away.'}
      </div>
      {error && <div className="forecast tight"><b>{error}</b></div>}
    </section>
  );
}
