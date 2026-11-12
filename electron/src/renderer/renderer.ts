import { toast } from './agentsGoUi';
import { mountChat, setChatHost } from './chat';
import { FitAddon } from '@xterm/addon-fit';
import { addLinks, openFind } from './terminalExtras';
import { Terminal } from '@xterm/xterm';
import { docOnScreen, setupDocs, showDocsOf, showPage } from './docs';
import { createFrame, type PaneName, type ProjectInfo } from './frame';
import { RENDERER_MODULES } from './modules';
import { openSetup } from './setup';
import { icon, paintIcons, svg } from './icons';
import { explainLoadError } from '../shared/loadErrors';

type Pane = 'agent' | 'shell';
interface TabInfo { id: number; title: string; kind: string; alive: boolean; server?: string; pane: Pane; project: string; chat?: boolean }
interface PageTabInfo { number: number; title: string; url: string; loading: boolean; active: boolean; asleep: boolean; waiting: boolean }
interface BrowserState { url: string; title: string; loading: boolean; canGoBack?: boolean; canGoForward?: boolean; tabs?: PageTabInfo[] }

declare global {
  interface Window { vibex: any }
}

const api = window.vibex;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const isMac = api.platform === 'darwin';
if (isMac) document.body.classList.add('mac');

const frame = createFrame(api, {
  projectShown: showProject,
  layoutChanged: () => {
    placeBrowser();
    fitActive();
  },
  paneOpened: (pane) => {
    if (pane === 'browser') return;
    const id = activeIn(frame.current()?.id ?? '')[pane];
    if (id !== null) select(id);
  },
  paneHidden: (pane) => {
    if (pane === focusedPane) focusShownTab();
  },
});
const onScreen = () => frame.current()?.id ?? null;
setChatHost({ opened: (id) => { if (views.has(id)) select(id); else focusWhenReady.add(id); }, select, frame: () => frame });

// ---------- terminals ----------

// The terminal palette of macOS Vibex (Terminal/TerminalTheme.swift): always dark.
const TERMINAL_THEME = {
  background: '#121216',
  foreground: '#e5e5ea',
  cursor: '#6ca8ff',
  cursorAccent: '#121216',
  selectionBackground: 'rgba(108, 168, 255, 0.32)',
  black: '#3a3a3c', red: '#ff6b6b', green: '#5ad178', yellow: '#ffd166',
  blue: '#6ca8ff', magenta: '#d18bff', cyan: '#5cd6e8', white: '#d1d1d6',
  brightBlack: '#7c7c80', brightRed: '#ff8a80', brightGreen: '#7ee59a', brightYellow: '#ffe08a',
  brightBlue: '#8fbfff', brightMagenta: '#e3adff', brightCyan: '#8ae6f3', brightWhite: '#f2f2f7',
};

interface View {
  info: TabInfo; term: Terminal; fit: FitAddon; el: HTMLElement; button: HTMLElement; exited: boolean; exitCode?: number;
  /// Running total of characters already drawn; null while the first replay is still loading.
  drawn: number | null;
  queued: [string, number][];
}
const views = new Map<number, View>();
/// The tab each project shows in each column.
const activeByProject = new Map<string, Record<Pane, number | null>>();
let focusedPane: Pane = 'agent';

function activeIn(project: string): Record<Pane, number | null> {
  let active = activeByProject.get(project);
  if (!active) {
    active = { agent: null, shell: null };
    activeByProject.set(project, active);
  }
  return active;
}

const paneEl = (pane: Pane) => document.querySelector<HTMLElement>(`.terminal-pane[data-pane="${pane}"]`)!;

/// Shows the tabs of the project on screen in this column, and only those.
function paintPane(pane: Pane): void {
  const project = onScreen();
  const active = project ? activeIn(project)[pane] : null;
  for (const v of views.values()) {
    if (v.info.pane !== pane) continue;
    const here = v.info.project === project;
    const on = here && v.info.id === active;
    v.button.hidden = !here;
    v.el.classList.toggle('active', on);
    v.button.setAttribute('aria-selected', String(on));
    v.button.tabIndex = on ? 0 : -1;
  }
  const hasTabs = !!project && [...views.values()].some((v) => v.info.pane === pane && v.info.project === project);
  const empty = paneEl(pane).querySelector<HTMLElement>('.pane-empty');
  if (empty) empty.hidden = hasTabs;
  paneEl(pane).querySelector<HTMLElement>('.terminals')!.hidden = !hasTabs;
}

