import { isTestRun } from './testSwitches';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { ProjectInfo } from './projects';
import { defaultShell, inProject, loginPathReady, loginShellRun, stripAnsi, type Terminals } from './terminals';

// Run the project, as macOS Vibex does (Run/RunConfig.swift, Run/Runner.swift): read `.vibex.json` or detect the dev
// command, start it in a "Run" tab of the command terminal, and open the page in the side browser once it answers.
// iOS and macOS builds need Xcode on a Mac; this edition runs web projects and plain commands.

export type RunKind = 'ios' | 'macos' | 'web' | 'command';

export interface RunConfig {
  kind: RunKind;
  command?: string;
  url?: string;
  project?: string;
  scheme?: string;
  prepare?: string;
  /// A command written in the project's own `.vibex.json` runs only after the person approved it once.
  source: 'file' | 'detected';
}

export const RUN_FILE = '.vibex.json';

/// `.vibex.json`: { "run": { "kind": "web", "command": "npm run dev", "url": "http://localhost:5173" } }
export function loadRunFile(folder: string): RunConfig | null {
  try {
    const run = JSON.parse(readFileSync(path.join(folder, RUN_FILE), 'utf8'))?.run;
    if (!run || !['ios', 'macos', 'web', 'command'].includes(run.kind)) return null;
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return { kind: run.kind, command: text(run.command), url: text(run.url), project: text(run.project), scheme: text(run.scheme), prepare: text(run.prepare), source: 'file' };
  } catch {
    return null;
  }
}

/// A port for the page: from a `--port` or `-p` flag in the script, else the usual one of the tool.
export function guessPort(deps: Record<string, unknown>, script: string): number {
  const flag = /(?:--port|-p)[ =](\d{2,5})/.exec(script);
  if (flag) return Number(flag[1]);
  if (deps.vite || script.includes('vite')) return 5173;
  if (deps.astro) return 4321;
  if (deps['@sveltejs/kit']) return 5173;
  if (deps['@angular/core']) return 4200;
  return 3000;
}

/// Guesses how a folder runs from the files in it. No program is started. The command is built from fixed words and
/// the script's name, never from the script's text.
export function detectRun(folder: string): RunConfig | null {
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return null;
  }
  const has = (n: string) => names.includes(n);
  const workspace = names.find((n) => n.endsWith('.xcworkspace'));
  const xcode = names.find((n) => n.endsWith('.xcodeproj'));
  if (has('project.yml') || workspace || xcode) {
    const read = (...parts: string[]) => {
      try {
        return readFileSync(path.join(folder, ...parts), 'utf8');
      } catch {
        return '';
      }
    };
    const spec = read('project.yml');
    const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(spec)?.[1] ?? ((workspace ?? xcode ?? '').replace(/\.(xcworkspace|xcodeproj)$/, '') || path.basename(folder));
    const platforms = [...spec.matchAll(/^\s*platform:\s*(\S+)/gm)].map((m) => m[1]);
    const pbx = xcode ? read(xcode, 'project.pbxproj') : '';
    // Mac-only when every platform of the spec is macOS, or the project file has no iOS SDK.
    const macOnly = spec ? platforms.length > 0 && platforms.every((p) => p === 'macOS') : pbx.includes('SDKROOT = macosx') && !pbx.includes('SDKROOT = iphoneos');
    return { kind: macOnly ? 'macos' : 'ios', project: workspace ?? xcode ?? `${name}.xcodeproj`, scheme: name, prepare: has('project.yml') ? 'xcodegen generate' : undefined, source: 'detected' };
  }
  if (has('package.json')) {
    try {
      const json = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
      const scripts: Record<string, string> = json.scripts ?? {};
      const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string');
      if (script) {
        const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
        const command = runner === 'npm' ? `npm run ${script}` : `${runner} ${script}`;
        const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
        return { kind: 'web', command, url: `http://localhost:${guessPort(deps, scripts[script])}`, source: 'detected' };
      }
    } catch {
      // A package.json that does not parse is not a project to run.
    }
  }
  if (has('Cargo.toml')) return { kind: 'command', command: 'cargo run', source: 'detected' };
  if (has('go.mod')) return { kind: 'command', command: 'go run .', source: 'detected' };
  if (has('Package.swift')) return { kind: 'command', command: 'swift run', source: 'detected' };
  if (has('Makefile')) {
    try {
      const make = readFileSync(path.join(folder, 'Makefile'), 'utf8');
      if (make.includes('\nrun:') || make.startsWith('run:')) return { kind: 'command', command: 'make run', source: 'detected' };
    } catch {
      // unreadable: nothing to run
    }
  }
  return null;
}

