import { useEffect, useState } from 'react';
import type { DesktopBridge } from './desktop';

/**
 * Minimise, maximise, close — drawn rather than borrowed.
 *
 * The shapes are the platform's, at the platform's weight: a one-pixel stroke
 * on a 10px box, which is what Windows 11 draws and what makes a custom title
 * bar stop announcing itself as custom. They are SVG rather than glyphs because
 * a font fallback turns "□" into a tofu box on a machine missing the face, and
 * this is the one row of the interface that must never look broken.
 *
 * Close is the only one that takes a colour on hover, and it takes the
 * platform's red rather than the app's `over` — a window control is not a
 * reading, and the palette's three states are reserved for things that are.
 */
export function WindowControls({ bridge }: { bridge: DesktopBridge }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => bridge.onMaximizeChange(setMaximized), [bridge]);

  return (
    <div className="winctl">
      <button className="winctl-btn" onClick={() => bridge.minimize()} aria-label="Minimize" tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button className="winctl-btn" onClick={() => bridge.toggleMaximize()} aria-label={maximized ? 'Restore' : 'Maximize'} tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? (
            <>
              <path d="M2.5 2.5V0.5h7v7h-2" />
              <path d="M0.5 2.5h7v7h-7z" />
            </>
          ) : (
            <path d="M0.5 0.5h9v9h-9z" />
          )}
        </svg>
      </button>
      <button className="winctl-btn danger" onClick={() => bridge.close()} aria-label="Close" tabIndex={-1}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
