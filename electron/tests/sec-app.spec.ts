import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { listAgents } from '../src/main/agents';
import { AskpassService, wireReply, askpassEnvironment } from '../src/main/askpass';
import { findClaude } from '../src/main/claude';
import { listFolder } from '../src/main/files';
import { diffOf, gitStatus, listBranches, log, runGit, showCommit } from '../src/main/git';
import { GoDesk, GoLog, PointerTracker, verifyPress } from '../src/main/goDesk';
import { InboxService, installHooks } from '../src/main/inbox';
import { runChecks } from '../src/main/setup';
import { jumpCommand, sshProgram, type ServerProfile } from '../src/main/servers';
import { tempDir } from './fixtures';

// The fixes of the security review (review-security.md) and B1 of the code review. Pure functions and real programs in
// temp folders; each test names its finding. What only a Windows or a packaged run can show is in release-gate.spec.ts.

const SRC = path.join(__dirname, '..', 'src');
const read = (...parts: string[]) => readFileSync(path.join(SRC, ...parts), 'utf8');
const sources = (folder: string) => readdirSync(path.join(SRC, folder)).filter((f) => f.endsWith('.ts')).map((f) => path.join(folder, f));
const isWindows = process.platform === 'win32';

let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

test.beforeEach(() => {
  dir = realpathSync.native(tempDir('vibex-sec-app-'));
  // Never the person's own git settings.
  setEnv('GIT_CONFIG_GLOBAL', path.join(dir, 'no-global-config'));
  setEnv('GIT_CONFIG_NOSYSTEM', '1');
  setEnv('GIT_AUTHOR_NAME', 'Test');
  setEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  setEnv('GIT_COMMITTER_NAME', 'Test');
  setEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
});

test.afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  process.chdir(path.join(__dirname, '..'));
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function makeRepo(name = 'repo'): string {
  const folder = path.join(dir, name);
  mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(folder, 'a.conv'), 'one\n');
  writeFileSync(path.join(folder, '.gitattributes'), '*.conv diff=conv filter=conv\n');
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', 'first');
  return folder;
}

