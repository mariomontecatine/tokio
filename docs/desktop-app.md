# tokio as a desktop app — plan and running state

Written for whoever picks this up next, agent or human. It is a **living document**:
when you finish something, move it and say what you learned. Do not append a
changelog; edit the state in place. The point is that someone arriving cold can
read this file and know what is true today.

Status keys: `[done]` `[doing]` `[next]` `[blocked]` `[open]` — `[open]` means a
decision nobody has made yet, and guessing at it is how this goes wrong.

---

## What we are building

A desktop application — Windows first, macOS and Linux after — that shows the
dashboard tokio already has, installs without a terminal, and runs in the
background.

**Scope decision `[done]`: ship for people who already have Claude Code
installed.** They are the only users for whom every number works. Reaching
people who never open a terminal is a separate question, deliberately deferred —
see [Non-CLI users](#non-cli-users-open).

## What we are not building

Not a rewrite. The daemon, the metering, the queue and the React dashboard stay
what they are. The desktop work is a shell, a port, and an installer.

---

## Why this is feasible at all

Three properties of the existing code, verified rather than assumed:

- **No native dependencies.** `fastify`, `@fastify/static`, `chokidar`. Nothing
  compiles per platform. `node:sqlite` is why — see `CLAUDE.md`.
- **The UI is already detached.** A React SPA over local HTTP plus an
  `EventSource` stream. Putting it in a window is packaging, not rewriting.
- **Cross-platform work already started.** `src/notify/index.ts` already
  branches on `darwin`, `win32`, WSL and Linux.

---

## Phase 0 — the spike `[done]`

The point of phase 0 was to kill the project cheaply if the runtime did not
hold. It held.

### Decision: Electron, not Tauri `[done]`

The daemon is Node end to end and needs Node >= 22.5 for `node:sqlite`. Under
Electron it runs unchanged, in the main process. Tauri would give a far smaller
binary but you would ship a Node sidecar anyway, and add a Rust toolchain to a
repo that has no compiled dependencies on purpose.

### `node:sqlite` under Electron `[done]` — the decisive risk, cleared

```
electron : 44.2.0
node     : 24.20.0
chrome   : 152.0.7977.76
node:sqlite -> OK, row: {"a":7,"b":"siete"} | null prototype: true
```

Node 24.20 clears the >= 22.5 floor comfortably, and rows come back as
null-prototype objects — the exact behaviour `CLAUDE.md` documents, so the
existing casts through `unknown` stay correct.

### tokio's real core under Electron `[done]`

Not a hello-world. The compiled modules, against a seeded database:

```
computeStatus  -> 44% reported, traceSource=reported, points=2
computeValue   -> 20
chokidar       -> loaded
fastify        -> listening on 35593 | response {"ok":true}
```

### The real server in a real Electron window `[done]`

`createServer` from `dist/server/index.js` started inside an Electron main
process and served the built dashboard to a `BrowserWindow`. The window opened
and the server answered.

`webContents.capturePage()` first returned a blank frame. **That was an
artefact, not a finding**: passing `--disable-gpu` *and*
`--disable-software-rasterizer` together leaves Chromium with nothing to
rasterize with. `--disable-gpu` alone renders correctly under WSLg, and the
window has since been captured showing live data.

### `claude -p "/usage"` read from Windows `[done]`

Run from native Windows against the CLI in WSL, which is this machine's
topology. `probeUsage` returned `sessionPct` and `weekPct` with `error: null`,
so the `Current session: N% used · resets …` line that `parseUsageText` in
`src/usage/probe.ts:66` matches survives the crossing intact. **The regex is the
contract and the contract holds.**

`[blocked]` **It no longer holds.** From Claude Code 2.1.312 (November 2026),
`claude -p "/usage"` prints the `/cost` summary — "Total cost: $0.0000" and
token counts — and no percentages, in a clean environment as well. Every
platform falls back to estimates, and the gauges say "estimated" while the reach
panel still says they come from Anthropic. Neither copy Claude Code keeps on disk
is a live substitute: `cachedUsageUtilization` in `~/.claude.json` is only
refreshed by the interactive `/usage`, and the desktop application's
`plan-usage-history.json` stops when that application is closed. Which source
replaces it is undecided.

Two things that came with it, neither a surprise once seen:

- `opusPct` comes back `null`. There is no `Current week (Opus…)` line for a
  plan that does not meter Opus separately, so the absence is the truth and not
  a parse failure. Anything reading that field has to keep treating `null` as an
  answer.
- What was verified is the invocation, not the phrasing on every plan. A plan
  with an Opus line, or a future wording change, is still the same single point
  of failure it always was.

`[blocked]` **The native-shim route.** `cmd.exe /d /s /c claude.cmd -p /usage`
is still untested, because no native-Windows Claude Code is installed here —
only the WSL one. Its construction is covered by the suite; whether Windows
answers it needs a machine that has the shim.

---

## Phase 1 — port the daemon to Windows `[doing]`

Worth doing on its own, before any window exists. Concrete, located work:

- **`[done]` Building.** `chmod` is not a command on Windows, so
  `build:server` died before it produced anything. It goes through
  `fs.chmodSync` now: a no-op there, and still what the shebang needs on Linux
  and macOS.
- **`[done]` Paths.** Windows gets the two directories it actually uses —
  roaming for config, local for the database, which is the split those folders
  exist to express. The XDG variables still win everywhere when set, and that is
  load-bearing rather than tidy: the suite points `XDG_CONFIG_HOME` at a temp
  directory so it does not edit the config of whoever runs it. macOS keeps the
  XDG layout deliberately — moving it would strand the config and database of
  everyone already running, for a directory nobody has complained about.
- **`[done]` Finding the CLI.** `spawn('claude')` finds nothing on Windows: an
  executable is only found by trying PATHEXT, and what npm installs is a `.cmd`
  shim that Node has refused to spawn directly since the argument-injection fix
  in 18.20. `discoverClaude` in `src/claudeCli.ts` walks PATH with PATHEXT,
  hands a shim to `cmd.exe /d /s /c` as a launcher — arguments stay separate
  argv entries, which `shell: true` would have flattened into one string for
  Windows to re-split — and falls back to WSL only when nothing native is found.
  A configured `claudeBin` always wins, the same rule the plan follows.
  Not finding anything is a real answer and says so at startup rather than
  failing a spawn every three minutes.
  `[done]` **A real spawn on Windows, through WSL.** `wsl.exe -- <abs path> -p
  /usage` runs from native Windows and parses. The shim route is still
  `[blocked]` on a machine that has one — see phase 0.
- **`[doing]` Where Claude Code lives.** Not a WSL question — a topology
  question, and WSL is one of three. All three are ordinary and all three have
  to work:

  | | Where the CLI is | Where the transcripts are |
  |---|---|---|
  | **Native** — Windows, macOS, Linux | on this system's PATH | this user's home |
  | **Wrapped** | behind a version manager, a container, an `ssh` hop | wherever that lands |
  | **WSL, app on Windows** | only as `wsl.exe -- claude` | `\\wsl$\<distro>\home\<user>\.claude` |

  `[done]` **A command is a vector, not a name.** `claudeBin` was a string, so
  there was nowhere to put `--`, a distro, or a host, and the second and third
  rows could not be expressed at all. `src/claudeCli.ts` puts a `claudeLauncher`
  prefix in front of it — `['wsl.exe', '--']` for WSL — and everything
  downstream builds its arguments exactly as before. A prefix rather than a
  shell string: handing a command line to a shell to be re-split is how a model
  name with a metacharacter becomes something else. The prompt is safe either
  way because it goes over stdin, but that is a property of today's `buildArgs`,
  not a guarantee to build on.

  `[done]` **The preflight no longer fails good setups.** `available()` checked
  `existsSync(claudeBin)`, which cannot mean anything when the binary is
  resolved on the far side of a launcher. Its separator test was `/` alone,
  which never matches a Windows path, so an absolute one there went unchecked.

  `[done]` **Detection.** The daemon looks for Claude Code natively, then — on
  Windows — in WSL, fills in what it found, and names it at startup instead of
  leaving the user to discover a config key.

  The finding that made this more than plumbing: **`wsl.exe -- claude` does not
  work, and looks like it should.** It runs the command without a login shell,
  so the PATH that `~/.profile` builds is absent — and `~/.local/bin`, where
  Claude Code's installer puts the binary, is on PATH for exactly that reason.
  Measured against a working install: exit 127, `claude: command not found`,
  while the same CLI answers fine from a login shell. `WSL_LAUNCHER` with a bare
  `claude` would therefore have failed on the ordinary install and looked to the
  user like Claude Code was missing.

  So a login shell is used **once, to locate it** (`command -v claude`), and the
  absolute path goes into argv from then on. The shell never sees the caller's
  arguments — that is the same rule the launcher exists to keep, and it does not
  stop applying because a shell happens to be convenient here.

  This also turns the WSL branch from a candidate into a finding in both
  directions: `wsl.exe` existing means a bridge exists, not that anything is
  across it, and a distribution with no Claude Code in it now reports `unknown`
  at startup rather than failing a spawn every three minutes.

  `resolveClaude` stays synchronous and pure for everything decidable from PATH
  and PATHEXT; `resolveClaudeAsync` is the one that can ask. Tests inject the
  capture, so the suite never reaches `wsl.exe`.

  `[done]` **Transcripts across the boundary — it works, and it is slow enough
  to change the recommendation.** Discovery now fills `claudeConfigDir` from
  `wslpath -w "$HOME/.claude"` (asked, not assembled: `\\wsl$` and
  `\\wsl.localhost` have both been the spelling, and the distribution name is
  not ours to guess). Verified end to end: a Windows-native daemon reporting
  real percentages and ingesting from WSL.

  Three things measured on the way, none of them guesses:

  - **`fs.watch` cannot watch 9p at all.** Not unreliable — `EISDIR`, refused
    outright, zero of two appends seen. With `usePolling` it saw both. And
    chokidar reports that as an `error` *event*, which the `try/catch` around it
    never saw: an `error` event with no listener is rethrown, so the real
    behaviour was the daemon dying at startup, not a degraded watcher. It now
    handles the error and re-watches with polling, once.
  - **9p costs a round trip per file, so the price is metadata, not bytes.**
    Reading the 906-file, 49 MB history takes 27.5s (~1.8 MB/s). Worse, a *warm*
    scan still costs 13.8s against a cold 26.4s: roughly 906 stats at ~15ms
    each, paid on every sweep, forever, whether or not anything changed.
  - **So the bridge is the fallback, not the recommendation.** Running the
    daemon inside WSL and pointing the window at it over `TOKIO_URL` avoids all
    of it, and is what this machine has been doing all along. The daemon now
    says so at startup when it sees a UNC transcript path, because the cost is
    invisible and the fix is not "wait".

  `[done]` **The sweep paces itself, and nothing polls files any more.** Someone
  ran the bridge in anger: the first launch of the installed application took
  the best part of a minute, span the fan up and made the whole machine sluggish.
  Three causes, all ours, all measured.

  **The window waited for the whole daemon.** `startDaemon` scanned every
  transcript and probed `/usage` *before* the server listened, and the dashboard
  is served by that server — so the window had nothing to load. Across the
  bridge that is 27.5s of synchronous reads on Electron's main thread plus a
  probe allowed thirty seconds. It listens first now and warms up behind the
  window; the ingest and the probe arrive as changes on the stream, which is
  what the stream is for. **Measured on an empty database: 50s → 3.5s.**

  **The busy sweep asked for a pass every five seconds and each pass cost
  fourteen**, so for the first two minutes they ran back to back — that was the
  fan. `sweepDelay` now takes the greater of the interval it wants and twice
  what the last full pass actually took. Measured rather than special-cased by
  platform: a local disk keeps the fast beat because its sweeps really are fast.

  **And the polling fallback cost more than the problem.** chokidar's
  `usePolling` is `fs.watchFile` per file, so a 975-transcript history became 975
  stats every 700ms, across the bridge, permanently — not a first-run cost at
  all. It is gone: where `fs.watch` is refused, the sweep is the mechanism, and
  it now scales with the history instead of fighting it. The price is latency,
  which is worth naming — a watched directory notices a response in a tenth of
  a second, an unwatched one within a sweep. Nothing is missed either way.
  **Idle daemon after: 0% CPU, 10 MB.**

  Also folded in: turn rows and session costs join the per-file transaction they
  used to sit outside, which on a first scan was thousands of separate WAL
  commits.

  **Not all of it was ours.** Windows Defender scanning a new, unsigned 233 MB
  executable on first execution is why the *machine* was slow rather than just
  the application — real-time protection on, no exclusion. That is an argument
  for phase 5 rather than a code change.

  `[done]` **Pacing was not enough: a sweep must not hold the event loop, and
  must not touch finished sessions.** After the above, an installed build still
  froze. Measured from Windows with the same calls the ingest makes, against a
  1058-file, 94 MB history: **12.1s and 15.3s per sweep, all of it synchronous**,
  so whatever shared the loop stopped for that long. In the application that
  was the window (see phase 2). Pacing only spaced the freezes out.

  Two changes, both needed. The reads are asynchronous now — `tailFile`,
  discovery, and the project and session endpoints, which did the same thing
  on every load of the compose panel. A sweep costs the same wall time over
  9p and blocks nothing. And a sweep reads only **live** transcripts: anything
  written in the last six hours, plus anything never seen. A full pass over all
  of them runs every ten minutes, and it is what catches an old session being
  resumed; a watched directory sees that immediately anyway. The rule is
  `sweepTargets` in `src/ingest/index.ts`, and it is tested. A file the watcher
  names is read on its own, whether it is live or not, so the rule never hides a
  change somebody reported.

  `[done]` **Two installations at once — read both.** Someone with Claude Code
  natively on Windows *and* inside WSL has two sets of transcripts and one
  account, and discovery can only point at one, because the binary is in one
  place. The feared failure was counting a machine's work twice. The actual one
  was the opposite, and worse: not counting it at all.

  Measured here mid-session: Anthropic reporting **39% of the window used**
  against **$0 of priced work**, because the session being typed into was the
  Windows one while tokio read WSL. The verdict line said "Nothing running" to
  someone who was running something. After merging — 72 events in the window, a
  real burn rate, `$61.85` in the window, and `$106` of that week's spend that
  had simply been missing.

  `claudeDirs` returns every directory worth reading rather than one. Merging is
  safe rather than merely convenient: events are keyed on
  `(messageId, requestId)` and inserted with `INSERT OR IGNORE`, so the same
  transcript reachable two ways cannot be counted twice — the failure this had
  to avoid. `CLAUDE_CONFIG_DIR` stays exclusive, because it is Claude Code's own
  variable and means "my configuration is here"; reading elsewhere as well would
  override something set on purpose.

  `TOKIO_URL` remains a way to *try* the application across the boundary, not
  the answer to any of the above.
- **`[done]` Watching.** Local Windows paths are fine natively; a `\\wsl$` path
  cannot be watched at all and falls back to polling. See above — the fallback
  is driven by the error the filesystem returns, not by matching on the path,
  because which filesystems support change notification is not something a path
  reliably says.
- **`[done]` Tests on Windows.** 165 of 165, and `tsc --noEmit` clean. Verified
  on Linux too, since the fixture is shared and a fix for one platform that
  breaks the other is not a fix.

  Four failed, all in `queue.test.ts`, all the same way: the executor was tested
  against `test/fake-claude.sh` and Windows cannot spawn a `.sh` — `spawn
  EFTYPE`. The same lesson as the npm shim, from the other side: a file is
  executable on Windows only if something knows how to run it. The fixture is
  now `test/fake-claude.mjs`, run through `claudeLauncher: [process.execPath]`,
  which is the launcher doing exactly the job it was added for — so the suite
  exercises that path as a side effect instead of only asserting about it.

  **Node must be ≥ 22.13**, now corrected in `package.json` and `CLAUDE.md`,
  which both claimed `>= 22.5`. `node:sqlite` landed in 22.5 but stayed behind
  `--experimental-sqlite` until 22.13, so 22.5–22.12 fails at import with
  `ERR_UNKNOWN_BUILTIN_MODULE` and no hint as to why — seven test files at once,
  on a machine whose only sin was an LTS Node.

---

## Phase 2 — the shell `[done]`

Run it with `npm run app` from the repo root: it builds the dashboard and opens
the window. On Linux, Electron needs GUI libraries the base image may not carry
— `sudo apt install -y libnss3 libnspr4 libasound2t64`. Nothing to install on
Windows or macOS.

`[done]` **The window, and the daemon beside it.** `startDaemon` runs unchanged
under Electron, which was the point of choosing it. It first ran in the main
process and now runs in a utility process (`desktop/daemon-host.js`): the same
executable and the same Node, and no second install. That process posts
`listening` with the port and token, and is restarted with backoff if it dies.
Verified against real data.

**Why not the main process.** That thread is where Windows delivers every click
the application gets: the tray, the window's buttons, dragging it, and the
second launch asking to see it. The ingest's synchronous sweeps held it for
12–15s at a time across the WSL bridge. On a build that had been open five
hours, the main process answered Windows in **0 of 17 samples over 40s**. That
is the "Not responding" the user saw. Clicks queued behind the sweep, closing
took as long as the sweep had left, and clicking the icon repeatedly piled up
more work for a thread that was not listening. Moving the daemon out fixes all
of that even where a sweep is slow, and the asynchronous ingest (phase 1) keeps
the daemon's own server answering too.

Measured after the change, on Windows 11, with a packaged build reading the same
1058-file history across the bridge into an **empty** database. That is the
worst case, because the first pass reads all 94 MB. The config was isolated on
another port so the installed copy was not touched.

| | before | after |
|---|---|---|
| main process answering Windows | 0 of 17 | 39 of 39 over 45s |
| window close (WM_CLOSE → hidden) | as long as the sweep had left | 6 ms |
| second launch → window shown | dropped while booting | 250 ms, and in the foreground |
| window visible after launch | tens of seconds | 2.6 s |
| `/api/status` during the first pass | stalled 12–15s | p50 139 ms, max 312 ms |

The tray toggle cannot be clicked from a script. It is covered by its unit test
and still needs a human on Windows.

`[done]` **Deferring to a daemon that is already running.** Anyone using
`tokio start` has one up with the real database open; a second would be two
writers and two pollers against one file. The first attempt tested `res.ok`,
which read the 401 from a daemon bound past loopback as an empty port and
started a second straight into `EADDRINUSE`. Any reply at all means occupied.

`[done]` **The token stays out of the log.** The URL is printed without its
query string.

`[done]` Single-instance lock.

`[done]` **Tray icon, and closing the window does not quit.** The daemon is the
point: it polls, it ingests, and it fires the queue when a window resets. An
application that stopped doing that because someone closed a window they had
finished reading would miss the resets it exists to catch. The icon is the
sun with the tower cut through it (see phase 3) — macOS gets a template image so the menu bar can
recolour it, and saying so is the difference between an icon and a white smudge.

`[done]` **The icon behaves like a tray icon.** Four faults, each seen on Windows:

- **Clicking it never hid anything.** The handler only showed. It is a switch
  now, and the obvious switch is wrong: pressing the icon moves focus to the
  taskbar before the click is reported, so "hide if focused" never fires. A
  window that blurred within 400ms of the click counts as having been in front
  (`desktop/window-state.js`, tested).
- **A covered window stayed covered.** `show()` does nothing to a visible window,
  and Windows can refuse `focus()` to a process that is not in the foreground.
  `raise` pins the window on top and releases it, which leaves it at the top of
  the ordinary windows either way.
- **The tray appeared only once the daemon was up**, and a second launch before
  then was dropped. The tray is built first now, and a request to show that
  arrives early is remembered.
- **The taskbar saw two applications.** The installer's shortcuts carry the
  `appId`, and the process ran as `electron.app.tokio` until
  `setAppUserModelId` was called. Keep the two in step.

`[done]` **Autostart, on all three.** `setLoginItemSettings` covers Windows and
macOS. Electron has no Linux equivalent because there is no system call to make:
the desktop environments agree on `~/.config/autostart/tokio.desktop`, and
honouring it is the whole specification, so tokio writes and removes that file
itself. Unpackaged the `Exec` line is Electron *plus the app directory*, or
autostart would launch a bare Electron with nothing in it.

Started at login, it goes to the tray. `openAsHidden` only ever meant that on
macOS; Windows launched the window as a double-click would. The login item and
the Linux `Exec` line now pass `--hidden`, and startup reads it. On Windows the
argument is also part of how the entry is recognised, so
`getLoginItemSettings` is asked with it.

The checkbox reads the filesystem rather than remembering what it last did — the
file is something a user can delete from outside the application, and a failed
write then falls back to the truth on its own instead of claiming a setting that
is not there.

`[open]` **Not verified on a live Linux desktop.** The entry is correct by
construction and against the spec, including quoting for paths with spaces, and
was generated under Linux to be sure the separators are right. Nobody has
watched a session actually start it.

`[done]` **`TOKIO_URL` points the window at a daemon anywhere.** It wins over
everything else. This is what makes the application testable on Windows before
the daemon is ported to it: someone whose Claude Code lives in WSL has the
transcripts, the CLI and the database over there, and the Windows window can
show that daemon over the network instead of being an empty shell that cannot
find anything.

`[done]` **The token is out of the URL.** A browser has nowhere to be handed a
secret, so the dashboard reads it off the query string — which is why `tokio
start` prints it there, and why it ends up in history, in screenshots and in any
Referer. An application has somewhere. `main.js` splits the token off the
address, holds it, and answers a synchronous `tokio:token` from the preload;
`window.tokioDesktop.token` is what the dashboard prefers. Synchronous because
`accessToken()` is called on every request, and a promise would push `await`
through all of it to save a round trip that happens once.

Verified against the running app over CDP: the loaded URL carries no token,
`/api/status` without one is 401, with the bridge token 200, and the dashboard
renders.

**A window can be newer than the daemon it is pointed at**, and that is not
exotic — it is what `TOKIO_URL` is for, and the daemon is what serves the
dashboard. Taking the token out of the address broke exactly that combination:
an older page, knowing nothing about the bridge, reported "the daemon is not
answering", which is a true sentence about the wrong thing. So the preload also
leaves the token in `sessionStorage`, where the browser flow has always kept it
and where every version already looks. That puts the secret nowhere it was not
already, and the bridge stays the preferred source because storage can be
refused and a window told the token directly should not depend on anything else.

---

## Phase 3 — how it looks `[doing]` — a requirement, not a polish pass

The dashboard itself is designed and stays as it is. What made the phase 0 test
window look like a 1995 Tk application was **nothing but the default OS chrome
around it**. That is the work:

`[done]` **Frameless, and the masthead is the title bar.** Not a second bar
stacked above the first: a frameless window needs somewhere to be dragged by and
somewhere to put its buttons, and that row was already both. `web/src/desktop.ts`
carries the bridge, `WindowControls.tsx` draws minimise/maximise/close at the
platform's own one-pixel stroke weight, and macOS keeps its own traffic lights
and gets only the room for them.

`[done]` **The scrollbar.** Chromium's default rail was the loudest remaining
tell. Note the two selectors in `styles.css`: without a space it is the
document's own scrollbar, with one it is every scrollbar inside — the first
attempt had only the second and left the visible one untouched.

`[done]` No text selection on chrome, links to elsewhere handed to the OS.

`[done]` **Platform options are only handed to their platform.** `mica` and
`vibrancy` were set on all three on the theory that a platform ignores what it
cannot do. Do not assume that; give each one only what it implements.

`[done]` **Rounded corners on Windows — verified.** Windows draws them for a
frameless window with no help.

`[done]` **Mica was declared and then buried.** Verified not working on Windows
11, and the cause was ours twice over: an opaque window `backgroundColor` and an
opaque page ground, both painted on top of the material Windows was faithfully
compositing underneath. A material request is not a promise that anything will
show — whatever the page paints wins. The window colour is transparent on
Windows now, and the ground carries `--ground-alpha`, set high on purpose: a
hint of depth at the edges, not a wallpaper behind a dashboard that spends three
colours saying whether you make it to the reset. Take that number to 1 and the
window is solid again.

`[done]` **Mica lands — and was buried a third time, by its own fix.** The rule
that made room for the material set the translucent ground on `html` *and*
`body`, and both painted it: `body`'s background only propagates to the canvas
while `html` has none, so giving `html` one turns `body` into an ordinary box
painted over it. Two passes at 90% compose to **99%**, which is a solid window
with extra steps. `html` carries the ground now and `body` is explicitly
cleared.

Measured on Windows 11 (build 26200), transparency on, energy saver off — both
checked, because either would have explained a negative and neither did:

| ground alpha | sampled window background |
|---|---|
| 0.99 (the bug) | (11,13,15) — indistinguishable from the ground |
| 0.90 (shipped) | (13,15,17) |
| 0.15 (probe) | (22.6) at one position, (21.0) at another |

The direction is the proof. The ground is `#0b0d10` = (11,13,16); over black,
*lowering* the alpha would make the window darker. It gets lighter, so something
lighter is behind it — and at 0.15 it changes when the window moves, which a
flat compositor colour would not. That is the wallpaper.

`[open]` **Whether 0.9 is still the number.** It was chosen while the effective
alpha was 0.99, so it was calibrated against something invisible. At 0.9 the
material contributes about two levels per channel. That may be exactly the hint
of depth intended, or it may now be worth less ground — but it is a judgement
about how the product should look, and belongs to whoever owns that.

`[blocked]` **macOS vibrancy.** Declared, and nothing has run on a Mac yet. The
same trap applies: `vibrancy` will be buried under the page's ground exactly as
Mica was, so whatever is done for `win32` will need doing for `darwin`.

**A pale 4px band under WSLg is not ours** — settled, and confirmed absent on Windows, so nobody re-opens it. It
runs along the left, right and bottom of the window and not the top. It is the
window manager's resize border around a frameless window: `capturePage` comes
back dark to all four edges, so the band is outside the web contents entirely.
`hasShadow: false` and `transparent: true` were both tried, neither touched it,
and neither was left in the code — a workaround that does not work is worse than
the artefact. Windows draws this frame through DWM and does not have it.

`[done]` **The strip no longer reads as broken on a fresh daemon.** A reported
line starts at the first reading and says nothing to its left — deliberately,
because `/usage` cannot say what the window was at before it was asked. With a
daemon that started seconds ago that leaves one point and an empty field, which
is honest and looks like a fault.

The transcripts do know that stretch: they were written before the daemon
existed. `computeStatus` now always sends `traceLocal` beside `trace`, and the
strip draws the unwatched span from it, dashed and behind — a reconstruction
standing where a measurement would go, and not mistakable for one. `trace` and
`traceSource` are untouched.

Deliberately **not** scaled to meet the reported line. The local shape counts
what this machine did; the reading counts the account. Where they fail to meet,
that gap is work done somewhere leaving no transcript here — a browser, another
computer — which is the thing the reach panel exists to explain, and stretching
one to touch the other would erase it.

`[done]` **Light theme from the system.** The application could not reach it at
all: `nativeTheme.themeSource` was pinned to `'dark'`, which forces
`prefers-color-scheme: dark` on the page whatever the machine says — so the
light palette would have worked in a browser tab and never in the window.

Only tokens change, and the light ramp keeps the dark one's *ordering* —
`--ground` furthest back, `--surface-2` most raised, in both — so every existing
rule keeps its meaning without being reconsidered. Inverting the ramp instead
would have quietly turned every raised element into a recessed one. There were
four hardcoded colours outside the tokens; two were shadows, now tokens as well,
because a shadow tuned to read on near-black is a smudge on near-white.

The three state colours are the thing that could not simply be reused. They are
the message here, and they are tuned against near-black: `--ease` at `#2fd98a`
carries 10.6:1 on the dark ground and **1.6:1 on white**, which is not a warning
anybody can read. The light values were picked against the worst background they
land on rather than against white — ease 4.73, tight 5.20, over 4.93, parked
5.56. `--ink-faint` lands at 3.47, the one value under AA for body text,
deliberately: it is 3.33 in the dark theme, and lifting it here would make the
light theme louder than the dark one rather than equivalent to it.

`[done]` **The greys are neutral now, and the brand has one colour.** The
palette carried a navy tint, and so did the old icon; both are black, white and
the sun's red (`--sun`, `#e8401c`) now. Each grey was swapped for the neutral
grey of the *same luminance*, which is why the ratios above moved by a few
hundredths and no more: the palette lost its colour, not its legibility.
`--sun` is not a state. The three state colours still mean what they meant, and
the brand red stays in the icon and on the wordmark's dot.

`[done]` **The icon and the wordmark.** The Tokyo Skytree in front of a centred
red sun, and "tokio" set in square blocks — one block, one token. The masters
are SVGs in `docs/brand/`; `desktop/assets/` holds the PNGs rendered from them
(a 1024 icon, which electron-builder needs at 512 or more for macOS, the colour
tray icon for Windows and Linux, and the macOS template pair). The wordmark is
a single path on a 10-unit grid, drawn at 20px so its edges fall on whole
pixels; as separate shapes, each block was anti-aliased on its own and hairlines
showed between the rows.

Verified by emulating the media query against the running app rather than by
changing the machine's settings, in both directions, with a capture of each.

`[done]` **`prefers-reduced-motion`** was already covered — a universal rule
collapsing every animation and transition, `scroll-behavior`, the `.reveal`
class, and a JS check in `smoothScroll.ts`. Confirmed rather than assumed:
emulated, the ring's transition goes from 0.7s to 1e-05s and its animation from
0.62s to the same.

The bar the user named is Claude Desktop for Windows. Treat it as the reference.

---

## Phase 4 — installing without a terminal `[doing]`

`[done]` **There is an installer.** `npm run dist:app` produces a 111 MB NSIS
installer; `npm run pack` produces the unpacked application without one. Built,
installed and run on Windows 11: it lands in `%LOCALAPPDATA%\Programs\tokio`,
registers an uninstaller, and the dashboard renders real figures out of the
asar.

The app directory is the **repository root**, not `desktop/`. The window is a
shell around a daemon it imports from `dist/`, so the thing being packaged is
the whole project; rooting the build here puts `dist/` and the production
dependencies where the code already expects them, and electron-builder drops
`devDependencies` by itself. Three things fell out of that and are load-bearing:

- Electron moved to the root `devDependencies`. It was only in `desktop/`, where
  the builder could not see it — and keeping a copy in both would have been two
  version specs to drift apart, plus 380 MB of duplicate.
- `extraMetadata` injects `main` and `name` into the packaged package.json only.
  `main` would dangle in the published npm package, which is a CLI and does not
  ship `desktop/`. `name` is what `app.getName()` reads, so without it an
  application called tokio kept its config under `tokio-queue`.
- `desktop/package.json` must stay in `files`. The root declares
  `"type": "module"` and Node takes a file's module system from the *nearest*
  package.json; without that one, `desktop/main.js` loads as ESM inside the asar
  and dies on its first `require`.

`[done]` **First run, for the state that actually happens here.** Installing and
running it as a user would found the application broken out of the box — and it
is the failure this audience hits, not an edge case. **WSL forwards localhost**,
so a Windows tokio probing 127.0.0.1 finds the daemon running *inside WSL*,
attaches to it, and authenticates with the Windows config's token, which belongs
to a different daemon. Every call is 401 and the dashboard says the daemon is
not answering — a true sentence about the wrong thing.

`probeDaemon` now sends the token and distinguishes three answers: free, ours,
and a daemon that refuses us. The last one opens `desktop/setup.html` instead of
a dashboard that can never load. It explains what was found, takes the address
that daemon printed, checks it before saving it, and swaps itself for the
dashboard without a restart. The address lives in the application's own
userData, because it is a fact about which daemon this window watches rather
than a setting of any daemon, and `TOKIO_URL` still wins over it.

A modal error box was the first answer and was the wrong shape: an application
that opens with a dialog quoting an environment variable and then quits is
talking to whoever built it.

Two faults surfaced only by building the real thing:

- **`window-all-closed` was unhandled, and unhandled means quit.** The comment
  said there was deliberately no handler *that quits* — but Electron's default
  when nothing listens is exactly that. It never fired because closing the
  window hides it; the setup screen destroys one, and the application died
  mid-transition. It is observed and ignored now.
- The startup line said `(TOKIO_URL)` for an address that came from setup,
  sending anyone debugging it to a variable that was never set. Four sources,
  four sentences.

`[next]` **Auto-update.** `electron-updater` is not wired. The build already
emits `latest.yml` and a blockmap, so the manifest side is there; what is
missing is a `publish` target and a release to point at. Not worth writing
blind — it cannot be verified until there is something to update *from*.

`[done]` **Say what tokio can and cannot see.** `GET /api/reach` answers with
facts rather than a verdict — where Claude Code was found, every transcript
directory being read and whether each crosses a filesystem boundary, and the
plan with its basis. The panel says it on first run and then folds into
Details: a limitation worth stating is not worth repeating every morning.

Two things it is careful about. The rings and the priced figures do not have the
same reach, and it says so: the rings come from Anthropic and cover the account
— every device, the browser included — while anything carrying a price is
rebuilt from transcripts, which only exist where the work was done. And a plan
nobody established is reported as unknown, not as the `'pro'` that `resolvePlan`
still answers with so the gauges have something to divide by.

Building it is what surfaced the two-installation fault in phase 1: the panel
claimed to read "this machine" while naming one of two directories.

`[open]` **The installer overwrites a Start Menu shortcut of the same name.**
Harmless here — it replaced a hand-made development launcher — but worth knowing
that `tokio.lnk` is not a name the installer owns exclusively.

---

## Phase 5 — signing and the other platforms `[next]`

**Start the certificates in week one.** This is blocked by calendar, not by
effort, and it is the step people discover too late:

- Unsigned Windows installers raise a SmartScreen warning that reads as a virus
  to exactly the audience this is for. Certificate ~100-400 EUR/year, and
  SmartScreen reputation still takes weeks to accumulate after you sign.
- macOS needs an Apple Developer account (99 USD/year) and notarisation.

### macOS `[doing]`

`[done]` **It builds and runs, unsigned.** `CSC_IDENTITY_AUTO_DISCOVERY=false
npm run pack` produces `release/mac-arm64/tokio.app`: arm64 only, carrying
Electron's ad-hoc linker signature and no Developer ID. Built on the machine
that runs it, it has no quarantine attribute and opens without a Gatekeeper
prompt; downloaded, it would be refused until it is signed and notarised. It
needed a 1024 icon first — the old 256px one was below electron-builder's 512
floor for an icns (`ERR_ICON_TOO_SMALL`).

`[done]` **An application started from the Finder could not find Claude
Code.** launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, so
`~/.local/bin`, where Claude Code's installer puts `claude`, was not on the
PATH. Reproduced with that environment: discovery answered `unknown`, and a
queued job would have run without `node`, `npm` or `brew`. It never showed in
development because `npm run app` inherits the terminal's PATH. The daemon
host now asks the login shell for its PATH before the daemon starts
(`desktop/shell-path.js`, tested with an injected shell so the suite never runs
anybody's startup files). Measured at 29ms. Verified on the installed build
launched with `open`: the listener belonged to `/Applications/tokio.app`, and
`/api/reach` answered `how: path` with the `~/.local/bin` binary.

`[done]` **Reading `/usage` no longer leaves a Claude Code session behind.**
Every read was a new 2.6 KB session in the daemon's working directory, one
every few minutes, filling `claude --resume` there and the Continue list in
Compose. `--no-session-persistence` stops it, verified on the installed build:
no session file after a read. A CLI that rejects the flag is asked again
without it.

`[open]` **Started at login, the window still opens.** The login item's
`--hidden` is a Windows-only argument and `openAsHidden` no longer exists, so
nothing tells the macOS build it was launched at login. Untested — it needs a
real login to see.

`[open]` Not yet tried on macOS: a queued job end to end (it spends tokens),
the folder-permission prompts macOS raises when a job works in `~/Documents` or
`~/Desktop`, the tray click, and vibrancy (see phase 3).

---

## Non-CLI users `[open]`

The unresolved question, parked deliberately. tokio depends on Claude Code in
three separate places, and each costs a browser-only user something different:

| What | Source | Browser-only user |
|---|---|---|
| Gauges (%) | `claude -p "/usage"`, **or** the desktop app's own `plan-usage-history.json` | Readable without the CLI, if they have the desktop app — see below |
| Payback, heatmap, burn rate, headroom | transcripts in `~/.claude/projects` | **Impossible** — they do not exist |
| Plan detection | `~/.claude.json` | Needs the CLI |
| The queue | spawns `claude -p` in a repo | Meaningless — no repo, no terminal |

Two consequences worth swallowing before anyone builds toward this:

**The gauges are not free.** There is no public endpoint for a Pro/Max
subscriber to read their own usage percentage. The Admin API reports usage for
API organisations against an admin key; it does not answer "how much of my
five-hour window is left". So even a gauges-only app has to get Claude Code
installed and authenticated.

**The money cannot be reconstructed.** No transcripts, no tokens, no price.

`[open]` **Which way we go.** The options on the table, none chosen:

1. **Install Claude Code for them.** The app bundles or fetches it and walks the
   user through the OAuth login in a wrapped flow. The `/usage` probe costs
   nothing and reports zero turns. Bigger installer, real onboarding work.
2. **Gauges-only tier, CLI required, stated plainly.** Smaller promise, no
   surprises.
3. **Price their percentage against a calibrated cap.** For a user who *also*
   works locally, `Δpercentage × cap` values their browser work in dollars — the
   calibration comes from their own local windows. Honest only if it reaches the
   UI as an estimate: `basis: 'default'`, a range, never one number. See the
   honesty rules in `CLAUDE.md`. Does not help someone who never works locally,
   because there is nothing to calibrate against.

**Ruled out `[done]`: scraping claude.ai with session cookies.** It would be the
easy way to the gauges and it would burn the only thing this project sells,
which is that the numbers can be trusted. Terms of service aside, do not.

`[done]` **Does the Claude desktop app leave anything readable on disk? Yes —
the percentages, with history.** Somebody looked. On Windows the desktop
application keeps `%APPDATA%\Claude\plan-usage-history.json`:

```json
{ "version": 2, "samples": [ { "t": 1788720253163, "org": "…", "u": { "fh": 43, "sd": 21 } } ] }
```

`fh` is the five-hour window and `sd` the seven-day one, both as whole
percentages. Verified rather than inferred: the 20:44 sample read `sd=21` while
`claude -p "/usage"` eleven minutes later reported the week at **21%**, and
`fh=43` against a session at **45%** and climbing. Sampled every 15 minutes;
35 samples covering about a day.

**This moves the non-CLI picture, but only the top row of the table.** The
gauges are readable from a file the application writes itself — no CLI, no
scraping, nothing anyone would have to be talked into. It is *better* than the
probe in one way, since `/usage` answers with a point and this is a trace. The
money is untouched: percentages carry no tokens and no prices, so payback, the
heatmap and burn rate still need transcripts and still cannot exist for someone
who never works locally.

Three things to weigh before building on it:

- It is undocumented and internal. `version: 2` is proof the shape has already
  changed once, so anything reading it must treat a surprise as "no data"
  rather than as an error, and must never let it override a reported reading.
- Samples carry an `org`, so an account in more than one organisation needs
  filtering rather than the last row.
- It only advances while the desktop application is running, and at a fifteen
  minute grain. That is a different promise from a live probe and should not be
  presented as the same thing.

`[open]` **Whether to read it.** The finding does not decide the question above;
it changes what option 2 costs. A gauges-only tier no longer requires installing
a CLI for anyone who already has the desktop app.

---

## Codex beside Claude `[doing]`

The same application, for someone who uses both. One screen, a pair of rings per agent, the queue
able to run either.

`[done]` **Usage from the rollouts.** `src/codex/` reads `$CODEX_HOME/sessions/**/rollout-*.jsonl`
(and `archived_sessions/`) into tables of its own. Nothing reaches `events`, which feeds Claude's
window, cap, burn rate and payback.

- **What is counted.** One row per `response_id`, from top-level `token_usage_record` lines only.
  The model comes from the `turn_context` with the same `turn_id`, and the last one is kept beside
  the offset, so a restart mid-turn still knows it.
- **Codex compresses finished sessions.** It zstd-compresses them in place as
  `rollout-….jsonl.zst`. On the machine this was built on, that was most of the history, and
  reading only `.jsonl` would have dropped the bulk of it. They are streamed through
  `node:zlib`'s zstd and read once, since they no longer change.
  - zstd arrived in Node 22.15. On an older Node they are skipped, and the daemon says so once.
  - A half-written one fails to decode and is retried on a later sweep.
- **Measured against a real `~/.codex`**, plain and compressed together:
  - No duplicates, and no response without a model.
  - The first full read took 27s; after that, only what changes.
  - The worst event-loop stall stayed under 10ms across runs, because decompression runs off the
    main thread.
  - The limits are asked for in parallel, so the rings do not wait for that first read.
- **The size is why it reads in pieces.** One rollout is 128 MB and one line in it is 10.6 MB. It
  reads in bounded chunks that never split a line, and filters on the head of each line before
  parsing.

`[done]` **Limits without spending a turn.** `codex app-server` answers `account/rateLimits/read`.

- **Measured:** 0.8s, zero turns, fresher than the last rollout.
- **What is kept:** only the percentages, resets and plan name. The account id in the reply is
  dropped.
- **When it cannot be asked:** the `token_count` readings in the rollouts stand in, and the
  interface says which source it is showing.
- **What a reading may claim:** it expires at the reset it named, and is never carried forward or
  shown as 0%.
- **An idle window, as OpenAI reports it:** 0% with a reset five hours from the moment of asking,
  moving forward with every read because nothing has started the window.
  - That moving deadline is not taken as a reset. Only a window that had usage counts as
    having reset.
  - An untouched window does count as open. An on-reset Codex job queued into one starts on the
    next scheduler pass, because the quota is already there; Claude's equivalent starts at the
    next hour.
  - After a refused attempt, only a reading taken since that refusal counts. Otherwise a stale 0%
    would re-run the job on every pass until its attempts ran out.
  - `[open]` **Whether that is what "when the window resets" should mean for Codex.** The review
    by Codex argued for waiting for evidence of a reset instead. That would leave a job queued
    into an idle window waiting indefinitely, so it was not taken, but the call is a product one.

`[done]` **The queue.** `codex exec --json` takes the prompt on stdin.

- **The sandbox:** `read-only`, `workspace-write` or `danger-full-access`, always passed.
- **Resume, verified at zero tokens.** The check used a throwaway `CODEX_HOME` and a model
  provider pointed at a closed port.
  - Options placed before `resume` apply to the resumed turn, although its help does not list them.
  - With no flag, a resumed turn gets the configured default, not the thread's own sandbox.
- **`--skip-git-repo-check` is not passed.** That safeguard is Codex's to lift.

`[done]` **First run asks which AI.** What was found is ticked. Detection does not trust PATH
alone, because an application opened from the Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`. It also
tries the usual install directories and counts a `~/.codex/sessions` as evidence. The answer is
`providers` in the config, and the daemon starts or stops Codex's half when it changes.

`[done]` **Brand tracks, measured in both themes.** The contrast of each state arc against the
track under it is in the comment above the rules in `styles.css`. The weakest solid pair is 3.4:1.

`[done]` **Codex in dollars.** `src/codex/prices.ts` carries OpenAI's Standard API list price for
five models, each copied from the model's own page and read on 2026-11-21. Every figure on screen
says *at least*, and where it comes from.

- **No start dates.** None of the pages says since when its price applies. A model's first row
  has `from: null` and covers its whole history until a later row. A launch date is not a price
  date, and the day the page was read would have claimed the price began then and left all history
  unpriced. The cost: older responses are priced at what the page said when it was read, so a price
  that was lower before then, with no row for it, would make those figures high rather than a
  floor.
- **Re-pricing is automatic.** The stamp that decides when stored responses are priced again is a
  hash of the rows plus `OPENAI_PRICING_VERSION`, so any edit to the table reaches what is stored.
  Before this, a response stored while its model had no row stayed unpriced for good: only a version
  bump would have reached it, and nothing said to bump for a new row.
- **The tier is recorded after all.** This note used to say it was not. Codex writes each thread's
  settings as `event_msg` / `thread_settings_applied`, `service_tier` included, before the turns
  they apply to. Only `default` has been seen written. Fast is `priority` in Codex's model catalog,
  but what the settings line says for it is unknown. So only `default` is priced; any other tier, or
  none recorded, stays in tokens rather than take a guessed multiple.
- **The 272K rule is on every page.** Past 272K input tokens the whole request costs 2× input and
  cache and 1.5× output. It is applied, although the GPT-6.1 Sol page says subscription use does not
  pay it, because the figure is the API's price.
- **Why it is a floor.** Web search calls, cache writes and regional processing cost extra and are
  not priced. Cache writes are recorded per response (`cache_write_input_tokens`) but count as plain
  input.
- **A Codex job has no cost of its own.** `codex exec` reports a total for the run, and the 272K
  rule and the tier are per request, so pricing that total would be wrong. The rollout, which has
  both, may not have been read when the run ends. The job's responses count in Codex's totals.
- **The prices do not update themselves.** tokio never fetches them. A new model or a new price is
  a row added by hand.

`[open]` **What has not been seen.**

- **A successful `codex exec --json` run.** The event names come from the 0.168 binary, and only
  the failure half has been observed.
- **Codex on Windows or inside WSL.** `codexLauncher` and the `.cmd` shim handling are there, but
  untried.
- **A Codex strip.** There is one reading per turn to draw from, and nothing draws it yet.
- **Per-model limits** (a `limitId` other than `codex`). They are stored and not drawn.
- **Any tier but `default` in `thread_settings_applied`.** Seeing what Fast writes means a run in
  Fast, which spends quota at twice the rate. Until then a response at any other tier is unpriced.
- **A cost per Codex job.** It needs to know the rollout has been read up to the end of the run, so
  that the priced part of a run is never shown as all of it.

---

## Groundwork already done `[done]`

Today's metering work is a prerequisite for all of the above, not a coincidence.
Until it landed, tokio silently assumed that the transcripts on this machine
were the account's usage. Every user who also uses the browser or a second
machine broke that assumption, and it produced a strip drawn flat under a live
ring, a cap four times under the truth, and a window reported as spent while
Anthropic still reported 75%. Opening this to a wider audience on top of that
premise would have manufactured those failures at scale.

See the commit `Stop assuming this machine saw everything the account spent`.
