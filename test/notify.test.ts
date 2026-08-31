import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../src/notify/index.ts';
import { loadConfig } from '../src/config.ts';

test('a missing desktop notifier does not take the daemon down', async () => {
  // spawn reports ENOENT asynchronously, so this used to crash the process
  // *after* a job had finished — losing the run's result to a notification.
  const cfg = {
    ...loadConfig(),
    notify: { ntfyTopic: null, ntfyServer: 'https://ntfy.sh', telegramToken: null, telegramChatId: null, webhook: null, desktop: true },
  };
  await notify(cfg, { title: 'tokio test', body: 'should not throw' });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(true);
});

test('a broken webhook is reported, not thrown', async () => {
  const cfg = {
    ...loadConfig(),
    notify: { ntfyTopic: null, ntfyServer: 'https://ntfy.sh', telegramToken: null, telegramChatId: null, webhook: 'http://127.0.0.1:1/nope', desktop: false },
  };
  await notify(cfg, { title: 'tokio test', body: 'unreachable' });
  assert.ok(true);
});
