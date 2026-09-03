import { useEffect, useRef, useState } from 'react';
import { until } from './format';

interface Props {
  /** When the window resets, in server time. */
  at: number;
  /** The server's clock at the moment the status was fetched. */
  serverNow: number;
  /** Wraps the formatted remainder, e.g. "resets in {t}". */
  render: (remaining: string) => string;
}

/**
 * A remainder that changes on the exact second it becomes true.
 *
 * The status arrives every twenty seconds, so reading the countdown straight
 * off it left the figure up to twenty seconds stale and made it shed a minute
 * in lurches. This ticks on its own instead.
 *
 * It ticks every second while only ever showing minutes, which is the point:
 * the displayed minute turns over when it actually turns over, not whenever a
 * re-render happens to land.
 *
 * The clock it counts against is the server's, not the browser's. The two can
 * be seconds — or on a laptop that has just woken, minutes — apart, and the
 * reset time is the server's to state. The offset is re-measured on every
 * status, so a machine that sleeps through an hour comes back correct.
 */
export function Countdown({ at, serverNow, render }: Props) {
  const skew = useRef(serverNow - Date.now());
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    skew.current = serverNow - Date.now();
    setNow(serverNow);
  }, [serverNow]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => clearInterval(id);
  }, []);

  return <>{render(until(at, now))}</>;
}
