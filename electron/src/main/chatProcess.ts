import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { commandsOf, controlLine, modelsOf, parseChatLine, transcriptFile, type ChatCommand, type ChatEvent, type ChatModelOption } from './chatEvents';
import { endsWithApp } from './programs';
import { endWindowsTree } from './terminals';

// The `claude` program of one chat tab: the system program by its full path, an argument list and three pipes. No shell and
// no PowerShell, on any system. macOS Vibex runs it through a login shell for its PATH; here the PATH is in the environment.

const END_GRACE_MS = 1500;
/// A line longer than this is no line of the stream format; it is dropped and the turn goes on.
const MAX_LINE = 64 * 1024 * 1024;
const STDERR_KEPT = 4000;

export interface ChatProcess {
  pid: number;
  write: (line: string) => void;
  /// Ends the program: asks first, then insists.
  end: () => void;
}

/// Claude runs commands of its own; they end with it. Its own process group on Mac and Linux, taskkill's tree on Windows.
const programOptions = () => ({ windowsHide: true, shell: false, detached: process.platform !== 'win32' });

export function signalProgram(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    endWindowsTree(child.pid ?? 0, () => { child.kill(); });
    return;
  }
  try {
    process.kill(-(child.pid ?? 0), signal);
  } catch {
    child.kill(signal);
  }
}

export function startClaude(file: string, args: string[], cwd: string, env: Record<string, string>, on: { line: (line: string) => void; ended: (stderr: string, spawnError: string | null) => void }): ChatProcess {
  const child: ChildProcess = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...programOptions() });
  const decoder = new StringDecoder('utf8');
  let held = '';
  let stderr = '';
  let spawnError: string | null = null;
  let done = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    held += decoder.write(chunk);
    let at = held.indexOf('\n');
    while (at >= 0) {
      const line = held.slice(0, at);
      held = held.slice(at + 1);
      if (line.trim()) on.line(line);
      at = held.indexOf('\n');
    }
    if (held.length > MAX_LINE) held = '';
  });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT);
  });
  // A pipe the program closed: a write there must not become a fault of the app.
  child.stdin!.on('error', () => undefined);
  child.stdout!.on('error', () => undefined);
  child.stderr!.on('error', () => undefined);
  const finish = () => {
    if (done) return;
    done = true;
    on.ended(stderr.trim(), spawnError);
  };
  child.on('error', (error) => {
    spawnError = error.message;
    finish();
  });
  child.on('close', finish);
  return {
    get pid() { return child.pid ?? 0; },
    write: (line) => {
      if (child.stdin!.writable) child.stdin!.write(`${line}\n`);
    },
    end: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalProgram(child, 'SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalProgram(child, 'SIGKILL');
      }, END_GRACE_MS);
      timer.unref();
    },
  };
}

// ------------------------------------------------------------------ what Claude Code offers

export interface ChatCapabilities { commands: ChatCommand[]; models: ChatModelOption[] }

const CATALOG_LIMIT_MS = 30_000;

/// Asks Claude Code what it offers in a folder, from its `initialize` reply, so the commands and models are there before the
/// first message. Nothing is sent to a model and no session is saved. Null when it does not answer.
export function askCapabilities(file: string, args: string[], cwd: string, env: Record<string, string>): Promise<ChatCapabilities | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: ChatCapabilities | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      signalProgram(child, 'SIGTERM');
    };
    const child = endsWithApp(spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], ...programOptions() }));
    timer = setTimeout(() => settle(null), CATALOG_LIMIT_MS);
    timer.unref();
    const decoder = new StringDecoder('utf8');
    let held = '';
    child.stdin!.on('error', () => undefined);
    child.on('error', () => settle(null));
    child.on('close', () => settle(null));
    child.stdout!.on('data', (chunk: Buffer) => {
      held += decoder.write(chunk);
      const lines = held.split('\n');
      held = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const object = JSON.parse(line);
          const reply = object?.type === 'control_response' ? object.response?.response : null;
          if (reply) return settle({ commands: commandsOf(reply.commands), models: modelsOf(reply.models) });
        } catch { /* some other line */ }
      }
    });
    child.stdin!.write(`${controlLine('initialize')}\n`);
  });
}

// ------------------------------------------------------------------ transcripts

export interface ChatSessionSummary { id: string; title: string; date: number }

const HEAD_BYTES = 256_000;

/// The first thing the person typed. Only the top of the file is read: transcripts get large.
async function titleOf(file: string): Promise<string | null> {
  let head: string;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  for (const line of head.split('\n')) {
    for (const event of parseChatLine(line)) {
      if (event.type === 'userText' && !event.text.startsWith('/')) return event.text.slice(0, 70).replace(/\n/g, ' ');
    }
  }
  return null;
}

/// Earlier conversations here, newest first, titled by what was asked first.
export async function recentSessions(folder: string, configDir: string, limit = 12): Promise<ChatSessionSummary[]> {
  // Claude Code names the folder by its real path, which a link does not show.
  const real = await fs.realpath(folder).catch(() => folder);
  const directory = path.dirname(transcriptFile('x', real, configDir));
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const dated = await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
    const file = path.join(directory, n);
    const stat = await fs.stat(file).catch(() => null);
    return stat ? { file, id: n.slice(0, -'.jsonl'.length), date: stat.mtimeMs } : null;
  }));
  const newest = dated.filter((d) => d !== null).sort((a, b) => b.date - a.date).slice(0, limit * 2);
  const out: ChatSessionSummary[] = [];
  for (const entry of newest) {
    const title = await titleOf(entry.file).catch(() => null);
    if (title) out.push({ id: entry.id, title, date: entry.date });
    if (out.length === limit) break;
  }
  return out;
}

export async function loadTranscript(session: string, folder: string, configDir: string): Promise<ChatEvent[]> {
  const real = await fs.realpath(folder).catch(() => folder);
  const text = await fs.readFile(transcriptFile(session, real, configDir), 'utf8').catch(() => '');
  return text.split('\n').flatMap(parseChatLine);
}
