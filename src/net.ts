import { networkInterfaces } from 'node:os';
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
