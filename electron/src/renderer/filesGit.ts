import { openDoc } from './docs';
import type { ProjectInfo } from './frame';
import { HOOKS_NOTE, serverNote } from './filesGitText';
import { icon } from './icons';
import type { RendererModule } from './modules';

// The Files and Git sections of the sidebar. Ported from Vibex/Explorer (ExplorerSidebar, FileViewer) and
// Vibex/SourceControl (SourceControlSidebar, DiffView). All text from files, git and commits is set with
// textContent; none of it is ever parsed as HTML.

const api = (window as any).vibex;
const mod = (name: string, projectId: string, ...args: unknown[]) => api.mod.invoke(`mod:${name}`, projectId, ...args);

/// main answers `{ ok, value }` or `{ ok: false, message }`; the message is already plain.
async function call<T>(name: string, projectId: string, ...args: unknown[]): Promise<T> {
  const answer = await mod(name, projectId, ...args);
  if (!answer.ok) throw new Error(answer.message);
  return answer.value as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'tool');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(name));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const note = (text: string) => el('p', 'fg-note', text);
const fileManagerLabel = () => (api.platform === 'darwin' ? 'Show in Finder' : api.platform === 'win32' ? 'Show in File Explorer' : 'Show in Files');
const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/// One timer per section: a new render replaces the old timer, so a section shown twice does not poll twice.
const timers: Record<string, number | undefined> = {};
function poll(section: string, every: number, live: () => boolean, tick: () => Promise<void>): void {
  if (timers[section] !== undefined) window.clearInterval(timers[section]);
  let busy = false;
  const run = async () => {
    if (!live()) {
      window.clearInterval(timers[section]);
      timers[section] = undefined;
      return;
    }
    if (busy || document.hidden) return;
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  };
  timers[section] = window.setInterval(() => void run(), every);
  window.addEventListener('focus', () => void run(), { once: true });
}

// ---------- document tabs: a file, a diff ----------

function notice(title: string, text: string): HTMLElement {
  const box = el('div', 'doc-note');
  box.append(el('p', 'empty-title', title), el('p', 'empty-text', text));
  return box;
}

function fileElement(project: ProjectInfo, rel: string, read: any): HTMLElement {
  const root = el('div', 'doc-pane');
  const head = el('div', 'doc-head');
  head.append(el('span', 'doc-path', rel));
  if (read.size !== undefined) head.append(el('span', 'doc-meta', sizeText(read.size)));
  head.append(el('span', 'doc-badge', 'Read only'));
  const reveal = el('button', 'side-button', fileManagerLabel());
  reveal.addEventListener('click', () => void mod('files:reveal', project.id, rel));
  head.append(reveal);
  root.append(head);
  if (read.kind === 'text') {
    const lines: string[] = read.text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const code = el('div', 'doc-code');
    const gutter = el('pre', 'doc-gutter', lines.map((_, i) => String(i + 1)).join('\n'));
    gutter.setAttribute('aria-hidden', 'true');
    code.append(gutter, el('pre', 'doc-text', lines.join('\n')));
    root.append(code);
  } else if (read.kind === 'binary') {
    root.append(notice('This is not a text file', `It is a binary file of ${sizeText(read.size)}, so it is not shown here. Use "${fileManagerLabel()}" to open it with another program.`));
  } else if (read.kind === 'big') {
    root.append(notice('This file is too big to show', `It is ${sizeText(read.size)}. Files above 1 MB are not opened here. Use "${fileManagerLabel()}" to open it with another program.`));
  } else {
    root.append(notice('This file cannot be shown', read.message));
  }
  return root;
}

export async function openFile(project: ProjectInfo, rel: string): Promise<void> {
  const name = rel.split('/').pop() ?? rel;
  const key = `file:${rel}`;
  openDoc(project.id, { key, title: name, icon: 'file', element: notice('Opening…', rel) });
  try {
    openDoc(project.id, { key, title: name, icon: 'file', element: fileElement(project, rel, await call(`files:read`, project.id, rel)) });
  } catch (e) {
    openDoc(project.id, { key, title: name, icon: 'file', element: notice('This file cannot be shown', (e as Error).message) });
  }
}

const MAX_LINES = 20_000;

