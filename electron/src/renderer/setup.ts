import { openDoc } from './docs';
import { icon } from './icons';
import { api, button, el, iconButton, plain, problem } from './pcaUi';

// Setup, as a tab in the middle column (macOS Vibex has a Setup window: Setup/SetupWindow.swift): what is on this
// computer and what is not, with one plain next step for each thing that is missing. Checking only reads;
// nothing is installed until a button is pressed.

interface Item {
  id: string; title: string; why: string; status: 'ready' | 'needed' | 'optional'; version?: string; next?: string;
  action?: { label: string; kind: 'open' | 'install'; url?: string };
}

/// A feature adds rows under the checks (the PCA edition). They do not count in "N of M ready".
export const setupExtras: ((projectId: string) => Promise<HTMLElement[]>)[] = [];

/// The installer runs in a project's command terminal. With none open, the folder picker comes first: the person chooses
/// where to work, and Setup goes on as a tab of that project.
async function projectForInstall(): Promise<string | null> {
  await api().projects.open();
  return (await api().projects.list()).current;
}

async function fill(page: HTMLElement, projectId: string | null, first = ''): Promise<void> {
  let items: Item[];
  try {
    items = await api().mod.invoke('mod:setup:check', projectId);
  } catch (error) {
    page.replaceChildren(problem(plain(error)));
    return;
  }
  // Claude Code is there now (the person installed it from this page): its tools register and the title bar chip clears,
  // with no restart.
  if (items.some((i) => i.id === 'claude' && i.status === 'ready')) {
    void api().mod.invoke('mod:setup:claude-found').then((changed: boolean) => { if (changed) window.dispatchEvent(new Event('vibex:status')); }).catch(() => undefined);
  }
  const ready = items.filter((i) => i.status === 'ready').length;
  const head = el('header', 'doc-head');
  head.append(el('h1', '', 'Set up Vibex'), el('p', 'doc-sub', 'What Vibex needs on this computer. It reads versions only and installs nothing until you press a button.'));
  const bar = el('div', 'tool-head');
  const summary = el('span', 'tool-head-title', `${ready} of ${items.length} ready`);
  summary.dataset.setupSummary = '1';
  bar.append(summary, iconButton('refresh', 'Check again', () => void fill(page, projectId)));
  const list = el('section', 'tool-group');
  const message = el('p', 'tool-note setup-message', first);
  message.setAttribute('role', 'status');
  for (const item of items) {
    const row = el('div', `tool-row setup-row ${item.status}`);
    row.dataset.setup = item.id;
    row.dataset.status = item.status;
    const text = el('div', 'row-text');
    text.append(el('span', 'row-name', item.title));
    text.append(el('span', 'row-sub', item.status === 'ready' ? (item.version ?? 'Ready') : item.status === 'optional' ? `Not installed. ${item.why}` : `Not found. ${item.why}`));
    if (item.status !== 'ready' && item.next) text.append(el('span', 'row-next', item.next));
    if (item.status !== 'ready' && item.action) {
      const act = button(item.action.label, async () => {
        act.disabled = true;
        try {
          const needsFolder = !projectId && item.action!.kind === 'install';
          const target = needsFolder ? await projectForInstall() : projectId;
          if (needsFolder && !target) message.textContent = 'No folder was chosen, so nothing was installed. Click the button again and choose a folder for your work.';
          else {
            const said: string = await api().mod.invoke('mod:setup:act', target, item.id);
            if (needsFolder) openSetup(target, said);
            else message.textContent = said;
          }
        } catch (error) {
          message.textContent = plain(error);
        }
        act.disabled = false;
      }, 'side-button small');
      text.append(act);
    }
    row.append(icon(item.status === 'ready' ? 'checkCircle' : 'alert', 'row-icon status-mark'), text);
    list.append(row);
  }
  const extras = projectId ? (await Promise.all(setupExtras.map((f) => f(projectId).catch(() => [] as HTMLElement[])))).flat() : [];
  page.replaceChildren(head, bar, list, ...extras, message);
}

/// A project has Setup as a tab. With no project open the welcome screen shows it in place (see frame.ts).
export function openSetup(projectId: string | null, first = ''): void {
  const page = el('div', 'doc-page');
  page.append(el('p', 'tool-note', 'Checking…'));
  void fill(page, projectId, first);
  if (projectId) openDoc(projectId, { key: 'setup', title: 'Setup', icon: 'settings', element: page });
  else window.dispatchEvent(new CustomEvent('vibex:setup-welcome', { detail: page }));
}