function select(id: number, focus = true): void {
  const v = views.get(id);
  if (!v) return;
  const pane = v.info.pane;
  activeIn(v.info.project)[pane] = id;
  // A tab of a project in the background becomes its active one, and stays out of sight.
  if (v.info.project !== onScreen()) return;
  paintPane(pane);
  fitView(v);
  if (focus) {
    focusedPane = pane;
    v.term.focus();
  }
}

function idsIn(pane: Pane, project = onScreen()): number[] {
  return [...views.values()].filter((v) => v.info.pane === pane && v.info.project === project).map((v) => v.info.id);
}

function cycle(step: number): void {
  const project = onScreen();
  if (!project || !frame.paneShown(focusedPane)) return;
  const ids = idsIn(focusedPane);
  const current = activeIn(project)[focusedPane];
  if (!ids.length || current === null) return;
  select(ids[(ids.indexOf(current) + step + ids.length) % ids.length]);
}

function fitView(v: View): void {
  if (!v.el.classList.contains('active')) return;
  try {
    v.fit.fit();
    api.term.resize(v.info.id, v.term.cols, v.term.rows);
  } catch {
    // The pane is hidden or zero-sized during layout.
  }
}

/// Copy and paste as in Windows Terminal: Ctrl+C copies when text is selected (else it interrupts),
/// Ctrl+V and Ctrl+Shift+V paste, Ctrl+Shift+C copies. macOS keeps Cmd+C / Cmd+V from the Edit menu.
function clipboardKeys(term: Terminal) {
  return (e: KeyboardEvent): boolean => {
    if (isMac || e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    if (key === 'v') {
      e.preventDefault();
      void navigator.clipboard.readText().then((text) => text && term.paste(text));
      return false;
    }
    return true;
  };
}

/// Commands like Close Tab act where the keyboard is, so the keyboard stays in a column the person can see.
function focusShownTab(): void {
  const project = onScreen();
  if (!project) return;
  const active = activeIn(project);
  const pane = ([focusedPane, 'agent', 'shell'] as Pane[]).find((p) => frame.paneShown(p) && active[p] !== null);
  if (!pane) return;
  focusedPane = pane;
  views.get(active[pane]!)?.term.focus();
}

/// Tabs a person asked for take the focus when they arrive; a tab that a tool call started never does.
const focusWhenReady = new Set<number>();
function openedByPerson(tab: Promise<TabInfo>): void {
  void tab.then((info) => {
    if (views.has(info.id)) select(info.id);
    else focusWhenReady.add(info.id);
  }).catch((error: unknown) => console.error(error));
}

function fitActive(): void {
  const project = onScreen();
  if (!project) return;
  for (const pane of ['agent', 'shell'] as Pane[]) {
    const id = activeIn(project)[pane];
    const v = id === null ? undefined : views.get(id);
    if (v) fitView(v);
  }
}

/// Another project is on screen: its tabs, its layout and its page take the place of the last one's.
function showProject(project: ProjectInfo | null): void {
  markPrimaryConnect();
  showDocsOf(project?.id ?? null);
  paintPane('agent');
  paintPane('shell');
  placeBrowser();
  fitActive();
  void refreshBrowser();
  if (!project) return;
  // A project shown for the first time starts in Claude; its tabs arrive after this.
  const active = activeIn(project.id);
  if (active.agent === null && active.shell === null) focusedPane = frame.paneShown('agent') ? 'agent' : 'shell';
  $('browser-empty-text').textContent = 'Enter an address above, or ask Claude to open a page here.';
  void showStatus();
  if (document.body.dataset.ready === 'true') focusShownTab();
}

function tabIconName(info: TabInfo): string {
  if (info.chat) return 'message';
  if (info.pane === 'agent') return 'sparkles';
  return info.server ? 'server' : 'terminal';
}

function newTerminal(info: TabInfo, el: HTMLElement): { term: Terminal; fit: FitAddon } {
  const openTerminalLink = (url: string) => {
    if (info.project !== onScreen()) return;
    api.mod.invoke('mod:browser:terminal-link', url).then((answer: { opened: boolean; message?: string }) => {
      if (!answer.opened) console.warn(answer.message);
    }).catch(() => undefined);
  };
  const term = new Terminal({
    fontFamily: '"Google Sans Code", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    theme: TERMINAL_THEME,
    // An OSC 8 link: the same rule as a typed link, with no confirm box that shows the server's own text.
    linkHandler: {
      activate: (event, uri) => {
        if (event.ctrlKey || event.metaKey) openTerminalLink(uri);
      },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.attachCustomKeyEventHandler(clipboardKeys(term));
  addLinks(term, openTerminalLink);
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const choice: string | null = await api.menu.terminal(term.hasSelection());
    if (choice === 'copy') await navigator.clipboard.writeText(term.getSelection());
    else if (choice === 'paste') term.paste(await navigator.clipboard.readText());
    else if (choice === 'select-all') term.selectAll();
    else if (choice === 'clear') term.clear();
    term.focus();
  });
  el.addEventListener('mousedown', () => {
    focusedPane = info.pane;
  });
  return { term, fit };
}

async function addView(info: TabInfo): Promise<void> {
  if (views.has(info.id)) return;
  const pane = paneEl(info.pane);
  const el = document.createElement('div');
  el.className = 'term';
  el.dataset.tab = String(info.id);
  pane.querySelector('.terminals')!.appendChild(el);

  const { term, fit } = info.chat ? mountChat(info.id, el) : newTerminal(info, el);
  if (info.chat) el.addEventListener('mousedown', () => { focusedPane = info.pane; });

  const button = document.createElement('div');
  button.className = 'tab';
  button.setAttribute('role', 'tab');
  button.dataset.tab = String(info.id);
  button.title = info.server ? `ssh: ${info.title}` : info.title;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = info.title;
  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Close tab (Ctrl+Shift+W)';
  close.setAttribute('aria-label', `Close ${info.title}`);
  close.innerHTML = svg('close');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    api.term.close(info.id);
  });
  button.append(icon(tabIconName(info), 'tab-icon'), label, close);
  button.addEventListener('click', () => select(info.id));
  button.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.term.close(info.id); // middle click closes, as in browsers
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') select(info.id);
  });
  button.hidden = info.project !== onScreen();
  pane.querySelector('.tabs')!.appendChild(button);

  const v: View = { info, term, fit, el, button, exited: !info.alive, drawn: null, queued: [] };
  views.set(info.id, v);
  term.onData((data: string) => {
    // An ssh tab whose connection ended reconnects on Enter instead of being a dead end.
    if (v.exited) {
      if (data === '\r' && info.server) void reconnect(v);
      return;
    }
    api.term.input(info.id, data);
  });
  // Replay what the PTY printed before this view existed, then the data that came during the replay,
  // skipping what the replay already held (each data event carries the running total after it).
  const past: { text: string; total: number } = await api.term.snapshot(info.id);
  if (past.text) term.write(past.text);
  v.drawn = past.total;
  for (const [data, total] of v.queued) writeNew(v, data, total);
  v.queued = [];
  if (v.exited) markExited(v, v.exitCode ?? null);
  // At start-up each pane shows its first tab. The first tabs of a project arrive together, and the focus goes to
  // the column the person is in, not to the last tab to arrive. Any other tab takes the focus only if a person
  // asked for it (openedByPerson); a tool call must not move someone's typing.
  const first = idsIn(info.pane, info.project).length === 1;
  const asked = focusWhenReady.delete(info.id);
  const ready = document.body.dataset.ready === 'true';
  // A person typing in this column keeps their tab: a tool's tab arrives beside it, and hiding theirs would lose the keys.
  if (ready && !asked && !first && info.project === onScreen() && pane.contains(document.activeElement)) {
    paintPane(info.pane);
    return;
  }
  select(info.id, ready && (asked || (first && info.pane === focusedPane && frame.paneShown(info.pane))));
}

