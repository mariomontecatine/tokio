<div align="center">

# tokio

**Queue prompts for later. Watch your quota. Stop babysitting the reset clock.**

You ran out of tokens with one small thing left to test. Write it down here and walk away —
`tokio` runs it the moment your window resets.

[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-5FA04E.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-f0b429.svg)](#roadmap)

[Español](README.es.md)

</div>

---

## The problem

Subscription coding agents don't run out of money, they run out of *window*. You hit the limit
at 6pm with one test unrun, one rename unfinished, one "does this actually build?" unanswered.
The work is five minutes long. The wait is three hours. So you either sit there refreshing, or
you come back tomorrow having forgotten what you were doing.

Meanwhile nothing tells you what you have left in terms you can act on. A percentage isn't a
plan. "Can I afford one more refactor before dinner?" is the actual question, and nothing
answers it.

`tokio` does both:

- **A queue that fires on reset.** Leave prompts behind. They run on your machine, in your repo,
  the moment quota comes back — resuming the exact session you were in, if you want. A prompt
  that hasn't run yet is still a draft: open it on the dashboard and rewrite it, and anything you
  pasted in stays folded away rather than filling the box back up.
- **A meter with the real numbers.** Not a reconstruction: `tokio` asks Claude Code's own
  `/usage` for the true percentage and the true reset time, then adds what only it can work out —
  your burn rate, and what a given request will cost before you commit to it.
- **A running total of what the plan is worth.** Every response you've ever had, priced at list
  API rates, against what you actually pay. Most people are surprised.

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/mariomontecatine/tokio/main/install.sh | sh
```

That checks your Node, fetches tokio into `~/.tokio`, builds it, and puts a
`tokio` command in `~/.local/bin`. Then, from any directory:

```bash
tokio                 # opens the dashboard, starting the daemon if it isn't up
tokio status          # just the numbers, no daemon needed
```

Typing `tokio` anywhere starts the daemon if it isn't running and opens the
dashboard in your browser; run it again later and it goes straight to the page
already being served instead of failing on a busy port. Add `--no-open` for the
daemon without the browser, and use `tokio start` in a service unit — that form
never opens anything.

Run the same one-liner again to update; it pulls and rebuilds in place. To
remove it: `rm -rf ~/.tokio ~/.local/bin/tokio`.

<details>
<summary>From source instead</summary>

```bash
git clone https://github.com/mariomontecatine/tokio
cd tokio
npm install && npm run build
npm link
```
</details>

There's nothing to configure and no account to make. `tokio` reads the transcripts Claude Code
already writes to `~/.claude/projects/`, so your entire history is there on first run.

Then, when you hit the wall:

```bash
tokio add "run the integration tests and fix whatever breaks" --resume last
```

```
  resuming "Refactor of the payment adapter"

  Queued 79ed7209: run the integration tests and fix whatever breaks
  Estimate  $1.80 (up to $10.15)  — 167 past opus turns
  Leaves    ~87% of the 5h window
  Runs      when the window resets (11:00 PM)
  Safety    edits
```

Close the laptop.

## What you see

<!-- Screenshot goes here. Drop dashboard.png into docs/screenshots/ and
     uncomment the line below. See docs/screenshots/README.md.

![The tokio dashboard](docs/screenshots/dashboard.png)

-->

```
  Plan: Pro  (read from your Claude account)  (reported by Claude Code)

  5h window  █████░░░░░░░░░░░░░░░░░░░  21%   $1.15 of $5.40
             resets at 11:00 PM
  Week       ██░░░░░░░░░░░░░░░░░░░░░░   8%   $3.60 of $45.00

  Burning $2.10/h — the window resets before you run dry
  Worth 12.4× your subscription over the last 30 days

  Queue (2):
    972dab44  queued    ~$0.40  finish the parser tests
    79ed7209  queued    ~$0.15  tidy the changelog
```

The dashboard draws the same thing as one chart — the window as a strip recorder, where the
filled trace is what you've spent, the dashed line is where your current pace lands you, and the
blocks past the reset rule are the jobs waiting to run in the next window:

<!-- Screenshot goes here: docs/screenshots/strip.png

![The window strip](docs/screenshots/strip.png)

-->

The strip is drawn in percent, from the same readings as the gauges above it, so it covers the
whole account: a window spent entirely in the Claude app or on another laptop still has a height
here, sampled every few minutes rather than turn by turn. Only when there is no reading to draw
from does it fall back to reconstructing the shape from this machine's transcripts, and the
source is named under **Details**. The payback below is the opposite — it can only ever count
transcripts, so it stays a floor.

```
 100 ┤                                              │
     │- - - - - - - - - - - - - - - - - - reserve - │
  75 ┤                                              │
     │                                        ╱     │
  50 ┤                                    ╱ ╱       │  ← projection at current pace
     │                              ▁▁▁▁●           │  ← now
  25 ┤                       ▁▁▁▁▁▁▉▉▉▉▉▉           │▉▉  ← queued jobs, next window
     │        ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▉▉▉▉▉▉▉▉▉▉▉▉▉           │▉▉
   0 ┼───────────────────────────────────────────────────────
     18:00    19:00    20:00    21:00    22:00   23:00 ↑reset
```

## Is the subscription paying for itself?

```
$ tokio value

  Last 30 days

  Run on the API this would have cost       $248.10
  Subscription for those 30 days             $20.00  ($20.00/month)
  So the plan is paying back                  12.4×

  Today 18.2×   ·   Yesterday 7.5×   ·   7 days 11.0×
  Last 5 hours  $3.90
```

Every assistant response you've ever had is in the transcripts, and every one of them has a
price. Add them up and you get what the same month would have cost you on a metered API key.

Two honest caveats, which the command prints itself:

- It counts **the transcripts on this machine**. Work done on another laptop, or in the Claude
  app, isn't in there — so the number is a floor, not a total.
- It's **list API pricing**, which is what *you* would have paid. It is not what Anthropic spends
  serving you; their inference cost is their own and much lower.

### Where the prices come from

Not from us. Claude Code ships a hand-maintained model catalog — the same one behind its own
`/cost` and the per-Mtok labels in `/model` — and [`src/meter/catalog.ts`](src/meter/catalog.ts)
mirrors it: the same tiers, the same model-to-tier mapping, the same surcharges. Three things
follow, and they are the difference between a number and a guess:

- **Prices are per model, not per family.** Opus 4.1 is `$15/$75` per Mtok; Opus 4.5 and
  everything after it is `$5/$25`. Sonnet 4.6 is `$3/$15`, Sonnet 5 is `$2/$10`. A family-wide
  rate misprices most transcripts by a multiple, not by a rounding error.
- **The extras are counted too.** Fast mode is the same model at premium rates, `inference_geo:
  "us"` carries a 10% surcharge, cache writes are split across their 5-minute and 1-hour tiers,
  and server-side web searches are billed per request. All four are in the transcript, so all
  four are counted.
- **A rate change re-prices your history.** Credits are stored per event, but the token counts
  they were computed from never change, so correcting a rate recomputes every event you already
  have rather than leaving old months priced at whatever the table said that week.

**And it checks itself.** Claude Code sometimes writes a `cost-state` line into a transcript with
the total *it* computed for that session. Where it did, `tokio value` compares the two and prints
the result:

```
  Checked against Claude Code's own total on 2 session(s): $37.26 here vs $38.96 there (96%).
```

Landing slightly under is expected and is the honest outcome: a few calls — the Haiku that titles
a session, compaction, retries — never appear in the transcript as assistant messages, so there
is nothing there for us to count. That gap is the floor caveat above, measured instead of
asserted.

**There is no dollar figure to ask Anthropic for.** On a subscription, `claude -p "/cost"` returns
percentages and reset times and no cost at all — deliberately, because a Pro or Max plan is not
billed per token. The Admin API's usage and cost reports cover API-key organisations, not
subscriptions. So the exact tokens come from Anthropic (the `usage` object in every transcript
line), the prices come from Claude Code's catalog, and the multiplication is the only part that
is ours.

If you subscribed before your oldest transcript, tell `tokio` when, so the months line up:

```json
{ "subscriptionStartedAt": "2026-05-14", "planPriceUsd": 100 }
```

## How it works

```
  ~/.claude/projects/**/*.jsonl          Claude Code writes these anyway
              │
              ▼
     ┌─────────────────┐
     │  ingest         │  tails each transcript, deduplicates the streamed
     │                 │  copies, groups calls into user turns
     └────────┬────────┘
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  meter          │◄───│  claude -p       │  the real percentage and
     │  5h + weekly    │    │  "/usage"        │  reset time, free to poll
     └────────┬────────┘    └──────────────────┘
              │
              ▼
     ┌─────────────────┐    ┌──────────────────┐
     │  scheduler      │───►│  claude -p       │  runs in your repo, on your
     │  reserve floor  │    │  --resume …      │  machine, with your setup
     └────────┬────────┘    └────────┬─────────┘
              │                      │
              ▼                      ▼
        dashboard + CLI        cost fed back into
                               the next estimate
```

Three things make the numbers real rather than decorative:

**Deduplication.** Claude Code appends the same assistant response to the transcript more than
once as it streams — across the transcripts on my machine there are 1.93 lines for every real
response, and some responses appear three times. Counting lines roughly doubles your apparent
usage. `tokio` keys on `messageId` + `requestId`, so each response counts once.

**Cost as the unit.** Tokens aren't comparable across models — an Opus turn drains a plan about
five times faster than a Sonnet one, and a cache read is a tenth of a fresh input token.
Everything is converted to one USD-equivalent unit using per-model list prices, which is what
subscription limits actually scale with. The rates are mirrored from Claude Code's own model
catalog rather than typed in from memory — see [Where the prices come from](#where-the-prices-come-from).

**Turn-level history.** Calls are grouped by the user prompt that triggered them, so an estimate
answers "what does one request like this cost" instead of "what does a whole session cost". This
works from your first run, because your existing transcripts are the training data.

## Where the percentage comes from

Straight from Anthropic. `claude -p "/usage"` runs Claude Code's own usage command without a UI,
and it reports **no turns and no cost** — it's a local command that queries the server, so it can
be polled for free:

```
Current session: 69% used · resets Sep 1, 1:19am (Europe/Madrid)
Current week (all models): 27% used · resets Sep 5, 8:59pm (Europe/Madrid)
```

The daemon reads that every few minutes, and the dashboard's ↻ button reads it on demand and
tells you how old the last one is. The header says `reported by Claude Code` whenever the figures
on screen are Anthropic's own.

A reading also expires the instant the reset it announced arrives, however recently it was taken.
`/usage` prints no session line at all while nothing is running, so on a machine that has gone
quiet — which is exactly what a machine out of quota does — the last reading from before a reset
would otherwise stay the newest one there is, and the page would go on describing a window that
had already ended.

This matters more than it sounds. Reconstructing the window from transcripts gets it wrong:
sessions don't start on the hour, so a locally guessed window can be hours off, and any cap you
infer from it drifts. Everything that *can* be read is read.

What still has to be worked out locally, because nothing reports it:

- **Burn rate and time-to-empty** — needs the shape of spend over time.
- **What a queued job will cost** — needs your own history, priced per turn.
- **What the plan is worth** — needs every response you've ever had, priced.

To express a dollar estimate as a share of your window, `tokio` divides the credits it counted by
the percentage Anthropic reported. That conversion is automatic and self-correcting.

### When the reading fails

If you're on an API key, not logged in, or `claude` isn't on the PATH, there's no percentage to
read. `tokio` says so in the header and falls back to estimating from
[`src/plans/profiles.json`](src/plans/profiles.json), whose caps are guesses. You can pin them by
hand:

```bash
tokio calibrate 63              # the 5-hour window
tokio calibrate 15 --window week
```

It also treats any limit it *actually hits* as a hard lower bound. The header always tells you
which of the three you're looking at: reported, calibrated, or estimated.

### Which plan you're on

Read from your Claude account, not asked for and not assumed. Claude Code stores the profile it
fetched from Anthropic in `.claude.json`, and the plan is in there — `organizationType` says Pro
or Max, and `organizationRateLimitTier` is what separates Max 5× from Max 20×. That is the same
pair of fields Claude Code itself uses to tell them apart.

It matters because the plan's price is the denominator of every payback figure: reading a Pro
account as Max 5× would understate what the subscription returned by five times.

Three rules keep it honest:

- **A plan you set by hand is never overridden.** `plan` in your config beats detection.
- **Team, Enterprise and an unqualified Max are left undetermined**, because the two Max plans
  differ by half in both price and limits and guessing would put a wrong price under everything.
- **An undetermined plan produces no payback at all**, rather than a plausible one. The gauges
  still work — they come from Anthropic's own percentages and never needed the plan.

Nothing is sent anywhere; it is a read of a file you already have, and nothing but the plan is
taken from it.

### Where it runs

| | Daemon and CLI | One-line install | Opens your browser | Desktop notifications |
|---|---|---|---|---|
| Linux | yes | yes | `xdg-open` | `notify-send` |
| macOS | yes | yes | `open` | `osascript` |
| WSL | yes | yes | `wslview`, else `explorer.exe` | Windows toast |
| Windows | yes | use the from-source steps | `start` | Windows toast |

Anything it cannot do, it says so and prints the URL instead of failing.

## Safety

Queued jobs run while you're not there. That's the whole point, and it's also the risk, so you
choose the leash per job:

| Mode | Flag | What it can do |
|---|---|---|
| `plan` | `--safety plan` | Reads and proposes. Changes nothing. |
| `edits` | `--safety edits` | Edits files and runs tools without asking. **Default.** |
| `full` | `--safety full` | No restrictions at all, in that directory. |

Two habits worth having: queue unattended work onto a branch you don't mind rewinding, and keep
`plan` for anything you haven't thought through. `tokio` never widens a job's permissions on its
own, and a job only ever touches the directory you gave it.

### Privacy, and what leaves your machine

Nothing goes anywhere you didn't configure. Worth knowing before you run it, and before you push
a fork of it:

- **`tokio` never reads, stores or forwards your Claude credentials.** It doesn't touch
  `~/.claude/.credentials.json` or any API key. It launches `claude` as a subprocess and lets
  Claude Code authenticate itself, exactly as it does when you run it by hand.
- **The database and config stay on your machine**, in `~/.local/share/tokio/` and
  `~/.config/tokio/` — outside the repo, so a `git add .` cannot pick them up. The config is
  written owner-only (`0600`) because it can hold an access token and a Telegram bot token.
- **The dashboard binds to `127.0.0.1` by default.** Bind it anywhere else and the daemon mints a
  random access token and prints a URL carrying it; without that token the API returns 401. The
  token travels in a header everywhere except `/api/stream`, which cannot send one.
- **`tokio config` and `GET /api/config` mask secrets.** Paste the output into a bug report
  without reading it twice. The real values are in the file, which the command names.
- **Notifications are the one thing that leaves.** An ntfy topic, a Telegram chat or a webhook
  only receives what you configured it to receive, and all three are off until you set them. An
  ntfy topic name *is* the password for that topic — anyone who knows it can read your
  notifications — so make it unguessable.

The thing to be deliberate about is that **the API can run code as you**. Queueing a job means
running `claude` in a directory you name, and `--safety full` means running it unrestricted. On
loopback that's your own shell. If you expose the dashboard to a network, the token is the only
thing between someone on that network and a shell on your machine — so treat it like an SSH key,
and don't put the daemon on an untrusted network.

The scheduler also keeps a **reserve** (10% by default). A job won't start if its pessimistic
estimate would eat into that floor, so an unattended queue can't quietly drain the window you
were saving for yourself. Mark a job `--urgent` to override.

## Commands

| Command | What it does |
|---|---|
| `tokio` | Open the dashboard, starting the daemon if it isn't up (`--no-open` to skip the browser) |
| `tokio status` | Quota, burn rate, projected exhaustion, queue |
| `tokio refresh` | Re-read the real numbers from Claude Code and show them |
| `tokio value` | What the subscription has been worth, month by month |
| `tokio start` | Daemon, scheduler and dashboard, without opening a browser |
| `tokio open` | Open the dashboard of a daemon that's already running |
| `tokio add <prompt>` | Queue a prompt |
| `tokio ls [--all]` | List jobs |
| `tokio show <id>` | A job and its output |
| `tokio run <id>` | Run one now, in the foreground |
| `tokio rm <id>` | Remove a job |
| `tokio calibrate <pct>` | Teach it your real limit |
| `tokio sessions` | Resumable sessions for this directory |
| `tokio config` | Show the config file and its values, with secrets masked |

Options for `add`:

| Option | Default | |
|---|---|---|
| `--cwd <dir>` | current directory | Which project to run in |
| `--resume <id\|last>` | new session | Continue an existing conversation |
| `--model <name>` | your Claude Code default | `opus`, `sonnet`, `haiku` or a full id |
| `--safety <mode>` | `edits` | See the table above |
| `--when <policy>` | `on-reset` | `on-reset`, `asap`, `manual`, or an ISO time |
| `--urgent` | off | Allow spending into the reserve |

## Configuration

`~/.config/tokio/config.json`, created on first use. The ones worth knowing:

| Key | Default | |
|---|---|---|
| `plan` | `auto` | Read from your Claude account. Override with `pro`, `max5`, `max20` or `custom` |
| `subscriptionStartedAt` | `null` | `"2026-05-14"` — when you started paying, for `tokio value` |
| `planPriceUsd` | `null` | Override the monthly price (regional pricing, a team seat) |
| `reservePct` | `10` | How much of the window to keep for yourself |
| `usagePollMs` | `180000` | How often to re-read the real percentages |
| `usageMaxAgeMs` | `900000` | Past this a reading is stale and estimates take over — as they do the moment the reset it reported arrives |
| `defaultSafety` | `edits` | Leash for new jobs |
| `weeklyAnchor` | `null` | `{ "weekday": 3, "hour": 11 }` — set it and the weekly gauge shows a real reset instead of a rolling window |
| `concurrency` | `1` | Jobs at once |
| `notify` | — | ntfy topic, Telegram bot, webhook, desktop |
| `host` / `port` | `127.0.0.1:4646` | Beyond loopback, a `token` is generated if you have none |
| `token` | `null` | Required for non-local access; sent as a header or `?token=` |

### Notifications

Set any of them and you'll hear when a job lands:

```json
{ "notify": { "ntfyTopic": "tokio-me-7f3a", "telegramToken": "…", "telegramChatId": "…" } }
```

### Keeping it running

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tokio.service <<EOF
[Unit]
Description=tokio

[Service]
# Absolute paths on purpose: a user unit gets none of your shell's PATH, so a
# version-managed node (nvm, fnm, volta) is invisible to it.
ExecStart=$(command -v node) $(pwd)/dist/cli.js start
WorkingDirectory=$(pwd)
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now tokio
systemctl --user status tokio --no-pager
```

Run that from the repo, so `$(pwd)` resolves. To have it survive logout,
`loginctl enable-linger $USER`.

## FAQ

**Does this work with ChatGPT?**
Not with a ChatGPT Plus/Pro subscription — it has no API, and driving the web UI with a browser
robot would break OpenAI's terms and shatter on every redesign. `tokio` won't do that. Paid API
keys and OpenAI's own Codex CLI are a different matter and are on the roadmap.

**Isn't this against Anthropic's terms?**
No. `tokio` reads log files on your own disk and runs the official CLI the same way you would, at
a normal pace. It doesn't share accounts, evade limits, or hide traffic — when the limit says
stop, jobs wait. It's a scheduler, not a workaround.

**I can already see my sessions in the Claude app. Why do I need this?**
The app is genuinely good at picking a conversation back up from your phone — but only while you
still have quota. It won't hold a prompt until your limit resets, it won't tell you what a
request is about to cost, and a cloud session isn't your machine, with your database running and
your services up. That's the gap this fills.

**How accurate are the numbers?**
The percentages and reset times are Anthropic's own, so they're exact as of the last reading —
the dashboard shows its age and refreshes on demand. The *cost forecasts* are ranges, not
promises. The dashboard shows how often reality landed inside the range it predicted,
so you can judge for yourself. In practice it tightens quickly, because every finished job
becomes training data for the next estimate.

**Is the payback number telling me what Anthropic spends on me?**
No, and it would be wrong to read it that way. It's what *you* would have paid at list API prices
for the same work — the alternative you didn't buy. Anthropic's actual serving cost is lower and
isn't public.

**Are the dollar figures right?**
They use the same per-model rates Claude Code uses, and `tokio value` checks itself against
Claude Code's own session totals wherever it left one in a transcript — see
[Where the prices come from](#where-the-prices-come-from).

**Where's my data?**
`~/.local/share/tokio/tokio.db`, on your machine. Nothing is sent anywhere. The dashboard binds
to loopback unless you deliberately change it. Details in
[Privacy, and what leaves your machine](#privacy-and-what-leaves-your-machine).

## Roadmap

- [x] Usage meter with 5-hour and weekly windows
- [x] Queue that fires on reset, with reserve protection
- [x] Cost forecasting with a feedback loop
- [x] Real percentages and reset times read from Claude Code's own `/usage`
- [ ] Pay-per-token providers (Anthropic API, OpenAI-compatible, Ollama) via the existing
      [`Provider`](src/providers/types.ts) interface
- [ ] OpenAI Codex CLI, for people whose subscription is on that side
- [ ] Chained jobs — "if this one passes, run that one"
- [ ] **Suspend when the queue drains.** Queue work overnight, let the machine sleep instead of
      idling. The constraint is the whole design: it may only fire when the queue is *completely*
      empty — nothing running, queued, deferred or scheduled — because sleeping after the first of
      three jobs means the other two never run, which defeats the point of queueing them. Off by
      default, with a countdown you can cancel, and never while a job is mid-write. The version
      worth building pairs it with an RTC wake for the reset time, so the machine sleeps, wakes
      when the window reopens, drains the queue and sleeps again; that needs root on most systems.

## Development

```bash
npm test          # 108 tests, no tokens spent: the executor runs against a fake CLI
npm run dev       # daemon from source, no build step
npm run dev:web   # dashboard with hot reload, proxying to the daemon
```

Node ≥ 22.5 (for built-in `node:sqlite`). The server is run through Node's type stripping, so
avoid TypeScript that needs code generation — no enums, no parameter properties, no decorators.

Contributions welcome, especially provider adapters and real-world calibration data.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

---

<sub>Not affiliated with Anthropic or OpenAI. Plan limits are estimates until you calibrate them.
The name is a pun on tokens and I/O; the Rust runtime got there first and is unrelated.</sub>
