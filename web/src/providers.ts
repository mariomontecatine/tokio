import type { Providers } from './api.ts';

/** Old daemons only offer Claude and cannot persist an agent selection. */
export function dashboardProviders(providers?: Providers | null) {
  return providers ? { ...providers, canChoose: true }
    : { claude: true, codex: false, chosen: true, canChoose: false };
}

/** Picker results arrive independently. Only submit choices for the visible agent and folder. */
export function composeTarget(
  provider: string,
  folder: { provider: string; path: string },
  modelChoice: { provider: string; name: string },
  thread: { provider: string; cwd: string; id: string },
) {
  const cwd = folder.provider === provider ? folder.path : '';
  return {
    cwd,
    model: modelChoice.provider === provider ? modelChoice.name : '',
    resume: cwd && thread.provider === provider && thread.cwd === cwd ? thread.id : '',
  };
}
