import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { readFileSync } from 'node:fs';
import type { Config } from '../config.ts';

/** Quotes for AppleScript and PowerShell, which take the text as source code. */
const escapeDouble = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escapeSingle = (text: string) => text.replace(/'/g, "''");

function onWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The desktop notifier for this machine, or null when it has none.
 *
 * Every operating system has its own, and there is no portable one — which is
 * why this used to be Linux-only by accident: `notify-send` simply failed
 * silently everywhere else, so a macOS user got no notifications and no reason
 * why. WSL is its own case again: the Linux side has no desktop, so the message
 * has to be handed to Windows to be seen at all.
 */
function desktopNotifier(n: { title: string; body: string }): { cmd: string; args: string[] } | null {
  const toast = (text: string, title: string) =>
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;` +
    `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(` +
    `[Windows.UI.Notifications.ToastTemplateType]::ToastText02);` +
    `$x=$t.GetElementsByTagName('text');` +
    `$x.Item(0).AppendChild($t.CreateTextNode('${escapeSingle(title)}')) > $null;` +
    `$x.Item(1).AppendChild($t.CreateTextNode('${escapeSingle(text)}')) > $null;` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tokio').Show(` +
    `[Windows.UI.Notifications.ToastNotification]::new($t))`;

  if (onWsl()) return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', toast(n.body, n.title)] };

  switch (platform()) {
    case 'darwin':
      return {
        cmd: 'osascript',
        args: ['-e', `display notification "${escapeDouble(n.body)}" with title "${escapeDouble(n.title)}"`],
      };
    case 'win32':
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', toast(n.body, n.title)] };
    case 'linux':
      return { cmd: 'notify-send', args: [n.title, n.body] };
    default:
      return null;
  }
}

/**
 * Fire and forget a command, surviving a binary that isn't there.
 *
 * `spawn` reports a missing executable through an asynchronous 'error' event
 * rather than a throw, so an unhandled one takes the whole process down — after
 * a job has already finished, losing its result to a notification that could
 * not be shown. Exported so that guarantee can be tested against a binary that
 * certainly does not exist, rather than by hoping the test machine has no
 * notifier and firing a real one at it when it does.
 */
export function runDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Some platforms throw synchronously on a malformed command instead.
  }
}

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
    // machines (servers, containers, minimal desktops) have no notifier at all.
    const command = desktopNotifier(n);
    if (command) runDetached(command.cmd, command.args);
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') console.error(`tokio: notification failed: ${r.reason}`);
  }
}
