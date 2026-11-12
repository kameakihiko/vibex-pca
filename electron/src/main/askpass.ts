import { execFile } from 'node:child_process';
import { endsWithApp, runnable } from './programs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { shown, unsafeCharacters, type Answer, type Questions } from './serverQuestions';
import type { SecretKind, SecretStore } from './serverSecrets';
import { hostKeyFailureText, hostKeyVerdict } from './pcaHostKey';
import { configArgs, keyFilePath, sshProgram, type ServerProfile } from './servers';
import { noPresence, presenceReason, SavedSecretGate, type Presence } from './savedSecretGate';
import { buildKind } from './testSwitches';

// ssh's own prompts for every ssh the app starts, through SSH_ASKPASS (fork: Servers/Askpass.swift, PR #24). ssh asks the
// helper, never the terminal, for its password, key passphrase and host key question. Text the server prints is only
// terminal output: it cannot run the helper, so it can never receive a secret, and the app reads nothing on the screen.
//
// On Linux and macOS the helper is this app itself (`askpassHelper.ts`), run by ssh with VIBEX_ASKPASS_HELPER=1. On Windows it is a
// small native program (`native/askpass-win`), because Electron writes a line end to stdout before any code of the app runs. Never a
// .cmd: cmd.exe parses a batch file's whole command line, and a keyboard-interactive prompt is text from the server, so a quote and
// an & in it would run a program on this computer.
//
// Not as strong as the fork: Node gives no peer process for a socket, so the fork's check of the process chain (the
// bundled helper under /usr/bin/ssh in a marked tab) is not here. Instead each ssh has its own ticket, which only that
// ssh's environment holds, and a socket only this user can open. A process of this user that reads ssh's environment
// can ask with that ticket, once for the saved secret. Also not covered, as in the fork: root, and a same-user edit of
// ~/.ssh/config (ProxyCommand, LocalCommand, Match exec). On Windows also a same-user change of the unsigned helper file.

export const MAX_BODY = 16 * 1024;
const MAX_CONNECTIONS = 32;
const REQUEST_DEADLINE_MS = 2_000;
const MAX_TYPED = 5;

export interface AskRequest { key: string; hint: string; prompt: string }
export interface JumpHost { user?: string; host: string }

/// Who ssh logs in to, as `ssh -G` resolves it: HostName and HostKeyAlias change the host ssh names in its prompts.
export interface Target { user: string; hosts: string[]; port: number; jumps: JumpHost[]; keys: string[] }

export type Prompt = { kind: 'secret'; secret: SecretKind } | { kind: 'typed' } | { kind: 'hostKey' } | { kind: 'other' };
export type JumpPrompt = { kind: 'secret'; secret: SecretKind; profile: ServerProfile } | { kind: 'typed' } | { kind: 'hostKey' } | { kind: 'other' };

/// The secret ssh asks for with this login.
export const expectedSecret = (p: ServerProfile): SecretKind => (p.authentication === 'key' || (!p.authentication && p.identityFile) ? 'passphrase' : 'password');

const profileTarget = (p: ServerProfile): Target => ({ user: p.user, hosts: [p.host], port: p.port ?? 22, jumps: [], keys: [] });

/// The user and host a password or keyboard-interactive prompt names, and the question (null: "password").
function named(text: string): { user: string; host: string; question: string | null } | null {
  if (text.toLowerCase().endsWith("'s password:")) {
    const name = text.slice(0, -"'s password:".length);
    const at = name.lastIndexOf('@');
    return at < 0 ? null : { user: name.slice(0, at), host: name.slice(at + 1), question: null };
  }
  if (text.startsWith('(') && text.includes(')')) {
    const close = text.indexOf(')');
    const name = text.slice(1, close);
    const at = name.lastIndexOf('@');
    const question = text.slice(close + 1).trim();
    if (at < 0 || !question) return null;
    return { user: name.slice(0, at), host: name.slice(at + 1), question: question.toLowerCase() === 'password:' ? null : question };
  }
  return null;
}

