import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentError, createAgent, agentCommand, agentSessionName, finishAgent, listAgents, parseWorktrees, removeAgent, slug, uniqueName, TASK_POINTER } from '../src/main/agents';
import { checkLine, GoDesk, GoLog, itemsHash, parseAsk, PointerTracker, requestHash, verifyPress } from '../src/main/goDesk';
import { HOOK_EVENTS, installedInto, isInstalled, parseHookEvent, removedFrom, waitingOf } from '../src/main/inbox';
import { tempDir, firstWindow, holdFolder } from './fixtures';

// Agents, the Go gate and the Inbox (macOS Vibex: Agents/ParallelAgents, Go/GoDesk, Go/GoTools, Inbox/*).
// The first half is pure functions and real git in temp folders; the second half runs the app.

process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function makeRepo(parent: string, name: string): string {
  const folder = path.join(parent, name);
  mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(folder, 'readme.txt'), 'hello\n');
  git(folder, 'add', 'readme.txt');
  git(folder, 'commit', '-q', '-m', 'first');
  return realpathSync.native(folder);
}

test.describe('Go: what a request may say', () => {
  test('checkLine refuses empty, long, line breaks and invisible characters', () => {
    expect(checkLine('  Merge PR 12  ', 'title', 200)).toBe('Merge PR 12');
    expect(() => checkLine('   ', 'title', 200)).toThrow(/title is empty/);
    expect(() => checkLine('x'.repeat(201), 'title', 200)).toThrow(/longer than 200/);
    expect(() => checkLine('a\nb', 'item 1', 300)).toThrow(/line break|control/);
    expect(() => checkLine('a​b', 'item 1', 300)).toThrow(/invisible|control/);
    expect(() => checkLine('a‮b', 'item 1', 300)).toThrow(/invisible|control/);
    expect(() => checkLine('é', 'item 1', 300)).toThrow(/combining|invisible/);
    expect(() => checkLine('aㅤb', 'item 1', 300)).toThrow(/invisible/);
    expect(checkLine('Deploy the shop (Bukhara)', 'item 1', 300)).toBe('Deploy the shop (Bukhara)');
  });

  test('parseAsk needs items, at most 50, and checks the links', () => {
    const ok = parseAsk({ title: 'Merge', items: ['one', 'two'], pr_url: 'https://github.com/a/b/pull/1', review_url: 'https://example.com/r' });
    expect(ok).toMatchObject({ title: 'Merge', items: ['one', 'two'], prUrl: 'https://github.com/a/b/pull/1' });
    expect(() => parseAsk({ title: 'Merge', items: [] })).toThrow(/items must list/);
    expect(() => parseAsk({ title: 'Merge', items: Array.from({ length: 51 }, () => 'x') })).toThrow(/at most 50/);
    expect(() => parseAsk({ title: 'Merge', items: [3 as any] })).toThrow(/item 1 is not a string/);
    expect(() => parseAsk({ title: 'Merge', items: ['x'], pr_url: 'ftp://x' })).toThrow(/pr_url must be an http/);
    expect(() => parseAsk({ title: 'Merge', items: ['x'], review_url: 'javascript:alert(1)' })).toThrow(/review_url must be/);
    expect(() => parseAsk({ title: 'Merge', items: ['x'], review_url: '/tmp/none.html' }, () => false)).toThrow(/no file at/);
    expect(parseAsk({ title: 'Merge', items: ['x'], review_url: '/tmp/page.html' }, () => true).reviewUrl).toBe('/tmp/page.html');
    expect(() => parseAsk({ title: 'Merge', items: ['x'], review_url: '/tmp/page.txt' }, () => true)).toThrow(/\.html/);
  });

  test('the hashes are stable and change with every word', () => {
    expect(itemsHash(['a', 'b'])).toBe(itemsHash(['a', 'b']));
    expect(itemsHash(['a', 'b'])).not.toBe(itemsHash(['b', 'a']));
    expect(requestHash('t', ['a'], null, null)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash('t', ['a'], null, null)).not.toBe(requestHash('t', ['a'], 'https://x.example', null));
  });
});

test.describe('Go: the pointer proof', () => {
  const rect = { x: 100, y: 100, width: 80, height: 30 };
  const at = (x: number, y: number, t: number) => ({ x, y, at: t });

  test('a held press that began at the last pointer move passes', () => {
    const tracker = new PointerTracker();
    tracker.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    tracker.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    const click = verifyPress(tracker.press(), rect, 2200, 1000);
    expect(click.heldFor).toBe(1100);
    expect(click.movedAt).toBe(1000);
  });

  test('a press with no mouse move, or after a jump of the pointer, is refused', () => {
    const none = new PointerTracker();
    none.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    expect(() => verifyPress(none.press(), rect, 2200, 1000)).toThrow(/move the pointer onto the button with the mouse first/);
    const warped = new PointerTracker();
    warped.feed({ type: 'mouseMove', x: 5, y: 5 }, 1000);
    warped.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    expect(() => verifyPress(warped.press(), rect, 2200, 1000)).toThrow(/jumped onto the button/);
  });

  test('a hold that is short, released, or left the button is refused', () => {
    const tracker = new PointerTracker();
    tracker.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    tracker.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    expect(() => verifyPress(tracker.press(), rect, 1500, 1000)).toThrow(/held for 0\.4 s; hold it for 1 s/);
    tracker.feed({ type: 'mouseMove', x: 300, y: 300 }, 1700);
    expect(() => verifyPress(tracker.press(), rect, 2200, 1000)).toThrow(/pointer left Go/);
    const released = new PointerTracker();
    released.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    released.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    released.feed({ type: 'mouseUp', x: 120, y: 110, button: 'left' }, 1500);
    expect(() => verifyPress(released.press(), rect, 2200, 1000)).toThrow(/released before the hold/);
  });

  test('only the left button counts, and a press outside the button does not', () => {
    const right = new PointerTracker();
    right.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    right.feed({ type: 'mouseDown', x: 120, y: 110, button: 'right' }, 1100);
    expect(() => verifyPress(right.press(), rect, 2200, 1000)).toThrow(/no mouse press|left mouse button/);
    const outside = new PointerTracker();
    outside.feed({ type: 'mouseMove', x: 20, y: 10 }, 1000);
    outside.feed({ type: 'mouseDown', x: 20, y: 10, button: 'left' }, 1100);
    expect(() => verifyPress(outside.press(), rect, 2200, 1000)).toThrow(/not on the button/);
    expect(() => verifyPress(outside.press(), null, 2200, 1000)).toThrow(/button is not on screen/);
  });

  test('a click needs its release inside the button, not long ago', () => {
    const tracker = new PointerTracker();
    tracker.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    tracker.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    expect(() => verifyPress(tracker.press(), rect, 1200, null)).toThrow(/no mouse-up/);
    tracker.feed({ type: 'mouseUp', x: 120, y: 110, button: 'left' }, 1150);
    expect(verifyPress(tracker.press(), rect, 1200, null).heldFor).toBe(0);
    expect(() => verifyPress(tracker.press(), rect, 9000, null)).toThrow(/too old/);
    const slid = new PointerTracker();
    slid.feed({ type: 'mouseMove', x: 120, y: 110 }, 1000);
    slid.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1100);
    slid.feed({ type: 'mouseUp', x: 400, y: 400, button: 'left' }, 1150);
    expect(() => verifyPress(slid.press(), rect, 1200, null)).toThrow(/ended outside/);
    expect(at(1, 2, 3)).toBeTruthy();
  });
});

