import { openDoc, showPage } from './docs';
import type { ProjectInfo } from './frame';
import { icon } from './icons';
import type { RendererModule } from './modules';
import { renderMarkdown, lf } from './notesMarkdown';

// Notes: a sidebar list with search, and a document tab per note with a Markdown preview, an editor and autosave.
// The files and their rules live in main/notes.ts; the page asks over the mod:notes:* channels.

const api = (window as any).vibex;
const ask = (channel: string, ...args: unknown[]): Promise<any> => api.mod.invoke(`mod:notes:${channel}`, ...args);
const AUTOSAVE_MS = 900;

interface Item { id: string; source: 'memory' | 'notes'; relativePath: string; name: string; label: string; isIndex: boolean; tags: string[] }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function textButton(label: string, title: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'side-button note-primary' : 'side-button', label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function iconButton(name: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
}

function emptyState(title: string, text: string): HTMLElement {
  const box = el('div', 'side-empty');
  box.append(el('p', 'empty-title', title), el('p', 'empty-text', text));
  return box;
}

// ---------- the document tab ----------

/// The editors that are open, by project and note, so a second click on a note shows the first one with its unsaved text.
const editors = new Map<string, { element: HTMLElement; close: () => void }>();

function openNote(project: ProjectInfo, id: string, title: string): void {
  const key = `${project.id}|${id}`;
  const existing = editors.get(key);
  const editor = existing ?? createEditor(project, id, () => editors.delete(key));
  editors.set(key, editor);
  openDoc(project.id, { key: `note:${id}`, title, icon: 'book', element: editor.element, onClose: editor.close });
}

function createEditor(project: ProjectInfo, id: string, forget: () => void): { element: HTMLElement; close: () => void } {
  const root = el('div', 'note-doc');
  const head = el('div', 'note-head');
  const titleBox = el('div', 'note-titles');
  const title = el('h2', 'note-title', 'Reading…');
  const where = el('span', 'note-where');
  titleBox.append(title, where);
  const status = el('span', 'note-status');
  status.setAttribute('role', 'status');
  const toggle = textButton('Edit', 'Edit this note. Your changes are saved by themselves.', () => setMode(mode === 'edit' ? 'preview' : 'edit'));
  const saveNow = textButton('Save', 'Save now (Ctrl+S)', () => void save(), true);
  head.append(titleBox, status, toggle, saveNow);

  const banner = el('div', 'note-banner');
  banner.hidden = true;
  const area = el('textarea', 'note-edit') as HTMLTextAreaElement;
  area.spellcheck = false;
  area.setAttribute('aria-label', 'Note text');
  area.hidden = true;
  const preview = el('div', 'note-preview md');
  const meta = el('div', 'note-meta');
  root.append(head, banner, preview, area, meta);

  let loaded = false;
  let mode: 'preview' | 'edit' = 'preview';
  /// The text as the file holds it (its own line ends). The textarea always gives LF, so the two are compared after `lf`.
  let base = '';
  let eol: '\r\n' | '\n' = '\n';
  let links: { target: string; isPath: boolean; id: string | null }[] = [];
  let refused: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  /// The save in progress, so a close waits for it instead of saving the same edit twice.
  let inflight: Promise<void> = Promise.resolve();
  let blocked = false;
  let closed = false;
  const toDisk = (t: string) => (eol === '\r\n' ? t.replace(/\n/g, '\r\n') : t);
  const adopt = (t: string) => {
    base = t;
    const crlf = (t.match(/\r\n/g) ?? []).length;
    eol = crlf > 0 && crlf >= (t.match(/\n/g) ?? []).length / 2 ? '\r\n' : '\n';
  };
  const dirty = () => loaded && area.value !== lf(base);

  const say = (text: string, kind: '' | 'ok' | 'error' = '') => {
    status.textContent = text;
    status.className = `note-status ${kind}`;
  };

  const linkTargets = () => ({
    wiki: (t: string) => links.find((l) => !l.isPath && l.target.split('#')[0].trim() === t)?.id ?? null,
    path: (t: string) => links.find((l) => l.isPath && l.target === t)?.id ?? null,
  });
  const paint = () => {
    preview.innerHTML = renderMarkdown(area.value, linkTargets());
    if (!preview.textContent?.trim()) preview.replaceChildren(el('p', 'note-blank', 'This note is empty.'));
  };

  function setMode(next: 'preview' | 'edit'): void {
    if (next === 'edit' && refused) return say(refused, 'error');
    mode = next;
    area.hidden = next !== 'edit';
    preview.hidden = next === 'edit';
    toggle.textContent = next === 'edit' ? 'Preview' : 'Edit';
    if (next === 'edit') area.focus();
    else { paint(); void save(); }
  }

  function showBanner(text: string, buttons: HTMLButtonElement[]): void {
    banner.replaceChildren(el('p', '', text), ...buttons);
    banner.hidden = false;
  }

  async function load(keepDraft = false): Promise<void> {
    const r = await ask('read', project.id, id);
    if (closed) return;
    if (!r.ok) {
      preview.replaceChildren(emptyState('This note did not open', r.message), textButton('Try again', 'Read the note again', () => void load()));
      say('', '');
      return;
    }
    title.textContent = r.name;
    where.textContent = r.label;
    refused = r.refusal;
    links = r.links;
    const keep = keepDraft && dirty();
    adopt(r.text);
    if (!keep) area.value = lf(r.text);
    loaded = true;
    blocked = false;
    banner.hidden = true;
    toggle.disabled = !!refused;
    toggle.title = refused ?? 'Edit this note. Your changes are saved by themselves.';
    saveNow.hidden = true;
    paint();
    say(refused ? 'Read only' : '');
    meta.replaceChildren();
    if (r.tags.length) {
      const tags = el('div', 'note-tags');
      for (const t of r.tags) {
        const a = el('a', 'tag', `#${t}`);
        a.href = '#';
        a.dataset.tag = t;
        tags.append(a);
      }
      meta.append(tags);
    }
    if (r.backlinks.length) {
      const back = el('div', 'note-back');
      back.append(el('span', 'side-label', 'Linked from'));
      for (const b of r.backlinks) {
        const a = el('a', 'wiki', b.label);
        a.href = '#';
        a.dataset.note = b.id;
        back.append(a);
      }
      meta.append(back);
    }
  }

  async function save(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty() || saving || blocked) return;
    saving = true;
    const text = toDisk(area.value);
    say('Saving…');
    let done!: () => void;
    inflight = new Promise<void>((resolve) => { done = resolve; });
    const r = await ask('save', project.id, id, text, base).finally(() => { saving = false; done(); });
    if (r.ok) {
      adopt(text);
      saveNow.hidden = true;
      say('Saved', 'ok');
      if (dirty()) schedule();
      return;
    }
    saveNow.hidden = false;
    if (r.conflict) return conflict(r.message);
    say('Not saved', 'error');
    showBanner(r.message, [textButton('Try again', 'Save again', () => { banner.hidden = true; void save(); })]);
  }

  /// The file changed on disk. The text in the editor stays; the person picks what happens to it.
  function conflict(message: string): void {
    blocked = true;
    say('Not saved', 'error');
    showBanner(`${message} Pick one: keep your text and replace the file, save your text as a copy, or load the file and drop your text.`, [
      textButton('Replace the file', 'Write your text over the file on disk', async () => {
        const fresh = await ask('read', project.id, id);
        if (!fresh.ok) return say(fresh.message, 'error');
        adopt(fresh.text);
        blocked = false;
        banner.hidden = true;
        void save();
      }),
      textButton('Save as a copy', 'Keep your text in a new file next to the note', async () => {
        const r = await ask('save-copy', project.id, id, toDisk(area.value));
        if (!r.ok) return say(r.message, 'error');
        banner.querySelector('p')!.textContent = `${r.message} Now load the file or replace it.`;
      }),
      textButton('Load the file', 'Drop your text and show the file as it is on disk', () => void load()),
    ]);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  area.addEventListener('input', () => {
    saveNow.hidden = false;
    say('Unsaved');
    if (!blocked) schedule();
  });
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  });
  area.addEventListener('blur', () => void save());

  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    if (a.dataset.note) openNote(project, a.dataset.note, a.dataset.note.split(/[\\/]/).pop()!.replace(/\.md$/i, ''));
    else if (a.dataset.web) { void api.browser.navigate(a.dataset.web); showPage(); }
    else if (a.dataset.tag) void searchFor(`#${a.dataset.tag}`);
  });

  // A change made by Obsidian or by Claude shows up when the window comes back, unless an edit waits.
  const refresh = () => { if (loaded && !closed && !dirty() && !saving) void load(); };
  const unload = () => { if (dirty() && !blocked) api.mod.send('mod:notes:flush', project.id, id, toDisk(area.value), base); };
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', unload);
  window.addEventListener('beforeunload', unload);

  /// A close saves what is unsaved. If the file cannot take it (it changed on disk), the text goes to a copy next to the
  /// note: closing a tab never drops text.
  const close = () => {
    closed = true;
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pagehide', unload);
    window.removeEventListener('beforeunload', unload);
    forget();
    void (async () => {
      if (timer) clearTimeout(timer);
      await inflight;
      if (!dirty()) return;
      const text = toDisk(area.value);
      const r = blocked ? { ok: false } : await ask('save', project.id, id, text, base);
      if (!r.ok) await ask('save-copy', project.id, id, text);
    })();
  };

  void load();
  return { element: root, close };
}

