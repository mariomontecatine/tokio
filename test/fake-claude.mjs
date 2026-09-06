#!/usr/bin/env node
// Stands in for the real CLI so the queue can be tested without spending tokens.
// Echoes the arguments it was given so the test can assert on them.
//
// Node rather than a shell script: Windows cannot spawn a `.sh` at all — it
// fails with EFTYPE, because a file is only executable there if something knows
// how to run it — and the suite has to pass on every platform tokio runs on.
// The interpreter goes in front of it through `claudeLauncher`, the same vector
// that reaches Claude Code inside WSL, so the fixture exercises that path too.

const args = process.argv.slice(2).join(' ');
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Drain the prompt on stdin: the executor writes it there and waits, and the
// real CLI reads it. Resolving on `error` as well keeps a closed or absent
// stdin from hanging the process instead of failing the test.
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', resolve);
  process.stdin.on('error', resolve);
});

say({ type: 'system', subtype: 'init', session_id: 'fake-session', args });

if (process.env.TOKIO_FAKE_MODE === 'ratelimit') {
  say({
    type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'fake-session',
    result: 'Claude usage limit reached. Your limit will reset at 11pm.',
  });
  process.exit(1);
}

if (process.env.TOKIO_FAKE_MODE === 'crash') {
  process.stderr.write('boom\n');
  process.exit(3);
}

say({
  type: 'assistant', session_id: 'fake-session',
  message: { content: [{ type: 'text', text: 'done: tests pass' }] },
});
say({
  type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session',
  total_cost_usd: 2.5, result: 'done: tests pass',
});