function markExited(v: View, code: number | null): void {
  v.exited = true;
  v.button.classList.add('exited');
  v.button.querySelector('.tab-icon')?.replaceWith(icon('alert', 'tab-icon'));
  const how = code === null ? 'ended' : `ended with code ${code}`;
  const next = v.info.server ? ' Press Enter to reconnect, or close the tab.' : ' Close the tab, or press + for a new one.';
  v.term.write(`\r\n\x1b[2m[${v.info.server ? 'Connection' : 'Session'} ${how}.${next}]\x1b[0m\r\n`);
}

async function reconnect(v: View): Promise<void> {
  openedByPerson(api.term.reopen(v.info.id));
}

function removeView(id: number): void {
  const v = views.get(id);
  if (!v) return;
  const { pane, project } = v.info;
  const ids = idsIn(pane, project);
  const neighbour = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1];
  // Read before the view goes: a person typing elsewhere (the address bar, Notes) keeps the keyboard. With nothing in focus,
  // or with the focus in this column, the keyboard stays with the column.
  const typing = document.activeElement;
  const typingElsewhere = !!typing && typing !== document.body && !paneEl(pane).contains(typing);
  v.term.dispose();
  v.el.remove();
  v.button.remove();
  views.delete(id);
  if (activeIn(project)[pane] === id) {
    // A tool's finished tab making way must not pull the keyboard out of the column the person is in.
    if (neighbour !== undefined) select(neighbour, pane === focusedPane && !typingElsewhere);
    else {
      activeIn(project)[pane] = null;
      if (pane === focusedPane && project === onScreen() && !typingElsewhere) focusShownTab();
    }
  }
  paintPane(pane);
}

