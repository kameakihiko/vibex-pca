import { execFile, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseChatLine, type ChatEvent } from './chatEvents';
import { signalProgram, type ChatProcess, type ChatSessionSummary } from './chatProcess';
import { isTrustedIn } from './chatTrust';
import { endsWithApp } from './programs';
import type { ProjectInfo } from './projects';
import { chatProbeScript } from './servers';
import type { Launch } from './terminals';

// The native chat of a project on a server: the same `claude -p` stream as a local chat, through one ssh login with no
// terminal. servers.ts writes the scripts; serverHub.ts gives the logins (profile, askpass ticket, token, tunnel port).
// This file runs them. No Electron here, so the tests run it with a made-up ssh.

/// A quiet login of a server project: the profile's ssh options, the askpass ticket (and with it the presence gate), no
/// terminal, no tunnel. `args(script)` closes ssh's input (-n) unless `input` is set.
export interface ChatLogin {
  file: string;
  args: (script: string, o?: { input?: boolean }) => string[];
  env: Record<string, string>;
  folder: string;
  /// Ends the askpass ticket. Call it once, when the ssh ended.
  dispose: () => void;
}

/// One ssh of a chat.
export interface ChatSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
  dispose: () => void;
  /// The server port of its tunnel to the app's tools, or null for a chat with no tools.
  tunnel: number | null;
}

/// What a chat tab asks of the server hub.
export interface ServerChatHost {
  login(project: { id: string; path: string; server?: string }): ChatLogin;
  /// The ssh of `attempt` (0, 1, ...): each attempt its own tunnel port; `attempt` at or past `attempts()`, or null, gives one with no tunnel.
  spawn(project: { id: string; path: string; server?: string }, chatKey: string, chatId: string, claudeArgs: string[], attempt: number | null): ChatSpawn;
  attempts(project: { id: string }, chatKey: string): number;
  /// Ends that chat's Claude on the server, by a login of its own that never asks (BatchMode). Fire and forget.
  stop(project: { id: string; path: string; server?: string }, chatId: string): void;
  /// The project's Claude terminal tab on the server: the fallback, and where /login and the trust question work.
  terminal(project: ProjectInfo): Launch;
}

// ------------------------------------------------------------------ what ssh says on its standard error

/// ssh's debug line when the server accepted the tunnel (OpenSSH ssh.c ssh_confirm_remote_forward, debug1).
const FORWARD_OK = /remote forward success for: listen (?:[^\s,]*:)?(\d+)\b/i;
/// ssh's last line when it did not (ExitOnForwardFailure); the Claude tab reads the same words (serverHub.ts).
const FORWARD_FAILED = /remote port forwarding failed for listen port (\d+)/i;
/// ssh sent the command: the answer about the tunnel is on its way.
const SENT_COMMAND = /\bSending command:/i;
/// ssh's own words with -v, which are not the server's and not for the person.
const NOISE = /^(debug\d: |OpenSSH_|Authenticated to |Transferred: |Bytes per second|Connection to \S+ closed)/;
const STDERR_KEPT = 4000;
const MAX_LINE = 64 * 1024 * 1024;
const END_GRACE_MS = 1500;
/// How long the input waits for ssh's word on the tunnel after it sent the command. An ssh that never says it is older
/// than any this app supports; the input goes then, and a tunnel that failed still ends ssh.
const READY_FALLBACK_MS = 5000;

/// What a failed login means, in plain words, with ssh's own last line when nothing else fits.
export function plainLoginFailure(stderr: string, server: string): string {
  const own = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  const vibex = own.find((l) => l.startsWith('Vibex: '));
  if (vibex) return vibex.slice('Vibex: '.length);
  const text = own.join('\n');
  if (/host key verification failed|remote host identification has changed/i.test(text)) return `${server} showed a host key this computer does not know. Open the Servers section, press Connect ${server} once and answer ssh there. Then send the message again.`;
  if (/permission denied/i.test(text)) return `${server} refused the login. The chat uses only a key with no passphrase, or a password or passphrase saved in the server's form. Save it there, or use the Claude terminal tab, which asks for it. Then send the message again.`;
  if (/could not resolve|timed out|connection refused|network is unreachable|no route to host|connection reset|broken pipe/i.test(text)) return `Could not reach ${server}. Check the internet connection, then send the message again.`;
  return own.at(-1) ?? `The connection to ${server} ended.`;
}

