import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stage, unstage } from '../src/main/git';
import { startMcp, type McpDeps } from '../src/main/mcp';
import { Projects, type ProjectInfo } from '../src/main/projects';
import { linkRanges } from '../src/renderer/terminalExtras';
import { runLaunch, skippedNames, stripOutput, type ServerProfile } from '../src/main/servers';
import { commandLaunch, forgetLoginPath, loginPathReady, psQuote, Terminals, windowsCommandScript, windowsShellFile, type Launch } from '../src/main/terminals';
import { sleeper, tempDir } from './fixtures';

// terminal_run, its tabs and what its neighbours share, with real PTYs and no window: the review of 2026-10-31.
// Each test has its own HOME, so no real setup file of this computer is read.

const posix = process.platform !== 'win32';
const shells = (['/bin/bash', '/bin/zsh', '/bin/sh'] as const).filter(existsSync);

const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR, PATH: process.env.PATH };
let home: string;
let terminals: Terminals;

function useShell(file: string): void {
  process.env.SHELL = file;
  forgetLoginPath();
}

test.beforeEach(() => {
  terminals = new Terminals();
  home = realpathSync.native(tempDir('vibex-termunit-'));
  process.env.HOME = home;
  process.env.ZDOTDIR = home;
  forgetLoginPath();
});

test.afterEach(() => {
  terminals.closeAll();
  Object.assign(process.env, saved);
  if (saved.ZDOTDIR === undefined) delete process.env.ZDOTDIR;
  forgetLoginPath();
  rmSync(home, { recursive: true, force: true });
});

const sh = (title: string, extra: Partial<Launch> = {}): Launch => ({ ...sleeper(), kind: 'none', title, project: 'p', ...extra });
const run = (command: string, cwd?: string, wait = 20_000) => terminals.runCommand({ ...commandLaunch(command, cwd), project: 'p' }, wait);
const profile: ServerProfile = { name: 'test', host: '127.0.0.1', user: 'pca' } as ServerProfile;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.describe('item 4: a server command runs once', () => {
  test('a run on a server is off the Reopen list, with no help from its caller', () => {
    const launch = runLaunch(profile, undefined, '/srv/app', undefined, 'echo hello');
    expect(launch.once).toBe(true);
    const tab = terminals.create({ ...launch, ...sleeper(), project: 'p' });
    terminals.close(tab.id);
    expect(terminals.reopenClosed('p')).toBeNull();
  });
});

