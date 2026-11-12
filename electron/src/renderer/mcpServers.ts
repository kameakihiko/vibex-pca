import type { ProjectInfo } from './frame';
import type { Section } from './modules';
import { api, button, el, emptyState, groupHeader, iconButton, MOD, plain, problem } from './pcaUi';

// The MCP section, as macOS Vibex has it (MCPServers/MCPServersViews.swift): the status of Vibex's own tools, then
// the other servers Claude Code uses here, with whether each connects. Add and remove ask first and show the exact
// change. A header or an environment value is never shown: main cuts it out before the list reaches this page.

type Scope = 'user' | 'project' | 'local';
type Health = 'connected' | 'needsSignIn' | 'waitingForApproval' | 'failed';
interface Server { name: string; scope: Scope; detail: string; origin?: string }
interface Check { name: string; target: string; health: Health }

const WHERE: Record<Scope, string> = {
  user: 'Every project',
  project: 'This project, shared in .mcp.json',
  local: 'This project, on this computer only',
};

function statusRow(name: string, value: string): HTMLElement {
  const line = el('div', 'side-row');
  line.append(el('span', 'side-label', name), el('span', 'side-value', value));
  return line;
}

const displayName = (name: string) => (name.startsWith('plugin:') ? name.split(':').at(-1)! : name.startsWith('claude.ai ') ? name.slice(10) : name);

function healthText(h?: Health): string | null {
  return h === 'needsSignIn' ? 'Needs sign-in' : h === 'waitingForApproval' ? 'Waiting for approval' : h === 'failed' ? "Couldn't connect" : null;
}

function serverRow(server: Server, health: Health | undefined, remove?: () => void): HTMLElement {
  const line = el('div', 'tool-row server-row');
  line.dataset.server = server.name;
  line.dataset.scope = server.scope;
  if (health) line.dataset.health = health;
  const mark = el('span', 'server-mark');
  mark.append(displayName(server.name).slice(0, 1).toUpperCase());
  const dot = el('span', 'health-dot');
  dot.setAttribute('aria-hidden', 'true');
  mark.append(dot);
  const text = el('div', 'row-text');
  const title = el('span', 'row-name');
  title.append(displayName(server.name));
  if (server.scope === 'project') title.append(el('span', 'chip-small', '.mcp.json'));
  if (server.name === 'vibex') title.append(el('span', 'chip-small', 'Vibex'));
  if (server.origin) title.append(el('span', 'chip-small', server.origin));
  const status = healthText(health);
  const sub = el('span', `row-sub clip${status ? ` health-${health}` : ''}`, status ?? server.detail);
  sub.title = server.detail;
  text.append(title, sub);
  line.append(mark, text);
  if (remove && server.name !== 'vibex' && !server.origin) {
    const actions = el('div', 'row-actions');
    actions.append(iconButton('trash', `Remove ${server.name} from Claude Code`, remove));
    line.append(actions);
  }
  return line;
}

/// A confirmation that names exactly what will change. Nothing runs before the person presses the main button.
function confirmBox(question: string, command: string, doIt: string, run: () => Promise<void>, cancel: () => void): HTMLElement {
  const box = el('div', 'confirm-box');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', question);
  const error = el('p', 'tools-problem');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const go = button(doIt, async () => {
    go.disabled = true;
    error.hidden = true;
    try {
      await run();
    } catch (e) {
      error.textContent = plain(e);
      error.hidden = false;
      go.disabled = false;
    }
  }, 'side-button danger');
  const actions = el('div', 'confirm-actions');
  actions.append(go, button('Cancel', cancel));
  box.append(el('p', 'confirm-question', question), el('code', 'confirm-command', command), error, actions);
  return box;
}