/// A script that leaves a mark when something runs it, so a test can see that git started a program from a folder's config.
function markerScript(name = 'mark.sh'): { script: string; marker: string } {
  const marker = path.join(dir, `${name}.ran`);
  const script = path.join(dir, name);
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null 2>&1\nexit 0\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

test.describe('H2: Electron fuses', () => {
  test('electron-builder.yml turns the four fuses the review names', () => {
    const yml = readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    const block = /^electronFuses:\n((?:  .*\n)+)/m.exec(yml)?.[1] ?? '';
    expect(block).toMatch(/^ {2}runAsNode: false$/m);
    expect(block).toMatch(/^ {2}enableNodeCliInspectArguments: false$/m);
    expect(block).toMatch(/^ {2}enableNodeOptionsEnvironmentVariable: false$/m);
    expect(block).toMatch(/^ {2}onlyLoadAppFromAsar: true$/m);
  });
});

test.describe('M7: test switches', () => {
  const SWITCHES = ['VIBEX_TEST', 'VIBEX_GO_ARM_MS', 'VIBEX_GO_HOLD_MS', 'VIBEX_GO_ASSUME_FRONT', 'VIBEX_SECRET_CRYPT', 'VIBEX_AGENT_COMMAND', 'VIBEX_CLAUDE_BIN', 'VIBEX_CLAUDE_MISSING', 'VIBEX_USER_DATA', 'VIBEX_MCP_PORT', 'VIBEX_TOKEN_STORE', 'VIBEX_REGISTER_CLAUDE'];

  test('a switch is read in one file only, and only when the build allows it', async () => {
    const leaks: string[] = [];
    for (const file of sources('main')) {
      if (file.endsWith('testSwitches.ts')) continue;
      const text = read(file);
      for (const name of SWITCHES) if (new RegExp(`process\\.env\\.${name}\\b|process\\.env\\[['"]${name}`).test(text)) leaks.push(`${file}: ${name}`);
      if (/process\.env\[name\]/.test(text)) leaks.push(`${file}: process.env[name]`);
    }
    expect(leaks).toEqual([]);
    const { switchesAllowed } = await import('../src/main/testSwitches');
    expect(switchesAllowed('dev')).toBe(true);
    expect(switchesAllowed('release')).toBe(false);
    expect(switchesAllowed('proof')).toBe(true);
  });

  test('the test hooks exist only in a test run', () => {
    expect(read('main', 'main.ts')).toMatch(/if \(isTestRun\(\)\) \{\n\s*\/\/ Read by the Playwright tests[^\n]*\n\s*\(globalThis as any\)\.__vibexTest = /);
  });
});

test.describe('H3: programs by an absolute path', () => {
  test('a git planted in the project is not run, also with a relative entry on the PATH', async () => {
    const folder = makeRepo();
    const planted = path.join(folder, isWindows ? 'git.cmd' : 'git');
    const { marker } = markerScript();
    writeFileSync(planted, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(planted, 0o755);
    setEnv('PATH', `.${path.delimiter}${process.env.PATH}`);
    const r = await runGit(folder, ['--version']);
    expect(existsSync(marker), 'the planted git ran').toBe(false);
    expect(r.out).toMatch(/^git version/);
    await listAgents(folder, path.join(dir, 'agents-root'));
    expect(existsSync(marker), 'the agents code ran the planted git').toBe(false);
  });

  test('the lookup reads PATH only: absolute folders, the Windows suffix, never the current folder', async () => {
    const { findProgram } = await import('../src/main/programs');
    const files = new Set(['C:\\Git\\cmd\\git.exe', 'C:\\work\\git.exe', 'C:\\Bad\\git.cmd', '/usr/bin/git', 'bin/git']);
    const isFile = (f: string) => files.has(f);
    expect(findProgram('git', { platform: 'win32', pathValue: '.;C:\\Bad;work;C:\\Git\\cmd', isFile })).toBe('C:\\Git\\cmd\\git.exe');
    expect(findProgram('git', { platform: 'win32', pathValue: '.;work', isFile })).toBeNull();
    expect(findProgram('git', { platform: 'win32', pathValue: '', isFile })).toBeNull();
    expect(findProgram('git', { platform: 'linux', pathValue: ':.:bin:/usr/bin', isFile })).toBe('/usr/bin/git');
    expect(findProgram('git', { platform: 'linux', pathValue: 'bin', isFile })).toBeNull();
  });

  test('ssh and the first-run checks get an absolute path; a missing program stays missing', async () => {
    expect(path.isAbsolute(sshProgram()), sshProgram()).toBe(true);
    const seen: string[] = [];
    await runChecks(dir, async (file) => { seen.push(file); return 'found'; }, () => null);
    expect(seen.filter((f) => !path.isAbsolute(f))).toEqual([]);
    setEnv('PATH', path.join(dir, 'empty'));
    // N12: no path at all, because any made-up path is one that someone could create.
    expect(() => sshProgram()).toThrow(/ssh was not found/);
    await expect(runGit(dir, ['--version'])).rejects.toThrow(/Git is not installed/);
  });

  test('a jump login on Windows names ssh by the path it was given', () => {
    const jump: ServerProfile = { name: 'j', host: 'j.example', user: 'hop' };
    expect(jumpCommand(jump, 'win32')).toMatch(/^"[^"]*ssh\.exe" "-l" "hop"/);
    expect(jumpCommand(jump, 'linux')).toMatch(/^'?ssh'? /);
  });

  test('a claude planted in the current folder is not found through a relative PATH entry', () => {
    const planted = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    writeFileSync(planted, '#!/bin/sh\n');
    chmodSync(planted, 0o755);
    process.chdir(dir);
    setEnv('PATH', '.');
    // Each is the home folder on one system. A computer with Claude Code has a real one in the true home.
    setEnv('HOME', path.join(dir, 'empty-home'));
    setEnv('USERPROFILE', path.join(dir, 'empty-home'));
    expect(findClaude()).toBeNull();
  });
});

test.describe("git config: a folder's settings run no program", () => {
  test('core.fsmonitor does not run on a status, a list of agents, or a list of files', async () => {
    const folder = makeRepo();
    const { script, marker } = markerScript();
    // Before the setting: this test's own git would run it.
    git(folder, 'worktree', 'add', '-q', '-b', 'vibex/one', path.join(dir, 'wt'), 'HEAD');
    git(folder, 'config', 'core.fsmonitor', script);
    await gitStatus(folder);
    expect(existsSync(marker), 'gitStatus ran core.fsmonitor').toBe(false);
    await listAgents(folder, path.join(dir, 'agents-root'));
    expect(existsSync(marker), 'the list of agents ran core.fsmonitor').toBe(false);
    await listFolder(folder, '');
    expect(existsSync(marker), 'the file list ran core.fsmonitor').toBe(false);
  });

  test('a textconv does not run on a diff or on a commit view', async () => {
    const folder = makeRepo();
    const { script, marker } = markerScript();
    git(folder, 'config', 'diff.conv.textconv', script);
    writeFileSync(path.join(folder, 'a.conv'), 'two\n');
    git(folder, 'add', 'a.conv');
    const hash = git(folder, 'commit', '-q', '-m', 'second') || git(folder, 'rev-parse', 'HEAD');
    writeFileSync(path.join(folder, 'a.conv'), 'three\n');
    await diffOf(folder, { path: 'a.conv', area: 'unstaged', kind: 'modified' });
    expect(existsSync(marker), 'diffOf ran the textconv').toBe(false);
    await showCommit(folder, git(folder, 'rev-parse', 'HEAD'));
    expect(existsSync(marker), `showCommit ran the textconv (${hash})`).toBe(false);
  });

  for (const [key, form] of [['filter.conv.clean', 'a filter'], ['filter.conv.process', 'a filter process'], ['core.sshCommand', 'an ssh command']] as const) {
    test(`${form} in the folder's own settings: the reads say so and run nothing`, async () => {
      const folder = makeRepo();
      const { script, marker } = markerScript();
      git(folder, 'config', key, script);
      writeFileSync(path.join(folder, 'a.conv'), 'two\n');
      for (const read of [() => gitStatus(folder), () => log(folder, 1), () => listBranches(folder), () => diffOf(folder, { path: 'a.conv', area: 'unstaged', kind: 'modified' })]) {
        await expect(read()).rejects.toThrow(new RegExp(`Git settings.*${key.split('.')[0]}`, 'i'));
      }
      expect(existsSync(marker), 'a read ran the program').toBe(false);
      const agents = await listAgents(folder, path.join(dir, 'agents-root'));
      expect(agents.agents).toEqual([]);
      expect(agents.problem).toMatch(/Git settings/);
    });
  }

  test('a filter from an included file counts; one in the person own settings does not', async () => {
    const folder = makeRepo();
    const included = path.join(dir, 'more.gitconfig');
    writeFileSync(included, '[filter "conv"]\n\tsmudge = cat\n');
    git(folder, 'config', 'include.path', included);
    await expect(gitStatus(folder)).rejects.toThrow(/Git settings/);
    git(folder, 'config', '--unset', 'include.path');
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '[filter "lfs"]\n\tclean = cat\n');
    expect(await gitStatus(folder)).toMatchObject({ repo: true });
  });
});

const profile = (name: string, extra: Partial<ServerProfile> = {}): ServerProfile => ({ name, host: `${name}.example`, user: name, authentication: 'password', ...extra } as ServerProfile);

/// A real askpass service on a real socket, with made-up saved secrets.
async function askpassService(profiles: ServerProfile[]) {
  const notes: string[] = [];
  const service = new AskpassService({
    secrets: { get: (p: ServerProfile, kind: string) => `${kind}-of-${p.name}`, available: () => true } as any,
    questions: { ask: async () => ({ refused: 'no person in this test' }) } as any,
    profiles: () => profiles,
    notify: (title, message) => notes.push(`${title}: ${message}`),
  }, { helper: process.execPath, packaged: true, execPath: process.execPath, appPath: '' });
  await service.start();
  expect(service.problem).toBeNull();
  return { service, notes };
}

/// One request as the helper sends it: a framed line, and the socket stays open both ways.
function askFramed(socketPath: string, key: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let out = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(`no reply in time; had ${JSON.stringify(out)}`); }, 8000);
    socket.on('error', reject);
    socket.on('data', (d) => { out += d; });
    socket.on('close', () => { clearTimeout(timer); resolve(out); });
    socket.write(`${JSON.stringify({ key, hint: '', prompt })}\n`);
  });
}

