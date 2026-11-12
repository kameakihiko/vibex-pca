import { BrowserWindow, session as electronSession, WebContentsView, type Session, type WebContents } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ACTIONS, SNAPSHOT } from './pageScripts';
import { openPreviewPage, type PreviewPage } from './previewPage';
import { FAILURE_PAGE_PREFIX, failureEntriesToDrop, failurePageUrl, judgedAddress, shouldShowFailurePage } from '../shared/loadErrors';
import { addressAllowed, isForward, isPrivateAddress, isServerCaller, partitionFor, type Resolver } from './serverGuard';

export interface TabInfo {
  number: number;
  title: string;
  url: string;
  loading: boolean;
  active: boolean;
  /// The page was closed to free its process; it comes back when the tab is used.
  asleep: boolean;
  /// A restored address that has not loaded yet.
  waiting: boolean;
}

/// `url`, `title` and `loading` are those of the selected tab, as before there were several.
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  tabs: TabInfo[];
}

/// Turns typed text into a URL: a scheme is kept, localhost gets http, a bare host gets https,
/// anything with spaces or no dot becomes a web search (as in macOS Vibex).
export function normalizeUrl(input: string): string {
  const text = input.trim();
  // localhost first: "localhost:3000" would otherwise read as a URL scheme.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^about:/i.test(text)) return text;
  if (!/\s/.test(text) && /^[^/]+\.[^/]+/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/// Pages may open only web addresses. file://, custom schemes and OS protocol handlers (ms-msdt:, search-ms:,
/// anything xdg-open knows) stay out, so a page cannot reach local files or start other apps.
export function isAllowedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === 'about:blank';
}

/// Idle time after which a tab that is not selected ends its page, as in macOS Vibex (BrowserPaneViewController).
export const SLEEP_AFTER_MS = 10 * 60_000;
const BUFFER_LIMIT = 500;
const CANNOT_READ = 'the page on screen is on this computer or the LAN, which an agent on a server cannot read';
const LED_AWAY = 'the page led to an address an agent on a server cannot open';
const blockedLoad = (error: unknown) => String(error).includes('ERR_BLOCKED_BY_CLIENT');

interface ConsoleEntry { level: string; text: string; date: number }
interface RequestEntry { method: string; url: string; status: number; error?: string; ms: number }
interface SavedTab { url: string; title: string; number: number }
interface SavedProject { active: number; next: number; tabs: SavedTab[] }

/// One page tab. The view (and so the renderer process) exists only while the tab is awake.
interface PageTab {
  number: number;
  view: WebContentsView | null;
  url: string;
  title: string;
  /// A restored address; loaded the first time the tab is shown or used.
  pending: string | null;
  asleep: boolean;
  /// The history of a sleeping page, put back on wake.
  saved: { entries: { url: string; title: string }[]; index: number } | null;
  started: boolean;
  lastActive: number;
  /// A person typed on this page since it loaded.
  typed: boolean;
  /// The page on show answers a form sent with POST. Restoring it could send the form again, so it never sleeps.
  postResult: boolean;
  postUnderWay: boolean;
  /// The address of the one local file this tab shows, in a session of its own; only vibex_preview sets it.
  allowedFile: string | null;
  /// That session. Null for a web page.
  preview: PreviewPage | null;
  attached: boolean;
  /// In a server project: the person opened a page of this computer here. It loads, and Claude on the server cannot read it.
  localPage: boolean;
  /// In a server project: a request used a private address after the lookup said public (the name changed its answer).
  /// The page is left, and the tab stays closed to Claude until the next move.
  tainted: boolean;
  /// Who started the next main-frame load; null means the page itself did.
  moveBy: 'person' | 'server' | null;
  /// Counts the pages of this tab, so a late answer to an earlier page's request is not listed under the new one.
  moveEpoch: number;
  /// The address that failed to load while the plain-words failure page is on show; null otherwise. The toolbar keeps this
  /// address, and Reload loads it.
  failure: string | null;
  /// Failure page address -> the failed address, so Back and Forward to a failure page bring the failed address back.
  failures: Map<string, string>;
  /// The history index of the page on show when the load failed; entries up to it are never removed as the failure.
  failAt: number | null;
  console: ConsoleEntry[];
  requests: RequestEntry[];
}

// ---------- saved tabs (restored lazily at the next start) ----------

let storeFile: string | null = null;
let store: Record<string, SavedProject> | null = null;
let storeTimer: NodeJS.Timeout | null = null;

/// Where the tab lists are kept: one file in the user data folder.
export function setTabStore(file: string): void {
  storeFile = file;
  store = null;
}

function loadStore(): Record<string, SavedProject> {
  if (store) return store;
  store = {};
  if (!storeFile) return store;
  try {
    const raw = JSON.parse(readFileSync(storeFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw as Record<string, any>)) {
        const tabs = Array.isArray(value?.tabs) ? value.tabs.filter((t: any) => typeof t?.url === 'string' && isAllowedUrl(t.url) && Number.isInteger(t.number)) : [];
        if (tabs.length) store[id] = { active: Number(value.active), next: Number(value.next) || 1, tabs: tabs.map((t: any) => ({ url: t.url, title: String(t.title ?? ''), number: t.number })) };
      }
    }
  } catch {
    // No file yet, or a damaged one: start without saved tabs.
  }
  return store;
}

