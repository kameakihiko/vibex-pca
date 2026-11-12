import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { endsWithApp } from './programs';
import type { TokenStore } from './token';

export const SERVER_NAME = 'vibex';

/// Where `claude` lives. On Windows only the native claude.exe is used: an npm claude.cmd needs cmd.exe,
/// which re-parses the JSON argument and breaks it. The native installer is Anthropic's Windows default.
export function findClaude(): string | null {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  if (process.platform === 'win32') dirs.push(path.join(process.env.USERPROFILE ?? '', '.local', 'bin'));
  else dirs.push(path.join(process.env.HOME ?? '', '.local', 'bin'));
  // A relative entry would find a file in the folder the app happens to run in.
  for (const dir of dirs.filter((d) => path.isAbsolute(d))) {
    for (const ext of exts) {
      const file = path.join(dir, `claude${ext}`);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/// The command Claude Code runs to get the Authorization header (MCP `headersHelper`): this app with
/// --mcp-headers. Forward slashes and double quotes read the same in cmd, Git Bash and sh.
export function headersHelperCommand(): string {
  const parts = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])];
  const quoted = parts.map((p) => `"${p.replace(/\\/g, '/')}"`);
  return [...quoted, '--mcp-headers'].join(' ');
}

/// Once for each install found, set before anything waits: registering takes up to 40 s with nothing to see, so the person
/// clicks again, and each pass would open one more Claude tab.
export function claimClaudeFound(status: { claudeInstalled: boolean; claude: string; foundClaimed?: boolean }): boolean {
  if (status.foundClaimed) return false;
  if (status.claudeInstalled && !status.claude.startsWith('not registered: Claude Code is not installed')) return false;
  status.foundClaimed = true;
  status.claudeInstalled = true;
  return true;
}

function run(file: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    endsWithApp(execFile(file, args, { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
    }));
  });
}

/// The entry in Claude's config. The header carries the project of the tab Claude started in, as macOS Vibex does
/// (ClaudeCodeRegistrar); Claude reads VIBEX_WINDOW from its own environment on each connection.
export function mcpEntry(port: number, headersHelper: string) {
  return { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Vibex-Window': '${VIBEX_WINDOW:-}' }, headersHelper };
}

/// Registers the MCP server for Claude Code at user scope, as macOS Vibex does on each launch, but with no
/// key in Claude's config: Claude asks this app for the header each time it connects.
export async function registerWithClaude(port: number, store: TokenStore): Promise<string> {
  if (store !== 'os-store') return 'not registered: no system key store, so Claude cannot fetch the key';
  const claude = findClaude();
  if (!claude) return 'not registered: Claude Code is not installed (or only as an npm claude.cmd on Windows)';
  const entry = JSON.stringify(mcpEntry(port, headersHelperCommand()));
  await run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  const added = await run(claude, ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, entry]);
  return added.ok ? 'registered' : `not registered: ${added.output.slice(0, 200)}`;
}
