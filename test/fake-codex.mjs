#!/usr/bin/env node
// Stands in for the Codex CLI, so nothing in `npm test` spends a token or asks
// OpenAI anything under someone's login. Two of its commands are faked:
//
//   exec …        emits the `--json` event stream `codex exec` writes, and echoes
//                 its arguments and the prompt it read so a test can assert on them.
//   app-server    answers `initialize` and `account/rateLimits/read` over stdio.
//
// TOKIO_FAKE_CODEX picks a behaviour: ratelimit, crash, reconnect, noauth, hang.
// Node rather than a shell script for the reason fake-claude.mjs gives.

const argv = process.argv.slice(2);
const mode = process.env.TOKIO_FAKE_CODEX ?? '';
const say = (o) => {
  const line = JSON.stringify(o) + '\n';
  if (mode === 'disordered' && o?.result?.rateLimits) {
    process.stdout.write(line.slice(0, 7));
    setImmediate(() => process.stdout.write(line.slice(7)));
  } else process.stdout.write(line);
};
if (mode === 'check-home' && process.env.CODEX_HOME !== '/fixture/configured-home') process.exit(3);

if (argv[0] === 'app-server') {
  if (mode === 'stubborn') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.TOKIO_FAKE_PID_FILE, String(process.pid));
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    setInterval(() => {}, 10000);
    await new Promise(() => {});
  }
  if (mode === 'exit-early') {
    process.stderr.write('diagnostic '.repeat(3000) + '\nconnection closed\n', () => process.exit(2));
  } else if (mode === 'hang') {
    // Never answers, but still leaves when stdin closes, so a test that gives
    // up on it cannot leave an orphan behind.
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    setInterval(() => {}, 1 << 30);
  } else {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          if (mode === 'disordered') {
            say(null);
            say({ method: 'account/updated' });
            say({ id: 2, error: { message: 'unsolicited' } });
          }
          say({ id: message.id, result: { userAgent: 'fake-codex/0.0.0', codexHome: '/nowhere' } });
          say({ method: 'account/updated', params: {} });
        } else if (message.method === 'account/rateLimits/read') {
          if (mode === 'noauth') {
            say({ id: message.id, error: { code: -32600, message: 'not signed in with a ChatGPT account' } });
            continue;
          }
          const resetsAt = Number(process.env.TOKIO_FAKE_RESETS_AT ?? Math.floor(Date.now() / 1000) + 3600);
          say({
            id: message.id,
            result: {
              accountId: 'acct-fake-must-not-be-stored',
              rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: Number(process.env.TOKIO_FAKE_PCT ?? 42), windowDurationMins: 300, resetsAt },
                secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: resetsAt + 5 * 86400 },
                planType: 'plus',
                rateLimitReachedType: null,
              },
            },
          });
        }
      }
    });
    process.stdin.on('end', () => process.exit(0));
  }
} else {
  // `exec`: drain the prompt first, as the real CLI does when given `-`.
  let prompt = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (prompt += c));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  if (mode === 'silent') process.exit(0);
  if (mode !== 'no-thread') say({ type: 'thread.started', thread_id: 'fake-thread' });
  say({ type: 'turn.started' });

  if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
  if (mode === 'empty-failure') {
    say({ type: 'turn.failed' });
    process.exit(0);
  }
  if (mode === 'noisy-crash') {
    process.stderr.write('debug: rate limit monitor enabled\ninvalid directory\n');
    process.exit(1);
  }
  if (mode === 'crash') {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (mode === 'ratelimit' || mode === 'ratelimit-workspace') {
    // The second is the workspace form, whose code has no word boundary in
    // front of `usage_limit_reached`.
    const message = mode === 'ratelimit'
      ? "You've hit your usage limit. Upgrade to Pro, or try again at 11:00 PM."
      : 'workspace_member_usage_limit_reached: Request a limit increase from your owner to continue.';
    say({ type: 'error', message });
    say({ type: 'turn.failed', error: { message } });
    process.exit(1);
  }
  if (mode === 'reconnect') {
    // Transient, and recovered from: not a failure.
    say({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  }

  say({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } });
  say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `done: ${argv.join(' ')} | prompt: ${prompt.trim()}` } });
  say({
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 },
  });
}
