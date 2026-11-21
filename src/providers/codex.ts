import { isAbsolute, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Job, Safety } from '../types.ts';
import type { Provider, RunContext, RunResult } from './types.ts';
import type { Config } from '../config.ts';
import { codexInvocation } from '../codex/cli.ts';

export const CODEX_PROVIDER_ID = 'codex';

/**
 * Codex's sandbox for each of our safety levels.
 *
 * `codex exec` never stops to ask — its approval policy is `never` — so the
 * sandbox is the whole of the leash, and these are the three it has.
 */
export const CODEX_SANDBOX: Record<Safety, string> = {
  plan: 'read-only',
  edits: 'workspace-write',
  full: 'danger-full-access',
};

/**
 * `codex exec` arguments for a job.
 *
 * Every option goes before the `resume` subcommand. Its help lists neither
 * `--sandbox` nor `--cd`, and they are accepted there all the same and applied
 * to the resumed turn — verified against 0.168 with a throwaway CODEX_HOME and a
 * model provider pointed at a closed port, so no token was spent: a thread
 * created as `danger-full-access` and resumed with `-s read-only` wrote
 * `read-only` into the new turn's context. A resume with no flag at all got the
 * configured default rather than the thread's own sandbox, which is why the
 * flag is always passed rather than left to inherit.
 *
 * The prompt goes over stdin, as Claude's does: `-` says so, and `resume`
 * needs it spelled out after the session id.
 *
 * `--skip-git-repo-check` is deliberately not passed. Codex refuses to run
 * outside a repository it trusts, and that is its safeguard to lift, not ours;
 * a job in such a folder fails and says why.
 */
export function buildCodexArgs(job: Job): string[] {
  const args = ['exec', '--json', '--sandbox', CODEX_SANDBOX[job.safety], '--cd', isAbsolute(job.cwd) ? job.cwd : resolvePath(job.cwd)];
  if (job.model) args.push('--model', job.model);
  if (job.resumeSessionId) args.push('resume', job.resumeSessionId, '-');
  else args.push('-');
  return args;
}

interface StreamState {
  text: string[];
  threadId: string | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  failed: boolean;
  errorText: string | null;
}

/**
 * One line of `codex exec --json`.
 *
 * The event names were read out of the 0.168 binary and the failure half has
 * been seen in a real run; a successful run has not been watched here, so the
 * parser takes only what it needs and ignores everything else.
 */
function consumeLine(line: string, state: StreamState, onChunk?: (t: string) => void): void {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  switch (event?.type) {
    case 'thread.started':
      if (typeof event.thread_id === 'string') state.threadId = event.thread_id;
      break;
    case 'item.completed':
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        state.text.push(event.item.text);
        onChunk?.(event.item.text);
      }
      break;
    case 'turn.completed': {
      const u = event.usage ?? {};
      const add = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
      state.usage = {
        inputTokens: (state.usage?.inputTokens ?? 0) + add(u.input_tokens),
        cachedInputTokens: (state.usage?.cachedInputTokens ?? 0) + add(u.cached_input_tokens),
        outputTokens: (state.usage?.outputTokens ?? 0) + add(u.output_tokens),
      };
      break;
    }
    case 'turn.failed':
      state.failed = true;
      if (typeof event.error?.message === 'string') state.errorText = event.error.message;
      break;
    case 'error':
      // Also used for "Reconnecting…", which Codex recovers from. Kept as the
      // explanation in case the run does fail, never as the failure itself.
      if (typeof event.message === 'string' && !/^Reconnecting(?:\.{3}|…)/i.test(event.message)) state.errorText = event.message;
      break;
  }
}

/**
 * Codex's own wording when the plan's limit is the reason, as the 0.168 binary
 * spells it: "Usage limit reached", "You've reached your usage limit", "You've
 * hit your usage limit", and the error codes behind them — including the
 * workspace ones, whose codes end in `usage_limit_reached` without a word
 * boundary in front. Phrases, not words: a log line that merely mentions rate
 * limits must not turn an ordinary failure into a wait for the reset.
 */
const CODEX_LIMIT = /(?:hit (?:your|the) usage limit|reached (?:your|the) usage limit|usage limit (?:reached|exceeded)|rate limit (?:reached|exceeded)|usage_limit_reached|credits_depleted|quota_exceeded)/i;

export function createCodexProvider(cfg: Config): Provider {
  return {
    id: CODEX_PROVIDER_ID,
    label: 'Codex (ChatGPT plan)',

    async available() {
      const launched = (cfg.codexLauncher ?? []).length > 0;
      const looksLikePath = cfg.codexBin.includes('/') || cfg.codexBin.includes('\\');
      if (!launched && looksLikePath) {
        try { await access(cfg.codexBin); } catch {
          return { ok: false, reason: `codex binary not found at ${cfg.codexBin}` };
        }
      }
      return { ok: true };
    },

    estimate() {
      // There is no history to estimate from in dollars without a price, and a
      // Codex window has no cap tokio could express one against.
      return null;
    },

    execute(job: Job, ctx: RunContext): Promise<RunResult> {
      if (ctx.signal?.aborted) return Promise.resolve({ ok: false, rateLimited: false, credits: null, sessionId: null, output: '', error: 'Codex job aborted' });
      return new Promise((resolve) => {
        const { cmd, argv } = codexInvocation(cfg, buildCodexArgs(job));
        const child = spawn(cmd, argv, { cwd: job.cwd, env: cfg.codexHome ? { ...process.env, CODEX_HOME: cfg.codexHome } : process.env });

        const state: StreamState = { text: [], threadId: null, usage: null, failed: false, errorText: null };
        let stderr = '';
        let buffer = '';
        let timedOut = false;

        const terminate = () => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, ctx.timeoutMs);
        const onAbort = terminate;
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
          if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
        });

        let finished = false;
        const finish = (code: number | null, spawnError?: Error, signal?: NodeJS.Signals | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          if (buffer.trim()) consumeLine(buffer, state, ctx.onChunk);

          const failed = Boolean(spawnError) || timedOut || ctx.signal?.aborted || state.failed || code !== 0 || !state.usage;
          // Only a failed run can be rate limited, and only from what it said
          // about the failure — an answer that talks about rate limits is not one.
          const said = state.errorText || stderr.trim().split('\n').pop() || '';
          const rateLimited = failed && !timedOut && !ctx.signal?.aborted && CODEX_LIMIT.test(said);
          // Never priced from here. What exec reports is the turn's total, and
          // OpenAI prices each request on its own: past 272K input tokens the
          // whole request costs more, which a sum of requests cannot show, and
          // the service tier that decides whether it is priced at all is not
          // in these events. The rollout has both, per response.
          const credits = null;

          let error = null;
          if (spawnError) error = spawnError.message;
          else if (timedOut) error = `timed out after ${Math.round(ctx.timeoutMs / 60000)} min`;
          else if (ctx.signal?.aborted) error = 'Codex job aborted';
          else if (failed) {
            error = state.errorText || stderr.trim();
            if (!error && signal) error = `codex terminated by signal ${signal}`;
            if (!error && state.failed) error = 'Codex turn failed';
            if (!error) error = code === 0 ? 'Codex exited without completing the turn' : `codex exited with code ${code}`;
          }
          resolve({
            ok: !failed, rateLimited, credits, sessionId: state.threadId,
            output: state.text.join('\n\n'), error,
          });
        };

        child.on('error', (err) => finish(null, err));
        child.on('close', (code, signal) => finish(code, undefined, signal));
        child.stdin.on('error', () => { /* close reports an early exit */ });
        child.stdin.end(job.prompt);
      });
    },
  };
}
