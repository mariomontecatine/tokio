import { useEffect, useState } from 'react';
import { api, useDashboard, type PeriodName, type Status, type ValueReport } from './api';
import { Ring, pressureOf, type Pressure } from './Ring';
import { WindowStrip } from './WindowStrip';
import { Compose } from './Compose';
import { Queue } from './Queue';
import { Reveal } from './Reveal';
import { Countdown } from './Countdown';
import { Heatmap } from './Heatmap';
import { Expand } from './Expand';
import { clock, money, pct, until } from './format';
import { useLang, localeOf, type Lang, type Translate } from './i18n';
import { startSmoothScroll } from './smoothScroll';

const HOUR = 3_600_000;

/** "10 sep" — enough to place a reset without spelling out a whole date. */
const dayMonth = (at: number, lang: Lang): string =>
  new Date(at).toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'short' }).replace('.', '');

/**
 * "9–24", "≤3" when even one expensive turn would not fit, or a single figure
 * when both ends agree.
 *
 * A range, not one number: a turn's cost varies by an order of magnitude with
 * what you ask for, and a single figure would hide that. The low end assumes
 * expensive turns, the high end typical ones.
 */
function turnCount(few: number, many: number): string {
  if (few >= many) return String(many);
  if (few <= 0) return `≤${many}`;
  return `${few}–${many}`;
}

interface Verdict {
  line: string;
  detail: string | null;
  pressure: Pressure;
  /** Where this pace lands by the reset, for the ring's second arc. */
  projectedPct: number | null;
}

/**
 * Do I make it to the reset?
 *
 * The whole tool exists because that question used to be answerable only by
 * cross-reading a percentage, a burn rate and a clock. It is one sentence, and
 * it is the first thing on the page.
 */
function readVerdict(status: Status, t: Translate): Verdict {
  const { block, burnRate, now, exhaustionAt } = status;
  const cap = block.cap.credits;

  if (burnRate <= 0 || cap <= 0) {
    // Idle: the useful thing is not how many dollars are left — nobody buys
    // dollars — but how much more work fits. Counted in your own prompts, with
    // the percentage as the fallback when there is too little history to say.
    const room = status.headroom;
    const line =
      room === null
        ? t('verdict.idle.pct', { pct: pct(100 - block.usedPct) })
        : room.many <= 0
          ? t('verdict.idle.none')
          : t('verdict.idle.turns', { count: turnCount(room.few, room.many) });
    return { line, detail: null, pressure: pressureOf(block.usedPct), projectedPct: null };
  }

  const hoursLeft = Math.max(0, (block.resetsAt - now) / HOUR);
  const projectedPct = ((block.window.credits + burnRate * hoursLeft) / cap) * 100;

  if (exhaustionAt && exhaustionAt < block.resetsAt) {
    return {
      line: t('verdict.dry', { time: clock(exhaustionAt) }),
      detail: t('verdict.dry.detail', { until: until(block.resetsAt, exhaustionAt) }),
      pressure: 'over',
      projectedPct,
    };
  }
  if (projectedPct >= 65) {
    return {
      line: t('verdict.tight'),
      detail: t('verdict.tight.detail', { pct: pct(projectedPct) }),
      pressure: 'tight',
      projectedPct,
    };
  }
  return {
    line: t('verdict.clear'),
    detail: t('verdict.clear.detail', { pct: pct(projectedPct) }),
    pressure: 'ease',
    projectedPct,
  };
}