test.describe('Go: the desk', () => {
  let dir: string;
  let log: GoLog;
  let desk: GoDesk;
  const key = Buffer.alloc(32, 7);
  const ask = { title: 'Merge PR 12', items: ['Merge #12', 'Deploy app'], reviewUrl: null, prUrl: null };
  const heldClick = (t: number) => ({ at: t, movedAt: t - 3000, heldFor: 1000 });

  test.beforeEach(() => {
    dir = tempDir('vibex-go-desk-');
    log = new GoLog(path.join(dir, 'go-log.json'), () => key);
    desk = new GoDesk(log, { armMs: 1500, holdMs: 1000 });
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the same request twice is one; a changed item is a new one', () => {
    const a = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    const b = desk.submit({ ...ask }, 'p1', 'alpha', '/work/alpha', 5);
    const c = desk.submit({ ...ask, items: ['Merge #12'] }, 'p1', 'alpha', '/work/alpha', 6);
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(desk.pending('p1')).toHaveLength(2);
    expect(desk.pending('p2')).toHaveLength(0);
  });

  test('Go stays off until the request is on screen, read to the end, in front, and the delay is over', () => {
    const r = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    expect(desk.goBlocker(r.id, 'p1', 0)).toMatch(/Only the request on screen/);
    desk.setFront(true, 0);
    desk.noteShown('p1', r.id, 0);
    expect(desk.goBlocker(r.id, 'p1', 100)).toMatch(/Scroll to the end/);
    desk.noteReadToEnd(r.id);
    expect(desk.goBlocker(r.id, 'p1', 100)).toMatch(/turns on 1\.5 seconds/);
    expect(desk.goBlocker(r.id, 'p1', 1600)).toBeNull();
    desk.setFront(false, 1700);
    expect(desk.goBlocker(r.id, 'p1', 1800)).toMatch(/Bring this window to the front/);
    desk.setFront(true, 1900);
    expect(desk.goBlocker(r.id, 'p1', 2000)).toMatch(/turns on/);
    expect(desk.goBlocker(r.id, 'p1', 3500)).toBeNull();
    desk.setFits(false);
    expect(desk.goBlocker(r.id, 'p1', 3500)).toMatch(/does not fit/);
  });

  test('a go needs the hold, the delay and a move that came after the request was shown', () => {
    const r = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    desk.setFront(true, 0);
    desk.noteShown('p1', r.id, 1000);
    desk.noteReadToEnd(r.id);
    expect(() => desk.answer(r.id, 'go', null, heldClick(1800), 1800)).toThrow(/press Go after it turns on|turns on/);
    expect(() => desk.answer(r.id, 'go', null, { at: 5000, movedAt: 500, heldFor: 1000 }, 5000)).toThrow(/move the pointer onto Go again/);
    expect(() => desk.answer(r.id, 'go', null, { at: 5000, movedAt: 2000, heldFor: 400 }, 5000)).toThrow(/hold it for 1 s/);
    expect(desk.status(r.id, 'p1').request?.answer).toBeUndefined();
    const answered = desk.answer(r.id, 'go', '  ship it  ', { at: 5000, movedAt: 2000, heldFor: 1000 }, 5000);
    expect(answered.answer).toMatchObject({ decision: 'go', note: 'ship it' });
    expect(() => desk.answer(r.id, 'go', null, heldClick(6000), 6000)).toThrow(/already answered/);
  });

  test('Not now needs the request on screen but no hold; both are logged, signed, and kept private', () => {
    const r = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    expect(() => desk.answer(r.id, 'declined', null, { at: 10, movedAt: 5, heldFor: 0 }, 10)).toThrow(/only the request on screen/);
    desk.noteShown('p1', r.id, 0);
    desk.answer(r.id, 'declined', null, { at: 10, movedAt: 5, heldFor: 0 }, 10);
    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: r.id, answer: 'declined', project: 'alpha', itemsHash: itemsHash(ask.items) });
    expect(log.isValid(entries[0])).toBe(true);
    expect(log.isValid({ ...entries[0], answer: 'go' })).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'go-log.json')).mode & 0o077).toBe(0);
  });

  test('an answer that cannot be logged is not given', () => {
    const broken = new GoLog(path.join(dir, 'go-log.json'), () => { throw new Error('no key'); });
    const d = new GoDesk(broken, { armMs: 0, holdMs: 0 });
    const r = d.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    d.noteShown('p1', r.id, 0);
    expect(() => d.answer(r.id, 'declined', null, { at: 1, movedAt: 0, heldFor: 0 }, 1)).toThrow(/no answer is recorded/);
    expect(d.pending('p1')).toHaveLength(1);
  });

  test('an answer from an earlier run is only a record, never a go; another project cannot read it', () => {
    const r = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    desk.noteShown('p1', r.id, 0);
    desk.answer(r.id, 'declined', null, { at: 10, movedAt: 5, heldFor: 0 }, 10);
    const later = new GoDesk(log, { armMs: 1500, holdMs: 1000 });
    const found = later.status(r.id, 'p1');
    expect(found.request).toBeUndefined();
    expect(found.logged?.entry.answer).toBe('declined');
    expect(found.logged?.signatureValid).toBe(true);
    expect(() => later.status(r.id, 'p2', '/work/beta')).toThrow(/another project/);
  });

  test('a log that cannot be read is kept aside, not overwritten', () => {
    writeFileSync(path.join(dir, 'go-log.json'), '{ not json');
    const r = desk.submit(ask, 'p1', 'alpha', '/work/alpha', 0);
    desk.noteShown('p1', r.id, 0);
    desk.answer(r.id, 'declined', null, { at: 10, movedAt: 5, heldFor: 0 }, 10);
    expect(log.entries()).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'go-log.json'), 'utf8')).toContain(r.id);
  });
});

