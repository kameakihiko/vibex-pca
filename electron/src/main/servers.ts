import { app } from 'electron';
import { hostKeyFailureText, isPinnedHost, pinnedHostArgs } from './pcaHostKey';
import { endsWithApp, programPath } from './programs';
import { testEnv } from './testSwitches';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Launch } from './terminals';

/// One saved server. The system OpenSSH client does the work (built into Windows 10+ and Linux). Secrets never live
/// here: they are in serverSecrets.ts. The last 5 fields are the fork's (Vibex/Servers/ServerProfile.swift).
export interface ServerProfile {
  name: string;
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  /// Extra `-o Key=Value` options, for example UserKnownHostsFile.
  options?: Record<string, string>;
  /// How ssh proves who the person is; left out: as the person's own ssh config says.
  authentication?: 'password' | 'key';
  /// Claude may list this server, open a session to it and run in a project on it. Off by default.
  allowClaude?: boolean;
  /// The folder the picker offers first; "~" or "~/..." is the login home.
  projectPath?: string;
  /// Server ports the Claude tab opens on this computer's loopback, for previews.
  forward?: number[];
  /// Claude there asks before each change, and each terminal_run waits for a hold in the app (serverQuestions.ts).
  confirmCommands?: boolean;
  /// The name of another saved server to reach this one through.
  jump?: string;
}

const NAME = /^[\w .-]{1,64}$/;
const HOST = /^[A-Za-z0-9.:_-]{1,253}$/;
const USER = /^[A-Za-z0-9._-]{1,64}$/;
const OPTION = /^[A-Za-z]{1,40}$/;
const MAX_FORWARDS = 32;

let profilesProblem: string | null = null;

/// Why the file could not be read at the last load; the person edits it by hand, so a typo must show.
export const profilesError = () => profilesProblem;

/// Profiles live in <userData>/servers.json as a JSON array. Bad entries are skipped, never passed to ssh.
export function loadProfiles(): ServerProfile[] {
  const file = path.join(app.getPath('userData'), 'servers.json');
  profilesProblem = null;
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    // PowerShell 5.1 writes a byte order mark, which JSON.parse refuses.
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    profilesProblem = 'servers.json cannot be read';
    return [];
  }
  if (!Array.isArray(raw)) {
    profilesProblem = 'servers.json is not a list';
    return [];
  }
  const skipped = skippedNames(raw);
  if (skipped.length) profilesProblem = `Skipped in servers.json: ${skipped.join(', ')}`;
  return raw.filter(isValid);
}

/// The name of each entry the app cannot use, for a person to find it in the file. Never its other fields: a bad host may
/// be an attack, and a line in the title bar must not repeat it.
export function skippedNames(list: unknown[]): string[] {
  return list.flatMap((entry, i) => {
    if (isValid(entry)) return [];
    const name = typeof (entry as { name?: unknown } | null)?.name === 'string' ? (entry as { name: string }).name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) : '';
    return [name || `entry ${i + 1}`];
  });
}

// eslint-disable-next-line no-control-regex
const hasControl = (text: string) => /[\x00-\x1f\x7f]/.test(text);

