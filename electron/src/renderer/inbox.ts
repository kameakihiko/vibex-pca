import { icon } from './icons';
import type { Section } from './modules';
import type { ProjectInfo } from './frame';
import { api, clock, h, plain, toast } from './agentsGoUi';
import { onGo, openGoPanel, waitingGo } from './go';

// The Inbox (macOS Vibex: Inbox/AttentionCenter.swift): what the Claude sessions wait for, from Claude Code's hooks, and
// what agents reported with vibex_notify.

export interface Waiting { id: string; projectId: string; project: string; kind: 'permission' | 'question'; message: string; since: number }
export interface Report { id: string; projectId: string; project: string; title: string; message: string | null; at: number }
export interface InboxState { waiting: Waiting[]; reports: Report[]; hooks: 'installed' | 'missing' | 'unreadable'; problem: string | null }

let state: InboxState = { waiting: [], reports: [], hooks: 'missing', problem: null };
const listeners: ((s: InboxState) => void)[] = [];
let target: { body: HTMLElement; live: () => boolean } | null = null;

onGo(() => { if (target?.live()) paint(); });

export const onInbox = (fn: (s: InboxState) => void) => listeners.push(fn);

export function startInbox(): void {
  api.mod.on('mod:inbox:changed', (next: InboxState) => {
    state = next;
    for (const fn of listeners) fn(state);
    if (target?.live()) paint();
  });
  api.mod.on('mod:inbox:toast', (report: Report) => toast(report.title, report.message));
  void api.mod.invoke('mod:inbox:state').then((first: InboxState) => {
    state = first;
    for (const fn of listeners) fn(state);
    if (target?.live()) paint();
  });
}

function paint(): void {
  if (!target) return;
  const { body } = target;
  const root = h('div', 'inbox');
  const waiting = h('section', 'inbox-block');
  waiting.append(h('h3', '', 'Waiting for you'));
  const asks = waitingGo();
  for (const ask of asks) {
    const row = h('div', 'inbox-item');
    row.dataset.kind = 'go';
    row.append(icon('flag', 'inbox-icon'));
    const text = h('div', 'inbox-body');
    text.append(h('span', 'inbox-text', `Asks for your go: ${ask.title}`), h('span', 'inbox-meta', `${ask.project} · since ${clock(ask.createdAt)}`));
    const show = h('button', 'side-button inbox-show', 'Open');
    show.title = 'Go to this project and its Go panel';
    show.addEventListener('click', async () => {
      await api.projects.select(ask.projectId);
      openGoPanel(ask.projectId);
    });
    row.append(text, show);
    waiting.append(row);
  }
  if (!state.waiting.length && !asks.length) waiting.append(h('p', 'empty-text inbox-none', 'Nothing is waiting. When a Claude asks for approval or has a question, it shows here and on the project tile.'));
  for (const item of state.waiting) {
    const row = h('div', 'inbox-item');
    row.dataset.kind = item.kind;
    row.append(icon(item.kind === 'permission' ? 'lock' : 'message', 'inbox-icon'));
    const text = h('div', 'inbox-body');
    text.append(h('span', 'inbox-text', item.message), h('span', 'inbox-meta', `${item.project} · since ${clock(item.since)}`));
    const show = h('button', 'side-button inbox-show', 'Show');
    show.title = 'Go to this project and its Claude';
    show.addEventListener('click', async () => {
      await api.projects.select(item.projectId);
      void api.mod.invoke('mod:inbox:show', item.projectId);
      window.dispatchEvent(new CustomEvent('vibex:show-waiting', { detail: item.projectId }));
    });
    const dismiss = h('button', 'side-button inbox-dismiss', 'Dismiss');
    dismiss.title = 'Remove this line. Claude is not told; use it when the tab has gone.';
    dismiss.addEventListener('click', () => void api.mod.invoke('mod:inbox:dismiss', item.id));
    row.append(text, show, dismiss);
    waiting.append(row);
  }
  const reported = h('section', 'inbox-block');
  const head = h('div', 'inbox-head');
  head.append(h('h3', '', 'Reported'));
  if (state.reports.length) {
    const clear = h('button', 'side-button inbox-clear', 'Clear all');
    clear.addEventListener('click', () => void api.mod.invoke('mod:inbox:clear'));
    head.append(clear);
  }
  reported.append(head);
  if (!state.reports.length) reported.append(h('p', 'empty-text inbox-none', 'Nothing reported yet. An agent can report with vibex_notify when a long task ends.'));
  for (const report of state.reports) {
    const row = h('div', 'inbox-item');
    row.dataset.kind = 'report';
    row.append(icon('bell', 'inbox-icon'));
    const text = h('div', 'inbox-body');
    text.append(h('span', 'inbox-text', report.title));
    if (report.message) text.append(h('span', 'inbox-detail', report.message));
    text.append(h('span', 'inbox-meta', `${report.project} · ${clock(report.at)}`));
    const dismiss = h('button', 'icon-button inbox-dismiss');
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', `Dismiss ${report.title}`);
    dismiss.append(icon('close'));
    dismiss.addEventListener('click', () => void api.mod.invoke('mod:inbox:clear', report.id));
    row.append(text, dismiss);
    reported.append(row);
  }
  const hooks = h('section', 'inbox-block inbox-hooks');
  hooks.append(h('h3', '', 'Claude Code hooks'));
  const installed = state.hooks === 'installed';
  hooks.append(h('p', 'empty-text', state.hooks === 'unreadable'
    ? 'Claude settings.json cannot be read, so the hooks are left as they are.'
    : installed ? 'On. Claude Code tells this app when a session waits for you. Your own hooks are not touched.' : 'Off. Without them, a Claude that waits for you does not show here.'));
  if (state.problem) {
    const problem = h('p', 'agents-message', state.problem);
    problem.dataset.ok = 'false';
    hooks.append(problem);
  }
  const toggle = h('button', 'side-button inbox-hooks-toggle', installed ? 'Remove the hooks' : 'Add the hooks');
  toggle.disabled = state.hooks === 'unreadable';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    const done: { ok: boolean; message: string } = await api.mod.invoke('mod:inbox:hooks', !installed).catch((e: unknown) => ({ ok: false, message: plain(e) }));
    if (!done.ok) toast('The hooks did not change', done.message);
  });
  hooks.append(toggle);
  root.append(waiting, reported, hooks);
  body.replaceChildren(root);
}

export const inboxSection: Section = {
  id: 'inbox',
  title: 'Inbox',
  icon: 'inbox',
  label: 'Inbox',
  help: 'Inbox: what Claude waits for, and what agents reported',
  render(body, _project: ProjectInfo, live) {
    target = { body, live };
    paint();
  },
};
