import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fuzzyMatch, rank } from '../src/renderer/fuzzy';
import { addArguments, installedServers, parseHealth, safeCommand, safeUrl } from '../src/main/mcpServers';
import { shortcutText } from '../src/main/palette';
import { detectRun, guessPort, loadRunFile, localUrl, summary } from '../src/main/run';
import { runChecks, type Probe } from '../src/main/setup';
import { frontmatter, listSkills, readSkill, removeSkill, undoRemoveSkill, validSkillName } from '../src/main/skills';
import { dayKeys, sanitized, toolKey, UsageCounter } from '../src/main/usage';
import { tempDir, firstWindow, standInProgram, useStandIn } from './fixtures';

// Skills, MCP servers, Run, the command palette, Setup and the usage counter (src/main/pcaTools.ts).
// Made-up data in temp folders; the person's own Claude config is never read: CLAUDE_CONFIG_DIR and HOME point at temp.

const SECRET_HEADER = 'Bearer sk-test-HEADER-9f8e7d6c';
const SECRET_ENV = 'sk-test-ENV-1a2b3c4d';
const SECRET_QUERY = 'sk-test-QUERY-5e6f7a8b';

/// Runs `fn` with HOME, USERPROFILE and CLAUDE_CONFIG_DIR pointed at a temp folder, then puts them back.
function withHome<T>(fn: (home: string) => T): T {
  const home = tempDir('vibex-tools-home-');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function writeSkill(root: string, name: string, description: string, body = 'Do the thing.'): void {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
}

// ---------- unit checks: no window ----------

test.describe('skills', () => {
  test('frontmatter reads plain, quoted and folded values', () => {
    const text = '---\nname: audit\ndescription: >\n  Checks the books\n  for gaps.\nother: "quoted"\n---\nBody';
    expect(frontmatter(text)).toMatchObject({ name: 'audit', description: 'Checks the books for gaps.', other: 'quoted' });
    expect(frontmatter('no front matter')).toEqual({});
  });

  test('lists project and global skills, sorted, and skips folders without SKILL.md', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      writeSkill(path.join(home, '.claude', 'skills'), 'zeta', 'Last one');
      writeSkill(path.join(home, '.claude', 'skills'), 'alpha', 'First one');
      mkdirSync(path.join(home, '.claude', 'skills', 'empty'), { recursive: true });
      writeSkill(path.join(project, '.claude', 'skills'), 'local-only', 'Only here');
      expect(listSkills('global', project).map((s) => s.name)).toEqual(['alpha', 'zeta']);
      expect(listSkills('project', project)).toMatchObject([{ name: 'local-only', summary: 'Only here', scope: 'project' }]);
      expect(readSkill('global', project, 'alpha')).toContain('# alpha');
    });
  });

  test('a skill name is one folder name', () => {
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', '.hidden', 5, null]) expect(validSkillName(bad as any)).toBe(false);
    expect(validSkillName('my-skill_2')).toBe(true);
    withHome((home) => {
      expect(() => readSkill('global', home, '../../etc')).toThrow('not a skill name');
      expect(() => removeSkill(path.join(home, 'trash'), 'global', home, '../x')).toThrow('not a skill name');
    });
  });

  test('remove moves the folder away and undo puts it back', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      const root = path.join(project, '.claude', 'skills');
      writeSkill(root, 'beta', 'Second');
      const trash = path.join(home, 'trash');
      const token = removeSkill(trash, 'project', project, 'beta');
      expect(existsSync(path.join(root, 'beta'))).toBe(false);
      expect(listSkills('project', project)).toEqual([]);
      expect(undoRemoveSkill(trash, token)).toBe('beta');
      expect(readFileSync(path.join(root, 'beta', 'SKILL.md'), 'utf8')).toContain('description: Second');
      expect(existsSync(path.join(trash, token))).toBe(false);
    });
  });

  test('remove and undo keep a linked skill linked, and move only the files under .agents/skills', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      const files = path.join(project, '.agents', 'skills', 'linked');
      writeSkill(path.join(project, '.agents', 'skills'), 'linked', 'Through a link');
      mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      symlinkSync('../../.agents/skills/linked', path.join(project, '.claude', 'skills', 'linked'), process.platform === 'win32' ? 'junction' : undefined);
      expect(listSkills('project', project).map((s) => s.name)).toEqual(['linked']);
      const trash = path.join(home, 'trash');
      const token = removeSkill(trash, 'project', project, 'linked');
      expect(existsSync(files)).toBe(false);
      expect(listSkills('project', project)).toEqual([]);
      undoRemoveSkill(trash, token);
      expect(existsSync(path.join(files, 'SKILL.md'))).toBe(true);
      expect(listSkills('project', project).map((s) => s.name)).toEqual(['linked']);
    });
  });

  test('a link to files outside .agents/skills is removed and the files stay', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      const elsewhere = path.join(home, 'my-own-skills');
      writeSkill(elsewhere, 'mine', 'Kept where I keep it');
      mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      symlinkSync(path.join(elsewhere, 'mine'), path.join(project, '.claude', 'skills', 'mine'), process.platform === 'win32' ? 'junction' : undefined);
      const token = removeSkill(path.join(home, 'trash'), 'project', project, 'mine');
      expect(existsSync(path.join(elsewhere, 'mine', 'SKILL.md'))).toBe(true);
      expect(listSkills('project', project)).toEqual([]);
      undoRemoveSkill(path.join(home, 'trash'), token);
      expect(listSkills('project', project).map((s) => s.name)).toEqual(['mine']);
    });
  });

  test('undo refuses an unknown token and does not overwrite a skill that came back', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      const root = path.join(project, '.claude', 'skills');
      writeSkill(root, 'again', 'One');
      const trash = path.join(home, 'trash');
      expect(() => undoRemoveSkill(trash, 'nope')).toThrow('not known');
      const token = removeSkill(trash, 'project', project, 'again');
      writeSkill(root, 'again', 'A new one');
      expect(() => undoRemoveSkill(trash, token)).toThrow('there already');
    });
  });
});

