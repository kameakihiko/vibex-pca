import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAllowedUrl, normalizeUrl } from '../src/main/browser';
import { monogram, Projects, projectId, tintIndex } from '../src/main/projects';
import { matchesAccelerator } from '../src/main/keys';
import { checkServerFolder, isValid, keyFilePath, LIST_FOLDERS, remoteFolder, serverLaunch, serverScript, sshLaunch, toolsScript, viaSh } from '../src/main/servers';
import { keyNameMatches } from '../src/main/askpass';
import { inProject, stripAnsi } from '../src/main/terminals';
import { posixSh } from './fixtures';

// Pure functions, no app window: these run in seconds on every OS, before the slow window checks.

test.describe('normalizeUrl: what the address bar does with typed text', () => {
  const cases: [string, string][] = [
    ['example.com', 'https://example.com'],
    ['  example.com/a?b=1  ', 'https://example.com/a?b=1'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['http://intranet.local', 'http://intranet.local'],
    ['about:blank', 'about:blank'],
    ['file:///C:/Users/a/report.html', 'file:///C:/Users/a/report.html'],
    ['cash flow report', 'https://www.google.com/search?q=cash%20flow%20report'],
    ['oylik hisobot', 'https://www.google.com/search?q=oylik%20hisobot'],
  ];
  for (const [typed, url] of cases) {
    test(JSON.stringify(typed), () => expect(normalizeUrl(typed)).toBe(url));
  }
});

test.describe('isAllowedUrl: only web addresses open in the side browser', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:3000/', 'about:blank']) {
    test(`allowed: ${url}`, () => expect(isAllowedUrl(url)).toBe(true));
  }
  for (const url of ['file:///C:/Windows/win.ini', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)', 'vscode://x']) {
    test(`refused: ${url}`, () => expect(isAllowedUrl(url)).toBe(false));
  }
});

test.describe('stripAnsi: terminal output as plain text', () => {
  test('colours and cursor moves are removed', () => {
    expect(stripAnsi('\x1b[32mPASS\x1b[0m done\x1b[2K\x1b[1G')).toBe('PASS done');
  });
  test('window titles (OSC) are removed, with either terminator', () => {
    expect(stripAnsi('\x1b]0;PowerShell\x07PS> \x1b]2;t\x1b\\ok')).toBe('PS> ok');
  });
  test('carriage returns from ConPTY are dropped', () => {
    expect(stripAnsi('line one\r\nline two\r\n')).toBe('line one\nline two\n');
  });
  test('plain text and Uzbek letters are kept', () => {
    expect(stripAnsi("O'zbekiston — oʻquv")).toBe("O'zbekiston — oʻquv");
  });
});