export function isValid(p: any): p is ServerProfile {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.name !== 'string' || !NAME.test(p.name)) return false;
  if (typeof p.host !== 'string' || !HOST.test(p.host) || p.host.startsWith('-')) return false;
  if (typeof p.user !== 'string' || !USER.test(p.user) || p.user.startsWith('-')) return false;
  if (p.port !== undefined && !(Number.isInteger(p.port) && p.port > 0 && p.port < 65536)) return false;
  if (p.identityFile !== undefined && (typeof p.identityFile !== 'string' || hasControl(p.identityFile))) return false;
  if (p.authentication !== undefined && p.authentication !== 'password' && p.authentication !== 'key') return false;
  if (p.allowClaude !== undefined && typeof p.allowClaude !== 'boolean') return false;
  if (p.confirmCommands !== undefined && typeof p.confirmCommands !== 'boolean') return false;
  if (p.projectPath !== undefined && (typeof p.projectPath !== 'string' || checkServerFolder(p.projectPath))) return false;
  if (p.jump !== undefined && (typeof p.jump !== 'string' || !NAME.test(p.jump))) return false;
  if (p.forward !== undefined) {
    if (!Array.isArray(p.forward) || p.forward.length > MAX_FORWARDS) return false;
    if (!p.forward.every((port: unknown) => Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)) return false;
  }
  if (p.options !== undefined) {
    if (typeof p.options !== 'object' || p.options === null) return false;
    for (const [k, v] of Object.entries(p.options)) {
      if (!OPTION.test(k) || typeof v !== 'string' || /[\r\n"]/.test(v)) return false;
      // These run programs or load libraries; a profile file must not smuggle one in.
      if (/^(proxycommand|localcommand|permitlocalcommand|knownhostscommand|pkcs11provider|securitykeyprovider)$/i.test(k)) return false;
    }
  }
  return true;
}

export const sshProgram = () => programPath('ssh');

/// A profile by name, in any letter case, as in the fork (ServerStore.find).
export function findProfile(name: string, list: ServerProfile[]): ServerProfile | undefined {
  return list.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

/// The saved server `p` jumps through: never itself, and never a chain.
export function jumpProfile(p: ServerProfile, list: ServerProfile[]): ServerProfile | undefined {
  if (!p.jump) return undefined;
  const found = findProfile(p.jump, list);
  if (!found || found.name === p.name) return undefined;
  const { jump: _chain, ...rest } = found;
  return rest;
}

/// The key file with its home written out. People copy a PowerShell line, so a key path may start with `$HOME`,
/// `$env:USERPROFILE` or `%USERPROFILE%`; Windows ssh reads those as plain text and finds no file (seen on a PCA PC,
/// 2026-11-04: "Identity file $HOME\.ssh\id_ed25519 not accessible"). `~` stays for ssh, which expands it itself.
/// Windows names ignore case; a POSIX shell reads only `$HOME`, so there the match keeps its case.
const HOME_HEAD = /^(?:\$\{HOME\}|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/;
export function keyFilePath(file: string, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  const head = new RegExp(HOME_HEAD.source, platform === 'win32' ? 'i' : '').exec(file);
  if (!head) return file;
  const rest = file.slice(head[0].length).replace(/^[\\/]+/, '');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return rest ? paths.join(home, rest) : home;
}

function authOptions(p: ServerProfile): string[] {
  if (p.authentication === 'password') return ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password'];
  if (p.authentication === 'key') return ['-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey'];
  return [];
}

function sshOptions(p: ServerProfile, jump?: ServerProfile, jumpExtra: string[] = []): string[] {
  const args: string[] = isPinnedHost(p.host, p.port) ? pinnedHostArgs() : [];
  if (p.port) args.push('-p', String(p.port));
  if (p.identityFile) args.push('-i', keyFilePath(p.identityFile));
  // OpenSSH splits an -o value at spaces unless it is quoted ("C:\Users\Ali Valiyev\..." paths).
  for (const [k, v] of Object.entries(p.options ?? {})) args.push('-o', /\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`);
  args.push(...authOptions(p));
  // A ProxyCommand, not -J: OpenSSH gives a -J jump none of the -i and -o options, so a saved jump's key would be lost.
  if (jump) args.push('-o', `ProxyCommand=${jumpCommand(jump, process.platform, jumpExtra)}`);
  return args;
}

/// The ProxyCommand for a saved jump server: its own login, `-W` to the server, then the jump host. ssh gives the line
/// to a shell: /bin/sh here (askpass.ts sets SHELL), cmd.exe on Windows. So every word is quoted for that shell, `%` is
/// doubled so ssh does not expand it, and on Windows a character cmd.exe reads is refused.
/// `extra`: `-o` options of the login it serves (a quiet login's BatchMode or single try), so the jump never asks more.
export function jumpCommand(jump: ServerProfile, platform: NodeJS.Platform = process.platform, extra: string[] = []): string {
  if (!HOST.test(jump.host) || jump.host.startsWith('-')) throw new Error(`the jump server ${jump.name} has a host that cannot be used`);
  if (!USER.test(jump.user) || jump.user.startsWith('-')) throw new Error(`the jump server ${jump.name} has a user that cannot be used`);
  // A real Windows run names the ssh it found: ssh starts this line in the current folder of its own run.
  const program = platform !== 'win32' ? 'ssh' : process.platform === 'win32' ? sshProgram() : 'ssh.exe';
  // `extra` first: ssh keeps the first value it reads, so the jump's own options cannot raise a quiet login's limit.
  const words = [program, ...extra, '-l', jump.user, '-p', String(jump.port ?? 22), '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
  if (jump.identityFile) words.push('-i', keyFilePath(jump.identityFile, platform));
  for (const [k, v] of Object.entries(jump.options ?? {})) words.push('-o', `${k}=${v}`);
  for (let i = 0, auth = authOptions(jump); i < auth.length; i++) words.push(auth[i]);
  const word = (text: string) => {
    if (platform === 'win32') {
      if (/["&|<>^%!\r\n]/.test(text)) throw new Error(`the jump server ${jump.name} has a value that cannot go through cmd.exe: ${text}`);
      return `"${text}"`;
    }
    return shellWord(text.replace(/%/g, '%%'));
  };
  const line = [...words.map(word), '-W', platform === 'win32' ? '"[%h]:%p"' : `'[%h]:%p'`, '--', word(jump.host)];
  return line.join(' ');
}

/// The ssh command for a profile, run directly in a PTY (no shell, so no quoting issues).
export function sshLaunch(p: ServerProfile, jump?: ServerProfile): Launch {
  return { file: sshProgram(), args: [...sshOptions(p, jump), '--', `${p.user}@${p.host}`], kind: 'none', title: p.name, server: p.name };
}

/// Why a folder cannot be a project on a server, or null when it can. Only the home ("~", "~/...") and absolute
/// paths: the path goes into a remote command, so it must not read as an option or hold a control character.
export function checkServerFolder(folder: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(folder)) return 'a folder name cannot hold control characters';
  if (folder === '~' || folder.startsWith('~/') || folder.startsWith('/')) return null;
  return 'enter a folder that starts with / or ~/';
}

const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/// The folder as one word for the server's shell. A quote or $(...) in the name stays text.
export function remoteFolder(folder: string): string {
  if (folder === '~') return '"$HOME"';
  if (folder.startsWith('~/')) return `"$HOME"/${shellWord(folder.slice(2))}`;
  return shellWord(folder);
}

/// Any login shell can run this, also csh and fish: the script travels as base64 and /bin/sh reads it. As macOS Vibex
/// does (SSHCommand.viaSh).
export function viaSh(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `exec /bin/sh -c 's=$(printf %s ${encoded} | base64 -d) || { echo Vibex: base64 -d failed on this server >&2; exit 127; }; eval "$s"'`;
}

/// The login shell, and how it runs one command with its setup: -lc, except csh and tcsh, which take -l only alone.
const LOGIN_PRELUDE = `VIBEX_SH="\${SHELL:-/bin/sh}"
case "\${VIBEX_SH##*/}" in csh|tcsh) VIBEX_SH_FLAGS=-c ;; *) VIBEX_SH_FLAGS=-lc ;; esac`;

/// Goes into the project folder, or says which folder is missing. A bare "cd: can't cd to /home/pca/team" left a person
/// with no next step (seen on 2026-11-04): the folder was typed as ~/team, and the real one is /srv/pca/people/<key>.
export function enterFolder(folder: string): string {
  const say = `Vibex: the folder ${folder} is not on this server, or this login cannot open it. Open the project again from the server button and type the right folder.`;
  return `cd -- ${remoteFolder(folder)} || { printf '\\n%s\\n' ${shellWord(say)} >&2; exit 1; }`;
}

/// What a tab of a server project runs on the server. The Claude tab starts Claude in the folder and stays a shell
/// after Claude ends, so the tab is never dead. The native install comes first, because its PATH may be set only in
/// a file that a command does not read. A missing Claude shows as the shell's own "command not found".
export function serverScript(folder: string, pane: 'agent' | 'shell', agentCommand: string): string {
  const lines = [LOGIN_PRELUDE, enterFolder(folder)];
  if (pane === 'agent' && agentCommand === 'claude') {
    lines.push('if [ -x "$HOME/.local/bin/claude" ]; then "$HOME/.local/bin/claude"; else "$VIBEX_SH" $VIBEX_SH_FLAGS claude; fi');
  } else if (pane === 'agent' && agentCommand) {
    lines.push(`"$VIBEX_SH" $VIBEX_SH_FLAGS ${shellWord(agentCommand)}`);
  }
  lines.push('exec "$VIBEX_SH" -l');
  return lines.join('\n');
}

/// A tab of a server project: ssh with a terminal, into the folder. `VIBEX_AGENT_COMMAND` changes what the Claude tab
/// starts; an empty value gives a plain shell (as for a local Claude tab). The keepalive ends a dead connection,
/// so the tab offers a reconnect after a sleep or a network drop instead of a frozen screen.
export function serverLaunch(p: ServerProfile, folder: string, pane: 'agent' | 'shell', agentCommand = testEnv('VIBEX_AGENT_COMMAND') ?? 'claude'): Launch {
  return {
    file: sshProgram(),
    args: [...sshOptions(p), '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-t', '--', `${p.user}@${p.host}`, viaSh(serverScript(folder, pane, agentCommand))],
    kind: 'none',
    title: pane === 'agent' ? 'Claude' : p.name,
    server: p.name,
    pane,
  };
}

/// Lists the folders in the login home, one per line, each ending in /.
export const LIST_FOLDERS = viaSh('cd && ls -1d -- */ 2>/dev/null; true');

/// The folders in the login home on the server, for the picker. With no way to ask (`ask` empty: an old ssh), BatchMode
/// comes first, because ssh keeps the first value it reads: it never waits for a password nobody can answer. With a way
/// to ask, a password or a host key question comes to the person's sheet, so the wait is that sheet's.
/// -n: this ssh reads nothing, and execFile leaves its stdin open. One listing of 3 hung on OpenSSH_for_Windows_9.5p2 in run 41422051308; see askpass-win.spec.
/// The arguments of that listing. Through a jump, ConnectTimeout waits for the jump's login and its presence prompt (60 s).
export const listFoldersArgs = (p: ServerProfile, jump: ServerProfile | undefined, asks: boolean): string[] =>
  ['-n', ...(asks ? [] : ['-o', 'BatchMode=yes']), '-o', `ConnectTimeout=${jump ? JUMP_CONNECT_TIMEOUT : 10}`, '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', ...sshOptions(p, jump), '--', `${p.user}@${p.host}`, LIST_FOLDERS];

export function listServerFolders(p: ServerProfile, jump?: ServerProfile, ask: Record<string, string> = {}): Promise<string[]> {
  const asks = Object.keys(ask).length > 0;
  const args = listFoldersArgs(p, jump, asks);
  return new Promise((resolve, reject) => {
    endsWithApp(execFile(sshProgram(), args, { timeout: asks ? 150_000 : 20_000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ...ask } }, (error, stdout, stderr) => {
      if (error) {
        const text = String(stderr);
        if (/host key verification failed/i.test(text) && isPinnedHost(p.host, p.port)) reject(new Error(hostKeyFailureText(p.name, text)!));
        else if (/host key verification failed/i.test(text)) reject(new Error(`This computer does not know ${p.name} yet. Press Connect ${p.name} once and answer ssh there, or type the folder below.`));
        else if (/permission denied/i.test(text)) reject(new Error(`${p.name} refused the login. Check the server profile, or type the folder below.`));
        else reject(new Error(`Could not reach ${p.name}. Check the connection and the server profile.`));
        return;
      }
      resolve(String(stdout).split('\n').filter((line) => line.endsWith('/') && line.length > 1).map((line) => line.replace(/\/+$/, '')).slice(0, 200));
    }));
  });
}

// ---------- the servers file: the form writes it, and a file it cannot read stays as it is ----------

export const profilesFile = () => path.join(app.getPath('userData'), 'servers.json');

function readRaw(file: string): unknown[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('servers.json cannot be read, so the app does not change it. Fix the file first.');
  }
  if (!Array.isArray(raw)) throw new Error('servers.json is not a list, so the app does not change it. Fix the file first.');
  return raw;
}

/// What the file says now, or why it cannot say: the hold before a command must tell these apart.
export function readProfiles(file = profilesFile()): { ok: ServerProfile[] } | { error: string } {
  try {
    return { ok: readRaw(file).filter(isValid) };
  } catch (error) {
    return { error: String(error).replace(/^Error: /, '') };
  }
}

/// Changes the file as one step: each entry it does not name stays, also one the app cannot use, and a file it cannot
/// read is never overwritten. Private to this user, as in the fork.
export function updateProfiles(file: string, change: (list: any[]) => any[]): any[] {
  const next = change(readRaw(file) as any[]);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch {
    // On Windows an antivirus or the indexer often holds the file for a moment.
    renameSync(temp, file);
  }
  return next;
}

const FORM_KEYS = ['name', 'host', 'user', 'port', 'identityFile', 'authentication', 'allowClaude', 'projectPath', 'forward', 'confirmCommands', 'jump'] as const;

/// The list with `input` in the place of the entry named `previous`, or at the end. The form owns its fields; every
/// other key of the entry (options, notes) stays.
export function savedProfile(list: any[], input: ServerProfile, previous: string | null): any[] {
  const at = previous === null ? -1 : list.findIndex((p) => p && p.name === previous);
  const entry: any = at >= 0 ? { ...list[at] } : {};
  for (const key of FORM_KEYS) {
    if (input[key] === undefined) delete entry[key];
    else entry[key] = input[key];
  }
  const next = [...list];
  if (at >= 0) next[at] = entry;
  else next.push(entry);
  return next;
}

/// What is wrong with the form, in plain words, or null. The same checks as for the file (isValid), one at a time.
export function checkProfile(input: ServerProfile, others: ServerProfile[], previous: string | null): string | null {
  const field = (key: keyof ServerProfile) => isValid({ name: 'x', host: 'x', user: 'x', [key]: input[key] });
  if (!input.name || !field('name')) return 'Enter a name: letters, digits, spaces, dots and dashes.';
  if (!input.host || !field('host') || input.host.startsWith('-')) return 'Enter a host name or an address. It cannot start with a dash.';
  if (!input.user || !field('user') || input.user.startsWith('-')) return 'Enter a user name with no spaces. It cannot start with a dash.';
  if (input.port !== undefined && !field('port')) return 'The port must be between 1 and 65535.';
  if (input.authentication === 'key' && !input.identityFile) return 'Enter the key file, or choose another login.';
  if (!field('identityFile')) return 'The key file path cannot hold control characters.';
  if (input.projectPath !== undefined && !field('projectPath')) return `The project folder: ${checkServerFolder(input.projectPath) ?? 'it cannot be used'}.`;
  if (!field('forward')) return `Forward ports must be numbers between 1 and 65535, at most ${MAX_FORWARDS}.`;
  const taken = others.find((p) => p.name.toLowerCase() === input.name.toLowerCase());
  if (taken && taken.name !== previous) return `A server named ${taken.name} exists already.`;
  if (input.jump !== undefined) {
    if (input.jump.toLowerCase() === input.name.toLowerCase()) return 'A server cannot jump through itself.';
    if (!findProfile(input.jump, others)) return `No saved server is named ${input.jump}.`;
  }
  return null;
}

// ---------- Claude on a server: the tunnel and the script (fork: Servers/CloudProject.swift) ----------

/// Carries the project's token to the server: its LC_ prefix passes a default sshd (AcceptEnv LANG LC_*), and it never
/// shows in the server's process list.
export const TOKEN_VARIABLE = 'LC_VIBEX_MCP_TOKEN';
/// The lowest Claude Code known to read the keys of `claudeSettings`.
export const MINIMUM_CLAUDE = '2.1.303';
/// Claude asks before each command and file change, and cannot switch to bypass or auto mode.
export const claudeSettings = '{"permissions":{"ask":["Bash","Edit","Write","MultiEdit","NotebookEdit"],"defaultMode":"default","disableAutoMode":"disable","disableBypassPermissionsMode":"disable"}}';
const CONFIRM_OPTIONS = '--permission-mode default --settings "$VIBEX_CLAUDE_SETTINGS"';
const CONFIRM_VARIABLES = 'VIBEX_CLAUDE_SETTINGS VIBEX_CLAUDE_COMMANDS VIBEX_CLAUDE_CHECK VIBEX_CLAUDE_START';

const fnv = (text: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash;
};

function pickPorts(seed: string, from: number, size: number): number[] {
  const ports: number[] = [];
  let hash = fnv(seed);
  while (ports.length < 3) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(ports.length + 1)) * 0x100000001b3n);
    const port = from + Number(hash % BigInt(size));
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/// The server ports a Claude tab tries for its tunnel. Not this computer's own port: after a restart an earlier sshd can
/// still hold that one on the server, and Claude would reach a dead tunnel.
export const serverPorts = (windowId: string) => pickPorts(windowId, 20_000, 40_000);
/// The server ports one more tab tries; the two ranges never meet.
export const shellPorts = (windowId: string, tabId: string) => pickPorts(`${windowId}/${tabId}`, 60_000, 5_000);

/// What Claude reaches, with a reference to the token that Claude Code expands. Nothing goes in a file on the server.
function mcpConfig(remotePort: number, windowId: string): string {
  return JSON.stringify({ mcpServers: { vibex: { headers: { Authorization: `Bearer \${${TOKEN_VARIABLE}}`, 'X-Vibex-Window': windowId }, type: 'http', url: `http://127.0.0.1:${remotePort}/mcp` } } });
}

/// What Claude on the server knows from its first turn: a server has no session hook, and the tools connect after that
/// turn. One line, with no character that sh or csh expands in double quotes.
function serverContext(profile: ServerProfile, folder: string, forward: number[]): string {
  const ports = forward.length ? ` (this project forwards server ports ${forward.join(', ')} to the computer)` : '';
  const text = `You run on the server ${profile.name}, started from a Vibex PCA project for it on the user's computer (the project folder on the server is ${folder}; you may have started elsewhere).`
    + ' Vibex PCA is a workstation: Claude terminal (left) | browser (middle) | command terminal (right).'
    + " Your shell and files are on this server; the computer's files are not reachable."
    + ' The vibex MCP tools (mcp__vibex__*) reach the computer through this ssh connection. If they are deferred, load them with ToolSearch query +vibex.'
    + ` Run EVERY shell command with the vibex tool terminal_run, even pwd or ls: it opens a tab on the computer where the user watches the command, runs it on this server, and returns the output and exit code. It starts in the project folder ${folder}; for another folder pass cwd.`
    + ' Use your own Bash tool only if the vibex tools are not available: then say so once and suggest pressing Enter in the Claude tab to reconnect.'
    + ` The browser tools open internet pages and the ports this project forwards${ports}; the computer's files, its local services and the LAN are refused.`
    + ' To show a page you serve on this server, call browser_navigate with http://localhost:<port>/...; Vibex forwards the port to the computer and opens it.'
    + ' If the vibex tools fail, the ssh connection or its tunnel ended: tell the user to press Enter in the Claude tab to connect again.';
  return text.replace(/[\r\n$`\\"!]/g, '');
}

const CLAUDE_CHECK = `[ "$("$VIBEX_CLAUDE" --version 2>/dev/null | head -n 1 | awk -v min=${MINIMUM_CLAUDE} 'BEGIN { split(min, m, ".") } { v = $1; if (v !~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/) { print 0; exit } split(v, p, "."); for (i = 1; i <= 3; i++) { if (p[i] + 0 > m[i] + 0) { print 1; exit } if (p[i] + 0 < m[i] + 0) { print 0; exit } } print 1; exit }')" = 1 ]`;

const CLAUDE_START = `if ! /bin/sh -c "$VIBEX_CLAUDE_CHECK"; then echo "Vibex: this server asks before each change, but its Claude Code is older than ${MINIMUM_CLAUDE} or did not give its version, so it may not ask. Vibex does not start it." >&2; exit 1; fi; `
  + 'case " $* " in *" --append-system-prompt"*) ;; *) set -- "$@" --append-system-prompt "$VIBEX_CONTEXT" ;; esac; '
  + `exec "$VIBEX_CLAUDE" "$@" ${CONFIRM_OPTIONS} --mcp-config "$VIBEX_MCP_CONFIG"`;

const confirmPrelude = (again: string) => `  VIBEX_CLAUDE_COMMANDS=$("$VIBEX_CLAUDE" --help 2>/dev/null | awk '/^Commands:/ { c = 1; next } c && /^  [^ ]/ { print $1 }' | tr '|' '\\n' | tr '\\n' ' ')
  VIBEX_CLAUDE_CHECK=${shellWord(CLAUDE_CHECK)}
  VIBEX_CLAUDE_START=${shellWord(CLAUDE_START)}
  export VIBEX_CLAUDE_COMMANDS VIBEX_CLAUDE_CHECK VIBEX_CLAUDE_START
  if ! /bin/sh -c "$VIBEX_CLAUDE_CHECK"; then
    echo 'Vibex: this server asks before each change, but its Claude Code is older than ${MINIMUM_CLAUDE} or did not give its version, so it may not ask. Vibex does not start it. Update it, ${again}.'
    unset VIBEX_MCP_CONFIG VIBEX_CONTEXT VIBEX_CLAUDE ${CONFIRM_VARIABLES} ${TOKEN_VARIABLE}
    exec "$VIBEX_SH" -l
  fi`;

/// The POSIX script of a tab in a project on a server, with the tools: Claude in the folder, started by the login shell
/// for its PATH, then a login shell where `claude` starts it again with the tools (bash: an exported function; other
/// shells: the line to type is printed). `--mcp-config` takes several values, so nothing may follow it. A shell tab has
/// the same variables and function, and Claude does not start. The script holds no secret; ssh sends the token.
export function toolsScript(o: { profile: ServerProfile; folder: string; pane: 'agent' | 'shell'; remotePort: number; windowId: string; forward: number[] }): string {
  const confirm = !!o.profile.confirmCommands;
  const shellOnly = o.pane === 'shell';
  const mcp = '"$VIBEX_CLAUDE" "$@" --mcp-config "$VIBEX_MCP_CONFIG"';
  const fixed = 'mcp|update|doctor|install|config|auth|plugin|setup-token|migrate-installer';
  const session = '/bin/sh -c "$VIBEX_CLAUDE_START" claude';
  const noted = `case " $* " in *" --append-system-prompt"*) ${mcp} ;; *) "$VIBEX_CLAUDE" "$@" --append-system-prompt "$VIBEX_CONTEXT" --mcp-config "$VIBEX_MCP_CONFIG" ;; esac`;
  const fn = confirm
    ? `case "\${1:-}" in ""|-*|*[!a-z0-9-]*) ${session} "$@" ;; *) case " $VIBEX_CLAUDE_COMMANDS " in *" $1 "*) case "$1" in ${fixed}) "$VIBEX_CLAUDE" "$@" ;; *) ${mcp} ;; esac ;; *) ${session} "$@" ;; esac ;; esac;`
    : `case "\${1:-}" in ${fixed}) "$VIBEX_CLAUDE" "$@" ;; *) ${noted} ;; esac;`;
  const start = confirm ? session : '"$VIBEX_CLAUDE" --append-system-prompt "$VIBEX_CONTEXT" --mcp-config "$VIBEX_MCP_CONFIG"';
  const again = shellOnly ? 'close this tab and open a new one' : 'exit this shell, and press Enter to connect again';
  const launch = shellOnly
    ? `  case "\${VIBEX_SH##*/}" in
    bash) exec env 'BASH_FUNC_claude%%=() { ${fn} }' "$VIBEX_SH" -l ;;
    *)
      echo 'Vibex: to start Claude here with the Vibex tools, type:'
      echo '  ${start}' ;;
  esac`
    : `  printf 'Vibex: starting %s (%s)\\n' "$VIBEX_CLAUDE" "$("$VIBEX_CLAUDE" --version 2>/dev/null | head -n 1)"${confirm ? "\n  echo 'Vibex: this server asks before each change (confirmCommands): Claude asks before commands and edits.'" : ''}
  "$VIBEX_SH" $VIBEX_SH_FLAGS '${start}'
  case "\${VIBEX_SH##*/}" in
    bash)
      echo 'Vibex: Claude ended. Type claude to start it again with the Vibex tools.'
      exec env 'BASH_FUNC_claude%%=() { ${fn} }' "$VIBEX_SH" -l ;;
    *)
      echo 'Vibex: Claude ended. To start it again with the Vibex tools, type:'
      echo '  ${start}' ;;
  esac`;
  const missing = shellOnly ? '' : `\n  echo 'Vibex: no claude found on this server.'`;
  return `${LOGIN_PRELUDE}
