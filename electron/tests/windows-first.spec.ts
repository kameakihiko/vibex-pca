import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentCommand, agentLaunch, createAgent, finishAgent, listAgents, removeAgent, TASK_POINTER, writeTaskFile } from '../src/main/agents';
import { classify, keyNameMatches } from '../src/main/askpass';
import { boundedLog, installFaultGuard, isForkRefusal } from '../src/main/faultGuard';
import { findProgram } from '../src/main/programs';
import type { ServerProfile } from '../src/main/servers';
import { endWindowsTree, spawnPty, Terminals, windowsClaudeCommand, windowsCommandArgs, type Launch } from '../src/main/terminals';
import { expandEnvText, mergePath, parseRegExport, refreshWindowsPath } from '../src/main/windowsPath';
import { lf } from '../src/renderer/notesMarkdown';
import { holdFolder, sleeper, tempDir } from './fixtures';

// The first Windows install (code review 2 of 2026-10-31), the parts with no window. Windows code runs here as logic or
// as text: nothing in this file proves a real Windows. A real PowerShell runs where one is on the PATH (the fence has one).

const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pwsh = (() => {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
    return true;
  } catch {
    return false;
  }
})();

test.describe('W1: a live tab closes with no fork', () => {
  const options = { name: 'x', cols: 80, rows: 24, cwd: 'C:\\', env: {} };

  test('on Windows the terminal uses the conpty.dll of the package, whose kill does not fork', () => {
    const seen: any[] = [];
    const proc = { pid: 1 } as any;
    expect(spawnPty('a.exe', [], options, 'win32', (_f, _a, o) => { seen.push(o); return proc; })).toBe(proc);
    expect(seen).toHaveLength(1);
    expect(seen[0].useConptyDll).toBe(true);
  });

  test('a conpty.dll that cannot load falls back to the conpty of Windows, and a tab still opens', () => {
    const seen: any[] = [];
    const proc = spawnPty('a.exe', [], options, 'win32', (_f, _a, o) => {
      seen.push(o);
      if (o.useConptyDll) throw new Error('Failed to load conpty.dll');
      return { pid: 2 } as any;
    });
    expect(proc.pid).toBe(2);
    expect(seen.map((o) => !!o.useConptyDll)).toEqual([true, false]);
  });

  test('elsewhere the option is not sent', () => {
    const seen: any[] = [];
    spawnPty('/bin/sh', [], options, 'linux', (_f, _a, o) => { seen.push(o); return {} as any; });
    expect(seen[0].useConptyDll).toBeUndefined();
  });

  test('the process tree ends by an absolute taskkill, and the terminal closes after it', () => {
    const calls: { file: string; args: string[] }[] = [];
    const order: string[] = [];
    endWindowsTree(4242, () => order.push('kill'), { SystemRoot: 'C:\\Windows' }, (file, args, done) => { calls.push({ file, args }); order.push('taskkill'); done(); });
    expect(calls).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/T', '/F', '/PID', '4242'] }]);
    expect(order).toEqual(['taskkill', 'kill']);
  });

  test('no process id yet, or a taskkill that cannot start: the terminal still closes', () => {
    let closed = 0;
    let started = 0;
    endWindowsTree(0, () => closed++, {}, () => { started++; });
    expect([closed, started]).toEqual([1, 0]);
    endWindowsTree(7, () => closed++, {}, () => { throw new Error('no taskkill'); });
    expect(closed).toBe(2);
  });
});