test.describe('sshLaunch: the ssh command a server profile gives', () => {
  test('a Windows key path with spaces stays one argument, and the target comes after --', () => {
    const launch = sshLaunch({
      name: 'PCA',
      host: 'pca.example',
      user: 'person-a',
      port: 2222,
      identityFile: 'C:\\Users\\Ali Valiyev\\.ssh\\id_ed25519',
      options: { UserKnownHostsFile: 'C:\\Users\\Ali Valiyev\\.ssh\\known_hosts' },
    });
    expect(launch.args).toEqual([
      '-p', '2222',
      '-i', 'C:\\Users\\Ali Valiyev\\.ssh\\id_ed25519',
      '-o', 'UserKnownHostsFile="C:\\Users\\Ali Valiyev\\.ssh\\known_hosts"',
      '--', 'person-a@pca.example',
    ]);
    expect(launch.kind).toBe('none');
    expect(launch.server).toBe('PCA');
  });
  test('the ssh program name follows the platform', () => {
    const launch = sshLaunch({ name: 'x', host: 'h', user: 'u' });
    expect(path.isAbsolute(launch.file)).toBe(true);
    expect(path.basename(launch.file)).toBe(process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    expect(launch.args).toEqual(['--', 'u@h']);
  });
});

test.describe('projects: names, ids and the saved list', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-projects-unit-'));
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const folder = (name: string) => {
    const p = path.join(dir, name);
    mkdirSync(p, { recursive: true });
    return realpathSync.native(p);
  };

  // The same cases as macOS Vibex (VibexTests/ProjectRailTests.swift).
  for (const [name, mono] of [['vibex', 'VI'], ['north-wind', 'NW'], ['blue_lake', 'BL'], ['x', 'X'], ['', '?']]) {
    test(`monogram of ${JSON.stringify(name)} is ${mono}`, () => expect(monogram(name)).toBe(mono));
  }

  test('a project keeps its id and its tile colour', () => {
    const p = folder('same');
    expect(projectId(p)).toBe(projectId(p));
    expect(projectId(p)).toMatch(/^[0-9a-f]{16}$/);
    expect(tintIndex('3f9a2c')).toBe(tintIndex('3f9a2c'));
    for (const id of ['3f9a2c', 'ffffffff', '0']) expect(tintIndex(id)).toBeLessThan(6);
  });

  test('the list keeps opening order, refuses a file, and one folder is one project', () => {
    const file = path.join(dir, 'list.json');
    const projects = new Projects(file);
    const [a, b] = [projects.open(folder('a')), projects.open(folder('b'))];
    expect(projects.list().map((p) => p.name)).toEqual(['a', 'b']);
    expect(projects.current()?.id).toBe(b.id);
    expect(projects.open(path.join(folder('a'), '.')).id).toBe(a.id);
    expect(projects.list()).toHaveLength(2);
    expect(projects.current()?.id).toBe(a.id);
    writeFileSync(path.join(dir, 'plain-file'), 'x');
    expect(() => projects.open(path.join(dir, 'plain-file'))).toThrow('not a folder');
    expect(() => projects.open(path.join(dir, 'missing'))).toThrow('not a folder');
  });

  test('known ids name every project of the saved file: open, held back on an unknown server, recent and missing', () => {
    const file = path.join(dir, 'known.json');
    const open = folder('known-open');
    const recent = folder('known-recent');
    const gone = path.join(dir, 'known-gone');
    writeFileSync(file, JSON.stringify({ open: [open, gone, { server: 'not-in-list', path: '~/held' }], recents: [recent] }));
    const projects = new Projects(file, () => false);
    // The held-back project and the missing folder are not open, but their ids are known.
    expect(projects.list().map((p) => p.name)).toEqual(['known-open']);
    const ids = projects.knownIds();
    expect(ids).toContain(projectId(realpathSync.native(open)));
    expect(ids).toContain(projectId(realpathSync.native(recent)));
    expect(ids).toContain(projectId(gone));
    const held = new Projects(path.join(dir, 'known-held.json'), () => true);
    expect(ids).toContain(held.openServer('not-in-list', '~/held').id);
  });

  test('a link to a folder is that folder', () => {
    const projects = new Projects(path.join(dir, 'links.json'));
    const real = folder('linked-real');
    const link = path.join(dir, 'linked-link');
    symlinkSync(real, link, 'junction');
    expect(projects.open(link).id).toBe(projects.open(real).id);
    expect(projects.list()).toHaveLength(1);
  });

  test('next and previous go round in the list', () => {
    const projects = new Projects(path.join(dir, 'round.json'));
    const [a, b, c] = ['r1', 'r2', 'r3'].map((n) => projects.open(folder(n)));
    expect(projects.adjacent(1)?.id).toBe(a.id);
    expect(projects.adjacent(1)?.id).toBe(b.id);
    expect(projects.adjacent(-1)?.id).toBe(a.id);
    expect(projects.adjacent(-1)?.id).toBe(c.id);
  });

  test('closing takes the next project, then the one before, then none', () => {
    const projects = new Projects(path.join(dir, 'close.json'));
    const [a, b, c] = ['c1', 'c2', 'c3'].map((n) => projects.open(folder(n)));
    projects.select(b.id);
    projects.close(b.id);
    expect(projects.current()?.id).toBe(c.id);
    projects.close(c.id);
    expect(projects.current()?.id).toBe(a.id);
    projects.close(a.id);
    expect(projects.current()).toBeNull();
  });

  test('a restart restores the list and the front project, and drops a folder that is gone', () => {
    const file = path.join(dir, 'restore.json');
    const first = new Projects(file);
    const [a, gone, c] = ['s1', 's2', 's3'].map((n) => first.open(folder(n)));
    first.select(a.id);
    rmSync(gone.path, { recursive: true });
    const second = new Projects(file);
    expect(second.list().map((p) => p.id)).toEqual([a.id, c.id]);
    expect(second.current()?.id).toBe(a.id);
    mkdirSync(gone.path);
  });

  test('a front project that is gone gives the first one; a damaged file gives an empty list', () => {
    const file = path.join(dir, 'front.json');
    const first = new Projects(file);
    const [a, b] = ['f1', 'f2'].map((n) => first.open(folder(n)));
    rmSync(b.path, { recursive: true });
    expect(new Projects(file).current()?.id).toBe(a.id);
    writeFileSync(file, '{ not json');
    const damaged = new Projects(file);
    expect(damaged.list()).toEqual([]);
    expect(damaged.current()).toBeNull();
    writeFileSync(file, JSON.stringify({ open: 'nope', recents: [1, null] }));
    expect(new Projects(file).list()).toEqual([]);
  });

  // The app opens no window if this throws at a start, and a second launch only finds the first one's lock.
  for (const content of ['null', '[]', '7', '"text"', '{"open":[null,3,{}]}', '{"open":["relative/path"]}']) {
    test(`a saved list of ${content} gives an empty list and does not throw`, () => {
      const file = path.join(dir, 'odd.json');
      writeFileSync(file, content);
      expect(new Projects(file).list()).toEqual([]);
    });
  }

  test('a save that fails changes nothing the person sees: the project is still selected, and nothing throws', () => {
    const blocker = path.join(dir, 'a-plain-file');
    writeFileSync(blocker, 'x');
    const projects = new Projects(path.join(blocker, 'cannot-be-here', 'list.json'));
    const [a, b] = [projects.open(folder('sv1')), projects.open(folder('sv2'))];
    expect(projects.current()?.id).toBe(b.id);
    expect(projects.select(a.id)?.id).toBe(a.id);
    expect(projects.current()?.id).toBe(a.id);
    projects.close(a.id);
    expect(projects.list().map((p) => p.id)).toEqual([b.id]);
  });

  test('a long saved recent list is cut, and only the first ones are looked at', () => {
    const file = path.join(dir, 'long.json');
    writeFileSync(file, JSON.stringify({ recents: Array.from({ length: 5000 }, (_, i) => `/no/such/folder/${i}`) }));
    expect(new Projects(file).recents()).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).recents).toHaveLength(5000); // reading does not rewrite it
    const projects = new Projects(file);
    projects.open(folder('after-long'));
    expect(JSON.parse(readFileSync(file, 'utf8')).recents.length).toBeLessThanOrEqual(9);
  });

  test('recents keep the last 8 folders, without the open ones, and only those that exist', () => {
    const projects = new Projects(path.join(dir, 'recent.json'));
    const opened = Array.from({ length: 10 }, (_, i) => projects.open(folder(`t${i}`)));
    for (const p of opened.slice(0, 9)) projects.close(p.id);
    expect(projects.recents().map((r) => r.name)).toEqual(['t8', 't7', 't6', 't5', 't4', 't3', 't2', 't1']);
    rmSync(opened[8].path, { recursive: true });
    expect(projects.recents().map((r) => r.name)[0]).toBe('t7');
    mkdirSync(opened[8].path);
  });

  test('routing: project_path first, then the header; no match is refused', () => {
    const projects = new Projects(path.join(dir, 'route.json'));
    const [a, b] = ['p1', 'p2'].map((n) => projects.open(folder(n)));
    expect(projects.route(a.id, undefined).id).toBe(a.id);
    expect(projects.route(a.id, b.path).id).toBe(b.id);
    expect(() => projects.route(undefined, undefined)).toThrow('project_path');
    expect(() => projects.route('', undefined)).toThrow('project_path');
    expect(() => projects.route('dead', undefined)).toThrow('not open');
    expect(() => projects.route(a.id, folder('p3'))).toThrow('open project');
    // A relative path would resolve against the app's own folder, not the caller's.
    expect(() => projects.route(a.id, '.')).toThrow('absolute');
    projects.close(b.id);
    // One project open and no header: the caller may be a Claude in another folder, so nothing acts here either.
    expect(() => projects.route(undefined, undefined)).toThrow('project_path');
    // A header that names a closed project is still refused: that session belongs to it.
    expect(() => projects.route(b.id, undefined)).toThrow('not open');
    projects.close(a.id);
    expect(() => projects.route(undefined, undefined)).toThrow('no project is open');
  });

  test('a tab in a project starts in its folder and knows its project', () => {
    const projects = new Projects(path.join(dir, 'launch.json'));
    const p = projects.open(folder('tab-home'));
    const launch = inProject({ file: 'sh', args: [], kind: 'posix', title: 't', env: { KEEP: '1' } }, p);
    expect(launch.cwd).toBe(p.path);
    expect(launch.project).toBe(p.id);
    expect(launch.env).toEqual({ KEEP: '1', VIBEX_PROJECT: p.path, VIBEX_WINDOW: p.id });
  });
});

