import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, runDetached } from '../src/notify/index.ts';
import { loadConfig, type Config } from '../src/config.ts';

/**
 * Never with `desktop: true`.
 *
 * These run on somebody's actual machine, and a desktop notifier that works is
 * a notifier that pops a real notification at whoever is running the suite —
 * which is exactly what happened once the notifier stopped being Linux-only.
 * The crash-safety it used to cover is tested directly below instead.
 */
const quiet = (over: Partial<Config['notify']> = {}): Config => ({
  ...loadConfig(),
  notify: {
    ntfyTopic: null,
    ntfyServer: 'https://ntfy.sh',
    telegramToken: null,
    telegramChatId: null,
    webhook: null,
    desktop: false,
    ...over,
  },
});

test('a missing binary does not take the daemon down', async () => {
  // spawn reports ENOENT asynchronously, so an unhandled one used to crash the
  // process *after* a job had finished — losing the run's result to a
  // notification. Pointed at a name no system has, so the result is the same
  // everywhere and nothing is shown to anyone.
  runDetached('tokio-no-such-notifier-9f3a', ['ignored']);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(true, 'still running');
});

test('a broken webhook is reported, not thrown', async () => {
  await notify(quiet({ webhook: 'http://127.0.0.1:1/nope' }), { title: 'tokio test', body: 'unreachable' });
  assert.ok(true);
});

test('with every channel off, notifying is a no-op', async () => {
  await notify(quiet(), { title: 'tokio test', body: 'nowhere to go' });
  assert.ok(true);
});
