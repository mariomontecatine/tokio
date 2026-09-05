/**
 * The only bridge between the window and the machine.
 *
 * Context isolation is on, so the dashboard cannot reach Node and does not need
 * to: it already talks to the daemon over HTTP, exactly as it does in a browser.
 * What it cannot do from a page is move or close its own window, which is the
 * whole of this file — plus one flag, so the same React app can render browser
 * chrome in a tab and application chrome in a window without guessing which it
 * is in.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokioDesktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizeChange: (fn) => {
    const handler = (_e, isMax) => fn(isMax);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
});
