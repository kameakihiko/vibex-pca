import { CHAT_PANES, chatFirstEdition, setChatFirstProbe } from './chatFirst';
import { icon } from './icons';
import { RENDERER_MODULES } from './modules';
import { openServerForm } from './servers';
import { openSetup } from './setup';

// The frame around the three columns, as in macOS Vibex (Layout/ProjectRail, ActivityBar, Sidebar): the project rail,
// the activity bar, the sidebar, the columns and the welcome view. It knows nothing about terminals or pages.

export type PaneName = 'agent' | 'browser' | 'shell';
type SectionId = string;

export interface ProjectInfo { id: string; name: string; path: string; server?: string; monogram: string; tint: number }
export interface ProjectsSnapshot { projects: ProjectInfo[]; current: string | null; recents: { name: string; path: string; server?: string }[]; known?: string[] }

export interface FrameHooks {
  /// Another project (or none) is on screen now.
  projectShown: (project: ProjectInfo | null) => void;
  /// The columns moved or changed size.
  layoutChanged: () => void;
  /// The person brought back this pane; it takes the focus.
  paneOpened: (pane: PaneName) => void;
  /// The person hid this pane; the keyboard must not stay in it.
  paneHidden: (pane: PaneName) => void;
}

/// What each project remembers (macOS Vibex keeps it per window too).
interface ProjectFrame {
  panes: Record<PaneName, boolean>;
  sidebar: SectionId | null;
  columns: Record<PaneName, number> | null;
  /// The chat layout of the PCA edition (./chatFirst.ts): new in this edition, or taken from the offer.
  chat: boolean;
  /// The person closed the offer of the chat layout in this project; it does not come back.
  offerClosed: boolean;
}

const PANES: PaneName[] = ['agent', 'browser', 'shell'];
const DEFAULT_COLUMNS: Record<PaneName, number> = { agent: 1, browser: 1.15, shell: 0.85 };
const MIN_COLUMN = 260;
/// Narrower than this, a terminal wraps each word and the address bar has no room. The smallest window holds three.
const PANE_MIN = 170;
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const RAIL_KEY = 'vibex.rail.hidden';
const SIDEBAR_KEY = 'vibex.sidebar.width';
const frameKey = (id: string) => `vibex.frame.${id}`;
/// Set at the first start of a chat-first build. The projects open before it keep the three columns they had.
const CHAT_SINCE_KEY = 'vibex.chatfirst.since';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

const threeColumns = (): ProjectFrame => ({ panes: { agent: true, browser: true, shell: true }, sidebar: null, columns: null, chat: false, offerClosed: false });

/// A project with no saved record: the chat layout in a chat-first edition, else the three columns.
function freshFrame(): ProjectFrame {
  return chatFirstEdition() ? { ...threeColumns(), panes: { ...CHAT_PANES }, chat: true } : threeColumns();
}

function readFrame(id: string): ProjectFrame | null {
  const fresh = threeColumns();
  try {
    const saved = JSON.parse(read(frameKey(id)) || 'null');
    if (!saved) return null;
    const panes = { agent: saved.panes?.agent !== false, browser: saved.panes?.browser !== false, shell: saved.panes?.shell !== false };
    const columns = PANES.every((p) => saved.columns?.[p] > 0) ? saved.columns : null;
    const known = ['files', 'git', 'agents', 'skills', 'mcp', ...RENDERER_MODULES.flatMap((m) => m.sections ?? []).map((s) => s.id)];
    const sidebar = known.includes(saved.sidebar) ? saved.sidebar : null;
    return { panes: PANES.some((p) => panes[p]) ? panes : fresh.panes, sidebar, columns, chat: saved.chat === true, offerClosed: saved.offerClosed === true };
  } catch {
    // A record that does not parse was a saved layout: the three columns, as before.
    return fresh;
  }
}