export function hasSavedTabs(projectId: string): boolean {
  return !!loadStore()[projectId];
}

function saveProject(projectId: string, value: SavedProject | null): void {
  const all = loadStore();
  if (value) all[projectId] = value;
  else delete all[projectId];
  if (!storeFile || storeTimer) return;
  storeTimer = setTimeout(flushTabStore, 300);
  storeTimer.unref?.();
}

/// Writes the tab lists now (also on quit). A temporary file and a rename keep the old file whole if the write fails.
export function flushTabStore(): void {
  if (storeTimer) clearTimeout(storeTimer);
  storeTimer = null;
  if (!storeFile || !store) return;
  try {
    mkdirSync(path.dirname(storeFile), { recursive: true });
    const temp = `${storeFile}.tmp`;
    writeFileSync(temp, JSON.stringify(store));
    renameSync(temp, storeFile);
  } catch {
    // The lists are a convenience; a failed write must not stop the browser.
  }
}

// ---------- the shared session: permissions, POST detection, fetch/XHR log ----------

const byContents = new Map<number, PageTab>();
const watched = new WeakSet<Session>();
/// The pane of a server project's session. Every request of that session passes it, also one with no tab (a service worker).
const guarded = new WeakMap<Session, BrowserPane>();

function watchSession(ses: Session): void {
  if (watched.has(ses)) return;
  watched.add(ses);
  // No page gets the camera, the microphone, the clipboard, notifications or any other permission.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const started = new Map<number, { begin: number; epoch: number }>();
  const tabOf = (details: { webContentsId?: number }) => (details.webContentsId === undefined ? undefined : byContents.get(details.webContentsId));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const tab = tabOf(details);
    if (tab) {
      if (details.resourceType === 'xhr') started.set(details.id, { begin: Date.now(), epoch: tab.moveEpoch });
      if (details.resourceType === 'mainFrame') tab.postUnderWay = details.method === 'POST';
    }
    const pane = guarded.get(ses);
    if (!pane) return callback({});
    pane.mayRequest(details.url, details.resourceType, tab).then((ok) => callback(ok ? {} : { cancel: true }), () => callback({ cancel: true }));
  });
  /// The address a request really used, in case the name answered differently from the lookup before it.
  const used = (details: { url: string; webContentsId?: number; ip?: string }) => void guarded.get(ses)?.noticeAddress(details.url, details.ip, tabOf(details));
  ses.webRequest.onResponseStarted((details) => used(details));
  ses.webRequest.onBeforeRedirect((details) => used(details));
  const record = (details: { id: number; webContentsId?: number; method: string; url: string }, status: number, error?: string) => {
    const start = started.get(details.id);
    if (start === undefined) return;
    started.delete(details.id);
    const tab = tabOf(details);
    // A request of the page before this one stays out of this page's list.
    if (!tab || tab.moveEpoch !== start.epoch) return;
    tab.requests.push({ method: details.method, url: details.url, status, error, ms: Date.now() - start.begin });
    if (tab.requests.length > BUFFER_LIMIT) tab.requests.splice(0, tab.requests.length - BUFFER_LIMIT);
  };
  ses.webRequest.onCompleted((details) => {
    used(details);
    record(details, details.statusCode);
  });
  ses.webRequest.onErrorOccurred((details) => record(details, 0, details.error));
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/// A page that asks before it unloads, a changed form field or a focused editable area: ending the page would lose it.
const UNSAVED_PROBE = `(() => {
  if (window.onbeforeunload) return true;
  const active = document.activeElement;
  if (active && active.isContentEditable) return true;
  for (const e of document.querySelectorAll('input, textarea, select')) {
    if (e.tagName === 'SELECT') {
      const options = [...e.options];
      const changed = options.some(o => o.defaultSelected)
        ? options.some(o => o.selected !== o.defaultSelected)
        : (e.multiple ? options.some(o => o.selected) : e.selectedIndex > 0);
      if (changed) return true;
      continue;
    }
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(e.type)) continue;
    if (e.type === 'checkbox' || e.type === 'radio') { if (e.checked !== e.defaultChecked) return true; continue; }
    if (e.value !== e.defaultValue) return true;
  }
  return false;
})()`;

export interface PaneOptions {
  /// The project's id: the key of its saved tabs.
  id: string;
  /// Called for the web contents of each tab, awake or woken again (the window's keyboard shortcuts hook in here).
  onContents?: (wc: WebContents) => void;
  /// This project runs on a server: its own logins, and the rule for Claude on the server. `forwards` lists the ports here
  /// that this project owns.
  server?: { forwards: () => number[] };
}

