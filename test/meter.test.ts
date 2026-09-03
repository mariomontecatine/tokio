import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocks, activeBlock, floorToHour, HOUR } from '../src/meter/blocks.ts';
import { weekStart } from '../src/meter/weekly.ts';
import { openDb } from '../src/db.ts';
import { addAnchor, addCeiling, resolveCap, rememberReading } from '../src/plans/calibrate.ts';
import { loadConfig } from '../src/config.ts';

const at = (iso: string, credits = 1, family: 'opus' | 'sonnet' = 'opus') => ({ ts: Date.parse(iso), credits, family });

test('a block is anchored to the hour its first message landed in', () => {
  const [block] = buildBlocks([at('2026-08-20T10:37:00Z')]);
  assert.equal(block!.start, floorToHour(Date.parse('2026-08-20T10:37:00Z')));
  assert.equal(block!.end - block!.start, 5 * HOUR);
});

test('messages inside five hours stay in one block', () => {
  const blocks = buildBlocks([at('2026-08-20T10:00:00Z'), at('2026-08-20T12:30:00Z'), at('2026-08-20T14:59:00Z')]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.events, 3);
});

test('a message past the window opens the next block', () => {
  const blocks = buildBlocks([at('2026-08-20T10:00:00Z'), at('2026-08-20T15:30:00Z')]);
  assert.equal(blocks.length, 2);
});

test('going quiet for a day leaves the blocks separate', () => {
  const blocks = buildBlocks([at('2026-08-20T06:00:00Z'), at('2026-08-21T06:00:00Z')]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.events, 1);
});

test('opus spend is tracked separately from the rest', () => {
  const [block] = buildBlocks([at('2026-08-20T10:00:00Z', 3, 'opus'), at('2026-08-20T10:10:00Z', 7, 'sonnet')]);
  assert.equal(block!.credits, 10);
  assert.equal(block!.opusCredits, 3);
});

test('an expired block gives way to an empty one', () => {
  const blocks = buildBlocks([at('2026-08-20T10:00:00Z')]);
  const now = Date.parse('2026-08-20T20:00:00Z');
  const active = activeBlock(blocks, now);
  assert.equal(active.credits, 0);
  assert.ok(active.end > now);
});

test('the weekly anchor lands on the most recent occurrence', () => {
  const now = Date.parse('2026-08-20T15:00:00');       // a Thursday
  const start = weekStart(now, { weekday: 3, hour: 11 }); // Wednesday 11:00
  assert.equal(new Date(start).getDay(), 3);
  assert.ok(start < now && now - start < 7 * 24 * HOUR);
});

test('a percentage read off /usage pins the real cap', () => {
  const db = openDb(':memory:');
  const cfg = loadConfig();
  assert.equal(resolveCap(db, cfg, 'block').basis, 'default');
  addAnchor(db, 'block', 40, 20);
  const cap = resolveCap(db, cfg, 'block');
  assert.equal(cap.credits, 50);
  assert.equal(cap.basis, 'calibrated');
});

test('several readings are reduced to their median', () => {
  const db = openDb(':memory:');
  const cfg = loadConfig();
  addAnchor(db, 'block', 50, 40);   // 80
  addAnchor(db, 'block', 50, 45);   // 90
  addAnchor(db, 'block', 50, 50);   // 100
  assert.equal(resolveCap(db, cfg, 'block').credits, 90);
});

test('a limit we actually hit raises a too-low default', () => {
  const db = openDb(':memory:');
  const cfg = { ...loadConfig(), plan: 'pro' as const };
  addCeiling(db, 'block', 999);
  const cap = resolveCap(db, cfg, 'block');
  assert.equal(cap.credits, 999);
  assert.equal(cap.basis, 'calibrated');
});

test('nonsense percentages are refused', () => {
  const db = openDb(':memory:');
  assert.throws(() => addAnchor(db, 'block', 0, 10), /between 0 and 100/);
  assert.throws(() => addAnchor(db, 'block', 50, 0), /run something first/);
});

test('a reported percentage is remembered, so a shipped guess stops being consulted', () => {
  const db = openDb(':memory:');
  const cfg = loadConfig();
  assert.equal(resolveCap(db, cfg, 'block').basis, 'default', 'nothing read yet');

  // What /usage states several times an hour: a real percentage against real spend.
  rememberReading(db, 'block', 40, 10, Date.now());
  const cap = resolveCap(db, cfg, 'block');
  assert.equal(cap.basis, 'calibrated');
  assert.equal(cap.credits, 25, '$10 at 40% is a $25 window');
});

test('an early percentage is too unstable to divide by', () => {
  const db = openDb(':memory:');
  // A whole-number 2% could be anything from 1.5 to 2.5 — a quarter off.
  rememberReading(db, 'block', 2, 1, Date.now());
  assert.equal(resolveCap(db, loadConfig(), 'block').basis, 'default');
});

test('readings are not recorded faster than the percentage moves', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  rememberReading(db, 'block', 40, 10, now);
  rememberReading(db, 'block', 41, 11, now + 60_000);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE windowKind = 'block'").get() as { n: number };
  assert.equal(rows.n, 1, 'a minute later is the same reading');

  rememberReading(db, 'block', 60, 15, now + 40 * 60_000);
  const later = db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE windowKind = 'block'").get() as { n: number };
  assert.equal(later.n, 2, 'half an hour later is a new one');
});
