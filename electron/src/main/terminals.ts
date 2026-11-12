import { testEnv } from './testSwitches';
import * as pty from '@lydell/node-pty';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from './claude';
import { findProgram, runnable } from './programs';
import { refreshWindowsPath } from './windowsPath';

/// Which shell syntax a tab speaks; terminal_run builds its end marker for it.
export type ShellKind = 'posix' | 'pwsh' | 'none';

/// Which column a tab lives in, as in macOS Vibex: Claude on the left, the command terminal on the right.
export type Pane = 'agent' | 'shell';

export interface Launch {
  file: string;
  args: string[];
  kind: ShellKind;
  title: string;
  cwd?: string;
  env?: Record<string, string>;
  /// Set for an ssh tab: the server profile it was opened from, so it can reconnect.
  server?: string;
  pane?: Pane;
  /// The project this tab belongs to.
  project?: string;
  /// What a reconnect runs, made fresh: a new askpass ticket, the file's profile now. A throw refuses the reconnect.
  rebuild?: () => Launch;
  /// One command that must not run twice: Reopen Closed Tab and a reconnect leave it alone. A command Claude or a Run
  /// button started has it, so a command never runs twice without a person asking.
  once?: boolean;
  /// Runs on the project's server, with no `server` field because it never offers a reconnect (a terminal_run there).
  remote?: boolean;
  /// What a command tab prints right before the command, unseen on screen. Each run has its own.
  startMark?: string;
  /// Told when the process ends, with what the tab holds.
  onExit?: (id: number, code: number, output: string) => void;
  /// A tab with no terminal in it: the native chat (chat.ts). It takes the place of the PTY, and the tab stays alive until it closes.
  chat?: { attach: (tab: number) => ChatTabProcess; busy: () => boolean };
}

/// What a tab asks of its process.
export type ChatTabProcess = Pick<pty.IPty, 'pid' | 'process' | 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>;

export interface TabInfo {
  id: number;
  title: string;
  kind: ShellKind;
  alive: boolean;
  server?: string;
  remote?: boolean;
  pane: Pane;
  project: string;
  /// A native chat, not a terminal.
  chat?: boolean;
}

const BUFFER_LIMIT = 400_000;

