// What closing a project, quitting or restarting for an update would stop. Only busy work counts: an idle shell tab
// stops nothing, so it must not raise a question (Swift #49 A1, A2). The caller says what is busy (Terminals.busy).

export interface WorkTab {
  alive: boolean;
  busy: boolean;
  project?: string;
  pane?: string;
  /// A native chat, not a terminal.
  chat?: boolean;
}

export interface Work {
  claude: number;
  commands: number;
  total: number;
  /// Projects that hold busy work.
  projects: number;
}

export function runningWork(tabs: readonly WorkTab[]): Work {
  let claude = 0;
  let commands = 0;
  const projects = new Set<string>();
  for (const tab of tabs) {
    if (!tab.alive || !tab.busy) continue;
    if (tab.chat || tab.pane === 'agent') claude++;
    else commands++;
    projects.add(tab.project ?? '');
  }
  return { claude, commands, total: claude + commands, projects: projects.size };
}

/// "2 Claude sessions and 1 command"; null when nothing runs.
export function workPhrase(work: Pick<Work, 'claude' | 'commands'>): string | null {
  const parts: string[] = [];
  if (work.claude > 0) parts.push(work.claude === 1 ? '1 Claude session' : `${work.claude} Claude sessions`);
  if (work.commands > 0) parts.push(work.commands === 1 ? '1 command' : `${work.commands} commands`);
  return parts.length ? parts.join(' and ') : null;
}

/// "run" or "runs" for the phrase, "it" or "them" for what stops.
export const verbFor = (total: number): string => (total === 1 ? 'runs' : 'run');
export const pronounFor = (total: number): string => (total === 1 ? 'it' : 'them');