function patchElement(title: string, text: string, truncated: boolean): HTMLElement {
  const root = el('div', 'doc-pane');
  const head = el('div', 'doc-head');
  head.append(el('span', 'doc-path', title), el('span', 'doc-badge', 'Read only'));
  root.append(head);
  if (!text.trim()) {
    root.append(notice('No changes to show', 'This change has no text. A new empty file or a change of mode has no lines.'));
    return root;
  }
  const code = el('div', 'doc-code diff');
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  const lines = all.slice(0, MAX_LINES);
  const pre = el('pre', 'doc-text');
  for (const line of lines) {
    const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('commit ')
      ? 'meta'
      : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    pre.append(el('span', `dl ${kind}`, line || ' '));
  }
  code.append(pre);
  root.append(code);
  if (truncated || all.length > MAX_LINES) root.append(note('This is only the start of a long change. Open the terminal and run git diff to see all of it.'));
  return root;
}

async function openPatch(project: ProjectInfo, key: string, title: string, iconName: string, load: () => Promise<{ text: string; truncated: boolean }>): Promise<void> {
  openDoc(project.id, { key, title, icon: iconName, element: notice('Opening…', title) });
  try {
    const patch = await load();
    openDoc(project.id, { key, title, icon: iconName, element: patchElement(title, patch.text, patch.truncated) });
  } catch (e) {
    openDoc(project.id, { key, title, icon: iconName, element: notice('This change cannot be shown', (e as Error).message) });
  }
}

// ---------- Files ----------

interface Entry { name: string; dir: boolean; ignored: boolean }
interface Tree {
  expanded: Set<string>;
  kids: Map<string, Entry[]>;
  stamps: Map<string, string | null>;
  selected: string | null;
}
const trees = new Map<string, Tree>();
const treeOf = (id: string): Tree => {
  if (!trees.has(id)) trees.set(id, { expanded: new Set(), kids: new Map(), stamps: new Map(), selected: null });
  return trees.get(id)!;
};

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

