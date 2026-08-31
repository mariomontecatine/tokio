import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEntry } from '../src/ingest/parse.ts';
import { tailFile } from '../src/ingest/tail.ts';
import { projectPathOf, unslugProject } from '../src/ingest/discover.ts';
import { creditsFor, familyOf } from '../src/meter/weights.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'transcript.jsonl');
const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

test('a streamed response repeated in the transcript is one billable event', () => {
  const usage = lines.map((l) => parseEntry(l, '/repo/demo')).filter((p) => p?.kind === 'usage');
  assert.equal(usage.length, 5, 'every copy is parsed');
  const unique = new Set(usage.map((u: any) => `${u.event.messageId}:${u.event.requestId}`));
  assert.equal(unique.size, 3, 'but they collapse to three distinct responses');
});

test('tool results do not start a new turn', () => {
  const turns = lines.map((l) => parseEntry(l, '/repo/demo')).filter((p) => p?.kind === 'turn');
  assert.deepEqual(turns.map((t: any) => t.promptId), ['p-1', 'p-2']);
});

test('cache tiers are priced apart', () => {
  const oneHour = creditsFor({ inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000, cacheRead: 0 }, 'opus');
  const fiveMin = creditsFor({ inputTokens: 0, outputTokens: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0, cacheRead: 0 }, 'opus');
  const read = creditsFor({ inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000 }, 'opus');
  assert.equal(oneHour, 30);
  assert.equal(fiveMin, 18.75);
  assert.equal(read, 1.5);
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
