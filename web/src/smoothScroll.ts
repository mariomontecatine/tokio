/**
 * Inertial page scrolling.
 *
 * The wheel stops moving the page directly and instead moves a target; a
 * requestAnimationFrame loop eases the real scroll position toward it. That
 * glide is the whole effect — the page keeps travelling for a beat after your
 * fingers stop, the way a heavy thing does.
 *
 * Taking the wheel from the browser is a real cost, so every way it normally
 * goes wrong is handled here rather than left to luck:
 *
 *   - Nested scrollers keep their own wheel. The job output, a pasted preview
 *     and the prompt box all scroll internally; the page only claims the event
 *     once the inner element has nothing left to give in that direction.
 *   - The keyboard is never touched. Arrows, space, Page Up/Down, Home and End
 *     scroll natively, which is what keyboard and screen-reader users rely on.
 *   - Touch is never touched. Phones already have momentum scrolling, and it is
 *     better than this.
 *   - Pinch-zoom (a wheel event with ctrl held) passes straight through.
 *   - Dragging the scrollbar, or any scroll we did not cause, re-syncs the
 *     target instead of fighting it back.
 *   - `prefers-reduced-motion` turns the whole thing off.
 *
 * A known limit, kept on purpose. This is tuned for a trackpad, which streams
 * many small deltas and comes out feeling continuous. A mouse wheel sends one
 * large jump per notch and nothing between, so its glide is a little steppier.
 * Chasing that produced worse results — a flat crawl that read as a brake, and
 * a sub-pixel tail that read as a shimmer, both because the browser snaps the
 * document's scroll offset to whole pixels and rounds the end of any slow
 * motion away. This is the version that felt best, so this is the version that
 * stays; the wheel's small step is the price of it.
 */

/** Time constant of the glide, in milliseconds. Larger is heavier. */
const TAU = 105;

/** How far one notch of wheel travel carries. 1 keeps native distance. */
const STRENGTH = 1;

/** Rough pixel equivalents for wheel events reported in lines or pages. */
const LINE_HEIGHT = 16;
const PAGE_HEIGHT = 800;

function pixelsOf(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * PAGE_HEIGHT;
  return event.deltaY;
}

/**
 * Whether something under the pointer should get this wheel event instead of
 * the page — an inner scroller that can still move in the direction asked for.
 */
function innerScrollerHandles(target: EventTarget | null, deltaY: number): boolean {
  let element = target instanceof Element ? target : null;

  while (element && element !== document.body && element !== document.documentElement) {
    const style = getComputedStyle(element);
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if ((scrolls || element.tagName === 'TEXTAREA') && element.scrollHeight > element.clientHeight + 1) {
      const atTop = element.scrollTop <= 0;
      const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      const wantsUp = deltaY < 0;
      // Only hand it over while the inner element can actually move that way;
      // at its own end the page should take over, as it does natively.
      if (!(wantsUp && atTop) && !(!wantsUp && atBottom)) return true;
    }
    element = element.parentElement;
  }
  return false;
}

/**
 * Start smoothing the page scroll. Returns a function that stops it and puts
 * the browser back exactly as it was.
 */
export function startSmoothScroll(): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) return () => {};

  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  // CSS smooth scrolling would animate on top of this one and fight it.
  root.style.scrollBehavior = 'auto';

  let target = window.scrollY;
  let current = window.scrollY;
  let frame = 0;
  let lastFrameAt = 0;

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  const step = (time: number) => {
    const dt = lastFrameAt ? Math.min(64, time - lastFrameAt) : 16;
    lastFrameAt = time;

    // Frame-rate independent easing: the same glide at 60Hz and at 144Hz.
    const factor = 1 - Math.exp(-dt / TAU);
    current += (target - current) * factor;

    if (Math.abs(target - current) < 0.35) {
      current = target;
      window.scrollTo(0, current);
      frame = 0;
      lastFrameAt = 0;
      return;
    }
    window.scrollTo(0, current);
    frame = requestAnimationFrame(step);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.defaultPrevented) return;
    if (innerScrollerHandles(event.target, event.deltaY)) return;

    const limit = maxScroll();
    if (limit <= 0) return;

    // Someone else moved the page (scrollbar, keyboard, a link): start from
    // where it actually is rather than snapping back to a stale target.
    if (!frame && Math.abs(window.scrollY - current) > 2) {
      current = window.scrollY;
      target = current;
    }

    event.preventDefault();
    target = Math.max(0, Math.min(limit, target + pixelsOf(event) * STRENGTH));

    if (!frame) {
      lastFrameAt = 0;
      frame = requestAnimationFrame(step);
    }
  };

  // Anything that scrolls the page without the wheel keeps its native feel; we
  // only need to know where it left us.
  const onScroll = () => {
    if (!frame) {
      current = window.scrollY;
      target = current;
    }
  };

  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('scroll', onScroll);
    root.style.scrollBehavior = previousBehavior;
  };
}