test.describe('server projects: a folder on a saved server', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-server-unit-'));
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const known = (name: string) => name === 'pca';
  const profile = { name: 'pca', host: 'server.example', user: 'me' };

  for (const good of ['~', '~/app', '/srv/app', "~/it's mine", '/srv/üzbek loyiha']) {
    test(`folder accepted: ${good}`, () => expect(checkServerFolder(good)).toBeNull());
  }
  for (const bad of ['', '   ', 'app', '-rf', '../up', '~other/app', '/srv/a\nrm -rf /', '/srv/a\x1b[2J']) {
    test(`folder refused: ${JSON.stringify(bad)}`, () => expect(checkServerFolder(bad)).toContain('folder'));
  }

  test('the folder is one shell word, and a quote or a command in it stays text', () => {
    expect(remoteFolder('~')).toBe('"$HOME"');
    expect(remoteFolder('~/app')).toBe(`"$HOME"/'app'`);
    expect(remoteFolder('/srv/app')).toBe(`'/srv/app'`);
    expect(remoteFolder("~/it's")).toBe(`"$HOME"/'it'\\''s'`);
    expect(remoteFolder('/srv/$(reboot)')).toBe(`'/srv/$(reboot)'`);
  });

  test('a server project tab asks for a terminal, and the target comes after --', () => {
    const shell = serverLaunch(profile, '/srv/app', 'shell');
    expect(shell.args.slice(-3)).toEqual(['--', 'me@server.example', viaSh(serverScript('/srv/app', 'shell', ''))]);
    expect(shell.args).toContain('-t');
    expect(shell.args).toContain('ServerAliveInterval=30');
    expect(shell.args.indexOf('-t')).toBeLessThan(shell.args.indexOf('--'));
    expect(shell.server).toBe('pca');
    expect(shell.pane).toBe('shell');
    const agent = serverLaunch(profile, '/srv/app', 'agent', 'claude');
    expect(agent.pane).toBe('agent');
    expect(agent.title).toBe('Claude');
    // A plain ssh tab stays as it was.
    expect(sshLaunch(profile).args).toEqual(['--', 'me@server.example']);
  });

  // The commands run for real, in each login shell this computer has: a test of the text alone would pass a syntax error.
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/tcsh', '/bin/csh', '/usr/bin/fish', '/opt/homebrew/bin/fish'].filter((f) => existsSync(f));
  for (const login of process.platform === 'win32' ? [] : shells) {
    test(`on a server with the login shell ${login}, the tabs and the folder list work`, () => {
      const home = realpathSync.native(mkdtempSync(path.join(dir, 'home-')));
      const folder = path.join(home, "it's $(mine)");
      mkdirSync(folder);
      mkdirSync(path.join(home, 'second'));
      writeFileSync(path.join(home, 'a-file'), 'x');
      const run = (remote: string) => execFileSync(login, ['-c', remote], { env: { PATH: process.env.PATH, HOME: home, SHELL: login }, cwd: home, encoding: 'utf8', input: '', timeout: 20_000 });
      const typed = "~/it's $(mine)";
      expect(run(viaSh(serverScript(typed, 'agent', 'pwd')))).toContain(folder);
      expect(run(viaSh(serverScript(typed, 'agent', 'pwd; echo "SHELL_TAB_LIVES"')))).toContain('SHELL_TAB_LIVES');
      execFileSync(login, ['-c', viaSh(serverScript(typed, 'shell', ''))], { env: { PATH: process.env.PATH, HOME: home, SHELL: login }, cwd: home, input: '', timeout: 20_000, stdio: ['pipe', 'ignore', 'ignore'] });
      expect(run(LIST_FOLDERS).split('\n').filter(Boolean).sort()).toEqual(["it's $(mine)/", 'second/']);
    });
  }

  test('the native Claude comes first, because a command does not read every setup file', () => {
    const home = realpathSync.native(mkdtempSync(path.join(dir, 'native-')));
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho NATIVE-CLAUDE-IN "$PWD"\n', { mode: 0o755 });
    const out = execFileSync(posixSh(), ['-c', viaSh(serverScript('~', 'agent', 'claude'))], { env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, encoding: 'utf8', input: '' });
    // Git's sh on Windows writes this folder as /c/...
    expect(out).toContain(process.platform === 'win32' ? 'NATIVE-CLAUDE-IN /' : `NATIVE-CLAUDE-IN ${home}`);
  });

  test('folder names on a server keep their letter case, also when this computer runs Windows', () => {
    const projects = new Projects(path.join(dir, 'case.json'), known);
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(projects.openServer('pca', '~/App').id).not.toBe(projects.openServer('pca', '~/app').id);
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });

  test('odd folder text: a trailing slash goes, an edge space stays, and all slashes are the root', () => {
    const projects = new Projects(path.join(dir, 'odd.json'), known);
    expect(projects.openServer('pca', '/srv/app///').path).toBe('/srv/app');
    expect(projects.openServer('pca', '//').path).toBe('/');
    expect(projects.openServer('pca', '~/foo ').path).toBe('~/foo ');
  });

  test('a server whose name is missing from servers.json for a while comes back with its projects', () => {
    const file = path.join(dir, 'parked.json');
    const first = new Projects(file, known);
    const parked = first.openServer('pca', '/srv/parked');
    let broken = new Projects(file, () => false);
    expect(broken.list()).toEqual([]);
    broken.open(mkdirSync(path.join(dir, 'other-local'), { recursive: true }) ?? path.join(dir, 'other-local'));
    broken = new Projects(file, known);
    expect(broken.list().map((p) => p.id)).toContain(parked.id);
  });

  test('a bad profile is skipped, and null options do not throw', () => {
    expect(isValid(profile)).toBe(true);
    for (const options of [null, 'x', { ProxyCommand: 'calc' }, { PKCS11Provider: '/tmp/x.so' }, { SecurityKeyProvider: '/tmp/x.so' }]) {
      expect(isValid({ ...profile, options })).toBe(false);
    }
  });

  test('menu shortcuts follow the physical key and the exact modifiers', () => {
    const none = { control: false, shift: false, alt: false, meta: false };
    expect(matchesAccelerator('CmdOrCtrl+4', { ...none, code: 'Digit4', control: true }, false)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+4', { ...none, code: 'Digit4', meta: true }, true)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+4', { ...none, code: 'Digit4', control: true }, true)).toBe(false);
    expect(matchesAccelerator('CmdOrCtrl+4', { ...none, code: 'Digit4', control: true, shift: true }, false)).toBe(false);
    expect(matchesAccelerator('Ctrl+PageDown', { ...none, code: 'PageDown', control: true }, true)).toBe(true);
    expect(matchesAccelerator('Ctrl+Shift+T', { ...none, code: 'KeyT', control: true, shift: true }, false)).toBe(true); // also on a Cyrillic layout
    expect(matchesAccelerator('Alt+Left', { ...none, code: 'ArrowLeft', alt: true }, false)).toBe(true);
    expect(matchesAccelerator('F5', { ...none, code: 'F5' }, false)).toBe(true);
    expect(matchesAccelerator('Ctrl+Tab', { ...none, code: 'KeyC', control: true }, false)).toBe(false);
  });

  test('one folder on one server is one project; the same path on another server or on this PC is not', () => {
    const projects = new Projects(path.join(dir, 'one.json'), known);
    const a = projects.openServer('pca', '/srv/app');
    expect(a.server).toBe('pca');
    expect(a.name).toBe('app');
    expect(a.monogram).toBe('AP');
    expect(projects.openServer('pca', '/srv/app').id).toBe(a.id);
    expect(projects.list()).toHaveLength(1);
    expect(projects.openServer('other', '/srv/app').id).not.toBe(a.id);
    expect(projectId('/srv/app')).not.toBe(a.id);
    expect(projects.openServer('pca', '~').name).toBe('pca');
  });

  test('a bad folder is refused before it is saved', () => {
    const projects = new Projects(path.join(dir, 'bad.json'), known);
    expect(() => projects.openServer('pca', 'app')).toThrow('folder');
    expect(projects.list()).toEqual([]);
  });

  test('a restart keeps local and server projects in order and the front one; an unknown server drops off', () => {
    const file = path.join(dir, 'mix.json');
    const local = mkdirSync(path.join(dir, 'local'), { recursive: true }) ?? path.join(dir, 'local');
    const first = new Projects(file, known);
    const a = first.open(local);
    const b = first.openServer('pca', '/srv/app');
    first.openServer('gone', '/srv/x');
    first.select(b.id);
    const second = new Projects(file, known);
    expect(second.list().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(second.current()?.id).toBe(b.id);
    expect(second.current()?.server).toBe('pca');
  });

  test('a hand-edited saved folder that fails the check drops off', () => {
    const file = path.join(dir, 'edited.json');
    writeFileSync(file, JSON.stringify({ open: [{ server: 'pca', path: '/srv/a\nreboot' }, { server: 'pca', path: 'relative' }, { server: 'pca', path: '/srv/ok' }] }));
    expect(new Projects(file, known).list().map((p) => p.path)).toEqual(['/srv/ok']);
  });

  test('closing puts a server project in the recents with its server; routing never matches it by path', () => {
    const projects = new Projects(path.join(dir, 'recents.json'), known);
    const a = projects.openServer('pca', '/srv/app');
    const local = projects.open(realpathSync.native(mkdtempSync(path.join(dir, 'l-'))));
    expect(() => projects.route(undefined, '/srv/app')).toThrow('open project');
    expect(projects.route(a.id, undefined).id).toBe(a.id);
    projects.close(a.id);
    expect(projects.recents()).toContainEqual({ name: 'app', path: '/srv/app', server: 'pca' });
    expect(projects.current()?.id).toBe(local.id);
  });
});

