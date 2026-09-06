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

// Asked for synchronously, once, before the page runs: the dashboard reads the
// token from a plain call on every request, and making this a promise would push
// `await` all the way through that for a round trip nobody can perceive. `null`
// on a loopback daemon, which needs no token at all.
const token = ipcRenderer.sendSync('tokio:token');

// The same token, left where every version of the dashboard already looks.
//
// `TOKIO_URL` points the window at a daemon anywhere, and that daemon serves the
// dashboard — so the page in this window can easily be older than the window
// itself and know nothing about the bridge below. Taking the token out of the
// address without this turned that combination into "the daemon is not
// answering", which is a true sentence about the wrong thing.
//
// sessionStorage is where the browser flow has always kept it, so this puts the
// secret nowhere it was not already, and still keeps it out of the address bar,
// the history and any Referer.
try {
  if (token) sessionStorage.setItem('tokio.token', token);
} catch {
  // Storage can be refused. The bridge below is the answer that does not need it.
}

contextBridge.exposeInMainWorld('tokioDesktop', {
  isDesktop: true,
  platform: process.platform,
  // The access token for a daemon beyond loopback, handed over here rather than
  // in the address. A browser has nowhere else to receive it, so the dashboard
  // still reads it off the query string there — but a query string is kept in
  // history, shown in screenshots and sent in Referer headers, and an
  // application has no reason to put a secret through any of that.
  //
  // Preferred over the copy in storage because storage can be refused, and a
  // window told the token directly should not depend on anything else.
  token,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizeChange: (fn) => {
    const handler = (_e, isMax) => fn(isMax);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
});
