import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Milliseconds to stagger this element behind the one before it. */
  delay?: number;
}

/**
 * Bring a section in as it reaches the viewport.
 *
 * This is the honest version of "smooth scrolling": the page never takes the
 * wheel away from you — hijacking it fights the trackpad, the scrollbar and
 * anyone using the keyboard — but the content arrives with a settle instead of
 * snapping into place, which is where the feeling actually comes from.
 *
 * Runs once. A section that re-animates every time it passes the fold stops
 * reading as arrival and starts reading as a fidget.
 */
export function Reveal({ children, delay = 0 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || shown) return;

    // Anything already on screen at load, and anything in a browser without an
    // observer, is shown immediately rather than left invisible.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.02 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);

  return (
    <div ref={ref} className={`reveal${shown ? ' in' : ''}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}