/// The side browser of one project: page tabs, one WebContentsView each while awake, driven through the Chrome DevTools Protocol.
export class BrowserPane {
  private tabs: PageTab[] = [];
  private active = 1;
  private nextNumber = 1;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  /// The project is on screen and its browser column is showing.
  private shown = false;
  private readonly sleepTimer: NodeJS.Timeout;
  private destroyed = false;
  private readonly partition: string;
  /// The rule of a server project. `resolve` is the lookup; null means the session's own.
  readonly guard: { forwards: () => number[]; resolve: Resolver | null } | null;

  constructor(
    private readonly win: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    private readonly options: PaneOptions,
  ) {
    this.partition = partitionFor(options.id, !!options.server);
    const ses = electronSession.fromPartition(this.partition);
    watchSession(ses);
    this.guard = options.server ? { forwards: options.server.forwards, resolve: null } : null;
    if (options.server) guarded.set(ses, this);
    const saved = loadStore()[options.id];
    if (saved) {
      for (const t of saved.tabs) this.tabs.push(this.makeTab(t.number, t.url, t.title));
      this.nextNumber = Math.max(saved.next, ...saved.tabs.map((t) => t.number + 1));
      this.active = this.tabs.some((t) => t.number === saved.active) ? saved.active : this.tabs[0].number;
    } else {
      this.newBlankTab();
    }
    this.sleepTimer = setInterval(() => void this.sleepIdle(), 60_000);
    this.sleepTimer.unref?.();
  }

  // ---------- tabs ----------

  private makeTab(number: number, pending: string | null, title = ''): PageTab {
    return {
      number, view: null, url: pending ?? '', title, pending, asleep: false, saved: null, started: false, lastActive: Date.now(),
      typed: false, postResult: false, postUnderWay: false, allowedFile: null, preview: null, attached: false, localPage: false, tainted: false, moveBy: null, moveEpoch: 0, failure: null, failures: new Map(), failAt: null, console: [], requests: [],
    };
  }

  private newBlankTab(): PageTab {
    const tab = this.makeTab(this.nextNumber++, null);
    this.tabs.push(tab);
    this.active = tab.number;
    this.ensureView(tab);
    return tab;
  }

  /// The tab with this number, or the selected one.
  tab(number?: number): PageTab {
    if (number === undefined) {
      const tab = this.tabs.find((t) => t.number === this.active);
      if (!tab) throw new Error('no browser tab is open');
      return tab;
    }
    const tab = this.tabs.find((t) => t.number === number);
    if (!tab) throw new Error(`no tab #${number}; call browser_tabs`);
    return tab;
  }

  /// The selected tab's view, for code that has one page in mind. Absent only while that tab waits or sleeps.
  get view(): WebContentsView {
    const tab = this.tab();
    if (!tab.view) throw new Error('the selected tab has no page loaded');
    return tab.view;
  }