function renderFiles(body: HTMLElement, project: ProjectInfo, live: () => boolean): Promise<void> {
  if (project.server) {
    body.append(note(serverNote(project.server, project.path)));
    return Promise.resolve();
  }
  const tree = treeOf(project.id);
  const head = el('div', 'fg-head');
  head.append(el('span', 'fg-title', project.name.toUpperCase()));
  const tools = el('span', 'fg-tools');
  tools.append(
    iconButton('chevronUp', 'Collapse all folders', () => {
      tree.expanded.clear();
      paint();
    }),
    iconButton('refresh', 'Refresh', () => void refreshAll()),
  );
  head.append(tools);
  const reveal = el('button', 'side-button', fileManagerLabel());
  reveal.addEventListener('click', () => api.projects.reveal(project.id));
  const error = el('p', 'fg-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const list = el('div', 'tree');
  list.setAttribute('role', 'tree');
  body.append(head, reveal, error, list);

  const fail = (e: unknown) => {
    error.textContent = (e as Error).message;
    error.hidden = false;
  };

  /// The stamp is read before the list, so a file that appears in between shows at the next poll.
  async function load(rel: string): Promise<void> {
    const stamp = await call<Record<string, string | null>>('files:stamps', project.id, [rel]);
    const result = await call<{ entries: Entry[] }>('files:list', project.id, rel);
    tree.kids.set(rel, result.entries);
    tree.stamps.set(rel, stamp[rel]);
  }

  async function refreshAll(): Promise<void> {
    error.hidden = true;
    try {
      for (const rel of ['', ...tree.expanded]) {
        try {
          await load(rel);
        } catch (e) {
          if (rel === '') throw e;
          // A folder that went away drops out of the tree.
          tree.expanded.delete(rel);
          tree.kids.delete(rel);
        }
      }
    } catch (e) {
      fail(e);
    }
    if (live()) paint();
  }

  function rows(dir: string, depth: number, out: { rel: string; entry: Entry; depth: number }[]): void {
    for (const entry of tree.kids.get(dir) ?? []) {
      const rel = join(dir, entry.name);
      out.push({ rel, entry, depth });
      if (entry.dir && tree.expanded.has(rel)) rows(rel, depth + 1, out);
    }
  }

  async function toggle(rel: string): Promise<void> {
    if (tree.expanded.has(rel)) {
      tree.expanded.delete(rel);
    } else {
      tree.expanded.add(rel);
      if (!tree.kids.has(rel)) {
        try {
          await load(rel);
        } catch (e) {
          tree.expanded.delete(rel);
          fail(e);
        }
      }
    }
    if (live()) paint();
  }

  function menu(at: MouseEvent, rel: string, dir: boolean): void {
    document.querySelector('.fg-menu')?.remove();
    const m = el('div', 'fg-menu');
    m.setAttribute('role', 'menu');
    const item = (label: string, act: () => void) => {
      const b = el('button', '', label);
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        m.remove();
        act();
      });
      m.append(b);
    };
    if (!dir) item('Open', () => void openFile(project, rel));
    item(fileManagerLabel(), () => void mod('files:reveal', project.id, rel));
    item('Copy relative path', () => void navigator.clipboard.writeText(rel));
    m.style.left = `${Math.min(at.clientX, window.innerWidth - 190)}px`;
    m.style.top = `${Math.min(at.clientY, window.innerHeight - 110)}px`;
    document.body.append(m);
    const close = (ev: Event) => {
      if (!m.contains(ev.target as Node)) {
        m.remove();
        document.removeEventListener('mousedown', close, true);
      }
    };
    document.addEventListener('mousedown', close, true);
    (m.firstChild as HTMLElement)?.focus();
  }

  function paint(): void {
    const all: { rel: string; entry: Entry; depth: number }[] = [];
    rows('', 0, all);
    if (!tree.kids.has('')) {
      list.replaceChildren(note('Loading the files…'));
      return;
    }
    if (!all.length) {
      list.replaceChildren(note('This folder is empty.'));
      return;
    }
    list.replaceChildren(
      ...all.map(({ rel, entry, depth }) => {
        const row = el('div', 'tree-row');
        row.dataset.path = rel;
        row.setAttribute('role', 'treeitem');
        row.tabIndex = 0;
        row.title = rel;
        row.style.paddingLeft = `${10 + depth * 14}px`;
        if (entry.dir) row.setAttribute('aria-expanded', String(tree.expanded.has(rel)));
        row.setAttribute('aria-selected', String(tree.selected === rel));
        if (entry.ignored) row.classList.add('ignored');
        const twisty = el('span', 'twisty');
        if (entry.dir) twisty.append(icon(tree.expanded.has(rel) ? 'chevronDown' : 'chevronRight'));
        row.append(twisty, icon(entry.dir ? 'folder' : 'file', 'kind'), el('span', 'name', entry.name));
        const act = () => {
          if (entry.dir) void toggle(rel);
          else {
            tree.selected = rel;
            paint();
            void openFile(project, rel);
          }
        };
        row.addEventListener('click', act);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            act();
          }
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          menu(e, rel, entry.dir);
        });
        return row;
      }),
    );
  }

  poll('files', 2000, live, async () => {
    // Only the folders on screen are asked; a changed stamp means a file came or went in that folder.
    const open = ['', ...tree.expanded];
    let stamps: Record<string, string | null>;
    try {
      stamps = await call('files:stamps', project.id, open);
    } catch {
      return;
    }
    const changed = open.filter((rel) => tree.stamps.get(rel) !== stamps[rel]);
    if (!changed.length) return;
    for (const rel of changed) {
      try {
        if (stamps[rel] === null) {
          tree.expanded.delete(rel);
          tree.kids.delete(rel);
          tree.stamps.delete(rel);
        } else {
          await load(rel);
        }
      } catch {
        // The next poll tries again.
      }
    }
    if (live()) paint();
  });

  paint();
  return refreshAll();
}

// ---------- Git ----------

interface Change { path: string; originalPath?: string; kind: string; area: 'staged' | 'unstaged' | 'conflicted' }
interface RepoStatus {
  hooksSkipped?: boolean;
  repo: boolean;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: Change[];
  unstaged?: Change[];
  conflicted?: Change[];
}
interface CommitRow { hash: string; short: string; author: string; time: number; subject: string }

const messages = new Map<string, string>();
const LETTERS: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typeChanged: 'T', untracked: 'U', conflicted: '!' };
const KIND_WORDS: Record<string, string> = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typeChanged: 'Type changed', untracked: 'New file', conflicted: 'Conflict' };

function ago(seconds: number): string {
  const diff = Math.round(seconds - Date.now() / 1000);
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return f.format(diff, 'second');
  if (abs < 3600) return f.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return f.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return f.format(Math.round(diff / 86400), 'day');
  return f.format(Math.round(diff / (86400 * 30)), 'month');
}

