import { useState } from 'react';
import { api, type Job, type Status } from './api';
import type { Translate } from './i18n';
import { Expand } from './Expand';
import { money } from './format';

interface Props {
  jobs: Job[];
  status: Status;
  onChange: () => void;
  t: Translate;
}

const ACTIVE = new Set(['queued', 'deferred', 'running']);

/** One line per job.
 *
 * The old row carried a status tag, a safety tag, a session tag, a folder, the
 * scheduler's reasoning and any error, all at the same weight — six things
 * shouting to answer one question, which is "what is waiting and what will it
 * cost". Those six are still here, one click down, where they answer the
 * follow-up question instead of drowning the first one.
 */
export function Queue({ jobs, status, onChange, t }: Props) {
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const reasons = new Map(status.decisions.map((d) => [d.id, d.reason]));

  const visible = jobs.filter((job) => (showDone ? true : ACTIVE.has(job.status)));
  const waiting = jobs.filter((job) => ACTIVE.has(job.status)).length;
  const finished = jobs.length - waiting;

  async function act(work: Promise<unknown>) {
    await work.catch(() => undefined);
    onChange();
  }

  return (
    <section className="block">
      <header className="block-head">
        <h2>{t('queue.title')}</h2>
        <span className="block-note">{waiting > 0 ? t('queue.waiting', { n: waiting }) : t('queue.none')}</span>
        <div className="spacer" />
        {finished > 0 && (
          <button className="link" onClick={() => setShowDone((v) => !v)}>
            {showDone ? t('queue.hideFinished') : t('queue.showFinished')}
          </button>
        )}
      </header>

      {visible.length === 0 ? (
        <p className="block-empty">{t('queue.empty')}</p>
      ) : (
        <ul className="jobs">
          {visible.map((job) => {
            const expanded = open === job.id;
            const cost = job.actualCredits != null ? money(job.actualCredits) : `~${money(job.estimateP50 ?? 0)}`;
            return (
              <li key={job.id} className={`job${expanded ? ' open' : ''}`}>
                <button className="job-row" onClick={() => setOpen(expanded ? null : job.id)} aria-expanded={expanded}>
                  <span className={`dot ${job.status}`} aria-hidden="true" />
                  <span className="job-chevron" aria-hidden="true" />
                  <span className="job-prompt">{job.prompt.replace(/\s+/g, ' ').trim()}</span>
                  <span className="job-cost">{cost}</span>
                </button>

                <Expand open={expanded}>
                  <div className="job-detail">
                    <dl>
                      <div>
                        <dt>{job.cwd.replace(/^.*\//, '')}</dt>
                        <dd>{job.status}{job.resumeSessionId ? ' · continues a session' : ''}{job.safety === 'full' ? ' · unrestricted' : ''}</dd>
                      </div>
                      <div>
                        <dt>{job.actualCredits != null ? t('queue.spent') : t('queue.upTo', { amount: money(job.estimateP90 ?? 0) })}</dt>
                        <dd>{job.estimateBasis ?? '—'}</dd>
                      </div>
                    </dl>
                    {job.status !== 'done' && reasons.has(job.id) && <p className="job-reason">{reasons.get(job.id)}</p>}
                    {job.error && <p className="job-reason bad">{job.error}</p>}
                    <div className="job-actions">
                      {ACTIVE.has(job.status) && job.status !== 'running' && (
                        <button className="link" onClick={() => void act(api.runNow(job.id))}>{t('queue.runNow')}</button>
                      )}
                      <button className="link danger" onClick={() => void act(api.remove(job.id))}>{t('queue.remove')}</button>
                    </div>
                    {job.output && <pre className="job-output">{job.output}</pre>}
                  </div>
                </Expand>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
