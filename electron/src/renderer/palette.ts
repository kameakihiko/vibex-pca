import { rank } from './fuzzy';
import { icon } from './icons';
import { api, count, el } from './pcaUi';

// The command palette (Palette/CommandPalette.swift): one search field over the commands of the menu bar, the
// other projects, and, by what is typed, a web address to open or a command to run ("$ npm test"). Up and Down move,
// Enter runs, Escape closes. The menu command opens it (Ctrl+Shift+P, Cmd+Shift+P on a Mac).

interface Command { id: string; title: string; path: string; shortcut?: string }
interface Row { key: string; title: string; subtitle?: string; shortcut?: string; icon: string; usage: string; run: () => void | Promise<unknown>; positions: number[] }

let overlay: HTMLElement | null = null;
let before: HTMLElement | null = null;

function highlight(parent: HTMLElement, text: string, positions: number[]): void {
  const chars = [...text];
  const marks = new Set(positions);
  let run = '';
  let on = false;
  const flush = () => {
    if (!run) return;
    if (on) parent.append(el('mark', '', run));
    else parent.append(run);
    run = '';
  };
  chars.forEach((c, i) => {
    if (marks.has(i) !== on) { flush(); on = marks.has(i); }
    run += c;
  });
  flush();
}

/// The tab of the command column that the person sees, so a typed command goes where they are looking.
const activeShellTab = (): number | null => {
  const tab = document.querySelector<HTMLElement>('.terminal-pane[data-pane="shell"] .term.active')?.dataset.tab;
  return tab ? Number(tab) : null;
};

const looksLikeUrl = (t: string) => !/\s/.test(t) && (t.includes('.') || t.startsWith('localhost') || t.includes('://'));
/// Menu rows are named by their fixed words; a "Connect <server>" row carries the person's server name, so it is counted apart.
const usageOf = (c: Command) => `menu.${c.title.startsWith('Connect ') ? 'connect' : c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

async function candidates(): Promise<Omit<Row, 'positions'>[]> {
  const [commands, snapshot]: [Command[], { current: string | null; projects: { id: string; name: string; path: string; server?: string }[]; recents: { name: string; path: string; server?: string }[] }] =
    await Promise.all([api().mod.invoke('mod:palette:commands'), api().projects.list()]);
  const rows: Omit<Row, 'positions'>[] = [];
  for (const p of snapshot.projects) {
    if (p.id === snapshot.current) continue;
    rows.push({ key: `project-${p.id}`, title: `Switch to ${p.name}`, subtitle: p.server ? `${p.server}:${p.path}` : p.path, icon: 'folder', usage: 'palette.project', run: () => api().projects.select(p.id) });
  }
  const open = new Set(snapshot.projects.map((p) => p.path));
  for (const r of snapshot.recents) {
    if (open.has(r.path) || r.server) continue;
    rows.push({ key: `recent-${r.path}`, title: `Open ${r.name}`, subtitle: r.path, icon: 'folder', usage: 'palette.recent', run: () => api().projects.open(r.path) });
  }
  for (const c of commands) {
    rows.push({ key: `menu-${c.id}`, title: c.title, subtitle: c.path, shortcut: c.shortcut, icon: c.path.startsWith('Run') ? 'play' : c.path.startsWith('View') ? 'layout' : c.path.startsWith('Browser') ? 'globe' : c.path.startsWith('Terminal') ? 'terminal' : 'command', usage: `palette.${usageOf(c)}`, run: () => api().mod.invoke('mod:palette:run', c.id) });
  }
  return rows;
}

function dynamicRows(text: string, projectId: string | null): Omit<Row, 'positions'>[] {
  const typed = text.trim();
  if (!typed || !projectId) return [];
  if (typed.startsWith('$') || typed.startsWith('>')) {
    const command = typed.slice(1).trim();
    return command ? [{ key: 'run-shell', title: `Run in the command terminal: ${command}`, icon: 'terminal', usage: 'palette.run-shell', run: () => api().mod.invoke('mod:palette:shell', projectId, command, activeShellTab()) }] : [];
  }
  if (looksLikeUrl(typed)) {
    return [{ key: 'open-url', title: `Open ${typed}`, subtitle: 'In the side browser', icon: 'globe', usage: 'palette.open-url', run: async () => { await api().browser.navigate(typed); } }];
  }
  return [];
}

export function closePalette(): void {
  overlay?.remove();
  overlay = null;
  before?.focus?.();
  before = null;
}

export async function openPalette(projectId: string | null): Promise<void> {
  if (overlay) return closePalette();
  before = document.activeElement as HTMLElement | null;
  const base = await candidates().catch(() => []);
  overlay = el('div', 'palette-overlay');
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
  const panel = el('div', 'palette');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Command palette');
  panel.setAttribute('aria-modal', 'true');
  const field = el('div', 'palette-field');
  const input = el('input');
  input.type = 'text';
  input.id = 'palette-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'Search commands and projects, or type $ to run a command';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-label', 'Search commands');
  field.append(icon('search', 'palette-icon'), input);
  const list = el('div', 'palette-list');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  panel.append(field, list);
  overlay.append(panel);
  document.body.append(overlay);

  let rows: Row[] = [];
  let selected = 0;

  const rowsFor = (query: string): Row[] => {
    const dynamic = dynamicRows(query, projectId).map((r) => ({ ...r, positions: [] as number[] }));
    const ranked = rank(base, query, (r) => r.title).map(({ item, match }) => ({ ...item, positions: match.positions }));
    return [...dynamic, ...ranked].slice(0, 60);
  };

  const paint = () => {
    rows = rowsFor(input.value);
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    list.replaceChildren(...(rows.length ? rows.map((r, i) => {
      const item = el('div', 'palette-row');
      item.id = `palette-row-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === selected));
      item.dataset.key = r.key;
      const text = el('div', 'palette-text');
      const title = el('span', 'palette-title');
      highlight(title, r.title, r.positions);
      text.append(title);
      if (r.subtitle) text.append(el('span', 'palette-sub', r.subtitle));
      item.append(icon(r.icon, 'palette-row-icon'), text);
      if (r.shortcut) item.append(el('kbd', 'palette-shortcut', r.shortcut));
      item.addEventListener('mousemove', () => { if (selected !== i) { selected = i; mark(); } });
      item.addEventListener('click', () => void go(i));
      return item;
    }) : [el('p', 'palette-empty', 'Nothing matches. Start with $ to run a command.')]));
    input.setAttribute('aria-activedescendant', rows.length ? `palette-row-${selected}` : '');
  };
  const mark = () => {
    list.querySelectorAll('.palette-row').forEach((n, i) => n.setAttribute('aria-selected', String(i === selected)));
    list.querySelector(`#palette-row-${selected}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `palette-row-${selected}`);
  };
  const go = async (i: number) => {
    const row = rows[i];
    if (!row) return;
    count(row.usage);
    closePalette();
    try {
      await row.run();
    } catch {
      // A command that cannot run (no project, no shell) says so in its own place; the palette has closed.
    }
  };
  input.addEventListener('input', () => { selected = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); if (rows.length) { selected = (selected + 1) % rows.length; mark(); } }
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); if (rows.length) { selected = (selected - 1 + rows.length) % rows.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); void go(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  paint();
  input.focus();
}