${enterFolder(o.folder)}
VIBEX_MCP_CONFIG=${shellWord(mcpConfig(o.remotePort, o.windowId))}
export VIBEX_MCP_CONFIG
VIBEX_CONTEXT=${shellWord(serverContext(o.profile, o.folder, o.forward))}
export VIBEX_CONTEXT${confirm ? `\nVIBEX_CLAUDE_SETTINGS=${shellWord(claudeSettings)}\nexport VIBEX_CLAUDE_SETTINGS` : ''}
VIBEX_CLAUDE=
if [ -x "$HOME/.local/bin/claude" ]; then VIBEX_CLAUDE="$HOME/.local/bin/claude"; fi
if [ -z "$VIBEX_CLAUDE" ]; then
  VIBEX_CLAUDE=$("$VIBEX_SH" $VIBEX_SH_FLAGS 'command -v claude || which claude' 2>/dev/null | tail -n 1)
fi
if [ -n "$VIBEX_CLAUDE" ] && [ -x "$VIBEX_CLAUDE" ]; then
  export VIBEX_CLAUDE${confirm ? `\n${confirmPrelude(again)}` : ''}
${launch}
else${missing}
  unset VIBEX_MCP_CONFIG VIBEX_CONTEXT VIBEX_CLAUDE${confirm ? ` ${CONFIRM_VARIABLES}` : ''} ${TOKEN_VARIABLE}
