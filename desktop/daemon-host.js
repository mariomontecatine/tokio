/**
 * The daemon, in a process of its own.
 *
 * `main.js` forks this with `utilityProcess`: the same executable and the same
 * Node, nothing extra to install — and an event loop that is not the window's.
 * The daemon used to run inside the main process, where every click Windows
 * delivers to the application is handled: the tray, the window's buttons,
 * dragging it, a second launch asking to see it. Its sweeps across the WSL
 * bridge held that loop for twelve to fifteen seconds at a time, so the window
 * stopped answering and closing it took as long as the sweep had left. See
 * `docs/desktop-app.md`.
 *
 * The contract with `main.js` is one message: `listening`, with the port and
 * the token, sent the moment the dashboard has a server to load from.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = pathToFileURL(path.join(__dirname, '..', 'dist')).href;

(async () => {
  const { startDaemon } = await import(`${DIST}/daemon.js`);
  // Resolves once the server listens; the first scan and the first /usage read
  // carry on behind it and reach the dashboard as changes on its stream.
  const daemon = await startDaemon({ host: '127.0.0.1' });
  process.parentPort.postMessage({ type: 'listening', port: daemon.cfg.port, token: daemon.cfg.token ?? null });
})().catch((err) => {
  console.error(`tokio: the daemon could not start — ${err?.stack ?? err}`);
  process.exit(1);
});