test.describe('item 6: terminal_tabs and a server token', () => {
  // Only the first test runs on Windows: the others run POSIX commands (sh, yes, head) through the local run.
  test.beforeEach(({}, info) => { test.skip(!posix && !info.title.startsWith('a local command stays out'), 'the local run here uses /bin/sh, yes and head'); });
  const project: ProjectInfo = { id: 'p', name: 'ledger', path: '/srv/ledger', server: 'test' } as ProjectInfo;
  async function serve() {
    const deps: McpDeps = {
      route: () => project,
      browser: () => { throw new Error('no browser here'); },
      terminals,
      reveal: () => {},
      serverProject: (token) => (token === 'server-token' ? project : null),
      guardForServer: () => {},
      confirmRun: async () => null,
      runOnServer: async () => ({ output: `${'x'.repeat(30_000)}END`, code: 0, timedOut: false, run: 1 }),
      listProjects: () => [project],
      recentProjects: () => [],
      openProject: () => project,
      version: '0',
      modules: [],
    };
    const mcp = await startMcp(deps, 'full-token', 0);
    const client = async (token: string) => {
      const c = new Client({ name: 'unit', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return c;
    };
    return { mcp, client };
  }
  const textOf = (r: unknown) => ((r as { content: { text?: string }[] }).content[0]?.text ?? '');

  test('a local command stays out of the list; the server tabs of this project stay in it', async () => {
    const { mcp, client } = await serve();
    terminals.create(sh('$ curl secret-local-word', { title: commandLaunch('curl secret-local-word').title }));
    terminals.create(sh('plain local shell'));
    terminals.create(sh('other server', { server: 'another-server' }));
    terminals.create(sh('own login', { server: 'test' }));
    terminals.create({ ...runLaunch(profile, undefined, '/srv', undefined, 'echo x'), ...sleeper(), project: 'p' });
    const server = await client('server-token');
    const seen = textOf(await server.callTool({ name: 'terminal_tabs', arguments: {} }));
    expect(seen).toContain('own login');
    expect(seen).toContain('Run on test');
    expect(seen).not.toContain('secret-local-word');
    expect(seen).not.toContain('plain local shell');
    expect(seen).not.toContain('another-server');
    expect(seen).not.toContain('other server');
    await server.close();
    // The person's own Claude keeps the whole list.
    const full = await client('full-token');
    expect(textOf(await full.callTool({ name: 'terminal_tabs', arguments: {} }))).toContain('secret-local-word');
    await full.close();
    mcp.close();
  });

  test('a big output says what it holds: a tail with the right total, and when the start is gone for good', async () => {
    useShell('/bin/sh');
    const { mcp, client } = await serve();
    const c = await client('full-token');
    const onServer = textOf(await c.callTool({ name: 'terminal_run', arguments: { command: 'x' } }));
    expect(onServer.length).toBeLessThan(8300);
    expect(onServer).toMatch(/^\[last 8000 of 30003 characters/);
    expect(onServer).toContain('END\n[exit code 0]');
    const local = textOf(await c.callTool({ name: 'terminal_run', arguments: { command: 'yes abcd | head -c 700000', local: true, wait: 30 } }));
    expect(local).toMatch(/^\[only the end of the output is kept/);
    await c.close();
    mcp.close();
  });
});

test.describe('item 1: a signal is not a success', () => {
  test.skip(!posix, 'POSIX signals');
  for (const shell of shells) {
    test(`a command that kills its own shell, under ${shell}, reports 128 + the signal`, async () => {
      useShell(shell);
      expect((await run('kill -9 $$')).code).toBe(137);
    });
  }
  test('a plain tab told by a signal gets 128 + the signal', async () => {
    const seen: number[] = [];
    terminals.create(sh('x', { args: ['-c', 'kill -15 $$'], onExit: (_i, code) => seen.push(code) }));
    await expect.poll(() => seen).toEqual([143]);
  });
});

test.describe('item 2: a background command is not lost, and its result is the truth', () => {
  test.skip(!posix, 'POSIX shells');
  for (const shell of shells) {
    test(`under ${shell}: nohup and & keep running until they finish, 6 of 6`, async () => {
      useShell(shell);
      const results = await Promise.all([0, 1, 2, 3, 4, 5].map(async (i) => {
        const file = path.join(home, `done-${i}`);
        const { code, timedOut } = await run(`nohup sh -c 'sleep 1; touch "${file}"' >/dev/null 2>&1 &`);
        return { code, timedOut, made: existsSync(file) };
      }));
      expect(results).toEqual(Array(6).fill({ code: 0, timedOut: false, made: true }));
    });

    test(`under ${shell}: the exit code stays the command's, also through exit`, async () => {
      useShell(shell);
      expect((await run('(sleep 1) & false')).code).toBe(1);
      expect((await run('(sleep 1) & exit 3')).code).toBe(3);
      expect((await run('echo fine')).code).toBe(0);
    });
  }

  test('a run with a job past the wait says it still runs, and then finishes', async () => {
    useShell('/bin/sh');
    const result = await run(`(sleep 2; echo late) & echo now`, undefined, 500);
    expect(result.timedOut).toBe(true);
    await expect.poll(() => terminals.runInfo(result.run)!.state.finished, { timeout: 10_000 }).toBe(true);
    expect(terminals.runInfo(result.run)!.state.output).toContain('late');
  });
});

test.describe('item 3: a tool on a PATH set only in the rc file is found', () => {
  test.skip(!posix, 'POSIX setup files');
  const tool = () => {
    const bin = path.join(home, 'rc-bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'rc-only-tool'), '#!/bin/sh\necho rc-tool-ran\n');
    chmodSync(path.join(bin, 'rc-only-tool'), 0o755);
    return bin;
  };
  const line = (bin: string) => `export PATH="${bin}:$PATH"\n`;

  test('zsh: .zshrc', async () => {
    test.skip(!existsSync('/bin/zsh'), 'no zsh here');
    writeFileSync(path.join(home, '.zshrc'), line(tool()));
    useShell('/bin/zsh');
    await loginPathReady();
    const { output, code } = await run('rc-only-tool');
    expect(output).toBe('rc-tool-ran');
    expect(code).toBe(0);
  });

  test('bash: .bashrc with the usual guard for a shell that is not interactive, and no .profile', async () => {
    writeFileSync(path.join(home, '.bashrc'), `case $- in *i*) ;; *) return ;; esac\n${line(tool())}`);
    useShell('/bin/bash');
    await loginPathReady();
    const { output, code } = await run('rc-only-tool');
    expect(output).toBe('rc-tool-ran');
    expect(code).toBe(0);
  });

  test('both together: the rc tool and a background job that must finish', async () => {
    writeFileSync(path.join(home, '.bashrc'), line(tool()));
    useShell('/bin/bash');
    await loginPathReady();
    const file = path.join(home, 'bg');
    const { output, code } = await run(`rc-only-tool; nohup sh -c 'sleep 1; touch "${file}"' >/dev/null 2>&1 &`);
    expect(output).toBe('rc-tool-ran');
    expect(code).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  test('an rc file that hangs does not hold the run: the wait ends, and the command runs', async () => {
    writeFileSync(path.join(home, '.bashrc'), 'sleep 60\n');
    useShell('/bin/bash');
    const started = Date.now();
    await loginPathReady(500);
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await run('echo still-runs')).output).toBe('still-runs');
  });

  test('an rc file that reads the keyboard gets no keyboard', async () => {
    writeFileSync(path.join(home, '.bashrc'), `read answer\n${line(tool())}`);
    useShell('/bin/bash');
    await loginPathReady();
    expect((await run('rc-only-tool')).output).toBe('rc-tool-ran');
  });
});

test.describe('item 5: closing a running Run tab asks', () => {
  test('an alive command tab is busy from the start, and a finished one is not', async () => {
    const running = terminals.create(sh('Run', { once: true }));
    expect(terminals.busy(running.id)).toBe(true);
    const short = terminals.create(sh('Run', { once: true, args: posix ? ['-c', 'exit 0'] : ['/c', 'exit 0'] }));
    await expect.poll(() => terminals.busy(short.id)).toBe(false);
  });
});

test.describe('item 7: the Windows script (text only: no PowerShell ran here)', () => {
  test('an Uzbek typographic quote does not end the word', () => {
    expect(psQuote('o‘zgarish')).toBe("'o‘‘zgarish'");
    expect(psQuote("o'g'il ’ ‚ ‛")).toBe("'o''g''il ’’ ‚‚ ‛‛'");
    expect(windowsCommandScript('Write-Output hi', 'C:\\o‘quv', 'MARK')).toContain("-LiteralPath 'C:\\o‘‘quv'");
    expect(windowsCommandScript('echo o‘zgarish', undefined, 'MARK')).toContain("'echo o‘‘zgarish'");
  });

  test('a failed cmdlet is not a success, and a code from an earlier program does not leak', () => {
    const lines = windowsCommandScript('Get-Item nope', undefined, 'MARK').split('\n');
    const at = lines.indexOf('Get-Item nope');
    expect(lines.slice(0, at)).toContain('$global:LASTEXITCODE = $null');
    // $? must be read right after the command, before any other statement changes it.
    expect(lines[at + 1]).toBe('$vibexCode = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }');
    // No `exit` after the command: a table in PowerShell's formatter would be lost.
    expect(lines.slice(at + 2).join('\n')).toBe('$host.SetShouldExit($vibexCode)');
  });
});

test.describe('a bare program name on Windows (security H3)', () => {
  const none = () => false;
  const only = (want: string) => (file: string) => file === want;
  const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'D:\\Win', PATH: '.;C:\\tools;relative\\bin' };
  test('with nothing found, Windows PowerShell by its full path, never a bare name', () => {
    expect(windowsShellFile(env, none)).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsShellFile({}, none)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
  test('PowerShell 7 first, then an absolute PATH folder; a relative one is not read', () => {
    expect(windowsShellFile(env, only('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(windowsShellFile(env, only('C:\\tools\\pwsh.exe'))).toBe('C:\\tools\\pwsh.exe');
    expect(windowsShellFile(env, only('relative\\bin\\pwsh.exe'))).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsShellFile(env, only('.\\pwsh.exe'))).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

test.describe('the smaller review items', () => {
  // Two tests run on Windows too, through PowerShell. The rest use POSIX shells, signals or POSIX tools.
  test.beforeEach(({}, info) => { test.skip(!posix && !/^(non-blocking 11|a finished run still reads)/.test(info.title), 'POSIX shells'); });

  test('non-blocking 1: a process that ignores HUP does not outlive its closed tab', async () => {
    useShell('/bin/sh');
    const file = path.join(home, 'pid');
    const started = run(`trap '' HUP; echo $$ > "${file}"; while :; do sleep 1; done`, undefined, 500);
    await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '', { timeout: 10_000 }).toBe(true);
    const pid = Number(readFileSync(file, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    await started;
    terminals.close(terminals.list().at(-1)!.id);
    await expect.poll(() => alive(pid), { timeout: 8000 }).toBe(false);
  });

  for (const csh of ['/bin/csh', '/bin/tcsh'].filter(existsSync)) {
    test(`non-blocking 2: ${csh} as the login shell: the script runs in sh, and the command runs`, async () => {
      useShell(csh);
      const { output, code } = await run('echo from-csh-user; if [ 1 = 1 ]; then echo posix; fi');
      expect(output).toBe('from-csh-user\nposix');
      expect(code).toBe(0);
    });
  }
  test('non-blocking 2: fish as the login shell gets the script in sh too', () => {
    process.env.SHELL = '/bin/ls'; // any real file whose name is no POSIX shell
    const launch = commandLaunch('echo hi');
    expect(launch.file).toBe('/bin/sh');
  });

  test('non-blocking 4: trailing space does not stall the main process', async () => {
    const spaces = ' '.repeat(200_000);
    const started = Date.now();
    expect(stripOutput(`a${spaces}b${spaces}`)).toBe(`a${spaces}b`);
    expect(Date.now() - started).toBeLessThan(1000);
    useShell('/bin/sh');
    const first = Date.now();
    const { output } = await run("printf 'x%200000sy%200000s' '' ''");
    expect(output.endsWith('y')).toBe(true);
    expect(Date.now() - first).toBeLessThan(5000);
  });

  test('non-blocking 6: a command that holds the start text keeps its output clean', async () => {
    useShell('/bin/sh');
    const { output } = await run("echo ']7777;vbx-start'; echo after");
    expect(output).toBe(']7777;vbx-start\nafter');
  });

  test('non-blocking 7: other escape sequences do not survive', async () => {
    useShell('/bin/sh');
    const { output } = await run("printf 'a\\033(Bb\\033=c\\033>d\\0337e\\0338f\\033cg\\n'");
    expect(output).toBe('abcdefg');
  });

  test('non-blocking 8: a failed cd and a parse error do not carry the login banner', async () => {
    writeFileSync(path.join(home, '.zprofile'), 'echo LOGIN-BANNER\n');
    writeFileSync(path.join(home, '.bash_profile'), 'echo LOGIN-BANNER\n');
    for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
      useShell(shell);
      const cd = await run('pwd', path.join(home, 'nope'));
      expect(cd.code).toBe(1);
      expect(cd.output).not.toContain('LOGIN-BANNER');
      expect(cd.output).toContain('nope');
      const parse = await run('if then');
      expect(parse.code).not.toBe(0);
      expect(parse.output).not.toContain('LOGIN-BANNER');
    }
  });

  test('non-blocking 10: the script holds the text once, so a big command runs; a too big one is refused in plain words', async () => {
    useShell('/bin/sh');
    const big = `echo ${'a'.repeat(100_000)}`;
    const script = commandLaunch(big).args.join(' ');
    expect(script.length).toBeLessThan(101_000);
    const { output, code } = await run(big);
    expect(code).toBe(0);
    // A finished run keeps its last 60,000 characters; the command itself got there whole.
    expect(output).toBe('a'.repeat(60_000));
    expect(() => commandLaunch(`echo ${'a'.repeat(200_000)}`)).toThrow(/characters.*file/);
  });

  test('non-blocking 11: closing a project forgets its command tabs', async () => {
    if (posix) useShell('/bin/sh');
    await run('echo one');
    terminals.closeProject('p');
    expect((terminals as unknown as { commandTabs: Map<string, number[]> }).commandTabs.has('p')).toBe(false);
  });

  test('a finished run still reads after its tab is gone', async () => {
    if (posix) useShell('/bin/sh');
    const { run: number } = await run('echo kept');
    await run('echo next');
    expect(terminals.runInfo(number)!.state).toMatchObject({ output: 'kept', finished: true, code: 0 });
  });
});

test.describe('C N19: Stage all with more paths than one command line holds', () => {
  test('the paths go by stdin, for add and for restore', async () => {
    const repo = realpathSync.native(tempDir('vibex-manypaths-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64_000_000 });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    writeFileSync(path.join(repo, 'first'), 'x');
    git('add', '.');
    git('commit', '--quiet', '-m', 'first');
    // Windows: a line ends at 32,767 characters, and git refuses a path over 260. POSIX: a line holds about 1 MB.
    const win = process.platform === 'win32';
    const names = Array.from({ length: win ? 1000 : 7000 }, (_, i) => `${'long-file-name-'.repeat(win ? 3 : 15)}${i}`);
    for (const name of names) writeFileSync(path.join(repo, name), '');
    await stage(repo, names);
    expect(git('diff', '--cached', '--name-only').trim().split('\n').length).toBe(names.length);
    await unstage(repo, names);
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
    rmSync(repo, { recursive: true, force: true });
  });
});

test.describe('C N20: no Ctrl+Alt shortcut on Windows and Linux', () => {
  test('AltGr reads as Ctrl+Alt on Windows, and GNOME keeps Ctrl+Alt+T', () => {
    const sources = ['main.ts', 'pcaTools.ts'].map((f) => readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8')).join('\n');
    expect(sources.match(/accelerator: (?:isMac \? '[^']*' : )?'(?:CmdOrCtrl|Ctrl)\+Alt\+[^']*'/g) ?? []).toEqual([]);
  });
});

test.describe('the UX list, the parts with no window', () => {
  test('a web address in terminal text: no trailing punctuation, brackets only when they belong', () => {
    const urls = (t: string) => linkRanges(t).map((r) => r.url);
    expect(urls('see http://a.b/c.')).toEqual(['http://a.b/c']);
    expect(urls('(see https://a.b/c)')).toEqual(['https://a.b/c']);
    expect(urls('https://a.b/(c) and http://d.e/f,')).toEqual(['https://a.b/(c)', 'http://d.e/f']);
    expect(urls('file:///etc/passwd javascript:alert(1) ftp://a.b')).toEqual([]);
    expect(linkRanges('x http://a.b y')[0]).toMatchObject({ start: 2, end: 12 });
  });

  test('a skipped server entry is named, and nothing else of it', () => {
    const list = [{ name: 'good', host: 'a.b', user: 'u' }, { name: 'broken', host: '-oProxyCommand=calc', user: 'u' }, { host: 'x' }, null, { name: 'bad\nname', host: '-x', user: 'u' }];
    expect(skippedNames(list)).toEqual(['broken', 'entry 3', 'entry 4', 'badname']);
  });

  test('a recent folder that a person clicked and that has gone stays gone, also when the folder comes back', () => {
    const file = path.join(home, 'projects.json');
    const folder = path.join(home, 'gone-one');
    mkdirSync(folder);
    writeFileSync(file, JSON.stringify({ open: [], recents: [realpathSync.native(folder)] }));
    const projects = new Projects(file);
    expect(projects.recents().length).toBe(1);
    rmSync(folder, { recursive: true });
    expect(() => projects.open(path.join(realpathSync.native(home), 'gone-one'))).toThrow(/not a folder/);
    mkdirSync(folder);
    expect(projects.recents()).toEqual([]);
    expect(new Projects(file).recents()).toEqual([]);
  });
});
