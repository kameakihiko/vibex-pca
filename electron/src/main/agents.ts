import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, shell } from 'electron';
import { findClaude } from './claude';
import { folderProgramRefusal, gitFile, hookArgs, NO_FOLDER_PROGRAM } from './git';
import { testEnv } from './testSwitches';
import type { InboxService } from './inbox';
import type { ModuleHost } from './modules';
import type { ProjectInfo } from './projects';
import { claudeCommand, defaultShell, type Launch, type ShellKind } from './terminals';

// Parallel agents (macOS Vibex: Agents/ParallelAgents.swift): several Claude Code attempts at once, each on its own
// branch in its own git worktree, so they never touch each other's files or the project's checkout. git runs as a
// system program with an argument list, never through a shell string.

export class AgentError extends Error {
  /// The folder's Git settings can run a program, so nothing here reads it.
  problem?: boolean;
}

/// Branches this app creates for agents start with this.
export const BRANCH_PREFIX = 'vibex/';

export interface Worktree { path: string; branch: string | null }

export interface AgentInfo {
  path: string;
  branch: string;
  name: string;
  task: string | null;
  created: number | null;
  /// Files with changes that are not committed.
  changes: number;
  /// Commits on the agent's branch that the base branch does not have.
  ahead: number;
  /// What the agent's Claude waits for, when a hook said so.
  waiting?: string;
}

export interface AgentList { state: 'ready' | 'notRepository' | 'noGit'; base: string | null; agents: AgentInfo[]; problem?: string }

// ------------------------------------------------------------------ names and commands (pure)

/// "Add a dark mode toggle" gives "add-a-dark-mode-toggle": at most five words.
export function slug(text: string): string {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  const joined = words.join('-').slice(0, 60);
  if (!joined) return 'agent';
  // A Windows device name cannot be a folder name.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(joined) ? `agent-${joined}` : joined;
}