  private ensureView(tab: PageTab): WebContentsView {
    if (tab.view) return tab.view;
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: tab.preview?.partition ?? this.partition },
    });
    tab.view = view;
    tab.attached = false;
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.applyBounds(view);
    const wc = view.webContents;
    byContents.set(wc.id, tab);
    // A page of a server project cannot use WebRTC to reach the LAN past the request check.
    if (this.guard || tab.preview) wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    this.options.onContents?.(wc);

    const mayOpen = (url: string) => (tab.allowedFile ? url.split('#')[0] === tab.allowedFile : isAllowedUrl(url));
    wc.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      tab.started = true;
      this.applyVisible();
    });
    wc.on('will-navigate', (event, url) => {
      if (!mayOpen(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!mayOpen(url)) event.preventDefault();
    });
    // Pages never open new windows; a popup loads in the same tab instead.
    wc.setWindowOpenHandler(({ url }) => {
      if (!tab.allowedFile && isAllowedUrl(url)) void wc.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    const sync = () => {
      if (tab.view?.webContents !== wc || wc.isDestroyed()) return;
      // The toolbar keeps the failed address while the failure page is on show.
      const url = tab.failure && wc.getURL().startsWith(FAILURE_PAGE_PREFIX) ? tab.failure : wc.getURL();
      if (url) tab.url = url;
      const title = wc.getTitle();
      if (title) tab.title = title;
      this.changed();
    };
    wc.on('did-start-loading', sync);
    wc.on('did-stop-loading', sync);
    wc.on('page-title-updated', sync);
    wc.on('did-navigate', () => {
      tab.postResult = tab.postUnderWay;
      tab.postUnderWay = false;
      tab.typed = false;
      // A new page: what the last one logged is not this page's, and may be private.
      tab.console = [];
      tab.requests = [];
      tab.moveEpoch++;
      tab.moveBy = null;
      if (!/^https?:/i.test(wc.getURL())) tab.localPage = false;
      // The failure page adds no history item: once it is the page on show (or a real page replaced it), the entries
      // before it that are the failed address or an older failure page are removed, so Back goes to the page before
      // the failure. Electron's loadURL has no "replace" option, so this uses navigationHistory.removeEntryAtIndex.
      const landed = wc.getURL();
      // Back or Forward onto a failure page brings its failed address back (toolbar, Reload, saved tabs).
      if (landed.startsWith(FAILURE_PAGE_PREFIX)) tab.failure = tab.failures.get(landed) ?? tab.failure;
      if (landed.startsWith(FAILURE_PAGE_PREFIX) || (tab.failure && /^https?:/i.test(landed))) dropFailureEntries(wc, tab.failure, tab.failAt);
      if (!landed.startsWith(FAILURE_PAGE_PREFIX)) tab.failure = null;
      sync();
    });
    // A web page that cannot load shows a page in plain words instead of Chromium's English one. The page is a data
    // address: it has no origin, and the tab's preload-free, sandboxed settings above are all it gets.
    wc.on('did-fail-load', (_e, errorCode, _description, validatedURL, isMainFrame) => {
      if (tab.view?.webContents !== wc || wc.isDestroyed()) return;
      if (!shouldShowFailurePage({ errorCode, isMainFrame, url: validatedURL })) return;
      tab.failure = validatedURL;
      try { tab.failAt = wc.navigationHistory.getActiveIndex(); } catch { tab.failAt = null; }
      const page = failurePageUrl(validatedURL, errorCode);
      tab.failures.set(page, validatedURL);
      // Keep the last 20 only; each can be large.
      if (tab.failures.size > 20) tab.failures.delete(tab.failures.keys().next().value as string);
      // After the failed load has stopped: Electron settles a loadURL with its error only at did-stop-loading, and a
      // navigation that starts before that makes it end as ERR_ABORTED, which the address bar ignores (proof test 10).
      wc.once('did-stop-loading', () => {
        if (wc.isDestroyed() || tab.view?.webContents !== wc || tab.failure !== validatedURL) return;
        void wc.loadURL(page).catch(() => undefined);
      });
    });
    wc.on('did-navigate-in-page', sync);
    // The message arrives as properties of the event itself (Electron 35 and later).
    wc.on('console-message', (details: any) => {
      // Electron has no separate log and info level: both arrive as info and are kept as log.
      const level = details.level === 'warning' ? 'warn' : details.level === 'info' || details.level === 'debug' ? 'log' : details.level;
      tab.console.push({ level, text: String(details.message), date: Date.now() });
      if (tab.console.length > BUFFER_LIMIT) tab.console.splice(0, tab.console.length - BUFFER_LIMIT);
    });
    // Real keys only (the ref tools type through the page script): a typed-in page is not put to sleep.
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && !input.control && !input.meta && !input.alt && (input.key.length === 1 || input.key === 'Backspace' || input.key === 'Delete')) tab.typed = true;
    });
    return view;
  }

  private applyBounds(view: WebContentsView): void {
    const r = (n: number) => Math.max(0, Math.round(n));
    view.setBounds({ x: r(this.bounds.x), y: r(this.bounds.y), width: r(this.bounds.width), height: r(this.bounds.height) });
  }

  /// A native view lies over the page, so only the selected tab of the project on screen shows: a page that
  /// Claude opens in a project in the background must not appear over the project on screen.
  private applyVisible(): void {
    for (const tab of this.tabs) tab.view?.setVisible(this.shown && tab.number === this.active && tab.started);
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown) this.wakeInBackground(this.tab());
    this.applyVisible();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
    for (const tab of this.tabs) if (tab.view) this.applyBounds(tab.view);
  }

  private changed(): void {
    if (this.destroyed) return;
    this.onState(this.state());
    this.persist();
  }

  private persist(): void {
    const tabs = this.tabs.filter((t) => !t.allowedFile && isAllowedUrl(t.pending ?? t.url) && (t.pending ?? t.url) !== 'about:blank');
    saveProject(this.options.id, tabs.length ? { active: this.active, next: this.nextNumber, tabs: tabs.map((t) => ({ number: t.number, url: t.pending ?? t.url, title: t.title })) } : null);
  }

  /// Takes the views out of the window and ends their pages. The pane is not usable after this.
  destroy(): void {
    this.destroyed = true;
    clearInterval(this.sleepTimer);
    for (const tab of this.tabs) this.closeView(tab);
    saveProject(this.options.id, null);
  }

  private closeView(tab: PageTab): void {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    // A preview's session and address end with its view.
    tab.preview?.close();
    tab.preview = null;
    tab.allowedFile = null;
    byContents.delete(view.webContents.id);
    this.win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      try { if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach(); } catch { /* already gone */ }
      view.webContents.close();
    }
  }

  // ---------- state ----------

  state(): BrowserState {
    const tabs = this.tabs.map((t): TabInfo => ({
      number: t.number, title: t.title, url: t.url, loading: !!t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isLoading(),
      active: t.number === this.active, asleep: t.asleep, waiting: t.pending !== null,
    }));
    const now = tabs.find((t) => t.active) ?? { url: '', title: '', loading: false };
    // A sleeping page keeps its history; the press wakes it, so it stays on.
    const active = this.tabs.find((t) => t.number === this.active);
    const history = active?.view && !active.view.webContents.isDestroyed() ? active.view.webContents.navigationHistory : null;
    return { url: now.url, title: now.title, loading: now.loading, canGoBack: history ? history.canGoBack() : !!active?.asleep, canGoForward: history ? history.canGoForward() : !!active?.asleep, tabs };
  }

  /// For the tests: what each tab holds in the main process.
  debug(): { tabs: { number: number; url: string; active: boolean; visible: boolean; asleep: boolean; pending: boolean; pid: number | null }[] } {
    return {
      tabs: this.tabs.map((t) => ({
        number: t.number, url: t.url, active: t.number === this.active, visible: !!t.view && t.view.getVisible(),
        asleep: t.asleep, pending: t.pending !== null, pid: t.view ? t.view.webContents.getOSProcessId() || null : null,
      })),
    };
  }

  async describeTabs(): Promise<string> {
    const lines = await Promise.all(this.tabs.map(async (t) => {
      const mark = `${t.number === this.active ? '*' : ' '} #${t.number}  `;
      // The list does not say what the person has open on this computer.
      if (isServerCaller() && !(await this.readable(t))) return `${mark}(a page on this computer)`;
      return `${mark}${t.title || hostOf(t.url)}  ${t.url}`;
    }));
    return lines.join('\n');
  }

  // ---------- the rule for Claude on a server ----------

  private resolve: Resolver = (host) => {
    if (this.guard?.resolve) return this.guard.resolve(host);
    return electronSession.fromPartition(this.partition).resolveHost(host).then((answer) => answer.endpoints.map((e) => e.address));
  };

  private addressOk(url: string): Promise<boolean> {
    return this.guard ? addressAllowed(url, this.guard.forwards(), this.resolve) : Promise.resolve(false);
  }

  /// Each request of a server project's session, redirects too. Refused: a private, loopback or link-local address, by
  /// name or by number, except this project's forward. A page the person opened on this computer may load its own parts.
  async mayRequest(url: string, type: string, tab: PageTab | undefined): Promise<boolean> {
    // Who moved is read now: the answer below takes time, and the next load may begin during it.
    const by = type === 'mainFrame' && tab ? tab.moveBy : null;
    if (type === 'mainFrame' && tab) tab.moveBy = null;
    if (/^(about|data|blob|devtools):/i.test(url)) return true;
    // A local file shows in a session of its own, so no file: address belongs in this one.
    if (/^file:/i.test(url)) return false;
    const allowed = /^(https?|wss?):/i.test(url) && (await this.addressOk(url));
    if (type === 'mainFrame' && tab) {
      if (allowed) {
        tab.localPage = false;
        tab.tainted = false;
        return true;
      }
      if (by === 'person' || (by === null && tab.localPage)) {
        tab.localPage = true;
        return true;
      }
      return false;
    }
    return allowed || !!tab?.localPage || !!tab?.allowedFile;
  }

  /// After the fact, the address a request used. A name can change its answer between the lookup and the connection, so
  /// this ends the page. Through a proxy of this computer's settings the address is the proxy's and says nothing.
  async noticeAddress(url: string, ip: string | undefined, tab: PageTab | undefined): Promise<void> {
    if (!this.guard || !ip || !isPrivateAddress(ip)) return;
    if (tab?.localPage || tab?.allowedFile || isForward(url, this.guard.forwards())) return;
    const route = await electronSession.fromPartition(this.partition).resolveProxy(url).catch(() => 'DIRECT');
    if (route !== 'DIRECT') return;
    for (const t of tab ? [tab] : this.tabs) {
      if (t.localPage || t.allowedFile) continue;
      t.tainted = true;
      void this.leave(t);
    }
  }

  private async leave(tab: PageTab): Promise<void> {
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    await wc?.loadURL('about:blank').catch(() => undefined);
  }

  /// May Claude on the server see this tab now: its page, and each frame in it. Judged again at each read and each move.
  private async readable(tab: PageTab): Promise<boolean> {
    if (!this.guard || tab.localPage || tab.tainted || tab.allowedFile) return false;
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    // While the failure page is on show, the failed address is what is judged: a public one stays readable, a LAN or
    // local one is refused, and an unknown one is refused.
    const main = tab.pending ?? judgedAddress(wc?.getURL() || tab.url, tab.failure);
    if (main === null || (main && !(await this.addressOk(main)))) return false;
    if (!wc || tab.pending !== null) return true;
    try {
      for (const frame of wc.mainFrame.framesInSubtree) {
        const url = frame.url;
        if (url && !/^(about|data|blob|chrome-error):/i.test(url) && !(await this.addressOk(url))) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private async assertReadable(tab: PageTab): Promise<void> {
    if (isServerCaller() && !(await this.readable(tab))) throw new Error(CANNOT_READ);
  }

  /// The next load of this tab: by whom it began decides whether it may go to this computer.
  private markMove(tab: PageTab): void {
    tab.moveBy = isServerCaller() ? 'server' : 'person';
    tab.tainted = false;
  }

  /// A load for a tool. A refused address, from the start or at a redirect, is told in plain words.
  private async load(tab: PageTab, wc: WebContents, url: string): Promise<void> {
    try {
      await loadWithin(wc, url, 15);
    } catch (error) {
      if (isServerCaller() && blockedLoad(error)) {
        await this.leave(tab);
        throw new Error(LED_AWAY);
      }
      throw error;
    }
  }

  // ---------- opening, selecting, closing ----------

  /// Opens a tab and selects it. With an address it loads it and waits; a failed load is told in plain words, the tab stays.
  /// `localFile` is the real path of a local .html file, which shows in a session of its own (./previewPage.ts).
  async newTab(input?: string, localFile?: string): Promise<{ number: number; status: string }> {
    const url = input ? normalizeUrl(input) : undefined;
    if (url && !isAllowedUrl(url)) throw new Error(`only web addresses (http, https) open here: ${url}`);
    if (isServerCaller() && (localFile || (url && !(await this.addressOk(url))))) throw new Error(LED_AWAY);
    const previous = this.tabs.find((t) => t.number === this.active);
    if (previous) previous.lastActive = Date.now();
    // The empty tab a new browser starts with is the first tab, not one more.
    const lone = this.tabs.length === 1 ? this.tabs[0] : null;
    const tab = lone && !lone.url && !lone.pending && !lone.started ? lone : this.newBlankTab();
    this.active = tab.number;
    if (localFile) {
      // A view keeps the session it was made with, so a preview always gets a new view in its own session.
      this.closeView(tab);
      tab.preview = openPreviewPage(localFile);
      tab.allowedFile = tab.preview.url;
      this.ensureView(tab);
    }
    this.applyVisible();
    this.changed();
    const target = tab.allowedFile ?? url;
    if (!target) return { number: tab.number, status: 'empty' };
    this.markMove(tab);
    try {
      await this.load(tab, tab.view!.webContents, target);
    } catch (error) {
      if (String(error).includes(LED_AWAY)) throw error;
      return { number: tab.number, status: `could not load: ${String(error).replace(/^Error: /, '')}` };
    }
    return { number: tab.number, status: await this.waitForLoad(tab, 15) };
  }

  select(number: number): void {
    const tab = this.tab(number);
    const previous = this.tabs.find((t) => t.number === this.active);
    if (previous) previous.lastActive = Date.now();
    this.active = tab.number;
    tab.lastActive = Date.now();
    this.wakeInBackground(tab);
    this.applyVisible();
    this.changed();
  }

  close(number: number): void {
    const tab = this.tab(number);
    const at = this.tabs.indexOf(tab);
    this.closeView(tab);
    this.tabs.splice(at, 1);
    if (!this.tabs.length) {
      this.newBlankTab();
    } else if (this.active === number) {
      this.active = this.tabs[Math.min(at, this.tabs.length - 1)].number;
      this.wakeInBackground(this.tab());
    }
    this.applyVisible();
    this.changed();
  }

  // ---------- sleep and wake ----------

  /// Starts loading a waiting or sleeping tab, without waiting for the page.
  private wakeInBackground(tab: PageTab): void {
    void this.wake(tab, false);
  }

  /// Gives a waiting or sleeping tab its page back. `settle` waits until the load ends.
  private async wake(tab: PageTab, settle: boolean): Promise<void> {
    tab.lastActive = Date.now();
    if (tab.pending === null && !tab.asleep) return;
    const pending = tab.pending;
    const saved = tab.saved;
    tab.pending = null;
    tab.asleep = false;
    tab.saved = null;
    const wc = this.ensureView(tab).webContents;
    this.markMove(tab);
    try {
      if (pending) await loadWithin(wc, pending, 15);
      else if (saved?.entries.length) await wc.navigationHistory.restore({ entries: saved.entries, index: saved.index });
      else if (tab.url) await wc.loadURL(tab.url);
    } catch (error) {
      // A redirect aborts the first load; the page still arrives. Other failures show in the page itself.
      void error;
    }
    if (settle) await this.waitForLoad(tab, 15);
    this.changed();
  }

  /// Ends the pages of tabs that are not selected and have been idle for `after` ms. Returns the numbers that slept.
  async sleepIdle(now = Date.now(), after = SLEEP_AFTER_MS): Promise<number[]> {
    const slept: number[] = [];
    const fit = (tab: PageTab) => !!tab.view && !tab.view.webContents.isDestroyed() && tab.number !== this.active && !tab.asleep && tab.pending === null
      && !tab.allowedFile && !tab.postResult && !tab.typed && !!tab.view.webContents.getURL() && now - tab.lastActive >= after
      && !tab.view.webContents.isCurrentlyAudible();
    for (const tab of this.tabs.filter(fit)) {
      let unsaved = true;
      try {
        unsaved = !!(await tab.view!.webContents.executeJavaScript(UNSAVED_PROBE));
      } catch {
        // A failed check counts as unsaved input.
      }
      // The person may have used the tab while the check ran.
      if (unsaved || !this.tabs.includes(tab) || !fit(tab)) continue;
      this.sleep(tab);
      slept.push(tab.number);
    }
    if (slept.length) this.changed();
    return slept;
  }

  /// Saves the history, then closes the page. Closing is what ends the process: a released view alone keeps it alive.
  private sleep(tab: PageTab): void {
    const wc = tab.view!.webContents;
    const nav = wc.navigationHistory;
    tab.saved = { entries: nav.getAllEntries().map((e) => ({ url: e.url.startsWith(FAILURE_PAGE_PREFIX) ? (tab.failures.get(e.url) ?? tab.failure ?? e.url) : e.url, title: e.title })), index: nav.getActiveIndex() };
    tab.url = tab.failure ?? (wc.getURL() || tab.url);
    tab.title = wc.getTitle() || tab.title;
    tab.asleep = true;
    tab.failure = null;
    tab.failures.clear();
    tab.started = false;
    this.closeView(tab);
  }

  // ---------- page work ----------

  /// A waiting or sleeping tab has no page to read: load it first and let it settle.
  private async awaken(tab: PageTab): Promise<WebContents> {
    await this.wake(tab, true);
    tab.lastActive = Date.now();
    return this.ensureView(tab).webContents;
  }

  /// Waits until the tab stops loading (or the timeout passes), then says where it is.
  async waitForLoad(tab: PageTab, timeoutSeconds: number): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    await pause(150);
    while (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.isLoading() && Date.now() < deadline) await pause(100);
    // The rule holds for where the move landed: a public page can lead to this computer.
    if (isServerCaller() && !(await this.readable(tab))) {
      await this.leave(tab);
      throw new Error(LED_AWAY);
    }
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    return `${wc?.getTitle() || tab.title} — ${tab.failure ?? (wc?.getURL() || tab.url)}`;
  }

  async navigate(input: string, number?: number): Promise<string> {
    const url = normalizeUrl(input);
    if (!isAllowedUrl(url)) throw new Error(`only web addresses (http, https) open here: ${url}`);
    const tab = this.tab(number);
    if (isServerCaller()) {
      if (!(await this.addressOk(url))) throw new Error(LED_AWAY);
      // A sleeping page is not restored for a call that leaves it: it may be a page the person opened on this computer.
      tab.asleep = false;
      tab.saved = null;
    }
    // A page loaded here is a web page again, whatever the tab showed before. It must not load in the preview's session.
    if (tab.preview) this.closeView(tab);
    tab.pending = null;
    const wc = tab.asleep ? await this.awaken(tab) : this.ensureView(tab).webContents;
    tab.lastActive = Date.now();
    this.markMove(tab);
    await this.load(tab, wc, url);
    return this.waitForLoad(tab, 15);
  }

  async backAndWait(number?: number): Promise<string> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const wc = await this.awaken(tab);
    this.markMove(tab);
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    return this.waitForLoad(tab, 10);
  }

  async forwardAndWait(number?: number): Promise<string> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const wc = await this.awaken(tab);
    this.markMove(tab);
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    return this.waitForLoad(tab, 10);
  }

  async reloadAndWait(number?: number): Promise<string> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const wc = await this.awaken(tab);
    this.markMove(tab);
    // On the failure page, Reload loads the failed address (reloading the data page would only show it again).
    if (tab.failure) void wc.loadURL(tab.failure).catch(() => undefined);
    else wc.reload();
    return this.waitForLoad(tab, 15);
  }

  /// The toolbar and the menu: the same moves without waiting.
  back(): void { void this.backAndWait().catch(() => undefined); }
  forward(): void { void this.forwardAndWait().catch(() => undefined); }
  reload(): void { void this.reloadAndWait().catch(() => undefined); }

  async snapshot(number?: number): Promise<string> {
    return String((await this.evaluate(SNAPSHOT, number)) ?? '(empty page)');
  }

  private async ensureActions(number?: number): Promise<void> {
    if (!(await this.evaluate('Boolean(window.__vibex && window.__vibex.click)', number))) await this.evaluate(ACTIONS, number);
  }

  async click(ref: string, number?: number): Promise<string> {
    await this.ensureActions(number);
    const tab = this.tab(number);
    const before = tab.view?.webContents.getURL();
    const result = String((await this.evaluate(`window.__vibex.click(${JSON.stringify(ref)})`, number)) ?? 'clicked');
    // Give a navigation a moment to start, then settle, so the reply says where the page is now.
    await pause(250);
    if (tab.view && (tab.view.webContents.isLoading() || tab.view.webContents.getURL() !== before)) return `${result}; now at ${await this.waitForLoad(tab, 10)}`;
    return result;
  }

  async type(ref: string, text: string, submit = false, number?: number): Promise<string> {
    await this.ensureActions(number);
    return String((await this.evaluate(`window.__vibex.type(${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${submit})`, number)) ?? 'typed');
  }

  async press(key: string, number?: number): Promise<string> {
    await this.ensureActions(number);
    return String((await this.evaluate(`window.__vibex.press(${JSON.stringify(key)})`, number)) ?? 'pressed');
  }

  async scroll(ref: string | undefined, dx: number, dy: number, number?: number): Promise<string> {
    await this.ensureActions(number);
    return String((await this.evaluate(`window.__vibex.scroll(${ref === undefined ? 'null' : JSON.stringify(ref)}, ${dx}, ${dy})`, number)) ?? 'scrolled');
  }

  async text(number?: number): Promise<string> {
    await this.ensureActions(number);
    return String((await this.evaluate('window.__vibex.text()', number)) ?? '');
  }

  /// Waits for milliseconds, then for a selector or for text; times out with a plain error.
  async wait(options: { ms?: number; selector?: string; text?: string; timeout: number }, number?: number): Promise<string> {
    if (options.ms) await pause(options.ms);
    if (options.selector === undefined && options.text === undefined) return 'waited';
    const probe = options.selector !== undefined
      ? `Boolean(document.querySelector(${JSON.stringify(options.selector)}))`
      : `(document.body && document.body.innerText || '').includes(${JSON.stringify(options.text)})`;
    const deadline = Date.now() + options.timeout * 1000;
    while (Date.now() < deadline) {
      if ((await this.evaluate(probe, number)) === true) return 'found';
      await pause(200);
    }
    throw new Error(`timed out waiting for ${options.selector ?? options.text}`);
  }

  /// Runs JavaScript in the page and returns the result as JSON text; promises are awaited, errors come back as text.
  async run(javaScript: string, number?: number): Promise<string> {
    const body = `(async () => {
      try {
        const value = await (async () => { return eval(${JSON.stringify(javaScript)}); })();
        if (value === undefined) return "undefined";
        try { return JSON.stringify(value, null, 1); } catch (e) { return String(value); }
      } catch (error) {
        return "Error: " + (error && (error.stack || error.message) || String(error));
      }
    })()`;
    return String((await this.evaluate(body, number)) ?? 'null').slice(0, 60_000);
  }

  async consoleLines(number: number | undefined, level: string | undefined, clear: boolean): Promise<string> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    // log and info are one level here, so asking for either shows both.
    const same = (a: string) => (level === undefined || a === level || (a === 'log' && level === 'info'));
    const lines = tab.console.filter((e) => same(e.level)).slice(-200).map((e) => `${clock(e.date)} [${e.level}] ${e.text}`);
    if (clear) tab.console = [];
    return lines.length ? lines.join('\n') : 'No console output.';
  }

  async requestLines(number: number | undefined, failedOnly: boolean, clear: boolean): Promise<string> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const lines = tab.requests.filter((r) => !failedOnly || r.status === 0 || r.status >= 400).slice(-200)
      .map((r) => `${r.method} ${r.url} → ${r.status === 0 ? (r.error ?? 'failed') : r.status} ${r.ms}ms`);
    if (clear) tab.requests = [];
    return lines.length ? lines.join('\n') : 'No requests recorded.';
  }

  /// JPEG of a tab, downscaled to maxWidth.
  async screenshot(maxWidth = 1024, number?: number): Promise<Buffer> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const wc = await this.awaken(tab);
    // stayHidden: a project in the background stays hidden while Claude looks at its page.
    let image = await wc.capturePage(undefined, { stayHidden: !(this.shown && tab.number === this.active) });
    // The page may have moved while the picture was taken.
    await this.assertReadable(tab);
    const { width } = image.getSize();
    if (width > maxWidth) image = image.resize({ width: maxWidth, quality: 'good' });
    return image.toJPEG(80);
  }

  /// Runs an expression in the page through CDP Runtime.evaluate; promises are awaited.
  async evaluate(expression: string, number?: number): Promise<unknown> {
    const tab = this.tab(number);
    await this.assertReadable(tab);
    const wc = await this.awaken(tab);
    const result = await this.cdp(tab, wc, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    tab.lastActive = Date.now();
    // The page may have moved while the script ran: its answer is then not given.
    await this.assertReadable(tab);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page script failed');
    }
    return result.result?.value;
  }

  private async cdp(tab: PageTab, wc: WebContents, method: string, params: object = {}): Promise<any> {
    const dbg = wc.debugger;
    if (!tab.attached || !dbg.isAttached()) {
      dbg.attach('1.3');
      tab.attached = true;
      dbg.on('detach', () => {
        tab.attached = false;
      });
    }
    return dbg.sendCommand(method, params);
  }
}

/// Removes the history entries just before the page on show that are the failure's own (see failureEntriesToDrop).
function dropFailureEntries(wc: WebContents, failed: string | null, failAt: number | null): void {
  try {
    const nav = wc.navigationHistory;
    const urls = nav.getAllEntries().map((e) => e.url);
    for (const index of failureEntriesToDrop(urls, nav.getActiveIndex(), failed, failAt)) {
      if (!nav.removeEntryAtIndex(index)) break;
    }
  } catch {
    // The history is left as it is: one extra Back step, never a lost page.
  }
}

/// Loads an address and waits for it, at most `seconds`. A redirect or a client-side navigation aborts the first
/// load while the page still arrives, so that error is not one.
async function loadWithin(wc: WebContents, url: string, seconds: number): Promise<void> {
  const load = wc.loadURL(url).catch((error: unknown) => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
  });
  await Promise.race([load, pause(seconds * 1000)]);
  // A load that fails after the wait must not become an unhandled rejection.
  void load.catch(() => undefined);
}

function hostOf(url: string): string {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') : 'New Tab';
  } catch {
    return 'New Tab';
  }
}

function clock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
