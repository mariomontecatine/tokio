import { useState } from 'react';
import { api } from './api';
import type { Translate } from './i18n';

/**
 * Ask for the real percentages now, rather than when the next poll comes round.
 *
 * The daemon reads `/usage` every three minutes while this machine is busy and
 * every twelve once it looks idle — and "idle" is judged from local transcripts,
 * so someone working in the browser gets the slow beat exactly while the number
 * they are watching moves fastest. This is the way out of waiting for it.
 *
 * The arrow always finishes the turn it started. The class is only dropped at an
 * iteration boundary, where the rotation is back at zero, so a quick answer does
 * not snap it back mid-spin and a slow one keeps it turning until it lands.
 */
export function Refresh({ t, onDone }: { t: Translate; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function reread() {
    setBusy(true);
    setSpinning(true);
    try {
      setFailed((await api.refresh()).error);
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  const label = t('refresh.label');

  return (
    <button
      className={`refresh${spinning ? ' spin' : ''}`}
      onClick={reread}
      disabled={busy}
      aria-busy={busy}
      aria-label={label}
      title={failed ? t('refresh.failed', { error: failed }) : label}
      onAnimationIteration={() => { if (!busy) setSpinning(false); }}
      // Only reached under reduced motion, where the turn is collapsed to a
      // single near-instant iteration and never repeats.
      onAnimationEnd={() => setSpinning(false)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33" />
        <path d="M14 2v3.33h-3.33" />
      </svg>
    </button>
  );
}