fi
exec "$VIBEX_SH" -l`;
}

export interface TunnelOptions {
  /// The server-side port of this tab's tunnel, and the MCP port on this computer.
  remotePort: number;
  localPort: number;
  windowId: string;
  /// The token of this project (never the full key of the app).
  token: string;
  /// What the Claude tab starts: `VIBEX_AGENT_COMMAND`, as for a tab with no tools.
  agentCommand?: string;
}

/// A tab of a project on a server with the tools. The token goes in this ssh's environment only, and ssh sends it. ssh
/// ends when it cannot bind the tunnel: a busy port must not leave Claude with no tools (the caller tries the next).
export function tunnelLaunch(p: ServerProfile, jump: ServerProfile | undefined, folder: string, pane: 'agent' | 'shell', o: TunnelOptions): Launch {
  const command = o.agentCommand ?? testEnv('VIBEX_AGENT_COMMAND') ?? 'claude';
  const forward = p.forward ?? [];
  const script = pane === 'agent' && command !== 'claude'
    ? serverScript(folder, 'agent', command)
    : toolsScript({ profile: p, folder, pane, remotePort: o.remotePort, windowId: o.windowId, forward });
  return {
    file: sshProgram(),
    args: [
      ...sshOptions(p, jump),
      '-o', connectTimeout(jump), '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-t',
      ...(pane === 'agent' ? forward.flatMap((port) => ['-L', `127.0.0.1:${port}:127.0.0.1:${port}`]) : []),
      '-R', `127.0.0.1:${o.remotePort}:127.0.0.1:${o.localPort}`,
      '-o', 'ExitOnForwardFailure=yes',
      '-o', `SendEnv=${TOKEN_VARIABLE}`,
      '--', `${p.user}@${p.host}`, viaSh(script),
    ],
    env: { [TOKEN_VARIABLE]: o.token },
    kind: 'none',
    title: pane === 'agent' ? 'Claude' : p.name,
    server: p.name,
    pane,
  };
}

/// The folder a command runs in: `cwd` when it names a place by itself, else inside the project's folder.
export function runFolder(folder: string, cwd?: string): string {
  if (!cwd) return folder;
  return cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/') ? cwd : path.posix.join(folder, cwd);
}

/// One command on the server, in the folder, by the login shell. Its exit code is the remote command's.
export function runScript(folder: string, cwd: string | undefined, command: string): string {
  return `${LOGIN_PRELUDE}\ncd -- ${remoteFolder(runFolder(folder, cwd))} || exit 1\nexec "$VIBEX_SH" $VIBEX_SH_FLAGS ${shellWord(command)}\n`;
}

/// A login of its own for one terminal_run, in a tab the person watches. LogLevel keeps ssh's own "Connection closed"
/// line out of the command's output. No `server` field: this tab never offers a reconnect, which would run it again.
export function runLaunch(p: ServerProfile, jump: ServerProfile | undefined, folder: string, cwd: string | undefined, command: string): Launch {
  return {
    file: sshProgram(),
    args: [...sshOptions(p, jump), '-o', connectTimeout(jump), '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', '-tt', '--', `${p.user}@${p.host}`, viaSh(runScript(folder, cwd, command))],
    kind: 'none',
    title: `Run on ${p.name}`,
    pane: 'shell',
    once: true,
    remote: true,
  };
}

/// A run's output as text: a tty sends CR LF, and the trailing line break is not the command's word.
export const stripOutput = (text: string) => text.trimEnd();

/// ConnectTimeout covers the wait for the server's banner, which comes through the ProxyCommand. The jump logs in during that
/// wait, and the presence prompt for its saved secret stays open for up to 40 s (savedSecretGate.ts; fork: jumpConnectTimeout).
export const JUMP_CONNECT_TIMEOUT = 60;
const connectTimeout = (jump?: ServerProfile) => `ConnectTimeout=${jump ? JUMP_CONNECT_TIMEOUT : 15}`;

/// The arguments of a login with no terminal and no tab: a port forward or a listing. `extra` comes before the target.
export function loginArgs(p: ServerProfile, jump: ServerProfile | undefined, extra: string[], remote: string): string[] {
  return [...sshOptions(p, jump), '-o', connectTimeout(jump), '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-T', ...extra, '--', `${p.user}@${p.host}`, remote];
}

/// The same options as a real login, for `ssh -G` (no network): askpass.ts reads who ssh will log in to.
export const configArgs = (p: ServerProfile, jump?: ServerProfile) => ['-G', ...sshOptions(p, jump), '--', `${p.user}@${p.host}`];

// ---------- the native chat on a server (serverChat.ts) ----------
//
// A chat speaks Claude Code's stream format over the standard output of one ssh login, so nothing else may write there:
// each script below moves its own standard output to standard error first (`exec 3>&1 1>&2`) and gives the real one
// only to Claude, or to the one JSON reply. There is no terminal (no -t), so the end of the local ssh does not end Claude
// on the server: the chat script starts a guard that ends Claude's process group when its ssh session ends, and the
// stop script ends it on request. Both find it by a chat id that the script exports into Claude's environment.

/// One chat process on the server: in its environment, and the name of its pid file.
export const safeChatId = (id: string) => /^[a-f0-9]{16,64}$/.test(id);

/// The server ports a chat tries for its tunnel. A range of its own: the Claude tab and the shell tabs use 20000 and up.
export const chatPorts = (windowId: string, chatKey: string) => pickPorts(`chat/${windowId}/${chatKey}`, 10_000, 10_000);

/// The folder of the pid files, private to the login (umask 077).
const CHAT_DIR = '"$HOME/.cache/vibex-chat"';

/// What Claude in a chat on a server knows from its first turn. The chat tab has no Enter to reconnect: the next message
/// starts a new login. One line, with no character that sh expands in double quotes.
function chatContext(profile: ServerProfile, folder: string, forward: number[], tools: boolean): string {
  const ports = forward.length ? ` (this project forwards server ports ${forward.join(', ')} to the computer)` : '';
  const text = `You run on the server ${profile.name}, started from a Vibex PCA chat on the user's computer (the project folder on the server is ${folder}).`
    + ' The person reads your answers in a chat window, not a terminal, and answers each permission request on a card there.'
    + " Your shell and files are on this server; the computer's files are not reachable."
    + (tools
      ? ' The vibex MCP tools (mcp__vibex__*) reach the computer through this ssh connection. If they are deferred, load them with ToolSearch query +vibex.'
        + ` Run shell commands with the vibex tool terminal_run, so the person can watch them in the command terminal; it runs on this server, in ${folder} unless you pass cwd.`
        + ` The browser tools open internet pages and the ports this project forwards${ports}; to show a page you serve here, call browser_navigate with http://localhost:<port>/...`
        + ' If the vibex tools fail, the connection ended: tell the person to send the message again.'
      : ' This chat has no Vibex tools (no free tunnel port on the server): use your own tools, and say so once if the person asks for the browser or the command terminal.');
  return text.replace(/[\r\n$`\\"!]/g, '');
}

export interface ChatScriptOptions {
  profile: ServerProfile;
  folder: string;
  chatId: string;
  /// Claude Code's own arguments (chatModel.ts claudeArgs). Each one becomes one quoted word.
  claudeArgs: string[];
  /// The server end of the tunnel to the app's tools, or null for a chat with no tools (and for the catalog).
  remotePort: number | null;
  windowId: string;
}

/// The script of a chat on a server: quiet until Claude starts. Claude gets the login shell's PATH, the same version
/// check and settings as the Claude tab on a server that asks before each change, and the tools when there is a tunnel.
/// It writes its pid file, starts the guard, and becomes Claude (exec), so Claude's pid is the script's and leads its group.
export function chatScript(o: ChatScriptOptions): string {
  if (!safeChatId(o.chatId)) throw new Error('bad chat id');
  const confirm = !!o.profile.confirmCommands;
  const forward = o.profile.forward ?? [];
  const tools = o.remotePort !== null;
  // A server that asks before each change starts Claude in Ask mode, whatever the chat last used, as its Claude tab does
  // (security review N2). The person may still switch while it runs, as in that tab.
  const args = confirm ? o.claudeArgs.map((word, i, all) => (all[i - 1] === '--permission-mode' ? 'default' : word)) : o.claudeArgs;
  const words = args.map(shellWord).join(' ');
  const lines = [
    'exec 3>&1 1>&2',
    LOGIN_PRELUDE,
    enterFolder(o.folder),
    'umask 077',
    `VIBEX_CHAT_ID=${o.chatId}`,
    'export VIBEX_CHAT_ID',
    `VIBEX_CONTEXT=${shellWord(chatContext(o.profile, o.folder, forward, tools))}`,
    ...(tools ? [`VIBEX_MCP_CONFIG=${shellWord(mcpConfig(o.remotePort!, o.windowId))}`, 'export VIBEX_MCP_CONFIG'] : [`unset ${TOKEN_VARIABLE}`]),
    ...(confirm ? [`VIBEX_CLAUDE_SETTINGS=${shellWord(claudeSettings)}`] : []),
    // The login shell's PATH, read with nothing on its input: its start files may print, and the stream input is Claude's.
    `VIBEX_PATH=$("$VIBEX_SH" $VIBEX_SH_FLAGS 'printf "\\nVIBEX_PATH=%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^VIBEX_PATH=//p' | tail -n 1)`,
    'if [ -n "$VIBEX_PATH" ]; then PATH=$VIBEX_PATH; export PATH; fi',
    'VIBEX_CLAUDE=',
    'if [ -x "$HOME/.local/bin/claude" ]; then VIBEX_CLAUDE="$HOME/.local/bin/claude"; else VIBEX_CLAUDE=$(command -v claude 2>/dev/null); fi',
    `if [ -z "$VIBEX_CLAUDE" ] || [ ! -x "$VIBEX_CLAUDE" ]; then echo 'Vibex: no claude found on this server.'; exit 127; fi`,
    ...(confirm ? [`if ! { ${CLAUDE_CHECK}; } </dev/null; then echo 'Vibex: this server asks before each change, but its Claude Code is older than ${MINIMUM_CLAUDE} or did not give its version, so it may not ask. Vibex does not start it.'; exit 1; fi`] : []),
    `VIBEX_DIR=${CHAT_DIR}`,
    `mkdir -p "$VIBEX_DIR" || exit 1`,
    // Pid files of chats that ended: their group is gone.
    'for f in "$VIBEX_DIR"/*.pid; do [ -f "$f" ] || continue; q=$(cat "$f" 2>/dev/null); case "$q" in ""|*[!0-9]*) rm -f "$f" ;; *) kill -s 0 -- "-$q" 2>/dev/null || rm -f "$f" ;; esac; done',
    'printf \'%s\\n\' "$$" > "$VIBEX_DIR/$VIBEX_CHAT_ID.pid" || exit 1',
    // The guard: while the ssh session (this script's parent) and Claude's group live, it waits. Then it ends the group.
    // It holds none of the three streams, so the session ends when Claude does. A TERM to the group does not end it.
    'VIBEX_SSHD=$PPID',
    '( trap \'\' TERM HUP INT; p=$$; while kill -s 0 "$VIBEX_SSHD" 2>/dev/null && kill -s 0 -- "-$p" 2>/dev/null; do sleep 2; done; rm -f "$VIBEX_DIR/$VIBEX_CHAT_ID.pid"; kill -s TERM -- "-$p" 2>/dev/null; sleep 3; kill -s KILL -- "-$p" 2>/dev/null ) </dev/null >/dev/null 2>&1 &',
    `set -- ${words}`,
    `exec "$VIBEX_CLAUDE" "$@" --append-system-prompt "$VIBEX_CONTEXT"${confirm ? ' --settings "$VIBEX_CLAUDE_SETTINGS"' : ''}${tools ? ' --mcp-config "$VIBEX_MCP_CONFIG"' : ''} 1>&3 3>&-`,
  ];
  return lines.join('\n');
}

/// Ends one chat's Claude on the server, with everything it started. The pid file names the group, and the group is ended
/// only when it is this chat's: on Linux, one of its members carries this chat's id in its environment (Claude's children
/// inherit it), so a stale file whose number now names another person's group ends nothing (security review N1). With no
/// /proc, a live leader must be a claude, and a group with no leader is left to the guard. Prints `stopped` or `left`.
export function chatStopScript(chatId: string): string {
  if (!safeChatId(chatId)) throw new Error('bad chat id');
  return `exec 3>&1 1>&2
f=${CHAT_DIR}/${chatId}.pid
done_() { rm -f "$f"; echo stopped >&3; exit 0; }
[ -f "$f" ] || done_
p=$(cat "$f" 2>/dev/null)
case "$p" in ""|*[!0-9]*) done_ ;; esac
[ "$p" -gt 1 ] || done_
if [ -d /proc/self ]; then
  ours=
  for d in /proc/[0-9]*; do
    g=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f3)
    [ "$g" = "$p" ] || continue
    if tr '\\000' '\\n' < "$d/environ" 2>/dev/null | grep -qx 'VIBEX_CHAT_ID=${chatId}'; then ours=1; break; fi
  done
  [ -n "$ours" ] || done_
