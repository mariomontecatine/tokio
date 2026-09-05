/**
 * tokio, as an application.
 *
 * The daemon is not reimplemented here and not talked to over a socket from a
 * second process: `startDaemon` is imported and run inside this one. That is the
 * whole reason this is Electron rather than Tauri — the metering, the ingest and
 * the queue are Node, and under Electron they run unchanged. See
 * `docs/desktop-app.md`.
 *
 * The window is frameless on purpose. A dashboard in a default OS title bar
 * reads as a web page someone put in a box; the chrome is drawn by the app, and
 * the dashboard's own masthead is the drag region, so there is no second bar
 * stacked above the first.
 */
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = pathToFileURL(path.join(__dirname, '..', 'dist')).href;

/** The ground colour from web/src/styles.css, so the window never flashes white. */
const GROUND = '#0b0d10';

/**
 * Attach to a daemon that is already running, rather than fighting it for the
 * port.
 *
 * Someone who has been using `tokio start` has one up with the real database
 * open. Starting a second against the same file would be two writers and two
 * pollers, so the application defers to it and just shows it.
 */
async function findRunningDaemon(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1200) });
    // Any reply at all means a daemon holds the port — including a 401, which
    // is what a daemon bound past loopback answers without a token. Testing
    // `res.ok` read that refusal as an empty port, and the application then
    // started a second daemon straight into an EADDRINUSE.
    return true;
  } catch {
    return false;
  }
}

/**
 * The URL to show, with the key to it.
 *
 * A daemon listening beyond loopback wants its token on every call, and the
 * dashboard picks that up from the query string exactly as it does from the URL
 * `tokio start` prints. On a loopback-only daemon there is no token and none is
 * appended.
 */
async function resolveUrl() {
  const { loadConfig } = await import(`${DIST}/config.js`);
  const cfg = loadConfig();
  const withToken = (port, token) => `http://127.0.0.1:${port}/${token ? `?token=${token}` : ''}`;

  if (await findRunningDaemon(cfg.port)) {
    return { url: withToken(cfg.port, cfg.token), own: false };
  }

  const { startDaemon } = await import(`${DIST}/daemon.js`);
  const daemon = await startDaemon({ host: '127.0.0.1' });
  return { url: withToken(daemon.cfg.port, daemon.cfg.token), own: true };
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 560,
    minHeight: 620,
    show: false,
    frame: false,
    // Windows 11 draws its own material behind the window; elsewhere this is
    // ignored and the solid ground below takes over.
    backgroundMaterial: 'mica',
    vibrancy: 'under-window',
    backgroundColor: GROUND,
    // macOS keeps its traffic lights — they are muscle memory there — and only
    // Windows and Linux get the buttons the app draws itself.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Painting only once the page is ready is the difference between an
  // application and a page load: no empty frame, no flash of the wrong colour.
  win.once('ready-to-show', () => win.show());

  const tellMaximized = () => win.webContents.send('window:maximized', win.isMaximized());
  win.on('maximize', tellMaximized);
  win.on('unmaximize', tellMaximized);

  // A link to somewhere else is the operating system's business, not a second
  // window with no chrome and no way back.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  void win.loadURL(url);
  return win;
}

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:toggle-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

// One tokio, however many times its icon is clicked. Two would be two pollers
// and two writers against one database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  nativeTheme.themeSource = 'dark';

  app.whenReady().then(async () => {
    const { url, own } = await resolveUrl();
    // Logged without its query string: the token travels in there, and an
    // application's stdout is the one place nobody thinks to check before
    // pasting it into a bug report.
    const shown = url.split('?')[0];
    console.log(own ? `tokio: started its own daemon at ${shown}` : `tokio: attached to the daemon already running at ${shown}`);
    createWindow(url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