// ------------------------------------------------------------------ the chat's Claude on the server

export interface RemoteChatOptions {
  spawn: (attempt: number) => ChatSpawn;
  /// How many tunnel ports to try; after them, one login with no tunnel.
  attempts: number;
  stopRemote: () => void;
  server: string;
  on: { line: (line: string) => void; ended: (stderr: string, spawnError: string | null) => void; notice?: (text: string) => void };
  readyFallbackMs?: number;
}

/// Claude on the server as a ChatProcess. With a tunnel, what the chat writes waits until ssh says the tunnel is up, so a
/// busy port never reaches Claude with a message: the login starts again on the next port with the same lines, and the
/// Claude of the failed login, which got nothing, ends with its session. End: the input closes (Claude ends by itself),
/// then the local ssh ends, and a stop login ends what is left on the server.
export function startRemoteClaude(o: RemoteChatOptions): ChatProcess {
  let attempt = 0;
  let child: ChildProcess | null = null;
  let ready = false;
  let queue: string[] = [];
  let kept = '';
  let ending = false;
  let finished = false;
  /// An ssh was started: the stop login has something to look for. It never asks, so a stop with nothing to stop costs nothing.
  let started = false;
  let spawnError: string | null = null;
  let lastCode: number | null = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    const said = kept.trim();
    o.on.ended(lastCode === 255 || spawnError ? plainLoginFailure(said, o.server) : said, spawnError);
  };

  const begin = () => {
    const spec = o.spawn(attempt);
    let retry = false;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let errHeld = '';
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      spec.dispose();
    };
    ready = false;
    let proc: ChildProcess;
    try {
      proc = spawn(spec.file, spec.args, { cwd: os.homedir(), env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    } catch (error) {
      dispose();
      spawnError = /ENOENT/.test(String(error)) ? 'ssh was not found on this computer.' : String(error).replace(/^Error: /, '');
      finish();
      return;
    }
    child = proc;
    started = true;
    const flush = () => {
      if (ready || proc !== child) return;
      ready = true;
      if (fallback) clearTimeout(fallback);
      for (const line of queue) proc.stdin!.write(`${line}\n`);
      queue = [];
    };
    // With no tunnel there is nothing to wait for: the lines held from a failed login go now.
    if (spec.tunnel === null) flush();
    const decoder = new StringDecoder('utf8');
    let held = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (proc !== child) return;
      held += decoder.write(chunk);
      let at = held.indexOf('\n');
      while (at >= 0) {
        const line = held.slice(0, at);
        held = held.slice(at + 1);
        if (line.trim()) o.on.line(line);
        at = held.indexOf('\n');
      }
      if (held.length > MAX_LINE) held = '';
    });
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      errHeld += chunk;
      const lines = errHeld.split('\n');
      errHeld = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const ok = FORWARD_OK.exec(line);
        if (ok && Number(ok[1]) === spec.tunnel) flush();
        else if (FORWARD_FAILED.test(line)) retry = true;
        else if (SENT_COMMAND.test(line)) {
          if (!ready && !fallback) {
            fallback = setTimeout(flush, o.readyFallbackMs ?? READY_FALLBACK_MS);
            fallback.unref?.();
          }
        }
        if (!NOISE.test(line)) kept = `${kept}${line}\n`.slice(-STDERR_KEPT);
      }
    });
    proc.stdin!.on('error', () => undefined);
    proc.stdout!.on('error', () => undefined);
    proc.stderr!.on('error', () => undefined);
    proc.on('error', (error) => {
      if (proc !== child) return;
      spawnError = /ENOENT/.test(error.message) ? 'ssh was not found on this computer.' : error.message;
      dispose();
      finish();
    });
    proc.on('close', (code) => {
      if (fallback) clearTimeout(fallback);
      dispose();
      if (proc !== child) return;
      lastCode = code;
      if (errHeld && !NOISE.test(errHeld)) kept = `${kept}${errHeld}\n`.slice(-STDERR_KEPT);
      if (retry && !ending && !ready && attempt < o.attempts) {
        attempt++;
        kept = '';
        if (attempt >= o.attempts) o.on.notice?.(`${o.server} has no free tunnel port for this chat, so it runs with no Vibex tools: no command terminal and no browser from here.`);
        begin();
        return;
      }
      finish();
    });
  };

  begin();
  return {
    get pid() { return child?.pid ?? 0; },
    write: (line) => {
      if (finished || ending || !child) return;
      if (!ready) queue.push(line);
      else if (child.stdin!.writable) child.stdin!.write(`${line}\n`);
    },
    end: () => {
      if (ending) return;
      ending = true;
      queue = [];
      const proc = child;
      if (started) o.stopRemote();
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      // At once, not after a wait: at a quit the app may not live for a timer. The end of the session is what the guard
      // on the server waits for, and the stop login above does not need it.
      try { proc.stdin!.end(); } catch { /* closed already */ }
      signalProgram(proc, 'SIGTERM');
      const kill = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) signalProgram(proc, 'SIGKILL');
      }, END_GRACE_MS);
      kill.unref?.();
    },
  };
}