api.term.onCreated((info: TabInfo) => void addView(info));
function writeNew(v: View, data: string, total: number): void {
  const from = total - data.length;
  if (total <= v.drawn!) return;
  v.term.write(from >= v.drawn! ? data : data.slice(v.drawn! - from));
  v.drawn = total;
}
api.term.onData((id: number, data: string, total: number) => {
  const v = views.get(id);
  if (!v) return;
  if (v.drawn === null) v.queued.push([data, total]);
  else writeNew(v, data, total);
});
api.term.onExit((id: number, code: number) => {
  const v = views.get(id);
  if (!v) return;
  // During its replay the view has not drawn the output yet: the line about the end comes after it, once.
  if (v.drawn === null) {
    v.exited = true;
    v.exitCode = code;
  } else markExited(v, code);
});
api.term.onClosed((id: number) => removeView(id));

document.querySelector('.new-chat')!.addEventListener('click', () => openedByPerson(api.term.create('agent-chat')));

$('app-menu').addEventListener('click', () => {
  const r = $('app-menu').getBoundingClientRect();
  api.menu.app(r.left, r.bottom + 4);
});

document.querySelectorAll<HTMLElement>('.new-tab, .pane-start').forEach((b) => {
  b.addEventListener('click', () => openedByPerson(api.term.create(b.dataset.pane as Pane)));
});

// ---------- servers (title bar) ----------

async function loadServers(): Promise<void> {
  const list: { name: string; target: string; projectPath?: string }[] = await api.servers.list();
  const box = $('servers');
  box.querySelectorAll('button.server').forEach((b) => b.remove()); // keep the empty-state hint
  list.forEach((s, i) => {
    const b = document.createElement('button');
    // The first profile (the PCA server) is the one primary action of the window.
    b.className = 'server';
    b.title = `Open an ssh tab to ${s.target}`;
    const text = document.createElement('span');
    text.textContent = `Connect ${s.name}`;
    b.append(icon('server'), text);
    b.addEventListener('click', () => openedByPerson(api.servers.connect(s.name)));
    box.appendChild(b);
  });
  const problem: string | null = await api.servers.problem();
  $('no-servers').textContent = problem ?? 'No server profiles';
  $('no-servers').hidden = list.length > 0 && !problem;
  markPrimaryConnect();
  frame.setServers(list);
}

/// On a server project the person is connected already, so Connect is not the main action of the window.
function markPrimaryConnect(): void {
  const onServer = !!frame.current()?.server;
  document.querySelectorAll('button.server').forEach((b, i) => b.classList.toggle('primary', i === 0 && !onServer));
}

// ---------- browser ----------

// The side browser is a native view over the page; it follows the placeholder's rectangle. A hidden column has
// no rectangle: the last one stays, so that pages in the background keep a real size.
const browserView = $('browser-view');
let browserRect = { x: 0, y: 0, width: 0, height: 0 };
function placeBrowser(): void {
  const r = browserView.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) browserRect = { x: r.left, y: r.top, width: r.width, height: r.height };
  api.browser.setArea(browserRect, !!onScreen() && frame.paneShown('browser') && !docOnScreen());
  markPageTabs();
}
new ResizeObserver(placeBrowser).observe(browserView);
new ResizeObserver(fitActive).observe($('workspace'));