function addForm(project: ProjectInfo, done: () => void, cancel: () => void): HTMLElement {
  const form = el('form', 'add-form');
  form.noValidate = true;
  const field = (label: string, input: HTMLElement): HTMLElement => {
    const wrap = el('label', 'form-field');
    wrap.append(el('span', 'side-label', label), input);
    return wrap;
  };
  const text = (placeholder: string, label: string): HTMLInputElement => {
    const input = el('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    return input;
  };
  const name = text('github', 'Server name');
  const where = el('select');
  where.setAttribute('aria-label', 'Where to add it');
  for (const scope of ['user', 'project', 'local'] as Scope[]) where.append(new Option(WHERE[scope], scope));
  const kind = el('select');
  kind.setAttribute('aria-label', 'Type of server');
  kind.append(new Option('A web address (remote server)', 'url'), new Option('A program on this computer', 'command'));
  const url = text('https://example.com/mcp', 'Web address');
  const command = text('npx', 'Program');
  const args = text('-y @modelcontextprotocol/server-memory', 'Arguments');
  const urlField = field('Address', url);
  const commandField = field('Program', command);
  const argsField = field('Arguments, separated by spaces', args);
  const sync = () => {
    urlField.hidden = kind.value !== 'url';
    commandField.hidden = argsField.hidden = kind.value !== 'command';
  };
  kind.addEventListener('change', sync);
  sync();
  const hint = el('p', 'tool-note', 'A server that needs a key or a token: add it in a terminal with claude mcp add, so the secret never passes through this window.');
  const slot = el('div');
  const next = button('Review…', () => {
    const base = { name: name.value.trim(), scope: where.value };
    const input = kind.value === 'url' ? { ...base, url: url.value.trim() } : { ...base, command: command.value.trim(), args: args.value.trim() };
    const preview = kind.value === 'url'
      ? `claude mcp add ${base.name} ${url.value.trim()} --transport http --scope ${where.value}`
      : `claude mcp add ${base.name} --scope ${where.value} -- ${command.value.trim()} ${args.value.trim()}`.trim();
    slot.replaceChildren(confirmBox(`Add ${base.name || 'this server'} for ${WHERE[where.value as Scope].toLowerCase()}?`, preview, 'Add server', async () => {
      await api().mod.invoke('mod:mcp:add', project.id, input);
      done();
    }, () => slot.replaceChildren()));
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    next.click();
  });
  const row = el('div', 'confirm-actions');
  row.append(next, button('Cancel', cancel));
  form.append(field('Name', name), field('Where', where), field('Type', kind), urlField, commandField, argsField, hint, row, slot);
  return form;
}

export const mcpSection: Section = {
  id: 'mcp',
  title: 'MCP Servers',
  icon: 'server',
  label: 'MCP',
  help: `MCP Servers: tools for Claude Code (${MOD()}+Shift+M)`,
  async render(body, project, live) {
    const status = await api().status();
    if (!live()) return;
    // The first rows stay as before: what Vibex's own tools and key are doing.
    const head = [
      ...(project.server ? [statusRow('Claude on the server', 'It reaches the Vibex tools through the ssh connection, with a key for this project only: terminal_run runs on the server, and pages open in the side browser.')] : []),
      statusRow('MCP server', status.mcpError ?? `Running on 127.0.0.1:${status.mcpPort}`),
      statusRow('Key', status.tokenStore === 'os-store' ? 'Saved in the system store' : 'Kept for this session only'),
      statusRow('Claude Code', status.claude),
    ];
    if (project.server) {
      body.replaceChildren(...head, emptyState('Servers of a server project', `Claude on ${project.server} reads its MCP servers on that server. Open them there.`));
      return;
    }
    const list = el('div', 'tool-list');
    body.replaceChildren(...head, list);

    /// The add form is made once and kept, so a health check that ends while someone types does not clear it.
    let form: HTMLElement | null = null;
    let checks: Check[] | null = null;
    let checking = false;
    let pending: string | null = null;

    const paint = async (refresh: boolean): Promise<void> => {
      let data: { servers: Server[]; claude: boolean };
      try {
        data = await api().mod.invoke('mod:mcp:list', project.id);
      } catch (error) {
        if (live()) list.replaceChildren(problem(plain(error)));
        return;
      }
      if (!live()) return;
      const health = new Map((checks ?? []).map((c) => [c.name, c.health]));
      const configured = new Set(data.servers.map((s) => s.name));
      const external: Server[] = (checks ?? []).filter((c) => !configured.has(c.name)).map((c) => ({
        name: c.name, scope: 'user' as const, detail: c.target, origin: c.name.startsWith('plugin:') ? 'Plugin' : c.name.startsWith('claude.ai') ? 'claude.ai' : 'Claude Code',
      }));
      const bar = el('div', 'tool-head');
      bar.append(el('span', 'tool-head-title', 'Other servers'));
      if (checking) bar.append(el('span', 'tool-note inline', 'Checking connections…'));
      bar.append(
        iconButton('plus', 'Add a server', () => {
          form = form ? null : addForm(project, () => { form = null; void paint(true); }, () => { form = null; void paint(false); });
          void paint(false);
        }),
        iconButton('refresh', 'Refresh and check connections', () => void paint(true)),
      );
      const parts: HTMLElement[] = [bar];
      if (!data.claude) parts.push(el('p', 'tool-note', 'Claude Code is not installed, so servers cannot be added or removed here. Open Setup to install it.'));
      if (form && data.claude) parts.push(form);
      const states = new Set([...health.values()]);
      if (states.has('needsSignIn') || states.has('waitingForApproval')) {
        const what = states.has('needsSignIn') && states.has('waitingForApproval') ? 'Some servers need you to sign in or approve them.' : states.has('needsSignIn') ? 'Some servers need you to sign in.' : "This project's .mcp.json has servers Claude Code has not approved yet.";
        parts.push(el('p', 'tool-note attention', `${what} Open Claude Code here and type /mcp.`));
      }
      const section = (title: string, servers: Server[]): HTMLElement => {
        const box = el('section', 'tool-group');
        box.append(groupHeader(title, servers.length));
        if (!servers.length) box.append(el('p', 'tool-note', 'None yet'));
        for (const server of servers) {
          const key = `${server.scope}:${server.name}`;
          if (pending === key) {
            box.append(confirmBox(`Remove ${server.name} from ${WHERE[server.scope].toLowerCase()}?`, `claude mcp remove ${server.name} --scope ${server.scope}`, 'Remove', async () => {
              await api().mod.invoke('mod:mcp:remove', project.id, server.name, server.scope);
              pending = null;
              void paint(true);
            }, () => { pending = null; void paint(false); }));
          } else {
            box.append(serverRow(server, health.get(server.name), data.claude ? () => { pending = key; void paint(false); } : undefined));
          }
        }
        return box;
      };
      parts.push(
        section('Every project', data.servers.filter((s) => s.scope === 'user')),
        section('This project', data.servers.filter((s) => s.scope !== 'user')),
      );
      if (external.length) parts.push(section('From plugins and claude.ai', external));
      list.replaceChildren(...parts);
      if (refresh && data.claude && !checking) {
        checking = true;
        void paint(false);
        const result: Check[] = await api().mod.invoke('mod:mcp:health', project.id).catch(() => []);
        checking = false;
        if (result.length) checks = result;
        if (live()) void paint(false);
      }
    };
    await paint(true);
  },
};
