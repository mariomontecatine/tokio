import { useState } from 'react';
import { api, type Job, type Status } from './api';
import { money } from './format';

interface Props {
  jobs: Job[];
  status: Status;
  onChange: () => void;
}

const ACTIVE = new Set(['queued', 'deferred', 'running']);

export function Queue({ jobs, status, onChange }: Props) {
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const reasons = new Map(status.decisions.map((d) => [d.id, d.reason]));

  const visible = jobs.filter((j) => (showDone ? true : ACTIVE.has(j.status)));
  const waiting = jobs.filter((j) => ACTIVE.has(j.status)).length;

  async function act(fn: Promise<unknown>) {
    await fn.catch(() => undefined);
    onChange();
  }

  return (
    <section className="panel">
      <div className="queue-head">
        <span className="eyebrow">Queue</span>
        <span className="eyebrow" style={{ color: 'var(--muted)' }}>{waiting} waiting</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setShowDone((v) => !v)}>
          {showDone ? 'hide finished' : 'show finished'}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          <strong>Nothing waiting.</strong>
          When you run out mid-thought, leave the prompt below. It runs itself when your window resets — you don't have to come back for it.
        </div>
      ) : (
        visible.map((job) => (
          <article className="job" key={job.id}>
            <div className="id">{job.id}</div>
            <div className="prompt">
              <p>{job.prompt.length > 220 ? `${job.prompt.slice(0, 220)}…` : job.prompt}</p>
              <div className="why">
                <span className={`tag ${job.status}`}>{job.status}</span>
                {job.safety === 'full' && <span className="tag full">unrestricted</span>}
                {job.resumeSessionId && <span className="tag">continues a session</span>}
                {job.cwd.replace(/^.*\//, '')}
                {job.status !== 'done' && reasons.has(job.id) && <> · {reasons.get(job.id)}</>}
                {job.error && <> · {job.error.slice(0, 120)}</>}
              </div>
              <div className="job-actions">
                {ACTIVE.has(job.status) && job.status !== 'running' && (
                  <button className="btn ghost" onClick={() => void act(api.runNow(job.id))}>run now</button>
                )}
                {job.output && (
                  <button className="btn ghost" onClick={() => setOpen(open === job.id ? null : job.id)}>
                    {open === job.id ? 'hide output' : 'output'}
                  </button>
                )}
                <button className="btn ghost danger" onClick={() => void act(api.remove(job.id))}>remove</button>
              </div>
              {open === job.id && job.output && <pre className="output">{job.output}</pre>}
            </div>
            <div className="cost">
              {job.actualCredits != null ? money(job.actualCredits) : `~${money(job.estimateP50 ?? 0)}`}
              <small>{job.actualCredits != null ? 'spent' : `up to ${money(job.estimateP90 ?? 0)}`}</small>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