elif kill -s 0 "$p" 2>/dev/null; then
  ps -p "$p" -o command= 2>/dev/null | grep -q claude || done_
else
  done_
fi
kill -s TERM -- "-$p" 2>/dev/null
i=0
while kill -s 0 -- "-$p" 2>/dev/null && [ $i -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
kill -s KILL -- "-$p" 2>/dev/null
sleep 0.3
if kill -s 0 -- "-$p" 2>/dev/null; then echo left >&3; exit 1; fi
rm -f "$f"
echo stopped >&3`;
}

/// What the server tells a chat about its folder, as one JSON line, read by python3 there: the real path, the trust
/// answers of that folder and its parents only (never the rest of the shared Claude file), which of them hold .git, and
/// the newest conversations with the first thing typed. With a session, the transcript of that conversation instead
/// (its last 32 MiB). Claude Code keeps both under the login, by the real path.
const PROBE_PY = String.raw`import json, os, sys, unicodedata
real, session = sys.argv[1], sys.argv[2]
home = os.path.expanduser('~')
cfg = os.environ.get('CLAUDE_CONFIG_DIR') or ''
store = cfg or os.path.join(home, '.claude')
slug = ''.join(c if c.isascii() and c.isalnum() else '-' for c in real)
folder = os.path.join(store, 'projects', slug)
out = os.fdopen(3, 'wb')
if session:
    path = os.path.join(folder, session + '.jsonl')
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 33554432))
            out.write(f.read())
    except OSError:
        pass
    out.close()
    sys.exit(0)