test.describe('keyFilePath: a key path copied from PowerShell (PCA PC, 2026-11-04)', () => {
  const home = 'C:\\Users\\user';
  for (const typed of ['$HOME\\.ssh\\id_ed25519', '${HOME}\\.ssh\\id_ed25519', '$env:USERPROFILE\\.ssh\\id_ed25519', '%USERPROFILE%\\.ssh\\id_ed25519', '$home/.ssh/id_ed25519']) {
    test(`Windows: ${typed} is the file in the home folder`, () => expect(keyFilePath(typed, 'win32', home)).toBe('C:\\Users\\user\\.ssh\\id_ed25519'));
  }
  test('Linux and macOS: $HOME/... is the file in the home folder', () => expect(keyFilePath('$HOME/.ssh/k', 'linux', '/home/me')).toBe('/home/me/.ssh/k'));
  test('Linux and macOS: $home is not $HOME, as in a POSIX shell', () => expect(keyFilePath('$home/.ssh/k', 'linux', '/home/me')).toBe('$home/.ssh/k'));
  for (const kept of ['~/.ssh/id_ed25519', 'C:\\keys\\id', '/keys/id', '$HOMEDIR/id', 'C:\\a\\$HOME\\id']) {
    test(`kept as typed: ${kept}`, () => expect(keyFilePath(kept, 'win32', home)).toBe(kept));
  }
  test('the ssh command gets the written-out path', () => {
    const launch = sshLaunch({ name: 'PCA', host: 'pca.example', user: 'pca', identityFile: '$HOME/.ssh/id_ed25519' });
    expect(launch.args[launch.args.indexOf('-i') + 1]).toBe(path.join(os.homedir(), '.ssh', 'id_ed25519'));
  });
  test('the passphrase prompt of that key still matches the saved profile', () => {
    expect(keyNameMatches('C:\\Users\\user/.ssh/id_ed25519', '$HOME\\.ssh\\id_ed25519', 'win32', home)).toBe(true);
  });
});

