import { app, dialog, Menu, shell } from 'electron';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { addServer, checkHealth, claudeBinary, installedServers, removeServer, type McpAddInput } from './mcpServers';
import type { ModuleHost, ToolContext, VibexModule } from './modules';
import { menuCommands, runMenuCommand } from './palette';
import type { ProjectInfo } from './projects';
import { Runner, RUN_FILE } from './run';
import { claudeInstallCommand, pageFor, runChecks } from './setup';
import { listSkills, readSkill, removeSkill, skillFolderReal, undoRemoveSkill, type SkillScope } from './skills';
import { defaultShell, inProject } from './terminals';
import { testEnv } from './testSwitches';
import { countUsage, setUsage, UsageCounter, usage } from './usage';
import { refreshWindowsPath } from './windowsPath';

// Skills, MCP servers, Run, the command palette, Setup and the usage counter: the macOS Vibex features
// (Skills/, MCPServers/, Run/, Palette/, Setup/, Support/Usage.swift) that need no Simulator.
// Each part lives in its own file; this file wires them to IPC, the menu bar and the MCP tools.

let host: ModuleHost | null = null;
let runner: Runner | null = null;

const SCOPES: SkillScope[] = ['global', 'project'];

/// PowerShell drops what is typed while it starts, so the installer line would be lost and the tab would show a bare prompt (run
/// 41400652008). A changed prompt never matches: the wait then ends at its limit, and the line goes as before.
async function windowsPromptShown(terminals: { buffer(id: number): string }, tab: number): Promise<void> {
  if (process.platform !== 'win32') return;
  const end = Date.now() + 8000;
  // eslint-disable-next-line no-control-regex
  while (Date.now() < end && !/PS [^\r\n]*> ?$/.test(terminals.buffer(tab).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd() + ' ')) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function projectOf(id: unknown): ProjectInfo {
  const project = host!.projects.get(String(id));
  if (!project) throw new Error('That project is not open.');
  return project;
}

/// Skills, MCP servers and Run read this computer's folders; a project on a server has none here.
function localProject(id: unknown): ProjectInfo {
  const project = projectOf(id);
  if (project.server) throw new Error(`${project.name} is on the server ${project.server}. This works on projects on this computer.`);
  return project;
}

const scopeOf = (scope: unknown): SkillScope => {
  if (!SCOPES.includes(scope as SkillScope)) throw new Error('That is not a place for skills.');
  return scope as SkillScope;
};

/// The shell tab of the project that a typed command goes to: its first local shell tab, else a new one.
function shellTab(project: ProjectInfo, wanted?: unknown): number {
  const usable = (t: { alive: boolean; project: string; pane: string; kind: string }) => t.alive && t.project === project.id && t.pane === 'shell' && t.kind !== 'none';
  // The tab the person sees, when it is one of this project's local shell tabs.
  const seen = typeof wanted === 'number' ? host!.terminals.list().find((t) => t.id === wanted && usable(t)) : undefined;
  // A program in front of it would take the line as its input.
  if (seen && !host!.terminals.busy(seen.id)) return seen.id;
  if (project.server) throw new Error(`${project.name} runs on the server ${project.server}; open its terminal tab and type there.`);
  const tab = host!.terminals.list().find((t) => usable(t) && !host!.terminals.busy(t.id));
  return tab ? tab.id : host!.terminals.create(inProject(defaultShell(), project)).id;
}

function start(h: ModuleHost): void {
  host = h;
  setUsage(new UsageCounter(path.join(h.userData, 'usage.json')));
  app.on('will-quit', () => usage()?.flush());

  // Removed skills wait 30 days for an Undo, then they go.
  const trash = path.join(h.userData, 'removed-skills');
  try {
    for (const name of readdirSync(trash)) {
      if (Date.now() - statSync(path.join(trash, name)).mtimeMs > 30 * 86_400_000) rmSync(path.join(trash, name), { recursive: true, force: true });
    }
  } catch {
    // no removed skills yet
  }

  runner = new Runner({
    terminals: h.terminals,
    navigate: async (project, url) => {
      h.reveal(project, 'browser');
      return h.browserFor(project).navigate(url);
    },
    reveal: (project) => h.reveal(project, 'shell'),
    changed: (state) => h.send('mod:run:state', state),
    userData: h.userData,
    approve: async (project, command) => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Run the command from ${RUN_FILE}?`,
        detail: `${project.name} asks to run:\n\n${command}\n\nOnly run it if you trust this project. Vibex asks once for each command.`,
        buttons: ['Run', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
  });

  // ---- skills ----
  h.handle('mod:skills:list', (id) => {
    const project = localProject(id);
    return { global: listSkills('global', project.path), project: listSkills('project', project.path) };
  });
  h.handle('mod:skills:read', (id, scope, name) => readSkill(scopeOf(scope), localProject(id).path, name));
  h.handle('mod:skills:reveal', (id, scope, name) => {
    shell.showItemInFolder(skillFolderReal(scopeOf(scope), localProject(id).path, name));
  });
  h.handle('mod:skills:remove', (id, scope, name) => {
    const token = removeSkill(trash, scopeOf(scope), localProject(id).path, name);
    countUsage('ui.skills.remove');
    return token;
  });
  h.handle('mod:skills:undo', (token) => undoRemoveSkill(trash, String(token)));

  // ---- MCP servers ----
  h.handle('mod:mcp:list', (id) => ({ servers: installedServers(localProject(id).path), claude: !!claudeBinary() }));
  h.handle('mod:mcp:health', (id) => checkHealth(localProject(id).path));
  h.handle('mod:mcp:add', async (id, input: McpAddInput) => {
    await addServer(localProject(id).path, input);
    countUsage('ui.mcp.add');
  });
  h.handle('mod:mcp:remove', async (id, name, scope) => {
    await removeServer(localProject(id).path, String(name), scope);
    countUsage('ui.mcp.remove');
  });

  // ---- run ----
  h.handle('mod:run:state', (id) => runner!.state(projectOf(id)));
  h.handle('mod:run:start', (id) => runner!.run(projectOf(id), false));
  h.handle('mod:run:stop', (id) => runner!.stop(projectOf(id)));

  // ---- setup ----
  h.handle('mod:setup:check', (id) => {
    refreshWindowsPath();
    return runChecks(localProjectOrHome(id));
  });
  h.handle('mod:setup:act', async (id, item) => {
    if (item === 'claude') {
      if (!id) throw new Error('Open a project first. The installer runs in the command terminal of a project.');
      const project = projectOf(id);
      const tab = shellTab(project);
      h.reveal(project, 'shell');
      // Tests must never run the real installer.
      await windowsPromptShown(h.terminals, tab);
      h.terminals.write(tab, `${testEnv('VIBEX_INSTALL_COMMAND') ?? claudeInstallCommand()}\r`);
      return 'The installer runs in the command terminal.';
    }
    const url = pageFor(String(item));
    if (!url) throw new Error('There is nothing to open for that.');
    return shell.openExternal(url).then(() => 'Opened the download page in your browser.');
  });

  // ---- usage ----
  h.handle('mod:usage:rows', () => usage()?.rows() ?? []);
  // The page may count only its own fixed feature names, never text it was handed.
  h.on('mod:usage:count', (key) => {
    if (typeof key === 'string' && /^(ui|palette)\.[A-Za-z0-9._-]{1,60}$/.test(key)) countUsage(key);
  });

  // ---- palette ----
  h.handle('mod:palette:commands', () => menuCommands(Menu.getApplicationMenu()));
  h.handle('mod:palette:run', (id) => runMenuCommand(Menu.getApplicationMenu(), String(id)));
  h.handle('mod:palette:shell', (id, command, tab) => {
    const text = String(command ?? '');
    if (!text.trim() || /[\0]/.test(text)) throw new Error('Type a command after the $.');
    h.terminals.write(shellTab(projectOf(id), tab), `${text}\r`);
    h.reveal(projectOf(id), 'shell');
  });
}

/// Setup checks run on this computer; a server project has no folder here, so the check uses the home folder.
function localProjectOrHome(id: unknown): string {
  // Setup also opens with no project, from the welcome screen.
  if (!id) return process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const project = projectOf(id);
  return project.server ? (process.env.HOME ?? process.env.USERPROFILE ?? '.') : project.path;
}

const view = z.enum(['browser', 'both', 'simulator', 'notes']);

function tools(server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, ctx: ToolContext): void {
  const say = (text: string, target: ProjectInfo) => ctx.said(text, target);
  const scope = ctx.scope as { project_path: z.ZodOptional<z.ZodString> };

  server.registerTool('vibex_run', {
    description: "Run the project: web projects start the dev server and open it in the side browser once it answers; others run their command in a Run tab of the command terminal. Uses .vibex.json or detects from the folder. Returns once started; check vibex_run_status.",
    inputSchema: { ...scope },
  }, async ({ project_path }) => {
    const target = ctx.project(project_path);
    countUsage('ui.run.tool');
    return say(await runner!.run(target, true), target);
  });

  server.registerTool('vibex_stop', {
    description: 'Stop the running dev server or command.',
    inputSchema: { ...scope },
  }, async ({ project_path }) => {
    const target = ctx.project(project_path);
    return say(runner!.stop(target), target);
  });

  server.registerTool('vibex_run_status', {
    description: 'Where the current run is (running, serving, failed…), its exit code and the last lines of its output. Poll this after vibex_run.',
    inputSchema: { lines: z.number().int().positive().optional().describe('How many output lines (default 60)'), ...scope },
  }, async ({ lines, project_path }) => {
    const target = ctx.project(project_path);
    return say(runner!.status(target, Math.min(lines ?? 60, 400)), target);
  });

  server.registerTool('vibex_usage', {
    description: "Read-only: how often each Vibex feature (MCP tools, the Run button, palette commands) was used on this computer in the last 7 and 30 days, most used first. Counts only; no URLs, arguments or names are kept.",
    inputSchema: {},
  }, async () => ({ content: [{ type: 'text' as const, text: usage()?.table() ?? 'No usage counted yet.' }] }));

  server.registerTool('vibex_view', {
    description: 'Show the browser as the selected tab of the middle column (the page, not a document tab). Use it to show something without acting on it. The simulator and the combined view belong to macOS Vibex.',
    inputSchema: { view: view.describe('What to show'), ...scope },
  }, async ({ view: what, project_path }) => {
    const target = ctx.project(project_path);
    if (what === 'both' || what === 'simulator') return say('The iOS Simulator is only in Vibex on a Mac. Use view browser here.', target);
    if (what === 'notes') return say('Notes open from the Notes button in the sidebar; this tool cannot open them here.', target);
    host!.reveal(target, 'browser');
    host!.send('mod:workspace:do', target.id, 'view-browser');
    return say('Showing the browser.', target);
  });

  server.registerTool('vibex_layout', {
    description: 'Switch the window layout. build: wide Claude column, narrow browser. watch: wide browser. balanced: the columns where the person had put them.',
    inputSchema: { mode: z.enum(['build', 'watch', 'balanced']).describe('Layout mode'), ...scope },
  }, async ({ mode, project_path }) => {
    const target = ctx.project(project_path);
    host!.send('mod:workspace:do', target.id, 'layout', mode);
    return say(`Layout: ${mode}.`, target);
  });

  server.registerTool('vibex_focus', {
    description: 'Give keyboard focus to a column: terminal (the Claude terminal), command (the command terminal) or browser. Focus moves only when the project is on screen; its column is shown either way.',
    inputSchema: { pane: z.enum(['terminal', 'command', 'simulator', 'browser', 'agents']).describe('Column'), ...scope },
  }, async ({ pane, project_path }) => {
    const target = ctx.project(project_path);
    if (pane === 'simulator') return say('The iOS Simulator is only in Vibex on a Mac.', target);
    if (pane === 'agents') return say('The Claude usage tab is only in Vibex on a Mac.', target);
    const onScreen = host!.projects.current()?.id === target.id;
    if (pane === 'browser') {
      host!.reveal(target, 'browser');
      if (onScreen) host!.browserFor(target).view.webContents.focus();
    } else {
      host!.send('mod:workspace:do', target.id, 'focus', pane === 'terminal' ? 'agent' : 'shell');
    }
    return say(onScreen ? 'Focused.' : 'Shown. The project is not on screen, so the keyboard stays where it is.', target);
  });
}

function menu(command: (name: string, arg?: string) => () => void) {
  const current = () => host?.projects.current() ?? null;
  return [
    {
      menu: 'View',
      items: [
        { type: 'separator' as const },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: command('palette') },
        { label: 'Setup', click: command('setup') },
        { label: 'Usage', click: command('usage') },
      ],
    },
    {
      menu: 'Run',
      items: [
        { label: 'Run Project', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const p = current(); if (p && runner) { countUsage('ui.run.menu'); void runner.run(p, false); } } },
        { label: 'Stop', click: () => { const p = current(); if (p && runner) { countUsage('ui.stop.menu'); runner.stop(p); } } },
      ],
    },
  ];
}

export const pcaToolsModule: VibexModule = { name: 'pca-tools', start, tools, menu };
