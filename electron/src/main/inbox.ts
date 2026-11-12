import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserWindow, Notification } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ModuleHost, ToolContext } from './modules';
import { testEnv } from './testSwitches';

// The approval inbox (macOS Vibex: Inbox/ClaudeHooks.swift, Inbox/AttentionCenter.swift): Claude Code hooks tell the app
// when a Claude session is waiting for the person (a permission request or a question) and when it moves on. The
// hooks live in Claude's settings.json next to the person's own, run asynchronously, and do nothing outside this
// app: the command needs VIBEXPCA_HOOK_URL, which only this app's terminals have.
// The names differ from the Mac app's (VIBEX_HOOK_URL), so both can be installed on one computer without one
// removing the other's hooks. The hook key is its own random key, not the MCP key.

/// Every hook command of this app contains this; it is how they are found again to update or remove.
export const HOOK_MARKER = 'VIBEXPCA_HOOK_URL';

export const HOOK_EVENTS: { name: string; matcher?: string }[] = [
  { name: 'PermissionRequest', matcher: '*' },
  { name: 'Notification' },
  { name: 'UserPromptSubmit' },
  { name: 'PostToolUse', matcher: '*' },
  { name: 'Stop' },
  { name: 'SessionEnd' },
];

/// Posts the hook's JSON (stdin) to the app with the project it came from. Always exits 0. Claude Code runs hook
/// commands with sh (Git Bash on Windows), and curl ships with Windows 10 and Git for Windows.
export const HOOK_COMMAND = `[ -n "$${HOOK_MARKER}" ] && curl -fsS -m 2 -X POST -H "Authorization: Bearer $VIBEXPCA_HOOK_TOKEN" -H "Content-Type: application/json" -H "X-Vibex-Window: $VIBEX_WINDOW" --data-binary @- "$${HOOK_MARKER}" >/dev/null 2>&1; exit 0`;

type Settings = Record<string, any>;

const isOurs = (entry: any): boolean => Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));

export function isInstalled(settings: Settings): boolean {
  const hooks = settings.hooks ?? {};
  return HOOK_EVENTS.every((e) => (Array.isArray(hooks[e.name]) ? hooks[e.name] : []).some((entry: any) => isOurs(entry) && entry.hooks?.[0]?.command === HOOK_COMMAND));
}

