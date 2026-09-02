import { networkInterfaces, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** This machine's first non-loopback IPv4, for the URL another host would use. */
export function lanAddress(): string | null {
  for (const net of Object.values(networkInterfaces()).flat()) {
    if (net && net.family === 'IPv4' && !net.internal) return net.address;
  }
  return null;
}

/** The address a browser should open, carrying the token when one is needed. */
export function dashboardUrl(cfg: Config): string {
  const host = cfg.host === '0.0.0.0' ? (lanAddress() ?? '127.0.0.1') : cfg.host;
  const query = cfg.token && !isLoopback(host) ? `/?token=${cfg.token}` : '';
  return `http://${host}:${cfg.port}${query}`;
}

/** Where the CLI should talk to a daemon on this machine. */
export function apiBase(cfg: Config): string {
  const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  return `http://${host}:${cfg.port}`;
}

/**
 * Whether a daemon is already up.
 *
 * Short timeout on purpose: this runs before every bare `tokio`, and a slow
 * check would make the command feel broken.
 */
export async function daemonRunning(cfg: Config, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase(cfg)}/api/status`, {
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function onWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The commands that might open a URL here, best first.
 *
 * WSL is the case that needs its own list: the browser lives on the Windows
 * side, so `xdg-open` is usually absent and, when it is present, opens nothing
 * anyone can see. `wslview` is the right tool when it's installed, and
 * `explorer.exe` is always there.
 */
function openers(): { cmd: string; args: (url: string) => string[] }[] {
  if (onWsl()) {
    return [
      { cmd: 'wslview', args: (url) => [url] },
      { cmd: 'explorer.exe', args: (url) => [url] },
      { cmd: 'xdg-open', args: (url) => [url] },
    ];
  }
  switch (platform()) {
    case 'darwin':
      return [{ cmd: 'open', args: (url) => [url] }];
    case 'win32':
      return [{ cmd: 'cmd', args: (url) => ['/c', 'start', '', url] }];
    default:
      return [
        { cmd: 'xdg-open', args: (url) => [url] },
        { cmd: 'gio', args: (url) => ['open', url] },
        { cmd: 'sensible-browser', args: (url) => [url] },
      ];
  }
}

/**
 * Open the dashboard in whatever browser this machine uses.
 *
 * Never throws and never blocks: a machine with no browser (a server, a bare
 * container) is a normal thing to run the daemon on, and failing to open a
 * window there must not look like the daemon failed. Resolves to false so the
 * caller can fall back to printing the URL.
 */
export function openInBrowser(url: string): Promise<boolean> {
  const candidates = openers();

  const attempt = (index: number): Promise<boolean> => {
    const opener = candidates[index];
    if (!opener) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const child = spawn(opener.cmd, opener.args(url), { stdio: 'ignore', detached: true });
        // A missing binary arrives as an async 'error' event, not a throw.
        child.on('error', () => resolve(attempt(index + 1)));
        child.on('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(attempt(index + 1));
      }
    });
  };

  return attempt(0);
}