function passphraseKey(text: string): string | null {
  for (const quote of ["'", '"']) {
    const head = `Enter passphrase for key ${quote}`;
    if (text.startsWith(head) && text.endsWith(`${quote}:`)) return text.slice(head.length, -2);
  }
  return null;
}

/// True when a key named in a prompt is this file. ssh's prompt cuts the path to 100 bytes ('%.100s'), which can fall inside
/// a Cyrillic letter. Windows ssh joins its home folder and the rest of `~/...` with its own slash (C:\Users\x/.ssh/id).
export function keyNameMatches(shown: string, file: string, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  file = keyFilePath(file, platform, home);
  const full = file === '~' || file.startsWith('~/') || file.startsWith('~\\') ? paths.join(home, file.slice(1)) : file;
  const form = (text: string) => (platform === 'win32' ? text.replace(/\\/g, '/').toLowerCase() : text);
  const cut = Buffer.from(full).subarray(0, 100).toString().replace(/\ufffd+$/, '');
  return form(shown.replace(/\ufffd+$/, '')) === form(cut);
}

/// ssh's own words open with this line. A server's keyboard-interactive prompt opens with its "(user@host) " head, and it may hold
/// the same words further on: that must not show the sheet that says "Trust the host key".
const isHostKeyQuestion = (text: string) => text.startsWith('The authenticity of host ') && text.includes('Are you sure you want to continue connecting (yes/no');

/// ssh's prompts for this server. Only the profile's own kind of secret is a saved secret; another question for this
/// server can be typed; a prompt that names anything else is `other`, whatever it says.
export function classify(request: AskRequest, profile: ServerProfile, target: Target = profileTarget(profile)): Prompt {
  if (request.hint === 'confirm') return { kind: 'other' };
  const text = request.prompt.trim();
  if (isHostKeyQuestion(text)) return { kind: 'hostKey' };
  const who = named(text);
  if (who && who.user.toLowerCase() === target.user.toLowerCase() && target.hosts.some((h) => h.toLowerCase() === who.host.toLowerCase())) {
    if (who.question === null && expectedSecret(profile) === 'password') return { kind: 'secret', secret: 'password' };
    return { kind: 'typed' };
  }
  const key = passphraseKey(text);
  if (key !== null) {
    if (expectedSecret(profile) === 'passphrase' && profile.identityFile && keyNameMatches(key, profile.identityFile)) return { kind: 'secret', secret: 'passphrase' };
    // A key ssh tries by itself (its own defaults, the person's config): no saved answer, but the person may type it.
    if (target.keys.some((k) => keyNameMatches(key, k))) return { kind: 'typed' };
  }
  return { kind: 'other' };
}

/// A jump connection's prompt must name a ProxyJump host of the server's ssh or a saved server. The saved secret of the
/// one saved server it names answers it; else the person types it.
export function classifyJump(request: AskRequest, jumps: JumpHost[], profiles: ServerProfile[]): JumpPrompt {
  if (request.hint === 'confirm') return { kind: 'other' };
  const text = request.prompt.trim();
  if (isHostKeyQuestion(text)) return { kind: 'hostKey' };
  const who = named(text);
  if (who) {
    const user = who.user.toLowerCase();
    const host = who.host.toLowerCase();
    const saved = profiles.filter((p) => p.user.toLowerCase() === user && p.host.toLowerCase() === host);
    const listed = jumps.some((j) => j.host.toLowerCase() === host && (!j.user || j.user.toLowerCase() === user));
    if (!listed && !saved.length) return { kind: 'other' };
    if (who.question === null) {
      const withPassword = saved.filter((p) => expectedSecret(p) === 'password');
      if (withPassword.length === 1) return { kind: 'secret', secret: 'password', profile: withPassword[0] };
    }
    return { kind: 'typed' };
  }
  const key = passphraseKey(text);
  if (key !== null) {
    const saved = profiles.filter((p) => expectedSecret(p) === 'passphrase' && p.identityFile && keyNameMatches(key, p.identityFile));
    return saved.length === 1 ? { kind: 'secret', secret: 'passphrase', profile: saved[0] } : { kind: 'typed' };
  }
  return { kind: 'other' };
}