test.describe('server project: a folder that is not on the server says so', () => {
  // PCA tabs run toolsScript (the Vibex tools are on); the plain path runs serverScript. Both must say it.
  const scripts: Record<string, (folder: string) => string> = {
    serverScript: (folder) => serverScript(folder, 'shell', ''),
    'toolsScript (shell tab)': (folder) => toolsScript({ profile: { name: 'PCA', host: 'pca.example', user: 'pca', allowClaude: true }, folder, pane: 'shell', remotePort: 5150, windowId: 'w1', forward: [] }),
    'toolsScript (Claude tab)': (folder) => toolsScript({ profile: { name: 'PCA', host: 'pca.example', user: 'pca', allowClaude: true }, folder, pane: 'agent', remotePort: 5150, windowId: 'w1', forward: [] }),
  };
  for (const [name, make] of Object.entries(scripts)) test(`${name} names the folder and the next step, and stops with code 1`, () => {
    const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'vibex-nofolder-')), "it's gone");
    const script = make(missing);
    let code = 0;
    let err = '';
    try {
      execFileSync(posixSh(), ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } });
    } catch (e: any) {
      code = e.status;
      err = String(e.stderr);
    }
    expect(code).toBe(1);
    expect(err).toContain(`Vibex: the folder ${missing} is not on this server`);
    expect(err).toContain('type the right folder');
  });
});
