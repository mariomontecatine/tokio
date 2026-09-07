import { useEffect, useState } from 'react';
import { api, type Reach as ReachFacts } from './api';
import type { Translate } from './i18n';

/**
 * What these numbers can see, said once, in the interface.
 *
 * Every figure here has a reach, and they are not the same one. The rings come
 * from Anthropic and cover the whole account. Everything priced is rebuilt from
 * transcripts, and transcripts only exist where the work was done — so a
 * browser session or a second computer is spend that no reading here can
 * recover.
 *
 * That gap has always been respected in the metering and never stated to the
 * person reading the result. A number that quietly means less than it appears
 * to is the failure this project cares about most, so it is said on the first
 * run and then kept one click away rather than repeated forever.
 */
export function Reach({ t, onDismiss }: { t: Translate; onDismiss?: () => void }) {
  const [facts, setFacts] = useState<ReachFacts | null>(null);

  useEffect(() => {
    let live = true;
    void api.reach().then((r) => live && setFacts(r)).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!facts) return null;

  const { claude, transcripts, plan } = facts;

  // A missing plan or a missing CLI is a limit on what can be shown, not a
  // failure to report — so they are stated in the same voice as the rest.
  const claudeLine =
    claude.how === 'unknown' ? t('reach.claude.unknown')
      : claude.how === 'wsl' ? t('reach.claude.wsl', { bin: claude.bin ?? '' })
      : claude.how === 'configured' ? t('reach.claude.configured', { bin: claude.bin ?? '' })
      : claude.how === 'path-shim' ? t('reach.claude.shim')
      : t('reach.claude.path');

  const planLine =
    plan.basis === 'detected' ? t('reach.plan.detected', { plan: plan.id ?? '' })
      : plan.basis === 'configured' ? t('reach.plan.configured', { plan: plan.id ?? '' })
      : t('reach.plan.unknown');

  return (
    <section className="reach">
      <h2>{t('reach.title')}</h2>
      <ul>
        <li>{t('reach.gauges')}</li>
        <li>{t('reach.priced.local')}</li>
        <li>{claudeLine}</li>
        {transcripts.map((where) => (
          <li key={where.dir}>
            {where.exists && where.projects > 0
              ? t('reach.transcripts', { dir: where.dir, count: String(where.projects) })
              : t('reach.transcripts.none', { dir: where.dir })}
            {where.remote && <> {t('reach.transcripts.remote')}</>}
          </li>
        ))}
        {transcripts.length > 1 && <li>{t('reach.transcripts.both')}</li>}
        <li>{planLine}</li>
      </ul>
      {onDismiss && (
        <button className="act" onClick={onDismiss}>{t('reach.dismiss')}</button>
      )}
    </section>
  );
}
