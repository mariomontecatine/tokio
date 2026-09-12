import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// CommonJS, like the rest of desktop/, so it is loaded the way main.js loads it.
const require = createRequire(import.meta.url);
const { trayAction, BLUR_GRACE_MS } = require('../desktop/window-state.js');

const shown = { visible: true, minimized: false };

test('a click on the tray icon puts away the window that was in front', () => {
  // Windows moves focus to the taskbar on the press, so by the time the click
  // is reported the window has just blurred. It was in front all the same.
  assert.equal(trayAction({ ...shown, focused: false, msSinceBlur: 120 }), 'hide');
  assert.equal(trayAction({ ...shown, focused: true, msSinceBlur: Infinity }), 'hide');
});

test('a click on the tray icon brings back a window that is hidden, minimised or covered', () => {
  assert.equal(trayAction({ visible: false, minimized: false, focused: false, msSinceBlur: Infinity }), 'show');
  assert.equal(trayAction({ visible: true, minimized: true, focused: false, msSinceBlur: 50 }), 'show');
  // Open, but under other windows since long before the click.
  assert.equal(trayAction({ ...shown, focused: false, msSinceBlur: BLUR_GRACE_MS + 1 }), 'show');
});
