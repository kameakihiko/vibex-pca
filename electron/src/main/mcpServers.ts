import { execFile } from 'node:child_process';
import { isTestRun, testEnv } from './testSwitches';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from './claude';

// The MCP servers Claude Code is set up to use, read from Claude's own config and changed with the `claude` CLI, as
// macOS Vibex does (MCPServers/MCPServersModel.swift). A header or an environment value is never read into a result.

export type McpScope = 'user' | 'project' | 'local';
export type McpHealth = 'connected' | 'needsSignIn' | 'waitingForApproval' | 'failed';

export interface McpServerRow {
  name: string;
  scope: McpScope;
  /// The command or the address for the row's second line, with secrets cut out.
  detail: string;
  /// Claude Code gets it from a plugin or claude.ai, not from a config file; Vibex cannot remove it.
  origin?: string;
}

/// Claude's user config: inside CLAUDE_CONFIG_DIR when that is set, else ~/.claude.json.
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const SECRET_FLAG = /(token|key|secret|password|passwd|auth|bearer|header|cookie|credential)/i;

/// An address without user, password or query: those are where keys sit.
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/\/[^/@]*@/, '//');
  }
}

/// The command line for the row, with the value of any `--flag=value`, `NAME=value` or secret-looking flag cut out.
export function safeCommand(command: unknown, args: unknown): string {
  const parts: string[] = [];
  let hide = false;
  for (const arg of Array.isArray(args) ? args.map(String) : []) {
    if (hide) {
      parts.push('…');
      hide = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0 && !/^[a-z]+:\/\//i.test(arg)) parts.push(`${arg.slice(0, eq + 1)}…`);
    else if (/^\w+:\/\//.test(arg)) parts.push(safeUrl(arg));
    else {
      parts.push(arg);
      if (/^--?[\w-]+$/.test(arg) && SECRET_FLAG.test(arg)) hide = true;
    }
  }
  return [typeof command === 'string' ? command : '', ...parts].filter(Boolean).join(' ');
}

function rows(value: unknown, scope: McpScope): McpServerRow[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, any>)
    .map(([name, entry]) => ({
      name,
      scope,
      detail: typeof entry?.url === 'string' ? safeUrl(entry.url) : safeCommand(entry?.command, entry?.args),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Servers in the config files: every project (user), this project on this computer (local) and the project's
/// `.mcp.json` (project).
export function installedServers(project: string): McpServerRow[] {
  const config = readJson(claudeJsonPath());
  return [
    ...rows(config.mcpServers, 'user'),
    // Windows paths may be keyed with / in Claude's file.
    ...rows((config.projects?.[project] ?? config.projects?.[project.replace(/\\/g, '/')])?.mcpServers, 'local'),
    ...rows(readJson(path.join(project, '.mcp.json')).mcpServers, 'project'),
  ];
}

/// "clickup: https://mcp.clickup.com/mcp (HTTP) - ✔ Connected" -> name, target, health. Same reading as macOS Vibex.
export function parseHealth(output: string): { name: string; target: string; health: McpHealth }[] {
  const out: { name: string; target: string; health: McpHealth }[] = [];
  for (const line of output.split('\n')) {
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon < 0 || dash < 0 || colon + 2 > dash) continue;
    const status = line.slice(dash + 3).toLowerCase();
    const health: McpHealth = status.includes('connected') && !status.includes('failed') ? 'connected'
      : status.includes('auth') ? 'needsSignIn'
      : status.includes('approval') ? 'waitingForApproval'
      : 'failed';
    const target = line.slice(colon + 2, dash).replace(' (HTTP)', '').replace(' (SSE)', '');
    out.push({ name: line.slice(0, colon), target: /^\w+:\/\//.test(target) ? safeUrl(target) : safeCommand(target.split(' ')[0], target.split(' ').slice(1)), health });
  }
  return out;
}

export function claudeBinary(): string | null {
  // The same switch as the chip, so a test can say "missing" on a computer that has Claude Code.
  if (isTestRun() && testEnv('VIBEX_CLAUDE_MISSING') === '1') return null;
  return (isTestRun() && testEnv('VIBEX_CLAUDE_BIN')) || findClaude();
}

function runClaude(args: string[], cwd: string, timeout: number): Promise<string> {
  const claude = claudeBinary();
  if (!claude) return Promise.reject(new Error('Claude Code is not installed. Open Setup to install it.'));
  return new Promise((resolve, reject) => {
    execFile(claude, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((String(stderr).trim() || String(stdout).trim() || `claude stopped with ${(error as any).code ?? 'an error'}`).slice(0, 300)));
      else resolve(String(stdout));
    });
  });
}

/// `claude mcp list` in the project folder: every server Claude Code would load there, with whether it connects.
/// It starts each server, so it takes a few seconds.
export async function checkHealth(project: string): Promise<{ name: string; target: string; health: McpHealth }[]> {
  try {
    return parseHealth(await runClaude(['mcp', 'list'], project, 90_000));
  } catch {
    return [];
  }
}

/// Starts with a letter or digit, so a name can never be read as an option.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SCOPES: McpScope[] = ['user', 'project', 'local'];

export type McpAddInput = { name: string; scope: McpScope } & ({ url: string; command?: undefined; args?: undefined } | { command: string; args?: string; url?: undefined });

/// The `claude mcp add` arguments for a server, or a plain reason why not. No shell: this is an argument list.
/// The name and address come before any option, as macOS Vibex does, because options take several values.
export function addArguments(input: McpAddInput): string[] {
  if (!NAME.test(String(input.name))) throw new Error('Use letters, digits, dot, dash or underscore in the name (up to 64), and start with a letter or digit.');
  if (input.name === 'vibex') throw new Error('Vibex manages the vibex server itself.');
  if (!SCOPES.includes(input.scope)) throw new Error('Pick where to add it: every project, this project, or this project on this computer.');
  if (input.url !== undefined) {
    let url: URL;
    try {
      url = new URL(String(input.url));
    } catch {
      throw new Error('The address is not a web address.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https:// or http://.');
    return ['mcp', 'add', input.name, url.toString(), '--transport', 'http', '--scope', input.scope];
  }
  const command = String(input.command ?? '').trim();
  if (!command || /[\0\r\n]/.test(command)) throw new Error('Enter the program that starts the server.');
  const args = String(input.args ?? '').split(/\s+/).filter(Boolean);
  return ['mcp', 'add', input.name, '--scope', input.scope, '--', command, ...args];
}

export async function addServer(project: string, input: McpAddInput): Promise<void> {
  await runClaude(addArguments(input), project, 30_000);
}

export async function removeServer(project: string, name: string, scope: McpScope): Promise<void> {
  if (!NAME.test(String(name))) throw new Error('That is not a server name.');
  if (name === 'vibex') throw new Error('Vibex manages the vibex server itself.');
  if (!SCOPES.includes(scope)) throw new Error('That is not a place a server can be removed from.');
  await runClaude(['mcp', 'remove', name, '--scope', scope], project, 30_000);
}
