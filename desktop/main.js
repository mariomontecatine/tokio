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
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
 * Separate an address from the token somebody put in its query string.
 *
 * `TOKIO_URL` is the URL a human was given, so it carries its token the way the
 * daemon prints it. The window does not have to pass it on that way.
 */
function splitToken(raw) {
  try {
    const parsed = new URL(raw);
    const token = parsed.searchParams.get('token');
    parsed.searchParams.delete('token');
    return { url: parsed.toString(), token };
  } catch {
    return { url: raw, token: null };
  }
}

/**
 * The address to show, and the key to it, kept apart.
 *
 * A daemon listening beyond loopback wants its token on every call. A browser
 * has nowhere to be handed one, so the dashboard reads it off the query string —
 * which is why `tokio start` prints it there, and why it lands in history, in
 * screenshots and in any Referer the page ever sends.
 *
 * An application has somewhere: the preload bridge. So the token is carried
 * beside the URL from here and handed over out of band, and the page is loaded
 * at an address with no secret in it. The query-string path stays exactly as it
 * was for the browser, which still has no alternative.
 */
async function resolveUrl() {
  // An explicit address wins over everything.
  //
  // This is what makes the application testable on Windows before the daemon
  // has been ported to it. Someone whose Claude Code lives inside WSL has the
  // transcripts, the CLI and the database over there; the Windows window can
  // point at that daemon over the network and be the real thing, rather than an
  // empty shell reporting that it cannot find anything.
  if (process.env.TOKIO_URL) {
    return { ...splitToken(process.env.TOKIO_URL), own: false, remote: true };
  }

  const { loadConfig } = await import(`${DIST}/config.js`);
  const cfg = loadConfig();
  const at = (port) => `http://127.0.0.1:${port}/`;

  if (await findRunningDaemon(cfg.port)) {
    return { url: at(cfg.port), token: cfg.token ?? null, own: false };
  }

  const { startDaemon } = await import(`${DIST}/daemon.js`);
  const daemon = await startDaemon({ host: '127.0.0.1' });
  return { url: at(daemon.cfg.port), token: daemon.cfg.token ?? null, own: true };
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
/** Set once the daemon is resolved, so a second launch can reopen the window. */
let currentUrl = null;
/** Handed to the page over the bridge instead of through its address. */
let currentToken = null;

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
 * Electron because there is no system call to make: the desktop environments
 * agree on a file, `~/.config/autostart/tokio.desktop`, and honouring it is the
 * whole of the specification. So that file is written and removed directly.
 */
const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'tokio.desktop');
const isLinux = process.platform === 'linux';

/**
 * `Exec` is a command line, so anything with a space in it has to be quoted —
 * and a path is exactly the kind of thing that has one. The desktop entry
 * specification wants backslashes and double quotes escaped inside the quotes.
 */
const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function desktopEntry() {
  // Packaged, the executable is the application. Unpackaged, it is Electron and
  // the application is an argument to it, which is what makes this work in
  // development instead of autostarting a bare Electron with no app in it.
  const exec = app.isPackaged
    ? quote(process.execPath)
    : `${quote(process.execPath)} ${quote(app.getAppPath())}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=tokio',
    'Comment=Watch your subscription quota and run queued prompts when it resets',
    `Exec=${exec}`,
    `Icon=${path.join(__dirname, 'assets', 'icon.png')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

// Read back rather than remembered. On Linux the answer is a file that the user
// can delete from outside the application, and a checkbox that reported what we
// last did rather than what is true would be wrong the first time they did.
const opensAtLogin = () => {
  if (!isLinux) return app.getLoginItemSettings().openAtLogin;
  try {
    return fs.existsSync(AUTOSTART);
  } catch {
    return false;
  }
};

function setAutostart(on) {
  if (!isLinux) {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
    return;
  }
  try {
    if (!on) {
      fs.rmSync(AUTOSTART, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
    fs.writeFileSync(AUTOSTART, desktopEntry());
  } catch (err) {
    // A home directory that cannot be written to is a real answer. The menu is
    // rebuilt from `opensAtLogin`, which reads the file, so the checkbox falls
    // back to the truth on its own rather than claiming a setting that is not
    // there.
    console.error(`tokio: could not change autostart — ${err.message}`);
  }
}

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
      {
        label: 'Start with the computer',
        type: 'checkbox',
        checked: opensAtLogin(),
        click: (item) => {
          setAutostart(item.checked);
          rebuild();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();

  // Left-clicking a tray icon opens the thing on Windows; macOS expects the
  // menu, which the framework already shows.
  tray.on('click', () => showWindow(url));
}

/**
 * A preferred size, clamped to the screen it will actually open on.
 *
 * 980x900 was a preference written as a guarantee, and on a 1280x672 work area
 * it put 228 pixels of window below the bottom of the screen — the footer
 * cut off, on a frameless window with no title bar to drag it back up by.
 *
 * The work area, not the resolution: it already excludes the taskbar, which is
 * the part that makes a full-height window wrong rather than merely tight. The
 * margin keeps the window off the edges, so it reads as a window rather than as
 * something that failed to maximise.
 *
 * The minimums are clamped too. Left at fixed values they would re-introduce
 * exactly this bug on a smaller display, by forcing back the size the clamp had
 * just taken away.
 */
function windowSize() {
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize;
  const margin = 48;
  const width = Math.min(980, aw - margin);
  const height = Math.min(900, ah - margin);
  return { width, height, minWidth: Math.min(560, width), minHeight: Math.min(620, height) };
}

function createWindow(url) {
  const win = new BrowserWindow({
    ...windowSize(),
    center: true,
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

// Synchronous because the preload asks once, before the page runs, and the
// dashboard reads the token from a plain function call on every request. Making
// it a promise would push `await` through every caller of `accessToken` to save
// a round trip that happens once and blocks nothing anyone can see.
ipcMain.on('tokio:token', (e) => { e.returnValue = currentToken; });

// One tokio, however many times its icon is clicked. Two would be two pollers
// and two writers against one database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching it again is a request to see it, and `showWindow` is the only
  // thing that knows what that means in every state the window can be in.
  // Focusing the window directly was not: closing hides rather than destroys, a
  // hidden window is still in `getAllWindows()` and is not `isMinimized()`, so
  // this focused something invisible and the launch did nothing at all -- the
  // exact state the tray is designed to leave behind.
  app.on('second-instance', () => {
    if (currentUrl) showWindow(currentUrl);
  });

  nativeTheme.themeSource = 'dark';

  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(async () => {
    const { url, token, own, remote } = await resolveUrl();
    // The URL no longer carries the token, but it is still printed without a
    // query string: an application's stdout is the one place nobody thinks to
    // check before pasting it into a bug report, and that should stay true of
    // whatever anyone puts in `TOKIO_URL` next.
    const shown = url.split('?')[0];
    console.log(
      remote ? `tokio: showing the daemon at ${shown} (TOKIO_URL)`
        : own ? `tokio: started its own daemon at ${shown}`
        : `tokio: attached to the daemon already running at ${shown}`,
    );

    currentToken = token;
    currentUrl = url;
    buildTray(url);
    showWindow(url);

    app.on('activate', () => showWindow(url));
  });

  // Deliberately no `window-all-closed` handler that quits. The tray is the
  // application now, on every platform, for the reason above the `close`
  // handler: closing the window must not stop the daemon.
}
