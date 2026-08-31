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

`npm test` must never spend tokens. The executor is tested against `test/fake-claude.sh`, which
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

## Honesty rules for this project

The whole value is that the numbers are trustworthy, so:

- Never present an estimated plan cap as a measurement. Anything derived from
  `src/plans/profiles.json` must carry `basis: 'default'` through to the UI.
- Estimates are ranges (p50/p90) with a stated basis. Don't collapse them to one number.
- If a number can't be known, say so in the interface instead of inventing a plausible one.