test.describe('MCP servers', () => {
  test('the list carries names, places and commands, and never a header or environment value', () => {
    withHome((home) => {
      const project = path.join(home, 'proj');
      mkdirSync(project, { recursive: true });
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({
        mcpServers: {
          remote: { type: 'http', url: `https://mcp.example.test/v1/mcp?key=${SECRET_QUERY}`, headers: { Authorization: SECRET_HEADER } },
          memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory', `--api-key=${SECRET_ENV}`], env: { API_KEY: SECRET_ENV } },
        },
        projects: { [project]: { mcpServers: { mine: { command: 'node', args: ['server.js', '--token', SECRET_ENV] } } } },
      }));
      writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { url: 'https://shared.example.test/mcp', headers: { 'X-Key': SECRET_HEADER } } } }));
      const servers = installedServers(project);
      expect(servers.map((s) => `${s.scope}:${s.name}`)).toEqual(['user:memory', 'user:remote', 'local:mine', 'project:shared']);
      const text = JSON.stringify(servers);
      for (const secret of [SECRET_HEADER, SECRET_ENV, SECRET_QUERY]) expect(text).not.toContain(secret);
      expect(servers.find((s) => s.name === 'remote')!.detail).toBe('https://mcp.example.test/v1/mcp');
      expect(servers.find((s) => s.name === 'memory')!.detail).toBe('npx -y @modelcontextprotocol/server-memory --api-key=…');
      expect(servers.find((s) => s.name === 'mine')!.detail).toBe('node server.js --token …');
    });
  });

  test('safeUrl and safeCommand cut user, password, query and values', () => {
    expect(safeUrl('https://user:pw@host.test/p?a=1#x')).toBe('https://host.test/p');
    expect(safeUrl('https://host.test/')).toBe('https://host.test');
    expect(safeCommand('docker', ['run', '-e', 'TOKEN=abc', 'image'])).toBe('docker run -e TOKEN=… image');
    expect(safeCommand(undefined, undefined)).toBe('');
  });

  test('health lines are read as macOS Vibex reads them', () => {
    const out = [
      'Checking MCP server health...',
      '',
      'clickup: https://mcp.clickup.test/mcp?x=secret (HTTP) - ✔ Connected',
      'memory: npx -y @modelcontextprotocol/server-memory - ✗ Failed to connect',
      'figma: https://mcp.figma.test/mcp (HTTP) - ⚠ Needs authentication',
      'shared: node s.js - ⚠ Pending approval',
    ].join('\n');
    expect(parseHealth(out)).toEqual([
      { name: 'clickup', target: 'https://mcp.clickup.test/mcp', health: 'connected' },
      { name: 'memory', target: 'npx -y @modelcontextprotocol/server-memory', health: 'failed' },
      { name: 'figma', target: 'https://mcp.figma.test/mcp', health: 'needsSignIn' },
      { name: 'shared', target: 'node s.js', health: 'waitingForApproval' },
    ]);
  });

  test('add arguments are an argument list, with the name and address before options', () => {
    expect(addArguments({ name: 'docs', scope: 'user', url: 'https://docs.example.test/mcp' })).toEqual(['mcp', 'add', 'docs', 'https://docs.example.test/mcp', '--transport', 'http', '--scope', 'user']);
    expect(addArguments({ name: 'mem', scope: 'project', command: 'npx', args: '-y  @modelcontextprotocol/server-memory' })).toEqual(['mcp', 'add', 'mem', '--scope', 'project', '--', 'npx', '-y', '@modelcontextprotocol/server-memory']);
  });

  test('add refuses a bad name, scope, address, program, and the vibex server', () => {
    const bad = (input: any, words: string) => expect(() => addArguments(input)).toThrow(words);
    bad({ name: 'a b', scope: 'user', url: 'https://x.test' }, 'letters, digits');
    bad({ name: '--scope', scope: 'user', url: 'https://x.test' }, 'start with a letter or digit');
    bad({ name: '-x', scope: 'user', command: 'npx' }, 'start with a letter or digit');
    bad({ name: 'vibex', scope: 'user', url: 'https://x.test' }, 'manages the vibex server');
    bad({ name: 'ok', scope: 'everywhere', url: 'https://x.test' }, 'Pick where');
    bad({ name: 'ok', scope: 'user', url: 'file:///etc/passwd' }, 'https:// or http://');
    bad({ name: 'ok', scope: 'user', url: 'not a url' }, 'not a web address');
    bad({ name: 'ok', scope: 'user', command: '  ' }, 'program');
  });
});

