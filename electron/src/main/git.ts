import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { programPath } from './programs';

// System git, run with an argument array and no shell, in the project's folder. Ported from
// Vibex/SourceControl/Git.swift: status, stage, unstage, commit, branches, history and diffs.
// Left out on purpose: discard (it destroys work), push, pull and worktrees.

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typeChanged' | 'untracked' | 'conflicted';
export type Area = 'staged' | 'unstaged' | 'conflicted';
export interface Change { path: string; originalPath?: string; kind: ChangeKind; area: Area }
export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Change[];
  unstaged: Change[];
  conflicted: Change[];
}
export type RepoStatus = { repo: false } | (Status & { repo: true; clean: boolean; hooksSkipped: boolean });
export interface Commit { hash: string; short: string; author: string; time: number; subject: string }
export interface Patch { text: string; truncated: boolean }

/// Diffs bigger than this are cut off; nobody reads a 40 MB diff in a sidebar.
export const DIFF_LIMIT = 2_000_000;

interface Run { code: number; out: string; err: string; truncated: boolean }

/// Before every git command: a folder's .git/config must not start a program when the app only looks (security review).
export const NO_FOLDER_PROGRAM = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];

export const gitFile = () => programPath('git');

/// Never rejects for a git failure: the exit code says what happened. It rejects only when git is not there.
export function runGit(cwd: string, args: string[], opts: { input?: string; limit?: number; plain?: boolean } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    let program: string;
    try {
      program = gitFile();
    } catch {
      return reject(new Error(missingGit()));
    }
    const child = execFile(
      program,
      // Paths are literal: a file named ":(glob)*" must not act as a pathspec. check-ignore refuses the flag (`plain`).
      [...NO_FOLDER_PROGRAM, ...(opts.plain ? args : ['--literal-pathspecs', ...args])],
      {
        cwd,
        windowsHide: true,
        maxBuffer: opts.limit ?? 16_000_000,
        encoding: 'utf8',
        // English messages (matched below), no password prompt that nobody can see, no index lock for a read.
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, out: stdout, err: stderr, truncated: false });
        const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (e.code === 'ENOENT') return reject(new Error(missingGit()));
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: 0, out: e.stdout ?? '', err: '', truncated: true });
        resolve({ code: typeof e.code === 'number' ? e.code : 1, out: e.stdout ?? '', err: e.stderr || String(e.message), truncated: false });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

const missingGit = () =>
  process.platform === 'win32' ? 'Git is not installed. Install Git for Windows from https://github.com/git-for-windows/git/releases/latest.' : 'Git is not installed. Install it with your package manager.';

/// Git's own words made plain, as `GitProblem.explain` does in the Swift app.
export function explain(raw: string): string {
  const text = raw.toLowerCase();
  if (text.includes('would be overwritten') || text.includes('please commit your changes or stash'))
    return 'You have changes that this would lose. Commit them first.';
  if (text.includes('please tell me who you are') || text.includes('unable to auto-detect email'))
    return 'Git does not know your name yet. Set user.name and user.email with git config --global.';
  if (text.includes('index.lock')) return 'Another git command is running in this folder. Try again when it finishes.';
  if (text.includes('not a git repository')) return 'This folder is not a git repository.';
  let message = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('hint:')) ?? raw.trim();
  for (const prefix of ['fatal: ', 'error: ']) if (message.startsWith(prefix)) message = message.slice(prefix.length);
  return message ? message[0].toUpperCase() + message.slice(1) : 'Git did not say why.';
}

async function ok(cwd: string, args: string[], opts?: { input?: string; limit?: number }): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) throw new Error(explain(r.err || r.out));
  return r.out;
}

/// The top of the working tree that holds the project folder; git reports paths from there.
export async function repoTop(folder: string): Promise<string | null> {
  const r = await runGit(folder, ['rev-parse', '--show-toplevel']);
  const top = r.code === 0 ? r.out.trim() : '';
  return top ? path.normalize(top) : null;
}

async function needTop(folder: string): Promise<string> {
  const top = await repoTop(folder);
  if (!top) throw new Error('This folder is not a git repository yet.');
  return top;
}

/// A filter, an ssh command or a signature program in the folder's own settings is a program the folder chose. One in the
/// person's own settings (git-lfs, say) is theirs, so it stays. Null: nothing to refuse. Keys only: a value may hold anything.
export async function folderProgramRefusal(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['config', '--show-scope', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|core\\.sshcommand|gpg\\.program|gpg\\.[^.]+\\.program|gpg\\.ssh\\.defaultkeycommand)$'], { plain: true });
  if (r.code === 1) return null;
  if (r.code !== 0) return 'Git could not list the settings of this folder, so Vibex does not read this repository. Git 2.26 or newer is needed.';
  const keys = [...r.out.matchAll(/^(?:local|worktree)\t(\S+)/gm)].map((m) => m[1]);
  return keys.length ? `This folder's Git settings can run a program (${keys.join(', ')}), so Vibex does not read this repository. Remove that setting if you do not trust it, then look again.` : null;
}

