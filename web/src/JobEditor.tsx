import { useState } from 'react';
import { api, type Job } from './api';
import type { Translate } from './i18n';
import { PromptField } from './PromptField';
import { draftOf, toPrompt, type Draft } from './pasted';

interface Props {
  job: Job;
  t: Translate;
  onSaved: () => void;
  onCancel: () => void;
}

const SAFETY = ['plan', 'edits', 'full'] as const;
const WHEN = [
  ['on-reset', 'compose.when.onReset'],
  ['asap-if-headroom', 'compose.when.asap'],
  ['manual', 'compose.when.manual'],
] as const;

/**
 * Change a job that hasn't run yet.
 *
 * A queued prompt is a note to yourself written on the way out of the door, and
 * by the time the window comes back you have thought of the thing you left out.
 * Rewriting it beats deleting it and starting again — which is what everyone
 * did instead, losing the folder, the session and the timing along with the
 * sentence they wanted to fix.
 *
 * What was pasted in stays folded. That is the whole reason this reads the job's
 * `promptBlocks` rather than its prompt alone: a two-hundred-line log that
 * unfolded itself on the way back in would make the box unusable at the moment
 * it is needed, and scrolling past someone else's stack trace to reach your own
 * sentence is not editing.
 *
 * "At a time I choose" is missing on purpose. It is a decision about the
 * calendar rather than about the prompt, and a job already scheduled for one
 * keeps its time untouched — nothing here sends `runPolicy` unless it changed.
 */
export function JobEditor({ job, t, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(job.prompt, job.promptBlocks));
  const [safety, setSafety] = useState(job.safety);
  const [when, setWhen] = useState(job.runPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompt = toPrompt(draft);
  const changed = prompt !== job.prompt || safety !== job.safety || when !== job.runPolicy;
  const ready = prompt.length > 0 && changed && !busy;

  async function save() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(job.id, {
        prompt,
        promptBlocks: draft.pasted.map((p) => p.text),
        safety,
        // Only when it moved: sending it unchanged would clear the time off a
        // job that was scheduled for one.
        ...(when === job.runPolicy ? {} : { runPolicy: when }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="job-editor">
      <PromptField
        draft={draft}
        onChange={setDraft}
        placeholder={t('compose.placeholder')}
        onSubmit={() => void save()}
        rows={3}
        autoFocus
        t={t}
      />
      <div className="job-editor-bar">
        <select value={safety} onChange={(e) => setSafety(e.target.value as Job['safety'])} aria-label={t('queue.edit.safety')}>
          {SAFETY.map((s) => <option key={s} value={s}>{t(`compose.safety.${s}`)}</option>)}
        </select>
        {/* A job already set for a specific time keeps that option in the list,
            so choosing something else is a decision rather than an accident. */}
        <select value={when} onChange={(e) => setWhen(e.target.value)} aria-label={t('queue.edit.when')}>
          {job.runPolicy === 'at' && <option value="at">{t('compose.when.at')}</option>}
          {WHEN.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
        </select>
        <div className="spacer" />
        <button className="link" onClick={onCancel} disabled={busy}>{t('queue.edit.cancel')}</button>
        <button className="btn" onClick={save} disabled={!ready}>
          {busy ? t('queue.edit.saving') : t('queue.edit.save')}
        </button>
      </div>
      {error && <p className="job-reason bad">{error}</p>}
    </div>
  );
}
