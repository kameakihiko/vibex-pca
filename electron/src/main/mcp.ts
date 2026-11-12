import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { BrowserPane } from './browser';
import type { ToolContext, VibexModule } from './modules';
import type { ProjectInfo } from './projects';
import { commandLaunch, inProject, loginPathReady, type Terminals } from './terminals';
import { countTools } from './usage';

export interface McpDeps {
  /// Which project a call is for; throws when that cannot be told, so nothing acts.
  route: (windowHeader: string | undefined, projectPath: string | undefined) => ProjectInfo;
  /// The project's browser; made at the first call that needs it.
  browser: (project: ProjectInfo) => BrowserPane;
  terminals: Terminals;
  /// Shows a pane the person hid, when something runs in it.
  reveal: (project: ProjectInfo, pane: 'browser' | 'shell') => void;
  /// The project of a per-project server token (serverHub.ts), or null. Such a request acts on that project only.
  serverProject: (token: string) => ProjectInfo | null;
  /// Puts the rule for Claude on a server in front of every tool of a server token's request.
  guardForServer: (server: McpServer, project: ProjectInfo) => void;
  /// Why a terminal_run must not run (the hold of a server with "confirmCommands"), or null. For every caller.
  confirmRun: (project: ProjectInfo, command: string, cwd: string | undefined, local: boolean) => Promise<string | null>;
  /// One command on the project's server, in a tab the person watches.
  runOnServer: (project: ProjectInfo, command: string, cwd: string | undefined, timeoutMs: number) => Promise<{ output: string; code: number | null; timedOut: boolean; run: number }>;
  listProjects: () => ProjectInfo[];
  recentProjects: () => { name: string; path: string; server?: string }[];
  openProject: (folder: string) => ProjectInfo;
  version: string;
  modules: VibexModule[];
}

const MAX_BODY = 4 * 1024 * 1024;
const OUTPUT_TAIL = 8000;
const ENDED = '[ended: its tab was closed]';