/// PowerShell 7, else any pwsh on PATH, else Windows PowerShell, always by a full path: for a bare name Windows looks in
/// the current folder first, and that is a project that may come from anyone (security review H3).
export function windowsShellFile(env: Record<string, string | undefined> = process.env, isFile: (file: string) => boolean = runnable): string {
  const seven = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (isFile(seven)) return seven;
  const lookup = { platform: 'win32' as const, pathValue: env.PATH ?? '', isFile };
  return findProgram('pwsh', lookup) ?? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/// The user's shell: PowerShell 7 if installed, else Windows PowerShell; $SHELL (or bash) elsewhere.
export function defaultShell(): Launch {
  if (process.platform === 'win32') return { file: windowsShellFile(), args: ['-NoLogo'], kind: 'pwsh', title: 'PowerShell' };
  const file = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  return { file, args: ['-l'], kind: 'posix', title: path.basename(file) };
}

/// PowerShell's command for Claude. The native claude.exe by its path: an npm claude.ps1 is blocked by the default execution
/// policy of Windows PowerShell 5.1. With none found, a plain line and not the red "not recognized"; one that came another
/// way still starts. Get-Command does not look in the current folder.
export function windowsClaudeCommand(claude: string | null): string {
  if (claude) return `& ${psQuote(claude)}`;
  return "if (Get-Command claude -ErrorAction SilentlyContinue) { claude } else { Write-Host 'Claude Code is not installed yet. Click the note at the top of the window to open Setup.' }";
}

/// What a Claude tab runs. By its full path where the app finds it: a shell does not see a PATH changed after it started,
/// and an installer's folder (~/.local/bin) is often not on it. Else the login shell may know it (nvm).
export function claudeCommand(kind: ShellKind): string {
  const claude = findClaude();
  if (kind === 'pwsh') return windowsClaudeCommand(claude);
  return claude ? shQuote(claude) : 'claude';
}

/// The Claude tab: the user's shell starts `claude` and stays open after it exits, so the tab is never dead.
/// VIBEX_AGENT_COMMAND changes the command; an empty value gives a plain shell (the tests use that).
export function agentLaunch(): Launch {
  const shell = defaultShell();
  const command = testEnv('VIBEX_AGENT_COMMAND') ?? claudeCommand(shell.kind);
  if (!command) return { ...shell, pane: 'agent', title: 'Claude' };
  const args = shell.kind === 'pwsh' ? ['-NoLogo', '-NoExit', '-Command', command] : ['-l', '-c', `${command}; exec "${shell.file}" -l`];
  return { ...shell, args, pane: 'agent', title: 'Claude' };
}

/// The same launch inside a project: it starts in the project's folder, and scripts and Claude in it can tell the
/// project (Claude sends VIBEX_WINDOW back as the X-Vibex-Window header on each tool call).
export function inProject(launch: Launch, project: { id: string; path: string; server?: string }): Launch {
  // A server project's path is on the server: the ssh process itself starts wherever it likes on this computer.
  if (project.server) return { ...launch, project: project.id };
  return { ...launch, cwd: project.path, project: project.id, env: { ...launch.env, VIBEX_PROJECT: project.path, VIBEX_WINDOW: project.id } };
}

/// A single-quoted PowerShell word. PowerShell also takes U+2018 to U+201B as a quote: the Uzbek o‘zgarish would end the
/// word and break the whole script.
export const psQuote = (text: string) => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
const shQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

// ---------- PATH as a person's terminal has it ----------

const LOGIN_PATH_WAIT_MS = 10_000;
const LOGIN_PATH_FRESH_MS = 60_000;
/// What the script below can run in. Another login shell (fish, csh) has its own syntax, so the script goes to sh.
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'ksh93', 'mksh', 'yash']);
const scriptShell = (file: string) => (POSIX_SHELLS.has(path.basename(file)) ? file : '/bin/sh');

let loginPathValue: string | null = null;
let loginPathAt = 0;
let loginPathRead: Promise<void> | null = null;
let loginPathNumber = 0;

