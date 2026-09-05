import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Job, Safety } from '../types.ts';
import type { Provider, RunContext, RunResult } from './types.ts';
import type { Config } from '../config.ts';
import { effectiveModel } from '../models.ts';
import { claudeInvocation } from '../claudeCli.ts';

/** Claude Code's `--permission-mode` value for each of our safety levels. */
const PERMISSION_MODE: Record<Safety, string | null> = {
  plan: 'plan',
  edits: 'acceptEdits',
  // bypassPermissions is only accepted alongside the explicit dangerous flag.
  full: null,
};

const RATE_LIMIT_PATTERNS = [
  /usage limit reached/i,
  /rate.?limit/i,
  /limit will reset/i,
  /out of (?:tokens|usage)/i,
  /quota (?:exceeded|reached)/i,
];

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

export function buildArgs(job: Job, cfg: Config): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  const model = job.model ?? effectiveModel(cfg);
  if (model) args.push('--model', model);
  if (job.safety === 'full') args.push('--dangerously-skip-permissions');
  else {
    const mode = PERMISSION_MODE[job.safety];
    if (mode) args.push('--permission-mode', mode);
  }
  if (job.resumeSessionId) args.push('--resume', job.resumeSessionId);
  return args;
}

interface StreamState {
  text: string[];
  sessionId: string | null;
  credits: number | null;
  isError: boolean;
  errorText: string | null;
}

function consumeLine(line: string, state: StreamState, onChunk?: (t: string) => void): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.session_id && !state.sessionId) state.sessionId = String(msg.session_id);

  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const part of msg.message.content) {
      if (part?.type === 'text' && part.text) {
        state.text.push(part.text);
        onChunk?.(part.text);
      }
    }
  } else if (msg.type === 'result') {
    if (typeof msg.total_cost_usd === 'number') state.credits = msg.total_cost_usd;
    if (msg.is_error) state.isError = true;
    if (typeof msg.result === 'string') {
      state.errorText = msg.is_error ? msg.result : state.errorText;
      if (!msg.is_error && !state.text.length) state.text.push(msg.result);
    }
    if (typeof msg.subtype === 'string' && msg.subtype !== 'success') state.isError = true;
  }
}

export function createClaudeCodeProvider(cfg: Config): Provider {
  return {
    id: 'claude-code',
    label: 'Claude Code (subscription)',

    async available() {
      // A path is only checkable when it is a path on *this* filesystem.
      //
      // Two ways it is not. A launcher means `claudeBin` is resolved on the far
      // side of it — inside WSL, inside a container — where a Windows
      // `existsSync` has nothing to say and would fail a perfectly good setup.
      // And the separator test was `/` alone, which never matches a Windows
      // path, so an absolute one there went unchecked instead of being caught
      // before the spawn.
      const launched = (cfg.claudeLauncher ?? []).length > 0;
      const looksLikePath = cfg.claudeBin.includes('/') || cfg.claudeBin.includes('\\');
      if (!launched && looksLikePath && !existsSync(cfg.claudeBin)) {
        return { ok: false, reason: `claude binary not found at ${cfg.claudeBin}` };
      }
      return { ok: true };
    },

    estimate() {
      return null; // The shared estimator handles this; see estimator/predict.ts.
    },

    execute(job: Job, ctx: RunContext): Promise<RunResult> {
      return new Promise((resolve) => {
        const { cmd, argv } = claudeInvocation(cfg, buildArgs(job, cfg));
        const child = spawn(cmd, argv, {
          cwd: job.cwd,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const state: StreamState = { text: [], sessionId: null, credits: null, isError: false, errorText: null };
        let stderr = '';
        let buffer = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        }, ctx.timeoutMs);

        const onAbort = () => child.kill('SIGTERM');
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) consumeLine(line, state, ctx.onChunk);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        const finish = (code: number | null, spawnError?: Error) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          if (buffer.trim()) consumeLine(buffer, state, ctx.onChunk);

          const output = state.text.join('');
          const failed = Boolean(spawnError) || timedOut || state.isError || (code !== 0 && code !== null);
          // Only a failed run can be rate limited, and only its error channels
          // count: an assistant that merely writes the words "rate limit" in a
          // successful answer must not be mistaken for one that hit the wall.
          const rateLimited = failed && looksRateLimited(`${stderr}\n${state.errorText ?? ''}`);

          resolve({
            ok: !failed,
            rateLimited,
            credits: state.credits,
            sessionId: state.sessionId,
            output,
            error: spawnError
              ? spawnError.message
              : timedOut
                ? `timed out after ${Math.round(ctx.timeoutMs / 60000)} min`
                : failed
                  ? (state.errorText ?? stderr.trim() ?? `claude exited with code ${code}`)
                  : null,
          });
        };

        child.on('error', (err) => finish(null, err));
        child.on('close', (code) => finish(code));

        child.stdin.end(job.prompt);
      });
    },
  };
}
