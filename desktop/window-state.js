/**
 * What a click on the tray icon means, decided from the window's state alone.
 *
 * Kept out of `main.js` so it can be tested without Electron, and it needs the
 * test: the obvious rule is wrong on Windows. Pressing the tray icon hands focus
 * to the taskbar, and the click is only reported on release — by then the
 * window has already blurred. "Hide it if it is focused" therefore never hides
 * anything there: the second click, the one meant to put the window away, finds
 * it unfocused every time and shows it again. A window that lost focus a moment
 * ago was in front when the click began.
 */
const BLUR_GRACE_MS = 400;

/**
 * @param {{ visible: boolean, minimized: boolean, focused: boolean, msSinceBlur: number }} win
 * @returns {'show' | 'hide'}
 */
function trayAction({ visible, minimized, focused, msSinceBlur }) {
  if (!visible || minimized) return 'show';
  // Visible but covered by other windows is a request to see it, not to hide it.
  return focused || msSinceBlur < BLUR_GRACE_MS ? 'hide' : 'show';
}

module.exports = { trayAction, BLUR_GRACE_MS };