const urlInput = $<HTMLInputElement>('url');

const browserError = $('browser-error');
/// What went wrong last in each project's browser.
const browserErrors = new Map<string, string>();
function paintBrowserError(): void {
  const message = browserErrors.get(onScreen() ?? '') ?? '';
  $('browser-error-text').textContent = message;
  browserError.hidden = !message;
}
function setBrowserError(project: string | null, message: string | null): void {
  if (!project) return;
  if (message) browserErrors.set(project, message);
  else browserErrors.delete(project);
  paintBrowserError();
}
$('urlbar').addEventListener('submit', (e) => {
  e.preventDefault();
  const wanted = urlInput.value.trim();
  if (!wanted) return;
  const project = onScreen();
  setBrowserError(project, null);
  $('urlbar').classList.add('loading'); // feedback at once, before the first network byte
  void api.browser.navigate(wanted).catch((error: unknown) => {
    // Keep what the user typed and say what failed, next to the address bar.
    setBrowserError(project, `Could not open ${wanted}: ${explainLoadError(String(error))}`);
    $('urlbar').classList.remove('loading');
  });
});
$('back').addEventListener('click', () => api.browser.back());
$('forward').addEventListener('click', () => api.browser.forward());
$('reload').addEventListener('click', () => api.browser.reload());
/// A document tab on screen takes the selection from the page tabs.
function markPageTabs(): void {
  const doc = !!docOnScreen();
  for (const tab of $('page-tabs').querySelectorAll<HTMLElement>('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.active === 'true' && !doc));
}
const hostOf = (url: string): string => {
  try { return url ? new URL(url).host.replace(/^www\./, '') : ''; } catch { return ''; }
};
function paintPageTabs(tabs: PageTabInfo[]): void {
  $('page-tabs').replaceChildren(...tabs.map((t) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.tab = String(t.number);
    tab.dataset.active = String(t.active);
    tab.classList.toggle('asleep', t.asleep || t.waiting);
    const name = t.title || hostOf(t.url) || 'New Tab';
    if (t.active) tab.id = 'page-tab';
    tab.title = t.asleep ? `${name} (asleep to save memory; it wakes when you open it)` : t.url || name;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    if (t.active) label.id = 'page-title';
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close tab';
    close.setAttribute('aria-label', `Close ${name}`);
    close.append(icon('close'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void api.mod.invoke('mod:browser:close', t.number);
    });
    tab.append(icon('globe', 'tab-icon'), label, ...(t.number ? [close] : []));
    tab.addEventListener('click', () => {
      showPage();
      if (!t.active) void api.mod.invoke('mod:browser:select', t.number);
    });
    // A middle click closes, as in browsers and in the terminal tabs.
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) void api.mod.invoke('mod:browser:close', t.number);
    });
    return tab;
  }));
  markPageTabs();
}
$('new-page-tab').addEventListener('click', async () => {
  showPage();
  await api.mod.invoke('mod:browser:new');
  urlInput.focus();
});
/// The selected tab last painted; a new selection replaces the address even while the bar has the keyboard.
let paintedTab = '';
function paintBrowser(s: BrowserState): void {
  const tab = `${onScreen()}:${s.tabs?.find((t) => t.active)?.number ?? 0}`;
  // A project with no browser yet shows a stand-in tab 0. The first address makes tab 1, with no URL until it loads, and
  // that must not empty the bar under the text the person just entered.
  const firstPage = paintedTab === `${onScreen()}:0`;
  if (document.activeElement !== urlInput || (tab !== paintedTab && !firstPage)) urlInput.value = s.url;
  paintedTab = tab;
  $('urlbar').classList.toggle('loading', s.loading);
  $<HTMLButtonElement>('back').disabled = !s.canGoBack;
  $<HTMLButtonElement>('forward').disabled = !s.canGoForward;
  $('browser-empty').hidden = !!s.url;
  // No browser yet for this project: one empty tab (number 0) stands for the page that will open.
  paintPageTabs(s.tabs ?? [{ number: 0, title: s.title, url: s.url, loading: false, active: true, asleep: false, waiting: false }]);
  const secure = s.url.startsWith('https:');
  document.body.classList.toggle('secure', secure);
  $('address-icon').innerHTML = svg(secure ? 'lock' : 'globe');
}
api.browser.onState((project: string, s: BrowserState) => {
  if (project === onScreen()) paintBrowser(s);
});
/// The address bar and the tabs of the project now on screen; what was typed for another project stays behind.
/// A project that was never browsed has no browser yet, so its saved tabs come from the module.
async function refreshBrowser(): Promise<void> {
  const project = onScreen();
  let s: BrowserState = await api.browser.state();
  if (!s.tabs) s = (await api.mod.invoke('mod:browser:tabs')) ?? s;
  if (project !== onScreen()) return;
  // A person who has started to type in this project keeps the text; a switch has moved the keyboard away by now.
  if (document.activeElement !== urlInput) urlInput.value = s.url;
  else paintedTab = `${project}:${s.tabs?.find((t) => t.active)?.number ?? 0}`;
  paintBrowser(s);
  paintBrowserError();
}

