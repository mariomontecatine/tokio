import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDirs, type Config } from './config.ts';
import { resolvePlan, type PlanBasis } from './plans/detect.ts';
import type { Discovery } from './claudeCli.ts';

/**
 * What this installation can actually see, and what it cannot.
 *
 * Every number tokio shows has a reach, and they are not the same. The gauges
 * come from Anthropic through `claude -p "/usage"` and describe the whole
 * account. Everything priced — payback, burn rate, the heatmap — is
 * reconstructed from transcripts, and transcripts only exist where the work was
 * done. Someone who also uses claude.ai in a browser, or a second computer, has
 * spend that no reading here can recover.
 *
 * That gap is already respected in the metering. It has never been said to the
 * person reading the numbers, and a figure that quietly means less than it
 * appears to is exactly what this project claims not to ship.
 *
 * This is deliberately a set of facts rather than a verdict. The interface
 * decides how to phrase them; inventing a severity here would put a judgement
 * in the daemon that belongs in the words.
 */
export interface Reach {
  claude: {
    /** How Claude Code was found, or that it was not. */
    how: Discovery['how'] | 'configured' | 'unknown';
    /** The command, once resolved. Null when nothing was found. */
    bin: string | null;
    /** Reached through a launcher — WSL, a shim, an ssh hop. */
    launched: boolean;
  };
  /**
   * Every directory being read, not one. A machine with Claude Code installed
   * twice has two, and saying "this machine" while naming one of them would be
   * the same half-truth this file exists to remove.
   */
  transcripts: {
    /** The directory, spelled the way this machine opens it. */
    dir: string;
    exists: boolean;
    /** How many project directories are in it. Zero is a real answer. */
    projects: number;
    /** True when it is reached across a filesystem boundary. */
    remote: boolean;
  }[];
  plan: {
    /**
     * Null whenever the basis is `unknown`.
     *
     * `resolvePlan` still answers 'pro' in that case, because something has to
     * be drawn on the gauges before the first reading — but that is a default
     * for arithmetic, not a fact about the account. Passing it on here would
     * put "Pro" in front of someone whose plan nobody has established, which is
     * the one thing this file exists to avoid.
     */
    id: string | null;
    basis: PlanBasis;
  };
}

/**
 * Counting the project directories rather than the transcripts inside them.
 *
 * One `readdir` instead of a walk: over the WSL bridge each entry is a round
 * trip, and this runs on a request. The question being answered is "is there
 * anything here at all", which the top level answers.
 */
function countProjects(dir: string): number {
  try {
    return readdirSync(join(dir, 'projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export function computeReach(cfg: Config, how: Reach['claude']['how']): Reach {
  const plan = resolvePlan(cfg);
  const launched = (cfg.claudeLauncher ?? []).length > 0;

  return {
    claude: {
      how,
      bin: how === 'unknown' ? null : cfg.claudeBin,
      launched,
    },
    transcripts: claudeDirs(cfg).map((dir) => ({
      dir,
      exists: existsSync(dir),
      projects: countProjects(dir),
      // A UNC path is another filesystem: on Windows that is the WSL bridge,
      // which is both slower and a sign that the CLI lives on the far side.
      remote: /^\\\\/.test(dir),
    })),
    plan: { id: plan.basis === 'unknown' ? null : plan.plan, basis: plan.basis },
  };
}