/// The saved servers a ticket may answer for beside its own: the jump server it was made with, and those its ssh lists as
/// ProxyJump. Any other saved server's secret stays shut, whatever a prompt names (security review M6).
export function ticketLogins(jump: ServerProfile | undefined, jumps: JumpHost[], profiles: ServerProfile[]): ServerProfile[] {
  const listed = profiles.filter((p) => jumps.some((j) => j.host.toLowerCase() === p.host.toLowerCase() && (!j.user || j.user.toLowerCase() === p.user.toLowerCase())));
  return jump && !listed.some((p) => p.name === jump.name) ? [...listed, jump] : listed;
}

/// An answer ssh can read: one line, not empty, no NUL. ssh reads 1023 bytes with the newline (readpass.c) and sends what it read as the password.
export const usableAnswer = (answer: string) => answer.length > 0 && !/[\r\n\0]/.test(answer) && Buffer.byteLength(answer) <= 1022;

/// The socket's reply, one frame: "OK\n", the answer and "\n", or "NO\n". An answer holds no line end (usableAnswer).
export const wireReply = (answer: string | null) => Buffer.from(answer === null ? 'NO\n' : `OK\n${answer}\n`);

export function parseSshVersion(text: string): [number, number] | null {
  const match = /OpenSSH\S*?_(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/// SSH_ASKPASS_REQUIRE came with OpenSSH 8.4, and so did the "(user@host)" prefix on server questions. An older ssh (Windows
/// 10's own is 8.1) reads passwords in the terminal, where the person types them; the app then sets nothing up.
export const supportsAskpass = (version: [number, number] | null) => !!version && (version[0] > 8 || (version[0] === 8 && version[1] >= 4));

const WINDOWS_HELPER = 'vibex-askpass.exe';

/// The native helper on Windows: in the resources of a package, in its build folder in a source run.
export const windowsHelperPath = (packaged: boolean, resourcesPath: string, appPath: string) =>
  (packaged ? path.win32.join(resourcesPath, WINDOWS_HELPER) : path.win32.join(appPath, 'native', 'askpass-win', 'build', WINDOWS_HELPER));

/// Whether the Windows ssh can start this path. A Cyrillic path fails: OpenSSH_for_Windows_9.5p2 on a CI runner says "CreateProcessW failed
/// error:2" (run 41420284135). By its source the likely reason is that getenv gives the value in the system's code page and
/// spawn_child_internal reads that as UTF-8; only the failure is measured. build_commandline_string (misc.c) ends the program name at the
/// first space after the first ".exe", in small letters.
export const sshCanStart = (file: string) => /^[\x20-\x7e]+$/.test(file) && !file.includes('"') && !/\.exe.* /.test(file);

/// What ssh needs to ask this app. A packaged app on Linux and macOS is one program ssh can run. A development run there is Electron
/// plus the app folder, and SSH_ASKPASS takes one program, so a small script adds the folder. On Windows it is always the native helper.
/// SHELL=/bin/sh: ssh runs a ProxyCommand through $SHELL, and /bin/sh reads no rc file.
export function askpassEnvironment(o: { platform: NodeJS.Platform; packaged: boolean; execPath: string; wrapper: string | null; helper?: string | null; socket: string; key: string }): Record<string, string> {
  if (o.platform === 'win32') {
    if (!o.helper) throw new Error('On Windows, password prompts need the askpass helper.');
    return { SSH_ASKPASS: o.helper, SSH_ASKPASS_REQUIRE: 'force', VIBEX_ASKPASS_SOCKET: o.socket, VIBEX_ASKPASS_KEY: o.key };
  }
  const program = o.packaged ? o.execPath : o.wrapper;
  if (!program) throw new Error('This run has no program for password prompts.');
  return {
    SSH_ASKPASS: program,
    SSH_ASKPASS_REQUIRE: 'force',
    VIBEX_ASKPASS_HELPER: '1',
    VIBEX_ASKPASS_SOCKET: o.socket,
    VIBEX_ASKPASS_KEY: o.key,
    SHELL: '/bin/sh',
  };
}

export interface Ticket {
  env: Record<string, string>;
  dispose: () => void;
}

interface TicketState {
  hash: Buffer;
  profile: ServerProfile;
  jump?: ServerProfile;
  /// Answers from saved secrets only; never a question to the person (a background listing).
  silent: boolean;
  target?: Promise<Target>;
  answered: Set<string>;
  typed: number;
  hostKeys: number;
  busy: boolean;
  /// The person pressed Cancel: ssh would ask 3 times more, and the sheet must not come back.
  cancelled: boolean;
  /// The ssh ended: its open question goes away.
  ended: AbortController;
  /// Told when a background ticket's saved secret was not confirmed, so its owner stops asking (the port listing).
  refused?: () => void;
}

const hashOf = (key: string) => createHash('sha256').update(key).digest();

function parseRequest(body: Buffer): AskRequest | null {
  if (body.length > MAX_BODY) return null;
  try {
    const o = JSON.parse(body.toString('utf8'));
    if (!o || typeof o !== 'object' || Object.keys(o).length !== 3) return null;
    if (typeof o.key !== 'string' || typeof o.hint !== 'string' || typeof o.prompt !== 'string') return null;
    if (o.key.length > 128 || o.hint.length > 32 || o.prompt.length > 4096) return null;
    return o;
  } catch {
    return null;
  }
}

function parseJumps(list: string): JumpHost[] {
  return list.split(',').flatMap((raw) => {
    let text = raw.trim().replace(/^ssh:\/\//i, '');
    let user: string | undefined;
    const at = text.lastIndexOf('@');
    if (at >= 0) {
      user = text.slice(0, at) || undefined;
      text = text.slice(at + 1);
    }
    if (text.startsWith('[') && text.includes(']')) text = text.slice(1, text.indexOf(']'));
    else if (text.split(':').length === 2) text = text.split(':')[0];
    return text ? [{ user, host: text }] : [];
  });
}

/// `ssh -G` prints one "keyword value" per line; ssh reads the person's and the system's config, as the real connection does.
export function parseConfig(output: string, profile: ServerProfile): Target {
  const target = profileTarget(profile);
  const hosts: string[] = [];
  for (const line of output.split('\n')) {
    const at = line.indexOf(' ');
    if (at < 0) continue;
    const key = line.slice(0, at).toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'user' && value) target.user = value;
    else if (key === 'hostname' && value) hosts.unshift(value);
    else if (key === 'hostkeyalias' && value && value.toLowerCase() !== 'none') hosts.push(value);
    else if (key === 'port' && Number(value) > 0) target.port = Number(value);
    else if (key === 'proxyjump' && value.toLowerCase() !== 'none') target.jumps = parseJumps(value);
    else if (key === 'identityfile' && value) target.keys.push(value);
  }
  if (hosts.length) target.hosts = hosts;
  return target;
}

function resolveTarget(profile: ServerProfile, jump?: ServerProfile): Promise<Target> {
  return new Promise((resolve) => {
    let args: string[];
    try {
      args = configArgs(profile, jump);
    } catch {
      return resolve(profileTarget(profile));
    }
    endsWithApp(execFile(sshProgram(), args, { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? profileTarget(profile) : parseConfig(String(stdout), profile));
    }));
  });
}

export interface AskpassDeps {
  secrets: SecretStore;
  questions: Questions;
  profiles: () => ServerProfile[];
  /// Why something failed, for a line in the window. Never holds a secret.
  notify: (title: string, message: string) => void;
  /// The person confirms before any saved secret is read (savedSecretGate.ts). The app always gives one (serverHub.ts). With
  /// none, a release build reads nothing saved; a dev build reads as before, for the older tests of this service.
  gate?: SavedSecretGate;
}

/// Why the sheet asks: this PC has no way to confirm the person (no Windows Hello, Linux, the helper failed).
export const UNCONFIRMED_NOTE = 'This PC cannot confirm it is you, so type it.';
const closedGate = new SavedSecretGate(noPresence);

/// Answers the helper's requests over one socket: a Unix socket in a 0700 folder, or a named pipe with a random name.
export class AskpassService {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private tickets = new Map<string, TicketState>();
  private open = 0;
  private wrapper: string | null = null;
  socketPath = '';
  /// Why tickets are empty: the person then types at ssh's own prompt in the tab. Shown in the Servers section.
  problem: string | null = null;
  private supported = false;
  private helperProgram: string | null = null;

  /// `helper` is for a test: another path of the Windows helper.
  constructor(private readonly deps: AskpassDeps, private readonly platform: { packaged: boolean; execPath: string; appPath: string; helper?: string }) {}

  async start(): Promise<void> {
    const version = await new Promise<[number, number] | null>((resolve) => {
      endsWithApp(execFile(sshProgram(), ['-V'], { timeout: 5_000, windowsHide: true }, (_error, stdout, stderr) => resolve(parseSshVersion(`${stdout}${stderr}`))));
    }).catch(() => null);
    if (!supportsAskpass(version)) {
      this.problem = version ? `This computer's ssh is OpenSSH ${version.join('.')}. It needs 8.4 or newer to use saved passwords; until then type them in the tab.` : 'ssh was not found on this computer.';
      return;
    }
    if (process.platform === 'win32') {
      try {
        this.helperProgram = await this.findWindowsHelper();
      } catch (error) {
        this.problem = `${String(error).replace(/^Error: /, '')} Type the password in the tab.`;
        return;
      }
    }
    try {
      this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vibex-askpass-${randomBytes(16).toString('hex')}` : this.prepareSocket();
      await new Promise<void>((resolve, reject) => {
        this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.serve(socket));
        this.server.once('error', reject);
        this.server.listen(this.socketPath, () => resolve());
      });
      if (process.platform !== 'win32') chmodSync(this.socketPath, 0o600);
      this.supported = true;
    } catch (error) {
      this.problem = `The app cannot answer ssh passwords: ${String(error).replace(/^Error: /, '')}. Type them in the tab.`;
    }
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    // Nothing answers after this. It was tried against the quit hang on Windows, and did not cure it (run 41438512187).
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.supported && process.platform !== 'win32') {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Gone already.
      }
    }
    if (this.wrapper) {
      try {
        unlinkSync(this.wrapper);
      } catch {
        // Gone already.
      }
    }
    this.tickets.clear();
  }

  /// The path to give ssh. With letters outside ASCII in it (a Cyrillic user name), the short form of the same file, which the helper
  /// reads for itself: Node has no call for it, and cmd.exe would parse the path.
  private async findWindowsHelper(): Promise<string> {
    const helper = this.platform.helper ?? windowsHelperPath(this.platform.packaged, process.resourcesPath, this.platform.appPath);
    if (!runnable(helper)) throw new Error('The askpass helper is missing from this install.');
    if (sshCanStart(helper)) return helper;
    const short = await new Promise<string>((resolve) => {
      endsWithApp(execFile(helper, [], { timeout: 5_000, windowsHide: true, env: { ...process.env, VIBEX_ASKPASS_SHORT_PATH: '1' } }, (error, stdout) => resolve(error ? '' : String(stdout))));
    });
    if (!sshCanStart(short)) throw new Error('ssh on Windows cannot start the askpass helper from this folder name, and this disk keeps no short name for it.');
    return short;
  }

  /// A folder only this user can open, checked for owner, mode and symlink, as in the fork (AskpassSocket.prepare).
  private prepareSocket(): string {
    const uid = process.getuid?.() ?? 0;
    const folder = path.join(os.tmpdir(), `vpca-${uid}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const info = lstatSync(folder);
    if (!info.isDirectory()) throw new Error('the askpass folder is not a folder');
    if (info.uid !== uid) throw new Error('the askpass folder belongs to another user');
    if (info.mode & 0o077) chmodSync(folder, 0o700);
    const socket = path.join(folder, `a-${process.pid}.sock`);
    try {
      unlinkSync(socket);
    } catch {
      // No old one.
    }
    if (!this.platform.packaged) {
      const quote = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;
      this.wrapper = path.join(folder, `askpass-${process.pid}.sh`);
      writeFileSync(this.wrapper, `#!/bin/sh\nexec ${quote(this.platform.execPath)} ${quote(this.platform.appPath)} "$@"\n`, { mode: 0o700 });
    }
    return socket;
  }

  /// A new ticket for one ssh: its environment, and the end of its life.
  /// `refused`: a silent ticket's saved secret was not confirmed (refused, no answer in time, or this PC cannot confirm).
  ticket(profile: ServerProfile, jump?: ServerProfile, silent = false, refused?: () => void): Ticket {
    if (!this.supported) return { env: {}, dispose: () => undefined };
    const key = randomBytes(32).toString('hex');
    const id = randomBytes(8).toString('hex');
    this.tickets.set(id, { hash: hashOf(key), profile, jump, silent, answered: new Set(), typed: 0, hostKeys: 0, busy: false, cancelled: false, ended: new AbortController(), refused });
    const env = askpassEnvironment({ platform: process.platform, packaged: this.platform.packaged, execPath: this.platform.execPath, wrapper: this.wrapper, helper: this.helperProgram, socket: this.socketPath, key });
    return {
      env,
      dispose: () => {
        this.tickets.get(id)?.ended.abort();
        this.tickets.delete(id);
      },
    };
  }

  private serve(socket: net.Socket): void {
    if (this.open >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.open++;
    this.sockets.add(socket);
    socket.once('close', () => { this.open--; this.sockets.delete(socket); });
    socket.on('error', () => socket.destroy());
    const chunks: Buffer[] = [];
    let total = 0;
    let framed = false;
    const reply = (answer: string | null) => {
      const data = wireReply(answer);
      socket.end(data, () => data.fill(0));
    };
    const deadline = setTimeout(() => {
      framed = true;
      reply(null);
    }, REQUEST_DEADLINE_MS);
    const refuse = () => {
      framed = true;
      clearTimeout(deadline);
      reply(null);
    };
    // A request is one line. The helper keeps its side open for the reply: on a Windows named pipe a half-close would
    // close both ends, so nothing here may wait for `end`.
    socket.on('data', (chunk: Buffer) => {
      if (framed) return;
      total += chunk.length;
      if (total > MAX_BODY) return refuse();
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const line = body.indexOf(10);
      if (line < 0) return;
      framed = true;
      clearTimeout(deadline);
      const request = parseRequest(body.subarray(0, line));
      if (!request) return reply(null);
      void this.handle(request).then(reply, () => reply(null));
    });
    socket.on('end', () => {
      if (!framed) refuse();
    });
  }

  private find(key: string): TicketState | null {
    const given = hashOf(key);
    for (const t of this.tickets.values()) if (timingSafeEqual(given, t.hash)) return t;
    return null;
  }

  /// One ticket stands for one ssh and its jump connections, so requests of a ticket come one at a time.
  private async handle(request: AskRequest): Promise<string | null> {
    const t = this.find(request.key);
    if (!t || t.busy) return null;
    t.busy = true;
    try {
      t.target ??= resolveTarget(t.profile, t.jump);
      return await this.decide(request, t, await t.target);
    } finally {
      t.busy = false;
    }
  }

  private async decide(request: AskRequest, t: TicketState, target: Target): Promise<string | null> {
    const own = classify(request, t.profile, target);
    const prompt = own.kind === 'other' ? classifyJump(request, target.jumps, ticketLogins(t.jump, target.jumps, this.deps.profiles())) : own;
    if (prompt.kind === 'other') {
      this.deps.notify(`${t.profile.name}: the app did not answer ssh`, `ssh asked: ${shown(request.prompt, 120)}. The app answers only prompts that name ${t.profile.user}@${t.profile.host}, its jump hosts or a saved server.`);
      return null;
    }
    if (t.silent || t.cancelled) {
      if (prompt.kind !== 'secret' || t.cancelled) return null;
      const profile: ServerProfile = (prompt as { profile?: ServerProfile }).profile ?? t.profile;
      const label = `${profile.name}|${prompt.secret}`;
      if (t.answered.has(label)) return null;
      t.answered.add(label);
      // Nothing saved: no prompt, nothing to give.
      if (!this.saved(profile, prompt.secret)) return null;
      // No question to the person here, so anything but a yes is a refusal.
      const presence = await this.presence(profile, prompt.secret, t);
      if (t.ended.signal.aborted) return null;
      if (presence !== 'ok') {
        t.refused?.();
        return null;
      }
      const value = this.deps.secrets.get(profile, prompt.secret);
      return value !== null && usableAnswer(value) ? value : null;
    }
    if (prompt.kind === 'hostKey') return this.hostKey(request, t);
    if (prompt.kind === 'typed') return this.typed(request, t, t.profile, null, 'ssh asks a question that has no saved answer.');
    const profile: ServerProfile = (prompt as { profile?: ServerProfile }).profile ?? t.profile;
    const label = `${profile.name}|${prompt.secret}`;
    const title = prompt.secret === 'password' ? 'password' : 'key passphrase';
    if (t.answered.has(label)) return this.typed(request, t, profile, prompt.secret, `ssh asks again: the ${title} of ${profile.name} was not accepted (wrong, or changed on the server).`);
    t.answered.add(label);
    // Nothing saved: the person types it, with no prompt first. The check decrypts nothing (serverSecrets.ts).
    if (!this.saved(profile, prompt.secret)) return this.typed(request, t, profile, prompt.secret, `No ${title} is saved for ${profile.name}.`);
    // Classify, then the gate, then the read: nothing saved is read before the person confirms this one request.
    const presence = await this.presence(profile, prompt.secret, t);
    if (t.ended.signal.aborted) return null;
    if (presence === 'unavailable') return this.typed(request, t, profile, prompt.secret, UNCONFIRMED_NOTE);
    if (presence !== 'ok') {
      // A refusal, or no answer in time: this ssh gets nothing more, and no sheet. The next connection asks again.
      t.cancelled = true;
      this.deps.notify(`${profile.name}: not confirmed`, `The saved ${title} was not used.`);
      return null;
    }
    const value = this.deps.secrets.get(profile, prompt.secret);
    if (value !== null) {
      if (usableAnswer(value)) return value;
      this.deps.notify(`The saved ${title} of ${profile.name} cannot be used`, 'It is empty, longer than ssh reads, or holds a line break.');
      return null;
    }
    return this.typed(request, t, profile, prompt.secret, `No ${title} is saved for ${profile.name}.`, true);
  }

  private gate(): SavedSecretGate | null {
    return this.deps.gate ?? (buildKind === 'release' ? closedGate : null);
  }

  /// Whether something is saved, before any prompt. With no gate (a dev build's older tests) the read itself tells.
  private saved(profile: ServerProfile, secret: SecretKind): boolean {
    return this.gate() ? this.deps.secrets.has(profile, secret) : true;
  }

  /// One prompt for this request only. The ssh's end aborts it.
  private presence(profile: ServerProfile, secret: SecretKind, t: TicketState): Promise<Presence> {
    const gate = this.gate();
    if (!gate) return Promise.resolve('ok');
    return gate.confirm(presenceReason(profile, secret), t.ended.signal);
  }

  private async hostKey(request: AskRequest, t: TicketState): Promise<string> {
    // One server and one jump connection at most: a server cannot keep asking.
    if (t.hostKeys >= 2) return 'no';
    t.hostKeys++;
    const reason = unsafeCharacters(request.prompt, "ssh's question");
    if (reason) {
      this.deps.notify(`${t.profile.name}: host key refused`, reason);
      return 'no';
    }
    // The PCA server's key ships with the app, so no person has to compare it. A connection to it uses the pinned file and
    // never asks; this is the case of the PCA server as a jump server.
    const pinned = hostKeyVerdict(request.prompt);
    if (pinned === 'match') return 'yes';
    if (pinned === 'changed') {
      this.deps.notify('Host key refused', hostKeyFailureText('The PCA server', 'host key verification failed')!);
      return 'no';
    }
    const answer = await this.deps.questions.ask({
      kind: 'hold',
      title: `Trust the host key of ${t.profile.name}?`,
      info: `ssh connects to ${t.profile.name} and does not know this host key. Compare the fingerprint with the one the server's owner gave you. Accept adds it to known_hosts. With no answer in 2 minutes it is rejected.`,
      textLabel: "ssh's question",
      text: request.prompt.trim(),
      holdTitle: 'Hold to accept',
      refuseTitle: 'Reject',
      verb: 'Accept',
    }, { signal: t.ended.signal });
    return 'run' in answer ? 'yes' : 'no';
  }

  /// The person types the answer in a sheet. It goes to this request only, and is saved only when asked for and when it
  /// is the server's own kind of secret.
  /// `confirmed`: the person confirmed this request at the gate, so the sheet may take a secret saved meanwhile.
  private async typed(request: AskRequest, t: TicketState, profile: ServerProfile, secret: SecretKind | null, note: string, confirmed = false): Promise<string | null> {
    if (t.typed >= MAX_TYPED) {
      this.deps.notify(`${profile.name}: ssh asked too many questions`, 'The app stopped answering this connection. Connect again.');
      return null;
    }
    t.typed++;
    // ssh asking again means the saved one was wrong, so only a first ask may take one saved meanwhile, and only after the
    // gate said yes for this request: the pre-fill is a read of the saved secret too.
    const firstAsk = note.startsWith('No ') && confirmed;
    const available = this.deps.secrets.available();
    const answer: Answer = await this.deps.questions.ask({
      kind: 'typed',
      title: `ssh asks for ${profile.name}`,
      note,
      prompt: shown(request.prompt),
      savable: !!secret && available,
      saveUnavailable: secret && !available ? 'This computer has no system store that encrypts, so the app cannot save this.' : undefined,
    }, {
      // Another tab of the same project may have saved it while this one waited.
      beforeShow: () => {
        const now = secret && firstAsk ? this.deps.secrets.get(profile, secret) : null;
        return now !== null && usableAnswer(now) ? { typed: now, save: false } : null;
      },
      signal: t.ended.signal,
    });
    if (!('typed' in answer)) {
      t.cancelled = true;
      return null;
    }
    if (!usableAnswer(answer.typed)) return null;
    if (answer.save && secret) {
      try {
        this.deps.secrets.set(profile, secret, answer.typed);
      } catch (error) {
        this.deps.notify(`Could not save the secret of ${profile.name}`, String(error).replace(/^Error: /, ''));
      }
    }
    return answer.typed;
  }
}
