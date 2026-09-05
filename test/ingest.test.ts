import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEntry } from '../src/ingest/parse.ts';
import { tailFile } from '../src/ingest/tail.ts';
import { projectPathOf, unslugProject } from '../src/ingest/discover.ts';
import { creditsFor, familyOf, resolveRates } from '../src/meter/weights.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'transcript.jsonl');
const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

test('a streamed response repeated in the transcript is one billable event', () => {
  const usage = lines.map((l) => parseEntry(l, '/repo/demo')).filter((p) => p?.kind === 'usage');
  assert.equal(usage.length, 5, 'every copy is parsed');
  const unique = new Set(usage.map((u: any) => `${u.event.messageId}:${u.event.requestId}`));
  assert.equal(unique.size, 3, 'but they collapse to three distinct responses');
});

test("Claude Code's own notices are not billable responses", () => {
  // An "assistant" line with model "<synthetic>" is Claude Code talking, not the
  // API: a login notice, an interruption. Zero tokens, so it never moved a
  // total — but its timestamp was enough to open a five-hour window nobody was
  // billed for, and to make an idle machine look busy.
  const notice = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-04T17:02:16.928Z',
    sessionId: 's-1',
    message: {
      id: 'syn-1', model: '<synthetic>', role: 'assistant',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'text', text: 'Login expired \u00b7 Please run /login' }],
    },
  });
  assert.equal(parseEntry(notice, '/repo/demo'), null);
});

test('tool results do not start a new turn', () => {
  const turns = lines.map((l) => parseEntry(l, '/repo/demo')).filter((p) => p?.kind === 'turn');
  assert.deepEqual(turns.map((t: any) => t.promptId), ['p-1', 'p-2']);
});

const MTOK = { inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

test('cache tiers are priced apart', () => {
  const oneHour = creditsFor({ ...MTOK, cacheWrite1h: 1_000_000 }, 'claude-opus-5');
  const fiveMin = creditsFor({ ...MTOK, cacheWrite5m: 1_000_000 }, 'claude-opus-5');
  const read = creditsFor({ ...MTOK, cacheRead: 1_000_000 }, 'claude-opus-5');
  assert.equal(oneHour, 10);
  assert.equal(fiveMin, 6.25);
  assert.equal(read, 0.5);
});

test('models inside one family are priced apart', () => {
  const input = { ...MTOK, inputTokens: 1_000_000 };
  // Opus 4.1 really is three times the price of everything from 4.5 on, and
  // Sonnet 5 undercuts Sonnet 4.6 by a third. A family-wide rate hides both.
  assert.equal(creditsFor(input, 'claude-opus-4-1'), 15);
  assert.equal(creditsFor(input, 'claude-opus-5'), 5);
  assert.equal(creditsFor(input, 'claude-sonnet-4-6'), 3);
  assert.equal(creditsFor(input, 'claude-sonnet-5'), 2);
  assert.equal(creditsFor(input, 'claude-haiku-4-5'), 1);
});

test('provider-flavoured and dated model ids price the same as the plain one', () => {
  const input = { ...MTOK, inputTokens: 1_000_000 };
  for (const id of [
    'claude-opus-4-5-20251101',
    'us.anthropic.claude-opus-4-5-20251101-v1:0',
    'claude-opus-4-5@20251101',
    'claude-opus-4-5[1m]',
  ]) {
    assert.equal(creditsFor(input, id), 5, id);
  }
});

test('a dated id whose catalog entry is named differently is still found', () => {
  // The catalog files these two under `-4-0`, but the ids Anthropic ships are
  // dated, and the date is all that separates them from a name with no `-0` to
  // match. They used to fall through to their family's newest tier, pricing a
  // summer of Opus 4 at a third of what it cost.
  const input = { ...MTOK, inputTokens: 1_000_000 };
  assert.equal(resolveRates('claude-opus-4-20250514').basis, 'model');
  assert.equal(creditsFor(input, 'claude-opus-4-20250514'), 15);
  assert.equal(creditsFor(input, 'us.anthropic.claude-opus-4-20250514-v1:0'), 15);
  assert.equal(creditsFor(input, 'claude-sonnet-4-20250514'), 3);
  // Vertex's own spelling of Sonnet 3.5 carries a `-v2` the date strip leaves behind.
  assert.equal(creditsFor(input, 'claude-3-5-sonnet-v2@20241022'), 3);
});

test('an unrecognised model falls back to its family, not to silence', () => {
  const input = { ...MTOK, inputTokens: 1_000_000 };
  assert.equal(resolveRates('claude-opus-99').basis, 'family');
  assert.equal(creditsFor(input, 'claude-opus-99'), 5);
  assert.equal(resolveRates('claude-opus-5').basis, 'model');
});

test('fast mode, the US surcharge and web search all cost extra', () => {
  const input = { ...MTOK, inputTokens: 1_000_000 };
  assert.equal(creditsFor(input, 'claude-opus-5', { speed: 'fast' }), 10);
  // Fast mode does not exist on Sonnet, so the flag must not invent a price.
  assert.equal(creditsFor(input, 'claude-sonnet-5', { speed: 'fast' }), 2);
  assert.equal(creditsFor(input, 'claude-opus-5', { inferenceGeo: 'us' }), 5.5);
  // Per-request charges sit outside the geo multiplier.
  assert.equal(creditsFor({ ...MTOK, webSearches: 10 }, 'claude-opus-5', { inferenceGeo: 'us' }), 0.1);
});

test('an unknown model in an expensive family is not priced as a cheap one', () => {
  // Fable and Mythos are not families the plan meters separately, so nothing
  // downstream groups by them — but they cost five times the middle tier, and a
  // model newer than this file has to land somewhere honest.
  const input = { ...MTOK, inputTokens: 1_000_000 };
  assert.equal(creditsFor(input, 'claude-fable-9'), 10);
  assert.equal(creditsFor(input, 'claude-mythos-9'), 10);
});

test('model families are recognised from full ids and aliases', () => {
  assert.equal(familyOf('claude-opus-5'), 'opus');
  assert.equal(familyOf('sonnet'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(familyOf(null), 'unknown');
});

test('tailing resumes where it left off and never splits a line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-tail-'));
  const file = join(dir, 't.jsonl');
  writeFileSync(file, '{"a":1}\n{"b":2}\n');
  const first = tailFile(file, 0);
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);

  // A half-written line must wait for its newline rather than be parsed short.
  writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":');
  const second = tailFile(file, first.offset);
  assert.deepEqual(second.lines, []);
  assert.equal(second.offset, first.offset);

  writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(tailFile(file, first.offset).lines, ['{"c":3}']);
});

