import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  children: ReactNode;
}

/**
 * A panel that opens to whatever height its content needs.
 *
 * Animating to `auto` is the thing CSS cannot do, so this uses the grid trick:
 * a single row goes from `0fr` to `1fr`, which the browser can interpolate, and
 * the child clips itself while it happens. No measuring, no ResizeObserver, and
 * it stays correct when the content changes size on its own.
 *
 * The content stays mounted so it has something to animate from, and is marked
 * `inert` while closed — otherwise its buttons stay in the tab order, and
 * tabbing into a panel nobody can see is worse than no animation at all.
 */
export function Expand({ open, children }: Props) {
  return (
    <div className={`expand${open ? ' open' : ''}`}>
      <div inert={!open || undefined}>{children}</div>
    </div>
  );
}
