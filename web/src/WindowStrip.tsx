import type { Status } from './api';
import type { Translate } from './i18n';
import { clock } from './format';

// A viewBox close to the box it actually renders in, so it can scale uniformly.
// Stretching it with preserveAspectRatio="none" would squash the clock labels
// horizontally and turn the two dots into ellipses.
const W = 600;
const H = 150;
const PAD = { left: 8, right: 8, top: 16, bottom: 26 };
const X0 = PAD.left;
const X1 = W - PAD.right;
const Y_TOP = PAD.top;
const Y_BOTTOM = H - PAD.bottom;

const HOUR = 3_600_000;

interface Props {
  status: Status;
  t: Translate;
}

/**
 * Spend across the window, and where this pace lands.
 *
 * The hour divisions carry the whole point: a block is five hours, and five
 * bays you can count say that faster than any sentence. They divide the window
 * evenly rather than falling on clock hours, because a window is not obliged to
 * start on one — when Claude Code reports the reset time, this one runs 08:29
 * to 13:29 — and marking clock hours there would draw six uneven bays, which is
 * the opposite of legible. Evenly divided, each bay is exactly one hour.
 *
 * What is gone is what was never load-bearing: the 0/25/50/75/100 rulings (the
 * ring states that better), the reserve line, and the queue stacked in a corner
 * on a scale it could not be read at.
 */
export function WindowStrip({ status, t }: Props) {
  const { block, trace, now, burnRate } = status;
  const start = block.window.start;
  const end = block.window.end;
  const cap = block.cap.credits || 1;
  const hours = Math.round((end - start) / HOUR);

  const x = (ts: number) => X0 + ((ts - start) / (end - start)) * (X1 - X0);
  const y = (credits: number) => Y_BOTTOM - Math.min(1, Math.max(0, credits / cap)) * (Y_BOTTOM - Y_TOP);

  const spent = block.window.credits;
  const nowX = Math.min(X1, Math.max(X0, x(now)));

  // Stepped, because spend jumps when a response lands and is flat in between.
  // Smoothing it would draw activity that never happened.
  const steps: string[] = [`M ${X0} ${Y_BOTTOM}`];
  let last = 0;
  for (const point of trace) {
    steps.push(`L ${x(point.t).toFixed(1)} ${y(last).toFixed(1)}`);
    steps.push(`L ${x(point.t).toFixed(1)} ${y(point.c).toFixed(1)}`);
    last = point.c;
  }
  steps.push(`L ${nowX.toFixed(1)} ${y(last).toFixed(1)}`);
  const line = steps.join(' ');
  const area = `${line} L ${nowX.toFixed(1)} ${Y_BOTTOM} Z`;

  // The projection stops wherever it lands first: the cap, or the reset.
  //
  // Only while there is still cap left to run into. Past it the arithmetic
  // gives a negative time — a crossing that already happened — and the line is
  // drawn backwards, off the left of the chart. There is nothing to forecast at
  // that point anyway: the window is spent, and the verdict says so in words.
  let projection: { d: string; hitsCap: boolean; atX: number; atY: number } | null = null;
  if (burnRate > 0 && spent < cap) {
    const hoursToCap = (cap - spent) / burnRate;
    const hoursToEnd = (end - now) / HOUR;
    const hitsCap = hoursToCap < hoursToEnd;
    const endT = now + Math.min(hoursToCap, hoursToEnd) * HOUR;
    const endC = spent + burnRate * ((endT - now) / HOUR);
    // Clamped regardless: a chart must not be able to draw outside itself,
    // whatever the arithmetic above ever produces.
    const atX = Math.max(nowX, Math.min(X1, x(endT)));
    const atY = y(endC);
    projection = { d: `M ${nowX.toFixed(1)} ${y(spent).toFixed(1)} L ${atX.toFixed(1)} ${atY.toFixed(1)}`, hitsCap, atX, atY };
  }

  // One line per hour boundary inside the window: `hours` bays, `hours - 1`
  // lines. Left unlabelled — the two ends carry the times, and six timestamps
  // to say one thing is how a chart turns back into small print.
  const ticks = Array.from({ length: Math.max(0, hours - 1) }, (_, i) => X0 + ((i + 1) / hours) * (X1 - X0));

  return (
    <div className="pace-chart">
      <div className="pace-head">
        <span>{t('pace.window', { n: hours })}</span>
        <span>{t('pace.reset', { time: clock(end) })}</span>
      </div>

      <svg className="strip" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={t('pace.window', { n: hours }) + `, ${Math.round(block.usedPct)}%`}>
        {ticks.map((at) => (
          <line key={at} className="strip-hour" x1={at} x2={at} y1={Y_TOP} y2={Y_BOTTOM} />
        ))}
        <line className="strip-base" x1={X0} x2={X1} y1={Y_BOTTOM} y2={Y_BOTTOM} />

        <path className="strip-area" d={area} />
        <path className="strip-line" d={line} />

        {projection && (
          <>
            <path className={`strip-projection${projection.hitsCap ? ' over' : ''}`} d={projection.d} />
            <circle className={`strip-end${projection.hitsCap ? ' over' : ''}`} cx={projection.atX} cy={projection.atY} r="3" />
          </>
        )}

        <circle className="strip-now" cx={nowX} cy={y(spent)} r="4" />

        <text className="strip-axis" x={X0} y={Y_BOTTOM + 16} textAnchor="start">{clock(start)}</text>
        <text className="strip-axis" x={X1} y={Y_BOTTOM + 16} textAnchor="end">{clock(end)}</text>
      </svg>
    </div>
  );
}