export const resolveRun = (folder: string): RunConfig | null => loadRunFile(folder) ?? detectRun(folder);

export function summary(config: RunConfig | null): string {
  if (!config) return 'nothing to run';
  if (config.kind === 'ios' || config.kind === 'macos') return `${config.kind === 'ios' ? 'iOS' : 'macOS'} · ${config.scheme ?? '?'}`;
  return config.command ?? config.kind;
}

export type RunPhase = 'idle' | 'running' | 'serving' | 'succeeded' | 'failed' | 'stopped';

export interface RunState {
  project: string;
  phase: RunPhase;
  /// A few plain words for the button: "Running", "localhost:5173", "Exited 1".
  label: string;
  summary: string;
  active: boolean;
  port: number | null;
}

interface Slot { phase: RunPhase; label: string; config: RunConfig | null; tab: number | null; exitCode: number | null; url: string | null; token: number }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/// A page address the person's own machine serves; the check never reaches out to another host.
export function localUrl(raw: string | undefined): URL | null {
  try {
    const url = new URL(String(raw));
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function responds(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    // A dev server on https://localhost has a certificate of its own; only the answer matters here.
    const secure = url.protocol === 'https:';
    const request = (secure ? https : http).get({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (secure ? 443 : 80), path: url.pathname + url.search, timeout: 1000, ...(secure ? { rejectUnauthorized: false } : {}) }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

export interface RunnerHost {
  terminals: Terminals;
  navigate: (project: ProjectInfo, url: string) => Promise<unknown>;
  reveal: (project: ProjectInfo) => void;
  changed: (state: RunState) => void;
  /// Asks the person to approve a command from the project's own file; true when they agree.
  approve: (project: ProjectInfo, command: string) => Promise<boolean>;
  userData: string;
}

export class Runner {
  private slots = new Map<string, Slot>();
  private projects = new Map<string, ProjectInfo>();
  private pollMs = isTestRun() ? 100 : 500;

  constructor(private host: RunnerHost) {
    host.terminals.on('exit', (tab: number, code: number) => {
      for (const [id, slot] of this.slots) {
        if (slot.tab !== tab) continue;
        slot.token++;
        slot.exitCode = code;
        if (slot.phase === 'stopped') continue;
        slot.phase = code === 0 ? 'succeeded' : 'failed';
        slot.label = code === 0 ? (slot.config?.kind === 'web' ? 'Server exited' : 'Finished') : `Exited ${code}`;
        this.publish(id);
      }
    });
    host.terminals.on('closed', (tab: number) => {
      for (const [id, slot] of this.slots) {
        if (slot.tab !== tab) continue;
        slot.tab = null;
        slot.token++;
        if (slot.phase === 'running' || slot.phase === 'serving') {
          slot.phase = 'stopped';
          slot.label = 'Stopped';
        }
        this.publish(id);
      }
    });
  }

  private slot(project: ProjectInfo): Slot {
    this.projects.set(project.id, project);
    let slot = this.slots.get(project.id);
    if (!slot) {
      slot = { phase: 'idle', label: 'Run', config: null, tab: null, exitCode: null, url: null, token: 0 };
      this.slots.set(project.id, slot);
    }
    return slot;
  }

  state(project: ProjectInfo): RunState {
    const slot = this.slot(project);
    const config = slot.config ?? resolveRun(project.path);
    const port = slot.phase === 'serving' && slot.url ? Number(new URL(slot.url).port) || null : null;
    return { project: project.id, phase: slot.phase, label: slot.label, summary: summary(config), active: slot.phase === 'running' || slot.phase === 'serving', port };
  }

  private publish(id: string): void {
    const project = this.projects.get(id);
    if (project) this.host.changed(this.state(project));
  }

  /// Starts the run. Returns the one line a tool or the button shows.
  async run(project: ProjectInfo, viaTool: boolean): Promise<string> {
    if (project.server) return 'Run works on projects on this computer. This project is on a server: run it in its terminal.';
    this.stop(project, true);
    const config = resolveRun(project.path);
    const slot = this.slot(project);
    if (!config) return this.fail(project, 'Nothing to run', `Vibex could not tell how to run this project. Add a ${RUN_FILE} to its root, or run it in the terminal.`);
    if (config.kind === 'ios' || config.kind === 'macos') {
      return this.fail(project, 'Needs a Mac', `${summary(config)} builds with Xcode on a Mac. This edition runs web projects and plain commands.`);
    }
    if (!config.command) return this.fail(project, 'No command', `Set "command" in ${RUN_FILE}.`);
    if (config.source === 'file' && !this.approved(project.path, config.command)) {
      if (viaTool) return this.fail(project, 'Needs your approval', `The command in ${RUN_FILE} (${config.command}) has not been approved. Press Run in Vibex once to look at it and approve it.`);
      if (!(await this.host.approve(project, config.command))) return this.fail(project, 'Not approved', 'The command was not run.');
      this.remember(project.path, config.command);
    }
    slot.config = config;
    slot.exitCode = null;
    slot.url = null;
    const token = ++slot.token;
    await loginPathReady();
    if (slot.token !== token) return 'Stopped before it started.';
    const shell = defaultShell();
    // RemoteSigned: with the default policy of Windows PowerShell 5.1, `npm run dev` goes to npm.ps1 and is refused.
    const started = shell.kind === 'pwsh' ? { args: ['-NoLogo', '-ExecutionPolicy', 'RemoteSigned', '-Command', config.command] } : loginShellRun(shell.file, config.command);
    const tab = this.host.terminals.create(inProject({ ...shell, ...started, kind: 'none', title: 'Run', pane: 'shell', once: true }, project));
    slot.tab = tab.id;
    slot.phase = 'running';
    slot.label = 'Running';
    this.host.reveal(project);
    this.publish(project.id);
    const url = config.kind === 'web' ? localUrl(config.url ?? 'http://localhost:3000') : null;
    if (url) void this.poll(project, slot, url, token);
    return `Started: ${summary(config)}. Phase: ${slot.label}.`;
  }

  private async poll(project: ProjectInfo, slot: Slot, url: URL, token: number): Promise<void> {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (slot.token !== token) return;
      if (await responds(url)) {
        if (slot.token !== token) return;
        slot.phase = 'serving';
        slot.url = url.toString();
        slot.label = `${url.hostname}:${url.port || 80}`;
        this.publish(project.id);
        void this.host.navigate(project, url.toString()).catch(() => undefined);
        return;
      }
    }
    // The wait ended: say so, instead of a label that reads "Running" for ever.
    if (slot.token === token && slot.phase === 'running') {
      slot.label = 'Running, no page answered';
      this.publish(project.id);
    }
  }

  stop(project: ProjectInfo, quietly = false): string {
    const slot = this.slot(project);
    slot.token++;
    const wasActive = slot.phase === 'running' || slot.phase === 'serving';
    if (slot.tab !== null) {
      const tab = slot.tab;
      if (!quietly && wasActive) {
        slot.phase = 'stopped';
        slot.label = 'Stopped';
      }
      this.host.terminals.close(tab);
      slot.tab = null;
    } else if (!quietly && wasActive) {
      slot.phase = 'stopped';
      slot.label = 'Stopped';
    }
    if (!quietly) this.publish(project.id);
    return wasActive ? 'Stopped.' : 'Nothing was running.';
  }

  /// config, phase, exit code and the tail of the output, for vibex_run_status.
  status(project: ProjectInfo, lines = 60): string {
    const slot = this.slot(project);
    const out = [`config: ${summary(slot.config ?? resolveRun(project.path))}`, `phase: ${slot.label}${this.state(project).active ? ' (active)' : ''}`];
    if (slot.exitCode !== null) out.push(`exit code: ${slot.exitCode}`);
    if (slot.tab !== null) {
      let tail = '';
      try {
        tail = stripAnsi(this.host.terminals.buffer(slot.tab)).split('\n').map((l) => l.trimEnd()).slice(-lines).join('\n').trim();
      } catch {
        // The tab closed between the two lines.
      }
      if (tail) out.push(`--- output ---\n${tail}`);
    }
    return out.join('\n');
  }

  private fail(project: ProjectInfo, title: string, detail: string): string {
    const slot = this.slot(project);
    slot.phase = 'failed';
    slot.label = title;
    this.publish(project.id);
    return `${title}: ${detail}`;
  }

  private approvalFile = () => path.join(this.host.userData, 'run-approved.json');
  private key = (folder: string, command: string) => createHash('sha256').update(`${folder}\n${command}`).digest('hex');
  private approved(folder: string, command: string): boolean {
    try {
      return (JSON.parse(readFileSync(this.approvalFile(), 'utf8')) as string[]).includes(this.key(folder, command));
    } catch {
      return false;
    }
  }
  private remember(folder: string, command: string): void {
    let list: string[] = [];
    try {
      list = JSON.parse(readFileSync(this.approvalFile(), 'utf8'));
    } catch {
      // first approval
    }
    list.push(this.key(folder, command));
    if (!existsSync(this.host.userData)) mkdirSync(this.host.userData, { recursive: true });
    writeFileSync(this.approvalFile(), JSON.stringify([...new Set(list)]));
  }
}