/** Everything true but not urgent. Present, one click away, never in the way. */
function Details({ status, t, lang, onRefresh }: { status: Status; t: Translate; lang: Lang; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const reported = status.block.source === 'reported';
  const age = status.probe ? Math.round(status.probe.ageMs / 1000) : null;
  const ageLabel = age === null ? '—' : age < 90 ? `${age}s` : `${Math.round(age / 60)}m`;
  const worth = status.value;

  async function reread() {
    setBusy(true);
    try {
      await api.refresh();
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  return (
    <div className="details">
      <dl className="facts">
        <div>
          <dt>{t('detail.source')}</dt>
          <dd>
            {reported ? t('detail.source.reported') : t('detail.source.estimated')}
            {age !== null && <> · {t('detail.readAge', { age: ageLabel })}</>}
            {' '}
            <button className="link" onClick={reread} disabled={busy}>
              {busy ? t('detail.rereading') : t('detail.reread')}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t('detail.remaining')}</dt>
          <dd>{money(status.block.remainingCredits)} {t('detail.of', { total: money(status.block.cap.credits) })}</dd>
        </div>
        {status.headroom && (
          <div>
            <dt>{t('detail.turnsLeft')}</dt>
            <dd>
              {t('detail.turnsLeft.value', {
                count: turnCount(status.headroom.few, status.headroom.many),
                p50: money(status.headroom.turnP50),
                p90: money(status.headroom.turnP90),
                n: status.headroom.sample,
              })}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('detail.burn')}</dt>
          <dd>{status.burnRate > 0 ? `${money(status.burnRate)}/h` : '—'}</dd>
        </div>
        <div>
          <dt>{t('detail.reserve')}</dt>
          <dd>{pct(status.reservePct)} — {t('detail.reserve.help')}</dd>
        </div>
        {status.accuracy.n >= 3 && (
          <div>
            <dt>{t('detail.accuracy')}</dt>
            <dd>{t('detail.accuracy.value', { pct: pct(status.accuracy.withinP90 * 100) })}</dd>
          </div>
        )}
        {status.weekOpus && (
          <div>
            <dt>{t('detail.opus')}</dt>
            <dd>{pct(status.weekOpus.usedPct)} · {money(status.weekOpus.window.opusCredits)} / {money(status.weekOpus.cap.credits)}</dd>
          </div>
        )}
        {worth.reconciliation && (
          <div>
            <dt>{t('detail.reconciliation')}</dt>
            <dd>
              {t('detail.reconciliation.value', {
                ours: money(worth.reconciliation.ourUsd),
                theirs: money(worth.reconciliation.reportedUsd),
                n: worth.reconciliation.sessions,
              })}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('detail.plan')}</dt>
          <dd>
            {status.planLabel}
            {' · '}
            {status.planBasis === 'detected'
              ? t('detail.plan.detected', { evidence: status.plan })
              : status.planBasis === 'configured'
                ? t('detail.plan.configured')
                : t('detail.plan.unknown')}
          </dd>
        </div>
        <div>
          <dt>{t('detail.period')}</dt>
          <dd>
            {t(worth.sinceIsFirstTranscript ? 'detail.period.transcript' : 'detail.period.configured', {
              since: new Date(worth.since).toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'long' }),
            })}
          </dd>
        </div>
        {worth.byMonth.length > 0 && (
          <div>
            <dt>{t('detail.month')}</dt>
            <dd>{worth.byMonth.slice(0, 4).map((m) => `${m.month} ${money(m.usd)}`).join(' · ')}</dd>
          </div>
        )}
      </dl>
      {/* Not a footnote for its own sake: every figure above is a counterfactual
          at list prices, and the page should never let that be forgotten. */}
      <p className="details-note">{t('detail.prices')}</p>
    </div>
  );
}

/** Only shown while the cap is still a guess — which is exactly when it matters. */
function Calibration({ status, t, onDone }: { status: Status; t: Translate; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);

  if (status.block.source === 'reported') return null;
  if (status.block.cap.basis === 'calibrated' && saved === null) return null;

  if (saved !== null) {
    return <p className="notice">{t('calibrate.done', { amount: money(saved) })}</p>;
  }

  return (
    <div className="notice">
      <div>
        <strong>{t('calibrate.title')}</strong>
        <span>{t('calibrate.help')}</span>
      </div>
      <div className="notice-action">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="63"
          inputMode="numeric"
          aria-label={t('calibrate.title')}
        />
        <button
          className="btn"
          disabled={!value}
          onClick={() => void api.calibrate('block', Number(value)).then((r) => { setSaved(r.impliedCap); onDone(); })}
        >
          {t('calibrate.action')}
        </button>
      </div>
    </div>
  );
}

/**
 * What the subscription returned.
 *
 * The second figure is the fee, not a bill — and it read as one: "for $105
 * paid" next to a usage total looks like money you were charged on top. Naming
 * it as the subscription and showing the arithmetic behind it (32 days at
 * $100/month) makes it checkable at a glance instead of alarming.
 */
/**
 * No all-time figure. Claude Code keeps transcripts for thirty days, so "since
 * the beginning" is a month for almost everyone — the same month the headline
 * already reports, dressed up as a longer view. Two numbers that differ only by
 * rounding, one of them implying a history nobody has.
 */
function Worth({ value, t, lang }: { value: ValueReport; t: Translate; lang: Lang }) {
  const month = value.periods.month;

  return (
    <section className="block worth">
      <header className="block-head">
        <h2>{t('worth.title')}</h2>
      </header>
      {/* Thirty days leads, not the whole history. The all-time figure keeps
          stretching over months you may barely have used, so it answers "has it
          been worth it ever" — a duller question than "is it worth it now". */}
      {month.multiple === null || month.paidUsd === null ? (
        <p className="block-empty">{t('worth.unknown')}</p>
      ) : (
        <div className="worth-body">
          <div className="worth-figure">
            {month.multiple.toFixed(1)}<span>×</span>
          </div>
          <p className="worth-line">
            {t('worth.line', {
              used: money(month.usd),
              paid: money(month.paidUsd),
              rate: value.monthlyUsd === null ? '—' : money(value.monthlyUsd),
            })}
          </p>
        </div>
      )}

      {/* The headline says how much the plan returned; these say when. A single
          all-time figure cannot tell steady use from three heroic afternoons. */}
      <dl className="periods">
        {(['today', 'yesterday', 'week'] as PeriodName[]).map((name) => {
          const period = value.periods[name];
          return (
            <div key={name}>
              <dt>{t(`worth.${name}`)}</dt>
              <dd title={`${money(period.usd)} ${period.paidUsd === null ? '' : `/ ${money(period.paidUsd)}`}`}>
                {period.multiple === null || period.usd <= 0
                  ? <span className="quiet">{t('worth.period.none')}</span>
                  : <>{period.multiple.toFixed(1)}<span>×</span></>}
              </dd>
            </div>
          );
        })}
      </dl>

      <Heatmap byDay={value.byDay} dailyUsd={value.dailyUsd} t={t} lang={lang} />
    </section>
  );
}

export default function App() {
  const { status, jobs, live, error, refresh } = useDashboard();
  const { lang, setLang, t } = useLang();
  const [showDetails, setShowDetails] = useState(false);

  // Inertial wheel scrolling. Set up once, and it undoes itself completely on
  // the way out — see smoothScroll.ts for what it deliberately leaves alone.
  useEffect(() => startSmoothScroll(), []);

  if (error && !status) {
    return (
      <div className="shell">
        <header className="masthead"><span className="wordmark">tokio</span></header>
        <div className="block-empty stand-alone">
          <strong>{t('error.daemon')}</strong>
          <span>{t('error.daemon.help')}</span>
        </div>
      </div>
    );
  }
  if (!status) {
    return <div className="shell"><header className="masthead"><span className="wordmark">tokio</span></header></div>;
  }

  const verdict = readVerdict(status, t);
  const week = status.week;

  return (
    <div className="shell">
      <header className="masthead">
        <span className="wordmark">tokio</span>
        <span className="plan">{status.planLabel}</span>
        {live === false && <span className="stale">{t('error.stale')}</span>}
        <div className="spacer" />
        {/* A segmented control rather than two buttons: the pill slides between
            fixed-width halves, so switching language moves the indicator and
            nothing else. */}
        <div className="segmented" data-active={lang} role="group" aria-label="Language">
          <span className="segmented-pill" aria-hidden="true" />
          {(['es', 'en'] as Lang[]).map((code) => (
            <button key={code} onClick={() => setLang(code)} aria-pressed={lang === code}>
              {code.toUpperCase()}
            </button>
          ))}
        </div>
        {/* Reserved width: "Details" and "Detalles" are different lengths, and
            without this the whole right-hand group jumps on every switch. */}
        <button className="link details-toggle" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
          {showDetails ? t('details.hide') : t('details.show')}
        </button>
      </header>

      <section className={`state tone-${verdict.pressure}`}>
        <div className="rings">
          <Ring
            usedPct={status.block.usedPct}
            projectedPct={verdict.projectedPct}
            pressure={verdict.pressure}
            label={t('ring.session')}
            sub={
              <Countdown
                at={status.block.resetsAt}
                serverNow={status.now}
                render={(remaining) => t('ring.resets.in', { until: remaining })}
              />
            }
          />
          <Ring
            usedPct={week.usedPct}
            label={t('ring.week')}
            sub={
              week.rolling
                ? t('ring.rolling')
                : t('ring.resets.at', { time: `${dayMonth(week.resetsAt, lang)} ${clock(week.resetsAt)}` })
            }
          />
        </div>

        <div className="pace">
          {status.block.window.events > 0 ? (
            <WindowStrip status={status} t={t} />
          ) : (
            <p className="block-empty">{t('pace.idle')}</p>
          )}
        </div>
      </section>

      <p className={`verdict tone-${verdict.pressure}`}>
        {verdict.line}
        {verdict.detail && <span className="quiet"> {verdict.detail}</span>}
      </p>

      <Expand open={showDetails}>
        <Details status={status} t={t} lang={lang} onRefresh={refresh} />
      </Expand>

      <Calibration status={status} t={t} onDone={refresh} />

      <Reveal>
        <Queue jobs={jobs} status={status} onChange={refresh} t={t} />
      </Reveal>

      <Reveal delay={60}>
        <section className="block">
          <Compose status={status} onQueued={refresh} t={t} />
        </section>
      </Reveal>

      <Reveal delay={120}>
        <Worth value={status.value} t={t} lang={lang} />
      </Reveal>
    </div>
  );
}
