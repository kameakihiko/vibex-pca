import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent, session } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { APP_URL, registerAppSchemes, serveAppWindow } from './appPage';
import { BrowserPane } from './browser';
import { startMcp } from './mcp';
import { Projects, type ProjectInfo } from './projects';
import { matchesAccelerator } from './keys';
import { MODULES, moduleMenu, type ModuleHost } from './modules';
import { hubTestHooks, ServerHub } from './serverHub';
import type { Crypt } from './serverSecrets';
import { findProfile, loadProfiles, profilesError, readProfiles } from './servers';
import { runningWork, verbFor, pronounFor, workPhrase, type Work } from './runningWork';
import { agentLaunch, defaultShell, inProject, Terminals, loginPathReady } from './terminals';
import { skipInstallAtQuit } from './updater';
import { chatService, nativeChatIsDefault } from './chat';
import { agentsInbox } from './agentsGo';
import { claimClaudeFound, findClaude, registerWithClaude } from './claude';
import { boundedLog, installFaultGuard, startEndedByQuit } from './faultGuard';
import { endLookups } from './programs';
import { refreshWindowsPath } from './windowsPath';
import { answerSecondStart, endHolder, firstAnswered, holderGone, newStartKey, noteHolder, SECOND_START_MS } from './secondStart';
import { buildKind, isTestRun, testEnv } from './testSwitches';
import { hwndText, presenceAuthenticator, presenceHelperPath, windowsPresence, type Authenticator } from './savedSecretGate';
import { loadMcpToken, osStoreAvailable, readStoredToken, type TokenStore } from './token';

// Tests point the profile somewhere else; this must happen before 'ready'. Not for a portable run: a packaged app takes
// Chromium's own --user-data-dir for that, so this stays a test switch.
const testProfile = testEnv('VIBEX_USER_DATA');
if (testProfile) app.setPath('userData', testProfile);

registerAppSchemes();

// `--mcp-headers`: Claude Code runs this (MCP headersHelper) to get the Authorization header. It prints one
// JSON object and quits; it never opens a window or touches the running app.
const headersMode = process.argv.includes('--mcp-headers');
if (headersMode) {
  app.whenReady().then(() => {
    const token = readStoredToken();
    // A pipe is asynchronous on Windows: an exit right after the write loses the text, and Claude then connects with no key.
    if (token) process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }) + '\n', () => app.exit(0));
    else process.stderr.write('Vibex PCA: no MCP key in the system store yet; start Vibex PCA once.\n', () => app.exit(1));
  });
}

const terminals = new Terminals();
let win: BrowserWindow | null = null;
/// A message for the person from before the page could take it.
let waitingFault: string | null = null;
if (!headersMode) installFaultGuard(process, {
  log: (text) => {
    console.error(text);
    boundedLog(path.join(app.getPath('userData'), 'vibex-errors.log'))(text);
  },
  show: (text) => {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('mod:app:fault', text);
    else waitingFault = text;
  },
});
let projects: Projects;
let hub: ServerHub;
/// A sheet or the server form shows: the native page lies over the window, so it steps back.
const browserCover = new Set<string>();
/// One browser per project, made at the first page it asks for.
const browsers = new Map<string, BrowserPane>();
/// Where the browser column is, and whether it shows, for the project on screen.
let browserArea = { x: 0, y: 0, width: 0, height: 0 };
let browserAreaShown = false;
/// Projects whose first tabs have started. A restored project starts its tabs when it is first shown.
const started = new Set<string>();
let lastShown: string | null = null;
/// Set after the person agreed to quit, so that the second close goes through.
let quitAgreed = false;
const START_KEY = newStartKey();
let quitting = false;
let asking = false;
/// What the Claude registration needs again after Setup installs Claude; set once the tool server runs.
let registration: { port: number; store: TokenStore } | null = null;
const status: { version: string; platform: string; mcpPort: number | null; mcpError: string | null; tokenStore: TokenStore | null; claude: string; claudeInstalled: boolean; foundClaimed?: boolean } = {
  version: app.getVersion(),
  platform: process.platform,
  mcpPort: null,
  mcpError: null,
  tokenStore: null,
  claude: 'not checked',
  claudeInstalled: testEnv('VIBEX_CLAUDE_MISSING') !== '1' && !!findClaude(),
};

