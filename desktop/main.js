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

/**
 * Both ground colours from web/src/styles.css, so the window never flashes the
 * wrong one. Kept in step with `--ground` by hand: there is no build step
 * shared between the stylesheet and the main process, and one that existed only
 * to carry two hex values would cost more than it saves.
 */
const GROUND = '#0b0d10';
const GROUND_LIGHT = '#edf0f4';

/**
 * Who, if anyone, is on the port — and whether we can actually talk to them.
 *
 * Someone using `tokio start` has a daemon up with the real database open, and
 * starting a second against the same file would be two writers and two pollers.
 * So the application defers to it. But "something replied" is not the same as
 * "something we can use", and the difference is not hypothetical on the machines
 * this is built for: **WSL forwards localhost**. A Windows tokio probing
 * 127.0.0.1 finds the daemon running *inside WSL*, attaches to it, and then
 * authenticates with the Windows config's token — which belongs to a different
 * daemon. Every call comes back 401 and the dashboard reports that the daemon is
 * not answering, which is a true sentence about the wrong thing.
 *
 * Testing `res.ok` was wrong for the opposite reason and is what this replaces:
 * it read the 401 from a token-protected daemon as an empty port and started a
 * second straight into EADDRINUSE. Sending the token separates the two cases
 * the single boolean could not.
 *
 * @returns 'free' — nothing there, start our own.
 *          'ours' — a daemon that accepts our token, or needs none.
 *          'foreign' — a daemon that refuses it. Not ours to use, and not a
 *          port we could bind either.
 */
async function probeDaemon(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1200),
    });
    return res.status === 401 ? 'foreign' : 'ours';
  } catch {
    return 'free';
  }
}

/**
 * An address the user gave the setup screen, remembered for next time.
 *
 * Kept in the application's own userData rather than in the daemon's config:
 * this is a fact about which daemon *this window* watches, not a setting of any
 * daemon. `TOKIO_URL` still wins over it, so a one-off run can point somewhere
 * else without disturbing what was saved.
 */
const remoteFile = () => path.join(app.getPath('userData'), 'remote.json');

function readRemote() {
  try {
    const url = JSON.parse(fs.readFileSync(remoteFile(), 'utf8')).url;
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  }
}

function writeRemote(url) {
  fs.mkdirSync(path.dirname(remoteFile()), { recursive: true });
  fs.writeFileSync(remoteFile(), JSON.stringify({ url }, null, 2));
}

/**
 * Does this address actually answer, with the token it carries?
 *
 * Checked before it is saved. Saving first and discovering on the next launch
 * that it was a typo would leave the application broken in a way that looks
 * like the fault it was meant to fix.
 */