test.describe('B1: askpass over a framed line', () => {
  test('main answers the frame, with no half-close from the helper', async () => {
    const a = profile('alpha');
    const { service } = await askpassService([a]);
    try {
      const { env } = service.ticket(a);
      expect(await askFramed(env.VIBEX_ASKPASS_SOCKET, env.VIBEX_ASKPASS_KEY, "alpha@alpha.example's password:")).toBe('OK\npassword-of-alpha\n');
    } finally {
      service.stop();
    }
  });

  test('on Windows no ssh is sent to the app for its answers: Electron would give an empty one', async () => {
    test.skip(process.platform !== 'win32', 'other systems use the app, and the tests above cover it');
    const missing = new AskpassService({ secrets: {} as any, questions: {} as any, profiles: () => [], notify: () => {} } as any, { packaged: true, execPath: process.execPath, appPath: 'y', helper: path.join(dir, 'gone.exe') });
    await missing.start();
    expect(missing.ticket(profile('alpha')).env).toEqual({});
    expect(missing.problem).toMatch(/Type the password in the tab/);
    missing.stop();
    const service = new AskpassService({ secrets: {} as any, questions: {} as any, profiles: () => [], notify: () => {} } as any, { packaged: true, execPath: process.execPath, appPath: 'y', helper: process.execPath });
    await service.start();
    const { env } = service.ticket(profile('alpha'));
    expect(env.SSH_ASKPASS).toBe(process.execPath);
    expect(env.VIBEX_ASKPASS_HELPER).toBeUndefined();
    service.stop();
  });

  test('the reply is a frame too', () => {
    expect(wireReply('abc').toString()).toBe('OK\nabc\n');
    expect(wireReply(null).toString()).toBe('NO\n');
  });

  // Windows named pipes: a shutdown with a read pending closes both ends (libuv src/win/pipe.c). This server does the
  // same on a Unix socket, so the old helper's half-close fails here as it does on Windows.
  /// On Windows Electron writes a line end first, so ssh would read an empty answer. This is why ssh runs a native helper there
  /// (askpass.ts). If this goes red on Windows, Electron has changed, and the app could answer ssh itself.
  const helperOut = process.platform === 'win32' ? '\r\nfrom-the-frame\n' : 'from-the-frame\n';

  /// A Unix socket, or on Windows a named pipe, as the app itself uses (askpass.ts).
  const helperSocket = (name: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\vibex-test-${process.pid}-${name}` : path.join(dir, `${name}.sock`));

  /// The app as ssh runs it: the prompt as its argument, the answer on its stdout.
  async function runHelper(socketPath: string): Promise<{ code: number | string; out: string }> {
    const electron = require('electron') as unknown as string;
    const child = spawn(electron, ['.', "someone's password:"], {
      cwd: path.join(__dirname, '..'),
      // What ssh gets from the app, so the answer is tested as the app sets it up.
      env: { ...process.env, ...askpassEnvironment({ platform: process.platform === 'win32' ? 'linux' : process.platform, packaged: true, execPath: electron, wrapper: null, socket: socketPath, key: 'k' }) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise<number | string>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve('still waiting after 15 s'); }, 15_000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 'killed'); });
    });
    return { code, out };
  }

  // The answer and the close of the socket come together, as they do from main. An exit at the close would lose the answer.
  test('the helper prints its answer also when the socket closes right after it', async () => {
    const socketPath = helperSocket('closing');
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', (chunk) => { if (String(chunk).includes('\n')) socket.end('OK\nfrom-the-frame\n'); });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      for (let i = 0; i < 4; i++) expect(await runHelper(socketPath)).toEqual({ code: 0, out: helperOut });
    } finally {
      server.close();
    }
  });

  test('the helper gets its answer from a server that closes at a half-close, as a Windows pipe does', async () => {
    const socketPath = helperSocket('pipe-like');
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let text = '';
      socket.on('end', () => socket.destroy());
      socket.on('data', (chunk) => {
        text += chunk;
        // The reply stays open afterwards: only the frame can end the helper's wait.
        if (text.includes('\n')) setTimeout(() => socket.write('OK\nfrom-the-frame\n'), 200);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(await runHelper(socketPath)).toEqual({ code: 0, out: helperOut });
    } finally {
      server.close();
    }
  });
});

test.describe('M6: a ticket answers its own logins only', () => {
  test('a prompt that names another saved server gets nothing', async () => {
    const a = profile('alpha');
    const other = profile('other');
    const { service, notes } = await askpassService([a, other]);
    try {
      const { env } = service.ticket(a);
      expect(await askFramed(env.VIBEX_ASKPASS_SOCKET, env.VIBEX_ASKPASS_KEY, "other@other.example's password:")).toBe('NO\n');
      expect(notes.join('\n')).toContain('did not answer');
      expect(await askFramed(env.VIBEX_ASKPASS_SOCKET, env.VIBEX_ASKPASS_KEY, "alpha@alpha.example's password:")).toBe('OK\npassword-of-alpha\n');
    } finally {
      service.stop();
    }
  });

  test("the ticket's jump server and a listed ProxyJump are answered; an unlisted one is not", async () => {
    const a = profile('alpha', { options: { ProxyJump: 'hop@hop.example' } } as any);
    const jump = profile('jump');
    const hop = profile('hop');
    const other = profile('other');
    const { service } = await askpassService([a, jump, hop, other]);
    try {
      const { env } = service.ticket(a, jump);
      const ask = (prompt: string) => askFramed(env.VIBEX_ASKPASS_SOCKET, env.VIBEX_ASKPASS_KEY, prompt);
      expect(await ask("jump@jump.example's password:")).toBe('OK\npassword-of-jump\n');
      expect(await ask("hop@hop.example's password:")).toBe('OK\npassword-of-hop\n');
      expect(await ask("other@other.example's password:")).toBe('NO\n');
    } finally {
      service.stop();
    }
  });
});

test.describe('L3: the mode of settings.json', () => {
  test('hooks keep the file mode the person set', () => {
    test.skip(isWindows, 'Windows has no file modes');
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, '{}\n');
    chmodSync(file, 0o600);
    installHooks(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('hooks');
  });

  test('a new file is private to the person', () => {
    test.skip(isWindows, 'Windows has no file modes');
    const file = path.join(dir, 'new', 'settings.json');
    installHooks(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

test.describe('L4: no command text in a system notification', () => {
  test('a waiting event names the tool only; the Inbox line keeps the detail', () => {
    const service = new InboxService();
    const sent: string[] = [];
    (service as any).host = { projects: { get: () => ({ name: 'demo' }) }, send: () => undefined, terminals: { list: () => [] } };
    (service as any).notify = (title: string, body: string) => sent.push(`${title}|${body}`);
    (service as any).snapshot = () => ({});
    const secret = 'curl https://example.com/a?token=made-up-text';
    service.handle('p', { name: 'PermissionRequest', session: 's1', cwd: '/x', tool: 'Bash', detail: secret } as any);
    service.handle('p', { name: 'Notification', session: 's2', cwd: '/x', message: `Claude wants to run ${secret}` } as any);
    expect(sent).toHaveLength(2);
    expect(sent.join('\n')).not.toContain('made-up-text');
    expect(sent[0]).toContain('Bash');
    expect(service.waitingIn('p').map((w) => w.message).join('\n')).toContain('made-up-text');
  });

  test('a Go request does not put its title in a system notification', () => {
    expect(read('main', 'go.ts')).not.toMatch(/inbox\.notify\([^\n]*request\.title/);
  });
});

test.describe('L5: approval shows the value that runs', () => {
  // Structure only: the two reads sit in one tick of main, so no test can change the file between them.
  test('the sheet uses the command given to it, and reads no file', () => {
    const approve = /approve: async \((.*?)\) => \{[\s\S]*?\n {4}\},/.exec(read('main', 'pcaTools.ts'))!;
    expect(approve[1]).toMatch(/project, command/);
    expect(approve[0]).not.toMatch(/loadRunFile/);
    expect(approve[0]).toMatch(/\$\{command\}/);
  });
});

test.describe('L2 and test 11: what the log keeps of a press', () => {
  const rect = { x: 100, y: 100, width: 80, height: 30 };

  test('each entry keeps position, hold time and move count, under the signature', () => {
    const file = path.join(dir, 'go-log.json');
    const key = Buffer.alloc(32, 7);
    const log = new GoLog(file, () => key);
    const desk = new GoDesk(log, { armMs: 10, holdMs: 100 });
    const request = desk.submit({ title: 't', items: ['i'], reviewUrl: null, prUrl: null }, 'p', 'demo', '/demo', 1000);
    desk.setFront(true, 1000);
    desk.noteShown('p', request.id, 1000);
    desk.noteReadToEnd(request.id);
    const tracker = new PointerTracker();
    for (const [x, t] of [[110, 1100], [115, 1110], [120, 1120]]) tracker.feed({ type: 'mouseMove', x, y: 110 }, t);
    tracker.feed({ type: 'mouseDown', x: 120, y: 110, button: 'left' }, 1200);
    desk.answer(request.id, 'go', null, verifyPress(tracker.press(), rect, 1400, 100));
    const entry = log.entries()[0] as any;
    expect(entry.press).toEqual({ x: 120, y: 110, heldMs: 200, moves: 3 });
    expect(log.isValid(entry)).toBe(true);
    expect(log.isValid({ ...entry, press: { ...entry.press, moves: 9 } })).toBe(false);
  });
});

test.describe('the helper run', () => {
  test('the app refuses a remote debugging port in a release build, before anything else loads', () => {
    const entry = read('main', 'entry.ts');
    expect(entry).toMatch(/remote-debugging-port/);
    expect(entry.indexOf('remote-debugging-port')).toBeLessThan(entry.indexOf("require('./app.js')"));
  });
});

