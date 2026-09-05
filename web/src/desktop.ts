/**
 * Whether this is running as an application or in a browser tab.
 *
 * The same dashboard serves both, and the difference is only chrome: a tab
 * already has a title bar, buttons to close it, and a window the user can move
 * by its edge. An application has none of that unless it draws it, which is why
 * the flag exists at all — not to change what is shown, only what surrounds it.
 *
 * The bridge is injected by `desktop/preload.js` under context isolation, so
 * this is the entire surface the page has to the machine.
 */
export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  onMaximizeChange(fn: (isMaximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    tokioDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | null =>
  typeof window !== 'undefined' && window.tokioDesktop ? window.tokioDesktop : null;

/**
 * macOS draws its own traffic lights into the frameless window, so the app must
 * not draw a second set — it only has to leave room for them. Everywhere else
 * the buttons are ours.
 */
export const drawsOwnControls = (bridge: DesktopBridge | null): boolean =>
  bridge !== null && bridge.platform !== 'darwin';
