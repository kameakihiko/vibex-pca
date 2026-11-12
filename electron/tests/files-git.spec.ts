import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { folderStamps, listFolder, readFile, safePath } from '../src/main/files';
import { commit, createBranch, diffOf, gitStatus, initRepo, listBranches, log, parseStatus, showCommit, stage, switchBranch, unstage } from '../src/main/git';
import { SERVER_NOTE } from '../src/renderer/filesGitText';
import { tempDir, firstWindow } from './fixtures';

// The Files and Git sections: the main-side functions on temp folders, then the sections in the window.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

function makeRepo(): string {
  const dir = realpathSync.native(tempDir('vibex-fg-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Person');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, '.gitignore'), 'build/\n*.log\n');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  mkdirSync(path.join(dir, 'build'));
  writeFileSync(path.join(dir, 'build', 'out.js'), 'x');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test.describe('files: the tree and the reader', () => {
  let dir: string;
  test.beforeAll(() => {
    dir = makeRepo();
    writeFileSync(path.join(dir, 'debug.log'), 'noise');
    writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(path.join(dir, 'huge.txt'), 'x'.repeat(1_100_000));
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('lists folders first, hides .git, marks what git ignores', async () => {
    const list = await listFolder(dir, '');
    const names = list.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names.slice(0, 2)).toEqual(['build', 'src']);
    expect(list.entries.find((e) => e.name === 'build')).toMatchObject({ dir: true, ignored: true });
    expect(list.entries.find((e) => e.name === 'debug.log')).toMatchObject({ dir: false, ignored: true });
    expect(list.entries.find((e) => e.name === 'a.txt')).toMatchObject({ dir: false, ignored: false });
    expect((await listFolder(dir, 'src')).entries.map((e) => e.name)).toEqual(['b.ts']);
  });

  test('a folder that is not a repository still lists, with nothing marked', async () => {
    const plain = realpathSync.native(tempDir('vibex-fg-plain-'));
    try {
      writeFileSync(path.join(plain, 'x.txt'), 'x');
      const list = await listFolder(plain, '');
      expect(list.entries).toEqual([{ name: 'x.txt', dir: false, ignored: false }]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('no path outside the project', async () => {
    for (const bad of ['..', '../x', 'src/../../x', path.resolve(dir, '..'), 'src/\0x']) {
      expect(() => safePath(dir, bad)).toThrow();
    }
    expect(safePath(dir, 'src/b.ts')).toBe(path.join(dir, 'src', 'b.ts'));
    await expect(listFolder(dir, '..')).rejects.toThrow();
    await expect(readFile(dir, '../etc/hosts')).rejects.toThrow();
  });

  test('a link that leaves the project is refused', async () => {
    const outside = realpathSync.native(tempDir('vibex-fg-out-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'private');
      symlinkSync(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(listFolder(dir, 'escape')).rejects.toThrow(/outside/i);
      await expect(readFile(dir, 'escape/secret.txt')).rejects.toThrow(/outside/i);
    } finally {
      rmSync(path.join(dir, 'escape'), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('reads text; binary and big files get a plain message', async () => {
    expect(await readFile(dir, 'a.txt')).toEqual({ kind: 'text', text: 'one\ntwo\n', size: 8 });
    expect(await readFile(dir, 'pic.bin')).toMatchObject({ kind: 'binary' });
    expect(await readFile(dir, 'huge.txt')).toMatchObject({ kind: 'big', size: 1_100_000 });
    expect(await readFile(dir, 'missing.txt')).toMatchObject({ kind: 'error' });
    expect(await readFile(dir, 'src')).toMatchObject({ kind: 'error' });
  });

  test('folder stamps change when a file appears, without a watcher', async () => {
    const before = await folderStamps(dir, ['', 'src', 'gone']);
    expect(before.gone).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'x');
    const after = await folderStamps(dir, ['', 'src']);
    expect(after.src).not.toBe(before.src);
    expect(after['']).toBe(before['']);
  });
});

test.describe('git: status, stage, commit, branches, history, diff', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = makeRepo();
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('parses porcelain output, with a rename and a conflict', () => {
    const s = parseStatus('## main...origin/main [ahead 1, behind 2]\0M  a.txt\0 M b.txt\0R  new.txt\0old.txt\0?? c.txt\0UU d.txt\0');
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2 });
    expect(s.staged.map((c) => c.path)).toEqual(['a.txt', 'new.txt']);
    expect(s.staged[1]).toMatchObject({ kind: 'renamed', originalPath: 'old.txt' });
    expect(s.unstaged.map((c) => c.path)).toEqual(['b.txt', 'c.txt']);
    expect(s.conflicted.map((c) => c.path)).toEqual(['d.txt']);
  });

  test('a folder with no repository says so; init makes one', async () => {
    const plain = realpathSync.native(tempDir('vibex-fg-plain-'));
    try {
      expect(await gitStatus(plain)).toEqual({ repo: false });
      await initRepo(plain);
      expect(await gitStatus(plain)).toMatchObject({ repo: true, staged: [], unstaged: [] });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('stage, unstage and commit', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(dir, 'new.txt'), 'n');
    let s: any = await gitStatus(dir);
    expect(s.clean).toBe(false);
    expect(s.unstaged.map((c: any) => c.path).sort()).toEqual(['a.txt', 'new.txt']);
    await stage(dir, ['a.txt']);
    s = await gitStatus(dir);
    expect(s.staged.map((c: any) => c.path)).toEqual(['a.txt']);
    await unstage(dir, ['a.txt']);
    expect((await gitStatus(dir) as any).staged).toEqual([]);
    await stage(dir, ['a.txt']);
    await expect(commit(dir, '   ')).rejects.toThrow(/message/i);
    const short = await commit(dir, 'add three');
    expect(short).toMatch(/^[0-9a-f]{7,}$/);
    s = await gitStatus(dir);
    expect(s.staged).toEqual([]);
    expect(s.unstaged.map((c: any) => c.path)).toEqual(['new.txt']);
  });

  test('a commit with nothing staged is refused in plain words', async () => {
    await expect(commit(dir, 'nothing')).rejects.toThrow(/nothing is staged/i);
  });

  test('a path that is an option or leaves the project is refused', async () => {
    for (const bad of ['--all', '../x', path.resolve(dir, 'a.txt'), '-f']) {
      await expect(stage(dir, [bad])).rejects.toThrow();
    }
  });

  test('a file name with spaces and unicode survives', async () => {
    writeFileSync(path.join(dir, 'hisobot oylik.txt'), 'x');
    await stage(dir, ['hisobot oylik.txt']);
    expect(((await gitStatus(dir)) as any).staged[0].path).toBe('hisobot oylik.txt');
  });

  test('branches: list, create, switch; a name that is not a branch is refused', async () => {
    expect(await listBranches(dir)).toEqual({ current: 'main', branches: ['main'] });
    await createBranch(dir, 'feature/x');
    expect((await listBranches(dir)).current).toBe('feature/x');
    await switchBranch(dir, 'main');
    expect((await listBranches(dir)).current).toBe('main');
    await expect(switchBranch(dir, '--detach')).rejects.toThrow();
    await expect(switchBranch(dir, 'nope')).rejects.toThrow();
    await expect(createBranch(dir, '-bad')).rejects.toThrow();
    await expect(createBranch(dir, 'has space')).rejects.toThrow();
  });

  test('a switch that would lose changes says so in plain words', async () => {
    await createBranch(dir, 'other');
    writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-q', '-am', 'other change');
    await switchBranch(dir, 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    await expect(switchBranch(dir, 'other')).rejects.toThrow(/changes/i);
  });

  test('history lists commits, newest first, and shows one', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    git(dir, 'commit', '-q', '-am', 'second');
    const entries = await log(dir, 10);
    expect(entries.map((e) => e.subject)).toEqual(['second', 'first']);
    expect(entries[0].hash).toMatch(/^[0-9a-f]{40}$/);
    const patch = await showCommit(dir, entries[0].hash);
    expect(patch.text).toContain('+changed');
    await expect(showCommit(dir, '--output=x')).rejects.toThrow();
    await expect(showCommit(dir, 'HEAD; rm')).rejects.toThrow();
  });

  test('history of a repository with no commit is an empty list', async () => {
    const fresh = realpathSync.native(tempDir('vibex-fg-fresh-'));
    try {
      await initRepo(fresh);
      expect(await log(fresh, 10)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('diff of an unstaged, a staged and an untracked file', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
    writeFileSync(path.join(dir, 'u.txt'), 'brand new\n');
    const unstaged = await diffOf(dir, { path: 'a.txt', area: 'unstaged', kind: 'modified' });
    expect(unstaged.text).toContain('-two');
    expect(unstaged.text).toContain('+TWO');
    const untracked = await diffOf(dir, { path: 'u.txt', area: 'unstaged', kind: 'untracked' });
    expect(untracked.text).toContain('+brand new');
    await stage(dir, ['a.txt']);
    const staged = await diffOf(dir, { path: 'a.txt', area: 'staged', kind: 'modified' });
    expect(staged.text).toContain('+TWO');
  });
});

test.describe('the sections in the window', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let root: string;

  test.beforeAll(async () => {
    dir = realpathSync.native(tempDir('vibex-fgw-'));
    root = path.join(dir, 'proj');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test Person');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs', 'deep.md'), '# deep\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'start');
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: path.join(dir, 'data'),
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), root);
    await page.waitForSelector('#workspace:not([hidden])');
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('Files shows the tree, opens a file read-only in a document tab, keeps Show in File Explorer', async () => {
    await page.click('#activity [data-activity="files"]');
    await expect(page.locator('#sidebar-body')).not.toContainText('Not in this build yet');
    await expect(page.locator('#sidebar-body [data-path="notes.txt"]')).toBeVisible();
    await expect(page.locator('#sidebar-body [data-path="docs/deep.md"]')).toHaveCount(0);
    await page.click('#sidebar-body [data-path="docs"]');
    await expect(page.locator('#sidebar-body [data-path="docs/deep.md"]')).toBeVisible();
    await page.click('#sidebar-body [data-path="notes.txt"]');
    await expect(page.locator('#doc-tabs .tab')).toContainText('notes.txt');
    await expect(page.locator('#doc-view')).toContainText('hello');
    expect(await page.locator('#doc-view textarea, #doc-view [contenteditable="true"]').count()).toBe(0);
    await expect(page.locator('#sidebar-body')).toContainText(/Show in (File Explorer|Finder|Files)/);
  });

  test('Files picks up a new file without a click on refresh', async () => {
    writeFileSync(path.join(root, 'later.txt'), 'x');
    await expect(page.locator('#sidebar-body [data-path="later.txt"]')).toBeVisible({ timeout: 10_000 });
  });

  test('Git shows the change, stages it, commits it, and opens a diff tab', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'hello\nworld\n');
    await page.click('#activity [data-activity="git"]');
    await expect(page.locator('#sidebar-body')).not.toContainText('Not in this build yet');
    const row = page.locator('#sidebar-body [data-change="unstaged|notes.txt"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('.name').click();
    await expect(page.locator('#doc-tabs .tab').last()).toContainText('notes.txt');
    await expect(page.locator('#doc-view')).toContainText('+world');
    await row.locator('button[title="Stage"]').click();
    await expect(page.locator('#sidebar-body [data-change="staged|notes.txt"]')).toBeVisible();
    await page.fill('#sidebar-body textarea', 'add world');
    await page.click('#sidebar-body button.commit');
    await expect(page.locator('#sidebar-body [data-change="staged|notes.txt"]')).toHaveCount(0);
    await expect(page.locator('#sidebar-body')).toContainText('add world');
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('add world');
  });

  test('Git lists branches and switches', async () => {
    git(root, 'branch', 'side');
    await page.click('#sidebar-body button.branch');
    await page.click('#sidebar-body [data-branch="side"]');
    await expect.poll(() => git(root, 'branch', '--show-current').trim()).toBe('side');
  });
});

test.describe('a server project', () => {
  test('both sections say plainly that they work on this computer only', async () => {
    const dir = realpathSync.native(tempDir('vibex-fgs-'));
    const userData = path.join(dir, 'data');
    mkdirSync(userData);
    // A profile that is never connected to: the sections must not try ssh.
    writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([{ name: 'test', host: '127.0.0.1', user: 'pca', port: 1, allowClaude: true }]));
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: userData,
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    const app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    try {
      const page = await firstWindow(app);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      await page.evaluate(() => (window as any).vibex.projects.openServer('test', '~/app'));
      await page.waitForSelector('#workspace:not([hidden])');
      for (const section of ['files', 'git']) {
        await page.click(`#activity [data-activity="${section}"]`);
        await expect(page.locator('#sidebar-body')).toContainText('This project is on test, in ~/app');
        await expect(page.locator('#sidebar-body')).not.toContainText('Not in this build yet');
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the words name the terminal tab as the way to work there', async () => {
    expect(SERVER_NOTE).toMatch(/server/i);
    expect(SERVER_NOTE).toMatch(/terminal/i);
  });
});