try:
    with open(os.path.join(cfg, '.claude.json') if cfg else os.path.join(home, '.claude.json'), encoding='utf-8') as f:
        projects = json.load(f).get('projects') or {}
except Exception:
    projects = {}
if not isinstance(projects, dict):
    projects = {}
chain, at = [], real
while True:
    chain.append(at)
    parent = os.path.dirname(at)
    if parent == at:
        break
    at = parent
trusted = {}
for p in chain:
    for key in {p, unicodedata.normalize('NFC', p)}:
        e = projects.get(key)
        if isinstance(e, dict) and e.get('hasTrustDialogAccepted') is True:
            trusted[key] = {'hasTrustDialogAccepted': True}
gits = [p for p in chain if os.path.exists(os.path.join(p, '.git'))]
def title(path):
    with open(path, 'rb') as f:
        head = f.read(256000).decode('utf-8', 'replace')
    for line in head.split('\n'):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if not isinstance(o, dict) or o.get('type') != 'user' or o.get('isSidechain') is True or isinstance(o.get('parent_tool_use_id'), str):
            continue
        content = (o.get('message') or {}).get('content')
        texts = [content] if isinstance(content, str) else [b.get('text') for b in content if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str)] if isinstance(content, list) else []
        for t in texts:
            t = t.strip()
            if not t or t.startswith('<') or t.startswith('[Request interrupted'):
                continue
            if t.startswith('/'):
                break
            return t[:70].replace('\n', ' ')
    return None
