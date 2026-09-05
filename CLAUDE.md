# tokio — notes for working in this repo

## What it is

A local daemon that reads Claude Code's transcripts to measure subscription usage, and a queue
that runs prompts through `claude -p` when quota comes back. Read `README.md` first; it explains
the design decisions and is kept accurate.

## Constraints that will bite you

- **The server runs through Node's type stripping**, not a TypeScript compiler, in dev and tests.
  Anything that needs code generation fails at import: no `enum`, no parameter properties
  (`constructor(private db: Db)`), no decorators, no `namespace`. Declare fields and assign them
  in the constructor body.
- **`node:sqlite` is built in** (Node ≥ 22.5) and is why there are no native dependencies. Rows
  come back as null-prototype objects, so cast through `unknown` when typing query results.
- **Transcripts repeat each assistant response** several times with the same `requestId`. Any new
  code that reads them must deduplicate on `messageId` + `requestId`, or usage triples.
- Relative imports use the `.ts` extension; `rewriteRelativeImportExtensions` fixes them on build.

## Testing

`npm test` must never spend tokens, and must never touch the machine it runs on. The server tests
point `XDG_CONFIG_HOME` at a temp directory before anything imports the config, because
`PATCH /api/config` calls `saveConfig`, which writes to the real path — without that redirect the
suite edits the config of whoever runs it.

Nor may a test reach the desktop. `notify.test.ts` once ran with `desktop: true` on the theory
that the notifier would be missing; the moment desktop notifications stopped being Linux-only it
started popping real toasts at whoever ran `npm test`. Notification tests use `desktop: false`,
and the crash-safety of a missing binary is tested through `runDetached` against a name no system
has.

The executor is tested against `test/fake-claude.sh`, which
emits the same `stream-json` shape as the real CLI and can simulate a rate limit
(`TOKIO_FAKE_MODE=ratelimit`) or a crash (`TOKIO_FAKE_MODE=crash`). Extend that script rather than
reaching for the real binary.

Fixtures in `test/fixtures/transcript.jsonl` mirror real transcript shapes, duplicates included.

## The percentage is not ours to invent

`claude -p "/usage"` returns Anthropic's own session and weekly percentages and reset times, at
no cost (it reports zero turns). That is the source of truth, in `src/usage/probe.ts`. Local
reconstruction from transcripts exists only as a fallback for API-key users and failed reads.

If you touch the meter: never let an estimated percentage override a reported one, and keep
`WindowStatus.source` accurate — the UI shows it, and the whole point is that a reader can tell
which is which.

## The prices are not ours to invent either

`src/meter/catalog.ts` mirrors the model catalog Claude Code carries — the one behind its own
`/cost`. Keep it a mirror: prices are per model ID (Opus 4.1 is three times Opus 4.5), fast mode
and the `us` inference surcharge and per-request web search all count, and an unrecognised model
falls back to its family's newest tier rather than being silently dropped.

Two rules follow. Bump `PRICING_VERSION` in `src/db.ts` whenever a rate changes, or stored history
keeps the old price forever. And leave the reconciliation in `meter/value.ts` alone: Claude Code
writes a `cost-state` line into some transcripts with its own session total, and comparing against
it is the only external check this project has. Landing a few percent under it is correct —
session-titling, compaction and retries never reach the transcript.

## The plan is read, not assumed

`src/plans/detect.ts` reads the plan off `~/.claude.json` (`organizationType` plus
`organizationRateLimitTier`, which is the only thing separating Max 5× from Max 20×). Config
`plan` defaults to `'auto'`; a value set by hand always wins.

When it cannot be determined — Team, Enterprise, an unqualified Max, an API key — `resolvePlan`
returns `basis: 'unknown'` and `computeValue` withholds the price, so no payback is built on a
plan nobody confirmed. Keep that: the gauges never needed the plan, only the payback does.

Nothing about the developer's own account belongs in this repo. `src/plans/profiles.json` once
carried a real session's figures in its `_note`; it is now a generic statement, and the README
examples use invented numbers. Check that before publishing anything.

## Honesty rules for this project

The whole value is that the numbers are trustworthy, so:

- Never present an estimated plan cap as a measurement. Anything derived from
  `src/plans/profiles.json` must carry `basis: 'default'` through to the UI.
- Estimates are ranges (p50/p90) with a stated basis. Don't collapse them to one number.
- If a number can't be known, say so in the interface instead of inventing a plausible one.

## Work in progress lives in docs/

`docs/desktop-app.md` is the running state of turning tokio into a desktop app — what is
decided, what is done, what is deliberately still open. Read it before touching packaging,
Windows paths, or anything about users who don't have the CLI. It is edited in place, not
appended to: if you finish something there, move its status and write down what you learned.
