import type { ReactNode } from 'react';
import { pressureOf, type Pressure } from './verdict';

const SIZE = 132;
const STROKE = 11;
const R = (SIZE - STROKE) / 2 - 2;
const C = 2 * Math.PI * R;

interface Props {
  /** What has actually been spent, 0–100. */
  usedPct: number;
  /**
   * Where the current pace lands by the time the window resets, 0–100+.
   * Drawn as a fainter arc continuing past the solid one. Omit when there is
   * nothing to project — an idle window must not sprout a ghost.
   */
  projectedPct?: number | null;
  label: string;
  /** A node, not a string: the session's remainder is a live countdown. */
  sub: ReactNode;
  /** Colour is driven by whichever of the two figures is worse. */
  pressure?: Pressure;
}

/**
 * A dial with two arcs.
 *
 * The solid arc is spend; the faint one continuing from it is where this pace
 * ends up when the window resets. One glance answers the only urgent question
 * this tool exists for — do I make it to the reset — which a single arc can
 * state but never answer.
 */
export function Ring({ usedPct, projectedPct, label, sub, pressure }: Props) {
  const used = Math.max(0, Math.min(100, usedPct));
  const projected = projectedPct == null ? null : Math.max(used, Math.min(100, projectedPct));
  const tone = pressure ?? pressureOf(Math.max(used, projected ?? 0));

  const dash = (pct: number) => `${(pct / 100) * C} ${C}`;

  return (
    <figure className={`ring tone-${tone}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${label}: ${Math.round(used)}%`}>
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle className="ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} strokeWidth={STROKE} />
          {projected !== null && projected > used && (
            <circle
              className="ring-projected"
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              strokeWidth={STROKE}
              strokeDasharray={dash(projected)}
            />
          )}
          <circle
            className="ring-used"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            strokeWidth={STROKE}
            strokeDasharray={dash(used)}
          />
        </g>
      </svg>
      <div className="ring-centre">
        {/* The number and its unit share a baseline, so the % sits level with
            the digits instead of riding above them like an exponent. */}
        <div className="ring-figure">
          <span className="ring-pct">{Math.round(used)}</span>
          <span className="ring-unit">%</span>
        </div>
      </div>
      <figcaption>
        <span className="ring-label">{label}</span>
        <span className="ring-sub">{sub}</span>
      </figcaption>
    </figure>
  );
}
