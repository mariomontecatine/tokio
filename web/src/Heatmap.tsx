import { useRef, useState } from 'react';
import type { Lang, Translate } from './i18n';
import { localeOf } from './i18n';
import { money } from './format';

/** Matches CALENDAR_DAYS on the server. */
const DAYS = 30;
const CELL = 16;
const GAP = 4;
const PITCH = CELL + GAP;
const LABEL_ROOM = 15;
/** A date label is centred under its square and overhangs it; give it room or
 *  the viewBox clips the last one clean in half. */
const SIDE_PAD = 16;

interface Props {
  byDay: { day: string; usd: number }[];
  /** What one day of subscription costs. Days are judged against it. */
  dailyUsd: number | null;
  t: Translate;
  lang: Lang;
}

/**
 * How many times over each day paid for itself.
 *
 * Four filled steps over an empty one, the same five GitHub uses — enough to
 * read a month at a glance without the shades blurring into each other.
 *
 * The first boundary is the one that carries the meaning: below 1× a day did
 * not cover its own share of the fee, so it gets the faintest shade rather than
 * a grey one. Grey is reserved for days with no work at all, and conflating
 * "nothing ran" with "not quite enough ran" would lose the distinction the
 * calendar exists to show.
 */
const STEPS = [1, 5, 15];

function level(usd: number, dailyUsd: number | null): number {
  if (usd <= 0) return 0;
  // With no price for the plan there is nothing to judge a day against, so
  // every day with work gets the same middle shade rather than a made-up rank.
  if (dailyUsd === null || dailyUsd <= 0) return 2;
  return 1 + STEPS.filter((step) => usd / dailyUsd >= step).length;
}

const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * The last thirty days, a day to a square.
 *
 * It answers what the big multiple cannot: the headline says the month paid
 * back several times over, but not whether that came from steady use or from
 * three heroic afternoons. A row of thirty shows which.
 *
 * Thirty and not a year, because thirty days is all there is to show. Claude
 * Code deletes transcripts after thirty days by default, so a longer calendar
 * draws empty squares for months nobody kept a record of — and an empty square
 * reads as idleness, not as absence of evidence.
 */
export function Heatmap({ byDay, dailyUsd, t, lang }: Props) {
  const usdOn = new Map(byDay.map((d) => [d.day, d.usd]));
  const strip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: DAYS }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (DAYS - 1 - index));
    const day = isoDay(date);
    return { day, date, usd: usdOn.get(day) ?? 0 };
  });

  const width = DAYS * PITCH - GAP;
  const box = width + SIDE_PAD * 2;

  const label = (cell: { usd: number; date: Date }) => {
    const when = cell.date.toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'long' });
    if (cell.usd <= 0) return t('heat.none', { when });
    if (dailyUsd === null) return `${when}: ${money(cell.usd)}`;
    return t('heat.day', { when, amount: money(cell.usd), multiple: (cell.usd / dailyUsd).toFixed(1) });
  };

  // A date under today and every fifth day back: enough to place a square
  // without printing thirty numbers under thirty squares.
  const ticks = days.map((cell, index) => ({ cell, index })).filter(({ index }) => (DAYS - 1 - index) % 5 === 0);

  const show = (index: number, cell: { usd: number; date: Date }) => {
    // The svg is scaled to its box, so a cell's own coordinates have to be
    // scaled with it before they mean anything in page pixels.
    const visible = strip.current?.clientWidth ?? box;
    const x = ((index * PITCH + CELL / 2 + SIDE_PAD) / box) * visible;
    setHover({ x: Math.max(90, Math.min(visible - 90, x)), text: label(cell) });
  };

  return (
    <div className="heat">
      <div className="heat-strip" ref={strip} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`${-SIDE_PAD} 0 ${box} ${CELL + LABEL_ROOM}`} role="img" aria-label={t('heat.title')}>
          {days.map((cell, index) => (
            <rect
              key={cell.day}
              className={`heat-cell l${level(cell.usd, dailyUsd)}`}
              x={index * PITCH}
              y={0}
              width={CELL}
              height={CELL}
              rx="3"
              aria-label={label(cell)}
              onMouseEnter={() => show(index, cell)}
            />
          ))}
          {ticks.map(({ cell, index }) => (
            <text key={cell.day} className="heat-tick" x={index * PITCH + CELL / 2} y={CELL + 11} textAnchor="middle">
              {cell.date.toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'short' }).replace('.', '')}
            </text>
          ))}
        </svg>
      </div>

      {hover && (
        <div className="heat-tip" style={{ left: hover.x }} role="status">
          {hover.text}
        </div>
      )}

      <div className="heat-key">
        <span>{t('heat.less')}</span>
        {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`heat-cell l${l}`} />)}
        <span>{t('heat.more')}</span>
        <div className="spacer" />
        <span className="heat-note">{t('heat.basis', { amount: dailyUsd === null ? '—' : money(dailyUsd) })}</span>
      </div>
    </div>
  );
}