async function checkRemote(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a URL. It should start with http://' };
  }
  const { url, token } = splitToken(raw);
  try {
    const res = await fetch(new URL('/api/status', url), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401) {
      return { ok: false, reason: 'That daemon answered but refused the token in the address.' };
    }
    if (!res.ok) return { ok: false, reason: `That daemon answered with ${res.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, reason: `Nothing answered at ${parsed.host}. Is that daemon still running?` };
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
    return { ...splitToken(process.env.TOKIO_URL), source: 'env' };
  }

  const saved = readRemote();
  if (saved) return { ...splitToken(saved), source: 'saved' };

  const { loadConfig } = await import(`${DIST}/config.js`);
  const cfg = loadConfig();
  const at = (port) => `http://127.0.0.1:${port}/`;

  const held = await probeDaemon(cfg.port, cfg.token);
  if (held === 'foreign') return { foreign: true, port: cfg.port };
  if (held === 'ours') {
    return { url: at(cfg.port), token: cfg.token ?? null, source: 'attached' };
  }

  const { startDaemon } = await import(`${DIST}/daemon.js`);
  const daemon = await startDaemon({ host: '127.0.0.1' });
  return { url: at(daemon.cfg.port), token: daemon.cfg.token ?? null, source: 'own' };
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

// The tray outlives whatever the window is currently showing, so it reaches
// for `currentUrl` rather than closing over the address it was built with:
// built while setup was up, a captured one would reopen setup forever.
function buildTray() {
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
      { label: 'Open tokio', click: () => currentUrl && showWindow(currentUrl) },
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
  tray.on('click', () => currentUrl && showWindow(currentUrl));
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
    // And the ground it falls back to is whichever one the page is about to
    // paint: a dark colour under a light theme is a black flash before the
    // first frame, which is the exact thing this option exists to prevent.
    backgroundColor: process.platform === 'win32'
      ? '#00000000'
      : (nativeTheme.shouldUseDarkColors ? GROUND : GROUND_LIGHT),
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

  // `themeSource` stays at its default of 'system'. Setting it to 'dark' forced
  // `prefers-color-scheme: dark` on the page regardless of the machine, which
  // made the light palette unreachable inside the application while working
  // perfectly in a browser tab.
  nativeTheme.themeSource = 'system';

  app.on('before-quit', () => { quitting = true; });

  /**
   * Work out what to show, and show it. Called again when setup resolves the
   * thing that was in the way, so the application arrives at the dashboard
   * without being restarted.
   */
  async function boot() {
    const resolved = await resolveUrl();

    // Before the branch, so setup has one too: with the window-all-closed
    // handler above keeping the process alive, a setup screen without a tray
    // would be an application running with no way back to it.
    if (!tray) buildTray();

    // A window opening onto a dashboard that can never load is worse than no
    // window: it reports a fault in the daemon, and the fault is here. The
    // setup screen says so in the interface and offers the way out.
    if (resolved.foreign) {
      console.error(`tokio: port ${resolved.port} is held by a daemon that refuses this token`);
      showSetup(resolved.port);
      return;
    }

    const { url, token, source } = resolved;
    // The URL no longer carries the token, but it is still printed without a
    // query string: an application's stdout is the one place nobody thinks to
    // check before pasting it into a bug report, and that should stay true of
    // whatever anyone puts in `TOKIO_URL` next.
    //
    // Four sources, four sentences. One line covering the environment variable
    // and the address saved in setup said `(TOKIO_URL)` for both, which sent
    // anyone debugging the second to look at a variable that was never set.
    const shown = url.split('?')[0];
    console.log({
      env: `tokio: showing the daemon at ${shown} (TOKIO_URL)`,
      saved: `tokio: showing the daemon at ${shown} (saved in setup)`,
      attached: `tokio: attached to the daemon already running at ${shown}`,
      own: `tokio: started its own daemon at ${shown}`,
    }[source]);

    currentToken = token;
    currentUrl = url;
    showWindow(url);
  }

  /** The setup screen is the same frameless window, pointed at a local file. */
  function showSetup(port) {
    const file = pathToFileURL(path.join(__dirname, 'setup.html')).href;
    currentUrl = `${file}?port=${port}`;
    currentToken = null;
    showWindow(currentUrl);
  }

  // Setup hands back a reason rather than throwing: the screen shows it, and an
  // address that does not work is an ordinary answer, not an exception.
  ipcMain.handle('setup:connect', async (_e, raw) => {
    const check = await checkRemote(String(raw ?? '').trim());
    if (!check.ok) return check;
    writeRemote(String(raw).trim());
    replaceWindowWith(boot);
    return { ok: true };
  });

  ipcMain.handle('setup:retry', async () => {
    const { loadConfig } = await import(`${DIST}/config.js`);
    const cfg = loadConfig();
    if (await probeDaemon(cfg.port, cfg.token) === 'foreign') {
      return { ok: false, reason: 'Still the same daemon on that port.' };
    }
    replaceWindowWith(boot);
    return { ok: true };
  });

  /**
   * Drop the setup window before rebuilding, so `showWindow` makes a new one
   * rather than reusing a window still showing setup.html.
   */
  function replaceWindowWith(next) {
    const old = windowRef;
    windowRef = null;
    if (old && !old.isDestroyed()) old.destroy();
    void next();
  }

  app.whenReady().then(async () => {
    await boot();
    app.on('activate', () => currentUrl && showWindow(currentUrl));
  });

  // Observed and ignored, which is not the same as absent.
  //
  // Electron quits on this event when *nothing* listens, so leaving it
  // unhandled is a handler that quits — the opposite of what the tray is for.
  // It went unnoticed because closing the window hides it rather than destroying
  // it, so the event never fired; the setup screen swapping itself for the
  // dashboard destroys one, and the application died mid-transition.
  app.on('window-all-closed', () => {});
}
