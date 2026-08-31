import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageText, parseResetTime } from '../src/usage/probe.ts';

const REAL = `You are currently using your subscription to power your Claude Code usage

Current session: 69% used · resets Sep 1, 1:19am (Europe/Madrid)
Current week (all models): 27% used · resets Sep 5, 8:59pm (Europe/Madrid)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 139 requests · 3 sessions
  43% of your usage was at >150k context`;

test('it reads the real percentages and resets out of /usage', () => {
  const p = parseUsageText(REAL);
  assert.equal(p.sessionPct, 69);
  assert.equal(p.weekPct, 27);
  assert.equal(p.opusPct, null, 'this plan reports no separate Opus allowance');
  assert.ok(p.sessionResetsAt && p.weekResetsAt);
  assert.ok(p.weekResetsAt! > p.sessionResetsAt!);
});

test('an Opus allowance is picked up when the plan has one', () => {
  const p = parseUsageText(`${REAL}\nCurrent week (Opus): 41% used · resets Sep 5, 8:59pm (Europe/Madrid)`);
  assert.equal(p.opusPct, 41);
});

test('output with no percentages parses to nulls rather than guesses', () => {
  const p = parseUsageText('You are using an API key. Usage limits do not apply.');
  assert.equal(p.sessionPct, null);
  assert.equal(p.weekPct, null);
});

test('reset times are read without a year and placed in the future', () => {
  const now = Date.parse('2026-08-31T23:00:00');
  const at = parseResetTime('Sep 1, 1:19am (Europe/Madrid)', now)!;
  const d = new Date(at);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 1);
  assert.equal(d.getMinutes(), 19);
  assert.ok(at > now);
});

test('a reset that crosses new year lands in the following one', () => {
  const now = Date.parse('2026-12-31T23:30:00');
  const at = parseResetTime('Jan 1, 2:00am', now)!;
  assert.equal(new Date(at).getFullYear(), 2027);
});

test('midnight and noon are not confused', () => {
  const now = Date.parse('2026-08-31T10:00:00');
  assert.equal(new Date(parseResetTime('Sep 1, 12:00am', now)!).getHours(), 0);
  assert.equal(new Date(parseResetTime('Sep 1, 12:00pm', now)!).getHours(), 12);
  assert.equal(new Date(parseResetTime('Sep 1, 9pm', now)!).getHours(), 21);
});

test('an unparseable time is refused instead of guessed', () => {
  assert.equal(parseResetTime('sometime soon'), null);
  assert.equal(parseResetTime('Xxx 40, 99:99am'), null);
});