test.describe('Inbox: Claude Code hooks', () => {
  test('install adds all six events, keeps the person hooks, and remove takes only ours', () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, theme: 'dark' };
    const added = installedInto(mine);
    expect(isInstalled(added)).toBe(true);
    expect(HOOK_EVENTS.map((e) => e.name)).toEqual(['PermissionRequest', 'Notification', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
    for (const e of HOOK_EVENTS) expect((added as any).hooks[e.name].length).toBeGreaterThan(0);
    expect((added as any).hooks.Stop).toHaveLength(2);
    expect(installedInto(added)).toEqual(added);
    const back = removedFrom(added) as any;
    expect(back.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(back.hooks.Notification).toBeUndefined();
    expect(back.theme).toBe('dark');
    expect(isInstalled(back)).toBe(false);
    expect(removedFrom(installedInto({}))).toEqual({});
  });

  test('a hook event is read as Claude Code sends it', () => {
    const ask = parseHookEvent(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'mcp__vibex__terminal_run', tool_input: { command: 'npm test\nnext line' }, session_id: 's1', cwd: '/work/alpha' }));
    expect(ask).toMatchObject({ name: 'PermissionRequest', tool: 'mcp__vibex__terminal_run', session: 's1', cwd: '/work/alpha' });
    expect(waitingOf(ask!)).toEqual({ kind: 'permission', message: 'Allow terminal_run: npm test?' });
    const note = parseHookEvent(JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your attention', session_id: 's1' }));
    expect(waitingOf(note!)).toEqual({ kind: 'question', message: 'Claude needs your attention' });
    for (const name of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(waitingOf(parseHookEvent(JSON.stringify({ hook_event_name: name, session_id: 's1' }))!)).toBeNull();
    }
    expect(parseHookEvent('not json')).toBeNull();
    expect(parseHookEvent(JSON.stringify({ hook_event_name: 'SomethingElse' }))).toBeNull();
  });
});

test.describe('Agents: names and commands', () => {
  test('slug keeps five words; a unique name adds a number', () => {
    expect(slug('Add a dark mode toggle to the settings page')).toBe('add-a-dark-mode-toggle');
    expect(slug('!!!')).toBe('agent');
    expect(uniqueName('Dark mode', new Set(['dark-mode']))).toBe('dark-mode-2');
    expect(uniqueName('Dark mode', new Set(['dark-mode', 'dark-mode-2']))).toBe('dark-mode-3');
  });

  test('a session name starts with the project', () => {
    expect(agentSessionName('north-wind', 'dark-mode')).toBe('north-wind - dark-mode');
    expect(agentSessionName('blue_lake', 'fix')).toBe('blue_lake - fix');
  });

  test('the task goes through the environment, never into the command line', () => {
    const posix = agentCommand('claude', 'posix', 'do it');
    expect(posix).toBe('claude --name "$VIBEX_AGENT_NAME" "$VIBEX_AGENT_TASK"');
    // PowerShell gets the line that names the task file; tests/windows-first.spec.ts runs it through a real PowerShell.
    expect(agentCommand('claude', 'pwsh', TASK_POINTER)).toBe('claude --name $env:VIBEX_AGENT_NAME $env:VIBEX_AGENT_TASK');
    expect(agentCommand('claude', 'pwsh', '')).toBe('claude --name $env:VIBEX_AGENT_NAME');
    expect(agentCommand('claude', 'posix', '')).toBe('claude --name "$VIBEX_AGENT_NAME"');
  });

  test('worktrees are read from git porcelain output', () => {
    const text = 'worktree /work/alpha\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/agents/dark\nHEAD def\nbranch refs/heads/vibex/dark\n\nworktree /work/agents/old\nHEAD 123\ndetached\n';
    expect(parseWorktrees(text)).toEqual([
      { path: '/work/alpha', branch: 'main' },
      { path: '/work/agents/dark', branch: 'vibex/dark' },
      { path: '/work/agents/old', branch: null },
    ]);
  });
});