// ---------- menu bar commands (main/main.ts setMenu) ----------

api.menu.onCommand((name: string, arg?: string) => {
  if (name === 'activity' && arg) frame.activity(arg);
  if (name === 'open-server') frame.openPicker();
  if (name === 'servers-changed') void loadServers();
  const project = onScreen();
  if (!project) return; // the welcome view has no tabs and no address bar
  if (name === 'new-tab') openedByPerson(api.term.create(arg || 'shell'));
  else if (name === 'close-tab') {
    // Never a tab of a hidden column: the person could not see what ended.
    const id = frame.paneShown(focusedPane) ? activeIn(project)[focusedPane] : null;
    if (id !== null) api.term.close(id);
  } else if (name === 'next-tab') cycle(1);
  else if (name === 'previous-tab') cycle(-1);
  else if (name === 'terminal-find') {
    const id = frame.paneShown(focusedPane) ? activeIn(project)[focusedPane] : null;
    const v = id === null ? undefined : views.get(id);
    if (v && !v.info.chat) openFind(paneEl(focusedPane), v.term, () => v.term.focus());
  } else if (name === 'connect' && arg) openedByPerson(api.servers.connect(arg));
  else if (name === 'focus-address') {
    urlInput.focus();
    urlInput.select();
  }
});

// ---------- status (title bar chip, not a bottom bar: HIG keeps critical information out of it) ----------

async function showStatus(): Promise<void> {
  const s = await api.status();
  const chip = $('mcp-chip');
  if (s.mcpError) {
    chip.className = 'chip error';
    $('mcp-text').textContent = 'MCP server stopped';
    chip.title = `${s.mcpError}. Close the other app that uses this port, then restart Vibex PCA.`;
  } else if (!s.claudeInstalled) {
    chip.className = 'chip warn';
    $('mcp-text').textContent = 'Claude Code is missing';
    chip.title = 'The Claude tabs cannot start. Click for Setup, which installs it where you can watch.';
  } else {
    chip.className = 'chip ok';
    $('mcp-text').textContent = 'MCP ready';
    const store = s.tokenStore === 'os-store' ? 'key saved in the system store' : 'key kept for this session only';
    chip.title = `MCP server on 127.0.0.1:${s.mcpPort} · ${store} · Claude Code: ${s.claude} · Vibex PCA ${s.version}`;
  }
}

$('mcp-chip').addEventListener('click', () => {
  // Setup also opens with no project (the welcome screen), where Claude is installed first.
  if ($('mcp-chip').classList.contains('warn')) openSetup(onScreen());
});
// Setup found Claude Code, or registered it: the chip reads the status again.
window.addEventListener('vibex:status', () => void showStatus());
// A fault in the main process: one plain line, which goes away by itself (src/main/faultGuard.ts).
api.mod.on('mod:app:fault', (text: string) => toast('Something went wrong', text, 15));

api.projects.onChanged(frame.apply);
api.projects.onRevealPane((id: string, pane: PaneName) => frame.revealPane(id, pane));

async function boot(): Promise<void> {
  paintIcons();
  frame.apply(await api.projects.list());
  const tabs: TabInfo[] = await api.term.list();
  for (const t of tabs) await addView(t);
  await loadServers();
  placeBrowser();
  await showStatus();
  focusShownTab();
  document.body.dataset.ready = 'true';
}

void boot();

// ---------- feature modules ----------
setupDocs(placeBrowser);
$('page-tab').addEventListener('click', showPage);
for (const module of RENDERER_MODULES) module.start?.({ frame });
