import { useEffect, useState } from 'react';
import { api, type Agents, type CodexStatus, type CodexTokens, type CodexWindow, type Providers } from './api';
import type { Lang, Translate } from './i18n';
import { localeOf } from './i18n';
import { Ring } from './Ring';
import { Countdown } from './Countdown';
import { clock, money } from './format';
import { codexSources, tokens } from './codexVerdict';

/** "10 sep" — the same short date the Claude week ring uses. */
const dayMonth = (at: number, lang: Lang): string =>
  new Date(at).toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'short' }).replace('.', '');

/** "21 nov 2026" — the day an OpenAI price page was read, as the page's own date. */
export const readOnDate = (iso: string, lang: Lang): string =>
  new Date(`${iso}T12:00:00Z`)
    .toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace('.', '');

const age = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
};

/** A small label with the agent's colour, over each pair of rings. */
export function ProviderLabel({ brand, t }: { brand: 'claude' | 'codex'; t: Translate }) {
  return (
    <span className={`provider-label brand-${brand}`}>
      <i className="provider-dot" aria-hidden="true" />
      {t(`provider.${brand}`)}
    </span>
  );
}

function windowSub(w: CodexWindow | null, kind: 'session' | 'week', serverNow: number, t: Translate, lang: Lang) {
  if (!w) return t('codex.ring.none');
  // An old reading is still true as a floor, and the caption says how old.
  if (w.stale) return t('codex.ring.stale', { age: age(w.ageMs) });
  if (!w.resetsAt) return t(w.via === 'app-server' ? 'codex.via.app-server.short' : 'codex.via.rollout.short');
  if (kind === 'week') return t('ring.resets.at', { time: `${dayMonth(w.resetsAt, lang)} ${clock(w.resetsAt)}` });
  return <Countdown at={w.resetsAt} serverNow={serverNow} render={(remaining) => t('ring.resets.in', { until: remaining })} />;
}

/**
 * Codex's pair of rings.
 *
 * Both are OpenAI's own percentages or nothing: there is no cap here to
 * estimate against, so a window with no current reading is drawn empty with a
 * dash rather than as a zero nobody measured.
 */
export function CodexRings({ codex, serverNow, t, lang }: { codex: CodexStatus; serverNow: number; t: Translate; lang: Lang }) {
  return (
    <div className="provider-group brand-codex">
      <ProviderLabel brand="codex" t={t} />
      <div className="rings">
        <Ring
          brand="codex"
          usedPct={codex.session?.usedPct ?? null}
          label={t('ring.session')}
          sub={windowSub(codex.session, 'session', serverNow, t, lang)}
        />
        <Ring
          brand="codex"
          usedPct={codex.week?.usedPct ?? null}
          label={t('ring.week')}
          sub={windowSub(codex.week, 'week', serverNow, t, lang)}
        />
      </div>
    </div>
  );
}

function tokenLine(totals: CodexTokens, priced: boolean, t: Translate): string {
  if (totals.responses === 0) return t('codex.tokens.none');
  const base = t('codex.tokens.value', {
    input: tokens(totals.inputTokens),
    cached: tokens(totals.cachedInputTokens),
    output: tokens(totals.outputTokens),
    n: totals.responses,
  });
  if (!priced) return base;
  // A floor, and worded as one. A span with any response unpriced has no
  // total at all, and says how many held it back rather than going quiet.
  if (totals.usd !== null) return `${base} · ${t('codex.usd.atLeast', { amount: money(totals.usd) })}`;
  return `${base} · ${t('codex.usd.unpriced', { n: totals.unpriced })}`;
}

/** Codex's rows in Details: where the rings came from, and what was counted here. */
export function CodexDetails({ codex, t, lang }: { codex: CodexStatus; t: Translate; lang: Lang }) {
  const sources = codexSources(codex);
  return (
    <>
      <div>
        <dt>{t('codex.detail.source')}</dt>
        <dd>
          {sources.length
            ? sources.map(({ kind, reading }) => <div key={kind}>
                {t(kind === 'session' ? 'ring.session' : 'ring.week')} · {t(reading.via === 'app-server' ? 'codex.via.app-server' : 'codex.via.rollout')} · {t('detail.readAge', { age: age(reading.ageMs) })}
              </div>)
            : t('codex.via.none')}
        </dd>
      </div>
      {codex.probe?.error && (
        <div>
          <dt>{t('codex.detail.probe')}</dt>
          <dd className="bad">{codex.probe.error}</dd>
        </div>
      )}
      {codex.planType && (
        <div>
          <dt>{t('codex.detail.plan')}</dt>
          <dd>{t('codex.detail.plan.value', { plan: codex.planType })}</dd>
        </div>
      )}
      <div>
        <dt>{t('codex.detail.window')}</dt>
        <dd>{tokenLine(codex.tokens.session, codex.priced, t)}</dd>
      </div>
      <div>
        <dt>{t('codex.detail.today')}</dt>
        <dd>{tokenLine(codex.tokens.today, codex.priced, t)}</dd>
      </div>
      <div>
        <dt>{t('codex.detail.price')}</dt>
        <dd>
          {codex.priced && codex.pricesReadOn
            ? t('codex.detail.price.value', { date: readOnDate(codex.pricesReadOn, lang) })
            : t('codex.detail.price.none')}
        </dd>
      </div>
    </>
  );
}

/**
 * Which AI do you use?
 *
 * Asked once, on the first run, with what was found on this machine already
 * ticked — so the usual answer is a single click — and reachable again from
 * Details. Each option says what was found, because "Codex: not found" next to
 * a box someone is about to tick is exactly when they need to know it.
 */
export function ProviderPicker({ providers, t, onDone, onCancel }: {
  providers: Providers;
  t: Translate;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [agents, setAgents] = useState<Agents | null>(null);
  const [choice, setChoice] = useState({ claude: providers.claude, codex: providers.codex });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.agents().then((r) => live && setAgents(r.agents)).catch(() => {});
    return () => { live = false; };
  }, []);

  const none = !choice.claude && !choice.codex;

  async function save() {
    if (none || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveProviders(choice);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const found = (brand: 'claude' | 'codex') => {
    const facts = agents?.[brand];
    if (!facts) return null;
    if (facts.bin) return t('agents.found.bin', { bin: facts.bin });
    if (facts.homeExists) return t('agents.found.home', { home: facts.home });
    return t('agents.notFound');
  };

  return (
    <section className="picker" aria-labelledby="picker-title">
      <h2 id="picker-title">{t('agents.title')}</h2>
      <p className="picker-help">{t('agents.help')}</p>
      <div className="picker-options">
        {(['claude', 'codex'] as const).map((brand) => (
          <label key={brand} className={`picker-option brand-${brand}${choice[brand] ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={choice[brand]}
              onChange={(e) => setChoice((c) => ({ ...c, [brand]: e.target.checked }))}
            />
            <span className="picker-name">
              <i className="provider-dot" aria-hidden="true" />
              {t(`agents.${brand}`)}
            </span>
            <span className="picker-found">{found(brand) ?? ' '}</span>
          </label>
        ))}
      </div>
      <div className="picker-bar">
        {none ? <span className="bad">{t('agents.none')}</span> : error ? <span className="bad">{error}</span> : null}
        <div className="spacer" />
        {onCancel && <button className="link" onClick={onCancel}>{t('agents.cancel')}</button>}
        <button className="btn" onClick={() => void save()} disabled={none || busy}>{t('agents.save')}</button>
      </div>
    </section>
  );
}
