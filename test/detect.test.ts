import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { detectPlan, resolvePlan } from '../src/plans/detect.ts';

/** A throwaway Claude config directory holding the account block under test. */
function withAccount(account: Record<string, unknown> | null): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tokio-account-'));
  if (account) writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: account }));
  return { ...loadConfig(), claudeConfigDir: dir, plan: 'auto' };
}

test('Pro is read straight off the account', () => {
  const cfg = withAccount({ organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai' });
  assert.equal(detectPlan(cfg)?.plan, 'pro');
  assert.deepEqual(resolvePlan(cfg), {
    plan: 'pro',
    basis: 'detected',
    evidence: 'claude_pro · default_claude_ai',
  });
});

test('the rate limit tier is what separates Max 5x from Max 20x', () => {
  const five = withAccount({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' });
  const twenty = withAccount({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' });
  assert.equal(detectPlan(five)?.plan, 'max5');
  assert.equal(detectPlan(twenty)?.plan, 'max20');
});

test('Max with no tier is left undetermined rather than guessed', () => {
  // The two Max plans differ by half in both price and limits, so a coin flip
  // here would put a wrong price under every figure that follows.
  const cfg = withAccount({ organizationType: 'claude_max' });
  assert.equal(detectPlan(cfg), null);
  assert.equal(resolvePlan(cfg).basis, 'unknown');
});

test('Team and Enterprise do not map onto a personal plan', () => {
  for (const type of ['team', 'enterprise']) {
    assert.equal(detectPlan(withAccount({ organizationType: type })), null, type);
  }
});

test('a missing or unreadable account is a normal state, not an error', () => {
  assert.equal(detectPlan(withAccount(null)), null);
  const broken = withAccount({});
  writeFileSync(join(broken.claudeConfigDir!, '.claude.json'), 'not json at all');
  assert.equal(detectPlan(broken), null);
});

test('a plan you set by hand is never overridden by detection', () => {
  const cfg: Config = { ...withAccount({ organizationType: 'claude_pro' }), plan: 'max20' };
  assert.deepEqual(resolvePlan(cfg), { plan: 'max20', basis: 'configured', evidence: null });
});

test('the account file beside a .claude directory is the same installation', () => {
  // The layout of a Claude Code install nobody reconfigured: transcripts in
  // ~/.claude, the account file next to it in the home directory. Reached from
  // Windows over \wsl.localhost this is the ordinary case, not an exotic one,
  // and reading only inside the directory found nothing — the plan came back
  // unknown and the payback silently disappeared.
  const home = mkdtempSync(join(tmpdir(), 'tokio-home-'));
  const dir = join(home, '.claude');
  mkdirSync(dir);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' } }),
  );

  const cfg: Config = { ...loadConfig(), claudeConfigDir: dir, plan: 'auto' };
  assert.equal(detectPlan(cfg)?.plan, 'max20');
});

test('inside the directory still wins over beside it', () => {
  // CLAUDE_CONFIG_DIR is where Claude Code puts the file when one is set, so
  // that stays the first answer when both exist.
  const home = mkdtempSync(join(tmpdir(), 'tokio-home-'));
  const dir = join(home, '.claude');
  mkdirSync(dir);
  const acct = (tier: string) => JSON.stringify({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: tier } });
  writeFileSync(join(dir, '.claude.json'), acct('default_claude_max_5x'));
  writeFileSync(join(home, '.claude.json'), acct('default_claude_max_20x'));

  const cfg: Config = { ...loadConfig(), claudeConfigDir: dir, plan: 'auto' };
  assert.equal(detectPlan(cfg)?.plan, 'max5');
});

test('a configured directory never reaches for an unrelated account', () => {
  // The rule the single-candidate list exists to keep: a directory not named
  // .claude has no sibling account file to claim, so nothing is read from a
  // parent nobody pointed us at.
  const home = mkdtempSync(join(tmpdir(), 'tokio-home-'));
  const dir = join(home, 'somewhere-else');
  mkdirSync(dir);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai' } }));

  const cfg: Config = { ...loadConfig(), claudeConfigDir: dir, plan: 'auto' };
  assert.equal(detectPlan(cfg), null);
});
