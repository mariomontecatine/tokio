import { spawn } from 'node:child_process';
import type { Config } from '../config.ts';
import { codexInvocation } from './cli.ts';
import { readingFromSnapshot, type CodexReading } from './parse.ts';

/**
 * Ask Codex itself what OpenAI says about the limits, without running a turn.
 *
 * `codex app-server` speaks JSON-RPC over stdio, and `account/rateLimits/read`
 * is the read its own interface uses for the usage screen: it reaches OpenAI
 * with Codex's own login and returns the percentages and reset times of the
 * five-hour and weekly windows. No model is called, so nothing is spent —
 * measured on the machine this was written on at under a second, zero turns.
 * It is the Codex counterpart of `claude -p "/usage"`.
 *
 * tokio never touches the credentials. Codex authenticates itself, exactly as
 * it does when you run it, and what comes back is kept down to the numbers:
 * the response also carries an account id, which is not stored or logged.
 *
 * The method is marked experimental by Codex. Anything unexpected — an older
 * CLI without it, an API-key login with no plan, a timeout — is a reading with
 * an error rather than an exception, and the rollouts' own readings stand in.
 *
 * The protocol is JSON-RPC 2.0 with the `jsonrpc` field left out, one message
 * per line: `initialize`, the `initialized` notification, then the read.
 */
export function probeCodexLimits(cfg: Pick<Config, 'codexBin' | 'codexLauncher'> & { codexHome?: string | null }, timeoutMs = 20_000, signal?: AbortSignal): Promise<CodexReading> {
  return new Promise((resolve) => {
    const failed = (error: string): CodexReading => ({
      at: Date.now(), via: 'app-server', limitId: '', sessionPct: null, sessionResetsAt: null, sessionMinutes: null,
      weekPct: null, weekResetsAt: null, weekMinutes: null, planType: null, limitReached: null, error,
    });

    if (signal?.aborted) return resolve(failed('Codex probe stopped'));
    const { cmd, argv } = codexInvocation(cfg, ['app-server']);
    // stdio defaults to three pipes; a missing binary arrives as an `error` event.
    const child = spawn(cmd, argv, { env: cfg.codexHome ? { ...process.env, CODEX_HOME: cfg.codexHome } : process.env });

    let settled = false;
    let expectedId = 1;
    let buffer = '';
    let stderr = '';
    const done = (reading: CodexReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      // Closing stdin is how the server is told to go; this is in case it does not.
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      resolve(reading);
    };
    const timer = setTimeout(() => done(failed('timed out asking Codex for its limits')), timeoutMs);
    const abort = () => done(failed('Codex probe stopped'));
    signal?.addEventListener('abort', abort, { once: true });
    const send = (message: object) => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch {
        // The process is gone; `close` reports it.
      }
    };

    child.stdin.on('error', (err) => done(failed(err.message)));
    child.on('error', (err) => done(failed(err.message)));
    child.on('close', (code) => done(failed(stderr.trim().split('\n').pop() || `codex app-server exited with code ${code}`)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (settled || message?.id !== expectedId || message.method) continue;
        if (message.id === 1) {
          expectedId = 2;
          if (message.error) return done(failed(String(message.error.message ?? 'initialize failed')));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (message.id === 2) {
          if (message.error) return done(failed(String(message.error.message ?? 'account/rateLimits/read failed')));
          const reading = readingFromSnapshot(message.result?.rateLimits, Date.now(), 'app-server');
          return done(reading ?? failed('Codex answered without any limits — is it signed in with a ChatGPT plan?'));
        }
        // Notifications (account/updated and the like) are not ours to act on.
      }
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tokio', title: 'tokio', version: '0.1.0' } } });
  });
}
