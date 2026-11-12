import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeUrl } from './browser';
import type { ToolContext, VibexModule } from './modules';
import type { ProjectInfo } from './projects';
import { asServerCaller, serverMayOpen } from './serverGuard';
import { LOOPBACK_HOSTS, PORTS, type Target } from './serverPorts';

export { serverMayOpen };

// What Claude on a server may do with its token (fork: MCP/MCPServer.swift serverMayCall, App/WindowManager.swift
// serverMayOpen). A token acts on its own project only. A tool is not listed unless it is named here, so a new module's
// tool is closed to a server until someone opens it on purpose.

const URL_TOOLS = new Set(['vibex_preview', 'simulator_open_url', 'browser_navigate', 'browser_new_tab']);
const PLAIN_TOOLS = new Set(['terminal_output', 'terminal_tabs', 'vibex_view', 'vibex_layout', 'vibex_notify', 'vibex_focus', 'vibex_run_status']);

export function serverMayCall(name: string, args: Record<string, unknown>, forwards: number[] = []): boolean {
  if (name === 'terminal_run') return args.local !== true;
  if (URL_TOOLS.has(name)) {
    if (typeof args.url !== 'string') return name === 'browser_new_tab';
    return serverMayOpen(normalizeUrl(args.url), forwards);
  }
  if (name.startsWith('browser_')) return true;
  return PLAIN_TOOLS.has(name);
}

const listedForServer = (name: string) => serverMayCall(name, { url: 'https://example.com', local: false });

export type ForwardPlan = { kind: 'none' } | { kind: 'refused'; reason: string } | { kind: 'open'; url: string } | { kind: 'forward'; target: Target; url: string };

/// A loopback address from Claude on a server names a server port: the app forwards it to a free port here, or opens
/// the forward that exists. The app picks the local port, never the caller.
export function planForward(raw: string, mapped: Map<number, number>): ForwardPlan {
  const text = normalizeUrl(raw);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'none' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host)) return { kind: 'none' };
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const macPort = mapped.get(port);
  if (macPort !== undefined) return { kind: 'open', url: rewrite(url, macPort) };
  if (port < PORTS[0]) return { kind: 'refused', reason: `server port ${port} is below ${PORTS[0]}; the app forwards only server ports ${PORTS[0]}-${PORTS[1]}. Serve the page on a higher port.` };
  return { kind: 'forward', target: { host, port }, url: text };
}

function rewrite(url: URL, macPort: number): string {
  const next = new URL(url.href);
  next.hostname = '127.0.0.1';
  next.port = String(macPort);
  next.username = '';
  next.password = '';
  return next.href;
}

export interface ServerGuardDeps {
  forwards: (project: ProjectInfo) => number[];
  portMap: (project: ProjectInfo) => Map<number, number>;
  forward: (project: ProjectInfo, target: Target) => Promise<number>;
}

/// Puts the rule in front of each tool of a request that came with a project's token. Nothing else in the MCP server
/// knows about servers, so every tool of every module passes here.
export function guardForServer(server: McpServer, project: ProjectInfo, deps: ServerGuardDeps): void {
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => any) => {
    if (!listedForServer(name)) return { name, enabled: false };
    return register(name, config, async (input: any, extra: any) => {
      const args = { ...(input ?? {}) };
      let note: string | undefined;
      // A path here would be a file of this computer, and text with no scheme is not an address until it is guessed at.
      if (name === 'vibex_preview' && !/^https?:\/\//i.test(String(args.url))) throw new Error('vibex_preview from an agent on a server opens only an http or https address');
      if (URL_TOOLS.has(name) && typeof args.url === 'string') {
        const plan = planForward(args.url, deps.portMap(project));
        if (plan.kind === 'refused') throw new Error(`${name}: ${plan.reason}`);
        if (plan.kind === 'open') args.url = plan.url;
        if (plan.kind === 'forward') {
          const macPort = await deps.forward(project, plan.target);
          const opened = rewrite(new URL(plan.url), macPort);
          args.url = opened;
          note = `The app forwarded port ${plan.target.port} of the server to this computer and opened it as ${opened}. Keep using http://localhost:${plan.target.port}/... in your calls.`;
        }
      }
      if (!serverMayCall(name, args, deps.forwards(project))) {
        throw new Error(`${name}${name === 'terminal_run' ? ' with local true' : ''} is not available to an agent on a server`);
      }
      // The Run button works on this computer only, and the tool would read this computer's folder of the same path.
      if (name === 'vibex_run_status') return { content: [{ type: 'text' as const, text: 'Run works on projects on this computer. This project is on a server: run it in its terminal.' }] };
      // The page rule lives in BrowserPane, for every tab and every read and move; this marks whose call it is.
      const result = await asServerCaller(() => (config.inputSchema ? handler(args, extra) : handler(extra)));
      if (note && Array.isArray(result?.content)) result.content.unshift({ type: 'text', text: note });
      return result;
    });
  };
}

export interface ServerToolsDeps {
  allowed: () => { name: string; address: string; login: string; confirm: boolean }[];
  /// This project's server and folder, for the line that says where terminal_run goes.
  here: (project: ProjectInfo) => { server: string; folder: string } | null;
  connect: (name: string, project: ProjectInfo) => string;
}

/// server_list and server_connect, with the fork's names and inputs (MCP/Tools/ServerTools.swift).
export function serverToolsModule(deps: () => ServerToolsDeps | null): VibexModule {
  return {
    name: 'servers',
    tools: (server: McpServer, ctx: ToolContext) => {
      server.registerTool('server_list', {
        description: 'Saved SSH servers the user lets Claude use ("allowClaude" in the server\'s form): name, user@host:port and how it logs in. Also says whether this project runs on a server.',
        inputSchema: { ...ctx.scope },
      }, async ({ project_path }: any) => {
        const d = deps();
        if (!d) throw new Error('the servers part of the app has not started');
        const lines = d.allowed().map((p) => `${p.name}  ${p.address}  ${p.login}${p.confirm ? '  asks before each change' : ''}`);
        if (!lines.length) lines.push('No server allows Claude. The user turns on "Let Claude use this server" in the server\'s form.');
        try {
          const here = d.here(ctx.project(project_path));
          if (here) lines.push(`This project runs on ${here.server} in ${here.folder}; terminal_run runs there unless local is true.`);
        } catch {
          // A call from outside a tab acts on no project; the list stays true.
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      });
      server.registerTool('server_connect', {
        description: "Open an interactive SSH session to a saved server in a new tab of the command terminal, where the user watches it. Only servers from server_list. ssh asks the app for the saved password; it never reaches this tool. Production writes on a server still need the user's explicit go.",
        inputSchema: { name: z.string().describe('Server name from server_list'), ...ctx.scope },
      }, async ({ name, project_path }: any) => {
        const d = deps();
        if (!d) throw new Error('the servers part of the app has not started');
        const target = ctx.project(project_path);
        return ctx.said(d.connect(name, target), target);
      });
    },
  };
}
