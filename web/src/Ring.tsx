import type { ReactNode } from 'react';
import { pressureOf, type Pressure } from './verdict';

const SIZE = 132;
const STROKE = 11;
const R = (SIZE - STROKE) / 2 - 2;
const C = 2 * Math.PI * R;

/** Whose ring this is. It colours the track, never the fill: the fill is the state. */
export type Brand = 'claude' | 'codex';

interface Props {
  /**
   * What has actually been spent, 0–100. Null when there is no reading to show:
   * the ring is drawn empty with a dash, never as a zero nobody measured.
   */
  usedPct: number | null;
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
  brand?: Brand;
}

/**
 * A dial with two arcs.
 *
 * The solid arc is spend; the faint one continuing from it is where this pace
 * ends up when the window resets. One glance answers the only urgent question
 * this tool exists for — do I make it to the reset — which a single arc can
 * state but never answer.
 *
 * The track under both is in the colour of the agent the ring belongs to, so
 * two pairs of rings side by side say whose is whose before any label is read.
 * The arcs keep the state colours; the brand is only ever the ground they run on.
 */
export function Ring({ usedPct, projectedPct, label, sub, pressure, brand }: Props) {
  const known = usedPct !== null && Number.isFinite(usedPct);
  const used = known ? Math.max(0, Math.min(100, usedPct)) : 0;
  const projected = !known || projectedPct == null ? null : Math.max(used, Math.min(100, projectedPct));
  const tone = pressure ?? pressureOf(Math.max(used, projected ?? 0));

  const dash = (pct: number) => `${(pct / 100) * C} ${C}`;

  return (
    <figure className={`ring tone-${tone}${brand ? ` brand-${brand}` : ''}${known ? '' : ' ring-unknown'}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={known ? `${label}: ${Math.round(used)}%` : `${label}: —`}>
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
          {known && (
            <circle
              className="ring-used"
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              strokeWidth={STROKE}
              strokeDasharray={dash(used)}
            />
          )}
        </g>
      </svg>
      <div className="ring-centre">
        {/* The number and its unit share a baseline, so the % sits level with
            the digits instead of riding above them like an exponent. */}
        <div className="ring-figure">
          {known ? (
            <>
              <span className="ring-pct">{Math.round(used)}</span>
              <span className="ring-unit">%</span>
            </>
          ) : (
            <span className="ring-pct ring-none">—</span>
          )}
        </div>
      </div>
      <figcaption>
        <span className="ring-label">{label}</span>
        <span className="ring-sub">{sub}</span>
      </figcaption>
    </figure>
  );
}
