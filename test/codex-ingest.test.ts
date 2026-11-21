import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { openDb } from '../src/db.ts';
import { parseCodexLine, readingFromSnapshot, worthParsing } from '../src/codex/parse.ts';
import { readChunk } from '../src/codex/tail.ts';
import { CodexIngestor, discoverRollouts } from '../src/codex/ingest.ts';
import { codexCredits, OPENAI_PRICES, priceRowAt, pricesReadOn, type PriceRow } from '../src/codex/prices.ts';
import { latestCodexRead, repriceCodexEvents } from '../src/codex/store.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex');

/** A private copy of the fixture home, so nothing a test appends leaks into another. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-codex-home-'));
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

test('only the five line kinds that matter are parsed, by their top-level type', () => {
  // Settings carry the service tier the next records ran under; nothing else of them is read.
  assert.deepEqual(
    parseCodexLine('{"timestamp":"2026-03-02T09:00:04.000Z","ordinal":1,"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"t","thread_settings":{"model":"m","service_tier":"default"}}}'),
    { kind: 'settings', serviceTier: 'default' },
  );
  assert.deepEqual(
    parseCodexLine('{"timestamp":"x","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"m"}}}'),
    { kind: 'settings', serviceTier: null },
    'settings that name no tier still replace the ones before',
  );

  const usage = parseCodexLine(
    '{"timestamp":"2026-03-02T09:00:12.000Z","type":"token_usage_record","payload":{"thread_id":"t","turn_id":"u","response_id":"r","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":1}}}',
  );
  assert.equal(usage?.kind, 'usage');
  assert.deepEqual(usage?.kind === 'usage' && usage.usage, {
    responseId: 'r', ts: Date.parse('2026-03-02T09:00:12.000Z'), threadId: 't', turnId: 'u',
    inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1,
  });

  // A conversation line that merely mentions the words is not parsed at all.
  assert.equal(worthParsing('{"timestamp":"x","type":"response_item","payload":{"type":"message","content":"token_usage_record"}}'), false);
  // And a compacted line's embedded copy of a record is not a record.
  assert.equal(parseCodexLine('{"timestamp":"x","type":"compacted","payload":{"latest_token_usage_record":{"response_id":"r"}}}'), null);
  assert.equal(parseCodexLine('not json'), null);
});

test('windows are told apart by their length, not by which slot they arrived in', () => {
  const swapped = readingFromSnapshot(
    {
      limit_id: 'codex',
      primary: { used_percent: 40, window_minutes: 10080, resets_at: 2_000_000 },
      secondary: { used_percent: 7, window_minutes: 300, resets_at: 1_000_000 },
    },
    0,
    'rollout',
  );
  assert.equal(swapped?.sessionPct, 7);
  assert.equal(swapped?.sessionResetsAt, 1_000_000_000, 'seconds become milliseconds');
  assert.equal(swapped?.weekPct, 40);

  // camelCase, as the app server answers.
  const camel = readingFromSnapshot(
    { limitId: 'codex', planType: 'pro', primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_000 }, secondary: null },
    5,
    'app-server',
  );
  assert.equal(camel?.sessionPct, 21);
  assert.equal(camel?.weekPct, null, 'a missing window is missing, not zero');
  assert.equal(camel?.planType, 'pro');
  assert.equal(camel?.via, 'app-server');
});

test('a chunked read never splits a line, however long', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-chunk-'));
  const file = join(dir, 'r.jsonl');
  const long = 'x'.repeat(50_000);
  writeFileSync(file, `one\n${long}\nthree\npartial`);

  const lines: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const chunk = await readChunk(file, offset, 1024);
    lines.push(...chunk.lines);
    offset = chunk.offset;
    if (!chunk.more) break;
  }
  assert.deepEqual(lines.map((l) => l.length), [3, 50_000, 5], 'the unfinished last line waits for its newline');

  appendFileSync(file, '\n');
  const rest = await readChunk(file, offset, 1024);
  assert.deepEqual(rest.lines, ['partial']);
});

test('ingesting counts each response once, with the model of its own turn', async () => {
  const db = openDb(':memory:');
  const codexHome = home();
  assert.equal((await discoverRollouts(codexHome)).length, 2);

  const inserted = await new CodexIngestor(db, codexHome, 512).scan();
  // Four distinct responses. The fork repeats resp_fixture_0001, a tool output
  // spells out a record, and a compacted line embeds one: none of those count.
  assert.equal(inserted, 4);
  const rows = db.prepare('SELECT responseId, model, inputTokens, cachedInputTokens, outputTokens, threadId, project, credits, serviceTier FROM codex_events ORDER BY ts').all() as any[];
  assert.deepEqual(rows.map((r) => r.responseId), ['resp_fixture_0001', 'resp_fixture_0002', 'resp_fixture_0003', 'resp_fixture_0004']);
  assert.deepEqual(rows.map((r) => r.model), ['gpt-test-large', 'gpt-test-large', 'gpt-test-small', 'gpt-test-large'], 'a thread can switch models between turns');
  assert.deepEqual(rows.map((r) => r.serviceTier), ['default', 'default', 'default', 'default'], 'the tier the settings named, kept across turns');
  assert.equal(rows[0].project, '/home/test/widget');
  assert.equal(rows[3].project, '/home/test/gadget');
  assert.ok(rows.every((r) => r.credits === null), 'no published price for these models, so no dollars');

  // The running totals beside each record are never what gets summed.
  const sum = db.prepare('SELECT SUM(inputTokens) AS i, SUM(outputTokens) AS o FROM codex_events').get() as any;
  assert.equal(sum.i, 12000 + 14000 + 3000 + 5000);
  assert.equal(sum.o, 300 + 500 + 1000 + 200);

  // A second pass reads nothing new.
  assert.equal(await new CodexIngestor(db, codexHome).scan(), 0);
});

test('a fork read before its parent does not keep the copy that did not know its model', async () => {
  const db = openDb(':memory:');
  const codexHome = home();
  const [parent, fork] = await discoverRollouts(codexHome);
  assert.match(parent!, /0000000000a\.jsonl$/, 'discovery lists oldest first, whatever the filesystem says');
  // Read in the worst order on purpose.
  await new CodexIngestor(db, codexHome).scan([fork!, parent!]);
  const row = db.prepare("SELECT model, project, threadId, serviceTier FROM codex_events WHERE responseId = 'resp_fixture_0001'").get() as any;
  assert.equal(row.model, 'gpt-test-large');
  assert.equal(row.project, '/home/test/widget');
  assert.equal(row.threadId, '0f0e0d0c-0000-7000-8000-00000000000a');
  // The fork copied the record before naming any settings of its own.
  assert.equal(row.serviceTier, 'default', 'and the tier of the turn it ran in, not the fork’s');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM codex_events').get() as any).n, 4, 'still one row per response');
});

const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

test('a rollout Codex compressed is read too, once, and a broken one is skipped and retried', { skip: !zstdCompress && 'this Node has no zstd' }, async () => {
  const db = openDb(':memory:');
  const codexHome = home();
  const [parent] = await discoverRollouts(codexHome);
  // What Codex does to a finished session: the same file, zstd-compressed in place.
  writeFileSync(`${parent}.zst`, zstdCompress!(readFileSync(parent!)));
  rmSync(parent!);
  const files = await discoverRollouts(codexHome);
  assert.ok(files.some((f) => f.endsWith('.jsonl.zst')));

  assert.equal(await new CodexIngestor(db, codexHome, 512).scan(), 4, 'the compressed thread counts like any other');
  const row = db.prepare("SELECT model, project FROM codex_events WHERE responseId = 'resp_fixture_0003'").get() as any;
  assert.equal(row.model, 'gpt-test-small');
  assert.equal(row.project, '/home/test/widget');
  assert.equal(await new CodexIngestor(db, codexHome).scan(), 0, 'read once: it is finished');

  // Half a file — the compressor still writing it — is not an error worth dying over.
  const broken = join(codexHome, 'sessions', '2026', '03', '02', 'rollout-2026-03-02T11-00-00-broken.jsonl.zst');
  const whole = zstdCompress!(Buffer.from('{"timestamp":"2026-03-02T11:00:00Z","type":"session_meta","payload":{"id":"t-broken","cwd":"/x"}}\n'.repeat(50)));
  writeFileSync(broken, whole.subarray(0, Math.floor(whole.length / 2)));
  await new CodexIngestor(db, codexHome).scan();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM codex_files WHERE path = ?').get(broken) as any).n, 0, 'not recorded as read, so it is tried again');
});

test('limit readings are kept, and only the general limit is read back', async () => {
  const db = openDb(':memory:');
  await new CodexIngestor(db, home()).scan();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM codex_limits').get() as any).n;
  assert.equal(count, 4, 'every token_count with limits is a reading');

  const session = latestCodexRead(db, 'session');
  // The 70% belongs to another model's allowance and must not land on the ring.
  assert.equal(session?.sessionPct, 17);
  assert.equal(session?.via, 'rollout');
  assert.equal(session?.sessionResetsAt, 1772456400 * 1000);
  assert.equal(session?.planType, 'plus');
});

test('a restart halfway through a turn still knows the model and the tier', async () => {
  const db = openDb(':memory:');
  const codexHome = mkdtempSync(join(tmpdir(), 'tokio-codex-resume-'));
  const dir = join(codexHome, 'sessions', '2026', '03', '03');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-03-03T08-00-00-aaaa.jsonl');
  writeFileSync(file, [
    '{"timestamp":"2026-03-03T08:00:00.000Z","type":"session_meta","payload":{"id":"thread-r","cwd":"/home/test/r"}}',
    '{"timestamp":"2026-03-03T08:00:00.500Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread-r","thread_settings":{"model":"gpt-test-large","service_tier":"default"}}}',
    '{"timestamp":"2026-03-03T08:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-test-large","cwd":"/home/test/r"}}',
    '{"timestamp":"2026-03-03T08:00:02.000Z","type":"token_usage_record","payload":{"thread_id":"thread-r","turn_id":"t1","response_id":"resp_r1","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}}',
    '',
  ].join('\n'));
  await new CodexIngestor(db, codexHome).scan();

  // A new daemon, with nothing in memory, picks up the rest of the same turn.
  appendFileSync(file, '{"timestamp":"2026-03-03T08:00:09.000Z","type":"token_usage_record","payload":{"thread_id":"thread-r","turn_id":"t1","response_id":"resp_r2","usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":2}}}\n');
  assert.equal(await new CodexIngestor(db, codexHome).scan(), 1);
  const row = db.prepare("SELECT model, project, serviceTier FROM codex_events WHERE responseId = 'resp_r2'").get() as any;
  assert.equal(row.model, 'gpt-test-large');
  assert.equal(row.project, '/home/test/r');
  assert.equal(row.serviceTier, 'default', 'the settings line is behind the offset now, so the tier has to have been kept');
});

const TABLE: PriceRow[] = [
  { model: 'gpt-test-large', from: '2026-01-01', rates: { input: 2, cachedInput: 0.5, output: 10 }, source: 'test', readOn: '2026-01-01' },
  // A real price change: a new row from its own date, the old one kept.
  { model: 'gpt-test-large', from: '2026-03-02T09:30:00Z', rates: { input: 1, cachedInput: 0.25, output: 5 }, source: 'test', readOn: '2026-03-02',
    longContext: { aboveInputTokens: 100_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
];

test('a price applies from its own date, and earlier responses keep the old one', () => {
  const before = Date.parse('2026-03-02T09:00:12Z');
  const after = Date.parse('2026-03-02T10:00:15Z');
  assert.equal(priceRowAt('gpt-test-large', before, TABLE)?.rates.input, 2);
  assert.equal(priceRowAt('gpt-test-large', after, TABLE)?.rates.input, 1);
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2025-12-31'), TABLE), null, 'nothing before the first row');
  assert.equal(priceRowAt('gpt-test-small', after, TABLE), null, 'no row, no price');

  // 2,000 fresh input at $2, 10,000 cached at $0.50, 300 output at $10, per million.
  const small = { inputTokens: 12_000, cachedInputTokens: 10_000, outputTokens: 300 };
  const usd = codexCredits(small, 'gpt-test-large', before, 'default', TABLE)!;
  assert.ok(Math.abs(usd - (2_000 * 2 + 10_000 * 0.5 + 300 * 10) / 1e6) < 1e-12);

  // Past the long-context threshold the whole request is charged at the higher rate.
  const big = codexCredits({ inputTokens: 200_000, cachedInputTokens: 0, outputTokens: 1_000 }, 'gpt-test-large', after, 'default', TABLE)!;
  assert.ok(Math.abs(big - (200_000 * 1 * 2 + 1_000 * 5 * 1.5) / 1e6) < 1e-12);

  // Standard is the only tier priced. Another one costs a multiple the label
  // has not been seen to name, and none recorded could be any of them.
  assert.equal(codexCredits(small, 'gpt-test-large', before, 'priority', TABLE), null);
  assert.equal(codexCredits(small, 'gpt-test-large', before, 'flex', TABLE), null);
  assert.equal(codexCredits(small, 'gpt-test-large', before, null, TABLE), null);
});

test('a first row with no stated date covers everything before the next one', () => {
  const OPEN: PriceRow[] = [
    { model: 'gpt-test-large', from: null, rates: { input: 2, cachedInput: 0.5, output: 10 }, source: 'test', readOn: '2026-01-01' },
    { model: 'gpt-test-large', from: '2026-06-01', rates: { input: 1, cachedInput: 0.25, output: 5 }, source: 'test', readOn: '2026-06-01' },
  ];
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2019-05-05'), OPEN)?.rates.input, 2, 'no start: as far back as there is history');
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2026-05-31T23:59:59Z'), OPEN)?.rates.input, 2);
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2026-06-01'), OPEN)?.rates.input, 1, 'a dated row takes over from its own date');
  // Listed the other way round, the answer is the same.
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2026-06-02'), [...OPEN].reverse())?.rates.input, 1);
  assert.equal(priceRowAt('gpt-test-large', Date.parse('2026-05-02'), [...OPEN].reverse())?.rates.input, 2);
});

test('the shipped table is a copy of each model’s own page, dated by when it was read', () => {
  assert.ok(OPENAI_PRICES.length > 0);
  const undated = new Set<string>();
  const seen = new Set<string>();
  for (const row of OPENAI_PRICES) {
    assert.equal(row.source, `https://developers.openai.com/api/docs/models/${row.model}`, `${row.model}: copied from its own page`);
    assert.match(row.readOn, /^\d{4}-\d{2}-\d{2}$/, `${row.model}: the day it was read`);
    if (row.from === null) {
      assert.ok(!undated.has(row.model), `${row.model}: at most one row without a start`);
      undated.add(row.model);
    } else {
      assert.ok(!Number.isNaN(Date.parse(row.from)), `${row.model}: a real date when there is one`);
    }
    const key = `${row.model}@${row.from}`;
    assert.ok(!seen.has(key), `${key} is listed once`);
    seen.add(key);
    assert.ok(row.rates.input > 0 && row.rates.cachedInput > 0 && row.rates.output > 0, `${row.model}: every rate is a price`);
    assert.ok(row.rates.cachedInput < row.rates.input, `${row.model}: cached input is the cheaper kind`);
  }
  assert.equal(pricesReadOn(), OPENAI_PRICES.map((r) => r.readOn).sort().at(-1));
});

test('stored responses are priced again whenever the table changes, with no version to bump', async () => {
  const db = openDb(':memory:');
  await new CodexIngestor(db, home()).scan();
  const credits = () => Object.fromEntries((db.prepare('SELECT responseId, credits FROM codex_events').all() as any[]).map((r) => [r.responseId, r.credits]));
  assert.ok(Object.values(credits()).every((c) => c === null), 'stored before their model had a row');

  // A model gets its first row: what was stored before it is priced on the next start.
  const first = [TABLE[0]!];
  assert.equal(repriceCodexEvents(db, first), 4);
  assert.ok(Math.abs(credits().resp_fixture_0004 - (1_000 * 2 + 4_000 * 0.5 + 200 * 10) / 1e6) < 1e-12);
  assert.equal(repriceCodexEvents(db, first), 0, 'nothing to do while the table is the same');
  assert.equal(repriceCodexEvents(db, first.map((r) => ({ ...r, readOn: '2030-01-01', source: 'elsewhere' }))), 0, 'reading the page again changes no price');

  // A real price change, dated: only what ran after it moves.
  const was = credits();
  assert.equal(repriceCodexEvents(db, TABLE), 4);
  const now = credits();
  assert.equal(now.resp_fixture_0001, was.resp_fixture_0001, 'earlier responses keep the price they ran at');
  assert.ok(Math.abs(now.resp_fixture_0004 - (1_000 * 1 + 4_000 * 0.25 + 200 * 5) / 1e6) < 1e-12, 'later ones get the new one');
  assert.equal(now.resp_fixture_0003, null, 'the small model still has no row');
});

test('only a response that ran at Standard is priced; another tier, or none recorded, is not', async () => {
  const db = openDb(':memory:');
  const codexHome = mkdtempSync(join(tmpdir(), 'tokio-codex-tier-'));
  const dir = join(codexHome, 'sessions', '2026', '03', '04');
  mkdirSync(dir, { recursive: true });
  const record = (id: string, second: number) =>
    `{"timestamp":"2026-03-04T08:00:${String(second).padStart(2, '0')}.000Z","type":"token_usage_record","payload":{"thread_id":"thread-t","turn_id":"t1","response_id":"${id}","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":10}}}`;
  const settings = (tier: string | null) =>
    `{"timestamp":"2026-03-04T08:00:00.000Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread-t","thread_settings":{"model":"gpt-test-large"${tier === null ? '' : `,"service_tier":"${tier}"`}}}}`;
  writeFileSync(join(dir, 'rollout-2026-03-04T08-00-00-tier.jsonl'), [
    '{"timestamp":"2026-03-04T08:00:00.000Z","type":"session_meta","payload":{"id":"thread-t","cwd":"/home/test/t"}}',
    '{"timestamp":"2026-03-04T08:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-test-large","cwd":"/home/test/t"}}',
    record('resp_t0', 2),
    settings('default'),
    record('resp_t1', 3),
    settings('priority'),
    record('resp_t2', 4),
    settings(null),
    record('resp_t3', 5),
    '',
  ].join('\n'));
  await new CodexIngestor(db, codexHome).scan();
  repriceCodexEvents(db, TABLE);
  const rows = db.prepare('SELECT responseId, serviceTier, credits FROM codex_events ORDER BY ts').all() as any[];
  assert.deepEqual(rows.map((r) => r.serviceTier), [null, 'default', 'priority', null]);
  assert.deepEqual(rows.map((r) => r.credits !== null), [false, true, false, false]);
});

test('a corrected table re-prices history, each response at the row of its own date', async () => {
  const db = openDb(':memory:');
  await new CodexIngestor(db, home()).scan();
  repriceCodexEvents(db, TABLE, true);
  const rows = db.prepare('SELECT responseId, credits FROM codex_events ORDER BY ts').all() as any[];
  const byId = Object.fromEntries(rows.map((r) => [r.responseId, r.credits]));
  assert.ok(Math.abs(byId.resp_fixture_0001 - (2_000 * 2 + 10_000 * 0.5 + 300 * 10) / 1e6) < 1e-12, 'priced at the January row');
  assert.ok(Math.abs(byId.resp_fixture_0004 - (1_000 * 1 + 4_000 * 0.25 + 200 * 5) / 1e6) < 1e-12, 'priced at the March row');
  assert.equal(byId.resp_fixture_0003, null, 'the small model has no row at all');
});

test('undated usage and limit snapshots cannot become measurements for today', () => {
  for (const timestamp of [undefined, 'invalid']) {
    for (const [type, payload] of [
      ['token_usage_record', { response_id: 'r', usage: { input_tokens: 5 } }],
      ['event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 20, resets_in_seconds: 300 } } }],
    ]) assert.equal(parseCodexLine(JSON.stringify({ type, timestamp, payload })), null);
  }
});

test('a replacement at the same path replays from its own metadata even after restart', async () => {
  const db = openDb(':memory:');
  const dir = home();
  const [path] = await discoverRollouts(dir);
  const scan = () => new CodexIngestor(db, dir).scan([path!]);
  await scan();
  const contents = readFileSync(path!, 'utf8').replaceAll('resp_fixture_', 'resp_changed_').replaceAll('/widget', '/gadget');
  writeFileSync(path + '.new', contents);
  renameSync(path + '.new', path!);
  assert.equal(await scan(), 3);
  assert.equal(db.prepare("SELECT project FROM codex_events WHERE responseId = 'resp_changed_0001'").get()?.project, '/home/test/gadget');

  writeFileSync(path!, '{"type":"session_meta","payload":{"id":"short","cwd":"/short"}}\n');
  await scan();
  const row = db.prepare('SELECT threadId, cwd FROM codex_files WHERE path = ?').get(path!);
  assert.deepEqual({ ...row }, { threadId: 'short', cwd: '/short' });
});

test('a new turn without a model cannot inherit the previous turn’s model', async () => {
  const db = openDb(':memory:');
  const dir = home();
  const [file] = await discoverRollouts(dir);
  appendFileSync(file!, '{"type":"turn_context","payload":{"turn_id":"missing-model"}}\n');
  await new CodexIngestor(db, dir).scan();
  appendFileSync(file!, '{"timestamp":"2026-03-02T10:00:00Z","type":"token_usage_record","payload":{"response_id":"missing","turn_id":"missing-model","usage":{"input_tokens":5}}}\n');
  await new CodexIngestor(db, dir).scan();
  assert.equal(db.prepare("SELECT model FROM codex_events WHERE responseId = 'missing'").get()?.model, 'unknown');
});

test('the prefix filter accepts formatted JSON and late token_count discriminators', () => {
  const entry = { timestamp: '2026-03-02T09:00:12Z', type: 'event_msg', payload: {
    info: { unused: 'x'.repeat(1000) }, type: 'token_count', rate_limits: { primary: { used_percent: 33 } },
  } };
  const parsed = parseCodexLine(JSON.stringify(entry).replaceAll('":', '": '));
  assert.equal(parsed?.kind === 'limits' && parsed.reading.sessionPct, 33);
});

test('archiving and compressing an already counted rollout preserves one row per response', { skip: !zstdCompress }, async () => {
  const dir = home();
  const db = openDb(':memory:');
  await new CodexIngestor(db, dir).scan();
  const [original] = await discoverRollouts(dir);
  const archived = join(dir, 'archived_sessions', 'moved.jsonl.zst');
  mkdirSync(join(dir, 'archived_sessions'), { recursive: true });
  writeFileSync(archived, zstdCompress!(readFileSync(original!)));
  rmSync(original!);
  assert.equal(await new CodexIngestor(db, dir).scan(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_events').get()?.n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, 0);
});
