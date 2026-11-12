import { icon } from './icons';
import { api, count, el } from './pcaUi';

// The Run control in the title bar (Run/RunButton.swift): a play button that starts the project and becomes a stop
// button while it runs, with the current step beside it. The port the run serves shows as a small line under the
// project's tile on the rail, as macOS Vibex shows a project's port.

interface RunState { project: string; phase: string; label: string; summary: string; active: boolean; port: number | null }

const states = new Map<string, RunState>();
let shownProject: string | null = null;
let group: HTMLElement;
let toggle: HTMLButtonElement;
let label: HTMLElement;

function paint(): void {
  const state = shownProject ? states.get(shownProject) : undefined;
  const active = !!state?.active;
  toggle.replaceChildren(icon(active ? 'stop' : 'play'));
  const help = active ? 'Stop' : `Run${state?.summary && state.summary !== 'nothing to run' ? ` · ${state.summary}` : ''} (${api().platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+R)`;
  toggle.title = help;
  toggle.setAttribute('aria-label', active ? 'Stop the run' : 'Run the project');
  toggle.dataset.active = String(active);
  group.hidden = !shownProject;
  const text = state && state.phase !== 'idle' ? state.label : '';
  label.textContent = text;
  label.dataset.phase = state?.phase ?? 'idle';
  label.hidden = !text;
  paintPorts();
}

/// A line "localhost:5173" under the tile of each project that serves a port.
function paintPorts(): void {
  document.querySelectorAll<HTMLElement>('#rail-tiles .tile').forEach((tile) => {
    const state = states.get(tile.dataset.project ?? '');
    let line = tile.querySelector<HTMLElement>('.port-line');
    if (!state?.port) {
      line?.remove();
      return;
    }
    if (!line) {
      line = el('span', 'port-line');
      tile.append(line);
    }
    line.textContent = `:${state.port}`;
    line.title = `This project serves port ${state.port}`;
  });
}

async function refresh(id: string): Promise<void> {
  try {
    states.set(id, await api().mod.invoke('mod:run:state', id));
  } catch {
    // The project closed meanwhile.
  }
  paint();
}

export function startRun(): void {
  group = el('div', 'run-group');
  group.id = 'run-group';
  toggle = el('button', 'icon-button run-toggle');
  toggle.type = 'button';
  label = el('span', 'run-label');
  label.setAttribute('role', 'status');
  group.append(toggle, label);
  document.getElementById('title-actions')?.prepend(group);
  toggle.addEventListener('click', async () => {
    if (!shownProject) return;
    const active = !!states.get(shownProject)?.active;
    count(active ? 'ui.stop.button' : 'ui.run.button');
    try {
      await api().mod.invoke(active ? 'mod:run:stop' : 'mod:run:start', shownProject);
    } catch {
      // The label shows the failure that main published.
    }
  });
  api().mod.on('mod:run:state', (state: RunState) => {
    states.set(state.project, state);
    paint();
  });
  // The rail is drawn again at each project change; the port lines are put back after it.
  new MutationObserver(paintPorts).observe(document.getElementById('rail-tiles')!, { childList: true });
  api().projects.onChanged((snapshot: { current: string | null; projects: { id: string }[] }) => {
    shownProject = snapshot.current;
    for (const id of states.keys()) if (!snapshot.projects.some((p) => p.id === id)) states.delete(id);
    if (shownProject) void refresh(shownProject);
    else paint();
  });
  void api().projects.list().then((snapshot: { current: string | null }) => {
    shownProject = snapshot.current;
    if (shownProject) void refresh(shownProject);
    else paint();
  });
  paint();
}