sessions = []
try:
    names = [n for n in os.listdir(folder) if n.endswith('.jsonl')]
except OSError:
    names = []
dated = []
for n in names:
    try:
        dated.append((os.path.getmtime(os.path.join(folder, n)), n))
    except OSError:
        pass
for date, n in sorted(dated, reverse=True)[:24]:
    try:
        t = title(os.path.join(folder, n))
    except Exception:
        t = None
    if t:
        sessions.append({'id': n[:-6], 'title': t, 'date': int(date * 1000)})
    if len(sessions) == 12:
        break
out.write((json.dumps({'real': real, 'projects': trusted, 'gits': gits, 'sessions': sessions}) + '\n').encode('utf-8'))
out.close()
`;

/// The probe of a chat's folder on the server, or one transcript (`session`, checked by the caller).
export function chatProbeScript(folder: string, session = ''): string {
  if (session && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session)) throw new Error('bad session');
  return `exec 3>&1 1>&2
${enterFolder(folder)}
VIBEX_REAL=$(pwd -P) || exit 1
command -v python3 >/dev/null 2>&1 || { echo 'Vibex: this server has no python3, so the chat cannot read its folder there.'; exit 3; }
# The folder is not trusted yet: python must load nothing from it. -I keeps the current folder and PYTHON* variables out of
# its import path, and it runs from / besides (security review B1: a json.py in a cloned repo ran).
cd / || exit 1
exec python3 -I -c ${shellWord(PROBE_PY)} "$VIBEX_REAL" ${shellWord(session)} </dev/null`;
}

export interface ChatLoginOptions {
  /// The app can answer this login's prompts (an askpass ticket). Without it, BatchMode: a hidden process never waits.
  asks: boolean;
  /// The `-o` options that limit what this login may try (serverHub.ts gives quietLoginOptions). Unset: one try when it asks.
  quiet?: string[];
  /// A tunnel to the app's tools: the server port and the app's MCP port on this computer.
  tunnel?: { remotePort: number; localPort: number };
}

/// The ssh arguments of a chat login: no terminal (-T), and with a tunnel `-v`, because ssh says only on its debug
/// lines that the remote forward is up (the chat holds its input until then; serverChat.ts). The project's forwards
/// come with the tunnel, as on the Claude tab.
export function chatLoginArgs(p: ServerProfile, jump: ServerProfile | undefined, script: string, o: ChatLoginOptions): string[] {
  // A chat login nobody watches. A refused or unanswered prompt makes ssh send an empty password, and the server counts each
  // one against the shared login (security review B2): so one try per login, and none at all when the app cannot answer.
  // The person's next action is the next try. The jump's own ssh gets the same.
  const quiet = !o.asks ? ['-o', 'BatchMode=yes'] : o.quiet ?? ['-o', 'NumberOfPasswordPrompts=1'];
  const tunnel = o.tunnel ? ['-v', ...(p.forward ?? []).flatMap((port) => ['-L', `127.0.0.1:${port}:127.0.0.1:${port}`]), '-R', `127.0.0.1:${o.tunnel.remotePort}:127.0.0.1:${o.tunnel.localPort}`, '-o', 'ExitOnForwardFailure=yes', '-o', `SendEnv=${TOKEN_VARIABLE}`] : [];
  return [...quiet, ...sshOptions(p, jump, quiet), '-o', connectTimeout(jump), '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-T', ...tunnel, '--', `${p.user}@${p.host}`, viaSh(script)];
}