test.describe('W1: the guard for a fault in the main process', () => {
  const guard = () => {
    const proc = new EventEmitter();
    const logged: string[] = [];
    const shown: string[] = [];
    installFaultGuard(proc, { log: (t) => logged.push(t), show: (t) => shown.push(t) });
    return { proc, logged, shown };
  };

  test('a rejection is logged, and the person reads one plain message, once', () => {
    const { proc, logged, shown } = guard();
    proc.emit('unhandledRejection', new Error('first'));
    proc.emit('unhandledRejection', new Error('second'));
    proc.emit('uncaughtException', new Error('third'));
    expect(logged.join('\n')).toContain('first');
    expect(logged.join('\n')).toContain('second');
    expect(logged.join('\n')).toContain('third');
    expect(shown).toHaveLength(1);
    expect(shown[0]).not.toMatch(/first|Error|stack|at /);
  });

  test("node-pty's fork under the off fuse is logged and said to nobody", () => {
    const { proc, logged, shown } = guard();
    const refusal = new Error('child_process.fork() is not supported when the runAsNode fuse is disabled');
    expect(isForkRefusal(refusal)).toBe(true);
    expect(isForkRefusal(new Error('other'))).toBe(false);
    proc.emit('unhandledRejection', refusal);
    expect(shown).toEqual([]);
    expect(logged).toHaveLength(1);
  });

  test('a rejection with no Error, and a key in its text', () => {
    const { proc, logged, shown } = guard();
    proc.emit('unhandledRejection', 'plain text Bearer abc.def');
    proc.emit('unhandledRejection', undefined);
    expect(logged.join('\n')).not.toContain('abc.def');
    expect(shown).toHaveLength(1);
  });

  test('the log file keeps a limit', () => {
    const dir = tempDir('vibex-guard-');
    try {
      const file = path.join(dir, 'errors.log');
      const log = boundedLog(file, 1000);
      for (let i = 0; i < 40; i++) log('x'.repeat(100));
      expect(statSync(file).size).toBeLessThanOrEqual(1000);
      expect(existsSync(`${file}.old`)).toBe(true);
      // A folder that cannot be written must not raise a new fault from inside the guard.
      expect(() => boundedLog(path.join(dir, 'no', 'such', 'folder', 'e.log'))('text')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('main.ts puts the guard in before the first await, and not for the --mcp-headers run', () => {
    const main = read('src/main/main.ts');
    expect(main).toMatch(/if \(!headersMode\) installFaultGuard\(process,/);
    expect(main.indexOf('installFaultGuard(process,')).toBeLessThan(main.indexOf('app.whenReady().then(start)'));
  });
});

test.describe('W3, W4: the PATH of the registry, at each check and each new tab', () => {
  /// As `reg export` writes a REG_EXPAND_SZ: UTF-16 bytes in hex, broken over lines that end in a backslash.
  const asExport = (value: string) => {
    const pairs = [...Buffer.from(`${value}\0`, 'utf16le')].map((b) => b.toString(16).padStart(2, '0'));
    const lines: string[] = [];
    for (let i = 0; i < pairs.length; i += 20) lines.push(pairs.slice(i, i + 20).join(','));
    return `Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"TEMP"=hex(2):25,00\r\n"Path"=hex(2):${lines.join(',\\\r\n  ')}\r\n\r\n`;
  };

  test('an export gives the text of Path, also a Cyrillic one and over several lines', () => {
    const value = '%USERPROFILE%\\.local\\bin;C:\\Users\\Иван Петров\\AppData\\Local\\Programs\\Git\\cmd;C:\\Tools\\A long folder name\\bin';
    expect(parseRegExport(asExport(value))).toBe(value);
  });

  test('a plain string value, and an export with no Path', () => {
    expect(parseRegExport('[HKEY_LOCAL_MACHINE\\x]\r\n"Path"="C:\\\\Windows;C:\\\\Program Files\\\\Git\\\\cmd"\r\n')).toBe('C:\\Windows;C:\\Program Files\\Git\\cmd');
    expect(parseRegExport('[HKEY_CURRENT_USER\\Environment]\r\n"TEMP"="C:\\\\t"\r\n')).toBeNull();
    expect(parseRegExport('')).toBeNull();
  });

  test('%names% expand, in any letter case, and an unknown one stays', () => {
    expect(expandEnvText('%userprofile%\\bin;%NOPE%\\x', { USERPROFILE: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\bin;%NOPE%\\x');
  });

  test('machine, then user, then what the app has; no twins; nothing relative', () => {
    const merged = mergePath('C:\\Windows;c:\\git\\cmd;', 'C:\\Users\\a\\.local\\bin;%NOPE%\\x;.;bin', 'C:\\WINDOWS;C:\\Extra');
    expect(merged).toBe('C:\\Windows;c:\\git\\cmd;C:\\Users\\a\\.local\\bin;C:\\Extra');
  });

  test('Git, installed while the app runs, is found at the next check with no restart', () => {
    const env: Record<string, string | undefined> = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' };
    const hives: Record<string, string | null> = { machine: asExport('C:\\Windows'), user: null };
    const refresh = () => refreshWindowsPath({ platform: 'win32', env, read: (hive) => hives[hive] });
    const git = () => findProgram('git', { platform: 'win32', pathValue: env.PATH ?? '', isFile: (f) => f === 'C:\\Program Files\\Git\\cmd\\git.exe' });
    refresh();
    expect(git()).toBeNull();
    hives.machine = asExport('C:\\Windows;C:\\Program Files\\Git\\cmd');
    refresh();
    expect(git()).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  test('a user PATH that gained .local\\bin counts, %USERPROFILE% expanded', () => {
    const env: Record<string, string | undefined> = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Иван' };
    refreshWindowsPath({ platform: 'win32', env, read: (hive) => (hive === 'user' ? asExport('%USERPROFILE%\\.local\\bin') : asExport('C:\\Windows')) });
    expect(env.PATH).toBe('C:\\Windows;C:\\Users\\Иван\\.local\\bin');
  });

  test('a registry that cannot be read leaves the PATH as it is; off Windows nothing is read', () => {
    const env: Record<string, string | undefined> = { PATH: 'C:\\Windows' };
    refreshWindowsPath({ platform: 'win32', env, read: () => null });
    expect(env.PATH).toBe('C:\\Windows');
    let asked = 0;
    refreshWindowsPath({ platform: 'linux', env, read: () => { asked++; return null; } });
    expect(asked).toBe(0);
  });

  test('a new tab gets the new PATH', async () => {
    const win = process.platform === 'win32';
    const saved = process.env.PATH;
    // The refresh hook is what changes the PATH of the next tab. Windows separates folders with ";", and cmd prints %PATH%.
    const added = win ? 'C:\\just-installed;' : '/just-installed:';
    const terminals = new Terminals(() => { process.env.PATH = `${added}${saved}`; });
    try {
      const launch: Launch = win
        ? { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'echo P=%PATH% & ping -n 6 127.0.0.1 >nul'], kind: 'none', title: 't' }
        : { file: '/bin/sh', args: ['-c', 'echo "P=$PATH"; sleep 5'], kind: 'none', title: 't' };
      const tab = terminals.create(launch);
      await expect.poll(() => terminals.buffer(tab.id)).toContain(`P=${added}`);
    } finally {
      terminals.closeAll();
      process.env.PATH = saved;
    }
  });

  test('Setup reads the registry before each check and before it looks for Claude', () => {
    const tools = read('src/main/pcaTools.ts');
    expect(tools).toMatch(/'mod:setup:check', \(id\) => \{\s*refreshWindowsPath\(\);/);
    const main = read('src/main/main.ts');
    expect(main).toMatch(/'mod:setup:claude-found', async \(\) => \{\s*refreshWindowsPath\(\);/);
  });

  test('a Claude tab with no Claude says so in plain words, and starts one that came by npm', () => {
    const text = windowsClaudeCommand(null);
    expect(text).toContain('Get-Command claude');
    expect(text).toContain('Claude Code is not installed yet');
    expect(text).not.toContain('"');
    expect(windowsClaudeCommand('C:\\Users\\Иван Петров\\.local\\bin\\claude.exe')).toBe("& 'C:\\Users\\Иван Петров\\.local\\bin\\claude.exe'");
  });

  test('a real PowerShell runs that text with no red and no error', () => {
    test.skip(!pwsh, 'no pwsh on this computer');
    // By its full path: this PATH must hold no claude, and a computer with Claude Code has one on the usual PATH.
    const file = findProgram('pwsh', { platform: process.platform, pathValue: process.env.PATH ?? '', isFile: existsSync })!;
    const out = execFileSync(file, ['-NoLogo', '-NoProfile', '-Command', windowsClaudeCommand(null)], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1', PATH: '/nowhere' } });
    expect(out).toContain('Claude Code is not installed yet');
  });
});

test.describe('A4: terminal_run on Windows', () => {
  test('its script may start a .ps1, as the Run tab may', () => {
    const args = windowsCommandArgs('npm test', 'C:\\x', 'mark');
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-ExecutionPolicy', 'RemoteSigned']);
    expect(args[3]).toBe('-EncodedCommand');
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toContain('npm test');
  });
});

test.describe('N8, A5: the task of an agent', () => {
  const project = { id: 'p1', name: 'Hisobot', path: '/tmp/hisobot' } as any;

  test('PowerShell gets no task text at all: it goes by a file', () => {
    const pwshCommand = agentCommand("& 'claude.exe'", 'pwsh', TASK_POINTER);
    expect(pwshCommand).toBe("& 'claude.exe' --name $env:VIBEX_AGENT_NAME $env:VIBEX_AGENT_TASK");
    expect(pwshCommand).not.toContain('"');
    expect(pwshCommand).not.toContain('-replace');
    expect(agentCommand("& 'claude.exe'", 'pwsh', '')).toBe("& 'claude.exe' --name $env:VIBEX_AGENT_NAME");
    expect(TASK_POINTER).not.toMatch(/["'\\]/);
  });

  const repo = () => {
    const dir = realpathSync.native(tempDir('vibex-task-'));
    const main = path.join(dir, 'repo');
    mkdirSync(main);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(main, 'a.txt'), 'a\n');
    mkdirSync(path.join(main, 'sub'));
    writeFileSync(path.join(main, 'sub', 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    return { dir, main, agents: path.join(dir, 'agents'), git };
  };

  test('the task file holds the text exactly, stays out of git, and does not stop a removal', async () => {
    const { dir, main, agents } = repo();
    try {
      const task = 'Rename "a" to "b" in C++ \\ o‘zgarish $(calc) & more';
      const made = await createAgent(main, agents, 'quote test', task);
      await writeTaskFile(made.path, task);
      expect(readFileSync(path.join(made.path, '.vibex-task.txt'), 'utf8')).toBe(task);
      const listed = await listAgents(main, agents);
      expect(listed.agents[0].changes).toBe(0);
      expect(await removeAgent(main, agents, made.path)).toContain('Removed');
      expect(existsSync(made.path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second task file does not add the exclude line twice', async () => {
    const { dir, main, agents } = repo();
    try {
      const made = await createAgent(main, agents, 'one', 't');
      await writeTaskFile(made.path, 't');
      rmSync(path.join(made.path, '.vibex-task.txt'));
      await writeTaskFile(made.path, 'u');
      const exclude = readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude.split('\n').filter((l) => l === '/.vibex-task.txt')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real PowerShell in its old argument mode: raw quotes split (the bug), the pointer arrives whole', () => {
    test.skip(!pwsh, 'no pwsh on this computer');
    const dir = tempDir('vibex-ps-');
    try {
      const printer = path.join(dir, 'print.js');
      writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const node = process.execPath.replace(/'/g, "''");
      const command = `& '${node}' '${printer}'`;
      const run = (script: string, task: string) => JSON.parse(execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `$PSNativeCommandArgumentPassing = 'Legacy'; ${script}`], {
        encoding: 'utf8',
        env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1', VIBEX_AGENT_NAME: 'Hisobot - fix login', VIBEX_AGENT_TASK: task },
      }));
      // The witness: this harness shows the fault of Windows PowerShell 5.1, or the good result below proves nothing.
      expect(run(`${command} $env:VIBEX_AGENT_TASK`, 'Rename "a" to "b"')).not.toEqual(['Rename "a" to "b"']);
      expect(run(agentCommand(command, 'pwsh', TASK_POINTER), TASK_POINTER)).toEqual(['--name', 'Hisobot - fix login', TASK_POINTER]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Reopen Closed Tab starts the agent again with no task, in any shell', () => {
    const dir = tempDir('vibex-reopen-');
    try {
      const launch = agentLaunch(project, dir, 'fix', 'do the thing');
      expect(launch.env?.VIBEX_AGENT_TASK).toBeTruthy();
      expect(typeof launch.rebuild).toBe('function');
      const again = launch.rebuild!();
      expect(again.env?.VIBEX_AGENT_TASK).toBeFalsy();
      expect(again.args.join(' ')).not.toContain('VIBEX_AGENT_TASK');
      expect(again.cwd).toBe(dir);
      expect(typeof again.rebuild).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a removed agent does not come back', () => {
    const launch = agentLaunch(project, path.join(tempDir('vibex-gone-'), 'no-such-folder'), 'fix', 'do');
    expect(() => launch.rebuild!()).toThrow(/gone|no longer/);
    const terminals = new Terminals();
    try {
      expect(terminals.reopenClosed('p1')).toBeNull();
    } finally {
      terminals.closeAll();
    }
  });

  test('Open on an agent starts Claude with no task', () => {
    expect(read('src/main/agents.ts')).toMatch(/this\.openTab\(project, tree\.path, name, ''\)/);
  });
});

test.describe('B5: a folder that stays behind', () => {
  // A lock: on POSIX a read-only folder (chmod). On Windows a real one: a process stands in the folder, and Windows refuses
  // to delete it. Both give back an `unlock`.
  const win = process.platform === 'win32';
  const lock = (folder: string): (() => Promise<void>) => {
    if (win) return holdFolder(folder);
    chmodSync(folder, 0o555);
    return async () => chmodSync(folder, 0o755);
  };

  const repo = () => {
    const dir = realpathSync.native(tempDir('vibex-left-'));
    const main = path.join(dir, 'repo');
    mkdirSync(path.join(main, 'sub'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(main, 'sub', 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    return { dir, main, agents: path.join(dir, 'agents'), git };
  };

  test('git cannot delete all of it: the answer says what is true, and no press of Remove is asked for', async () => {
    const { dir, main, agents } = repo();
    let unlock: (() => Promise<void>) | null = null;
    try {
      const made = await createAgent(main, agents, 'held', '');
      // What a lock does to git on Windows: the delete fails part of the way, after which git has dropped its record.
      unlock = lock(path.join(made.path, 'sub'));
      const answer = await finishAgent(main, agents, made.path);
      expect(answer).toContain('Merged vibex/held');
      expect(answer).not.toContain('press Remove');
      expect(answer).toContain(made.path);
      expect(answer).toContain('vibex/held');
      expect((await listAgents(main, agents)).agents).toEqual([]);
    } finally {
      await unlock?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Remove on the same lock says the same, and throws no raw git text', async () => {
    const { dir, main, agents } = repo();
    let unlock: (() => Promise<void>) | null = null;
    try {
      const made = await createAgent(main, agents, 'held', '');
      unlock = lock(path.join(made.path, 'sub'));
      const answer = await removeAgent(main, agents, made.path);
      expect(answer).toContain(made.path);
      expect(answer).not.toContain('press Remove');
    } finally {
      await unlock?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lock that lets go soon: the folder goes, and the answer is a plain removal', async () => {
    const { dir, main, agents } = repo();
    let unlock: (() => Promise<void>) | null = null;
    let held = '';
    try {
      const made = await createAgent(main, agents, 'soon', '');
      held = path.join(made.path, 'sub');
      unlock = lock(held);
      const let_go = unlock;
      // On Windows the release is a taskkill and a wait, so it may take a little longer than a chmod. The app tries for 1.5 s.
      setTimeout(() => { void let_go(); }, 300);
      const answer = await removeAgent(main, agents, made.path);
      expect(existsSync(made.path)).toBe(false);
      expect(answer).toContain('Removed soon');
    } finally {
      // POSIX: the folder is gone, and a chmod on it would fail. Windows: release is safe at any time.
      if (unlock && (win || existsSync(held))) await unlock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('closing a tab waits for its process, and only up to the limit', async () => {
    const terminals = new Terminals();
    try {
      const quick = terminals.create({ ...sleeper(), kind: 'none', title: 'q' });
      expect(await terminals.closeAndWait(quick.id, 5000)).toBe(true);
      // Windows ends the whole tree with taskkill /F, so no program can ignore the close: there is no stubborn one to build.
      if (win) {
        test.info().annotations.push({ type: 'note', description: 'stubborn part not run on Windows: taskkill /F cannot be ignored' });
        return;
      }
      const stubborn = terminals.create({ file: '/bin/sh', args: ['-c', "trap '' HUP TERM; echo up; while :; do sleep 1; done"], kind: 'none', title: 's' });
      await expect.poll(() => terminals.buffer(stubborn.id)).toContain('up');
      const started = Date.now();
      expect(await terminals.closeAndWait(stubborn.id, 300)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      terminals.closeAll();
    }
  });

  test('the tabs of a folder are found by where they started, also one Reopen brought back', () => {
    const terminals = new Terminals();
    try {
      // A tab needs a folder that exists, so Windows uses two temp folders in place of /tmp and /.
      const one = win ? tempDir('vibex-tabs-a-') : '/tmp';
      const two = win ? tempDir('vibex-tabs-b-') : '/';
      const a = terminals.create({ ...sleeper(), kind: 'none', title: 'a', cwd: one });
      terminals.create({ ...sleeper(), kind: 'none', title: 'b', cwd: two });
      expect(terminals.tabsIn(one)).toEqual([a.id]);
      expect(terminals.tabsIn(path.join(one, 'x'), () => false)).toEqual([]);
    } finally {
      terminals.closeAll();
    }
  });
});

test.describe('A8: a saved passphrase with ~/ on Windows', () => {
  const profile = { name: 's', host: 'h', user: 'u', authentication: 'key', identityFile: '~/.ssh/id' } as unknown as ServerProfile;

  test('the prompt of Windows ssh names the same key with its own slashes', () => {
    const home = 'C:\\Users\\a';
    expect(keyNameMatches('C:\\Users\\a/.ssh/id', '~/.ssh/id', 'win32', home)).toBe(true);
    expect(keyNameMatches('c:\\users\\a\\.ssh\\id', '~/.ssh/id', 'win32', home)).toBe(true);
    expect(keyNameMatches('C:\\Users\\b/.ssh/id', '~/.ssh/id', 'win32', home)).toBe(false);
    expect(keyNameMatches('C:\\Users\\a/.ssh/other', '~/.ssh/id', 'win32', home)).toBe(false);
  });

  test('elsewhere a backslash is a letter of the name', () => {
    expect(keyNameMatches('/home/a/x\\y', '/home/a/x/y', 'linux', '/home/a')).toBe(false);
    expect(keyNameMatches('/home/a/.ssh/id', '~/.ssh/id', 'linux', '/home/a')).toBe(true);
  });

  test('a long Cyrillic path cut at 100 bytes in the middle of a letter still matches', () => {
    const home = 'C:\\Users\\Иван1';
    const file = `${home}\\${'папка'.repeat(12)}\\id`;
    const cut = Buffer.from(file).subarray(0, 100).toString();
    expect(cut.endsWith('\ufffd')).toBe(true);
    expect(keyNameMatches(cut, file, 'win32', home)).toBe(true);
    expect(keyNameMatches(cut.replace(/\ufffd+$/, ''), file, 'win32', home)).toBe(true);
  });

  test('classify reads through the same check', () => {
    const answer = classify({ prompt: `Enter passphrase for key '${path.join(process.env.HOME ?? '', '.ssh/id')}': `, hint: '' } as any, profile, { user: 'u', hosts: ['h'], keys: ['~/.ssh/id'] } as any);
    expect(answer.kind).toBe('secret');
  });
});

test.describe('B2: a lone CR', () => {
  test('counts as a line end, as a textarea reads it', () => {
    expect(lf('a\rb\r\nc\nd')).toBe('a\nb\nc\nd');
  });
  test('notes.ts compares through it', () => {
    expect(read('src/renderer/notes.ts')).toMatch(/import \{[^}]*\blf\b[^}]*\} from '\.\/notesMarkdown'/);
  });
});

test.describe('A2: Check for Updates can be reached', () => {
  test('the menu bar has Help, which the updater fills', () => {
    expect(read('src/main/main.ts')).toContain("{ label: '&Help', submenu: moduleMenu('Help', command) }");
    expect(read('src/main/updater.ts')).toContain("menu: 'Help'");
  });
});

test.describe('W5, A3: the workflow that makes the installers', () => {
  const yml = readFileSync(path.join(root, '..', '.github/workflows/vibex-pca.yml'), 'utf8');
  const jobs = yml.slice(yml.indexOf('\njobs:'));
  const job = (name: string) => {
    const start = jobs.indexOf(`\n  ${name}:`);
    expect(start, name).toBeGreaterThan(-1);
    const next = jobs.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
  };

  test('the installer job comes first, and no test sits in it', () => {
    const build = job('installers');
    expect(build).not.toMatch(/\n\s+needs:/);
    expect(build).not.toMatch(/playwright|npm test|typecheck/);
    expect(build).toMatch(/electron-builder --win nsis --x64 --publish never/);
    expect(build).toMatch(/electron-builder --linux AppImage deb --x64 --publish never/);
    expect(build).toMatch(/windows-latest/);
    expect(build).toMatch(/ubuntu-24\.04/);
  });

  test('the cache of the run holds what the publish script reads, and an empty one is a failure', () => {
    const build = job('installers');
    for (const file of ['*.exe', '*.deb', '*.AppImage', '*.blockmap', 'latest.yml', 'latest-linux.yml', 'appimage-gate/']) expect(build, file).toContain(`electron/release/${file}`);
    expect(build).toMatch(/actions\/cache\/save@v4/);
    expect(build).not.toMatch(/upload-artifact/);
    expect(build.indexOf('name: Check the installers are there')).toBeLessThan(build.indexOf('actions/cache/save'));
    expect(read('scripts/publish-update.sh')).toContain('latest.yml');
  });

  test('the test job needs the installers and cannot take them back', () => {
    const tests = job('tests');
    expect(tests).toMatch(/needs: installers/);
    expect(tests).toMatch(/actions\/cache\/restore@v4/);
    expect(tests).not.toMatch(/actions\/cache\/save|download-artifact/);
    expect(tests).not.toMatch(/upload-artifact[\s\S]*name: vibex-pca-installers/);
  });

  test('nothing goes to the update feed, and only the release job of a tag writes to GitHub', () => {
    const code = yml.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/--publish always|publish-update|scp /);
    const others = ['installers', 'tests'].map(job).join('\n').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(others).not.toMatch(/contents: write|gh release/);
    expect(job('release-assets')).toMatch(/contents: write/);
    expect(yml.match(/--publish never/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test('each job has a limit that fits it', () => {
    expect(Number(/timeout-minutes: (\d+)/.exec(job('installers'))?.[1])).toBeLessThanOrEqual(25);
    expect(Number(/timeout-minutes: (\d+)/.exec(job('tests'))?.[1])).toBeGreaterThanOrEqual(60);
  });
});

test.describe('the Windows installer of the fence', () => {
  const yml = readFileSync(path.join(root, '..', '.github/workflows/vibex-pca-fence.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  windows-installer:'));
  const script = read('scripts/fence-windows-installer.sh');
  const check = require('../scripts/check-windows-installer.cjs');

  test('a red test does not stop it, and it keeps its artifact when it fails', () => {
    expect(job).not.toMatch(/\n\s+needs:/);
    expect(job).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact/);
    expect(job).toContain('include-hidden-files: true');
  });

  test('nothing from it can reach the update feed', () => {
    const code = (job + script).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).toMatch(/electron-builder --win nsis --x64 --publish never/);
    expect(code).not.toMatch(/--publish always|publish-update|scp |contents: write|gh release/);
    expect(script).not.toMatch(/cp [^\n]*(latest|blockmap)/);
  });

  test('the Linux tools stay: plain npm ci, then the win32 pty package at the version of the lock', () => {
    const code = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/--os=win32/);
    expect(code).toMatch(/^npm ci /m);
    const lock = JSON.parse(read('package-lock.json')).packages['node_modules/@lydell/node-pty-win32-x64'].version;
    expect(code).toContain(`npm i --no-save --force @lydell/node-pty-win32-x64@${lock}`);
  });

  test('the check looks for what the win32 package holds', () => {
    const code = read('scripts/check-windows-installer.cjs');
    for (const file of ['conpty.dll', 'conpty.node', 'OpenConsole.exe']) expect(code, file).toContain(file);
    expect(code).not.toContain("'pty.node'");
  });

  test('the check asks for each fuse of electron-builder.yml', () => {
    const yml2 = read('electron-builder.yml');
    for (const [key, fuse] of [['runAsNode', 'RunAsNode'], ['enableNodeCliInspectArguments', 'EnableNodeCliInspectArguments'], ['enableNodeOptionsEnvironmentVariable', 'EnableNodeOptionsEnvironmentVariable'], ['onlyLoadAppFromAsar', 'OnlyLoadAppFromAsar'], ['enableEmbeddedAsarIntegrityValidation', 'EnableEmbeddedAsarIntegrityValidation'], ['grantFileProtocolExtraPrivileges', 'GrantFileProtocolExtraPrivileges']]) {
      expect(check.FUSES[fuse]).toBe(new RegExp(`\\n\\s+${key}: true`).test(yml2) ? 'Enabled' : 'Disabled');
    }
  });

  test('the check finds the integrity list in made-up bytes, and says when there is none', () => {
    const list = [{ file: 'resources\\app.asar', alg: 'SHA256', value: 'ab'.repeat(32) }];
    const bytes = Buffer.concat([Buffer.alloc(40, 0x90), Buffer.from(JSON.stringify(list)), Buffer.alloc(40)]);
    expect(check.findIntegrity(bytes)).toEqual(list);
    expect(check.findIntegrity(Buffer.alloc(200, 0x90))).toBeNull();
  });

  test('the check reads a PE header: x64 passes, anything else does not', () => {
    const pe = (machine: number) => {
      const b = Buffer.alloc(0x100);
      b.write('MZ');
      b.writeUInt32LE(0x80, 0x3c);
      b.write('PE\0\0', 0x80, 'latin1');
      b.writeUInt16LE(machine, 0x84);
      return b;
    };
    expect(check.isWindowsX64(pe(0x8664))).toBe(true);
    expect(check.isWindowsX64(pe(0xaa64))).toBe(false);
    expect(check.isWindowsX64(Buffer.from('#!/bin/sh\n'))).toBe(false);
    // The NSIS stub of an x64 installer is a 32-bit program, and still a Windows one.
    expect(check.peMachine(pe(0x14c))).toBe(0x14c);
    expect(check.peMachine(Buffer.from('#!/bin/sh\n'))).toBeNull();
  });
});

test.describe('W2, W3: the guide is the app', () => {
  const guide = read('INSTALL-WINDOWS.md');

  test('it has Smart App Control, the folder step and the round arrow; it never says type claude', () => {
    for (const word of ['Smart App Control', 'SmartScreen', 'Choose a folder', 'round arrow', 'new Claude tab']) expect(guide, word).toContain(word);
    expect(guide).not.toContain('type `claude`');
    expect(guide).not.toContain('Click "Check again"');
  });

  // git-scm.com resets TLS on the owner's office network (measured: curl 35); github.com answers there.
  test('the Git link on Windows does not use git-scm.com', () => {
    const page = 'https://github.com/git-for-windows/git/releases/latest';
    expect(read('INSTALL-WINDOWS.md')).toContain(page);
    expect(read('INSTALL-WINDOWS.md')).not.toContain('git-scm.com');
    expect(read('src/main/setup.ts')).toContain(`process.platform === 'win32' ? '${page}'`);
    expect(read('src/main/git.ts')).toContain(`Install Git for Windows from ${page}.`);
    expect(read('src/main/git.ts')).not.toContain('git-scm.com');
  });

  test('it says that Vibex asks in a box, and that an old ssh asks in the tab', () => {
    expect(read('INSTALL-WINDOWS.md')).toMatch(/box that Vibex shows/);
    expect(read('INSTALL-WINDOWS.md')).toMatch(/older than 8\.4.*ssh asks in the tab/s);
    expect(read('INSTALL-WINDOWS.md')).toContain('vibex-askpass.exe');
  });

  test('Setup tells a person to restart only as the last way', () => {
    const setup = read('src/main/setup.ts');
    expect(setup).toContain('round arrow');
    expect(setup).toMatch(/still shows Not found, close Vibex PCA/);
  });

  test('the first-run check: each step one action, under 20 words', () => {
    const page = read('WINDOWS-FIRST-RUN.md');
    const steps = page.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(steps.length).toBeGreaterThan(15);
    for (const step of steps) expect(step.replace(/^\d+\. /, '').split(/\s+/).length, step).toBeLessThan(20);
    for (const word of ['125', '150', 'Smart App Control', 'terminal_run', 'Cyrillic', 'Send back']) expect(page, word).toContain(word);
  });

  test('the README has the vault, the tests and updates as they are', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('~/Desktop/Projects/obsidian');
    expect(readme).not.toContain('The tests run on macOS');
    expect(readme).toContain('~/Documents');
    expect(readme).toContain('Check for Updates');
    expect(readme).toContain('VIBEX_INSTALL_COMMAND');
  });
});