/// Another copy holds the lock. A healthy one answers and shows its window. One that stayed after its quit answers nothing: with no word
/// here, a click on the icon would seem to do nothing until a restart of the PC (review 4, C1).
async function secondStart(): Promise<void> {
  const folder = app.getPath('userData');
  if (await firstAnswered(folder, START_KEY, SECOND_START_MS)) {
    app.quit();
    return;
  }
  boundedLog(path.join(folder, 'vibex-errors.log'))('A second start found an older copy that does not answer.');
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Vibex PCA',
    message: 'Vibex PCA did not open. An older copy of it still runs, and it does not answer.',
    detail: 'End the Old Copy closes that copy and starts Vibex PCA again. Work that it did not save is lost. If this does not help, restart the PC.',
    buttons: ['End the Old Copy', 'Close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    if (endHolder(folder) && (await holderGone(folder))) app.relaunch();
    else dialog.showErrorBox('Vibex PCA', 'The older copy could not be closed. Restart the PC, then open Vibex PCA.');
  }
  app.exit(0);
}

if (headersMode) {
  // handled above
} else if (!app.requestSingleInstanceLock({ vibexStart: START_KEY })) {
  app.whenReady().then(secondStart).catch(() => app.exit(1));
} else {
  noteHolder(app.getPath('userData'));
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    answerSecondStart(app.getPath('userData'), data, quitting);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(start).catch((error) => {
    if (startEndedByQuit({ quitting, windowMade: !!win, windowGone: !win || win.isDestroyed() })) {
      console.error(`Vibex PCA: the quit ended the start: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    // A throw while starting must not leave a blank window.
    dialog.showErrorBox('Vibex PCA could not start', `${String(error?.message ?? error)}\n\nClose Vibex PCA and start it again. If this repeats, send this text to the person who installed it.`);
    app.quit();
  });
}

// Test runs under Playwright on Windows only: its --inspect makes a thread that Node joins at exit, and in some runs that join did not end
// (run 41443516515: the main thread in FreeEnvironment > uv_thread_join, the InspectorIo thread still in uv_run, after the app's own exit event).
// A release has no inspector. tests/quit-plain.spec.ts holds the quit with no inspector, with no such guard.
if (process.platform === 'win32' && testEnv('VIBEX_TEST') && require('node:inspector').url()) {
  process.on('exit', () => {
    const root = process.env.SystemRoot || 'C:\\Windows';
    spawn(path.win32.join(root, 'System32', 'cmd.exe'), ['/d', '/c', `ping -n 9 127.0.0.1 >nul & taskkill /F /T /PID ${process.pid}`], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

// Chromium writes localStorage a moment later: a quick quit lost the last layout change (frame test 23, about 1 run in 30).
app.on('before-quit', () => { if (app.isReady()) session.defaultSession.flushStorageData(); });

app.on('window-all-closed', () => {
  if (headersMode) return;
  hub?.closeAll();
  terminals.closeAll();
  app.quit();
});

// app.quit() (Exit, a signal, the system ending the session) closes the windows with no window-all-closed, so what the app
// started goes here. Each of these can run twice.
app.on('will-quit', () => {
  if (headersMode) return;
  hub?.closeAll();
  terminals.closeAll();
  endLookups();
});

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

/// IPC is accepted only from the app's own window, never from the side browser's pages.
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!win && event.sender === win.webContents;
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('IPC from an unknown sender');
    return fn(...args);
  });
}

function on(channel: string, fn: (...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (fromApp(event)) fn(...args);
  });
}

function createTab(pane: string) {
  const project = projects.current();
  if (!project) throw new Error('no project is open');
  if (pane === 'agent-terminal') return terminals.create(project.server ? hub.launch(project, 'agent') : chatService.terminalClaude(project));
  // A chat in a server project runs Claude on the server (serverChat.ts). Which tab is the default there stays as it was.
  if (pane === 'agent-chat') return terminals.create(chatService.launch(project));
  return terminals.create(launchFor(project, pane === 'agent' ? 'agent' : 'shell'));
}

function launchFor(project: ProjectInfo, pane: 'agent' | 'shell') {
  // Before the shell and Claude are looked for, not only before the tab starts.
  refreshWindowsPath();
  if (project.server) return hub.launch(project, pane);
  if (pane === 'agent' && nativeChatIsDefault()) return chatService.launch(project);
  return inProject(pane === 'agent' ? agentLaunch() : defaultShell(), project);
}

/// The first show of a project starts its Claude tab and its terminal tab. Each is checked apart, because a tool
/// call may have started a terminal tab in the background already.
function startTabs(project: ProjectInfo): void {
  if (started.has(project.id)) return;
  started.add(project.id);
  const own = terminals.list().filter((t) => t.project === project.id);
  try {
    if (!own.some((t) => t.pane === 'agent')) terminals.create(launchFor(project, 'agent'));
    // A command tab that a tool started is no terminal for the person.
    if (!own.some((t) => t.pane === 'shell' && t.kind !== 'none')) terminals.create(launchFor(project, 'shell'));
  } catch (error) {
    // The server profile was removed while the app ran.
    started.delete(project.id);
    void dialog.showMessageBox(win!, { type: 'warning', message: `Could not start ${project.name}`, detail: String(error).replace(/^Error: /, '') });
  }
}

function browserFor(project: ProjectInfo): BrowserPane {
  let pane = browsers.get(project.id);
  if (!pane) {
    pane = new BrowserPane(win!, (state) => send('browser:state', project.id, state), {
      id: project.id,
      server: project.server ? { forwards: () => hub.guard().forwards(project) } : undefined,
      // Each tab's page, also one woken again, hands the window's shortcuts back to the menu.
      onContents: (wc) => wc.on('before-input-event', runMenuShortcut),
    });
    browsers.set(project.id, pane);
    pane.setBounds(browserArea);
    pane.setShown(project.id === projects.current()?.id && browserAreaShown && !browserCover.size);
  }
  return pane;
}

function placeBrowsers(): void {
  const current = projects.current()?.id;
  for (const [id, pane] of browsers) {
    // Each view keeps the size of the column, so a page in the background lays out as it will when it shows.
    pane.setBounds(browserArea);
    pane.setShown(id === current && browserAreaShown && !browserCover.size);
  }
}

function snapshot() {
  return { projects: projects.list(), current: projects.current()?.id ?? null, recents: projects.recents(), known: projects.knownIds() };
}

/// Tells the window which project is on screen, then starts its tabs if this is its first show.
function showCurrent(): void {
  const onScreen = projects.current()?.id ?? null;
  if (onScreen !== lastShown) {
    // The window answers with the new project's area; until then no page may lie over its columns.
    lastShown = onScreen;
    browserAreaShown = false;
    win?.webContents.focus();
  }
  placeBrowsers();
  send('projects:changed', snapshot());
  const project = projects.current();
  if (project) startTabs(project);
}

function openFolder(folder: string): ProjectInfo {
  try {
    const project = projects.open(folder);
    showCurrent();
    return project;
  } catch (error) {
    // The list drawn on screen may name the folder that was just found gone.
    send('projects:changed', snapshot());
    throw error;
  }
}

/// A tool opens a project on the rail and leaves the screen and the keyboard alone: another project's Claude must
/// not move the person's typing into a third project.
function openFolderForTool(folder: string): ProjectInfo {
  const project = projects.open(folder, true);
  showCurrent();
  return project;
}

/// The window's close button and Exit end every project's tabs, so they ask, as Close Project does for one.
/// Closing a tab where work runs asks first, in a person's own run; tests turn the question on themselves.
async function closeTabAsking(id: number): Promise<void> {
  const askInTests = (globalThis as any).__vibexTest?.askOnClose === true;
  if (terminals.busy(id) && (!isTestRun() || askInTests)) {
    const tab = terminals.list().find((t) => t.id === id);
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Close ${tab?.title ?? 'this tab'}?`,
      // A command tab does not come back: its command never runs twice without a person asking.
      detail: tab?.chat ? 'Claude stops what it is doing. Reopen Closed Tab brings this conversation back, and sends nothing.' : tab?.kind === 'none' ? 'What runs in this tab stops. It does not start again.' : 'What runs in this tab stops. Reopen Closed Tab starts the tab again, with a new session.',
      buttons: ['Close Tab', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  terminals.close(id);
}

function reopenTab(): void {
  const project = projects.current();
  if (project) terminals.reopenClosed(project.id);
}

/// Only busy work asks: an idle shell tab stops nothing (Swift #49 A1, A2). One project, or all.
function busyWork(project?: string): Work {
  return runningWork(terminals.list().filter((t) => !project || t.project === project).map((t) => ({ ...t, busy: terminals.busy(t.id) })));
}

async function askBeforeQuit(): Promise<void> {
  if (asking) return;
  asking = true;
  const work = busyWork();
  if (!work.total) {
    // The work ended while the question was being made: nothing left to protect.
    asking = false;
    quitAgreed = true;
    if (win && !win.isDestroyed()) win.close();
    return;
  }
  const { response } = await dialog.showMessageBox(win!, {
    type: 'warning',
    message: 'Quit Vibex PCA?',
    detail: `${workPhrase(work)} ${verbFor(work.total)} in ${work.projects === 1 ? '1 project' : `${work.projects} projects`}. Quitting stops ${pronounFor(work.total)}. The projects come back at the next start, with new sessions.`,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  asking = false;
  if (response !== 0) return;
  quitAgreed = true;
  if (win && !win.isDestroyed()) win.close();
}

/// An update's restart: the same question, when work runs; the update then does the quitting.
async function agreeToQuit(): Promise<boolean> {
  const work = busyWork();
  if (work.total) {
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: 'Restart to update?',
      detail: `${workPhrase(work)} ${verbFor(work.total)} in ${work.projects === 1 ? '1 project' : `${work.projects} projects`}. Restarting stops ${pronounFor(work.total)}. If you cancel, the update installs when you quit.`,
      buttons: ['Restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
  }
  quitAgreed = true;
  return true;
}

/// The system ends the app: nobody can answer a question now, so it must not stop the quit.
function quitWithoutAsking(): void {
  quitAgreed = true;
  app.quit();
}

/// See keys.ts. Only the app's own items: an Edit role such as Copy stays with the page.
function runMenuShortcut(event: Electron.Event, input: Electron.Input): void {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return;
  const find = (menu: Electron.Menu | null | undefined): Electron.MenuItem | undefined => {
    for (const item of menu?.items ?? []) {
      if (item.accelerator && !item.role && matchesAccelerator(item.accelerator, input)) return item;
      const inner = find(item.submenu);
      if (inner) return inner;
    }
    return undefined;
  };
  const item = find(Menu.getApplicationMenu());
  if (!item) return;
  event.preventDefault();
  item.click();
}

async function pickFolders(): Promise<void> {
  const picked = await dialog.showOpenDialog(win!, { title: 'Open Project', buttonLabel: 'Open', properties: ['openDirectory', 'multiSelections'] });
  if (!picked.canceled) picked.filePaths.forEach(openFolder);
}

/// Closing ends the project's Claude sessions and terminal commands, so it asks while any of them still runs.
async function closeProject(id: string): Promise<void> {
  const project = projects.get(id);
  if (!project) return;
  const work = busyWork(id);
  if (work.total) {
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Close ${project.name}?`,
      detail: `${workPhrase(work)} ${verbFor(work.total)} in this project. Closing the project stops ${work.total === 1 ? 'it' : 'all of them'}. The folder stays as it is.`,
      buttons: ['Close Project', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  terminals.closeProject(id);
  browsers.get(id)?.destroy();
  browsers.delete(id);
  started.delete(id);
  hub.projectClosed(id);
  projects.close(id);
  showCurrent();
}

const revealLabel = process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in File Explorer' : 'Show in Files';

function revealProject(id: string): void {
  const project = projects.get(id);
  if (project && !project.server) void shell.openPath(project.path);
}

/// A project on a server runs Claude there, so a server not yet marked for Claude is marked after the person agrees, as in
/// the fork (ServerActions.openWindow). Before anything connects.
async function openServerFolder(server: string, folder: string): Promise<void> {
  const profile = findProfile(server, loadProfiles());
  if (!profile) throw new Error(`no server profile named ${server}`);
  if (!profile.allowClaude) {
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Open ${profile.name} with Claude?`,
      detail: `This project starts Claude Code on ${profile.user}@${profile.host}. Claude can run commands there and open pages in the browser. The app turns on "Let Claude use this server", so every Claude session with the Vibex tools can also list it and open a terminal to it. Turn it off again in its form.`,
      buttons: ['Allow and Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) throw new Error(`${profile.name} does not allow Claude, so the project did not open.`);
    hub.allowClaude(profile.name);
  }
  projects.openServer(profile.name, folder);
  showCurrent();
}

/// Every command is in the menu bar with its shortcut (HIG cross-platform: desktop apps), so the
/// toolbar, the keyboard and the menu stay one set of commands. Menu items send a command name to the window.
function command(name: string, arg?: string) {
  return () => {
    // A click in the side browser leaves the keyboard in the page; the command's target is in the window.
    win?.webContents.focus();
    send('menu:command', name, arg);
  };
}

function currentBrowser(): BrowserPane | undefined {
  const id = projects.current()?.id;
  return id ? browsers.get(id) : undefined;
}

const isMac = process.platform === 'darwin';
const ASKPASS_WAIT_MS = 500;

function setMenu(): void {
  const profiles = loadProfiles();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        // Windows and Linux: plain Ctrl+O and Ctrl+L belong to Claude, nano and the shell in a terminal tab.
        { label: 'Open Project…', accelerator: isMac ? 'Cmd+O' : 'Ctrl+Shift+O', click: () => void pickFolders() },
        { label: 'Open Server Project…', accelerator: isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+J', click: command('open-server') },
        { label: 'Close Project', click: () => { const p = projects.current(); if (p) void closeProject(p.id); } },
      ],
    },
    {
      label: '&Terminal',
      submenu: [
        { label: 'New Claude Tab', accelerator: 'CmdOrCtrl+Shift+N', click: command('new-tab', 'agent') },
        nativeChatIsDefault()
          ? { label: 'New Claude Terminal Tab', accelerator: 'CmdOrCtrl+Shift+U', click: command('new-tab', 'agent-terminal') }
          : { label: 'New Claude Chat', accelerator: 'CmdOrCtrl+Shift+U', click: command('new-tab', 'agent-chat') },
        { label: 'New Terminal Tab', accelerator: 'CmdOrCtrl+Shift+T', click: command('new-tab', 'shell') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+Shift+W', click: command('close-tab') },
        { label: 'Find in Terminal', accelerator: 'CmdOrCtrl+Shift+F', click: command('terminal-find') },
        { label: 'Reopen Closed Tab', accelerator: isMac ? 'Cmd+Alt+T' : 'Ctrl+Shift+Y', click: () => reopenTab() },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: command('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: command('previous-tab') },
        { type: 'separator' },
        ...(profiles.length
          ? profiles.map((p) => ({ label: `Connect ${p.name}`, click: command('connect', p.name) }))
          : [{ label: 'No Server Profiles', enabled: false }]),
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'Exit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: '&Browser',
      submenu: [
        { label: 'Open Address', accelerator: isMac ? 'Cmd+L' : 'Ctrl+Shift+L', click: command('focus-address') },
        { label: 'Back', accelerator: 'Alt+Left', click: () => currentBrowser()?.back() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => currentBrowser()?.forward() },
        { label: 'Reload Page', accelerator: 'F5', click: () => currentBrowser()?.reload() },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Claude', accelerator: 'CmdOrCtrl+1', click: command('activity', 'agent') },
        { label: 'Browser', accelerator: 'CmdOrCtrl+2', click: command('activity', 'browser') },
        { label: 'Command Terminal', accelerator: 'CmdOrCtrl+3', click: command('activity', 'shell') },
        { type: 'separator' },
        { label: 'Files', accelerator: 'CmdOrCtrl+Shift+E', click: command('activity', 'files') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: command('activity', 'git') },
        { label: 'Agents', accelerator: 'CmdOrCtrl+Shift+A', click: command('activity', 'agents') },
        { label: 'Skills', accelerator: 'CmdOrCtrl+Shift+K', click: command('activity', 'skills') },
        { label: 'MCP Servers', accelerator: 'CmdOrCtrl+Shift+M', click: command('activity', 'mcp') },
        { label: 'Notes', click: command('activity', 'notes') },
        { label: 'Inbox', click: command('activity', 'inbox') },
        { label: 'Servers', click: command('activity', 'servers') },
        { label: 'Go Panel', click: command('go-open') },
        ...moduleMenu('View', command),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: '&Run', submenu: moduleMenu('Run', command) },
    { label: '&Help', submenu: moduleMenu('Help', command) },
    {
      label: '&Window',
      submenu: [
        { label: 'Next Project', accelerator: 'Ctrl+PageDown', click: () => { if (projects.adjacent(1)) showCurrent(); } },
        { label: 'Previous Project', accelerator: 'Ctrl+PageUp', click: () => { if (projects.adjacent(-1)) showCurrent(); } },
        { label: 'Project Rail', accelerator: isMac ? 'Cmd+Alt+P' : 'Ctrl+Shift+B', click: command('activity', 'rail') },
      ],
    },
  ]));
}

/// Electron safeStorage. The tests use a stand-in, so they never touch a real system store; only with VIBEX_TEST set.
function secretCrypt(): Crypt {
  if (isTestRun() && testEnv('VIBEX_SECRET_CRYPT') === 'test') {
    const flip = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
    return { available: () => true, encrypt: (t) => flip(Buffer.from(t)), decrypt: (b) => flip(b).toString() };
  }
  return { available: osStoreAvailable, encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) };
}

/// Who confirms the person before a saved server secret is read. Windows: Windows Hello through the helper, over this
/// window. Linux and others: nobody, so the person types it. Tests take a stand-in (ok, no, unavailable, hang); a test run
/// that names none gets 'ok', as before the gate. A release build has no test switch at all (testSwitches.ts).
function presence(): Authenticator {
  return presenceAuthenticator({
    kind: buildKind,
    fake: testEnv('VIBEX_TEST_PRESENCE') ?? (isTestRun() ? 'ok' : undefined),
    platform: process.platform,
    windows: () => windowsPresence({
      helper: presenceHelperPath(app.isPackaged, process.resourcesPath, app.getAppPath()),
      window: () => (win && !win.isDestroyed() ? hwndText(win.getNativeWindowHandle()) : null),
    }),
  });
}

async function start(): Promise<void> {
  projects = new Projects(path.join(app.getPath('userData'), 'projects.json'), (name) => loadProfiles().some((p) => p.name === name));
  setMenu();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'Vibex PCA',
    backgroundColor: '#0c0c0f',
    icon: path.join(__dirname, 'icon.png'),
    // One unified title bar as in macOS Vibex. Windows and Linux keep their own minimise, maximise and close
    // buttons (titleBarOverlay); the menu bar appears when Alt is pressed.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#0c0c0f', symbolColor: '#9b9ba7', height: 40 } }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The PCA edition opens each new project as a chat (renderer/chatFirst.ts). A test run keeps the three columns
      // unless it asks for the chat layout, so the specs of the columns stay as they were.
      additionalArguments: [`--vibex-chat-first=${!isTestRun() || testEnv('VIBEX_CHAT_FIRST') === '1' ? 1 : 0}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', runMenuShortcut);
  // Windows ending the session, or a signal on Linux.
  win.on('session-end', () => { skipInstallAtQuit(); quitWithoutAsking(); });
  process.on('SIGTERM', quitWithoutAsking);
  win.on('close', (e) => {
    const askInTests = (globalThis as any).__vibexTest?.askOnClose === true;
    if (quitAgreed || (isTestRun() && !askInTests)) return;
    if (!busyWork().total) return;
    e.preventDefault();
    void askBeforeQuit();
  });
  // The system window buttons take the title bar colours of the current appearance.
  const paintTitleBar = () => {
    if (process.platform === 'darwin' || !win) return;
    const dark = nativeTheme.shouldUseDarkColors;
    win.setTitleBarOverlay({ color: dark ? '#0c0c0f' : '#f5f5f7', symbolColor: dark ? '#9b9ba7' : '#5c5c66', height: 40 });
    win.setBackgroundColor(dark ? '#0c0c0f' : '#f5f5f7');
  };
  paintTitleBar();
  nativeTheme.on('updated', paintTitleBar);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  terminals.on('created', (info) => send('term:created', info));
  terminals.on('data', (id, data, total) => send('term:data', id, data, total));
  terminals.on('exit', (id, code) => send('term:exit', id, code));
  terminals.on('closed', (id) => send('term:closed', id));

  handle('term:list', () => terminals.list());
  handle('term:buffer', (id: number) => terminals.buffer(id));
  handle('term:snapshot', (id: number) => terminals.snapshot(id));
  handle('term:create', (pane: string) => createTab(pane));
  handle('term:reopen', (id: number) => terminals.reopen(id));
  on('term:input', (id: number, data: string) => terminals.write(id, data));
  on('term:resize', (id: number, cols: number, rows: number) => terminals.resize(id, cols, rows));
  on('term:close', (id: number) => void closeTabAsking(id));
  on('mod:tabs:reopen', () => reopenTab());

  handle('servers:list', () => loadProfiles().map((p) => ({ name: p.name, target: `${p.user}@${p.host}${p.port ? ':' + p.port : ''}`, projectPath: p.projectPath })));
  handle('servers:problem', () => profilesError());
  handle('servers:connect', (name: string) => {
    const profile = loadProfiles().find((p) => p.name === name);
    if (!profile) throw new Error(`no server profile named ${name}`);
    const project = projects.current();
    if (!project) throw new Error('no project is open');
    return terminals.create(hub.connectTab(profile, project));
  });

  handle('projects:list', () => snapshot());
  handle('projects:open', (folder?: string) => (folder ? void openFolder(String(folder)) : pickFolders()));
  handle('projects:openServer', (server: string, folder: string) => openServerFolder(String(server), String(folder)));
  handle('servers:folders', (name: string) => hub.folders(String(name)));
  handle('projects:select', (id: string) => {
    if (projects.select(String(id))) showCurrent();
  });
  handle('projects:close', (id: string) => closeProject(String(id)));
  on('projects:reveal', (id: string) => revealProject(String(id)));

  handle('browser:navigate', (url: string) => {
    const project = projects.current();
    if (!project) throw new Error('no project is open');
    return browserFor(project).navigate(String(url));
  });
  handle('browser:state', () => currentBrowser()?.state() ?? { url: '', title: '', loading: false });
  on('browser:back', () => currentBrowser()?.back());
  on('browser:forward', () => currentBrowser()?.forward());
  on('browser:reload', () => currentBrowser()?.reload());
  on('browser:area', (rect, shown: boolean) => {
    // The page measures in zoomed pixels; the native view in window pixels.
    const zoom = win!.webContents.getZoomFactor();
    browserArea = { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
    browserAreaShown = !!shown;
    placeBrowsers();
  });

  handle('app:status', () => status);
  // The title bar hides the Windows and Linux menu bar, so a button opens the same menu.
  on('menu:app', (x: number, y: number) => {
    Menu.getApplicationMenu()?.popup({ window: win!, x: Math.round(x), y: Math.round(y) });
  });
  // Right-click on a rail tile.
  on('menu:project', (id: string) => {
    const project = projects.get(String(id));
    if (!project) return;
    Menu.buildFromTemplate([
      { label: `Show ${project.name}`, click: () => { if (projects.select(project.id)) showCurrent(); } },
      ...(project.server ? [] : [{ label: revealLabel, click: () => revealProject(project.id) }]),
      { type: 'separator' },
      { label: 'Close Project', click: () => void closeProject(project.id) },
    ]).popup({ window: win! });
  });
  // Right-click in a terminal: the usual Copy, Paste, Select All, plus Clear.
  handle('menu:terminal', (hasSelection: boolean) => new Promise<string | null>((resolve) => {
    const pick = (name: string) => () => resolve(name);
    const menu = Menu.buildFromTemplate([
      { label: 'Copy', enabled: !!hasSelection, click: pick('copy') },
      { label: 'Paste', click: pick('paste') },
      { label: 'Select All', click: pick('select-all') },
      { type: 'separator' },
      { label: 'Clear', click: pick('clear') },
    ]);
    menu.popup({ window: win!, callback: () => setTimeout(() => resolve(null), 0) });
  }));

  hub = new ServerHub({
    terminals,
    projects,
    userData: app.getPath('userData'),
    crypt: secretCrypt(),
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    presence: presence(),
    send,
    reveal: (project, pane) => send('pane:reveal', project.id, pane),
    browserFor,
    coverBrowsers: (reason, on) => {
      if (on) browserCover.add(reason);
      else browserCover.delete(reason);
      placeBrowsers();
    },
    confirmRemove: async (name) => (await dialog.showMessageBox(win!, {
      type: 'warning',
      message: `Remove ${name}?`,
      detail: 'Its entry and its saved secrets go. The server stays as it is.',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })).response === 0,
    serversChanged: () => {
      setMenu();
      send('menu:command', 'servers-changed');
    },
  });
  // `ssh -V` can hang for its whole limit of 5 s on a broken install: the window does not wait for that (see the end of start).
  const askpassReady = hub.askpass.start();
  hub.startIpc({ handle, on });
  // A chat in a project on a server runs Claude there, through this hub's logins.
  chatService.useServers(hub.chatHost());

  const host: ModuleHost = {
    handle,
    on,
    send,
    projects,
    terminals,
    browserFor,
    reveal: (project, pane) => send('pane:reveal', project.id, pane),
    userData: app.getPath('userData'),
    agreeToQuit,
    cancelQuit: () => { quitAgreed = false; },
    inbox: agentsInbox,
  };
  for (const module of MODULES) module.start?.(host);
  // Setup found Claude Code (the person installed it from there): register the tools and clear the chip, no restart.
  host.handle('mod:setup:claude-found', async () => {
    refreshWindowsPath();
    if (testEnv('VIBEX_CLAUDE_MISSING') === '1' || !findClaude()) return false;
    if (!claimClaudeFound(status)) return false;
    if (registration && (process.platform !== 'darwin' || testEnv('VIBEX_REGISTER_CLAUDE') === '1')) {
      status.claude = await registerWithClaude(registration.port, registration.store);
    }
    // The Claude tab of the project stayed at a prompt when Claude was missing, and its shell has the old PATH.
    const project = projects.current();
    if (project && !project.server) {
      // A terminal, where Claude asks the person to sign in; a chat cannot show that.
      terminals.create(nativeChatIsDefault() ? chatService.terminalClaude(project) : launchFor(project, 'agent'));
      send('pane:reveal', project.id, 'agent');
    }
    return true;
  });

  const { token, store } = loadMcpToken();
  status.tokenStore = store;
  const wanted = testEnv('VIBEX_MCP_PORT') !== undefined ? Number(testEnv('VIBEX_MCP_PORT')) : 5150;
  try {
    const mcp = await startMcp(
      {
        route: (header, projectPath) => projects.route(header, projectPath),
        browser: browserFor,
        terminals,
        reveal: (project, pane) => send('pane:reveal', project.id, pane),
        listProjects: () => projects.list(),
        recentProjects: () => projects.recents(),
        openProject: openFolderForTool,
        serverProject: (bearer) => hub.projectOfToken(bearer),
        guardForServer: (server, project) => hub.applyGuard(server, project),
        confirmRun: (project, command, cwd, local) => hub.confirmRun(project, command, cwd, local),
        runOnServer: (project, command, cwd, timeoutMs) => hub.runOnServer(project, command, cwd, timeoutMs),
        version: status.version,
        modules: MODULES,
      },
      token,
      wanted,
    );
    status.mcpPort = mcp.port;
    hub.mcpPort = mcp.port;
    registration = { port: mcp.port, store };
    // Not before-quit: the person can still say Cancel after that, and the tools must keep working.
    app.on('will-quit', () => mcp.close());
    // Tabs inherit this, so scripts and Claude in them can find the server.
    process.env.VIBEX_MCP_URL = `http://127.0.0.1:${mcp.port}/mcp`;
    // Register with Claude Code as macOS Vibex does, but only on Windows and Linux by default: on a Mac the
    // Swift Vibex owns the "vibex" entry.
    if (process.platform !== 'darwin' || testEnv('VIBEX_REGISTER_CLAUDE') === '1') {
      // Not awaited: the window must not wait for two `claude mcp` runs (up to 20 s each).
      status.claude = 'registering with Claude Code';
      void registerWithClaude(mcp.port, store).then((result) => { status.claude = result; });
    } else {
      status.claude = 'not registered: macOS Vibex owns the vibex entry on a Mac';
    }
  } catch (error) {
    status.mcpError = `MCP server did not start on 127.0.0.1:${wanted}: ${String(error)}`;
  }

  if (isTestRun()) {
    // Read by the Playwright tests through electronApp.evaluate; never set in a normal run.
    (globalThis as any).__vibexTest = { token, status, terminals, projects, browsers, servers: hubTestHooks(hub) };
  }

  // In the background, so the first terminal_run does not wait for the setup files.
  void loginPathReady();

  // Only the project on screen starts its tabs; the others start when they are first shown.
  const front = projects.current();
  lastShown = front?.id ?? null;
  // Long enough for a normal ssh. A server project needs the answer before its first login, so it waits for all of it.
  await Promise.race([askpassReady, new Promise((resolve) => setTimeout(resolve, ASKPASS_WAIT_MS))]);
  if (front?.server) void askpassReady.then(() => startTabs(front));
  else if (front) startTabs(front);
  win.webContents.once('did-finish-load', () => {
    if (waitingFault) send('mod:app:fault', waitingFault);
    waitingFault = null;
  });
  serveAppWindow(__dirname);
  await win.loadURL(APP_URL);
}