/// What the agent reads of a long output. The note says how much that is, and whether the start is gone for good.
function tailOf(output: string, cut: boolean, limit: number, run: number): string {
  if (cut) return `[only the end of the output is kept, and the earlier part is gone; this is the last ${Math.min(limit, output.length)} characters]\n${output.slice(-limit)}`;
  if (output.length <= limit) return output;
  return `[last ${limit} of ${output.length} characters; terminal_output with run ${run} and chars reads more]\n${output.slice(-limit)}`;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/// Every tool that acts on a project takes this, as in macOS Vibex.
const scope = {
  project_path: z.string().optional().describe('Absolute folder of the intended open Vibex project. Set this when the call does not come from a Vibex tab, or when vibex_projects shows another project.'),
};

/// The tools: 2 terminal and 2 project tools here, with the macOS Vibex names and inputs; the browser tools are the browser module's (browserTools.ts).
/// One server per request, so the header of this request is the project of each tool below.
function buildServer(deps: McpDeps, windowHeader: string | undefined, serverProject: ProjectInfo | null = null): McpServer {
  const server = new McpServer({ name: 'vibex', version: deps.version });
  countTools(server);
  const project = (projectPath?: string) => {
    if (!serverProject) return deps.route(windowHeader, projectPath);
    if (projectPath !== undefined) throw new Error('server tokens cannot select another project');
    return serverProject;
  };
  if (serverProject) deps.guardForServer(server, serverProject);
  // With several projects open, each result names the project that acted, so a session in the wrong one shows.
  const said = (result: string, target: ProjectInfo) => text(deps.listProjects().length > 1 ? `${result}\n[project: ${target.name}]` : result);

  server.registerTool('terminal_tabs', {
    description: "List the project's terminal tabs with their numbers, titles and whether they still run.",
    inputSchema: { ...scope },
  }, async ({ project_path }) => text(deps.terminals.list().filter((t) => {
    const target = project(project_path);
    if (t.project !== target.id) return false;
    // Claude on a server sees what runs on its own server. A local tab's title holds the words of a command of this computer.
    return !serverProject || t.remote === true || t.server === target.server;
  }).map((t) => `${t.id}\t${t.title}\t${t.kind}\t${t.alive ? 'running' : 'exited'}`).join('\n')));

  server.registerTool('terminal_run', {
    description: "Run a shell command in a terminal tab the user can see, and return its output. Starts in the project folder unless cwd is given. In a server project (see server_list) it runs on the server, in the project's server folder, unless local is true.",
    inputSchema: {
      command: z.string().min(1).describe('Shell command (PowerShell on Windows, the login shell elsewhere, or sh when that shell is fish or csh; on a server, its login shell)'),
      tab: z.number().int().optional().describe('Not supported: each command gets a tab of its own, and a value is refused'),
      wait: z.number().int().min(0).optional().describe('Seconds to wait for it to finish (default 45, max 50). A command still running after that keeps going; read it with terminal_output. For a dev server pass 0.'),
      cwd: z.string().optional().describe('Folder to run in: absolute, or relative to the project folder'),
      local: z.boolean().optional().describe('In a server project, run it on this computer instead (default false)'),
      ...scope,
    },
  }, async ({ command, tab, wait, cwd, local, project_path }) => {
    const target = project(project_path);
    // Both would run on this computer, which Claude on a server must never reach.
    if (serverProject && (local || tab !== undefined)) throw new Error('terminal_run with local or tab is not available to an agent on a server');
    if (tab !== undefined) throw new Error('terminal_run takes no tab: each command gets a tab of its own, and nothing is typed into another one. Leave out tab.');
    // Before the time limit starts: the person may need the whole of it.
    const refused = await deps.confirmRun(target, command, cwd, !!local);
    if (refused) throw new Error(`terminal_run: ${refused}. The command did not run. Do not retry it unchanged; ask the user what to do.`);
    const seconds = Math.min(wait ?? 45, 50);
    const limit = seconds * 1000;
    const stillRunning = (run: number) => `[still running after ${seconds} s; it keeps going. Read it with terminal_output, run ${run}]`;
    if (target.server && !local) {
      const { output, code, timedOut, run } = await deps.runOnServer(target, command, cwd, limit);
      const shown = tailOf(output, false, OUTPUT_TAIL, run);
      return said(timedOut ? `${shown}\n${stillRunning(run)}` : `${shown}\n[exit code ${code}]`, target);
    }
    deps.reveal(target, 'shell');
    await loginPathReady();
    const { output, timedOut, run, code, cut } = await deps.terminals.runCommand(inProject(commandLaunch(command, cwd), target), limit);
    const shown = tailOf(output, cut, OUTPUT_TAIL, run);
    return said(`${shown}\n${timedOut ? stillRunning(run) : code === undefined ? ENDED : `[exit code ${code}]`}`.trimStart(), target);
  });

  server.registerTool('terminal_output', {
    description: 'Whether a command started with terminal_run has finished (with its exit code when known), and the last of its output.',
    inputSchema: {
      run: z.number().int().describe('Run number from terminal_run'),
      chars: z.number().int().positive().optional().describe('How much of the output tail to return (default 8000)'),
      ...scope,
    },
  }, async ({ run, chars, project_path }) => {
    const target = project(project_path);
    const found = deps.terminals.runInfo(run);
    // Claude on a server reads only what ran on its server, never a command of this computer.
    if (!found || found.project !== target.id || (serverProject && found.kind !== 'server')) throw new Error(`no run ${run} in ${target.name}`);
    const { output, finished, code, cut } = found.state;
    const state = !finished ? '[still running]' : code === undefined ? ENDED : `[finished, exit code ${code}]`;
    return said(`${tailOf(output, !!cut, Math.min(chars ?? OUTPUT_TAIL, 60_000), run)}\n${state}`.trimStart(), target);
  });

  server.registerTool('vibex_projects', {
    description: 'Projects open in Vibex (* marks the project this call acts on) and recent projects.',
    inputSchema: {},
  }, async () => {
    let caller: string | null = null;
    try {
      caller = deps.route(windowHeader, undefined).id;
    } catch {
      // A call from outside a tab with several projects open acts on none of them; nothing gets the mark.
    }
    const lines = ['open:', ...deps.listProjects().map((p) => `${p.id === caller ? '*' : ' '} ${p.name}  ${p.server ? `${p.server}:${p.path}` : p.path}`)];
    const recents = deps.recentProjects();
    if (recents.length) lines.push('recent:', ...recents.map((r) => `  ${r.name}  ${r.server ? `${r.server}:${r.path}` : r.path}`));
    return text(lines.join('\n'));
  });

  server.registerTool('vibex_open_project', {
    description: "Open a project's own folder on this computer (a repository). It appears on the project rail; the person picks when to look at it, so a tool never changes the screen under their hands. A folder on a server is opened by the person, not by a tool.",
    inputSchema: { path: z.string().describe('Absolute path to the project folder') },
  }, async ({ path }) => text(`Opened ${deps.openProject(path).name}.`));

  const ctx: ToolContext = { project, said, scope };
  for (const module of deps.modules) module.tools?.(server, ctx);

  return server;
}

const bearerOf = (header: string | undefined) => /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? null;

function tokenMatches(header: string | undefined, token: string): boolean {
  const bearer = bearerOf(header);
  if (!bearer) return false;
  const given = Buffer.from(bearer);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function reply(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/// Streamable HTTP MCP server on 127.0.0.1 only, stateless, one server per request.
/// Checks, in order: Host (blocks DNS rebinding), no browser Origin, bearer token, POST /mcp.
export async function startMcp(deps: McpDeps, token: string, port: number): Promise<{ port: number; close: () => void }> {
  const httpServer = http.createServer(async (req, res) => {
    const actual = (httpServer.address() as AddressInfo).port;
    const host = req.headers.host ?? '';
    const full = tokenMatches(req.headers.authorization, token);
    const serverProject = full ? null : deps.serverProject(bearerOf(req.headers.authorization) ?? '');
    // Claude on a server comes through the ssh tunnel, so its Host names the port on the server. Only its token opens that.
    const hostOk = host === `127.0.0.1:${actual}` || host === `localhost:${actual}` || (!!serverProject && /^(127\.0\.0\.1|localhost):\d+$/.test(host));
    if (!hostOk) return reply(res, 403, 'bad Host header');
    if (req.headers.origin) return reply(res, 403, 'browser requests are not allowed');
    if (!full && !serverProject) return reply(res, 401, 'missing or wrong bearer token');
    if ((req.url ?? '').split('?')[0] !== '/mcp') return reply(res, 404, 'not found');
    if (req.method !== 'POST') return reply(res, 405, 'only POST is supported (stateless server)');

    // Read the whole body even when it is too large, so the client gets the 413 and not a reset connection.
    const raw = await new Promise<Buffer | null>((resolve) => {
      let size = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) tooLarge = true;
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
      req.on('error', () => resolve(Buffer.alloc(0)));
    });
    if (raw === null) return reply(res, 413, 'request too large');
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply(res, 400, 'body is not JSON');
    }

    const server = buildServer(deps, req.headers['x-vibex-window'] as string | undefined, serverProject);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) reply(res, 500, String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  return { port: (httpServer.address() as AddressInfo).port, close: () => httpServer.close() };
}