/// The top of the repository, for a read: it runs no program the folder chose.
async function readTop(folder: string): Promise<string> {
  const top = await needTop(folder);
  const refusal = await folderProgramRefusal(top);
  if (refusal) throw new Error(refusal);
  return top;
}

/// A folder's hook is a program the folder chose, and this app has no trust step for a folder that came from someone. So a
/// Commit or a branch change runs with no hook, unless the hooks are the person's own (core.hooksPath in their settings).
const NO_HOOKS = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`];

async function hooksArePersons(top: string): Promise<boolean | null> {
  const r = await runGit(top, ['config', '--show-scope', '--get-regexp', '^core\\.hookspath$'], { plain: true });
  const last = r.out.split('\n').filter(Boolean).at(-1);
  return last ? /^(global|system)\t/.test(last) : null;
}

export const hookArgs = async (top: string) => ((await hooksArePersons(top)) === true ? [] : NO_HOOKS);

/// The Git section says so when it skips a hook: a project with a pre-commit check must not lose it with no word.
async function hooksSkipped(top: string): Promise<boolean> {
  const own = await hooksArePersons(top);
  if (own !== null) return !own;
  const r = await runGit(top, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) return false;
  try {
    return (await fs.readdir(path.resolve(top, r.out.trim(), 'hooks'))).some((name) => !name.endsWith('.sample'));
  } catch {
    return false;
  }
}

/// A path git acts on: relative to the repository, inside it.
function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('That is not a file path.');
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || norm === '..' || norm.startsWith('../') || norm === '.') throw new Error('That path is outside the project.');
  return norm;
}

// ---------- status ----------

const KINDS: Record<string, ChangeKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged' };

/// Parses NUL-separated `status --porcelain=v1 --branch -z`. A rename carries its old path as the next field.
export function parseStatus(output: string): Status {
  const s: Status = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] };
  const fields = output.split('\0').filter(Boolean);
  while (fields.length) {
    const field = fields.shift()!;
    if (field.startsWith('## ')) {
      parseBranch(s, field.slice(3));
      continue;
    }
    if (field.length < 4) continue;
    const x = field[0];
    const y = field[1];
    const file = field.slice(3);
    const original = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? fields.shift() : undefined;
    if (x === '?' && y === '?') {
      s.unstaged.push({ path: file, kind: 'untracked', area: 'unstaged' });
    } else if (x === '!') {
      continue;
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      s.conflicted.push({ path: file, kind: 'conflicted', area: 'conflicted' });
    } else {
      if (x !== ' ' && KINDS[x]) s.staged.push({ path: file, originalPath: original, kind: KINDS[x], area: 'staged' });
      if (y !== ' ' && KINDS[y]) s.unstaged.push({ path: file, originalPath: original, kind: KINDS[y], area: 'unstaged' });
    }
  }
  return s;
}

/// `main...origin/main [ahead 1, behind 2]`, `HEAD (no branch)` or `No commits yet on main`.
function parseBranch(s: Status, line: string): void {
  let head = line;
  const bracket = head.indexOf(' [');
  if (bracket >= 0) {
    for (const part of head.slice(bracket + 2, -1).split(',')) {
      const [word, n] = part.trim().split(' ');
      if (word === 'ahead') s.ahead = Number(n) || 0;
      if (word === 'behind') s.behind = Number(n) || 0;
    }
    head = head.slice(0, bracket);
  }
  for (const prefix of ['No commits yet on ', 'Initial commit on ']) if (head.startsWith(prefix)) head = head.slice(prefix.length);
  const dots = head.indexOf('...');
  if (dots >= 0) {
    s.branch = head.slice(0, dots);
    s.upstream = head.slice(dots + 3);
  } else {
    s.branch = head === 'HEAD (no branch)' ? null : head;
  }
}

export async function gitStatus(folder: string): Promise<RepoStatus> {
  const top = await repoTop(folder);
  if (!top) return { repo: false };
  const refusal = await folderProgramRefusal(top);
  if (refusal) throw new Error(refusal);
  const s = parseStatus(await ok(top, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all']));
  return { ...s, repo: true, clean: !s.staged.length && !s.unstaged.length && !s.conflicted.length, hooksSkipped: await hooksSkipped(top) };
}

export async function initRepo(folder: string): Promise<void> {
  await ok(folder, ['init']);
}

// ---------- stage, unstage, commit ----------

/// A long list goes on stdin: Windows ends a command line at 32,767 characters (`spawn ENAMETOOLONG`). A short one stays
/// on the command line, where a git older than 2.26 reads it too.
const LONG_PATH_LIST = 4000;
function withPaths(args: string[], paths: string[]): { args: string[]; input?: string } {
  if (paths.reduce((sum, p) => sum + p.length + 1, 0) < LONG_PATH_LIST) return { args: [...args, '--', ...paths] };
  return { args: [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], input: paths.join('\0') };
}

export async function stage(folder: string, paths: string[]): Promise<void> {
  const top = await readTop(folder);
  const { args, input } = withPaths(['add', '--all'], paths.map(cleanPath));
  await ok(top, args, { input });
}

export async function unstage(folder: string, paths: string[]): Promise<void> {
  const top = await readTop(folder);
  const clean = paths.map(cleanPath);
  // `restore --staged` fails before the first commit; `rm --cached` covers that case.
  const restore = withPaths(['restore', '--staged'], clean);
  const r = await runGit(top, restore.args, { input: restore.input });
  if (r.code === 0) return;
  const remove = withPaths(['rm', '--cached', '-r', '--quiet'], clean);
  await ok(top, remove.args, { input: remove.input });
}

/// Commits what is staged and returns the new commit's short hash.
export async function commit(folder: string, message: string): Promise<string> {
  const top = await readTop(folder);
  const text = String(message ?? '').trim();
  if (!text) throw new Error('Write a commit message first.');
  if (!(await ok(top, ['diff', '--cached', '--name-only', '-z'])).length) throw new Error('Nothing is staged. Stage the files to commit first.');
  await ok(top, [...(await hookArgs(top)), 'commit', '--quiet', '-F', '-'], { input: text + '\n' });
  return (await ok(top, ['rev-parse', '--short', 'HEAD'])).trim();
}

// ---------- branches ----------

export async function listBranches(folder: string): Promise<{ current: string | null; branches: string[] }> {
  const top = await readTop(folder);
  const list = (await ok(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  const current = (await ok(top, ['branch', '--show-current'])).trim() || null;
  return { current, branches: list };
}

/// Only a name from the list of branches goes to git, so a name cannot act as an option.
export async function switchBranch(folder: string, name: string): Promise<void> {
  const top = await readTop(folder);
  if (!(await listBranches(top)).branches.includes(name)) throw new Error(`There is no branch called "${String(name).slice(0, 80)}".`);
  await ok(top, [...(await hookArgs(top)), 'switch', name]);
}

export async function createBranch(folder: string, name: string): Promise<void> {
  const top = await readTop(folder);
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || n.length > 200) throw new Error('Give the branch a name that does not start with a dash.');
  if ((await runGit(top, ['check-ref-format', '--branch', n])).code !== 0) throw new Error('Git does not accept that branch name. Use letters, digits, dashes and slashes, no spaces.');
  await ok(top, [...(await hookArgs(top)), 'switch', '-c', n]);
}

// ---------- history and diffs ----------

export async function log(folder: string, count: number): Promise<Commit[]> {
  const top = await readTop(folder);
  const n = Math.max(1, Math.min(200, Math.floor(Number(count) || 30)));
  const r = await runGit(top, ['log', `-n${n}`, '-z', '--format=%H%x1f%an%x1f%ct%x1f%s']);
  // A repository with no commit has an empty history.
  if (r.code !== 0) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(r.err)) return [];
    throw new Error(explain(r.err));
  }
  return r.out.split('\0').filter(Boolean).map((record) => {
    const [hash, author, time, ...subject] = record.replace(/^\n/, '').split('\x1f');
    return { hash, short: hash.slice(0, 7), author, time: Number(time) || 0, subject: subject.join('\x1f') };
  });
}

export async function showCommit(folder: string, hash: string): Promise<Patch> {
  const top = await readTop(folder);
  if (typeof hash !== 'string' || !/^[0-9a-f]{7,40}$/.test(hash)) throw new Error('That is not a commit.');
  const r = await runGit(top, ['show', '--no-color', '--no-ext-diff', '--no-textconv', '-M', hash, '--'], { limit: DIFF_LIMIT });
  if (r.code !== 0) throw new Error(explain(r.err));
  return { text: r.out, truncated: r.truncated };
}

export interface ChangeRef { path: string; area: Area; kind: ChangeKind; originalPath?: string }

/// The text of a new file, or null when it is binary, big, not readable, or not a plain file inside the repository. A link
/// is never followed, also a linked folder on the way: its target may be any file of this person (security review L6).
async function textOrNull(abs: string, top: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(abs);
    if (!stat.isFile() || stat.size > DIFF_LIMIT) return null;
    const [real, root] = await Promise.all([fs.realpath(abs), fs.realpath(top)]);
    if (path.relative(root, real) !== path.relative(root, path.join(root, path.relative(top, abs)))) return null;
    const data = await fs.readFile(real);
    return data.subarray(0, 8000).includes(0) ? null : data.toString('utf8');
  } catch {
    return null;
  }
}

export async function diffOf(folder: string, change: ChangeRef): Promise<Patch> {
  const top = await readTop(folder);
  const file = cleanPath(change.path);
  if (change.kind === 'untracked') {
    // Built here, not with `diff --no-index /dev/null`, which differs per platform.
    const content = await textOrNull(path.join(top, file), top);
    if (content === null) return { text: `New file ${file}\nIt is a link, binary, too big or not readable, so there is no text to show.\n`, truncated: false };
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { text: `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`, truncated: false };
  }
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  if (change.area === 'staged') args.push('--cached');
  args.push('--');
  if (change.originalPath) args.push(cleanPath(change.originalPath));
  args.push(file);
  const r = await runGit(top, args, { limit: DIFF_LIMIT });
  if (r.code !== 0 && r.code !== 1) throw new Error(explain(r.err));
  return { text: r.out, truncated: r.truncated };
}