test.describe('run', () => {
  const project = (files: Record<string, string>): string => {
    const dir = tempDir('vibex-run-');
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
  };

  test('a package.json dev script becomes a web run with the right runner and port', () => {
    const cases: [Record<string, string>, string, number][] = [
      [{ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '1' } }) }, 'npm run dev', 5173],
      [{ 'package.json': JSON.stringify({ scripts: { start: 'node s.js --port 4567' } }), 'pnpm-lock.yaml': '' }, 'pnpm start', 4567],
      [{ 'package.json': JSON.stringify({ scripts: { serve: 'x' } }), 'yarn.lock': '' }, 'yarn serve', 3000],
      [{ 'package.json': JSON.stringify({ scripts: { dev: 'astro dev' }, dependencies: { astro: '1' } }) }, 'npm run dev', 4321],
    ];
    for (const [files, command, port] of cases) {
      const dir = project(files);
      try {
        expect(detectRun(dir)).toEqual({ kind: 'web', command, url: `http://localhost:${port}`, source: 'detected' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('other projects and nothing', () => {
    const dir = project({ 'Cargo.toml': '' });
    const go = project({ 'go.mod': '' });
    const make = project({ Makefile: 'build:\n\ttrue\nrun:\n\ttrue\n' });
    const makeNoRun = project({ Makefile: 'build:\n\ttrue\n' });
    const xcode = project({ 'project.yml': 'name: Demo\ntargets:\n  Demo:\n    platform: iOS\n' });
    const macApp = project({ 'project.yml': 'name: Desk\ntargets:\n  Desk:\n    platform: macOS\n' });
    const empty = project({});
    const broken = project({ 'package.json': '{ not json' });
    try {
      expect(detectRun(dir)).toMatchObject({ kind: 'command', command: 'cargo run' });
      expect(detectRun(go)).toMatchObject({ command: 'go run .' });
      expect(detectRun(make)).toMatchObject({ command: 'make run' });
      expect(detectRun(makeNoRun)).toBeNull();
      expect(detectRun(xcode)).toMatchObject({ kind: 'ios', scheme: 'Demo', prepare: 'xcodegen generate' });
      expect(summary(detectRun(xcode))).toBe('iOS · Demo');
      expect(detectRun(macApp)).toMatchObject({ kind: 'macos', scheme: 'Desk' });
      expect(detectRun(empty)).toBeNull();
      expect(detectRun(broken)).toBeNull();
      expect(detectRun(path.join(empty, 'missing'))).toBeNull();
    } finally {
      for (const d of [dir, go, make, makeNoRun, xcode, macApp, empty, broken]) rmSync(d, { recursive: true, force: true });
    }
  });

  test('.vibex.json wins and is marked as from the file', () => {
    const dir = project({ '.vibex.json': JSON.stringify({ run: { kind: 'web', command: 'node s.js', url: 'http://127.0.0.1:4000' } }), 'package.json': JSON.stringify({ scripts: { dev: 'x' } }) });
    const bad = project({ '.vibex.json': JSON.stringify({ run: { kind: 'bogus' } }) });
    try {
      expect(loadRunFile(dir)).toMatchObject({ kind: 'web', command: 'node s.js', url: 'http://127.0.0.1:4000', source: 'file' });
      expect(loadRunFile(bad)).toBeNull();
      expect(loadRunFile(path.join(dir, 'nowhere'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test('ports and local addresses', () => {
    expect(guessPort({}, 'next dev -p 3100')).toBe(3100);
    expect(guessPort({ '@angular/core': '1' }, 'ng serve')).toBe(4200);
    expect(localUrl('http://localhost:5173')).not.toBeNull();
    expect(localUrl('http://127.0.0.1:3000/x')).not.toBeNull();
    expect(localUrl('https://example.com')).toBeNull();
    expect(localUrl('ftp://localhost')).toBeNull();
    expect(localUrl('garbage')).toBeNull();
  });
});

test.describe('usage counter', () => {
  const at = (iso: string) => () => new Date(`${iso}T12:00:00`);

  test('counts per day, reads 7 and 30 day totals, most used first', () => {
    let today = '2026-10-31';
    const counter = new UsageCounter(null, () => new Date(`${today}T12:00:00`));
    counter.count('mcp.browser_click');
    counter.count('mcp.browser_click');
    today = '2026-10-20';
    counter.count('ui.run.button');
    today = '2026-09-01';
    counter.count('palette.menu.old');
    today = '2026-10-31';
    expect(counter.rows()).toEqual([
      { feature: 'mcp.browser_click', last7: 2, last30: 2 },
      { feature: 'ui.run.button', last7: 0, last30: 1 },
    ]);
    expect(counter.table()).toContain('mcp.browser_click');
    expect(counter.table()).not.toContain('palette.menu.old');
    expect(new UsageCounter(null, at('2026-10-31')).table()).toBe('No usage counted yet.');
  });

  test('keys can only be fixed names', () => {
    expect(sanitized('mcp.browser_click')).toBe('mcp.browser_click');
    expect(sanitized('C:\\Users\\me\\secret folder/x?y=1')).toBe('C:_Users_me_secret_folder_x_y_1');
    expect(sanitized('')).toBe('other');
    expect(sanitized('a'.repeat(200))).toHaveLength(80);
    expect(toolKey('browser_navigate', { url: 'https://secret.example.test' })).toBe('mcp.browser_navigate');
    expect(toolKey('vibex_view', { view: 'browser' })).toBe('mcp.vibex_view.browser');
    expect(toolKey('vibex_view', { view: '../etc' })).toBe('mcp.vibex_view.other');
  });

  test('drops days older than 180 and keeps the rest across a restart; the file holds counts only', () => {
    const dir = tempDir('vibex-usage-');
    try {
      const file = path.join(dir, 'usage.json');
      let now = new Date('2026-10-31T12:00:00');
      const counter = new UsageCounter(file, () => now);
      now = new Date('2026-03-01T12:00:00');
      counter.count('ui.old');
      now = new Date('2026-10-30T12:00:00');
      counter.count('ui.recent');
      now = new Date('2026-10-31T12:00:00');
      counter.flush();
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(saved.days)).toEqual(['2026-10-30']);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(new UsageCounter(file, () => now).rows()).toEqual([{ feature: 'ui.recent', last7: 1, last30: 1 }]);
      expect(dayKeys(new Date('2026-03-01T12:00:00'), 3)).toEqual(['2026-03-01', '2026-02-28', '2026-02-27']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file that does not read is kept aside and counting starts again', () => {
    const dir = tempDir('vibex-usage-');
    try {
      const file = path.join(dir, 'usage.json');
      writeFileSync(file, '{ broken');
      const counter = new UsageCounter(file, at('2026-10-31'));
      counter.count('ui.x');
      counter.flush();
      expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{ broken');
      expect(JSON.parse(readFileSync(file, 'utf8')).days['2026-10-31']).toEqual({ 'ui.x': 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('setup checks', () => {
  const fake = (present: Record<string, string>): Probe => async (file) => present[path.basename(file).replace(/\.exe$/, '')] ?? null;

  test('everything there: four of four ready, no next steps', async () => {
    const items = await runChecks(os.tmpdir(), fake({ git: 'git version 2.50.0', ssh: 'OpenSSH_9.9', node: 'v24.1.0', claude: '2.1.0 (Claude Code)' }), () => '/x/claude');
    expect(items.map((i) => `${i.id}:${i.status}`)).toEqual(['git:ready', 'ssh:ready', 'node:ready', 'claude:ready']);
    expect(items.every((i) => !i.next && !i.action)).toBe(true);
  });

  test('missing git and ssh are needed and say what to do; Node is only optional for a folder with no package.json', async () => {
    const empty = tempDir('vibex-setup-');
    try {
      const items = await runChecks(empty, fake({ claude: '2.1.0' }), () => '/x/claude');
      const by = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(by.git).toMatchObject({ status: 'needed' });
      // The round arrow is the button named Check again; the Windows text says what the person sees.
      expect(by.git.next).toMatch(process.platform === 'win32' ? /round arrow/ : /Check again/);
      expect(by.git.action).toMatchObject({ kind: 'open' });
      expect(by.ssh.status).toBe('needed');
      expect(by.node.status).toBe('optional');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('Node is needed when the project has a package.json', async () => {
    const dir = tempDir('vibex-setup-');
    try {
      writeFileSync(path.join(dir, 'package.json'), '{}');
      const node = (await runChecks(dir, fake({ git: 'g', ssh: 's', claude: '1' }), () => '/x/claude')).find((i) => i.id === 'node')!;
      expect(node.status).toBe('needed');
      expect(node.action).toMatchObject({ kind: 'open' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Claude Code missing offers an install button, which is a click and not a run', async () => {
    const items = await runChecks(os.tmpdir(), fake({ git: 'g', ssh: 's', node: 'n' }), () => null);
    const claude = items.find((i) => i.id === 'claude')!;
    expect(claude.status).toBe('needed');
    expect(claude.action).toEqual({ label: 'Install Claude Code', kind: 'install' });
    expect(claude.next).toMatch(/watch it/);
  });
});

test.describe('palette helpers', () => {
  test('fuzzy ranks word starts and runs first', () => {
    const titles = ['Open Project', 'Open Browser Tab', 'Close Tab', 'Next Tab'];
    expect(rank(titles, 'obt', (t) => t)[0].item).toBe('Open Browser Tab');
    expect(rank(titles, 'zzz', (t) => t)).toEqual([]);
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch('ct', 'Close Tab')!.positions).toEqual([0, 6]);
    expect(rank(titles, 'tab', (t) => t).map((r) => r.item)).toEqual(['Next Tab', 'Close Tab', 'Open Browser Tab']);
  });

  test('shortcuts read per platform', () => {
    expect(shortcutText('CmdOrCtrl+Shift+P', true)).toBe('Cmd+Shift+P');
    expect(shortcutText('CmdOrCtrl+Shift+P', false)).toBe('Ctrl+Shift+P');
  });
});

// ---------- the app: sections, tools, run, palette ----------

test.describe('in the app', () => {
  test.describe.configure({ mode: 'serial' });

  let app: ElectronApplication;
  let page: Page;
  const paneMoves: string[] = [];
  let dir: string;
  let userData: string;
  let project: string;
  let projectId: string;
  let home: string;
  let claudeLog: string;
  let appPort: number;
  let token: string;
  let serverPort: number;
  const posix = process.platform !== 'win32';

  const mcp = async (windowId?: string): Promise<Client> => {
    const client = new Client({ name: 'vibex-tools-test', version: '1.0.0' });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (windowId !== undefined) headers['X-Vibex-Window'] = windowId;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${appPort}/mcp`), { requestInit: { headers } }));
    return client;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const client = await mcp(projectId);
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    await client.close();
    return (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  };
  const activity = (name: string) => page.locator(`#activity [data-activity="${name}"]`);
  /// Screenshots of the made-up data, only when VIBEX_SHOTS names a folder.
  const shot = async (name: string) => {
    if (process.env.VIBEX_SHOTS) await page.screenshot({ path: path.join(process.env.VIBEX_SHOTS, `${name}.png`) });
  };
  const claudeCalls = () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  test.beforeAll(async () => {
    dir = realpathSync.native(tempDir('vibex-tools-app-'));
    userData = path.join(dir, 'profile');
    home = path.join(dir, 'home');
    project = path.join(dir, 'alpha-tools');
    claudeLog = path.join(dir, 'claude-calls.log');
    mkdirSync(userData);
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(project);
    writeSkill(path.join(home, '.claude', 'skills'), 'global-review', 'Reviews work in every project');
    writeSkill(path.join(project, '.claude', 'skills'), 'ledger-check', 'Checks the ledger of this project', 'Step one: open the ledger.\n\n- compare totals\n- note gaps\n\n```\nrun-me --now\n```');
    writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({
      mcpServers: {
        memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { API_KEY: SECRET_ENV } },
        remote: { type: 'http', url: `https://mcp.example.test/mcp?key=${SECRET_QUERY}`, headers: { Authorization: SECRET_HEADER } },
      },
    }));
    writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { url: 'https://shared.example.test/mcp' } } }));
    // A stand-in for the claude program: it records its arguments and answers `mcp list` and `--version`.
    const fake = path.join(dir, 'fake-claude.sh');
    writeFileSync(fake, [
      '#!/bin/sh',
      `echo "$@" >> "${claudeLog}"`,
      'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then',
      '  echo "Checking MCP server health..."',
      '  echo "memory: npx -y @modelcontextprotocol/server-memory - ✔ Connected"',
      '  echo "remote: https://mcp.example.test/mcp (HTTP) - ✗ Failed to connect"',
      '  echo "shared: https://shared.example.test/mcp (HTTP) - ⚠ Needs authentication"',
      '  echo "plugin:figma:figma: https://mcp.figma.test/mcp (HTTP) - ✔ Connected"',
      'fi',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    // On Windows a shell script cannot be the program: the stand-in is a copy of node as claude.exe that runs the same answers.
    const windowsStandIn = posix ? null : standInProgram(path.join(dir, 'bin'), 'claude', [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(claudeLog)}, args.join(' ') + '\\n');`,
      "if (args[0] === '--version') fs.writeSync(1, '9.9.9 (Claude Code)\\n');",
      "else if (args[0] === 'mcp' && args[1] === 'list') fs.writeSync(1, [",
      "  'Checking MCP server health...',",
      "  'memory: npx -y @modelcontextprotocol/server-memory - ✔ Connected',",
      "  'remote: https://mcp.example.test/mcp (HTTP) - ✗ Failed to connect',",
      "  'shared: https://shared.example.test/mcp (HTTP) - ⚠ Needs authentication',",
      "  'plugin:figma:figma: https://mcp.figma.test/mcp (HTTP) - ✔ Connected',",
      "].join('\\n') + '\\n');",
    ].join('\n  '));
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    serverPort = free;
    writeFileSync(path.join(project, 'server.js'), `require('http').createServer((q, r) => r.end('tools demo page')).listen(${serverPort}, '127.0.0.1');\nconsole.log('demo server up');\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(path.join(project, '.vibex.json'), JSON.stringify({ run: { kind: 'web', command: 'node server.js', url: `http://127.0.0.1:${serverPort}` } }));

    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: userData,
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      HOME: home,
      USERPROFILE: home,
      ...(posix ? { VIBEX_CLAUDE_BIN: fake } : { VIBEX_CLAUDE_BIN: windowsStandIn!.file }),
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    if (windowsStandIn) await useStandIn(app, windowsStandIn.env);
    page = await firstWindow(app);
    page.on('console', (message) => {
      const moved = /^vibex activity (agent|browser|shell)$/.exec(message.text());
      if (moved) paneMoves.push(moved[1]);
    });
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    const hook = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest;
      return { token: t.token as string, port: t.status.mcpPort as number };
    });
    token = hook.token;
    appPort = hook.port;
    await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
    await page.waitForSelector('#workspace:not([hidden])');
    projectId = (await page.locator('.tile').first().getAttribute('data-project'))!;
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the Skills section lists this project and every project, and opens a skill as a page', async () => {
    await activity('skills').click();
    const body = page.locator('#sidebar-body');
    await expect(body).toContainText('This project');
    await expect(body).toContainText('Every project');
    await expect(body.locator('.skill-row[data-scope="project"]')).toHaveCount(1);
    await expect(body.locator('.skill-row[data-scope="global"]')).toHaveCount(1);
    await expect(body).toContainText('Checks the ledger of this project');
    await shot('1-skills');
    await expect(body).not.toContainText('Not in this build yet');
    await body.locator('.skill-row[data-skill="ledger-check"]').click();
    const tab = page.locator('#doc-tabs .tab', { hasText: 'ledger-check · SKILL.md' });
    await expect(tab).toBeVisible();
    await expect(page.locator('#doc-view h2', { hasText: 'ledger-check' })).toBeVisible();
    await expect(page.locator('#doc-view li')).toHaveText(['compare totals', 'note gaps']);
    await expect(page.locator('#doc-view pre')).toHaveText('run-me --now');
    await shot('2-skill-page');
    await tab.locator('.close').click();
    await expect(tab).toHaveCount(0);
  });

  test('Remove takes a skill away, Undo brings it back, and the file returns', async () => {
    const body = page.locator('#sidebar-body');
    const row = body.locator('.skill-row[data-skill="ledger-check"]');
    await row.hover();
    await row.getByRole('button', { name: /Remove ledger-check/ }).click();
    await expect(body.locator('.tool-notice')).toContainText('Removed “ledger-check”');
    await expect(row).toHaveCount(0);
    expect(existsSync(path.join(project, '.claude', 'skills', 'ledger-check'))).toBe(false);
    await body.getByRole('button', { name: 'Undo' }).click();
    await expect(row).toHaveCount(1);
    expect(readFileSync(path.join(project, '.claude', 'skills', 'ledger-check', 'SKILL.md'), 'utf8')).toContain('open the ledger');
    await expect(body.locator('.tool-notice')).toHaveCount(0);
  });

  test('the MCP section keeps its status rows and lists the other servers without a secret', async () => {
    await activity('mcp').click();
    const body = page.locator('#sidebar-body');
    await expect(body).toContainText('MCP server');
    await expect(body).toContainText(`Running on 127.0.0.1:${appPort}`);
    await expect(body).toContainText('Key');
    await expect(body).toContainText('Claude Code');
    for (const name of ['memory', 'remote', 'shared']) await expect(body.locator(`.server-row[data-server="${name}"]`)).toHaveCount(1);
    await expect(body.locator('.server-row[data-server="shared"] .chip-small')).toHaveText('.mcp.json');
    await expect(body).not.toContainText('Not in this build yet');
    const html = await body.innerHTML();
    for (const secret of [SECRET_HEADER, SECRET_ENV, SECRET_QUERY]) expect(html).not.toContain(secret);
    expect(html).not.toContain('key=');
    if (!posix) return;
    // The health check ran the stand-in claude program: dots and plain words for what is wrong.
    await expect(body.locator('.server-row[data-server="memory"]')).toHaveAttribute('data-health', 'connected');
    await expect(body.locator('.server-row[data-server="remote"]')).toContainText("Couldn't connect");
    await expect(body.locator('.server-row[data-server="shared"]')).toContainText('Needs sign-in');
    await shot('3-mcp');
    await expect(body.locator('.tool-note.attention')).toContainText('/mcp');
    await expect(body.locator('.server-row[data-server="plugin:figma:figma"]')).toContainText('Plugin');
    expect(await body.locator('.server-row[data-server="plugin:figma:figma"] .row-action').count()).toBe(0);
  });

  test('adding a server shows the exact change first and runs nothing until Add', async () => {
    const body = page.locator('#sidebar-body');
    const before = claudeCalls().filter((l) => l.startsWith('mcp add')).length;
    await body.getByRole('button', { name: 'Add a server' }).click();
    await body.getByLabel('Server name').fill('docs');
    await body.getByLabel('Type of server').selectOption('url');
    await body.getByLabel('Web address').fill('https://docs.example.test/mcp');
    await body.getByRole('button', { name: 'Review…' }).click();
    await expect(body.locator('.confirm-command')).toHaveText('claude mcp add docs https://docs.example.test/mcp --transport http --scope user');
    await shot('4-mcp-add-confirm');
    expect(claudeCalls().filter((l) => l.startsWith('mcp add')).length).toBe(before);
    await body.locator('.confirm-box').getByRole('button', { name: 'Cancel' }).click();
    expect(claudeCalls().filter((l) => l.startsWith('mcp add')).length).toBe(before);
    await body.getByLabel('Web address').fill('https://docs.example.test/mcp');
    await body.getByRole('button', { name: 'Review…' }).click();
    await body.getByRole('button', { name: 'Add server' }).click();
    await expect.poll(() => claudeCalls().filter((l) => l.startsWith('mcp add'))).toEqual(['mcp add docs https://docs.example.test/mcp --transport http --scope user']);
    await expect(body.getByLabel('Server name')).toHaveCount(0);
  });

  test('a bad name is refused in plain words and nothing runs', async () => {
    const body = page.locator('#sidebar-body');
    // Only what changes something: the list of the test before can still be refreshing, and a stand-in on Windows starts slowly.
    const changes = () => claudeCalls().filter((l) => !l.startsWith('mcp list'));
    const before = changes().length;
    await body.getByRole('button', { name: 'Add a server' }).click();
    await body.getByLabel('Server name').fill('--scope');
    await body.getByLabel('Web address').fill('https://x.example.test');
    await body.getByRole('button', { name: 'Review…' }).click();
    await body.getByRole('button', { name: 'Add server' }).click();
    await expect(body.locator('.confirm-box .tools-problem')).toContainText('Use letters, digits');
    expect(changes().length).toBe(before);
    await body.locator('.add-form').getByRole('button', { name: 'Cancel' }).first().click();
  });

  test('removing asks first, names the command, and then runs it', async () => {
    const body = page.locator('#sidebar-body');
    const row = body.locator('.server-row[data-server="memory"]');
    await row.hover();
    await row.getByRole('button', { name: 'Remove memory from Claude Code' }).click();
    await expect(body.locator('.confirm-command')).toHaveText('claude mcp remove memory --scope user');
    expect(claudeCalls().some((l) => l.startsWith('mcp remove'))).toBe(false);
    await body.locator('.confirm-box').getByRole('button', { name: 'Cancel' }).click();
    expect(claudeCalls().some((l) => l.startsWith('mcp remove'))).toBe(false);
    await row.hover();
    await row.getByRole('button', { name: 'Remove memory from Claude Code' }).click();
    await body.locator('.confirm-box').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => claudeCalls().filter((l) => l.startsWith('mcp remove'))).toEqual(['mcp remove memory --scope user']);
  });

  test('Vibex itself cannot be removed or added over', async () => {
    const client = await mcp(projectId);
    await client.close();
    const result = await page.evaluate(() => (window as any).vibex.mod.invoke('mod:mcp:remove', document.querySelector('.tile')!.getAttribute('data-project'), 'vibex', 'user').then(() => 'ran', (e: Error) => e.message));
    expect(result).toContain('manages the vibex server itself');
  });

  test('the Setup tab shows each check with a next step, and installs nothing by itself', async () => {
    await page.locator('#app-menu').click().catch(() => undefined);
    await app.evaluate(({ Menu }) => {
      const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
        for (const i of m?.items ?? []) {
          if (i.label === 'Setup') return i;
          const inner = find(i.submenu ?? null);
          if (inner) return inner;
        }
        return undefined;
      };
      find(Menu.getApplicationMenu())!.click();
    });
    await page.keyboard.press('Escape');
    const tab = page.locator('#doc-tabs .tab', { hasText: 'Setup' });
    await expect(tab).toBeVisible();
    const view = page.locator('#doc-view');
    await expect(view.locator('.setup-row')).toHaveCount(4);
    await expect(view.locator('[data-setup="git"]')).toBeVisible();
    await expect(view.locator('[data-setup="claude"]')).toHaveAttribute('data-status', posix ? 'ready' : /ready|needed/);
    await expect(view.locator('[data-setup-summary]')).toContainText(/\d of 4 ready/);
    await shot('5-setup');
    expect(await view.locator('[data-setup="claude"]').innerText()).toContain(posix ? '9.9.9' : '');
    const typedBefore = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length);
    // Pressing Check again reads, and starts no tab.
    await view.getByRole('button', { name: 'Check again' }).click();
    await expect(view.locator('.setup-row')).toHaveCount(4);
    expect(await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length)).toBe(typedBefore);
    await tab.locator('.close').click();
  });

  test('Run: an unapproved command from .vibex.json is refused to a tool, approved once by a person, then serves the page', async () => {
    const refused = await call('vibex_run');
    expect(refused).toContain('Needs your approval');
    expect(refused).toContain('node server.js');
    expect(await call('vibex_run_status')).toContain('phase: Needs your approval');
    // The person presses Run and says yes to the question.
    await app.evaluate(({ dialog }) => {
      (dialog as any).showMessageBox = async (...args: any[]) => {
        const options = args.at(-1);
        (globalThis as any).__asked = { message: options.message, detail: options.detail };
        return { response: 0, checkboxChecked: false };
      };
    });
    await page.locator('#run-group .run-toggle').click();
    await expect(page.locator('#run-group .run-label')).toHaveText(`127.0.0.1:${serverPort}`, { timeout: 30_000 });
    await expect(page.locator('#run-group .run-toggle')).toHaveAttribute('data-active', 'true');
    const asked = await app.evaluate(() => (globalThis as any).__asked);
    expect(asked.detail).toContain('node server.js');
    // The port line sits under the project's tile.
    await expect(page.locator('.tile .port-line')).toHaveText(`:${serverPort}`);
    await shot('6-run');
    const status = await call('vibex_run_status', { lines: 20 });
    expect(status).toContain('phase: 127.0.0.1:');
    expect(status).toContain('(active)');
    expect(status).toContain('demo server up');
    // The page opened in the side browser.
    await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id)?.state().url ?? '', projectId)).toContain(`127.0.0.1:${serverPort}`);
    // A run tab exists in the command column.
    await expect(page.locator('.terminal-pane[data-pane="shell"] .tab:visible', { hasText: 'Run' })).toHaveCount(1);
  });

  test('Stop ends the server; the tool says so; a second stop says nothing ran', async () => {
    expect(await call('vibex_stop')).toBe('Stopped.');
    await expect(page.locator('#run-group .run-label')).toHaveText('Stopped');
    await expect(page.locator('.tile .port-line')).toHaveCount(0);
    await expect.poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/`);
        return response.status;
      } catch {
        return 'down';
      }
    }, { timeout: 15_000 }).toBe('down');
    expect(await call('vibex_stop')).toBe('Nothing was running.');
  });

  test('now approved, a tool can start the run again', async () => {
    expect(await call('vibex_run')).toContain('Started: node server.js');
    await expect(page.locator('#run-group .run-label')).toHaveText(`127.0.0.1:${serverPort}`, { timeout: 30_000 });
    expect(await call('vibex_stop')).toBe('Stopped.');
  });

  test('a folder with no way to run says so in plain words', async () => {
    const empty = path.join(dir, 'nothing-here');
    mkdirSync(empty);
    await page.evaluate((f) => (window as any).vibex.projects.open(f), empty);
    await expect(page.locator('.tile', { hasText: 'nothing-here' })).toHaveCount(1);
    const client = await mcp();
    const result = await client.callTool({ name: 'vibex_run', arguments: { project_path: empty } });
    await client.close();
    expect(JSON.stringify(result.content)).toContain('Nothing to run');
    expect(JSON.stringify(result.content)).toContain('.vibex.json');
    await page.locator('.tile', { hasText: 'alpha-tools' }).click();
  });

  test('layout, view and focus tools act on the project and say plainly what the Simulator cannot do', async () => {
    const columns = () => page.locator('#workspace').evaluate((e) => (e as HTMLElement).style.gridTemplateColumns);
    // No step of this file hides a pane. A red here names a pane that a key press or a stray click moved (the failure on the
    // shared Mac, review of 2026-10-31); the checks below then say nothing about the layout tool.
    expect(paneMoves).toEqual([]);
    await call('vibex_layout', { mode: 'balanced' });
    const balanced = await columns();
    for (const pane of ['agent', 'browser', 'shell']) await expect(page.locator(`#activity [data-activity="${pane}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await call('vibex_layout', { mode: 'build' })).toContain('Layout: build.');
    await expect.poll(columns).not.toBe(balanced);
    const build = await columns();
    expect(build).toContain('1.7fr');
    await call('vibex_layout', { mode: 'watch' });
    await expect.poll(columns).toContain('1.8fr');
    await call('vibex_layout', { mode: 'balanced' });
    await expect.poll(columns).toBe(balanced);

    expect(await call('vibex_view', { view: 'browser' })).toContain('Showing the browser.');
    expect(await call('vibex_view', { view: 'simulator' })).toContain('only in Vibex on a Mac');
    expect(await call('vibex_view', { view: 'both' })).toContain('only in Vibex on a Mac');
    expect(await call('vibex_focus', { pane: 'simulator' })).toContain('only in Vibex on a Mac');

    expect(await call('vibex_focus', { pane: 'command' })).toContain('Focused.');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.terminal-pane[data-pane="shell"]'))).toBe(true);
    expect(await call('vibex_focus', { pane: 'terminal' })).toContain('Focused.');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.terminal-pane[data-pane="agent"]'))).toBe(true);
  });

  test('the palette opens from its shortcut, finds menu commands by a few letters, and runs one', async () => {
    const press = (keyCode: string, modifiers: string[]) => app.evaluate(({ BrowserWindow }, [key, mods]) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: key as string, modifiers: mods as any });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key as string, modifiers: mods as any });
    }, [keyCode, modifiers] as const);
    await press('P', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
    const palette = page.locator('.palette');
    await expect(palette).toBeVisible();
    await expect(palette).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#palette-input')).toBeFocused();
    const rows = palette.locator('.palette-row');
    expect(await rows.count()).toBeGreaterThan(10);
    // Real commands of the app are there, with their shortcuts.
    await page.locator('#palette-input').fill('nct');
    await expect(rows.first()).toContainText('New Claude Tab');
    await expect(rows.first().locator('.palette-shortcut')).toHaveText(`${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+N`);
    await shot('7-palette');
    await page.locator('#palette-input').fill('run proj');
    await expect(rows.first()).toContainText('Run Project');
    // Escape closes and gives the keyboard back.
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    // Reopen, run "New Terminal Tab" with Enter: a new tab appears in the command column.
    const tabs = () => page.locator('.terminal-pane[data-pane="shell"] .tab:visible').count();
    const before = await tabs();
    await press('P', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
    await page.locator('#palette-input').fill('ntt');
    await expect(rows.first()).toContainText('New Terminal Tab');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect.poll(tabs).toBe(before + 1);
    // Down moves the choice; the listbox says which one.
    await press('P', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
  });

  test('the palette runs a $ command in the command terminal and opens an address', async () => {
    const press = (keyCode: string, modifiers: string[]) => app.evaluate(({ BrowserWindow }, [key, mods]) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: key as string, modifiers: mods as any });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key as string, modifiers: mods as any });
    }, [keyCode, modifiers] as const);
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    await press('P', [mod, 'shift']);
    await page.locator('#palette-input').fill('$ echo palette-shell-ok');
    const rows = page.locator('.palette .palette-row');
    await expect(rows.first()).toContainText('Run in the command terminal: echo palette-shell-ok');
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-pane[data-pane="shell"] .term.active .xterm-rows')).toContainText('palette-shell-ok', { timeout: 20_000 });
    await press('P', [mod, 'shift']);
    await page.locator('#palette-input').fill(`127.0.0.1:${serverPort}/x`);
    await expect(rows.first()).toContainText(`Open 127.0.0.1:${serverPort}/x`);
    await page.keyboard.press('Escape');
  });

  test('the palette lists the other open project and switches to it', async () => {
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    await app.evaluate(({ BrowserWindow }, m) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: [m, 'shift'] as any });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: [m, 'shift'] as any });
    }, mod);
    await page.locator('#palette-input').fill('switch nothing');
    const row = page.locator('.palette .palette-row').first();
    await expect(row).toContainText('Switch to nothing-here');
    await page.keyboard.press('Enter');
    await expect(page.locator('.tile', { hasText: 'nothing-here' })).toHaveAttribute('aria-current', 'true');
    await page.locator('.tile', { hasText: 'alpha-tools' }).click();
  });

  test('the Usage tab and vibex_usage show counts per feature, and nothing about what was asked', async () => {
    await call('vibex_projects');
    await call('browser_navigate', { url: `http://127.0.0.1:${serverPort}/secret-path-for-test` }).catch(() => undefined);
    const table = await call('vibex_usage');
    expect(table).toContain('Vibex usage on this computer');
    expect(table).toMatch(/mcp\.vibex_projects\s+1\s+1/);
    expect(table).toMatch(/mcp\.vibex_run\s+3\s+3/);
    expect(table).toMatch(/ui\.run\.button\s+1\s+1/);
    expect(table).toMatch(/palette\.menu\.new-terminal-tab\s+1\s+1/);
    expect(table).not.toContain('secret-path-for-test');
    expect(table).not.toContain(project);
    await app.evaluate(({ Menu }) => {
      const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
        for (const i of m?.items ?? []) {
          if (i.label === 'Usage') return i;
          const inner = find(i.submenu ?? null);
          if (inner) return inner;
        }
        return undefined;
      };
      find(Menu.getApplicationMenu())!.click();
    });
    const view = page.locator('#doc-view');
    await expect(view.locator('tr[data-feature="mcp.vibex_projects"]')).toBeVisible();
    await expect(view).toContainText('No addresses, commands or names');
    await shot('8-usage');
  });

  test('the page can count only fixed feature names', async () => {
    await page.evaluate(() => {
      const mod = (window as any).vibex.mod;
      mod.send('mod:usage:count', 'ui.fixed.name');
      mod.send('mod:usage:count', 'C:\\Users\\me\\private');
      mod.send('mod:usage:count', 'mcp.fake_tool');
      mod.send('mod:usage:count', { key: 'ui.x' });
    });
    await expect.poll(async () => await call('vibex_usage')).toContain('ui.fixed.name');
    const table = await call('vibex_usage');
    expect(table).not.toContain('private');
    expect(table).not.toContain('mcp.fake_tool');
  });

  test('on quit the counts reach usage.json: counts only, private to the person', async () => {
    await app.close();
    const file = path.join(userData, 'usage.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const text = JSON.stringify(saved);
    expect(Object.values<any>(saved.days)[0]['mcp.vibex_run']).toBeGreaterThanOrEqual(3);
    for (const leak of [project, 'secret-path-for-test', 'server.js', SECRET_ENV, home]) expect(text).not.toContain(leak);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