/// Seam for feature modules: the number of things a project's Claude waits for (a question, a go), shown on its rail tile.
const railBadges = new Map<string, number>();
function paintBadge(tile: Element, count: number): void {
  tile.querySelector('.rail-badge')?.remove();
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'rail-badge';
    badge.textContent = count > 99 ? '99+' : String(count);
    tile.querySelector('.mono')?.append(badge);
  }
  if (count > 0) tile.setAttribute('aria-label', `${tile.querySelector('.name')?.textContent ?? ''}, ${count} waiting for you`);
  else tile.removeAttribute('aria-label');
}
export function setRailBadge(projectId: string, count: number): void {
  if (count > 0) railBadges.set(projectId, count);
  else railBadges.delete(projectId);
  const tile = document.querySelector(`.tile[data-project="${CSS.escape(projectId)}"]`);
  if (tile) paintBadge(tile, count);
}

export function createFrame(api: any, hooks: FrameHooks) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const mod = api.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const workspace = $('workspace');
  const sidebar = $('sidebar');
  const sideSplitter = $('sidebar-splitter');
  const splitters = [...workspace.querySelectorAll<HTMLElement>(':scope > .splitter')];
  const paneEl = (pane: PaneName) => workspace.querySelector<HTMLElement>(pane === 'browser' ? '#browser-pane' : `.terminal-pane[data-pane="${pane}"]`)!;

  let snapshot: ProjectsSnapshot = { projects: [], current: null, recents: [] };
  const frames = new Map<string, ProjectFrame>();
  let railHidden = read(RAIL_KEY) === 'true';
  /// The folder picker for server projects takes the place of the columns while it shows.
  let picking = false;
  let servers: { name: string; projectPath?: string }[] = [];

  const current = () => snapshot.projects.find((p) => p.id === snapshot.current) ?? null;
  const saveFrame = (id: string) => write(frameKey(id), JSON.stringify(frameOf(id)));
  const frameOf = (id: string): ProjectFrame => {
    if (!frames.has(id)) {
      const saved = readFrame(id);
      // Before the first chat-first start has kept the older projects (a pane message can come before the first list),
      // a project with no record is one of them.
      const older = chatFirstEdition() && !read(CHAT_SINCE_KEY);
      frames.set(id, saved ?? (older ? threeColumns() : freshFrame()));
      // A new project's layout is saved at once: the next start must not take it for an older project.
      if (!saved) saveFrame(id);
    }
    return frames.get(id)!;
  };
  setChatFirstProbe((id) => frameOf(id).chat);

  /// The first start of a chat-first build: each project open from before keeps the three columns it showed, as a saved
  /// layout. Only projects opened after this start get the chat layout.
  function keepOlderLayouts(next: ProjectsSnapshot): void {
    if (!chatFirstEdition() || read(CHAT_SINCE_KEY)) return;
    // Open, held back (a server not in the list now), recent, and every folder the saved list named.
    for (const id of new Set([...next.projects.map((p) => p.id), ...(next.known ?? [])])) {
      if (read(frameKey(id)) === null) write(frameKey(id), JSON.stringify(threeColumns()));
    }
    write(CHAT_SINCE_KEY, '1');
  }
  /// The widths a person had before a tool set a layout mode, per project.
  const ownColumns = new Map<string, { columns: Record<PaneName, number> | null; panes: Record<PaneName, boolean> }>();

  // ---------- activity bar ----------

  const SECTIONS: Record<string, { title: string; icon: string; label: string; help: string }> = {
    files: { title: 'Files', icon: 'folder', label: 'Files', help: `Files (${mod}+Shift+E)` },
    git: { title: 'Source Control', icon: 'branch', label: 'Git', help: `Source Control (${mod}+Shift+G)` },
    agents: { title: 'Agents', icon: 'users', label: 'Agents', help: `Agents (${mod}+Shift+A)` },
    skills: { title: 'Skills', icon: 'puzzle', label: 'Skills', help: `Skills (${mod}+Shift+K)` },
    mcp: { title: 'MCP Servers', icon: 'server', label: 'MCP', help: `MCP Servers: tools for Claude Code (${mod}+Shift+M)` },
  };
  const PANE_BUTTONS: Record<PaneName, { icon: string; label: string; help: string }> = {
    agent: { icon: 'sparkles', label: 'Claude', help: `Show or hide Claude (${mod}+1)` },
    browser: { icon: 'globe', label: 'Browser', help: `Show or hide the browser (${mod}+2)` },
    shell: { icon: 'command', label: 'Command', help: `Show or hide the command terminal (${mod}+3)` },
  };

  function button(name: string, iconName: string, label: string, help: string): void {
    const b = document.createElement('button');
    b.dataset.activity = name;
    b.title = help;
    // Short windows hide the words; the name stays.
    b.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.className = 'activity-label';
    text.textContent = label;
    b.append(icon(iconName), text);
    b.addEventListener('click', () => activity(name));
    $('activity').appendChild(b);
  }
  function divider(): void {
    const line = document.createElement('div');
    line.className = 'activity-divider';
    $('activity').appendChild(line);
  }

  button('rail', 'grid', 'Projects', `Show or hide the project rail (${api.platform === 'darwin' ? 'Cmd+Alt+P' : 'Ctrl+Shift+B'})`);
  divider();
  for (const pane of PANES) button(pane, PANE_BUTTONS[pane].icon, PANE_BUTTONS[pane].label, PANE_BUTTONS[pane].help);
  divider();
  const moduleSections = new Map(RENDERER_MODULES.flatMap((m) => m.sections ?? []).map((s) => [s.id, s]));
  for (const s of moduleSections.values()) SECTIONS[s.id] = { title: s.title, icon: s.icon, label: s.label, help: s.help };
  for (const id of Object.keys(SECTIONS)) button(id, SECTIONS[id].icon, SECTIONS[id].label, SECTIONS[id].help);

  function activity(name: string): void {
    // The tests read this: which pane moved, and when (a layout test failed once with a pane hidden by nothing it did).
    console.debug(`vibex activity ${name}`);
    if (name === 'rail') {
      railHidden = !railHidden;
      write(RAIL_KEY, String(railHidden));
      applyLayout();
      return;
    }
    const project = current();
    if (!project) return;
    const frame = frameOf(project.id);
    if ((PANES as string[]).includes(name)) {
      const pane = name as PaneName;
      if (frame.panes[pane]) {
        // The last pane stays: a window with no pane has no place to type.
        if (PANES.filter((p) => frame.panes[p]).length === 1) return;
        frame.panes[pane] = false;
      } else {
        frame.panes[pane] = true;
      }
      saveFrame(project.id);
      applyLayout();
      if (frame.panes[pane]) hooks.paneOpened(pane);
      else hooks.paneHidden(pane);
      return;
    }
    frame.sidebar = frame.sidebar === name ? null : (name as SectionId);
    saveFrame(project.id);
    applyLayout();
  }

  /// Something runs in this pane (a tool call): the person must be able to watch it, as in macOS Vibex.
  function revealPane(id: string, pane: PaneName): void {
    const frame = frameOf(id);
    if (frame.panes[pane]) return;
    frame.panes[pane] = true;
    saveFrame(id);
    if (id === snapshot.current) applyLayout();
  }

  // ---------- the offer of the chat layout, for a project that kept an older layout ----------

  const offer = document.createElement('div');
  offer.id = 'chat-layout-offer';
  offer.setAttribute('role', 'note');
  offer.hidden = true;
  const offerText = document.createElement('span');
  offerText.className = 'chat-layout-offer-text';
  // One short question fits a third of the window; the rest is in the tooltip.
  offerText.textContent = 'Give Claude the whole window?';
  offer.title = 'The browser and the terminal stay one click away, on their buttons on the left.';
  const offerUse = document.createElement('button');
  offerUse.id = 'chat-layout-use';
  offerUse.className = 'side-button small';
  offerUse.textContent = 'Use the chat layout';
  const offerClose = document.createElement('button');
  offerClose.id = 'chat-layout-close';
  offerClose.className = 'icon-button';
  offerClose.title = 'Keep this layout';
  offerClose.setAttribute('aria-label', 'Keep this layout');
  offerClose.append(icon('close'));
  offer.append(icon('layout', 'chat-layout-offer-icon'), offerText, offerUse, offerClose);
  // Below the Claude tabs, so they stay level with the browser and terminal tabs.
  paneEl('agent').querySelector('.tabstrip')!.after(offer);

  offerUse.addEventListener('click', () => {
    const project = current();
    if (!project) return;
    const frame = frameOf(project.id);
    const hidden = PANES.filter((p) => frame.panes[p] && !CHAT_PANES[p]);
    // The person's widths stay, not a tool's: a pane opened again comes back as wide as it was.
    const own = ownColumns.get(project.id);
    if (own) frame.columns = own.columns;
    ownColumns.delete(project.id);
    frame.panes = { ...CHAT_PANES };
    frame.chat = true;
    saveFrame(project.id);
    applyLayout();
    for (const pane of hidden) hooks.paneHidden(pane);
    hooks.paneOpened('agent');
  });
  offerClose.addEventListener('click', () => {
    const project = current();
    if (!project) return;
    frameOf(project.id).offerClosed = true;
    saveFrame(project.id);
    applyLayout();
  });

  // ---------- sidebar ----------

  async function renderSidebar(project: ProjectInfo, section: SectionId): Promise<void> {
    $('sidebar-title').textContent = SECTIONS[section].title;
    const body = $('sidebar-body');
    body.replaceChildren();
    const fromModule = moduleSections.get(section);
    if (fromModule) {
      await fromModule.render(body, project, () => frameOf(project.id).sidebar === section && snapshot.current === project.id);
    }
  }

  let sidebarWidth = (() => {
    const saved = Number(read(SIDEBAR_KEY));
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
  })();

  sideSplitter.addEventListener('pointerdown', (e) => {
    sideSplitter.setPointerCapture(e.pointerId);
    sideSplitter.classList.add('dragging');
    let last = e.clientX;
    const move = (ev: PointerEvent) => {
      resizeSidebar(ev.clientX - last);
      last = ev.clientX;
    };
    const up = () => {
      sideSplitter.classList.remove('dragging');
      sideSplitter.removeEventListener('pointermove', move);
      write(SIDEBAR_KEY, String(sidebarWidth));
    };
    sideSplitter.addEventListener('pointermove', move);
    sideSplitter.addEventListener('pointerup', up, { once: true });
    sideSplitter.addEventListener('pointercancel', up, { once: true });
  });
  sideSplitter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      resizeSidebar(e.key === 'ArrowLeft' ? -24 : 24);
      write(SIDEBAR_KEY, String(sidebarWidth));
    }
  });
  sideSplitter.addEventListener('dblclick', () => {
    sidebarWidth = SIDEBAR_DEFAULT;
    write(SIDEBAR_KEY, null);
    applyLayout();
  });

  function resizeSidebar(delta: number): void {
    sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, sidebarWidth + delta));
    applyLayout();
  }

  // ---------- columns: drag the splitters, 1:1 with the pointer ----------

  /// The panes on each side of a splitter, or nothing when the splitter has no job. The first splitter sits right
  /// of Claude, the second right of the browser; a hidden browser leaves the first between Claude and the terminal.
  function neighbours(index: number, frame: ProjectFrame): [PaneName, PaneName] | null {
    const { agent, browser, shell } = frame.panes;
    if (index === 0) return agent && (browser || shell) ? ['agent', browser ? 'browser' : 'shell'] : null;
    return browser && shell ? ['browser', 'shell'] : null;
  }

  splitters.forEach((splitter, index) => {
    const resize = (delta: number): void => {
      const project = current();
      if (!project) return;
      const frame = frameOf(project.id);
      const pair = neighbours(index, frame);
      if (!pair) return;
      const shown = PANES.filter((p) => frame.panes[p]);
      const widths = Object.fromEntries(shown.map((p) => [p, paneEl(p).getBoundingClientRect().width])) as Record<PaneName, number>;
      const [left, right] = pair;
      // A narrow window keeps both columns usable: the limit is never more than half of what the two have.
      const min = Math.min(MIN_COLUMN, (widths[left] + widths[right]) / 2);
      const d = Math.max(min - widths[left], Math.min(delta, widths[right] - min));
      widths[left] += d;
      widths[right] -= d;
      // Columns are shares. Keep the shown ones on the same scale as a hidden one, which keeps its share.
      const columns = { ...(frame.columns ?? DEFAULT_COLUMNS) };
      const shares = shown.reduce((sum, p) => sum + columns[p], 0);
      const total = shown.reduce((sum, p) => sum + widths[p], 0);
      for (const p of shown) columns[p] = (widths[p] / total) * shares;
      frame.columns = columns;
      applyColumns(frame);
      hooks.layoutChanged();
    };
    const save = () => {
      const project = current();
      if (project) saveFrame(project.id);
    };
    splitter.addEventListener('pointerdown', (e) => {
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      let last = e.clientX;
      const move = (ev: PointerEvent) => {
        resize(ev.clientX - last);
        last = ev.clientX;
      };
      const up = () => {
        splitter.classList.remove('dragging');
        splitter.removeEventListener('pointermove', move);
        save();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up, { once: true });
      splitter.addEventListener('pointercancel', up, { once: true });
    });
    // Keyboard: arrow keys move the splitter by 24 px.
    splitter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        resize(e.key === 'ArrowLeft' ? -24 : 24);
        save();
      }
    });
    // Double click restores the default widths.
    splitter.addEventListener('dblclick', () => {
      const project = current();
      if (!project) return;
      frameOf(project.id).columns = null;
      saveFrame(project.id);
      applyLayout();
    });
  });

  function applyColumns(frame: ProjectFrame): void {
    const columns = frame.columns ?? DEFAULT_COLUMNS;
    workspace.style.gridTemplateColumns = PANES.filter((p) => frame.panes[p]).map((p) => `minmax(${PANE_MIN}px, ${columns[p]}fr)`).join(' 6px ');
  }

  // ---------- everything that depends on the project on screen ----------

  function applyLayout(): void {
    const project = current();
    const frame = project ? frameOf(project.id) : null;
    document.body.classList.toggle('no-project', !project);
    $('rail').hidden = railHidden;
    $('activity').hidden = !project || picking;
    $('welcome').hidden = !!project || picking;
    $('server-picker').hidden = !picking;
    workspace.hidden = !project || picking;
    sidebar.hidden = !frame?.sidebar || picking;
    sideSplitter.hidden = !frame?.sidebar || picking;
    // With no server yet, this is the way to the form that adds the first one.
    $('rail-open-server').hidden = false;
    $('welcome-open-server').hidden = false;
    sidebar.style.width = `${sidebarWidth}px`;

    const pressed = (name: string, on: boolean) => $('activity').querySelector(`[data-activity="${name}"]`)?.setAttribute('aria-pressed', String(on));
    pressed('rail', !railHidden);
    if (frame) {
      for (const pane of PANES) {
        paneEl(pane).hidden = !frame.panes[pane];
        pressed(pane, frame.panes[pane]);
      }
      for (const id of Object.keys(SECTIONS)) pressed(id, frame.sidebar === id);
      splitters.forEach((s, i) => { s.hidden = !neighbours(i, frame); });
      applyColumns(frame);
    }
    // No offer where it would change nothing: the person shows only Claude already.
    const asChat = !!frame && PANES.every((p) => frame.panes[p] === CHAT_PANES[p]);
    offer.hidden = !frame || !chatFirstEdition() || frame.chat || frame.offerClosed || asChat;
    if (project && frame?.sidebar) void renderSidebar(project, frame.sidebar);
    hooks.layoutChanged();
  }

  /// The folder above, when another open project has the same name.
  function parentWhenNeeded(p: ProjectInfo): string | null {
    if (snapshot.projects.filter((o) => o.name === p.name).length < 2) return null;
    return p.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? null;
  }

  function renderRail(): void {
    const tiles = snapshot.projects.map((p) => {
      const tile = document.createElement('button');
      tile.className = `tile tint-${p.tint}`;
      tile.dataset.project = p.id;
      tile.title = p.server ? `${p.name}\nOn the server ${p.server}: ${p.path}` : `${p.name}\n${p.path}`;
      if (p.server) tile.dataset.server = p.server;
      if (p.id === snapshot.current) tile.setAttribute('aria-current', 'true');
      const mono = document.createElement('span');
      mono.className = 'mono';
      mono.textContent = p.monogram;
      if (p.server) mono.append(icon('server', 'server-mark'));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      tile.append(mono, name);
      const parent = parentWhenNeeded(p);
      if (parent) {
        const place = document.createElement('span');
        place.className = 'name parent';
        place.textContent = parent;
        tile.append(place);
      }
      paintBadge(tile, railBadges.get(p.id) ?? 0);
      tile.addEventListener('click', () => {
        closePicker();
        void api.projects.select(p.id);
        // A project with something waiting shows it: Go panels open again after they were closed.
        if (railBadges.get(p.id)) window.dispatchEvent(new CustomEvent('vibex:badge', { detail: p.id }));
      });
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.menu.project(p.id);
      });
      return tile;
    });
    $('rail-tiles').replaceChildren(...tiles);
  }

  function renderWelcome(): void {
    $('welcome-recents').hidden = !snapshot.recents.length;
    $('welcome-recent-list').replaceChildren(...snapshot.recents.map((r) => {
      const b = document.createElement('button');
      b.className = 'recent';
      b.title = r.path;
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = r.name;
      const where = document.createElement('span');
      where.className = 'recent-path';
      where.textContent = r.server ? `${r.server}:${r.path}` : r.path;
      b.append(name, where);
      b.addEventListener('click', () => void (r.server ? openServerFolder(r.server, r.path, $('welcome-error')) : openProject(r.path)));
      return b;
    }));
  }

  const plainError = (e: unknown) => String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

  async function openProject(folder?: string): Promise<void> {
    const error = $('welcome-error');
    error.hidden = true;
    try {
      await api.projects.open(folder);
      closePicker();
    } catch (e) {
      // A recent folder can go away after the list was drawn.
      error.textContent = `Could not open this project: ${plainError(e)}`;
      error.hidden = false;
    }
  }
  // Setup with no project: a button under Open Project, and the page opens in place on this screen.
  const setupButton = document.createElement('button');
  setupButton.className = 'side-button';
  setupButton.id = 'welcome-setup-open';
  setupButton.textContent = 'Set up Vibex';
  setupButton.title = 'Check Git, SSH and Claude Code on this computer';
  const setupBox = document.createElement('div');
  setupBox.id = 'welcome-setup';
  setupBox.hidden = true;
  $('welcome-open-server').after(setupButton);
  $('welcome-error').after(setupBox);
  setupButton.addEventListener('click', () => openSetup(null));
  window.addEventListener('vibex:setup-welcome', (e) => {
    setupBox.replaceChildren((e as CustomEvent<HTMLElement>).detail);
    setupBox.hidden = false;
  });
  $('rail-open').addEventListener('click', () => void openProject());
  $('welcome-open').addEventListener('click', () => void openProject());

  // ---------- server projects: pick a server, then a folder on it ----------

  let pickerServer: string | null = null;
  /// Only the answer for the last server asked counts; a slow server must not fill the list of a later one.
  let pickerAsk = 0;

  function showPickerError(message: string | null): void {
    $('picker-error').textContent = message ?? '';
    $('picker-error').hidden = !message;
  }

  async function openServerFolder(server: string, folder: string, errorEl: HTMLElement): Promise<void> {
    errorEl.hidden = true;
    try {
      await api.projects.openServer(server, folder);
      closePicker();
    } catch (e) {
      errorEl.textContent = `Could not open this project: ${plainError(e)}`;
      errorEl.hidden = false;
    }
  }

  function pickServer(name: string): void {
    pickerServer = name;
    const ask = ++pickerAsk;
    const start = servers.find((s) => s.name === name)?.projectPath;
    if (start) ($('picker-path') as HTMLInputElement).value = start;
    showPickerError(null);
    for (const b of $('picker-servers').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === name));
    const list = $('picker-folders');
    list.replaceChildren();
    list.setAttribute('aria-busy', 'true');
    void api.servers.folders(name).then((folders: string[]) => {
      if (ask !== pickerAsk) return;
      list.removeAttribute('aria-busy');
      if (!folders.length) {
        const none = document.createElement('p');
        none.className = 'empty-text';
        none.textContent = 'No folders in the home folder. Type a folder below.';
        list.replaceChildren(none);
        return;
      }
      list.replaceChildren(...folders.map((folder) => {
        const b = document.createElement('button');
        b.className = 'recent';
        b.append(icon('folder'));
        const label = document.createElement('span');
        label.className = 'recent-name';
        label.textContent = folder;
        b.append(label);
        b.addEventListener('click', () => void openServerFolder(name, `~/${folder}`, $('picker-error')));
        return b;
      }));
    }).catch((e: unknown) => {
      if (ask !== pickerAsk) return;
      list.removeAttribute('aria-busy');
      showPickerError(plainError(e));
    });
  }

  function renderPickerServers(): void {
    $('picker-servers').replaceChildren(...servers.map(({ name }) => {
      const b = document.createElement('button');
      b.className = 'side-button';
      b.textContent = name;
      b.addEventListener('click', () => pickServer(name));
      return b;
    }));
    let manage = document.getElementById('picker-manage');
    if (!manage) {
      manage = document.createElement('div');
      manage.id = 'picker-manage';
      const add = document.createElement('button');
      add.id = 'picker-add';
      add.className = 'side-button';
      add.textContent = 'Add Server';
      add.addEventListener('click', () => void openServerForm(null));
      const edit = document.createElement('button');
      edit.id = 'picker-edit';
      edit.className = 'side-button';
      edit.textContent = 'Edit Server';
      edit.addEventListener('click', () => { if (pickerServer) void openServerForm(pickerServer); });
      manage.append(add, edit);
      $('picker-servers').after(manage);
    }
    $('picker-edit').hidden = !servers.length;
    $('picker-form').hidden = !servers.length;
    $('picker-folders').hidden = !servers.length;
  }

  function openPicker(): void {
    picking = true;
    ($('picker-path') as HTMLInputElement).value = '';
    renderPickerServers();
    applyLayout();
    if (servers.length) pickServer(servers[0].name);
    else showPickerError(null);
    $('picker-path').focus();
  }

  function closePicker(): void {
    pickerAsk++;
    if (!picking) return;
    picking = false;
    applyLayout();
    hooks.projectShown(current());
  }

  $('rail-open-server').addEventListener('click', openPicker);
  $('welcome-open-server').addEventListener('click', openPicker);
  $('picker-cancel').addEventListener('click', closePicker);
  $('picker-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (pickerServer) void openServerFolder(pickerServer, ($('picker-path') as HTMLInputElement).value.trim(), $('picker-error'));
  });
  $('server-picker').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
  });

  function apply(next: ProjectsSnapshot): void {
    const changed = next.current !== snapshot.current;
    keepOlderLayouts(next);
    snapshot = next;
    const project = current();
    const parent = project ? parentWhenNeeded(project) : null;
    $('project-name').textContent = project ? [project.name, parent, project.server].filter(Boolean).join(' · ') : '';
    document.title = project ? `${project.name} — Vibex PCA` : 'Vibex PCA';
    renderRail();
    renderWelcome();
    applyLayout();
    if (changed) hooks.projectShown(project);
  }

  return {
    current,
    apply,
    activity,
    revealPane,
    openProject,
    openPicker,
    setServers: (list: { name: string; projectPath?: string }[]) => {
      servers = list;
      if (picking) {
        renderPickerServers();
        // The server on the list was renamed or removed: the next one takes its place.
        if (!servers.some((s) => s.name === pickerServer)) {
          pickerServer = null;
          if (servers.length) pickServer(servers[0].name);
        }
      }
      applyLayout();
    },
    /// A tool changes the columns: build gives Claude the width, watch gives the browser the width, balanced puts the
    /// person's own widths back. The widths of the person are kept while a mode is on.
    layout: (id: string, mode: 'build' | 'watch' | 'balanced') => {
      const f = frameOf(id);
      if (mode === 'balanced') {
        const own = ownColumns.get(id);
        f.columns = own?.columns ?? null;
        if (own) f.panes = { ...own.panes };
        ownColumns.delete(id);
      } else {
        if (!ownColumns.has(id)) ownColumns.set(id, { columns: f.columns, panes: { ...f.panes } });
        f.panes.agent = true;
        f.panes.shell = true;
        if (mode === 'watch') f.panes.browser = true;
        f.columns = mode === 'build' ? { agent: 1.7, browser: 0.7, shell: 0.9 } : { agent: 0.8, browser: 1.8, shell: 0.8 };
      }
      saveFrame(id);
      if (id === snapshot.current) applyLayout();
    },
    /// The keyboard goes to a column of the project on screen (a hidden column is shown first).
    focusPane: (pane: PaneName) => {
      const project = current();
      if (!project) return;
      revealPane(project.id, pane);
      hooks.paneOpened(pane);
    },
    paneShown: (pane: PaneName) => {
      const project = current();
      return !picking && !!project && frameOf(project.id).panes[pane];
    },
  };
}