test('a truncated file is read again from the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-rotate-'));
  const file = join(dir, 't.jsonl');
  writeFileSync(file, '{"a":1}\n{"b":2}\n');
  const first = tailFile(file, 0);
  writeFileSync(file, '{"z":9}\n');
  const after = tailFile(file, first.offset);
  assert.deepEqual(after.lines, ['{"z":9}']);
});

test('a project path is read from the transcript, not guessed from the folder name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-slug-'));
  const slug = '-home-me-work-my-project';
  const projectDir = join(dir, slug);
  mkdirSync(projectDir);
  writeFileSync(
    join(projectDir, 's.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/home/me/work/my-project', message: { role: 'user', content: 'hi' } }) + '\n',
  );

  // The slug cannot tell a hyphen in a directory name from a path separator.
  assert.equal(unslugProject(slug), '/home/me/work/my/project');
  assert.equal(projectPathOf(projectDir, slug), '/home/me/work/my-project');
});

test('an empty project folder falls back to the slug rather than failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-empty-'));
  const projectDir = join(dir, '-tmp-x');
  mkdirSync(projectDir);
  assert.equal(projectPathOf(projectDir, '-tmp-x'), '/tmp/x');
});

test("Claude Code's own session total is picked out of the transcript", () => {
  const line = JSON.stringify({
    type: 'cost-state',
    sessionId: 's-1',
    totalCostUSD: 10.9,
    hasUnknownModelCost: false,
  });
  const parsed = parseEntry(line, '/repo/demo') as any;
  assert.equal(parsed.kind, 'session-cost');
  assert.equal(parsed.usd, 10.9);

  // A session Claude Code could not price itself is no use as a check.
  const unknown = JSON.stringify({ type: 'cost-state', sessionId: 's-2', totalCostUSD: 5, hasUnknownModelCost: true });
  assert.equal(parseEntry(unknown, '/repo/demo'), null);
});

test('the cache-write aggregate is never lost when the breakdown disagrees', () => {
  // The per-tier fields can add up to less than the total. The remainder still
  // costs money, so it lands on the cheaper 5m tier rather than vanishing.
  const line = JSON.stringify({
    type: 'assistant',
    requestId: 'r-1',
    timestamp: '2026-08-20T10:00:00Z',
    message: {
      id: 'm-1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
  const parsed = parseEntry(line, '/repo/demo') as any;
  assert.equal(parsed.event.cacheWrite1h, 400);
  assert.equal(parsed.event.cacheWrite5m, 600);
});