// ------------------------------------------------------------------ the folder on the server

export interface ServerFolderInfo {
  real: string;
  trusted: boolean;
  sessions: ChatSessionSummary[];
}

function runLogin(login: ChatLogin, script: string, limitMs: number, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let args: string[];
    try {
      args = login.args(script);
    } catch (error) {
      login.dispose();
      reject(error);
      return;
    }
    endsWithApp(execFile(login.file, args, { encoding: 'buffer', timeout: limitMs, windowsHide: true, maxBuffer, env: login.env }, (error, stdout, stderr) => {
      login.dispose();
      if (error) {
        const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        reject(new Error((error as { killed?: boolean }).killed ? `The server did not answer in ${Math.round(limitMs / 1000)} seconds.` : plainLoginFailure(text, 'The server')));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)));
    }));
  });
}

/// The reply of the probe: one JSON line. Each field is checked, as text from a server.
export function parseProbe(text: string): ServerFolderInfo | null {
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.real !== 'string' || !o.real.startsWith('/')) return null;
  const gits = new Set(Array.isArray(o.gits) ? o.gits.filter((g: unknown): g is string => typeof g === 'string') : []);
  const projects: Record<string, { hasTrustDialogAccepted: true }> = {};
  if (o.projects && typeof o.projects === 'object') {
    for (const [key, value] of Object.entries(o.projects)) {
      if ((value as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true) projects[key] = { hasTrustDialogAccepted: true };
    }
  }
  const trusted = isTrustedIn(o.real, JSON.stringify({ projects }), { paths: path.posix, exists: (file) => gits.has(path.posix.dirname(file)) });
  const sessions: ChatSessionSummary[] = (Array.isArray(o.sessions) ? o.sessions : []).flatMap((s: any) => {
    if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s.id) || typeof s.title !== 'string' || !Number.isFinite(s.date)) return [];
    // eslint-disable-next-line no-control-regex
    const title = s.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 70);
    return title && !title.startsWith('/') ? [{ id: s.id, title, date: Number(s.date) }] : [];
  }).slice(0, 12);
  return { real: o.real, trusted, sessions };
}

const PROBE_LIMIT_MS = 60_000;
const TRANSCRIPT_LIMIT_MS = 120_000;
const TRANSCRIPT_MAX = 34 * 1024 * 1024;

/// The trust answer and the newest conversations of the folder on the server, in one short login.
export async function probeServerFolder(login: ChatLogin): Promise<ServerFolderInfo> {
  const out = await runLogin(login, chatProbeScript(login.folder), PROBE_LIMIT_MS, 1024 * 1024);
  const info = parseProbe(out.toString('utf8'));
  if (!info) throw new Error('The server gave no answer about this folder.');
  return info;
}

/// One conversation's transcript from the server, for its history in the chat.
export async function loadServerTranscript(login: ChatLogin, session: string): Promise<ChatEvent[]> {
  try {
    const out = await runLogin(login, chatProbeScript(login.folder, session), TRANSCRIPT_LIMIT_MS, TRANSCRIPT_MAX);
    return out.toString('utf8').split('\n').flatMap(parseChatLine);
  } catch {
    return [];
  }
}