test.describe('Agents: real git worktrees', () => {
  let dir: string;
  let repo: string;
  let root: string;
  test.beforeEach(() => {
    dir = tempDir('vibex-agents-');
    repo = makeRepo(dir, 'alpha');
    root = path.join(dir, 'agents');
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('create makes a branch and a folder; list shows it with its changes', async () => {
    const empty = await listAgents(repo, root);
    expect(empty).toMatchObject({ state: 'ready', base: 'main', agents: [] });
    const made = await createAgent(repo, root, 'Fix login', 'fix the login page');
    expect(made.branch).toBe('vibex/fix-login');
    expect(existsSync(made.path)).toBe(true);
    writeFileSync(path.join(made.path, 'new.txt'), 'x');
    const listed = await listAgents(repo, root);
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({ name: 'fix-login', branch: 'vibex/fix-login', task: 'fix the login page', changes: 1 });
    const again = await createAgent(repo, root, 'Fix login', undefined);
    expect(again.name).toBe('fix-login-2');
  });

  test('a folder that is not a repository says so', async () => {
    const plain = path.join(dir, 'plain');
    mkdirSync(plain);
    expect((await listAgents(plain, root)).state).toBe('notRepository');
    await expect(createAgent(plain, root, 'x', undefined)).rejects.toThrow(/not a git repository/);
  });

  test('a dirty worktree stays, with a plain reason', async () => {
    const made = await createAgent(repo, root, 'dirty one', undefined);
    writeFileSync(path.join(made.path, 'work.txt'), 'unsaved');
    await expect(removeAgent(repo, root, made.path)).rejects.toThrow(/1 change that is not committed.*stays/);
    await expect(finishAgent(repo, root, made.path)).rejects.toThrow(/1 change that is not committed.*stays/);
    expect(existsSync(made.path)).toBe(true);
  });

  test('finish merges a clean agent into the base branch and removes it', async () => {
    const made = await createAgent(repo, root, 'add notes', undefined);
    writeFileSync(path.join(made.path, 'notes.txt'), 'notes\n');
    git(made.path, 'add', 'notes.txt');
    git(made.path, 'commit', '-q', '-m', 'notes');
    const done = await finishAgent(repo, root, made.path);
    expect(done).toMatch(/Merged vibex\/add-notes into main/);
    expect(existsSync(path.join(repo, 'notes.txt'))).toBe(true);
    expect(existsSync(made.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'vibex/add-notes')).toBe('');
  });

  test('finish stops when the project folder itself has changes, and when the merge conflicts', async () => {
    const made = await createAgent(repo, root, 'edit readme', undefined);
    writeFileSync(path.join(made.path, 'readme.txt'), 'agent version\n');
    git(made.path, 'commit', '-q', '-am', 'agent edit');
    writeFileSync(path.join(repo, 'loose.txt'), 'loose');
    await expect(finishAgent(repo, root, made.path)).rejects.toThrow(/project folder has 1 change/);
    rmSync(path.join(repo, 'loose.txt'));
    writeFileSync(path.join(repo, 'readme.txt'), 'main version\n');
    git(repo, 'commit', '-q', '-am', 'main edit');
    await expect(finishAgent(repo, root, made.path)).rejects.toThrow(/conflict.*readme\.txt.*nothing was changed/s);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(made.path)).toBe(true);
  });

  test('a refused prepare step stops Finish before the merge', async () => {
    const made = await createAgent(repo, root, 'held', undefined);
    writeFileSync(path.join(made.path, 'held.txt'), 'x\n');
    git(made.path, 'add', 'held.txt');
    git(made.path, 'commit', '-q', '-m', 'held');
    const refuse = { prepare: async () => { throw new AgentError('Close the tab first.'); } };
    await expect(finishAgent(repo, root, made.path, refuse)).rejects.toThrow(/Close the tab first/);
    await expect(removeAgent(repo, root, made.path, refuse)).rejects.toThrow(/Close the tab first/);
    expect(existsSync(path.join(repo, 'held.txt'))).toBe(false);
    expect(existsSync(made.path)).toBe(true);
  });

  test('Finish says the merge passed when the folder cannot be removed', async () => {
    const win = process.platform === 'win32';
    const made = await createAgent(repo, root, 'stuck', undefined);
    writeFileSync(path.join(made.path, 'stuck.txt'), 'x\n');
    git(made.path, 'add', 'stuck.txt');
    git(made.path, 'commit', '-q', '-m', 'stuck');
    // The lock: on Unix a read-only parent folder. On Windows a process that stands in the worktree, which Windows will not delete.
    const release = win ? holdFolder(made.path) : null;
    if (!win) chmodSync(root, 0o555);
    try {
      const said = await finishAgent(repo, root, made.path);
      // git has dropped its record of the worktree by now, so there is no row to press Remove on.
      expect(said).toMatch(/^Merged vibex\/stuck into main\. Removed stuck from the list, but some of its files stayed, because a program still uses them\. Close that program, then delete the folder /);
      expect(said).toContain(made.path);
      expect(existsSync(path.join(repo, 'stuck.txt'))).toBe(true);
    } finally {
      if (release) await release();
      else chmodSync(root, 0o755);
    }
  });

  test('remove deletes a clean worktree, keeps an unmerged branch, and refuses a path git does not list', async () => {
    const made = await createAgent(repo, root, 'side work', undefined);
    writeFileSync(path.join(made.path, 'a.txt'), 'a');
    git(made.path, 'add', 'a.txt');
    git(made.path, 'commit', '-q', '-m', 'a');
    const said = await removeAgent(repo, root, made.path);
    expect(said).toMatch(/Removed side-work.*vibex\/side-work.*not merged.*kept/s);
    expect(existsSync(made.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'vibex/side-work')).toContain('vibex/side-work');
    await expect(removeAgent(repo, root, path.join(dir, 'elsewhere'))).rejects.toThrow(/not an agent of this project/);
    await expect(removeAgent(repo, root, repo)).rejects.toThrow(/not an agent of this project/);
  });
});

// ---------------------------------------------------------------- the app

test.describe('the app: Agents, Inbox and Go', () => {
  test.describe.configure({ mode: 'serial' });

  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let userData: string;
  let configDir: string;
  let alpha: string;
  let plain: string;
  let alphaId: string;
  let port: number;
  let token: string;
  let hasFocus = false;

  async function launch(): Promise<void> {
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: userData,
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      VIBEX_AGENT_TAB_LOCK: '1',
      VIBEX_GO_ARM_MS: '300',
      VIBEX_GO_HOLD_MS: '700',
      // Other programs on a shared computer take the focus. GO_REAL_FOCUS=1 runs these checks with the real focus.
      ...(process.env.GO_REAL_FOCUS === '1' ? {} : { VIBEX_GO_ASSUME_FRONT: '1' }),
      CLAUDE_CONFIG_DIR: configDir,
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    const hook = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest;
      return { token: t.token as string, port: t.status.mcpPort as number };
    });
    port = hook.port;
    token = hook.token;
    // Finish and Remove ask before they close an agent's tabs (as on Windows); tests answer "Close" unless they say no.
    await app.evaluate(() => { (globalThis as any).__vibexTest.agentTabAnswer = 0; });
  }

  /// The Go gate needs the window in front; a test run may start the app behind other windows.
  const front = () => app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    electronApp.focus({ steal: true });
    w.focus();
  });

  async function openProject(folder: string): Promise<string> {
    await app.evaluate(({ dialog }, picked) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, folder);
    await page.locator('#rail-open').click();
    const tile = page.locator('.tile', { hasText: path.basename(folder) });
    await expect(tile).toHaveCount(1);
    await tile.click();
    return (await tile.getAttribute('data-project')) as string;
  }

  async function mcp(windowId?: string): Promise<Client> {
    const client = new Client({ name: 'vibex-agents-go-test', version: '1.0.0' });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (windowId !== undefined) headers['X-Vibex-Window'] = windowId;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
    return client;
  }
  const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const textOf = (result: Awaited<ReturnType<typeof call>>) => ((result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '');

  const hookEnv = () => app.evaluate(() => ({ url: process.env.VIBEXPCA_HOOK_URL ?? '', token: process.env.VIBEXPCA_HOOK_TOKEN ?? '' }));
  async function sendHook(body: Record<string, unknown>, windowId: string, over: { token?: string; origin?: string } = {}): Promise<number> {
    const h = await hookEnv();
    const headers: Record<string, string> = { Authorization: `Bearer ${over.token ?? h.token}`, 'Content-Type': 'application/json', 'X-Vibex-Window': windowId };
    if (over.origin) headers.Origin = over.origin;
    const res = await fetch(h.url, { method: 'POST', headers, body: JSON.stringify(body) });
    return res.status;
  }

  const section = (name: string) => page.locator(`#activity [data-activity="${name}"]`);
  /// A click on the open section's button would close it.
  const openSection = async (name: string) => {
    if ((await section(name).getAttribute('aria-pressed')) !== 'true') await section(name).click();
  };
  const badge = (id: string) => page.locator(`.tile[data-project="${id}"] .rail-badge`);

  test.beforeAll(async () => {
    dir = tempDir('vibex-agents-go-app-');
    userData = path.join(dir, 'profile');
    configDir = path.join(dir, 'claude-config');
    mkdirSync(userData);
    mkdirSync(configDir);
    // A hook of the person's own must survive.
    writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    alpha = makeRepo(dir, 'alpha-project');
    plain = path.join(dir, 'plain-folder');
    mkdirSync(plain);
    plain = realpathSync.native(plain);
    await launch();
    alphaId = await openProject(alpha);
    await front();
    if (process.env.GO_REAL_FOCUS === '1') {
      const deadline = Date.now() + 8000;
      while (!hasFocus && Date.now() < deadline) {
        await front();
        hasFocus = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
        if (!hasFocus) await page.waitForTimeout(250);
      }
      // A runner with no window manager gives no window the focus. It says so; it does not pass by doing nothing.
      if (!hasFocus) console.log('::warning::GO_REAL_FOCUS: this runner gave the window no focus, so the Go checks with a real focus did not run');
    }
  });

  test.beforeEach(({}, info) => {
    test.skip(process.env.GO_REAL_FOCUS === '1' && !hasFocus && /Go:/.test(info.title), 'this computer gave the window no real focus');
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('1. the hooks are in Claude settings next to the person hooks, and tabs know the hook address', async () => {
    const settings = JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    expect(isInstalled(settings)).toBe(true);
    expect(settings.model).toBe('x');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('echo mine');
    expect(existsSync(path.join(configDir, 'settings.json.vibex-backup'))).toBe(true);
    const client = await mcp(alphaId);
    const printed = process.platform === 'win32' ? 'Write-Output "HOOK=$env:VIBEXPCA_HOOK_URL"' : 'echo "HOOK=$VIBEXPCA_HOOK_URL"';
    expect(textOf(await call(client, 'terminal_run', { command: printed }))).toMatch(/HOOK=http:\/\/127\.0\.0\.1:\d+\//);
    await client.close();
  });

  test('2. the tools are the three of macOS Vibex, and none of them can give a go', async () => {
    const client = await mcp(alphaId);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const wanted of ['vibex_request_go', 'vibex_go_status', 'vibex_notify']) expect(names).toContain(wanted);
    expect(names.filter((n) => /approve|answer|grant|confirm|go_give|vibex_go$/.test(n))).toEqual([]);
    const tools = (await client.listTools()).tools;
    const request = tools.find((t) => t.name === 'vibex_request_go')!;
    expect(Object.keys((request.inputSchema as any).properties)).toEqual(expect.arrayContaining(['title', 'items', 'review_url', 'pr_url', 'device', 'project_path']));
    await client.close();
  });

  test('3a. a waiting line whose tab has gone can be dismissed, and the badge goes with it', async () => {
    expect(await sendHook({ hook_event_name: 'PermissionRequest', session_id: 'gone-tab', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: alpha }, alphaId)).toBe(204);
    await expect(badge(alphaId)).toHaveText('1');
    await openSection('inbox');
    await page.locator('.inbox-item[data-kind="permission"] .inbox-dismiss').click();
    await expect(page.locator('.inbox-item[data-kind="permission"]')).toHaveCount(0);
    await expect(badge(alphaId)).toHaveCount(0);
    await openSection('inbox');
  });

  test('3. a hook that waits for the person puts a badge on the rail and a line in the Inbox; the next event clears it', async () => {
    expect(await sendHook({ hook_event_name: 'Stop', session_id: 's1' }, alphaId, { token: 'wrong' })).toBe(401);
    expect(await sendHook({ hook_event_name: 'Stop', session_id: 's1' }, alphaId, { origin: 'https://evil.example' })).toBe(403);
    expect(await sendHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: alpha }, alphaId)).toBe(204);
    await expect(badge(alphaId)).toHaveText('1');
    await openSection('inbox');
    await expect(page.locator('.inbox-item[data-kind="permission"] .inbox-text')).toHaveText('Allow Bash: npm test?');
    expect(await sendHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, alphaId)).toBe(204);
    await expect(badge(alphaId)).toHaveCount(0);
    await expect(page.locator('.inbox-item[data-kind="permission"]')).toHaveCount(0);
    expect(await sendHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash' }, 'not-a-project')).toBe(404);
  });

  test('4. vibex_notify shows a toast and keeps the line in the Inbox', async () => {
    const client = await mcp(alphaId);
    expect(textOf(await call(client, 'vibex_notify', { title: 'Build done', message: 'All 12 checks pass' }))).toBe('Shown.');
    await expect(page.locator('.toast')).toContainText('Build done');
    await openSection('inbox');
    await expect(page.locator('.inbox-item[data-kind="report"]').first()).toContainText('Build done');
    await expect(page.locator('.inbox-item[data-kind="report"]').first()).toContainText('All 12 checks pass');
    await client.close();
  });

  test('5. the Inbox hook switch removes our hooks and keeps the person hooks; it stays removed after a restart', async () => {
    await openSection('inbox');
    await page.locator('.inbox-hooks-toggle').click();
    await expect.poll(() => isInstalled(JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command).toBe('echo mine');
    await app.close();
    await launch();
    await front();
    expect(isInstalled(JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')))).toBe(false);
    await openSection('inbox');
    await page.locator('.inbox-hooks-toggle').click();
    await expect.poll(() => isInstalled(JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')))).toBe(true);
    alphaId = await page.locator('.tile', { hasText: 'alpha-project' }).getAttribute('data-project') as string;
    await page.locator('.tile', { hasText: 'alpha-project' }).click();
  });

  test('6. Agents: a folder that is not a repository says so', async () => {
    const id = await openProject(plain);
    await openSection('agents');
    await expect(page.locator('.agents-empty')).toContainText('not a git repository');
    await expect(page.locator('#agent-start')).toHaveCount(0);
    await page.locator(`.tile[data-project="${id}"]`).click();
    await page.locator('.tile', { hasText: 'alpha-project' }).click();
  });

  test('7. Agents: start an agent in its own worktree in a new Claude tab named after the project', async () => {
    await openSection('agents');
    await expect(page.locator('.agents-none')).toBeVisible();
    await page.locator('#agent-name').fill('Fix login');
    await page.locator('#agent-task').fill('fix the login page');
    const before = await page.locator('.terminal-pane[data-pane="agent"] .tab:visible').count();
    await page.locator('#agent-start').click();
    const card = page.locator('.agent-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.agent-name')).toHaveText('fix-login');
    await expect(card.locator('.agent-branch')).toHaveText('vibex/fix-login');
    await expect(page.locator('.terminal-pane[data-pane="agent"] .tab:visible')).toHaveCount(before + 1);
    await expect(page.locator('.terminal-pane[data-pane="agent"] .tab:visible .label', { hasText: 'alpha-project - fix-login' })).toHaveCount(1);
    await expect(page.locator('.terminal-pane[data-pane="agent"] .term.active .xterm-rows')).toContainText(
      // PowerShell: the task goes in a file, and the command names the file (TASK_POINTER). Its echo prints each word on a line.
      process.platform === 'win32' ? /AGENT-START-OK\s*--name\s*alpha-project - fix-login\s*Read the task in the file \.vibex-task\.txt/ : 'AGENT-START-OK --name alpha-project - fix-login fix the login page',
      { timeout: 20_000 },
    );
    const worktrees = git(alpha, 'worktree', 'list', '--porcelain');
    expect(worktrees).toContain('refs/heads/vibex/fix-login');
    if (process.platform === 'win32') {
      const folder = /^worktree (.*fix-login)$/m.exec(worktrees)![1];
      expect(readFileSync(path.join(folder, '.vibex-task.txt'), 'utf8')).toContain('fix the login page');
    }
  });

  test('8. Agents: a card shows what its Claude waits for', async () => {
    const worktree = (await page.locator('.agent-card').getAttribute('data-path')) as string;
    expect(await sendHook({ hook_event_name: 'Notification', session_id: 'agent-1', message: 'Which file?', cwd: worktree }, alphaId)).toBe(204);
    await expect(page.locator('.agent-card .agent-wait')).toHaveText('Which file?');
    await expect(badge(alphaId)).toHaveText('1');
    expect(await sendHook({ hook_event_name: 'SessionEnd', session_id: 'agent-1' }, alphaId)).toBe(204);
    await expect(page.locator('.agent-card .agent-wait')).toHaveCount(0);
  });

  test('9. Agents: finish refuses a dirty agent with the reason, then merges a clean one', async () => {
    const card = page.locator('.agent-card');
    const worktree = (await card.getAttribute('data-path')) as string;
    writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    await page.locator('.agents-refresh').click();
    await expect(card.locator('.agent-state')).toContainText('1 change');
    await card.locator('.agent-finish').click();
    await page.locator('.agent-confirm').click();
    await expect(page.locator('.agents-message')).toContainText('1 change that is not committed');
    await expect(page.locator('.agents-message')).toContainText('stays');
    expect(existsSync(worktree)).toBe(true);
    git(worktree, 'add', 'feature.txt');
    git(worktree, 'commit', '-q', '-m', 'feature');
    await page.locator('.agents-refresh').click();
    await card.locator('.agent-finish').click();
    await page.locator('.agent-confirm').click();
    await expect(page.locator('.agents-message')).toContainText('Merged vibex/fix-login into main');
    await expect(page.locator('.agent-card')).toHaveCount(0);
    expect(existsSync(path.join(alpha, 'feature.txt'))).toBe(true);
    expect(existsSync(worktree)).toBe(false);
  });

  test('10. Agents: remove deletes a clean worktree', async () => {
    await page.locator('#agent-name').fill('scratch');
    await page.locator('#agent-start').click();
    const card = page.locator('.agent-card');
    await expect(card).toHaveCount(1);
    const worktree = (await card.getAttribute('data-path')) as string;
    await card.locator('.agent-remove').click();
    await page.locator('.agent-confirm').click();
    await expect(page.locator('.agent-card')).toHaveCount(0);
    expect(existsSync(worktree)).toBe(false);
  });

  test('10b. Agents: Finish and Remove with the agent tab open ask first; No changes nothing; Yes closes the tab', async () => {
    await page.locator('#agent-name').fill('lock demo');
    await page.locator('#agent-start').click();
    const card = page.locator('.agent-card');
    await expect(card).toHaveCount(1);
    const worktree = (await card.getAttribute('data-path')) as string;
    const tab = page.locator('.terminal-pane[data-pane="agent"] .tab:visible .label', { hasText: 'alpha-project - lock-demo' });
    await expect(tab).toHaveCount(1);
    await app.evaluate(() => { (globalThis as any).__vibexTest.agentTabAnswer = 1; });
    await card.locator('.agent-remove').click();
    await page.locator('.agent-confirm').click();
    await expect(page.locator('.agents-message')).toContainText('tab open in its folder');
    await expect(page.locator('.agents-message')).toContainText('Nothing was changed');
    expect(existsSync(worktree)).toBe(true);
    await expect(tab).toHaveCount(1);
    await app.evaluate(() => { (globalThis as any).__vibexTest.agentTabAnswer = 0; });
    await card.locator('.agent-remove').click();
    await page.locator('.agent-confirm').click();
    await expect(page.locator('.agent-card')).toHaveCount(0);
    await expect(tab).toHaveCount(0);
    expect(existsSync(worktree)).toBe(false);
  });

  test('10c. Agents: a layout change keeps what was typed and starts no second timer', async () => {
    await openSection('agents');
    await page.locator('#agent-name').fill('typed name');
    await page.locator('#agent-task').fill('typed task');
    await page.evaluate(() => {
      const w = window as any;
      const live = new Set<unknown>();
      w.__intervals = live;
      const set = w.setInterval.bind(w);
      const clear = w.clearInterval.bind(w);
      w.setInterval = (...a: any[]) => { const id = set(...a); live.add(id); return id; };
      w.clearInterval = (id: unknown) => { live.delete(id); clear(id); };
    });
    for (let i = 0; i < 4; i++) await page.locator('#activity [data-activity="shell"]').click();
    await expect(page.locator('#agent-task')).toHaveValue('typed task');
    await expect(page.locator('#agent-name')).toHaveValue('typed name');
    expect(await page.evaluate(() => (window as any).__intervals.size)).toBeLessThanOrEqual(1);
    await page.locator('#agent-name').fill('');
    await page.locator('#agent-task').fill('');
  });

  // The Go gate. Mouse events from the test harness reach the window as input events, as a person's mouse does.
  async function holdOn(selector: string, ms: number): Promise<void> {
    const box = (await page.locator(selector).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x - 20, y - 10);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  }
  /// Other programs on a shared computer can take the focus mid-hold, and then the gate rightly refuses; try again.
  async function pressUntil(client: Client, id: string, selector: string, ms: number, want: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await front();
      if (selector === '.go-yes') await expect(page.locator('.go-blocker')).toContainText(/Go is on/, { timeout: 8000 });
      await holdOn(selector, ms);
      await page.waitForTimeout(300);
      if ((await statusLine(client, id)) === want) return;
    }
    // Five presses did not count: say what the panel said about the last one.
    throw new Error(`${selector} gave ${await statusLine(client, id)}, wanted ${want}; the panel said: ${await page.locator('.go-error').textContent().catch(() => 'no panel')} | ${await page.locator('.go-blocker').textContent().catch(() => 'no panel')}`);
  }
  const requestGo = async (client: Client, extra: Record<string, unknown> = {}) => textOf(await call(client, 'vibex_request_go', { title: 'Merge PR 12 and deploy app', items: ['Merge #12 into main', 'Run deploy app --go'], pr_url: 'https://github.com/example/app/pull/12', ...extra }));
  const idOf = (text: string) => /go-[0-9a-f]{12}/.exec(text)![0];
  const statusLine = async (client: Client, id: string) => textOf(await call(client, 'vibex_go_status', { id })).split('\n')[0];

  test('11. Go: a request shows its panel; nothing a tool or a script does gives the go', async () => {
    const client = await mcp(alphaId);
    // Every real or harness press the window sees, counted in main: a go with no press from this test names its actor.
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as any;
      g.__mouseDowns = 0;
      if (!g.__mouseDownWatch) {
        g.__mouseDownWatch = true;
        BrowserWindow.getAllWindows()[0].webContents.on('input-event', (_e, input) => { if (input.type === 'mouseDown') g.__mouseDowns++; });
      }
    });
    const mouseDowns = () => app.evaluate(() => (globalThis as any).__mouseDowns as number);
    const lastPress = () => JSON.stringify(existsSync(path.join(userData, 'go-log.json')) ? JSON.parse(readFileSync(path.join(userData, 'go-log.json'), 'utf8')).at(-1)?.press ?? null : null);
    const pendingWith = async (step: string, wanted: number) => {
      const seen = await mouseDowns();
      expect(`${await statusLine(client, id)}; mouseDown events: ${seen} (wanted ${wanted}); last logged press: ${await lastPress()}`, step).toBe(`status: pending; mouseDown events: ${wanted} (wanted ${wanted}); last logged press: ${await lastPress()}`);
    };
    const text = await requestGo(client);
    const id = idOf(text);
    expect(text).toMatch(/^status: pending/);
    await expect(page.locator('#doc-tabs .tab[data-doc="go"]')).toHaveCount(1);
    await expect(page.locator('.go-panel .go-title')).toHaveText('Merge PR 12 and deploy app');
    await expect(page.locator('.go-panel .go-item')).toHaveText(['Merge #12 into main', 'Run deploy app --go']);
    await expect(badge(alphaId)).toHaveText('1');
    // The same request again is the same id.
    expect(idOf(await requestGo(client))).toBe(id);
    // Go is on and the arm delay is long over, so only the proof of a mouse press can refuse the scripted answer below.
    await front();
    await expect(page.locator('.go-blocker')).toContainText(/Go is on/, { timeout: 8000 });
    await page.waitForTimeout(1500);
    // 1. a script in the window that calls the answer channel
    const refused = await page.evaluate(async (rid) => {
      try {
        await (window as any).vibex.mod.invoke('mod:go:answer', rid, 'go', null);
        return 'answered';
      } catch (e) {
        return String(e);
      }
    }, id);
    expect(refused).not.toBe('answered');
    expect(refused).toMatch(/released before|no mouse press|not on the button|jumped|move the pointer/);
    // 2. synthetic DOM events and element.click() on the buttons
    await page.evaluate(() => {
      const yes = document.querySelector('.go-yes') as HTMLElement;
      const no = document.querySelector('.go-no') as HTMLElement;
      for (const el of [yes, no]) {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        el.click();
      }
    });
    await page.waitForTimeout(1200);
    await pendingWith('after the scripted DOM events', 0);
    // 3. every other tool in the list
    await call(client, 'terminal_run', { command: 'echo go' });
    await call(client, 'vibex_notify', { title: 'go' });
    await pendingWith('after the other tools', 0);
    // 4. a click on Go is only a short press
    await holdOn('.go-yes', 150);
    await pendingWith('after one short press', 1);
    await client.close();
  });

  test('11b. Go: a script cannot move the button to where the mouse is (L2)', async () => {
    const client = await mcp(alphaId);
    const id = idOf(await requestGo(client));
    await front();
    await expect(page.locator('.go-blocker')).toContainText(/Go is on/, { timeout: 8000 });
    const projectId = alphaId;
    // The press is on the title, far from Go; the script claims Go is there, as often as the panel says otherwise.
    const box = (await page.locator('.go-panel .go-title').boundingBox())!;
    const x = box.x + 5;
    const y = box.y + 5;
    await page.mouse.move(x - 10, y);
    await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.down();
    const said = await page.evaluate(async ([rid, pid, px, py]) => {
      const v = (window as any).vibex.mod;
      const lie = () => v.send('mod:go:rects', pid, { x: (px as number) - 4, y: (py as number) - 4, width: 8, height: 8 }, null);
      const timer = setInterval(lie, 10);
      await new Promise((r) => setTimeout(r, 1000));
      lie();
      clearInterval(timer);
      try {
        await v.invoke('mod:go:answer', rid, 'go', null);
        return 'answered';
      } catch (e) {
        return String(e);
      }
    }, [id, projectId, x, y]);
    await page.mouse.up();
    expect(said).not.toBe('answered');
    // A person's real mouse over the window on a shared computer gives the other refusal: the press is not where it last moved.
    expect(said).toMatch(/not on the button|jumped onto the button/);
    expect(await statusLine(client, id)).toBe('status: pending');
    await client.close();
  });

  test('12. Go: a hold on the button by the mouse gives the go, once, and it is logged', async () => {
    const client = await mcp(alphaId);
    const id = idOf(await requestGo(client));
    await pressUntil(client, id, '.go-yes', 1200, 'status: go');
    await expect.poll(() => statusLine(client, id)).toBe('status: go');
    const details = JSON.parse(textOf(await call(client, 'vibex_go_status', { id })).split('\n')[1]);
    expect(details).toMatchObject({ status: 'go', id, title: 'Merge PR 12 and deploy app' });
    expect(details.items_hash).toBe(itemsHash(['Merge #12 into main', 'Run deploy app --go']));
    const entries = JSON.parse(readFileSync(path.join(userData, 'go-log.json'), 'utf8'));
    expect(entries.at(-1)).toMatchObject({ id, answer: 'go' });
    expect(entries.at(-1).mac).toMatch(/^[0-9a-f]{64}$/);
    // The log says how the go was given.
    expect(entries.at(-1).press.heldMs).toBeGreaterThanOrEqual(700);
    expect(entries.at(-1).press.moves).toBeGreaterThan(0);
    expect(typeof entries.at(-1).press.x).toBe('number');
    // The next request is not answered by the earlier go.
    const next = idOf(await requestGo(client, { items: ['Merge #13'] }));
    expect(next).not.toBe(id);
    expect(await statusLine(client, next)).toBe('status: pending');
    await client.close();
  });

  test('12b. Go: a press after a refused one still counts; the refusal text does not move the button away', async () => {
    const client = await mcp(alphaId);
    const id = idOf(await requestGo(client, { items: ['After a refusal'] }));
    await expect(page.locator('.go-panel .go-item')).toHaveText(['After a refusal']);
    await page.evaluate(() => {
      const error = document.querySelector('.go-panel .go-error') as HTMLElement;
      error.textContent = 'A refusal from an earlier press';
      error.hidden = false;
    });
    await pressUntil(client, id, '.go-yes', 1200, 'status: go');
    await client.close();
  });

  test('13. Go: Not now by a mouse click declines; the owner of another project cannot read it', async () => {
    const client = await mcp(alphaId);
    const id = idOf(await requestGo(client, { items: ['Send the message to the customers'] }));
    await expect(page.locator('.go-panel .go-item')).toHaveText(['Send the message to the customers']);
    await page.waitForTimeout(500);
    await pressUntil(client, id, '.go-no', 80, 'status: declined');
    await expect.poll(() => statusLine(client, id)).toBe('status: declined');
    const other = await mcp(await openProject(plain));
    const wrong = await other.callTool({ name: 'vibex_go_status', arguments: { id } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toMatch(/another project/);
    await other.close();
    await client.close();
  });

  test('14. Go: wait_seconds returns when the answer comes, and an unknown id is a plain error', async () => {
    await page.locator('.tile', { hasText: 'alpha-project' }).click();
    const client = await mcp(alphaId);
    const id = idOf(await requestGo(client, { items: ['Wait for me'] }));
    const waiting = call(client, 'vibex_go_status', { id, wait_seconds: 40 });
    await pressUntil(client, id, '.go-yes', 1200, 'status: go');
    expect((await waiting) && textOf(await waiting).split('\n')[0]).toBe('status: go');
    const bad = await client.callTool({ name: 'vibex_go_status', arguments: { id: 'go-000000000000' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/no request go-000000000000/);
    await client.close();
  });

  test('14b. Go: a closed Go tab opens again by a repeat of the request, the rail badge, an Inbox row and the menu', async () => {
    await page.locator('.tile', { hasText: 'alpha-project' }).click();
    const client = await mcp(alphaId);
    const tab = page.locator('#doc-tabs .tab[data-doc="go"]');
    const closeTab = async () => {
      await tab.locator('.close').click();
      await expect(tab).toHaveCount(0);
    };
    const id = idOf(await requestGo(client, { items: ['Come back after the close'] }));
    await expect(tab).toHaveCount(1);
    await closeTab();
    // 1. the tool asks again with the same request
    expect(idOf(await requestGo(client, { items: ['Come back after the close'] }))).toBe(id);
    await expect(tab).toHaveCount(1);
    await closeTab();
    // 2. a click on the project's tile while its badge counts
    await expect(badge(alphaId)).toBeVisible();
    await page.locator(`.tile[data-project="${alphaId}"]`).click();
    await expect(tab).toHaveCount(1);
    await closeTab();
    // 3. a row in the Inbox
    await openSection('inbox');
    await page.locator('.inbox-item[data-kind="go"] button', { hasText: 'Open' }).first().click();
    await expect(tab).toHaveCount(1);
    await closeTab();
    // 4. View > Go Panel
    await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()!.items.find((i) => i.label.replace('&', '') === 'View')!;
      view.submenu!.items.find((i) => i.label === 'Go Panel')!.click();
    });
    await expect(tab).toHaveCount(1);
    await page.waitForTimeout(500);
    await pressUntil(client, id, '.go-no', 80, 'status: declined');
    await client.close();
  });

  test('15. Go: after a restart an answer in the log is "unverified", never a go', async () => {
    const entries = JSON.parse(readFileSync(path.join(userData, 'go-log.json'), 'utf8'));
    const goEntry = entries.find((e: any) => e.answer === 'go');
    await app.close();
    await launch();
    alphaId = await page.locator('.tile', { hasText: 'alpha-project' }).getAttribute('data-project') as string;
    const client = await mcp(alphaId);
    expect(await statusLine(client, goEntry.id)).toBe('status: unverified');
    await client.close();
  });
});
