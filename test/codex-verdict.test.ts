import { composeTarget, dashboardProviders } from '../web/src/providers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexSources, expireCodexWindows, readCodexVerdict, tokens } from '../web/src/codexVerdict.ts';
import type { CodexStatus } from '../web/src/api.ts';

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

const empty = { responses: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, usd: null, unpriced: 0 };
const base: CodexStatus = {
  session: null, week: null, planType: 'plus', limitReached: null, lastResetAt: null, probe: null,
  tokens: { session: empty, week: empty, today: empty }, models: [], priced: false,
};
const window = (usedPct: number) => ({
  usedPct, resetsAt: Date.now() + 3_600_000, windowMinutes: 300, start: null, source: 'reported' as const,
  via: 'app-server' as const, readAt: Date.now(), ageMs: 0, stale: false,
});

test('no reading says so, rather than calling an unread window empty', () => {
  const v = readCodexVerdict(base, t);
  assert.equal(v.line, 'codex.verdict.none');
  assert.equal(v.pressure, 'ease');
});

test('the colour follows the same thresholds as Claude’s rings', () => {
  assert.equal(readCodexVerdict({ ...base, session: window(40) }, t).pressure, 'ease');
  assert.equal(readCodexVerdict({ ...base, session: window(70) }, t).pressure, 'tight');
  assert.equal(readCodexVerdict({ ...base, session: window(95) }, t).pressure, 'over');
});

test('a limit OpenAI flags as reached is red whatever the percentage says', () => {
  const v = readCodexVerdict({ ...base, session: window(20), limitReached: 'rate_limit_reached' }, t);
  assert.equal(v.line, 'codex.verdict.limit');
  assert.equal(v.pressure, 'over');
});

test('token counts read as magnitudes', () => {
  assert.equal(tokens(312), '312');
  assert.equal(tokens(860_400), '860k');
  assert.equal(tokens(1_240_000), '1.2M');
  assert.equal(tokens(73_872_126), '74M');
});

test('each window expires independently between dashboard polls', () => {
  const session = { ...window(25), readAt: 10, resetsAt: 20 };
  const week = { ...window(75), readAt: 5, via: 'rollout' as const, resetsAt: null, expiresAt: 30 };
  const s = { ...base, session, week, limitReached: 'limited' };
  assert.deepEqual(codexSources(s).map(({ kind, reading }) => [kind, reading.via]), [['session', 'app-server'], ['week', 'rollout']]);
  assert.equal(expireCodexWindows(s, 19).session?.usedPct, 25);
  assert.equal(expireCodexWindows(s, 20).session, null);
  assert.equal(expireCodexWindows(s, 20).limitReached, null);
  assert.equal(expireCodexWindows(s, 20).week?.usedPct, 75);
  assert.equal(expireCodexWindows(s, 30).week, null);
});

test('the verdict reports a full week and qualifies stale session usage', () => {
  assert.equal(readCodexVerdict({ ...base, session: window(12), week: window(100) }, t).line, 'codex.verdict.weekFull');
  assert.match(readCodexVerdict({ ...base, session: { ...window(12), stale: true } }, t).line, /codex.verdict.floor/);
});

test('switching agent or project cannot submit selections from the previous picker', () => {
  const folder = { provider: 'claude-code', path: '/project' };
  const model = { provider: 'claude-code', name: 'opus' };
  const session = { provider: 'claude-code', cwd: '/project', id: 'previous' };
  assert.deepEqual(composeTarget('codex', folder, model, session), { cwd: '', model: '', resume: '' });
  assert.equal(composeTarget('claude-code', { ...folder, path: '/different' }, model, session).resume, '');
  assert.equal(composeTarget('claude-code', folder, model, session).resume, 'previous');
});

test('an older daemon has Claude and no provider configuration control', () => {
  assert.deepEqual(dashboardProviders(undefined), { claude: true, codex: false, chosen: true, canChoose: false });
  assert.equal(dashboardProviders({ claude: false, codex: true, chosen: false }).canChoose, true);
});
