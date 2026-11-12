import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installPack, listPack, makeLoginKey, managedSettingsTarget, PCA_PROFILE, personFolder, pickedKey, profileOffer, validPersonKey } from '../src/main/pcaEdition';
import { isValid } from '../src/main/servers';
import { firstWindow, standInProgram, tempDir } from './fixtures';

// The PCA edition: the server offer, the skills pack, the managed settings sample, and the files that ship them.
// Made-up folders only. Nothing here reaches a server or the person's own Claude folder.

const root = path.join(__dirname, '..');
const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = tempDir(prefix); made.push(d); return d; };
const write = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const skill = (dir: string, name: string, body = `---\nname: ${name}\ndescription: Made up.\n---\nBody of ${name}.\n`) => write(path.join(dir, name, 'SKILL.md'), body);

test.describe('the PCA server offer', () => {
  test('the profile holds the shared login user and key login, and no key or folder of anyone', () => {
    expect(PCA_PROFILE).toEqual({ name: 'PCA', host: '203.0.113.20', port: 22, user: 'pca', authentication: 'key', allowClaude: true, confirmCommands: true });
    for (const key of ['identityFile', 'password', 'projectPath']) expect(PCA_PROFILE).not.toHaveProperty(key);
  });

  test('the key name is the owner\'s word: the exact shape, and the folder comes only from it', () => {
    for (const good of ['ab', 'test-ali', 'a1-b2', `a${'b'.repeat(30)}`]) expect(validPersonKey(good), good).toBe(true);
    for (const bad of ['', 'a', 'A1', '1a', '-ab', 'a b', 'a/b', '../x', 'a.b', 'a\nb', `a${'b'.repeat(31)}`]) expect(validPersonKey(bad), bad).toBe(false);
    expect(personFolder('test-ali')).toBe('/srv/pca/people/test-ali');
    expect(() => personFolder('../root')).toThrow(/key name/);
    expect(isValid({ name: 'PCA', host: 'x', user: 'pca', projectPath: personFolder('test-ali') })).toBe(true);
  });

  test('making a key creates the missing .ssh folder (the failure on a real PC), and the one .pub line comes back', async () => {
    const home = temp('vibex-home-');
    expect(existsSync(path.join(home, '.ssh'))).toBe(false);
    const made = await makeLoginKey(home, 'test-ali');
    expect(made.file).toBe(path.join(home, '.ssh', 'pca_ed25519'));
    expect(made.line).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ pca-test-ali$/);
    expect(made.line.includes('\n')).toBe(false);
    expect(readFileSync(`${made.file}.pub`, 'utf8').trim()).toBe(made.line);
    expect(readFileSync(made.file, 'utf8')).toContain('PRIVATE KEY');
    if (process.platform !== 'win32') expect(statSync(path.join(home, '.ssh')).mode & 0o077).toBe(0);
  });

  test('a key that is there is never replaced: a second make gives the same line', async () => {
    const home = temp('vibex-home-');
    const first = await makeLoginKey(home, 'test-ali');
    const bytes = readFileSync(first.file, 'utf8');
    const second = await makeLoginKey(home, 'test-ali');
    expect(second.line).toBe(first.line);
    expect(readFileSync(first.file, 'utf8')).toBe(bytes);
  });

  test('making a key refuses a key name that is not the owner\'s shape, before it writes anything', async () => {
    const home = temp('vibex-home-');
    await expect(makeLoginKey(home, '-oProxyCommand=x')).rejects.toThrow(/key name/);
    expect(existsSync(path.join(home, '.ssh'))).toBe(false);
  });

  test('picking a key: ed25519 only, by either file of the pair, and the private file stays unread', async () => {
    const home = temp('vibex-home-');
    const made = await makeLoginKey(home, 'test-ali');
    expect(pickedKey(made.file)).toEqual(made);
    expect(pickedKey(`${made.file}.pub`)).toEqual(made);
    const rsa = path.join(home, 'old_key');
    writeFileSync(rsa, 'made-up');
    writeFileSync(`${rsa}.pub`, 'ssh-rsa AAAAB3NzaC1yc2E me\n');
    expect(() => pickedKey(rsa)).toThrow(/ed25519/);
    const lone = path.join(home, 'lone_key');
    writeFileSync(lone, 'made-up');
    expect(() => pickedKey(lone)).toThrow(/\.pub/);
    const pubOnly = path.join(home, 'pub_only');
    writeFileSync(`${pubOnly}.pub`, 'ssh-ed25519 AAAA me\n');
    expect(() => pickedKey(`${pubOnly}.pub`)).toThrow(/private/);
    // Two lines are no key line: what the person copies is one line.
    const two = path.join(home, 'two_lines');
    writeFileSync(two, 'made-up');
    writeFileSync(`${two}.pub`, 'ssh-ed25519 AAAA me\nssh-ed25519 BBBB you\n');
    expect(() => pickedKey(two)).toThrow(/one line/);
  });

  test('it is offered while no saved server is the PCA host; a file it cannot read is not ours to touch', () => {
    const dir = temp('vibex-offer-');
    const file = path.join(dir, 'servers.json');
    expect(profileOffer(file)).toEqual(PCA_PROFILE);
    for (const text of ['{ not json', '{"a":1}', '"text"', 'null']) {
      writeFileSync(file, text);
      expect(profileOffer(file), text).toBeNull();
    }
    const other = { name: 'Test', host: 'server.example.invalid', port: 22, user: 'me' };
    for (const list of [[], [other], [other, null, 'x', { host: 7 }]]) {
      writeFileSync(file, JSON.stringify(list));
      expect(profileOffer(file), JSON.stringify(list)).toEqual(PCA_PROFILE);
    }
    for (const host of [PCA_PROFILE.host, PCA_PROFILE.host.toUpperCase()]) {
      writeFileSync(file, JSON.stringify([other, { name: 'Named by the person', host, port: 22, user: 'pca' }]));
      expect(profileOffer(file), host).toBeNull();
    }
  });

  test('two makes at the same moment are one action: one key, both get its line, and no false word about OpenSSH', async () => {
    const home = temp('vibex-key-twice-');
    const [a, b] = await Promise.all([makeLoginKey(home, 'test-ali'), makeLoginKey(home, 'test-ali')]);
    expect(a.line).toMatch(/^ssh-ed25519 /);
    expect(b.line).toBe(a.line);
    expect(readFileSync(path.join(home, '.ssh', 'pca_ed25519.pub'), 'utf8').trim()).toBe(a.line);
  });

  test('two makes at the same moment start one ssh-keygen', async () => {
    test.skip(process.platform === 'win32', 'a shell stand-in; the action is the same code on each system');
    const bin = temp('vibex-keygen-once-');
    const count = path.join(bin, 'count');
    writeFileSync(path.join(bin, 'ssh-keygen'), `#!/bin/sh\necho started >> '${count}'\n/bin/sleep 0.3\nfor last; do :; done\nprintf 'ssh-ed25519 AAAA made-up\\n' > "$last.pub"\n: > "$last"\n`, { mode: 0o755 });
    const before = process.env.PATH;
    try {
      process.env.PATH = bin;
      const home = temp('vibex-key-once-');
      const [a, b] = await Promise.all([makeLoginKey(home, 'test-ali'), makeLoginKey(home, 'test-ali')]);
      expect(b.line).toBe(a.line);
      expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      process.env.PATH = before;
    }
  });

  test('only a missing ssh-keygen says to install OpenSSH; another failure says what it was', async () => {
    const bin = temp('vibex-keygen-');
    const before = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
    try {
      if (process.platform === 'win32') {
        // A copy of node under that name: it refuses ssh-keygen's switches by itself, and says so on stderr.
        standInProgram(bin, 'ssh-keygen', '');
      } else {
        writeFileSync(path.join(bin, 'ssh-keygen'), '#!/bin/sh\necho "made-up refusal: no room" >&2\nexit 1\n', { mode: 0o755 });
      }
      process.env.PATH = bin;
      const failed = await makeLoginKey(temp('vibex-key-fail-'), 'test-ali').catch((error: Error) => error.message);
      expect(failed).not.toMatch(/Install the OpenSSH/);
      expect(failed).toMatch(process.platform === 'win32' ? /could not make the key: .*bad option/ : /could not make the key: made-up refusal/);
      process.env.PATH = temp('vibex-key-empty-');
      const missing = await makeLoginKey(temp('vibex-key-none-'), 'test-ali').catch((error: Error) => error.message);
      expect(missing).toMatch(/Install the OpenSSH/);
    } finally {
      process.env.PATH = before.PATH;
      if (before.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = before.NODE_OPTIONS;
    }
  });
});

