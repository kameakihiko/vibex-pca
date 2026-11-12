import { MOD } from './pcaUi';
import { icon } from './icons';
import type { Section } from './modules';
import { api, count, h, plain } from './agentsGoUi';
import { onInbox } from './inbox';

// The Agents section (macOS Vibex: Agents/AgentsSidebar.swift): several Claude Code attempts at once, each on its own
// branch in its own git worktree. Start one, open its Claude tab, finish it (merge and remove) or remove it.

interface Agent { path: string; branch: string; name: string; task: string | null; changes: number; ahead: number; waiting?: string }
interface AgentList { state: 'ready' | 'notRepository' | 'noGit'; base: string | null; agents: Agent[]; problem?: string }
interface Result { ok: boolean; message: string }

let refreshActive: (() => void) | null = null;
/// One timer for the section, and what was typed per project: a redraw (a pane toggle, a tool that opens a project)
/// draws the section again and must neither start another timer nor empty the boxes.
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const drafts = new Map<string, { name: string; task: string }>();
onInbox(() => refreshActive?.());

function stateLine(agent: Agent): string {
  const parts = [agent.changes ? count(agent.changes, 'change', 'changes') : 'No changes'];
  if (agent.ahead) parts.push(`${count(agent.ahead, 'commit', 'commits')} ahead`);
  return parts.join(' · ');
}

