import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent, finishAgent, noClaudeRefusal, removeAgent, TASK_FILE, writeTaskFile } from '../src/main/agents';
import { claimClaudeFound } from '../src/main/claude';
import { startEndedByQuit } from '../src/main/faultGuard';
import { commit, folderProgramRefusal } from '../src/main/git';
import { endLookups, endsWithApp } from '../src/main/programs';
import { hostKeyVerdict, PCA_HOST, PCA_HOST_KEY_FINGERPRINT } from '../src/main/pcaHostKey';
import { watchInstall } from '../src/main/updateFlow';
import { tempDir } from './fixtures';

// Review 3 of 2026-10-31, the parts with no window. Real git on made-up repositories, with a witness file for each program.

const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function repo() {
  const dir = realpathSync.native(tempDir('vibex-review3-'));
  const main = path.join(dir, 'repo');
  mkdirSync(main);
  const witness = path.join(dir, 'witness');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const program = path.join(dir, 'program.sh');
  writeFileSync(program, `#!/bin/sh\necho program >> '${witness}'\nexit 0\n`);
  chmodSync(program, 0o755);
  const hook = (...names: string[]) => {
    for (const name of names) {
      const file = path.join(main, '.git', 'hooks', name);
      writeFileSync(file, `#!/bin/sh\necho ${name} >> '${witness}'\n`);
      chmodSync(file, 0o755);
    }
  };
  const ran = () => (existsSync(witness) ? readFileSync(witness, 'utf8').trim().split('\n') : []);
  return { dir, main, agents: path.join(dir, 'agents'), witness, git, program, hook, ran, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test.describe('review 3', () => {
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  test.beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  test.afterAll(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
  });

  test('S1: Start Agent, Finish and Remove run none of the folder\'s hooks', async () => {
    const r = repo();
    try {
      r.hook('post-checkout', 'post-merge', 'reference-transaction', 'pre-merge-commit', 'pre-commit', 'commit-msg', 'post-commit');
      const one = await createAgent(r.main, r.agents, 'one', undefined);
      expect(r.ran()).toEqual([]);
      writeFileSync(path.join(one.path, 'b.txt'), 'b\n');
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: one.path });
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'two'], { cwd: one.path });
      expect(await finishAgent(r.main, r.agents, one.path)).toMatch(/^Merged/);
      expect(existsSync(path.join(r.main, 'b.txt'))).toBe(true);
      const two = await createAgent(r.main, r.agents, 'two', undefined);
      await removeAgent(r.main, r.agents, two.path);
      expect(r.ran()).toEqual([]);
    } finally {
      r.done();
    }
  });

  test('S2: a merge driver in the folder\'s settings is refused, and it does not run', async () => {
    const r = repo();
    try {
      r.git('config', 'merge.own.driver', `${r.program} %O %A %B`);
      expect(await folderProgramRefusal(r.main)).toMatch(/can run a program \(merge\.own\.driver\)/);
    } finally {
      r.done();
    }
  });

  test('S2: gpg.ssh.defaultKeyCommand is refused, and a Commit does not run it', async () => {
    const r = repo();
    try {
      r.git('config', 'gpg.ssh.defaultKeyCommand', r.program);
      r.git('config', 'commit.gpgSign', 'true');
      r.git('config', 'gpg.format', 'ssh');
      expect(await folderProgramRefusal(r.main)).toMatch(/can run a program \(gpg\.ssh\.defaultkeycommand\)/);
      writeFileSync(path.join(r.main, 'b.txt'), 'b\n');
      r.git('add', 'b.txt');
      await expect(commit(r.main, 'second')).rejects.toThrow(/can run a program/);
      expect(r.ran()).toEqual([]);
    } finally {
      r.done();
    }
  });

  test('S2: a setting that arrives after the first look stops the merge, and the driver does not run', async () => {
    const r = repo();
    try {
      writeFileSync(path.join(r.main, '.gitattributes'), 'a.txt merge=own\n');
      r.git('add', '.');
      r.git('commit', '-qm', 'attributes');
      const one = await createAgent(r.main, r.agents, 'one', undefined);
      writeFileSync(path.join(one.path, 'a.txt'), 'agent\n');
      execFileSync('git', ['add', '.'], { cwd: one.path });
      execFileSync('git', ['commit', '-qm', 'agent'], { cwd: one.path, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
      writeFileSync(path.join(r.main, 'a.txt'), 'project\n');
      r.git('add', '.');
      r.git('commit', '-qm', 'project');
      const before = r.git('rev-parse', 'HEAD');
      await expect(finishAgent(r.main, r.agents, one.path, { prepare: async () => { r.git('config', 'merge.own.driver', `${r.program} %O %A %B`); } })).rejects.toThrow(/can run a program/);
      expect(r.ran()).toEqual([]);
      expect(r.git('rev-parse', 'HEAD')).toBe(before);
      expect(existsSync(one.path)).toBe(true);
    } finally {
      r.done();
    }
  });

  test('S2: a setting that arrives before a Remove stops it, and the folder stays', async () => {
    const r = repo();
    try {
      const one = await createAgent(r.main, r.agents, 'one', undefined);
      await expect(removeAgent(r.main, r.agents, one.path, { prepare: async () => { r.git('config', 'filter.own.smudge', r.program); } })).rejects.toThrow(/can run a program/);
      expect(existsSync(one.path)).toBe(true);
    } finally {
      r.done();
    }
  });

  test('S3: a task file that is a link is refused, and what the link names keeps its text', async () => {
    const r = repo();
    try {
      const one = await createAgent(r.main, r.agents, 'one', undefined);
      const target = path.join(r.dir, 'target.txt');
      writeFileSync(target, 'KEEP');
      symlinkSync(target, path.join(one.path, TASK_FILE));
      await expect(writeTaskFile(one.path, 'the task')).rejects.toThrow(/already has a file named \.vibex-task\.txt/);
      expect(readFileSync(target, 'utf8')).toBe('KEEP');
    } finally {
      r.done();
    }
  });

  test('S3: a tracked file of that name stays as it is', async () => {
    const r = repo();
    try {
      writeFileSync(path.join(r.main, TASK_FILE), 'TRACKED');
      r.git('add', '.');
      r.git('commit', '-qm', 'task file');
      const one = await createAgent(r.main, r.agents, 'one', undefined);
      await expect(writeTaskFile(one.path, 'the task')).rejects.toThrow(/already has a file named/);
      expect(readFileSync(path.join(one.path, TASK_FILE), 'utf8')).toBe('TRACKED');
    } finally {
      r.done();
    }
  });

  test('S3: Start Agent takes the agent away again when its task cannot be written', () => {
    const code = read('src/main/agents.ts');
    const handler = code.slice(code.indexOf("'mod:agents:create'"), code.indexOf("'mod:agents:open'"));
    expect(handler).toMatch(/writeTaskFile\(made\.path, cleanTask\)\.catch\(/);
    expect(handler).toMatch(/removeAgent\(/);
  });

  test('S4: only the form for port 22 is judged against the pinned key', () => {
    const other = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ask = (host: string, fingerprint: string) => `The authenticity of host '${host}' can't be established.\nED25519 key fingerprint is ${fingerprint}.`;
    expect(hostKeyVerdict(ask(`${PCA_HOST} (${PCA_HOST})`, PCA_HOST_KEY_FINGERPRINT))).toBe('match');
    expect(hostKeyVerdict(ask(`${PCA_HOST} (${PCA_HOST})`, other))).toBe('changed');
    expect(hostKeyVerdict(`Host key for ${PCA_HOST} has changed`)).toBe('changed');
    expect(hostKeyVerdict(ask(`[${PCA_HOST}]:2222 ([${PCA_HOST}]:2222)`, other))).toBeNull();
    expect(hostKeyVerdict(`Host key for [${PCA_HOST}]:2222 has changed`)).toBeNull();
    expect(hostKeyVerdict(ask(`server.example.invalid (${PCA_HOST})`, other))).toBeNull();
    expect(hostKeyVerdict(ask(`evil.${PCA_HOST}.example.invalid`, other))).toBeNull();
  });

  test('N1: on PowerShell with no claude.exe, Start Agent and Open refuse in plain words', () => {
    expect(noClaudeRefusal('pwsh', null, undefined)).toMatch(/^Install Claude Code first/);
    expect(noClaudeRefusal('pwsh', 'C:\\claude.exe', undefined)).toBeNull();
    // The other shells may find it through the login shell (nvm), and a test may name its own command.
    expect(noClaudeRefusal('posix', null, undefined)).toBeNull();
    expect(noClaudeRefusal('pwsh', null, 'echo OK')).toBeNull();
    const code = read('src/main/agents.ts');
    const create = code.slice(code.indexOf("'mod:agents:create'"), code.indexOf("'mod:agents:open'"));
    expect(create.indexOf('refuseWithoutClaude()')).toBeGreaterThan(-1);
    expect(create.indexOf('refuseWithoutClaude()')).toBeLessThan(create.indexOf('createAgent('));
    expect(code.slice(code.indexOf("'mod:agents:open'"), code.indexOf("'mod:agents:finish'"))).toContain('refuseWithoutClaude()');
  });

  test('N4: a second click while the first still registers opens nothing', () => {
    const status = { claudeInstalled: false, claude: 'not registered: Claude Code is not installed (or only as an npm claude.cmd on Windows)' };
    expect(claimClaudeFound(status)).toBe(true);
    // The first click waits for two `claude mcp` runs here, and status.claude has not changed yet.
    expect(claimClaudeFound(status)).toBe(false);
    expect(claimClaudeFound({ claudeInstalled: true, claude: 'registered' })).toBe(false);
    const main = read('src/main/main.ts');
    const handler = main.slice(main.indexOf("'mod:setup:claude-found'"), main.indexOf('const { token, store } = loadMcpToken()'));
    expect(handler.indexOf('claimClaudeFound(status)')).toBeGreaterThan(-1);
    expect(handler.indexOf('claimClaudeFound(status)')).toBeLessThan(handler.indexOf('await'));
  });

  test.describe('N7: a failed installer start', () => {
    const preventable = () => { const e = { prevented: false, preventDefault() { e.prevented = true; } }; return e; };

    test('an error that comes after the call says so, and the app does not quit from under the line', () => {
      const updater = new EventEmitter();
      const app = new EventEmitter();
      let failed = 0;
      watchInstall(updater, app, () => undefined, () => { failed++; });
      updater.emit('error', new Error('spawn failed'));
      expect(failed).toBe(1);
      const quit = preventable();
      app.emit('before-quit', quit);
      expect(quit.prevented).toBe(true);
      // Only that one quit: the person can still quit after it.
      const next = preventable();
      app.emit('before-quit', next);
      expect(next.prevented).toBe(false);
      expect(updater.listenerCount('error')).toBe(0);
    });

    test('an error during the call says so too', () => {
      const updater = new EventEmitter();
      const app = new EventEmitter();
      let failed = 0;
      watchInstall(updater, app, () => updater.emit('error', new Error('no path')), () => { failed++; });
      expect(failed).toBe(1);
    });

    test('a quit that goes ahead ends the watch, and blocks nothing', () => {
      const updater = new EventEmitter();
      const app = new EventEmitter();
      let failed = 0;
      updater.on('error', () => undefined);
      watchInstall(updater, app, () => undefined, () => { failed++; });
      const quit = preventable();
      app.emit('before-quit', quit);
      expect(quit.prevented).toBe(false);
      updater.emit('error', new Error('later'));
      expect(failed).toBe(0);
      expect(updater.listenerCount('error')).toBe(1);
      expect(app.listenerCount('before-quit')).toBe(0);
    });

    test('the Restart button goes through it', () => {
      const code = read('src/main/updater.ts');
      expect(code).toMatch(/watchInstall\(autoUpdater, app,/);
      expect(code).not.toMatch(/autoUpdater\.off\('error', failure\)/);
    });
  });

  test('item 1: a short question to a program ends with the app, and every quit path ends what the app started', async () => {
    const child = endsWithApp(spawn('sleep', ['30'], { stdio: 'ignore' }));
    const ended = new Promise<string | null>((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    endLookups();
    expect(await ended).toBe('SIGTERM');
    // A finished one is off the list: this must not throw.
    endLookups();
    const main = read('src/main/main.ts');
    const quit = main.slice(main.indexOf("app.on('will-quit', () => {"), main.indexOf('function send('));
    for (const step of ['hub?.closeAll()', 'terminals.closeAll()', 'endLookups()']) expect(quit, step).toContain(step);
    for (const [file, call] of [['src/main/askpass.ts', "endsWithApp(execFile(sshProgram(), ['-V']"], ['src/main/askpass.ts', 'endsWithApp(execFile(sshProgram(), args, { timeout: 5_000'], ['src/main/setup.ts', 'endsWithApp(execFile(file, args'], ['src/main/claude.ts', 'endsWithApp(execFile(file, args'], ['src/main/servers.ts', 'endsWithApp(execFile(sshProgram(), args']]) expect(read(file), call).toContain(call);
  });

  test('item 1: a quit during the start shows no box: the box would stop the quit for good', () => {
    expect(startEndedByQuit({ quitting: true, windowMade: true, windowGone: false })).toBe(true);
    expect(startEndedByQuit({ quitting: false, windowMade: true, windowGone: true })).toBe(true);
    // A real failure still says so, also before the window exists.
    expect(startEndedByQuit({ quitting: false, windowMade: true, windowGone: false })).toBe(false);
    expect(startEndedByQuit({ quitting: false, windowMade: false, windowGone: true })).toBe(false);
    const main = read('src/main/main.ts');
    const caught = main.slice(main.indexOf('app.whenReady().then(start).catch'), main.indexOf("app.on('window-all-closed'"));
    expect(caught.indexOf('startEndedByQuit(')).toBeGreaterThan(-1);
    expect(caught.indexOf('startEndedByQuit(')).toBeLessThan(caught.indexOf('showErrorBox'));
    expect(main).toMatch(/app\.on\('before-quit', \(\) => \{ quitting = true; \}\)/);
  });

  test('N8: the install guide connects, asks for the log, and has a way on with no note', () => {
    const page = read('INSTALL-WINDOWS.md');
    expect(page).toMatch(/If there is no note, go to step 6/);
    expect(page).toMatch(/vibex-errors\.log/);
    const six = page.slice(page.indexOf('## Step 6'), page.indexOf('## Updates'));
    expect(six).toMatch(/\d+\. Click "Connect PCA"/);
  });

  test('the first-run check has steps that test what they say', () => {
    const page = read('WINDOWS-FIRST-RUN.md');
    expect(page).toContain("Write-Output 'two  spaces'");
    expect(page).not.toContain('echo two  spaces');
    expect(page).not.toContain('Run npm --version');
    expect(page).toContain('.ps1');
    expect(page).toMatch(/^42\. .*vibex tools/m);
    expect(page).toMatch(/^20\. .*not the PCA server/m);
    for (const words of [/PCA server.*different host key|different host key.*PCA server/, /pre-commit/, /while the app runs/, /vibex_preview.*\.html/]) expect(page, String(words)).toMatch(words);
    const steps = page.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => Number(/^\d+/.exec(l)![0]));
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(46);
  });
});