/// `settings` without our hooks; events left with no hooks are dropped.
export function removedFrom(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks: Settings = {};
  for (const [name, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) {
      hooks[name] = entries;
      continue;
    }
    const kept = entries.filter((entry) => !isOurs(entry));
    if (kept.length) hooks[name] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/// `settings` with our hooks added (or refreshed), leaving every other hook as it was.
export function installedInto(settings: Settings): Settings {
  const clean = removedFrom(settings);
  const hooks: Settings = { ...(clean.hooks ?? {}) };
  for (const e of HOOK_EVENTS) {
    const entry: Settings = { hooks: [{ type: 'command', command: HOOK_COMMAND, async: true }] };
    if (e.matcher) entry.matcher = e.matcher;
    hooks[e.name] = [...(Array.isArray(hooks[e.name]) ? hooks[e.name] : []), entry];
  }
  return { ...clean, hooks };
}

// ------------------------------------------------------------------ events

export interface HookEvent { name: string; message?: string; tool?: string; detail?: string; session: string; cwd: string }

export function parseHookEvent(body: string): HookEvent | null {
  let object: any;
  try {
    object = JSON.parse(body);
  } catch {
    return null;
  }
  if (!object || typeof object.hook_event_name !== 'string' || !HOOK_EVENTS.some((e) => e.name === object.hook_event_name)) return null;
  const input = object.tool_input && typeof object.tool_input === 'object' ? object.tool_input : {};
  const detail = [input.command, input.file_path, input.url, input.pattern].find((v) => typeof v === 'string');
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { name: object.hook_event_name, message: str(object.message), tool: str(object.tool_name), detail, session: str(object.session_id) ?? '', cwd: str(object.cwd) ?? '' };
}

const oneLine = (text: string, limit: number) => {
  const line = text.split(/\r?\n/)[0];
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/// "mcp__vibex__simulator_tap" gives "simulator_tap"
const friendlyTool = (name: string) => (name.startsWith('mcp__') ? name.split('__').pop() || name : name);

/// The line shown in the inbox for a waiting event, or null for events that end the wait.
export function waitingOf(event: HookEvent): { kind: 'permission' | 'question'; message: string } | null {
  if (event.name === 'PermissionRequest') {
    const tool = event.tool ? friendlyTool(event.tool) : 'a tool';
    return { kind: 'permission', message: `Allow ${tool}${event.detail ? `: ${oneLine(event.detail, 80)}` : ''}?` };
  }
  if (event.name === 'Notification') return { kind: 'question', message: oneLine(event.message ?? 'Claude is waiting for you', 110) };
  return null;
}

// ------------------------------------------------------------------ the settings file

export const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

/// The settings to change: empty only when there is no file. A file that does not parse throws, so a write never
/// replaces the person's settings with our hooks alone.
function readForWrite(file: string): Settings {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings.json is not an object');
  return parsed;
}

/// The first time it touches the file, the original is kept next to it as settings.json.vibex-backup.
function writeSettings(file: string, settings: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.vibex-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  // The new file keeps the mode the person gave the old one; a first file is private.
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  if (process.platform !== 'win32') chmodSync(temporary, mode);
  renameSync(temporary, file);
}

export type HooksStatus = 'installed' | 'missing' | 'unreadable';

export function hooksStatus(file = settingsFile()): HooksStatus {
  try {
    return isInstalled(readForWrite(file)) ? 'installed' : 'missing';
  } catch {
    return 'unreadable';
  }
}

export const installHooks = (file = settingsFile()) => writeSettings(file, installedInto(readForWrite(file)));
export const uninstallHooks = (file = settingsFile()) => writeSettings(file, removedFrom(readForWrite(file)));

// ------------------------------------------------------------------ the service

export interface Waiting { id: string; projectId: string; project: string; session: string; cwd: string; kind: 'permission' | 'question'; message: string; since: number }
export interface Report { id: string; projectId: string; project: string; title: string; message: string | null; at: number }

const MAX_BODY = 4 * 1024 * 1024;
const MAX_REPORTS = 100;

export class InboxService {
  private host!: ModuleHost;
  private waiting = new Map<string, Waiting>();
  private reports: Report[] = [];
  private server: http.Server | null = null;
  private removedMarker = '';
  private problem: string | null = null;

  start(host: ModuleHost): void {
    this.host = host;
    this.removedMarker = path.join(host.userData, 'hooks-removed');
    host.handle('mod:inbox:state', () => this.snapshot());
    host.handle('mod:inbox:hooks', (want: boolean) => this.setHooks(!!want));
    host.handle('mod:inbox:clear', (id?: string) => {
      this.reports = id ? this.reports.filter((r) => r.id !== String(id)) : [];
      this.changed();
    });
    // A wait is known per session, not per tab: when its Claude tab closes and another one stays, only a person can end it.
    host.handle('mod:inbox:dismiss', (id: string) => {
      if (this.waiting.delete(String(id))) this.changed();
    });
    host.handle('mod:inbox:show', (projectId: string) => {
      const project = host.projects.get(String(projectId));
      if (project) host.reveal(project, 'agent');
    });
    host.terminals.on('exit', () => this.prune());
    host.terminals.on('closed', () => this.prune());
    this.startHookServer();
    // Same rule as the registration in main.ts: on a Mac the Swift Vibex owns Claude's real settings.
    const swiftOwnsSettings = process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR && testEnv('VIBEX_REGISTER_CLAUDE') !== '1';
    if (!existsSync(this.removedMarker) && !swiftOwnsSettings) this.setHooks(true);
  }

  private startHookServer(): void {
    const token = randomBytes(32).toString('base64url');
    const server = http.createServer((req, res) => {
      const reply = (status: number) => {
        res.writeHead(status);
        res.end();
      };
      const actual = (server.address() as AddressInfo).port;
      const hostHeader = req.headers.host ?? '';
      if (hostHeader !== `127.0.0.1:${actual}` && hostHeader !== `localhost:${actual}`) return reply(403);
      if (req.headers.origin) return reply(403);
      const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return reply(401);
      if ((req.url ?? '').split('?')[0] !== '/hook' || req.method !== 'POST') return reply(404);
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return reply(413);
        const projectId = String(req.headers['x-vibex-window'] ?? '');
        if (!this.host.projects.get(projectId)) return reply(404);
        const event = parseHookEvent(Buffer.concat(chunks).toString('utf8'));
        if (!event) return reply(400);
        this.handle(projectId, event);
        reply(204);
      });
      req.on('error', () => reply(400));
    });
    server.listen(0, '127.0.0.1', () => {
      // Terminals started after this inherit the address; the key is this run's own.
      process.env.VIBEXPCA_HOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      process.env.VIBEXPCA_HOOK_TOKEN = token;
    });
    this.server = server;
    server.unref();
  }

  /// One hook event for a project: a waiting event shows, any other event of that session ends the wait.
  handle(projectId: string, event: HookEvent): void {
    const key = `${projectId}|${event.session}`;
    const project = this.host.projects.get(projectId)!;
    const waiting = waitingOf(event);
    if (waiting) {
      const old = this.waiting.get(key);
      // A Notification right after a PermissionRequest repeats it; keep the more specific one.
      if (event.name === 'Notification' && old?.kind === 'permission') return;
      this.waiting.set(key, { id: key, projectId, project: project.name, session: event.session, cwd: event.cwd, kind: waiting.kind, message: waiting.message, since: old?.since ?? Date.now() });
      // The Inbox line holds the detail; a system notification can show on a locked screen, so it never holds a command, a URL or a path.
      if (!old) {
        if (waiting.kind === 'permission') this.notify('Claude needs your approval', `${project.name}: Claude asks to use ${event.tool ? friendlyTool(event.tool) : 'a tool'}`);
        else this.notify('Claude is waiting for you', `${project.name}: open the Inbox to see what it asks`);
      }
    } else if (!this.waiting.delete(key)) {
      return;
    }
    this.changed();
  }

  /// A session in a tab that closed cannot be waiting; neither can one in a project that was closed.
  private prune(): void {
    let removed = false;
    for (const [key, item] of this.waiting) {
      const alive = this.host.projects.get(item.projectId) && this.host.terminals.list().some((t) => t.project === item.projectId && t.pane === 'agent' && t.alive);
      if (!alive) {
        this.waiting.delete(key);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  /// What the Claude sessions of this project wait for, newest first.
  waitingIn(projectId: string): Waiting[] {
    return [...this.waiting.values()].filter((w) => w.projectId === projectId).sort((a, b) => b.since - a.since);
  }

  snapshot() {
    return { waiting: [...this.waiting.values()].sort((a, b) => a.since - b.since), reports: this.reports, hooks: this.problem ? 'unreadable' : hooksStatus(), problem: this.problem };
  }

  private changed(): void {
    this.host.send('mod:inbox:changed', this.snapshot());
  }

  /// A system notification when the person is not looking at the app.
  notify(title: string, body: string): void {
    const front = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    if (front || !Notification.isSupported()) return;
    new Notification({ title, body }).show();
  }

  private setHooks(want: boolean): { ok: boolean; message: string } {
    try {
      if (want) {
        installHooks();
        rmSync(this.removedMarker, { force: true });
      } else {
        uninstallHooks();
        writeFileSync(this.removedMarker, 'The person removed the hooks; do not add them again at start.\n');
      }
      this.problem = null;
      this.changed();
      return { ok: true, message: want ? 'Hooks added to Claude settings.' : 'Hooks removed from Claude settings.' };
    } catch (error) {
      this.problem = `Claude settings.json could not be changed (${String(error).replace(/^Error: /, '')}). It was left as it is.`;
      this.changed();
      return { ok: false, message: this.problem };
    }
  }

  tools(server: McpServer, ctx: ToolContext): void {
    server.registerTool('vibex_notify', {
      description: "Show a toast in the Vibex window (and a system notification if Vibex is in the background), and keep it in the Inbox. Use it when a long task finishes or needs the user's attention.",
      inputSchema: { title: z.string().min(1).describe('Short headline'), message: z.string().optional().describe('Optional detail, one or two sentences'), ...ctx.scope },
    }, async ({ title, message, project_path }: any) => {
      const target = ctx.project(project_path);
      const report: Report = { id: randomBytes(6).toString('hex'), projectId: target.id, project: target.name, title: title.slice(0, 200), message: message ? message.slice(0, 1000) : null, at: Date.now() };
      this.reports = [report, ...this.reports].slice(0, MAX_REPORTS);
      this.host.send('mod:inbox:toast', report);
      this.changed();
      this.notify(report.title, report.message ? `${target.name}: ${report.message}` : target.name);
      return ctx.said('Shown.', target);
    });
  }

  close(): void {
    this.server?.close();
  }
}
