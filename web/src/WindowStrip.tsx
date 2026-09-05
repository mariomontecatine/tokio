import type { Status } from './api';
import type { Translate } from './i18n';
import { clock } from './format';
import { projectionOf, tracePaths, xOf, yOf, type Box, type StripInput } from './strip';

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
const BOX: Box = { x0: X0, x1: X1, yTop: Y_TOP, yBottom: Y_BOTTOM };

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
  const { block, trace, traceSource, now, burnRate } = status;
  const start = block.window.start;
  const end = block.window.end;
  const hours = Math.round((end - start) / HOUR);

  // Everything the chart draws is a share of the window, and `usedPct` is the
  // figure the ring is showing. They are not the same as this machine's credits
  // and the difference is the whole point: credits are what tokio watched happen
  // in a terminal here, the percentage is what the account has actually spent,
  // wherever it was spent. A window used from the browser has a real height and
  // no credits at all, and drawing the credits put a flat line under a ring
  // reading 10%.
  const input: StripInput = {
    trace,
    traceSource,
    start,
    end,
    now,
    usedPct: block.usedPct,
    burnRate,
    cap: block.cap.credits,
  };

  const { line, area } = tracePaths(input, BOX);
  const projection = projectionOf(input, BOX);
  const nowX = xOf(now, input, BOX);

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

        <circle className="strip-now" cx={nowX} cy={yOf(block.usedPct, BOX)} r="4" />

        <text className="strip-axis" x={X0} y={Y_BOTTOM + 16} textAnchor="start">{clock(start)}</text>
        <text className="strip-axis" x={X1} y={Y_BOTTOM + 16} textAnchor="end">{clock(end)}</text>
      </svg>
    </div>
  );
}