// ---------- the sidebar ----------

let query = '';

/// Puts a query in the search box of the sidebar, opening the Notes section first if it is shut.
async function searchFor(text: string): Promise<void> {
  query = text;
  let input = document.querySelector<HTMLInputElement>('#sidebar-body .notes-search');
  if (!input) {
    (document.querySelector('#activity [data-activity="notes"]') as HTMLElement | null)?.click();
    for (let i = 0; i < 20 && !input; i++) {
      await new Promise((r) => setTimeout(r, 50));
      input = document.querySelector<HTMLInputElement>('#sidebar-body .notes-search');
    }
  }
  if (input) { input.value = text; input.dispatchEvent(new Event('input')); }
}

async function renderSidebar(body: HTMLElement, project: ProjectInfo, live: () => boolean): Promise<void> {
  if (project.server) {
    body.append(emptyState('Notes of a server project', 'They are not in this build. Open the folder on this computer to use its notes.'));
    return;
  }
  const bar = el('div', 'notes-bar');
  const input = el('input', 'notes-search') as HTMLInputElement;
  input.type = 'search';
  input.placeholder = 'Search notes';
  input.setAttribute('aria-label', 'Search notes');
  input.value = query;
  const reload = iconButton('refresh', 'Read the files again', () => void render());
  const pick = iconButton('folderPlus', "Choose this project's notes folder in the vault", async () => {
    const r = await ask('pick', project.id);
    if (!r.ok) list.replaceChildren(emptyState('That folder does not work', r.message));
    else if (r.folder !== null) void render();
  });
  bar.append(input, reload, pick);
  const suggestion = el('div', 'notes-suggest');
  suggestion.hidden = true;
  const list = el('div', 'notes-list');
  list.setAttribute('role', 'list');
  body.append(bar, suggestion, list);

  let items: Item[] = [];
  let order: { id: string; line?: string }[] | null = null;
  let generation = 0;

  const row = (item: Item, line?: string) => {
    const b = el('button', 'note-row');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.title = item.label;
    b.append(icon('book', 'note-row-icon'), el('span', 'note-row-name', item.name), el('span', 'note-row-path', item.relativePath));
    if (line) b.append(el('span', 'note-row-line', line));
    b.addEventListener('click', () => openNote(project, item.id, item.name));
    return b;
  };

  function paint(): void {
    const byId = new Map(items.map((i) => [i.id, i]));
    const shown: { item: Item; line?: string }[] = order ? order.flatMap((o) => (byId.has(o.id) ? [{ item: byId.get(o.id)!, line: o.line }] : [])) : items.map((item) => ({ item }));
    if (!shown.length) return list.replaceChildren(emptyState(order ? 'No note matches' : 'No notes yet', order ? 'Every word must match. Try fewer words, or #tag.' : 'This folder has no Markdown files.'));
    const groups: [string, typeof shown][] = [['Memory', shown.filter((s) => s.item.source === 'memory')], ['Notes', shown.filter((s) => s.item.source === 'notes')]];
    list.replaceChildren(...groups.filter(([, g]) => g.length).flatMap(([name, g]) => [el('div', 'side-label notes-group', `${name} (${g.length})`), ...g.map((s) => row(s.item, s.line))]));
  }

  async function runSearch(): Promise<void> {
    const mine = ++generation;
    if (!input.value.trim()) { order = null; return paint(); }
    const r = await ask('search', project.id, input.value);
    if (mine !== generation || !live()) return;
    if (!r.ok) return list.replaceChildren(emptyState('The search failed', r.message));
    order = r.matches.map((m: any) => ({ id: m.id, line: m.lines[0]?.text }));
    paint();
  }

  let typing: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    query = input.value;
    if (typing) clearTimeout(typing);
    typing = setTimeout(() => void runSearch(), 150);
  });

  async function render(): Promise<void> {
    list.replaceChildren(el('p', 'note-blank', 'Reading the notes…'));
    const r = await ask('list', project.id);
    if (!live()) return;
    if (!r.ok) {
      list.replaceChildren(emptyState('The notes did not load', r.message), textButton('Try again', 'Read the notes again', () => void render()));
      return;
    }
    items = r.items;
    suggestion.hidden = !r.suggested;
    if (r.suggested) {
      suggestion.replaceChildren(
        el('p', 'empty-text', `This project's .vibex.json suggests the notes folder "${r.suggested}". Use it?`),
        textButton('Use', 'Use this folder for notes', async () => { await ask('choose', project.id, r.suggested); void render(); }),
        textButton('No', 'Do not use it, and do not ask again', async () => { await ask('choose', project.id, ''); void render(); }),
      );
    }
    if (!r.memory && !r.notes) {
      list.replaceChildren(emptyState('No notes for this project', `Keep a .claude/memory folder in the project, or choose a notes folder inside the vault ${r.vault} with the folder button.`));
      return;
    }
    if (input.value.trim()) await runSearch();
    else paint();
    if (r.capped) list.append(el('p', 'note-blank', 'More than 5,000 notes: the rest is left out.'));
  }

  await render();
}

export const notesModule: RendererModule = {
  name: 'notes',
  sections: [{
    id: 'notes',
    title: 'Notes',
    icon: 'book',
    label: 'Notes',
    help: "Notes: this project's memory and its notes folder",
    render: renderSidebar,
  }],
};