test.describe('the skills pack', () => {
  test('lists the folders that hold a SKILL.md, by name', () => {
    const pack = temp('vibex-pack-');
    skill(pack, 'beta');
    skill(pack, 'alpha');
    mkdirSync(path.join(pack, 'empty'));
    write(path.join(pack, 'stray.txt'), 'x');
    expect(listPack(pack)).toEqual(['alpha', 'beta']);
    expect(listPack(path.join(pack, 'missing'))).toEqual([]);
  });

  test('installs what is missing, skips a name that exists and keeps it, and a second run changes nothing', () => {
    const pack = temp('vibex-pack-');
    const target = path.join(temp('vibex-claude-'), 'skills');
    skill(pack, 'alpha');
    skill(pack, 'beta');
    write(path.join(pack, 'beta', 'extra', 'notes.md'), 'more');
    skill(target, 'alpha', 'my own alpha\n');
    const first = installPack(pack, target);
    expect(first).toEqual({ installed: ['beta'], skipped: ['alpha'] });
    expect(readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8')).toBe('my own alpha\n');
    expect(readFileSync(path.join(target, 'beta', 'extra', 'notes.md'), 'utf8')).toBe('more');
    write(path.join(target, 'beta', 'SKILL.md'), 'edited by the person\n');
    const second = installPack(pack, target);
    expect(second).toEqual({ installed: [], skipped: ['alpha', 'beta'] });
    expect(readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8')).toBe('edited by the person\n');
    expect(readdirSync(target).sort()).toEqual(['alpha', 'beta']);
  });

  test('a link or a broken link under the same name counts as there', () => {
    const pack = temp('vibex-pack-');
    const target = path.join(temp('vibex-claude-'), 'skills');
    skill(pack, 'alpha');
    mkdirSync(target, { recursive: true });
    try {
      symlinkSync(path.join(target, 'nowhere'), path.join(target, 'alpha'));
    } catch (error) {
      // A link needs a right on Windows (Developer Mode or an admin account). Without it, this test has nothing to try.
      test.skip((error as NodeJS.ErrnoException).code === 'EPERM', 'this account has no right to make links');
      throw error;
    }
    expect(installPack(pack, target)).toEqual({ installed: [], skipped: ['alpha'] });
    expect(lstatSync(path.join(target, 'alpha')).isSymbolicLink()).toBe(true);
  });

  test('the shipped pack has the two skills, each with a name that matches its folder and a description', () => {
    const names = listPack(path.join(root, 'pca', 'skills'));
    expect(names).toEqual(expect.arrayContaining(['linear-end-of-session', 'pca-memory-and-notes']));
    for (const name of names) {
      const text = readFileSync(path.join(root, 'pca', 'skills', name, 'SKILL.md'), 'utf8');
      expect(text, name).toMatch(new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
      expect(text, name).toMatch(/\ndescription: \S/);
      // No contact, key or address of a person in a skill.
      expect(text, name).not.toMatch(/@\w+|sk-ant|\b\d{6,}\b|password\s*[:=]/i);
    }
  });
});

test.describe('the managed settings sample', () => {
  const sample = JSON.parse(readFileSync(path.join(root, 'pca', 'managed-settings.json'), 'utf8'));
  const readme = readFileSync(path.join(root, 'pca', 'README.md'), 'utf8');
  // Keys we can name from Claude Code's documented settings; a key outside this list is not shipped.
  const KNOWN = ['permissions', 'disableAutoMode', 'forceLoginMethod', 'env'];

  test('uses only keys that are known, and the README explains each one', () => {
    for (const key of Object.keys(sample)) {
      expect(KNOWN, key).toContain(key);
      expect(readme, key).toMatch(new RegExp(`\`${key}[\`.]`));
    }
    for (const key of Object.keys(sample.permissions)) expect(readme, key).toContain(`\`permissions.${key}\``);
    for (const key of Object.keys(sample.env)) expect(readme, key).toContain(`\`env.${key}\``);
  });

  test('holds no secret, no address, no user name', () => {
    expect(JSON.stringify(sample)).not.toMatch(/sk-ant|https?:\/\/|@|token|password/i);
  });

  test('the target file is the one Claude Code reads on each system', () => {
    expect(managedSettingsTarget('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
    expect(managedSettingsTarget('linux')).toBe('/etc/claude-code/managed-settings.json');
    expect(managedSettingsTarget('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
  });
});

test.describe('what ships', () => {
  const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
  const pkg = JSON.parse(read('package.json'));

  test('a plain release version, and the description no longer says proof build', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.description).not.toMatch(/proof build/i);
  });

  test('electron-builder ships the pca folder next to the app', () => {
    const yml = read('electron-builder.yml');
    expect(yml).toMatch(/- from: pca\n\s+to: pca\n/);
    expect(yml).toContain('dist/**');
    expect(pkg.main).toBe('dist/main.js');
  });

  test('the workflow runs only on pull requests to main, tags and manual dispatch', () => {
    const wf = readFileSync(path.join(root, '..', '.github', 'workflows', 'vibex-pca.yml'), 'utf8');
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    expect(on).toMatch(/pull_request:\n\s+branches: \[main\]/);
    expect(on).toContain('workflow_dispatch');
    expect(on).toMatch(/push:\n\s+tags: \['vibex-pca-v\*'\]/);
    // No push of a branch starts it: a pull request, a tag or a person does.
    expect(on).not.toMatch(/push:\n\s+branches:/);
    expect(on.match(/^ {2}\w+:/gm)).toEqual(['  pull_request:', '  push:', '  workflow_dispatch:']);
    if (/macos/i.test(wf)) expect(wf).toContain('CSC_IDENTITY_AUTO_DISCOVERY');
    expect(wf).toContain('CSC_IDENTITY_AUTO_DISCOVERY');
  });

  test('the README says what the edition is, and what is left out', () => {
    const top = read('README.md').slice(0, 6000);
    expect(top).not.toMatch(/proof build/i);
    for (const word of ['Simulator', 'Design', 'Install', 'unproven', 'Windows']) expect(top, word).toContain(word);
  });

  test('the install page is there, with the SmartScreen step and what to send back', () => {
    const page = read('INSTALL-WINDOWS.md');
    for (const word of ['SmartScreen', 'More info', 'Run anyway', 'Git', 'Claude Code', 'Send back']) expect(page, word).toContain(word);
  });
});

test.describe('in the app', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let userData: string;
  let claudeDir: string;
  let home: string;

  async function launch(): Promise<void> {
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: userData,
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      VIBEX_CLAUDE_MISSING: '1',
      CLAUDE_CONFIG_DIR: claudeDir,
      // A made-up home: a key made in a test never goes in the person's own folder.
      HOME: home,
      USERPROFILE: home,
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: root, env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    const folder = path.join(dir, 'project');
    mkdirSync(folder, { recursive: true });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), folder);
    await page.waitForSelector('#workspace:not([hidden])');
  }

  /// The activity button toggles the sidebar, and the app remembers it open across a restart.
  async function openServers(): Promise<void> {
    const button = page.locator('#activity [data-activity="servers"]');
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
    await expect(page.locator('#sidebar-body .sv-head').last()).toBeVisible();
  }

  test.beforeAll(() => {
    dir = temp('vibex-edition-');
    userData = path.join(dir, 'data');
    home = path.join(dir, 'home');
    mkdirSync(home);
    claudeDir = path.join(dir, 'claude-config');
    mkdirSync(userData);
  });
  test.afterAll(async () => { await app?.close(); });

  test('1. with no servers.json the Servers section offers PCA; the form asks for the key name and a login key, shows the one line, and Save uses the normal path', async () => {
    await launch();
    await openServers();
    const offer = page.locator('[data-pca-offer]');
    await expect(offer).toBeVisible();
    expect(existsSync(path.join(userData, 'servers.json'))).toBe(false);
    await offer.getByRole('button', { name: 'Add the PCA server' }).click();
    await expect(page.locator('#sf-name')).toHaveValue(PCA_PROFILE.name);
    await expect(page.locator('#sf-host')).toHaveValue(PCA_PROFILE.host);
    await expect(page.locator('#sf-port')).toHaveValue(String(PCA_PROFILE.port));
    await expect(page.locator('#sf-allow')).toBeChecked();
    await expect(page.locator('#sf-confirm')).toBeChecked();
    await expect(page.locator('#sf-user')).toHaveValue('pca');
    await expect(page.locator('#sf-login')).toHaveValue('key');
    // Nothing is guessed: no folder until the owner's key name is typed.
    await expect(page.locator('#sf-path')).toHaveValue('');
    await expect(page.locator('#sf-person-key')).toHaveValue('');
    await page.locator('#sf-save').click();
    await expect(page.locator('#sf-error')).toContainText('key name');
    expect(existsSync(path.join(userData, 'servers.json'))).toBe(false);
    await page.locator('#sf-person-key').fill('Not Valid');
    await expect(page.locator('#sf-path')).toHaveValue('');
    await page.locator('#sf-person-key').fill('test-ali');
    await expect(page.locator('#sf-path')).toHaveValue('/srv/pca/people/test-ali');
    await page.locator('#sf-save').click();
    await expect(page.locator('#sf-error')).toContainText('login key');
    expect(existsSync(path.join(userData, 'servers.json'))).toBe(false);
    // Make a key: the .ssh folder of this test's home does not exist yet.
    expect(existsSync(path.join(home, '.ssh'))).toBe(false);
    await page.locator('#sf-make-key').click();
    const line = page.locator('#sf-pub-line');
    await expect(line).toContainText('ssh-ed25519 ');
    const keyFile = path.join(home, '.ssh', 'pca_ed25519');
    expect(readFileSync(`${keyFile}.pub`, 'utf8').trim()).toBe((await line.textContent())!.trim());
    await expect(page.locator('#sf-key')).toHaveValue(keyFile);
    await expect(page.locator('#server-form')).not.toContainText('PRIVATE');
    await page.locator('#sf-pub-copy').click();
    await expect(page.locator('#sf-pub-note')).toContainText('Copied');
    await page.locator('#sf-save').click();
    await expect(page.locator('#server-form')).toHaveCount(0);
    const saved = JSON.parse(readFileSync(path.join(userData, 'servers.json'), 'utf8'));
    expect(saved).toEqual([{ ...PCA_PROFILE, identityFile: keyFile, projectPath: '/srv/pca/people/test-ali' }]);
    await expect(page.locator('[data-pca-offer]')).toHaveCount(0);
  });

  test('2. a restart with the file there offers nothing', async () => {
    await app.close();
    await launch();
    await openServers();
    await expect(page.locator('.sv-row', { hasText: 'PCA' })).toBeVisible();
    await expect(page.locator('[data-pca-offer]')).toHaveCount(0);
  });

  test('3. a servers.json that cannot be read gets no offer and is never overwritten', async () => {
    await app.close();
    writeFileSync(path.join(userData, 'servers.json'), '{ not json');
    await launch();
    await openServers();
    await expect(page.locator('.sv-problem').first()).toBeVisible();
    await expect(page.locator('[data-pca-offer]')).toHaveCount(0);
    expect(readFileSync(path.join(userData, 'servers.json'), 'utf8')).toBe('{ not json');
  });

  test('4. Setup has a PCA skills row: Install copies the pack, skips what is there and says so, and a second click changes nothing', async () => {
    await page.locator('#mcp-chip').click();
    const view = page.locator('#doc-view');
    const row = view.locator('[data-setup-extra="pca-skills"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('0 of');
    const skills = path.join(claudeDir, 'skills');
    expect(existsSync(skills)).toBe(false);
    // The person already has a skill of the same name as one in the pack.
    write(path.join(skills, 'pca-memory-and-notes', 'SKILL.md'), 'mine\n');
    await row.getByRole('button', { name: 'Install' }).click();
    const message = view.locator('[data-pca-skills-message]');
    await expect(message).toContainText('Installed');
    await expect(message).toContainText('pca-memory-and-notes');
    await expect(message).toContainText('already');
    expect(readFileSync(path.join(skills, 'pca-memory-and-notes', 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(skills, 'linear-end-of-session', 'SKILL.md'))).toBe(true);
    const before = readdirSync(skills).sort();
    await row.getByRole('button', { name: 'Install' }).click();
    await expect(message).toContainText('Nothing changed');
    expect(readdirSync(skills).sort()).toEqual(before);
  });

  test('5. Setup explains the managed settings and installs nothing', async () => {
    const row = page.locator('#doc-view [data-setup-extra="managed-settings"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText(managedSettingsTarget(process.platform));
    await expect(row).toContainText('administrator');
    await expect(row.getByRole('button', { name: 'Install' })).toHaveCount(0);
  });

  // Last, because this spec is serial and a failure hides what follows.
  test('6. a servers.json with another server still offers PCA, and a double click on Make a Key is one action', async () => {
    await app.close();
    const other = { name: 'Test', host: 'server.example.invalid', port: 22, user: 'me' };
    writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([other]));
    rmSync(path.join(home, '.ssh'), { recursive: true, force: true });
    await launch();
    await openServers();
    const offer = page.locator('[data-pca-offer]');
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Add the PCA server' }).click();
    await page.locator('#sf-person-key').fill('test-ali');
    await page.locator('#sf-make-key').dblclick();
    await expect(page.locator('#sf-pub-line')).toContainText('ssh-ed25519 ');
    await expect(page.locator('#sf-key-problem')).toHaveText('');
    await expect(page.locator('#sf-make-key')).toBeEnabled();
    expect(readFileSync(path.join(home, '.ssh', 'pca_ed25519.pub'), 'utf8').trim()).toBe((await page.locator('#sf-pub-line').textContent())!.trim());
    await page.locator('#sf-save').click();
    await expect(page.locator('#server-form')).toHaveCount(0);
    expect(JSON.parse(readFileSync(path.join(userData, 'servers.json'), 'utf8'))).toHaveLength(2);
    await expect(page.locator('[data-pca-offer]')).toHaveCount(0);
  });
});