/// A name no existing agent, folder or branch uses: "dark-mode", then "dark-mode-2".
export function uniqueName(name: string, taken: Set<string>): string {
  const base = slug(name);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/// A session name starts with the project so the sessions of one project sit together in Claude's list.
export const agentSessionName = (project: string, agent: string) => `${project} - ${agent}`;

/// Windows PowerShell 5.1 hands a double quote inside an argument to a program unescaped, and 7.0 to 7.2 do the same. No
/// escape in a script can be sure of each version, so on Windows the task goes by a file and Claude gets this line.
export const TASK_FILE = '.vibex-task.txt';
export const TASK_POINTER = `Read the task in the file ${TASK_FILE} in this folder, then do it.`;

/// The agent's Claude command. The session name and the task go through the environment, so no text of the person is
/// ever part of a command line. A Windows folder name cannot hold a double quote, so the name is safe in PowerShell too.
export function agentCommand(command: string, kind: ShellKind, task: string): string {
  if (kind === 'pwsh') return `${command} --name $env:VIBEX_AGENT_NAME${task ? ' $env:VIBEX_AGENT_TASK' : ''}`;
  return `${command} --name "$VIBEX_AGENT_NAME"${task ? ' "$VIBEX_AGENT_TASK"' : ''}`;
}

/// The task, in the agent's folder, kept out of git by info/exclude: it counts as no change, and a removal takes it along.
export async function writeTaskFile(worktree: string, task: string): Promise<void> {
  const exclude = (await git(worktree, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = path.resolve(worktree, exclude);
  const line = `/${TASK_FILE}`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.split(/\r?\n/).includes(line)) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  // wx: a repository can track this name, as a file or as a link, and a link would put the task over what it names.
  try {
    writeFileSync(path.join(worktree, TASK_FILE), task, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError(`This repository already has a file named ${TASK_FILE}, so Vibex PCA cannot give the agent its task. Rename that file, then start the agent again.`);
    throw error;
  }
}

/// Where the shell cannot start Claude: the command would be a parse error, and the task would be lost. Elsewhere a login
/// shell may still know Claude (nvm), and a test may name its own command.
export function noClaudeRefusal(kind: ShellKind, claude: string | null, command: string | undefined): string | null {
  if (kind !== 'pwsh' || claude || command !== undefined) return null;
  return 'Install Claude Code first. Click the note at the top of the window to open Setup, then start the agent again.';
}

function refuseWithoutClaude(): void {
  const refusal = noClaudeRefusal(defaultShell().kind, findClaude(), testEnv('VIBEX_AGENT_COMMAND'));
  if (refusal) throw new AgentError(refusal);
}

/// Like the Claude tab of terminals.ts (agentLaunch), in the agent's worktree, with its name and task. Reopen Closed Tab
/// starts it again with no task, and only while its folder is there: a task must not run twice without a person asking.
export function agentLaunch(project: ProjectInfo, worktree: string, name: string, task: string): Launch {
  const shellLaunch = defaultShell();
  const base = testEnv('VIBEX_AGENT_COMMAND') ?? claudeCommand(shellLaunch.kind);
  const title = agentSessionName(project.name, name);
  // A task that starts with a dash must not read as an option.
  const text = shellLaunch.kind === 'pwsh' && task ? TASK_POINTER : task.startsWith('-') ? `Task: ${task}` : task;
  const env = { VIBEX_PROJECT: project.path, VIBEX_WINDOW: project.id, VIBEX_AGENT_NAME: title, VIBEX_AGENT_TASK: text };
  const rebuild = () => {
    if (!existsSync(worktree)) throw new AgentError(`The folder of ${name} is gone.`);
    return agentLaunch(project, worktree, name, '');
  };
  const common = { ...shellLaunch, pane: 'agent' as const, title, cwd: worktree, project: project.id, env, rebuild };
  if (!base) return common;
  const command = agentCommand(base, shellLaunch.kind, text);
  const args = shellLaunch.kind === 'pwsh' ? ['-NoLogo', '-NoExit', '-Command', command] : ['-l', '-c', `${command}; exec "${shellLaunch.file}" -l`];
  return { ...common, args };
}

/// `git worktree list --porcelain`: the first entry is the project's own checkout.
export function parseWorktrees(text: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const tree = lines.find((l) => l.startsWith('worktree '));
    if (!tree) continue;
    const branch = lines.find((l) => l.startsWith('branch '));
    list.push({ path: tree.slice('worktree '.length), branch: branch ? branch.slice('branch '.length).replace(/^refs\/heads\//, '') : null });
  }
  return list;
}

// ------------------------------------------------------------------ git

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // --no-optional-locks: a status that refreshes the index must not make the person's own git command fail.
    execFile(gitFile(), [...NO_FOLDER_PROGRAM, '--no-optional-locks', ...args], { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new AgentError('Git is not installed, or it is not on the PATH. Install Git, then try again.'));
      const detail = String(stderr || stdout || error.message).trim().split(/\r?\n/)[0];
      reject(Object.assign(new AgentError(detail), { stderr: String(stderr), stdout: String(stdout) }));
    });
  });
}

/// A git command that changes something. The folder's hooks are programs it chose, and this app has no trust step for a
/// folder that came from someone, so they do not run, as on Commit (git.ts). The caller refuses first (refuseFolderProgram).
const gitWrite = async (cwd: string, args: string[]) => git(cwd, [...(await hookArgs(cwd)), ...args]);

const real = (file: string) => {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};
const same = (a: string, b: string) => (process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));
export const isInside = (child: string, parent: string) => {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/// All worktrees of the repository the folder belongs to, the project's own checkout first. Null: not a repository.
async function refuseFolderProgram(folder: string): Promise<void> {
  const refusal = await folderProgramRefusal(folder);
  if (refusal) throw Object.assign(new AgentError(refusal), { problem: true });
}

async function worktreesOf(folder: string): Promise<Worktree[] | null> {
  try {
    await refuseFolderProgram(folder);
    return parseWorktrees(await git(folder, ['worktree', 'list', '--porcelain']));
  } catch (error) {
    if (/Git is not installed/.test(String(error)) || (error as AgentError).problem) throw error;
    return null;
  }
}

const count = async (cwd: string) => (await refuseFolderProgram(cwd), await git(cwd, ['status', '--porcelain'])).split(/\r?\n/).filter(Boolean).length;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ------------------------------------------------------------------ what each agent was asked (agents.json)

interface Note { name: string; task: string | null; created: number }

function readNotes(root: string): Record<string, Note> {
  try {
    return JSON.parse(readFileSync(path.join(root, 'agents.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeNotes(root: string, notes: Record<string, Note>): void {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'agents.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(notes, null, 2));
  renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------ actions

export async function listAgents(folder: string, root: string): Promise<AgentList> {
  let trees: Worktree[] | null;
  try {
    trees = await worktreesOf(folder);
  } catch (error) {
    if ((error as AgentError).problem) return { state: 'notRepository', base: null, agents: [], problem: (error as AgentError).message };
    return { state: 'noGit', base: null, agents: [] };
  }
  if (!trees?.length) return { state: 'notRepository', base: null, agents: [] };
  const main = trees[0];
  const base = await git(main.path, ['symbolic-ref', '--short', '-q', 'HEAD']).then((s) => s.trim() || null, () => null);
  const notes = readNotes(root);
  const agents: AgentInfo[] = [];
  for (const tree of trees.slice(1)) {
    if (!tree.branch || !existsSync(tree.path)) continue;
    const note = notes[real(tree.path)];
    agents.push({
      path: tree.path,
      branch: tree.branch,
      name: note?.name ?? (tree.branch.startsWith(BRANCH_PREFIX) ? tree.branch.slice(BRANCH_PREFIX.length) : tree.branch),
      task: note?.task ?? null,
      created: note?.created ?? null,
      changes: await count(tree.path).catch(() => 0),
      ahead: base ? Number((await git(main.path, ['rev-list', '--count', `${base}..${tree.branch}`]).catch(() => '0')).trim()) : 0,
    });
  }
  agents.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  return { state: 'ready', base, agents };
}

/// Creates the worktree and branch from the base branch's last commit.
export async function createAgent(folder: string, root: string, name: string, task: string | undefined): Promise<{ path: string; branch: string; name: string }> {
  const trees = await worktreesOf(folder);
  if (!trees?.length) throw new AgentError('This folder is not a git repository, so agents have no worktree to work in.');
  const main = trees[0].path;
  const taken = new Set<string>(trees.map((t) => path.basename(t.path)));
  if (existsSync(root)) for (const entry of readdirSync(root)) taken.add(entry);
  for (const branch of (await git(main, ['branch', '--list', `${BRANCH_PREFIX}*`])).split(/\r?\n/)) taken.add(branch.replace(/^[*+ ]+/, '').trim().slice(BRANCH_PREFIX.length));
  const unique = uniqueName(name, taken);
  const target = path.join(root, unique);
  mkdirSync(root, { recursive: true });
  const branch = BRANCH_PREFIX + unique;
  await refuseFolderProgram(main);
  try {
    await gitWrite(main, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  } catch (error) {
    if (/not a valid object name|invalid reference/i.test(String(error))) throw new AgentError('The repository has no commit yet. Make a first commit, then start an agent.');
    throw error;
  }
  const notes = readNotes(root);
  notes[real(target)] = { name: unique, task: task?.trim() ? task.trim() : null, created: Date.now() };
  writeNotes(root, notes);
  return { path: real(target), branch, name: unique };
}

/// The agent at `target`, or a plain refusal: a path git does not list as a linked worktree is never touched.
async function agentAt(folder: string, target: string): Promise<{ main: string; tree: Worktree; name: string }> {
  const trees = await worktreesOf(folder);
  if (!trees?.length) throw new AgentError('This folder is not a git repository.');
  const tree = trees.slice(1).find((t) => t.branch && same(t.path, target));
  if (!tree) throw new AgentError(`${path.basename(target)} is not an agent of this project.`);
  return { main: trees[0].path, tree, name: tree.branch!.startsWith(BRANCH_PREFIX) ? tree.branch!.slice(BRANCH_PREFIX.length) : tree.branch! };
}

async function refuseIfDirty(tree: string, name: string): Promise<void> {
  const n = await count(tree);
  if (n) throw new AgentError(`${name} has ${n} ${plural(n, 'change that is not committed', 'changes that are not committed')}, so it stays. Commit or discard ${plural(n, 'it', 'them')} in its folder first.`);
}

/// Deletes the worktree and the note. The branch goes too if it was merged; otherwise it stays, so nothing is lost.
/// On a failed delete `git worktree remove` has dropped its record already (builtin/worktree.c: "no going back from here"),
/// so the agent has no row and no Remove any more. What is left goes here, only inside the app's own folder for agents.
async function dropWorktree(main: string, root: string, tree: Worktree, name: string): Promise<string> {
  let left: string | null = null;
  // Outside the try: a refusal is no failed delete, and it must leave the folder alone.
  await refuseFolderProgram(main);
  try {
    await gitWrite(main, ['worktree', 'remove', tree.path]);
  } catch (error) {
    const listed = (await worktreesOf(main).catch(() => null))?.some((t) => same(t.path, tree.path));
    if (listed) throw error;
    left = isInside(tree.path, root) ? await removeRest(tree.path) : tree.path;
  }
  const notes = readNotes(root);
  delete notes[real(tree.path)];
  // A note left over reads as nothing: git lists the agents, and the notes only name them.
  try {
    writeNotes(root, notes);
  } catch { /* the folder for agents cannot be written */ }
  const deleted = await refuseFolderProgram(main).then(() => gitWrite(main, ['branch', '-d', tree.branch!])).then(() => true, () => false);
  if (left) return `Removed ${name} from the list, but some of its files stayed, because a program still uses them. Close that program, then delete the folder ${path.normalize(left)}. ${deleted ? '' : `Its branch ${tree.branch} is kept.`}`.trim();
  return deleted ? `Removed ${name} and its branch.` : `Removed ${name}. Its branch ${tree.branch} was not merged, so it is kept.`;
}

const RETRIES = 6;
const RETRY_MS = 250;

/// A lock on Windows often ends within a second or two: the shell's last child, an antivirus scan. Null when the folder went.
async function removeRest(folder: string): Promise<string | null> {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      rmSync(folder, { recursive: true, force: true });
      return null;
    } catch { /* still in use */ }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  return folder;
}

/// `prepare` runs once the agent is known to be clean and before anything changes. It can refuse (throw an AgentError),
/// so a person who says no leaves the merge and the folder as they were.
export interface Prepare { prepare?: (worktree: string, name: string) => Promise<void> }

export async function removeAgent(folder: string, root: string, target: string, hooks: Prepare = {}): Promise<string> {
  const { main, tree, name } = await agentAt(folder, target);
  await refuseIfDirty(tree.path, name);
  await hooks.prepare?.(tree.path, name);
  return dropWorktree(main, root, tree, name);
}

/// Merges the agent's branch into the project's current branch, then removes the agent. Nothing changes when the
/// agent or the project folder has uncommitted changes, or when the merge conflicts.
export async function finishAgent(folder: string, root: string, target: string, hooks: Prepare = {}): Promise<string> {
  const { main, tree, name } = await agentAt(folder, target);
  await refuseIfDirty(tree.path, name);
  const n = await count(main);
  if (n) throw new AgentError(`The project folder has ${n} ${plural(n, 'change that is not committed', 'changes that are not committed')}. Commit or stash ${plural(n, 'it', 'them')}, then finish ${name} again.`);
  const base = (await git(main, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (!base) throw new AgentError('The project folder is not on a branch. Switch to the branch to merge into, then finish again.');
  await hooks.prepare?.(tree.path, name);
  await refuseFolderProgram(main);
  try {
    await gitWrite(main, ['merge', '--no-edit', tree.branch!]);
  } catch (error) {
    const conflicts = (await git(main, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split(/\r?\n/).filter(Boolean);
    await gitWrite(main, ['merge', '--abort']).catch(() => undefined);
    if (conflicts.length) throw new AgentError(`Merging ${tree.branch} into ${base} has a conflict in ${conflicts.join(', ')}; nothing was changed and ${name} stays.`);
    if (/tell me who you are|empty ident|unable to auto-detect/i.test(String((error as any).stderr ?? error))) {
      throw new AgentError('Git needs your name and email for the merge. Set them with git config --global user.name and user.email, then try again.');
    }
    throw error;
  }
  const merged = `Merged ${tree.branch} into ${base}.`;
  // The merge is done and stays done. If the folder cannot be removed, the answer says so apart from the merge. Here git
  // still lists the agent, so Remove can try again.
  try {
    return `${merged} ${await dropWorktree(main, root, tree, name)}`;
  } catch (error) {
    const detail = String((error as Error).message ?? error).replace(/^Error: /, '').slice(0, 200);
    return `${merged} The folder of ${name} was not removed: ${detail} Close what uses the folder, then press Remove.`;
  }
}

// ------------------------------------------------------------------ the service

const TAB_EXIT_LIMIT_MS = 5000;

export class AgentsService {
  private host!: ModuleHost;
  private inbox!: InboxService;
  start(host: ModuleHost, inbox: InboxService): void {
    this.host = host;
    this.inbox = inbox;
    host.handle('mod:agents:list', async (projectId: string) => this.list(this.local(projectId)));
    host.handle('mod:agents:create', (projectId: string, name: string, task: string) => this.guard(async () => {
      const project = this.local(projectId);
      const cleanName = String(name ?? '').trim().slice(0, 80);
      const cleanTask = String(task ?? '').trim().slice(0, 4000);
      if (!cleanName && !cleanTask) throw new AgentError('Give the agent a name or a task.');
      refuseWithoutClaude();
      const made = await createAgent(project.path, this.root(project), cleanName || cleanTask, cleanTask);
      if (cleanTask && defaultShell().kind === 'pwsh') {
        // No task, no agent: nothing has run in the new folder yet.
        await writeTaskFile(made.path, cleanTask).catch(async (error) => {
          await removeAgent(project.path, this.root(project), made.path).catch(() => undefined);
          throw error;
        });
      }
      this.openTab(project, made.path, made.name, cleanTask);
      return `Started ${made.name} on ${made.branch}.`;
    }));
    host.handle('mod:agents:open', (projectId: string, target: string) => this.guard(async () => {
      const project = this.local(projectId);
      refuseWithoutClaude();
      const { tree, name } = await agentAt(project.path, String(target));
      // The agent has its task already; a second tab is for a person to go on.
      this.openTab(project, tree.path, name, '');
      return `Opened a Claude tab for ${name}.`;
    }));
    host.handle('mod:agents:finish', (projectId: string, target: string) => this.guard(async () => {
      const project = this.local(projectId);
      return finishAgent(project.path, this.root(project), String(target), { prepare: (tree, name) => this.releaseTabs(tree, name, 'finish') });
    }));
    host.handle('mod:agents:remove', (projectId: string, target: string) => this.guard(async () => {
      const project = this.local(projectId);
      return removeAgent(project.path, this.root(project), String(target), { prepare: (tree, name) => this.releaseTabs(tree, name, 'remove') });
    }));
    host.handle('mod:agents:reveal', async (projectId: string, target: string) => {
      const project = this.local(projectId);
      const { tree } = await agentAt(project.path, String(target));
      void shell.openPath(tree.path);
    });
  }

  private local(projectId: string): ProjectInfo {
    const project = this.host.projects.get(String(projectId));
    if (!project) throw new Error('no such project');
    if (project.server) throw new AgentError('Agents work on folders on this computer, not on a server.');
    return project;
  }

  /// Where the project's agent worktrees and notes live: <profile>/Agents/<project id>.
  private root(project: ProjectInfo): string {
    return path.join(this.host.userData, 'Agents', project.id);
  }

  private async guard(work: () => Promise<string>): Promise<{ ok: boolean; message: string }> {
    try {
      return { ok: true, message: await work() };
    } catch (error) {
      if (error instanceof AgentError) return { ok: false, message: error.message };
      return { ok: false, message: `Something went wrong: ${String(error).replace(/^Error: /, '').slice(0, 200)}` };
    }
  }

  private async list(project: ProjectInfo): Promise<AgentList> {
    const list = await listAgents(project.path, this.root(project));
    const waiting = this.inbox.waitingIn(project.id);
    for (const agent of list.agents) {
      const found = waiting.find((w) => w.cwd && isInside(w.cwd, agent.path));
      if (found) agent.waiting = found.message;
    }
    return list;
  }

  /// A new Claude tab in the agent's worktree, named after the project. It belongs to the project, so Claude's
  /// tool calls from it act on the project.
  private openTab(project: ProjectInfo, worktree: string, name: string, task: string): void {
    this.host.terminals.create(agentLaunch(project, worktree, name, task));
    this.host.reveal(project, 'agent');
  }

  /// Windows does not delete a folder that a program uses, and the agent's tab holds its folder (the shell stays open
  /// there). So before a merge or a removal the tabs of the folder close, after the person agrees. Elsewhere the
  /// folder can go while a tab is open, so nothing is asked.
  private async releaseTabs(worktree: string, name: string, action: 'finish' | 'remove'): Promise<void> {
    const locks = process.platform === 'win32' || testEnv('VIBEX_AGENT_TAB_LOCK') === '1';
    const mine = this.host.terminals.tabsIn(worktree, isInside);
    if (!locks || !mine.length) return;
    const tabs = `${mine.length} ${plural(mine.length, 'tab', 'tabs')}`;
    const answer = (globalThis as any).__vibexTest?.agentTabAnswer;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const { response } = answer !== undefined ? { response: answer as number } : await dialog.showMessageBox(...(win ? [win] : []) as [BrowserWindow], {
      type: 'warning',
      message: `Close ${tabs} of ${name}?`,
      detail: `${name} has ${tabs} open in its folder. Windows cannot delete a folder that is in use, so ${plural(mine.length, 'it', 'they')} must close before ${action === 'finish' ? 'the merge and the removal' : 'the removal'}. What runs there stops.`,
      buttons: [action === 'finish' ? 'Close and Finish' : 'Close and Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) throw new AgentError(`${name} has ${tabs} open in its folder. Windows cannot delete a folder that is in use. Close ${plural(mine.length, 'it', 'them')}, then try again. Nothing was changed.`);
    await Promise.all(mine.map((id) => this.host.terminals.closeAndWait(id, TAB_EXIT_LIMIT_MS)));
    // The exit comes a moment before Windows lets go of the folder.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
