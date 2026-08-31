import { spawn } from 'node:child_process';
import type { Config } from '../config.ts';

export interface Notification {
  title: string;
  body: string;
  /** Maps to ntfy priority and is echoed in webhook payloads. */
  level?: 'low' | 'normal' | 'high';
}

/**
 * Fire-and-forget notification to every configured channel.
 *
 * Never throws: a broken webhook must not take down the daemon or lose a job's
 * result, so failures are logged and swallowed.
 */
export async function notify(cfg: Config, n: Notification): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  const { notify: cfgN } = cfg;

  if (cfgN.ntfyTopic) {
    tasks.push(
      fetch(`${cfgN.ntfyServer.replace(/\/$/, '')}/${cfgN.ntfyTopic}`, {
        method: 'POST',
        headers: {
          Title: n.title,
          Priority: n.level === 'high' ? 'high' : n.level === 'low' ? 'low' : 'default',
          Tags: 'hourglass',
        },
        body: n.body,
      }),
    );
  }

  if (cfgN.telegramToken && cfgN.telegramChatId) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${cfgN.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfgN.telegramChatId, text: `*${n.title}*\n${n.body}`, parse_mode: 'Markdown' }),
      }),
    );
  }

  if (cfgN.webhook) {
    tasks.push(
      fetch(cfgN.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...n, at: Date.now() }),
      }),
    );
  }

  if (cfgN.desktop) {
    // spawn reports a missing binary through an async 'error' event, not a
    // throw, so an unhandled one would take the daemon down with it. Plenty of
    // machines (WSL, servers, minimal desktops) have no notify-send at all.
    const desktop = spawn('notify-send', [n.title, n.body], { stdio: 'ignore', detached: true });
    desktop.on('error', () => {});
    desktop.unref();
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') console.error(`tokio: notification failed: ${r.reason}`);
  }
}
