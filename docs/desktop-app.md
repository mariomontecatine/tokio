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

### `claude -p "/usage"` on native Windows `[blocked]` — the one open item

Could not be tested from here: no native-Windows Claude Code is installed on
this machine (`find /mnt/c/Users -iname "claude*.cmd"` finds nothing), and the
CLI in use runs inside WSL. Run this on a Windows machine with Claude Code
installed before starting phase 1:

```powershell
claude -p "/usage" --output-format json
```

What matters is whether the reply still contains the `Current session: N% used ·
resets …` line that `parseUsageText` in `src/usage/probe.ts:66` matches. The
regex is the contract; if Windows phrases it differently, that is a phase 1 task
and not a surprise.

---

## Phase 1 — port the daemon to Windows `[next]`

Worth doing on its own, before any window exists. Concrete, located work:

- **`[next]` Paths.** `src/config.ts:80-85` hardcodes XDG (`~/.config`,
  `~/.local/share`). Windows wants `%APPDATA%` and `%LOCALAPPDATA%`. Keep the
  XDG variables honoured where they are set — the test suite redirects
  `XDG_CONFIG_HOME` and must keep working (`CLAUDE.md`, Testing).
- **`[next]` Spawning the CLI.** `src/usage/probe.ts:139` and
  `src/providers/claudeCode.ts:95` call `spawn(cfg.claudeBin, …)` with
  `claudeBin: 'claude'`. On Windows that is `claude.cmd`, which `spawn` will not
  find without PATHEXT resolution or `shell: true`. Prefer explicit resolution
  over `shell: true` — a prompt reaches the shell otherwise.
- **`[open]` WSL.** The first user of this runs Claude Code *inside WSL*, so a
  Windows-native tokio cannot see those transcripts or that `claude`. Either
  tokio runs inside WSL with the window on the Windows side, or the Windows app
  bridges to it, or Claude Code gets installed natively too. `TOKIO_URL` makes
  the question testable today without answering it — it is a way to try the
  application, not the answer.
- **`[next]` Watching.** `chokidar` on Windows is fine for local paths; a
  `\\wsl$` path may need polling.
- **`[next]` Tests on Windows.** The suite must pass there, under the same rule
  it passes here: no tokens, no touching the machine.

---

## Phase 2 — the shell `[doing]`

Run it with `npm run app` from the repo root: it builds the dashboard and opens
the window. On Linux, Electron needs GUI libraries the base image may not carry
— `sudo apt install -y libnss3 libnspr4 libasound2t64`. Nothing to install on
Windows or macOS.

`[done]` **The window, and the daemon inside it.** `desktop/main.js` imports
`startDaemon` and runs it in the Electron main process — the point of choosing
Electron. Verified against real data.

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
finished reading would miss the resets it exists to catch. The icon is a ring,
generated rather than fetched — macOS gets a template image so the menu bar can
recolour it, and saying so is the difference between an icon and a white smudge.

`[done]` **Autostart, where Electron has it.** `setLoginItemSettings` covers
Windows and macOS and is offered in the tray menu. Linux wants a `.desktop`
file in `~/.config/autostart`, which Electron does not write, so the item is not
offered there rather than offered and silently ignored — `[next]` to add.

`[done]` **`TOKIO_URL` points the window at a daemon anywhere.** It wins over
everything else. This is what makes the application testable on Windows before
the daemon is ported to it: someone whose Claude Code lives in WSL has the
transcripts, the CLI and the database over there, and the Windows window can
show that daemon over the network instead of being an empty shell that cannot
find anything.

`[next]` **Get the token out of the URL entirely.** Appending it to the query
string is what the dashboard already understands, so it is what the window does
today — but an application has no reason to put a secret there at all. Hand it
over the preload bridge instead, and have the dashboard prefer that when it is
running as an app.

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

`[blocked]` **Windows 11 Mica and macOS vibrancy.** Declared in
`desktop/main.js` and unverifiable from Linux. Check them on the real platforms;
if Mica does not take, the solid ground colour is already behind it.

**A pale 4px band under WSLg is not ours** — settled, so nobody re-opens it. It
runs along the left, right and bottom of the window and not the top. It is the
window manager's resize border around a frameless window: `capturePage` comes
back dark to all four edges, so the band is outside the web contents entirely.
`hasShadow: false` and `transparent: true` were both tried, neither touched it,
and neither was left in the code — a workaround that does not work is worse than
the artefact. Windows draws this frame through DWM and does not have it.

`[next]` Light theme from the system, `prefers-reduced-motion`.

The bar the user named is Claude Desktop for Windows. Treat it as the reference.

---

## Phase 4 — installing without a terminal `[next]`

Installer, first-run, auto-update (`electron-updater`). First run should detect
the plan, find Claude Code, and say in plain language what tokio can and cannot
see — which after today's metering work it can state truthfully.

---

## Phase 5 — signing and the other platforms `[next]`

**Start the certificates in week one.** This is blocked by calendar, not by
effort, and it is the step people discover too late:

- Unsigned Windows installers raise a SmartScreen warning that reads as a virus
  to exactly the audience this is for. Certificate ~100-400 EUR/year, and
  SmartScreen reputation still takes weeks to accumulate after you sign.
- macOS needs an Apple Developer account (99 USD/year) and notarisation.

---

## Non-CLI users `[open]`

The unresolved question, parked deliberately. tokio depends on Claude Code in
three separate places, and each costs a browser-only user something different:

| What | Source | Browser-only user |
|---|---|---|
| Gauges (%, reset) | `claude -p "/usage"` | Needs the CLI installed and signed in |
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

`[open]` **Does the Claude desktop app leave anything readable on disk?**
Unknown, and worth half an hour before anyone designs for option 1 or 2 — if the
answer is yes, the whole picture for non-CLI users improves. Nobody has looked.

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
