import { useState } from 'react';
import { api, useDashboard, type Status, type ValueReport } from './api';
import { WindowStrip } from './WindowStrip';
import { Compose } from './Compose';
import { Queue } from './Queue';
import { clock, money, pct, until } from './format';
import { useState as useReactState } from 'react';

/**
 * Where the percentages came from, and the button that goes and gets them again.
 *
 * Reading Claude Code's own `/usage` is free and takes a few seconds, so the
 * honest thing is to show its age and let anyone demand a fresh one rather than
 * quietly serving a number from twenty minutes ago.
 */
function Provenance({ status, onRefresh }: { status: Status; onRefresh: () => void }) {
  const [busy, setBusy] = useReactState(false);
  const reported = status.block.source === 'reported';
  const age = status.probe ? Math.round(status.probe.ageMs / 1000) : null;

  async function run() {
    setBusy(true);
    try {
      await api.refresh();
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  return (
    <>
      <span className="plan" style={{ color: reported ? 'var(--spent)' : 'var(--queued)' }}>
        {reported ? 'reported by Claude Code' : 'estimated'}
      </span>
      <button className="btn ghost refresh" onClick={run} disabled={busy} title="Re-read /usage">
        {busy ? 'reading…' : age === null ? 'read /usage' : age < 90 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}
        <span aria-hidden="true"> ↻</span>
      </button>
      {status.probe?.error && <span className="plan" style={{ color: 'var(--over)' }}>{status.probe.error}</span>}
    </>
  );
}

function Gauge({ name, used, total, usedPct, sub, color }: {
  name: string; used: number; total: number; usedPct: number; sub: string; color: string;
}) {
  return (
    <div className="gauge">
      <div className="gauge-top">
        <span className="name">{name}</span>
        <span className="pct" style={{ color: usedPct > 90 ? 'var(--over)' : undefined }}>{pct(usedPct)}</span>
      </div>
      <div className="track">
        <span style={{ width: `${Math.min(100, usedPct)}%`, background: color }} />
      </div>
      <div className="sub">{money(used)} of {money(total)} · {sub}</div>
    </div>
  );
}

/**
 * What the subscription has returned.
 *
 * The multiple leads because it is the number that answers "is this worth it".
 * The provenance line is not fine print: this counts one machine's transcripts
 * at list prices, and saying so is what makes the headline trustworthy.
 */
function Worth({ value }: { value: ValueReport }) {
  if (value.multiple === null) return null;
  const since = new Date(value.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <div className="gauge worth">
      <div className="gauge-top">
        <span className="name">subscription payback</span>
      </div>
      <div className="worth-figure">
        {value.multiple.toFixed(1)}<span className="x">×</span>
      </div>
      <div className="sub">
        {money(value.equivalentUsd)} of API usage for {money(value.paidUsd!)} paid
      </div>
      <div className="sub" style={{ color: 'var(--dim)' }}>
        since {since}{value.sinceIsFirstTranscript ? ', your oldest transcript' : ''} · {money(value.thisWeekUsd)} this week
      </div>
    </div>
  );
}

function Calibration({ status, onDone }: { status: Status; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);

  // Nothing to calibrate while Claude Code is telling us the real number.
  if (status.block.source === 'reported') return null;
  if (status.block.cap.basis === 'calibrated' && saved === null) return null;

  return (
    <div className="notice">
      {saved !== null ? (
        <span>Got it — your 5-hour window holds about <b>{money(saved)}</b>. Numbers above are now yours, not an estimate.</span>
      ) : (
        <>
          <span>
            <b style={{ color: 'var(--text)' }}>These limits are a guess.</b> Anthropic doesn't publish them.
            Run <code>/usage</code> in Claude Code and type the 5-hour percentage it shows you.
          </span>
          <div className="spacer" />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="63"
            inputMode="numeric"
            aria-label="Percentage Claude Code reports for the 5-hour window"
          />
          <button
            className="btn"
            onClick={() =>
              void api.calibrate('block', Number(value)).then((r) => {
                setSaved(r.impliedCap);
                onDone();
              })
            }
            disabled={!value}
          >
            Set it
          </button>
        </>
      )}
    </div>
  );
}

export default function App() {
  const { status, jobs, live, error, refresh } = useDashboard();

  if (error && !status) {
    return (
      <div className="shell">
        <header className="masthead"><span className="wordmark">tokio</span></header>
        <div className="empty">
          <strong>The daemon isn't answering.</strong>
          Start it with <code>tokio start</code>, then this page will pick it up. ({error})
        </div>
      </div>
    );
  }
  if (!status) return <div className="shell"><header className="masthead"><span className="wordmark">tokio</span></header></div>;

  const queued = jobs.filter((j) => j.status === 'queued' || j.status === 'deferred');
  const dry = status.exhaustionAt;

  return (
    <div className="shell">
      <header className="masthead">
        <span className="wordmark">tokio</span>
        <span className="plan">{status.planLabel}</span>
        <Provenance status={status} onRefresh={refresh} />
        <div className="spacer" />
        <span className={`live${live ? '' : ' stale'}`}><i />{live ? 'live' : 'reconnecting'}</span>
      </header>

      <section className="panel strip">
        <div className="strip-head">
          <div className="headline">
            {pct(status.block.usedPct)} <span className="unit">of your 5-hour window</span>
          </div>
          <div className="spacer" />
          <div className="readout">
            <div className="label">resets in</div>
            <div className="value">{until(status.block.resetsAt, status.now)}</div>
          </div>
        </div>

        <WindowStrip status={status} queued={queued} />

        <div className="readouts">
          <div className="readout">
            <div className="label">left</div>
            <div className="value">{money(status.block.remainingCredits)}</div>
          </div>
          <div className="readout">
            <div className="label">burn rate</div>
            <div className="value">{status.burnRate > 0 ? `${money(status.burnRate)}/h` : 'idle'}</div>
          </div>
          <div className="readout">
            <div className="label">runs dry</div>
            <div className={`value${dry ? ' bad' : ''}`}>{dry ? clock(dry) : 'not this window'}</div>
          </div>
          <div className="readout">
            <div className="label">queued</div>
            <div className={`value${queued.length ? ' warn' : ''}`}>{queued.length}</div>
          </div>
          {status.accuracy.n >= 3 && (
            <div className="readout">
              <div className="label">forecast accuracy</div>
              <div className="value">{pct(status.accuracy.withinP90 * 100)} within range</div>
            </div>
          )}
        </div>
      </section>

      <Calibration status={status} onDone={refresh} />

      <div className="columns">
        <div className="panel">
          <Worth value={status.value} />
          <Gauge
            name="week"
            used={status.week.window.credits}
            total={status.week.cap.credits}
            usedPct={status.week.usedPct}
            sub={status.week.rolling ? 'rolling 7 days' : `resets ${clock(status.week.resetsAt)}`}
            color="var(--spent)"
          />
          {status.weekOpus && (
            <Gauge
              name="opus this week"
              used={status.weekOpus.window.opusCredits}
              total={status.weekOpus.cap.credits}
              usedPct={status.weekOpus.usedPct}
              sub="separate allowance"
              color="var(--opus)"
            />
          )}
          <div className="gauge">
            <div className="gauge-top">
              <span className="name">reserve kept free</span>
              <span className="pct">{pct(status.reservePct)}</span>
            </div>
            <div className="sub">Queued jobs stop before eating this, so there's always something left for you.</div>
          </div>
        </div>

        <Queue jobs={jobs} status={status} onChange={refresh} />
      </div>

      <Compose status={status} onQueued={refresh} />
    </div>
  );
}
