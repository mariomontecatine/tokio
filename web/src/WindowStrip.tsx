import type { Job, Status } from './api';
import { clock, money, until } from './format';

const W = 1000;
const H = 172;
const PAD = { left: 46, right: 10, top: 14, bottom: 28 };
const X0 = PAD.left;
const X1 = W - PAD.right;
const Y_TOP = PAD.top;
const Y_BOTTOM = H - PAD.bottom;
/** The window itself gets most of the width; the rest is the runway after the reset. */
const BLOCK_SHARE = 0.78;

const HOUR = 3_600_000;

interface Props {
  status: Status;
  queued: Job[];
}

/**
 * The window as a chart recorder.
 *
 * One picture answers all three questions at once: the filled trace is what
 * you've spent so far, the dashed line is where your current pace lands you,
 * and the blocks past the reset rule are the jobs waiting to run in the next
 * window. Nothing here is decorative — every mark is a quantity.
 */
export function WindowStrip({ status, queued }: Props) {
  const { block, trace, now, burnRate, reservePct } = status;
  const start = block.window.start;
  const end = block.window.end;
  const cap = block.cap.credits || 1;

  const resetX = X0 + (X1 - X0) * BLOCK_SHARE;
  const x = (t: number) => X0 + ((t - start) / (end - start)) * (resetX - X0);
  const y = (c: number) => Y_BOTTOM - Math.min(1, Math.max(0, c / cap)) * (Y_BOTTOM - Y_TOP);

  const spent = block.window.credits;
  const nowX = Math.min(resetX, x(now));

  // Stepped trace: spend jumps when a response lands and is flat in between,
  // which is what actually happens — smoothing it would invent activity.
  const steps: string[] = [`M ${X0} ${Y_BOTTOM}`];
  let last = 0;
  for (const p of trace) {
    steps.push(`L ${x(p.t).toFixed(1)} ${y(last).toFixed(1)}`);
    steps.push(`L ${x(p.t).toFixed(1)} ${y(p.c).toFixed(1)}`);
    last = p.c;
  }
  steps.push(`L ${nowX.toFixed(1)} ${y(last).toFixed(1)}`);
  const line = steps.join(' ');
  const area = `${line} L ${nowX.toFixed(1)} ${Y_BOTTOM} Z`;

  // Projection at the current pace, stopping wherever it lands first.
  let projection: { d: string; hitsCap: boolean } | null = null;
  if (burnRate > 0) {
    const hoursToCap = (cap - spent) / burnRate;
    const hoursToEnd = (end - now) / HOUR;
    const hitsCap = hoursToCap < hoursToEnd;
    const endT = now + Math.min(hoursToCap, hoursToEnd) * HOUR;
    const endC = spent + burnRate * ((endT - now) / HOUR);
    projection = { d: `M ${nowX.toFixed(1)} ${y(spent).toFixed(1)} L ${x(endT).toFixed(1)} ${y(endC).toFixed(1)}`, hitsCap };
  }

  const hours: number[] = [];
  for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) hours.push(t);

  const reserveLine = cap * (1 - reservePct / 100);

  // Queued jobs stack up from zero in the next window, so their combined bite
  // is legible against the same scale as everything else.
  let stacked = 0;
  const chips = queued.slice(0, 6).map((job) => {
    const size = job.estimateP50 ?? 0;
    const bottom = stacked;
    stacked += size;
    return { job, bottom, top: stacked, size };
  });
  const chipX = resetX + 14;
  const chipW = Math.max(24, X1 - chipX - 6);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`5-hour window, ${Math.round(block.usedPct)}% used`}>
      {/* ruling */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={X0} x2={X1} y1={y(cap * f)} y2={y(cap * f)} stroke="var(--line-soft)" strokeWidth="1" />
          <text x={X0 - 8} y={y(cap * f) + 3.5} textAnchor="end" className="axis">
            {Math.round(f * 100)}
          </text>
        </g>
      ))}
      {hours.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={Y_TOP} y2={Y_BOTTOM} stroke="var(--line-soft)" strokeWidth="1" />
          <text x={x(t)} y={Y_BOTTOM + 15} textAnchor="middle" className="axis">{clock(t)}</text>
        </g>
      ))}

      {/* the floor the scheduler protects */}
      <line x1={X0} x2={resetX} y1={y(reserveLine)} y2={y(reserveLine)} stroke="var(--over)" strokeWidth="1" strokeDasharray="2 4" opacity="0.55" />
      <text x={X0 + 4} y={y(reserveLine) - 5} className="axis over">reserve</text>

      {/* spend so far */}
      <path d={area} fill="var(--spent)" opacity="0.13" />
      <path d={line} fill="none" stroke="var(--spent)" strokeWidth="1.8" strokeLinejoin="round" />

      {projection && (
        <>
          <path d={projection.d} fill="none" stroke={projection.hitsCap ? 'var(--over)' : 'var(--queued)'} strokeWidth="1.4" strokeDasharray="4 4" />
          {projection.hitsCap && status.exhaustionAt && (
            <text x={x(status.exhaustionAt) + 6} y={Y_TOP + 12} className="axis over">dry {clock(status.exhaustionAt)}</text>
          )}
        </>
      )}

      {/* now */}
      <line x1={nowX} x2={nowX} y1={Y_TOP - 4} y2={Y_BOTTOM} stroke="var(--text)" strokeWidth="1" opacity="0.5" />
      <circle cx={nowX} cy={y(spent)} r="3.2" fill="var(--spent)" />

      {/* reset */}
      <line x1={resetX} x2={resetX} y1={Y_TOP - 8} y2={Y_BOTTOM + 6} stroke="var(--queued)" strokeWidth="1.2" />
      <text x={resetX + 6} y={Y_TOP - 2} className="axis queued">
        resets {clock(block.resetsAt)} · in {until(block.resetsAt, now)}
      </text>

      {/* A queue worth cents against a $125 cap draws as a sliver, so the total
          is spelled out rather than left to be read off the bars. */}
      {chips.length > 0 && (
        <text x={chipX + 4} y={Y_TOP + 10} className="axis queued">
          {queued.length} job{queued.length === 1 ? '' : 's'} · ~{money(stacked)}
        </text>
      )}
      {chips.length > 0 ? (
        chips.map(({ job, bottom, top }) => (
          <g key={job.id}>
            <rect
              x={chipX}
              y={y(top)}
              width={chipW}
              height={Math.max(3, y(bottom) - y(top))}
              fill="var(--queued)"
              opacity={job.status === 'deferred' ? 0.32 : 0.5}
              stroke="var(--queued)"
              strokeWidth="0.8"
            />
            {y(bottom) - y(top) > 13 && (
              <text x={chipX + 6} y={(y(bottom) + y(top)) / 2 + 3.5} className="axis chip">
                {job.id.slice(0, 6)} · {money(job.estimateP50 ?? 0)}
              </text>
            )}
          </g>
        ))
      ) : (
        <text x={chipX + 4} y={Y_BOTTOM - 6} className="axis">nothing queued</text>
      )}
      <text x={chipX + 4} y={Y_BOTTOM + 15} className="axis">next window</text>
    </svg>
  );
}
