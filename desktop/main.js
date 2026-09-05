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
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, nativeTheme } = require('electron');
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
  // An explicit address wins over everything.
  //
  // This is what makes the application testable on Windows before the daemon
  // has been ported to it. Someone whose Claude Code lives inside WSL has the
  // transcripts, the CLI and the database over there; the Windows window can
  // point at that daemon over the network and be the real thing, rather than an
  // empty shell reporting that it cannot find anything.
  if (process.env.TOKIO_URL) return { url: process.env.TOKIO_URL, own: false, remote: true };

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

/**
 * Closing the window is not quitting.
 *
 * The daemon is the point of the thing: it polls, it ingests, and it fires the
 * queue when a window resets. An application that stopped doing all that
 * because someone closed a window they had finished reading would be missing
 * the resets it exists to catch. So the window closes, the tray stays, and
 * `quitting` is what tells the handler the difference between the two.
 */
let quitting = false;
let tray = null;
let windowRef = null;

function showWindow(url) {
  if (windowRef && !windowRef.isDestroyed()) {
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
    return windowRef;
  }
  windowRef = createWindow(url);
  return windowRef;
}

/**
 * Start with the machine, or don't.
 *
 * `setLoginItemSettings` covers Windows and macOS. Linux has no equivalent in
 * Electron — it wants a `.desktop` file in `~/.config/autostart` — so the menu
 * item is simply not offered there rather than offered and silently ignored.
 */
const autostartSupported = process.platform === 'win32' || process.platform === 'darwin';
const opensAtLogin = () => autostartSupported && app.getLoginItemSettings().openAtLogin;

function buildTray(url) {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  // A template image is recoloured by macOS to match the menu bar, light or
  // dark. Saying so is the difference between an icon and a white smudge.
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('tokio');

  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open tokio', click: () => showWindow(url) },
      { type: 'separator' },
      ...(autostartSupported
        ? [{
            label: 'Start with the computer',
            type: 'checkbox',
            checked: opensAtLogin(),
            click: (item) => {
              app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
              rebuild();
            },
          },
          { type: 'separator' }]
        : []),
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();

  // Left-clicking a tray icon opens the thing on Windows; macOS expects the
  // menu, which the framework already shows.
  tray.on('click', () => showWindow(url));
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 560,
    minHeight: 620,
    show: false,
    frame: false,
    // Mica needs something to show through.
    //
    // The material was declared and then painted over twice — once here with an
    // opaque window colour, once by the page's own ground — so Windows was
    // compositing a wallpaper tint underneath two layers of near-black and the
    // feature looked broken when it was simply buried. A transparent window
    // colour lets it reach the page, which then decides how much of it to let
    // through. Everywhere else the solid ground stays: it is what stops the
    // window flashing white before the first paint.
    backgroundColor: process.platform === 'win32' ? '#00000000' : GROUND,
    // A pale 4px band along the left, right and bottom shows up under WSLg.
    // It is the window manager's resize border around a frameless window, not
    // anything this code draws: `capturePage` comes back dark to all four
    // edges, so the band lives outside the web contents entirely. `hasShadow:
    // false` and `transparent: true` were both tried and neither touched it,
    // and they are not left behind as cargo — a workaround that does not work
    // is worse than the artefact. Windows draws this frame itself through DWM
    // and does not have it.
    // macOS keeps its traffic lights — they are muscle memory there — and only
    // Windows and Linux get the buttons the app draws itself.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Each platform is handed only the options it actually implements.
    //
    // `backgroundMaterial` and `vibrancy` were set on all three on the theory
    // that a platform ignores what it cannot do. It does not: asking a Linux
    // window for a material it has no idea about left a pale band down the
    // right edge and along the bottom — the window turning partly translucent
    // and showing what was behind it, which is the opposite of ignoring it.
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' } : {}),
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window', trafficLightPosition: { x: 18, y: 22 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Painting only once the page is ready is the difference between an
  // application and a page load: no empty frame, no flash of the wrong colour.
  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

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

  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(async () => {
    const { url, own, remote } = await resolveUrl();
    // Logged without its query string: the token travels in there, and an
    // application's stdout is the one place nobody thinks to check before
    // pasting it into a bug report.
    const shown = url.split('?')[0];
    console.log(
      remote ? `tokio: showing the daemon at ${shown} (TOKIO_URL)`
        : own ? `tokio: started its own daemon at ${shown}`
        : `tokio: attached to the daemon already running at ${shown}`,
    );

    buildTray(url);
    showWindow(url);

    app.on('activate', () => showWindow(url));
  });

  // Deliberately no `window-all-closed` handler that quits. The tray is the
  // application now, on every platform, for the reason above the `close`
  // handler: closing the window must not stop the daemon.
}