export const agentsSection: Section = {
  id: 'agents',
  title: 'Agents',
  icon: 'users',
  label: 'Agents',
  help: `Agents: Claude working in parallel, each in its own worktree (${MOD()}+Shift+A)`,
  async render(body, project, live) {
    const root = h('div', 'agents');
    body.replaceChildren(root);
    let list: AgentList;
    try {
      list = await api.mod.invoke('mod:agents:list', project.id);
    } catch (error) {
      if (live()) root.append(h('p', 'agents-empty', plain(error)));
      return;
    }
    if (!live()) return;
    if (list.state !== 'ready') {
      root.append(h('p', 'agents-empty', list.problem ?? (list.state === 'noGit'
        ? 'Git is not installed, or it is not on the PATH. Install Git, then open this section again.'
        : 'This folder is not a git repository. Agents need git: each one works in its own worktree, on its own branch.')));
      return;
    }

    const message = h('p', 'agents-message');
    message.setAttribute('role', 'status');
    message.hidden = true;
    const say = (result: Result) => {
      message.textContent = result.message;
      message.dataset.ok = String(result.ok);
      message.hidden = false;
    };

    // The form is built once; only the list below it is rebuilt, so what the person typed stays.
    const form = h('form', 'agents-form');
    const name = h('input');
    name.id = 'agent-name';
    name.type = 'text';
    name.placeholder = 'Name, e.g. dark mode';
    name.setAttribute('aria-label', 'Agent name');
    name.autocomplete = 'off';
    name.spellcheck = false;
    const task = h('textarea');
    task.id = 'agent-task';
    task.placeholder = 'What should it do? (optional)';
    task.setAttribute('aria-label', 'Task for the agent');
    task.rows = 3;
    const start = h('button', 'side-button primary', 'Start agent');
    start.id = 'agent-start';
    start.type = 'submit';
    const draft = drafts.get(project.id) ?? { name: '', task: '' };
    drafts.set(project.id, draft);
    name.value = draft.name;
    task.value = draft.task;
    name.addEventListener('input', () => { draft.name = name.value; });
    task.addEventListener('input', () => { draft.task = task.value; });
    form.append(name, task, start, h('p', 'empty-text', `Starts Claude in a new tab, in its own worktree on a branch vibex/<name>, from ${list.base ?? 'the last commit'}.`));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      start.disabled = true;
      const result: Result = await api.mod.invoke('mod:agents:create', project.id, name.value, task.value).catch((err: unknown) => ({ ok: false, message: plain(err) }));
      start.disabled = false;
      say(result);
      if (result.ok) {
        name.value = '';
        task.value = '';
        draft.name = '';
        draft.task = '';
      }
      await refresh();
    });

    const head = h('div', 'agents-head');
    head.append(h('h3', '', `Agents${list.base ? ` · from ${list.base}` : ''}`));
    const refreshButton = h('button', 'icon-button agents-refresh');
    refreshButton.title = 'Refresh';
    refreshButton.setAttribute('aria-label', 'Refresh the agents');
    refreshButton.append(icon('refresh'));
    refreshButton.addEventListener('click', () => void refresh());
    head.append(refreshButton);
    const cards = h('div', 'agents-list');
    root.append(form, message, head, cards);

    /// The button the person pressed first asks again before it acts.
    let asking: { path: string; action: 'finish' | 'remove' } | null = null;
    let busy = false;
    let latest = list;

    const act = async (agent: Agent, action: 'finish' | 'remove' | 'open' | 'reveal') => {
      busy = true;
      asking = null;
      paint();
      const result: Result | undefined = await api.mod.invoke(`mod:agents:${action}`, project.id, agent.path).catch((err: unknown) => ({ ok: false, message: plain(err) }));
      busy = false;
      if (result) say(result);
      await refresh();
    };

    function paint(): void {
      if (!latest.agents.length) {
        cards.replaceChildren(h('p', 'agents-none empty-text', 'No agents yet. Name one above and start it.'));
        return;
      }
      cards.replaceChildren(...latest.agents.map((agent) => {
        const card = h('div', 'agent-card');
        card.dataset.path = agent.path;
        const top = h('div', 'agent-top');
        top.append(h('span', 'agent-name', agent.name), h('span', 'agent-branch', agent.branch));
        card.append(top);
        if (agent.task) card.append(h('p', 'agent-task', agent.task));
        card.append(h('span', 'agent-state', stateLine(agent)));
        if (agent.waiting) {
          const wait = h('span', 'agent-wait', agent.waiting);
          wait.title = 'This agent’s Claude is waiting for you';
          card.append(wait);
        }
        const row = h('div', 'agent-actions');
        const button = (cls: string, label: string, run: () => void, help?: string) => {
          const b = h('button', `side-button ${cls}`, label);
          b.disabled = busy;
          if (help) b.title = help;
          b.addEventListener('click', run);
          return b;
        };
        if (asking?.path === agent.path) {
          const merge = asking.action === 'finish';
          row.append(
            button('agent-confirm primary', merge ? `Merge into ${latest.base ?? 'the project'}?` : 'Remove the folder?', () => void act(agent, asking!.action as 'finish' | 'remove')),
            button('agent-cancel', 'Cancel', () => { asking = null; paint(); }),
          );
        } else {
          row.append(
            button('agent-open', 'Open', () => void act(agent, 'open'), 'Open a Claude tab in this worktree'),
            button('agent-finish', 'Finish', () => { asking = { path: agent.path, action: 'finish' }; paint(); }, `Merge ${agent.branch} into ${latest.base ?? 'the project'}, then remove the worktree`),
            button('agent-remove', 'Remove', () => { asking = { path: agent.path, action: 'remove' }; paint(); }, 'Remove a worktree with no uncommitted changes'),
            button('agent-reveal', 'Folder', () => void act(agent, 'reveal'), 'Show the worktree folder'),
          );
        }
        card.append(row);
        return card;
      }));
    }

    async function refresh(): Promise<void> {
      if (!live()) return;
      try {
        latest = await api.mod.invoke('mod:agents:list', project.id);
      } catch (error) {
        say({ ok: false, message: plain(error) });
        return;
      }
      if (live() && !busy) paint();
    }

    paint();
    // Agents work in their own tabs; keep their numbers fresh while this is showing.
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => (live() ? void refresh() : clearInterval(refreshTimer)), 4000);
    refreshActive = () => (live() ? void refresh() : (refreshActive = null));
  },
};