function renderGit(body: HTMLElement, project: ProjectInfo, live: () => boolean): Promise<void> {
  if (project.server) {
    body.append(note(serverNote(project.server, project.path)));
    return Promise.resolve();
  }
  const bar = el('div', 'fg-head');
  const branchButton = el('button', 'branch side-button');
  branchButton.type = 'button';
  branchButton.setAttribute('aria-haspopup', 'listbox');
  const branchLabel = el('span', 'branch-label', 'Branch');
  branchButton.append(icon('branch'), branchLabel, icon('chevronDown'));
  const sync = el('span', 'fg-sync');
  bar.append(branchButton, sync, iconButton('refresh', 'Refresh', () => void refresh()));
  const branchMenu = el('div', 'branch-menu');
  branchMenu.hidden = true;
  const error = el('p', 'fg-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const compose = el('div', 'compose');
  const text = el('textarea');
  text.placeholder = 'Message (what changed and why)';
  text.rows = 2;
  text.setAttribute('aria-label', 'Commit message');
  text.value = messages.get(project.id) ?? '';
  const commitButton = el('button', 'commit side-button primary', 'Commit');
  commitButton.type = 'button';
  compose.append(text, commitButton);
  const lists = el('div', 'changes');
  const history = el('div', 'history');
  body.append(bar, branchMenu, error, compose, lists, history);

  let status: RepoStatus | null = null;
  let seen = '';
  const fail = (e: unknown) => {
    error.textContent = (e as Error).message;
    error.hidden = false;
  };
  const guard = async (work: () => Promise<unknown>) => {
    error.hidden = true;
    try {
      await work();
    } catch (e) {
      fail(e);
    }
    await refresh();
  };

  const syncCommit = () => {
    commitButton.disabled = !status?.repo || !(status.staged?.length) || !text.value.trim();
    commitButton.title = !status?.staged?.length ? 'Stage the files to commit first' : !text.value.trim() ? 'Write a message first' : 'Commit the staged files';
  };
  text.addEventListener('input', () => {
    messages.set(project.id, text.value);
    syncCommit();
  });
  text.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !commitButton.disabled) commitButton.click();
  });
  commitButton.addEventListener('click', () =>
    void guard(async () => {
      await call('git:commit', project.id, text.value);
      text.value = '';
      messages.delete(project.id);
    }),
  );

  // ---- branches ----
  async function openBranches(): Promise<void> {
    if (!branchMenu.hidden) {
      branchMenu.hidden = true;
      branchButton.setAttribute('aria-expanded', 'false');
      return;
    }
    error.hidden = true;
    try {
      const { current, branches } = await call<{ current: string | null; branches: string[] }>('git:branches', project.id);
      branchMenu.replaceChildren(
        ...branches.map((name) => {
          const b = el('button', 'branch-item');
          b.type = 'button';
          b.dataset.branch = name;
          b.setAttribute('role', 'option');
          b.setAttribute('aria-selected', String(name === current));
          b.append(icon(name === current ? 'check' : 'branch'), el('span', '', name));
          b.addEventListener('click', () => {
            branchMenu.hidden = true;
            if (name !== current) void guard(() => call('git:switch', project.id, name));
          });
          return b;
        }),
      );
      const create = el('form', 'branch-new');
      const input = el('input');
      input.placeholder = 'New branch name';
      input.setAttribute('aria-label', 'New branch name');
      const go = el('button', 'side-button', 'Create');
      go.type = 'submit';
      create.append(input, go);
      create.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!input.value.trim()) return;
        branchMenu.hidden = true;
        void guard(() => call('git:create', project.id, input.value));
      });
      branchMenu.append(create);
      branchMenu.hidden = false;
      branchButton.setAttribute('aria-expanded', 'true');
    } catch (e) {
      fail(e);
    }
  }
  branchButton.addEventListener('click', () => void openBranches());

  // ---- lists ----
  function changeRow(c: Change): HTMLElement {
    const row = el('div', 'change');
    row.dataset.change = `${c.area}|${c.path}`;
    row.tabIndex = 0;
    const name = c.path.split('/').pop() ?? c.path;
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';
    const letter = el('span', `letter k-${c.kind}`, LETTERS[c.kind] ?? '?');
    letter.title = KIND_WORDS[c.kind] ?? c.kind;
    const label = el('span', 'name', name);
    label.title = c.path;
    row.append(letter, label, el('span', 'dir', dir));
    const open = () =>
      void openPatch(project, `diff:${c.area}:${c.path}`, c.area === 'staged' ? `${name} (staged)` : `${name} (changes)`, 'fileCode', () => call('git:diff', project.id, c));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
    if (c.area === 'staged') {
      row.append(iconButton('minus', 'Unstage', () => void guard(() => call('git:unstage', project.id, [c.path, ...(c.originalPath ? [c.originalPath] : [])]))));
    } else if (c.area === 'unstaged') {
      row.append(iconButton('plus', 'Stage', () => void guard(() => call('git:stage', project.id, [c.path]))));
    }
    return row;
  }

  function group(title: string, changes: Change[], all?: { label: string; act: () => void }): HTMLElement | null {
    if (!changes.length) return null;
    const box = el('section', 'group');
    const h = el('div', 'group-head');
    h.append(el('span', 'group-title', `${title} (${changes.length})`));
    if (all) {
      const b = el('button', 'link', all.label);
      b.type = 'button';
      b.addEventListener('click', all.act);
      h.append(b);
    }
    box.append(h, ...changes.map(changeRow));
    return box;
  }

  function paint(commits: CommitRow[]): void {
    if (!status?.repo) {
      bar.hidden = true;
      compose.hidden = true;
      history.replaceChildren();
      const init = el('button', 'side-button primary', 'Create a repository');
      init.addEventListener('click', () => void guard(() => call('git:init', project.id)));
      lists.replaceChildren(note('This folder is not a git repository. Git tracks changes so that you can go back to an earlier version.'), init);
      return;
    }
    bar.hidden = false;
    compose.hidden = false;
    branchLabel.textContent = status.branch ?? 'No branch (detached)';
    sync.textContent = [status.ahead ? `${status.ahead} to push` : '', status.behind ? `${status.behind} to pull` : ''].filter(Boolean).join(' · ');
    const staged = status.staged ?? [];
    const unstaged = status.unstaged ?? [];
    const conflicted = status.conflicted ?? [];
    const parts = [
      group('Conflicts', conflicted),
      group('Staged changes', staged, { label: 'Unstage all', act: () => void guard(() => call('git:unstage', project.id, staged.flatMap((c) => [c.path, ...(c.originalPath ? [c.originalPath] : [])]))) }),
      group('Changes', unstaged, { label: 'Stage all', act: () => void guard(() => call('git:stage', project.id, unstaged.map((c) => c.path))) }),
    ].filter((p): p is HTMLElement => !!p);
    lists.replaceChildren(...(parts.length ? parts : [note('No changes. The files match the last commit.')]), ...(status.hooksSkipped ? [note(HOOKS_NOTE)] : []));
    const h = el('div', 'group-head');
    h.append(el('span', 'group-title', 'History'));
    const items = commits.length
      ? commits.map((c) => {
          const row = el('div', 'commit-row');
          row.dataset.commit = c.hash;
          row.tabIndex = 0;
          row.append(icon('commit', 'kind'), el('span', 'name', c.subject), el('span', 'dir', `${c.author} · ${ago(c.time)}`));
          row.title = `${c.short} · ${c.subject}`;
          const open = () => void openPatch(project, `commit:${c.hash}`, c.short, 'commit', () => call('git:show', project.id, c.hash));
          row.addEventListener('click', open);
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') open();
          });
          return row;
        })
      : [note('No commits yet. Stage files and write a message to make the first one.')];
    history.replaceChildren(h, ...items);
    syncCommit();
  }

  async function refresh(): Promise<void> {
    try {
      const next = await call<RepoStatus>('git:status', project.id);
      const commits = next.repo ? await call<CommitRow[]>('git:log', project.id, 30) : [];
      if (!live()) return;
      // Nothing changed: leave the lists alone, so a click or a scroll in them is not lost.
      const key = JSON.stringify([next, commits.map((c) => c.hash)]);
      if (key === seen) return;
      seen = key;
      status = next;
      paint(commits);
    } catch (e) {
      if (live()) fail(e);
    }
  }

  poll('git', 3000, live, refresh);
  return refresh();
}

export const filesGitModule: RendererModule = {
  name: 'files-git',
  sections: [
    { id: 'files', title: 'Files', icon: 'folder', label: 'Files', help: `Files (${api.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+E)`, render: (b, p, live) => renderFiles(b, p, live) },
    { id: 'git', title: 'Source Control', icon: 'branch', label: 'Git', help: `Source Control (${api.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+G)`, render: (b, p, live) => renderGit(b, p, live) },
  ],
};