/// An interactive login shell, once, with no terminal and no keyboard: a tool on a PATH set only in .zshrc or .bashrc
/// (nvm) is not found by `-l -c`, and `-i` on the run itself would bring prompts, job control and a stuck rc file with it.
function readLoginPath(timeoutMs: number): Promise<void> {
  const number = ++loginPathNumber;
  return new Promise((resolve) => {
    const mark = randomBytes(8).toString('hex');
    const shell = defaultShell().file;
    // A bash login reads .profile and not .bashrc, and most nvm lines sit in .bashrc.
    const bashrc = path.basename(shell) === 'bash' ? '[ -r ~/.bashrc ] && . ~/.bashrc; ' : '';
    let done = false;
    let out = '';
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A slower read that an earlier call gave up on must not replace a later one.
      if (number === loginPathNumber) {
        if (value) loginPathValue = [...new Set(value.split(':').filter(Boolean))].join(':');
        loginPathAt = Date.now();
      }
      resolve();
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch { /* it has ended */ }
    };
    const child = spawn(shell, ['-l', '-i', '-c', `${bashrc}printf '%s' '${mark}'"$PATH"'${mark}'`], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout!.setEncoding('utf8').on('data', (data: string) => {
      out += data;
      const found = new RegExp(`${mark}([^\\n]*)${mark}`).exec(out);
      if (found) finish(found[1]);
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
  });
}

/// Waits for the first read, at most `waitMs`. After that it never waits: a read older than a minute runs behind the next
/// command, so a tool a person just installed is found soon, without a restart.
export async function loginPathReady(waitMs = LOGIN_PATH_WAIT_MS): Promise<void> {
  if (process.platform === 'win32') return;
  if (!loginPathAt && !loginPathRead) loginPathRead = readLoginPath(waitMs).finally(() => { loginPathRead = null; });
  else if (loginPathAt && !loginPathRead && Date.now() - loginPathAt > LOGIN_PATH_FRESH_MS) {
    loginPathRead = readLoginPath(LOGIN_PATH_WAIT_MS).finally(() => { loginPathRead = null; });
    return;
  }
  await loginPathRead;
}

/// The PATH of a person's terminal, once it was read; a chat's Claude gets the same one.
export const loginPathNow = (): string | null => loginPathValue;

export function forgetLoginPath(): void {
  loginPathValue = null;
  loginPathAt = 0;
  loginPathRead = null;
  loginPathNumber++;
}

/// A login shell runs this text. The PATH goes first in the text and not in the environment: the login files would put it
/// in another order (macOS path_helper).
export function loginShellRun(file: string, script: string): { file: string; args: string[] } {
  const prefix = loginPathValue ? `PATH=${shQuote(loginPathValue)}; export PATH\n` : '';
  return { file: scriptShell(file), args: ['-l', '-c', `${prefix}${script}`] };
}

// ---------- one command in a tab of its own ----------

/// Printed by a command tab right before the command, unseen on screen. What comes earlier is login text. A run adds its
/// own random part, because the command's own text may hold these words.
const COMMAND_START = ']7777;vbx-start';
/// The start of the command, printed on top of its tab. Long text would count twice against the limits below.
const COMMAND_SHOWN = 400;
/// One argument on Linux holds 128 KiB. Windows holds 32,767 characters on a command line, and the encoded script takes 2.67 per character.
const COMMAND_LIMIT = process.platform === 'win32' ? 11_000 : 120_000;

const shownCommand = (command: string) => (command.length > COMMAND_SHOWN ? `${command.slice(0, COMMAND_SHOWN)}…` : command);

/// PowerShell. The command stands on its own lines and is parsed with the script. $? is read straight after it: a failed
/// cmdlet leaves $LASTEXITCODE alone, and a value from before it must not count. (PowerShell 5.1 sets $? to false when a
/// program's stderr is redirected, also with exit code 0; then this says 1, with the output beside it.)
export function windowsCommandScript(command: string, cwd: string | undefined, mark: string): string {
  return [
    "$env:PAGER = 'cat'; $env:GIT_PAGER = 'cat'",
    `Write-Host ('$ ' + ${psQuote(shownCommand(command))}) -ForegroundColor DarkGray`,
    `[Console]::Out.Write([string][char]27 + '${mark}' + [char]7)`,
    ...(cwd ? [`Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction Stop`] : []),
    '$global:LASTEXITCODE = $null',
    command,
    // No `exit` here: it ends the script while a table waits in the formatter, so `ls` or `pwd` returned nothing (run 41403299873).
    '$vibexCode = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
    '$host.SetShouldExit($vibexCode)',
  ].join('\n');
}

/// Encoded, because a quote in a command does not survive the Windows command line. RemoteSigned, as the Run tab: with the
/// default policy of Windows PowerShell 5.1, Claude's `npm test` goes to npm.ps1 and is refused.
export function windowsCommandArgs(command: string, cwd: string | undefined, mark: string): string[] {
  return ['-NoLogo', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(windowsCommandScript(command, cwd, mark), 'utf16le').toString('base64')];
}

/// sh, bash and zsh. The command goes through eval, so a parse error comes after the start mark and stays that command's
/// own. The trap waits for what it left in the background: when the login shell ends, the terminal hangs up on them, also
/// on a nohup that has not set itself up yet. A dev server started with & keeps the run open; the wait ends, the tab stays.
function posixCommandScript(command: string, cwd: string | undefined, mark: string): string {
  return [
    'export PAGER=cat GIT_PAGER=cat',
    `printf '\\033[2m$ %s\\033[0m\\n' ${shQuote(shownCommand(command))}`,
    `printf '\\033${mark}\\007'`,
    "trap '__vibex_code=$?; wait; exit $__vibex_code' EXIT",
    ...(cwd ? [`cd -- ${shQuote(cwd)} || exit 1`] : []),
    `eval ${shQuote(command)}`,
    '',
  ].join('\n');
}

/// One terminal_run: the login shell runs it and ends, in a tab of its own. Nothing is typed into a shell.
/// A pager would wait for a key, and the run would hang.
export function commandLaunch(command: string, cwd?: string): Launch {
  if (Buffer.byteLength(command) > COMMAND_LIMIT) throw new Error(`the command has ${command.length} characters, and one command holds ${COMMAND_LIMIT}. Write it to a file, and run the file`);
  const shell = defaultShell();
  const title = `$ ${command.split('\n')[0].slice(0, 24)}`;
  const startMark = `${COMMAND_START}-${randomBytes(6).toString('hex')}`;
  const common = { title, pane: 'shell' as const, once: true, startMark, kind: 'none' as const };
  if (shell.kind === 'pwsh') {
    return { ...shell, ...common, args: windowsCommandArgs(command, cwd, startMark) };
  }
  return { ...shell, ...common, ...loginShellRun(shell.file, posixCommandScript(command, cwd, startMark)) };
}

const stripEscapes = (text: string) => text
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  // Any other sequence: ESC ( B, ESC =, ESC 7, ESC c.
  .replace(/\x1b[ -/]*[0-~]/g, '');

// Removes CSI, OSC and other escape sequences so output can be searched as plain text.
export function stripAnsi(text: string): string {
  return stripEscapes(text).replace(/\r/g, '');
}

/// A command's output as the screen shows it: a progress bar's last state, and a backspace takes back its character.
function plainOutput(raw: string): string {
  const lines = stripEscapes(raw).replace(/\r+\n/g, '\n').split('\n').map((line) => {
    const shown = line.split('\r').filter(Boolean).pop() ?? '';
    const kept: string[] = [];
    for (const c of shown) {
      if (c === '\b') kept.pop();
      else kept.push(c);
    }
    return kept.join('');
  });
  return lines.join('\n').trimEnd();
}

/// The foreground process group of a shell's terminal (Mac and Linux), as Swift's tcgetpgrp. Null when it cannot be read.
function foregroundGroup(pid: number): number | null {
  try {
    if (process.platform === 'win32') return null;
    if (process.platform === 'linux') {
      // Field 8 of stat; the name in field 2 may hold brackets, so count from the last one.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const group = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[5]);
      return group > 0 ? group : null;
    }
    const group = Number(execFileSync('ps', ['-o', 'tpgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim());
    return group > 0 ? group : null;
  } catch {
    return null;
  }
}

type PtyStart = (file: string, args: string[], options: pty.IWindowsPtyForkOptions & pty.IPtyForkOptions) => pty.IPty;

/// On Windows the conpty.dll in node-pty's package (it holds conpty.dll and OpenConsole.exe). The conpty of Windows makes
/// node-pty's kill call child_process.fork, which the release's off runAsNode fuse refuses. A dll that cannot load (a
/// company policy, Smart App Control) falls back to that conpty, and the fault guard takes the one refusal.
export function spawnPty(file: string, args: string[], options: pty.IPtyForkOptions, platform: NodeJS.Platform = process.platform, start: PtyStart = pty.spawn as PtyStart): pty.IPty {
  if (platform !== 'win32') return start(file, args, options);
  try {
    return start(file, args, { ...options, useConptyDll: true });
  } catch {
    return start(file, args, options);
  }
}

type RunFile = (file: string, args: string[], done: () => void) => void;
const runQuietly: RunFile = (file, args, done) => {
  execFile(file, args, { windowsHide: true, timeout: 3000 }, () => done());
};

/// Ends a tab's whole process tree, then `after` closes its terminal: taskkill needs the root alive to walk down from it.
/// By its full path: the current folder of the app must not give another taskkill.exe.
export function endWindowsTree(pid: number, after: () => void, env: Record<string, string | undefined> = process.env, run: RunFile = runQuietly): void {
  if (!pid) return after();
  let closed = false;
  const once = () => {
    if (closed) return;
    closed = true;
    after();
  };
  try {
    run(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], once);
  } catch {
    once();
  }
}

const MAX_CLOSED = 10;
const MAX_RUNS = 200;
/// What a finished run keeps; its tab and buffer can go.
const RUN_KEPT = 60_000;
const SHELL_START_MS = 5_000;
const CLOSE_GRACE_MS = 1_500;

export type RunScope = 'local' | 'server';
export interface RunState {
  output: string;
  finished: boolean;
  code?: number | null;
  /// The start of the output is gone for good: more came than a tab or a finished run keeps.
  cut?: boolean;
}

class Tab {
  /// Reads the terminal_run command still in this tab, if one is.
  pending: (() => RunState) | null = null;
  /// Closed while its process ran: the exit code then says nothing about the command.
  closedRunning = false;
  readonly born = Date.now();
  buffer = '';
  /// Characters received since the tab started; the buffer keeps only the last BUFFER_LIMIT of them.
  total = 0;
  alive = true;
  constructor(
    readonly id: number,
    public title: string,
    readonly kind: ShellKind,
    readonly proc: ChatTabProcess,
    readonly server?: string,
    readonly pane: Pane = 'shell',
    readonly project: string = '',
    readonly launch?: Launch,
  ) {}
}

/// Owns every PTY. The renderer only mirrors them: it gets data events and sends keystrokes.
export class Terminals extends EventEmitter {
  private closed = new Map<string, Launch[]>();
  private runs = new Map<number, { project: string; kind: RunScope; tab: number; read: () => RunState }>();
  private runNumber = 0;
  /// The command tabs of each project, for the one that makes way for the next.
  private commandTabs = new Map<string, number[]>();
  private tabs = new Map<number, Tab>();
  private nextId = 1;

  /// `refreshPath` runs before each new tab, so a tab sees what an installer changed while the app runs.
  constructor(private readonly refreshPath: () => void = refreshWindowsPath) {
    super();
  }

  create(launch: Launch = defaultShell(), cols = 120, rows = 32): TabInfo {
    this.refreshPath();
    const id = this.nextId++;
    const proc = launch.chat ? launch.chat.attach(id) : spawnPty(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: launch.cwd || os.homedir(),
      env: { ...process.env, ...launch.env, TERM_PROGRAM: 'VibexPCA' } as Record<string, string>,
    });
    const tab = new Tab(id, launch.title, launch.kind, proc, launch.server, launch.pane ?? 'shell', launch.project ?? '', launch);
    this.tabs.set(tab.id, tab);
    proc.onData((data) => {
      tab.buffer += data;
      tab.total += data.length;
      if (tab.buffer.length > BUFFER_LIMIT) tab.buffer = tab.buffer.slice(-BUFFER_LIMIT);
      this.emit('data', tab.id, data, tab.total);
    });
    proc.onExit(({ exitCode, signal }) => {
      tab.alive = false;
      // As a shell says it. A process that a signal ended has exit code 0 here, and that must not read as a success.
      const code = signal ? 128 + signal : exitCode;
      this.emit('exit', tab.id, code);
      launch.onExit?.(tab.id, code, tab.buffer);
    });
    const info = this.info(tab);
    this.emit('created', info);
    return info;
  }

  list(): TabInfo[] {
    return [...this.tabs.values()].map((t) => this.info(t));
  }

  buffer(id: number): string {
    return this.tab(id).buffer;
  }

  /// The buffer and the running total at the same moment, so a view can skip data it already replayed.
  snapshot(id: number): { text: string; total: number } {
    const tab = this.tab(id);
    return { text: tab.buffer, total: tab.total };
  }

  write(id: number, data: string): void {
    const tab = this.tab(id);
    if (tab.alive) tab.proc.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (tab?.alive && cols > 0 && rows > 0) tab.proc.resize(cols, rows);
  }

  /// True when closing the tab stops work. A Claude tab or an ssh tab always counts. A shell counts when another
  /// program is in front (Unix); ConPTY does not tell, so on Windows an idle shell does not count.
  busy(id: number): boolean {
    const tab = this.tabs.get(id);
    if (!tab?.alive) return false;
    // A chat with nothing going on comes back whole with Reopen Closed Tab.
    if (tab.launch?.chat) return tab.launch.chat.busy();
    // A command tab is its command. Its shell has no other program in front while a script runs, so the group says nothing.
    if (tab.pane === 'agent' || tab.server || tab.kind === 'none' || this.runPending(tab)) return true;
    // A shell that just started runs its profile's programs; that is not work to protect.
    if (process.platform === 'win32' || !tab.launch || Date.now() - tab.born < SHELL_START_MS) return false;
    // By process group, because a script can have the shell's own name.
    const group = foregroundGroup(tab.proc.pid);
    if (group !== null) return group !== tab.proc.pid;
    return path.basename(tab.proc.process).replace(/^-/, '') !== path.basename(tab.launch.file);
  }

  private runPending(tab: Tab): boolean {
    if (tab.pending?.().finished) tab.pending = null;
    return !!tab.pending;
  }

  /// The last closed tab of the project starts again, in the same place. A tab with a `rebuild` is made fresh (a new
  /// askpass ticket); one that refuses is skipped.
  reopenClosed(project: string): TabInfo | null {
    const list = this.closed.get(project);
    for (let launch = list?.pop(); launch; launch = list?.pop()) {
      try {
        return this.create(launch.rebuild ? launch.rebuild() : launch);
      } catch { /* this one cannot start again */ }
    }
    return null;
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.launch && !tab.launch.once) {
      const list = this.closed.get(tab.project) ?? [];
      list.push(tab.launch);
      this.closed.set(tab.project, list.slice(-MAX_CLOSED));
    }
    if (tab.alive) {
      tab.closedRunning = true;
      this.endProcess(tab);
      // A command that ignores the hang-up must not outlive its tab. A person's shell keeps what it put in the background.
      if (tab.launch?.once && process.platform !== 'win32') this.killGroupSoon(tab.proc.pid);
    }
    this.tabs.delete(id);
    // A finished run keeps its result and lets go of the tab and its buffer.
    tab.pending?.();
    this.emit('closed', id);
  }

  private endProcess(tab: Tab): void {
    const kill = () => {
      try {
        tab.proc.kill();
      } catch { /* it has ended */ }
    };
    if (process.platform === 'win32') endWindowsTree(tab.proc.pid, kill);
    else kill();
  }

  /// Closes a tab and waits for its process, up to the limit. True when the process ended: on Windows its folder is free then.
  closeAndWait(id: number, limitMs: number): Promise<boolean> {
    const tab = this.tabs.get(id);
    if (!tab?.alive) {
      this.close(id);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        listener.dispose();
        resolve(false);
      }, limitMs);
      const listener = tab.proc.onExit(() => {
        clearTimeout(timer);
        listener.dispose();
        resolve(true);
      });
      this.close(id);
    });
  }

  /// The live tabs that started in this folder.
  tabsIn(folder: string, same: (a: string, b: string) => boolean = (a, b) => a === b): number[] {
    return [...this.tabs.values()].filter((t) => t.alive && t.launch?.cwd && same(t.launch.cwd, folder)).map((t) => t.id);
  }

  private killGroupSoon(group: number): void {
    setTimeout(() => {
      try {
        process.kill(-group, 'SIGKILL');
      } catch { /* all of them have ended */ }
    }, CLOSE_GRACE_MS).unref();
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  /// Starts the same command again in a new tab and closes this one: an ended ssh connection reconnects.
  reopen(id: number): TabInfo {
    const tab = this.tab(id);
    if (!tab.launch || tab.launch.once) throw new Error(`terminal tab ${id} cannot start again`);
    const info = this.create(tab.launch.rebuild ? tab.launch.rebuild() : tab.launch);
    this.close(id);
    return info;
  }

  closeProject(project: string): void {
    for (const tab of [...this.tabs.values()]) if (tab.project === project) this.close(tab.id);
    // Their tickets and tokens end with the project; Reopen Closed Tab must not bring them back.
    this.closed.delete(project);
    this.commandTabs.delete(project);
  }

  /// One command in a tab of its own, as a Swift run has its own script and log. No prompt, no marker, and a person's
  /// tab is never touched. The wait ends the waiting only: the person can watch the tab and stop the command, and the
  /// run number reads it later. Finished command tabs make way for the next one, so the strip does not grow.
  async runCommand(launch: Launch, waitMs = 45_000): Promise<{ output: string; timedOut: boolean; run: number; code?: number | null; cut: boolean }> {
    const project = launch.project ?? '';
    const earlier = (this.commandTabs.get(project) ?? []).filter((id) => this.tabs.has(id));
    for (const id of earlier) if (!this.tabs.get(id)!.alive) this.close(id);
    let exit: number | undefined;
    const info = this.create({ ...launch, onExit: (_id, code) => { exit = code; } });
    this.commandTabs.set(project, [...earlier.filter((id) => this.tabs.has(id)), info.id]);
    const tab = this.tab(info.id);
    // The closures hold this one, and drop it when the run has ended: 400 KB per finished run adds up.
    let held: Tab | null = tab;
    let final: RunState | null = null;
    const mark = launch.startMark ?? COMMAND_START;
    const output = (t: Tab) => {
      const at = t.buffer.indexOf(mark);
      return plainOutput(at >= 0 ? t.buffer.slice(at + mark.length + 1) : t.buffer);
    };
    const read = (): RunState => {
      if (final) return final;
      const t = held!;
      const cut = t.total > t.buffer.length;
      if (t.alive && this.tabs.has(t.id)) return { output: output(t), finished: false, cut };
      const whole = output(t);
      final = { output: whole.slice(-RUN_KEPT), finished: true, code: t.closedRunning ? undefined : exit, cut: cut || whole.length > RUN_KEPT };
      // The process can end after this tab closed; then the wait below still holds `tab` for its last turn only.
      t.pending = null;
      held = null;
      return final;
    };
    tab.pending = read;
    const run = this.addRun(project, 'local', info.id, read);
    const deadline = Date.now() + waitMs;
    while (tab.alive && this.tabs.has(tab.id)) {
      if (Date.now() >= deadline) {
        const now = read();
        return { output: now.output, timedOut: true, run, cut: !!now.cut };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // The last output can arrive just after the process ends.
    await new Promise((r) => setTimeout(r, 60));
    const state = read();
    return { output: state.output, timedOut: false, run, code: state.code, cut: !!state.cut };
  }

  /// A chat names itself after the first thing asked. The strip hears from the chat; this is for the tools and the close question.
  retitle(id: number, title: string): void {
    const tab = this.tabs.get(id);
    if (tab) tab.title = title;
  }

  /// A command that runs elsewhere (a server login) reads through the same run numbers.
  addRun(project: string, kind: RunScope, tab: number, read: () => RunState): number {
    const number = ++this.runNumber;
    this.runs.set(number, { project, kind, tab, read });
    // Enough for a long session; an old number answers "no such run".
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value as number);
    return number;
  }

  runInfo(number: number): { project: string; kind: RunScope; tab: number; state: RunState } | null {
    const run = this.runs.get(number);
    return run ? { project: run.project, kind: run.kind, tab: run.tab, state: run.read() } : null;
  }

  runTab(number: number): number | null {
    return this.runs.get(number)?.tab ?? null;
  }

  private tab(id: number): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no terminal tab ${id}`);
    return tab;
  }

  private info(t: Tab): TabInfo {
    return { id: t.id, title: t.title, kind: t.kind, alive: t.alive, server: t.server, remote: t.launch?.remote, pane: t.pane, project: t.project, ...(t.launch?.chat ? { chat: true } : {}) };
  }
}

