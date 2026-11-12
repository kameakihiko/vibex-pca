import { expect, test } from '@playwright/test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startSshServer, tempDir } from './fixtures';
import { commit, createBranch, diffOf, gitStatus, log, showCommit, stage, switchBranch } from '../src/main/git';
import { appFileFor } from '../src/main/appPage';
import { hostKeyFailureText, hostKeyVerdict, PCA_HOST_KEY_FINGERPRINT, PCA_HOST_KEY_LINE, pinnedHostOptions, setHostKeyFolder } from '../src/main/pcaHostKey';
import { PCA_PROFILE } from '../src/main/pcaEdition';
import { EXAMPLE_SITE } from '../src/main/site';
import { findProgram, programPath } from '../src/main/programs';
import { sshLaunch } from '../src/main/servers';
import { isForward, serverMayOpen } from '../src/main/serverGuard';

// No app window: the third security review's fixes in git, the address rule and the program lookup.

test.describe('N3, N10, L6: what a folder can make git do', () => {
  let dir: string;
  let repo: string;
  let witness: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'empty-config') } });
  /// A program that leaves a mark. A folder's config names it; it must never run.
  const program = () => {
    const file = path.join(dir, 'evil.sh');
    writeFileSync(file, `#!/bin/sh\necho ran >> '${witness}'\nexit 1\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const ran = () => existsSync(witness);

  test.beforeEach(() => {
    dir = tempDir('vibex-sec3-');
    repo = path.join(dir, 'repo');
    witness = path.join(dir, 'witness');
    mkdirSync(repo);
    writeFileSync(path.join(dir, 'empty-config'), '');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'first');
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('N3: gpg.program with log.showSignature is refused, and the program does not run on a log or a show', async () => {
    const hash = git('rev-parse', 'HEAD').trim();
    git('config', 'log.showSignature', 'true');
    // The signed-commit part of the attack needs a real signature object; a plain witness on the same setting shows the path.
    for (const key of ['gpg.program', 'gpg.ssh.program', 'gpg.x509.program']) {
      git('config', key, program());
      await expect(log(repo, 5), key).rejects.toThrow(/can run a program/);
      await expect(showCommit(repo, hash), key).rejects.toThrow(/can run a program/);
      git('config', '--unset', key);
    }
    expect(ran()).toBe(false);
  });

  test('N3: log.showSignature is off for a read: a signed commit runs no program on a log or a show, with a witness on plain git', async () => {
    // The program comes from the person's own settings here, so the refusal does not hide what -c does.
    const config = path.join(dir, 'person-config');
    // Forward slashes: a backslash in a git config file starts an escape.
    writeFileSync(config, `[gpg]\n\tprogram = ${program().replace(/\\/g, '/')}\n[log]\n\tshowSignature = true\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      // A commit with a signature block by hand: a real signature is not needed for git to ask the program about it.
      const tree = git('rev-parse', 'HEAD^{tree}').trim();
      const raw = `tree ${tree}\nauthor T <t@example.invalid> 1 +0000\ncommitter T <t@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\nsigned\n`;
      const hash = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: raw, encoding: 'utf8' }).trim();
      git('update-ref', 'refs/heads/main', hash);
      await log(repo, 5);
      await showCommit(repo, hash);
      expect(ran(), 'the app ran the program').toBe(false);
      execFileSync('git', ['log', '-n1'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: config }, stdio: 'pipe' });
      expect(ran(), 'plain git runs it: the test has a witness').toBe(true);
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  test('N3: a stage or a commit is refused as well when the folder names a program', async () => {
    git('config', 'gpg.program', program());
    git('config', 'commit.gpgSign', 'true');
    writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    await expect(stage(repo, ['b.txt'])).rejects.toThrow(/can run a program/);
    git('add', 'b.txt');
    await expect(commit(repo, 'second')).rejects.toThrow(/can run a program/);
    expect(ran()).toBe(false);
  });

  test('N10: the folder\'s Git hooks do not run on Commit, Switch Branch or New Branch, and the status says they are skipped', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout']) {
      writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ran >> '${witness}'\n`);
      chmodSync(path.join(hooks, name), 0o755);
    }
    const status = await gitStatus(repo);
    expect(status.repo && status.hooksSkipped).toBe(true);
    writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    await stage(repo, ['b.txt']);
    await commit(repo, 'second');
    await createBranch(repo, 'other');
    await switchBranch(repo, 'main');
    expect(ran()).toBe(false);
    expect(git('log', '-1', '--format=%s').trim()).toBe('second');
  });

  test('N10: core.hooksPath from the folder does not run either, and a folder with no hook has no note', async () => {
    const plain = await gitStatus(repo);
    expect(plain.repo && plain.hooksSkipped).toBe(false);
    const hooks = path.join(repo, 'myhooks');
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho ran >> '${witness}'\n`);
    chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    git('config', 'core.hooksPath', hooks);
    const status = await gitStatus(repo);
    expect(status.repo && status.hooksSkipped).toBe(true);
    writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    await stage(repo, ['b.txt']);
    await commit(repo, 'second');
    expect(ran()).toBe(false);
  });

  test('L6: an untracked link shows no text of the file it points at', async () => {
    const secret = path.join(dir, 'made-up-secret.txt');
    writeFileSync(secret, 'MADE-UP-SECRET\n');
    symlinkSync(secret, path.join(repo, 'link.txt'));
    const patch = await diffOf(repo, { path: 'link.txt', area: 'unstaged', kind: 'untracked' });
    expect(patch.text).not.toContain('MADE-UP-SECRET');
    expect(patch.text).toContain('link');
  });

  test('L6: a file reached through a linked folder is refused too', async () => {
    const outside = path.join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'f.txt'), 'MADE-UP-SECRET\n');
    symlinkSync(outside, path.join(repo, 'linked'));
    const patch = await diffOf(repo, { path: 'linked/f.txt', area: 'unstaged', kind: 'untracked' });
    expect(patch.text).not.toContain('MADE-UP-SECRET');
  });

  test('L6: an ordinary new file still shows its text', async () => {
    writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
    expect((await diffOf(repo, { path: 'new.txt', area: 'unstaged', kind: 'untracked' })).text).toContain('+hello');
  });
});

test.describe('N6: the forward rule reads a parsed address', () => {
  test('credentials before the host never count as a forward', () => {
    expect(isForward('http://127.0.0.1:41000/', [41000])).toBe(true);
    expect(isForward('ws://127.0.0.1:41000/x', [41000])).toBe(true);
    expect(isForward('http://127.0.0.1:41000@rebind.example.com/', [41000])).toBe(false);
    expect(isForward('http://127.0.0.1:41000@rebind.example.com:41000/', [41000])).toBe(false);
    expect(isForward('http://user:pw@127.0.0.1:41000/', [41000])).toBe(false);
    expect(isForward('http://127.0.0.1:41001/', [41000])).toBe(false);
    expect(isForward('not an address', [41000])).toBe(false);
  });

  test('an address with credentials is refused for Claude on a server', () => {
    expect(serverMayOpen('http://127.0.0.1:41000@rebind.example.com/', [41000])).toBe(false);
    expect(serverMayOpen('https://user:pw@example.com/', [])).toBe(false);
    expect(serverMayOpen('https://user@example.com/', [])).toBe(false);
    expect(serverMayOpen('https://example.com/', [])).toBe(true);
  });
});

test.describe('N12: a missing program starts nothing', () => {
  test('programPath throws in plain words, and gives no path for a person to place a file at', () => {
    const before = process.env.PATH;
    process.env.PATH = '/nonexistent-vibex-folder';
    try {
      expect(() => programPath('git')).toThrow(/git was not found on this computer/);
    } finally {
      process.env.PATH = before;
    }
  });

  test('a found program is still its absolute path', () => {
    expect(findProgram('git', { platform: 'linux', pathValue: 'rel:/usr/bin', isFile: (f) => f === '/usr/bin/git' })).toBe('/usr/bin/git');
    expect(spawnSync(programPath('git'), ['--version']).status).toBe(0);
  });
});

test.describe('N7: the PCA host key is pinned', () => {
  let dir: string;
  test.beforeEach(() => { dir = tempDir('vibex-pin-'); });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the key of the site values has the fingerprint beside it, and the install steps say who gives the fingerprint', () => {
    // The repository holds a made-up key (src/main/site.ts). A release build holds the real one, from the site file.
    expect(PCA_HOST_KEY_FINGERPRINT).toBe(EXAMPLE_SITE.hostKeyFingerprint);
    const blob = Buffer.from(PCA_HOST_KEY_LINE.split(' ')[2], 'base64');
    expect(`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`).toBe(PCA_HOST_KEY_FINGERPRINT);
    expect(PCA_HOST_KEY_LINE.startsWith(`${PCA_PROFILE.host} ssh-ed25519 `)).toBe(true);
    expect(readFileSync(path.join(__dirname, '..', 'INSTALL-WINDOWS.md'), 'utf8')).toMatch(/person who manages the team can give you the fingerprint/);
  });

  test('every ssh to the PCA address uses the pinned file and never asks; another server keeps the person\'s own', () => {
    setHostKeyFolder(dir);
    const args = sshLaunch({ name: 'PCA', host: PCA_PROFILE.host, user: 'made-up', port: 22, options: { UserKnownHostsFile: '/tmp/other', StrictHostKeyChecking: 'no' } }).args;
    const options = args.flatMap((a, i) => (args[i - 1] === '-o' ? [a] : []));
    const first = (key: string) => options.find((o) => o.startsWith(`${key}=`));
    // ssh keeps the first value it reads, so the pin comes before the profile's own options.
    expect(first('StrictHostKeyChecking')).toBe('StrictHostKeyChecking=yes');
    expect(first('UserKnownHostsFile')).toContain('pca_known_hosts');
    expect(readFileSync(path.join(dir, 'pca_known_hosts'), 'utf8').trim()).toBe(PCA_HOST_KEY_LINE);
    expect(sshLaunch({ name: 'x', host: '192.0.2.10', user: 'made-up' }).args.join(' ')).not.toContain('pca_known_hosts');
    expect(sshLaunch({ name: 'x', host: PCA_PROFILE.host, user: 'made-up', port: 2222 }).args.join(' ')).not.toContain('pca_known_hosts');
  });

  test('a folder with a space or a percent sign stays one option', () => {
    const value = pinnedHostOptions('/home/a b/100%/pca_known_hosts').find((o) => o.startsWith('UserKnownHostsFile='));
    expect(value).toBe('UserKnownHostsFile="/home/a b/100%%/pca_known_hosts"');
  });

  test('a real ssh: the matching key goes on to the login, a changed key is refused with no question, and the person\'s known_hosts stays out of it', async () => {
    const server = await startSshServer(dir);
    try {
      // The server lives in this process, so ssh runs without blocking it.
      const ssh = (options: string[]) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const base = ['-F', 'none', '-p', String(server.port), '-i', server.keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', ...options, '--', 'pca@127.0.0.1', 'true'];
        execFile('ssh', base, { timeout: 20_000, env: { ...process.env, HOME: dir } }, (error, _out, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr) }));
      });
      // One plain login makes ssh write the server's real key in the form it reads.
      await ssh(['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${server.knownHosts}`]);
      const before = server.logins();
      const known = readFileSync(server.knownHosts, 'utf8').trim().split('\n')[0];
      const key = known.split(' ').slice(1, 3).join(' ');
      const run = (pinFile: string) => ssh(pinnedHostOptions(pinFile));
      const good = path.join(dir, 'good');
      writeFileSync(good, `${PCA_PROFILE.host} ${key}\n`);
      const ok = await run(good);
      expect(ok.stderr).not.toMatch(/host key verification failed/i);
      expect(server.logins()).toBeGreaterThan(before);
      const logins = server.logins();
      const changed = path.join(dir, 'changed');
      writeFileSync(changed, `${PCA_HOST_KEY_LINE}\n`);
      const refused = await run(changed);
      expect(refused.status).toBe(255);
      expect(refused.stderr).toMatch(/host key verification failed/i);
      expect(server.logins()).toBe(logins);
      expect(existsSync(path.join(dir, '.ssh', 'known_hosts'))).toBe(false);
      expect(hostKeyFailureText('PCA', refused.stderr)).toMatch(/different host key/);
      expect(hostKeyFailureText('PCA', 'Permission denied')).toBeNull();
    } finally {
      server.close();
    }
  });

  test('a question from ssh about this address: only the pinned fingerprint passes', () => {
    const ask = (host: string, fp: string) => `The authenticity of host '${host} (${host})' can't be established.\nED25519 key fingerprint is ${fp}.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?`;
    expect(hostKeyVerdict(ask(PCA_PROFILE.host, PCA_HOST_KEY_FINGERPRINT))).toBe('match');
    expect(hostKeyVerdict(ask(PCA_PROFILE.host, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBe('changed');
    expect(hostKeyVerdict(ask('192.0.2.10', 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBeNull();
    expect(hostKeyVerdict(`Host key for ${PCA_PROFILE.host} has changed`)).toBe('changed');
    expect(hostKeyVerdict(ask(`1${PCA_PROFILE.host}`, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBeNull();
  });
});

test.describe('N14: the managed settings sample', () => {
  test('it holds the keys the README names, and only keys from the settings reference', () => {
    const sample = JSON.parse(readFileSync(path.join(__dirname, '..', 'pca', 'managed-settings.json'), 'utf8'));
    expect(sample.disableAutoMode).toBe('disable');
    expect(sample.permissions.disableBypassPermissionsMode).toBe('disable');
    for (const rule of ['Read(**/.env)', 'Read(**/.env.*)', 'Read(~/.ssh/**)']) expect(sample.permissions.deny).toContain(rule);
    const readme = readFileSync(path.join(__dirname, '..', 'pca', 'README.md'), 'utf8');
    for (const key of ['disableAutoMode', 'permissions.deny', 'forceLoginMethod']) expect(readme).toContain(key);
    expect(readme).toContain('code.claude.com/docs/en/settings-reference');
  });
});

test.describe('N2: the app window has its own address', () => {
  test('only the files of the window are served, whatever the path says', () => {
    for (const [url, file] of [
      ['vibex-app://app/index.html', 'index.html'],
      ['vibex-app://app/renderer.js', 'renderer.js'],
      ['vibex-app://app/style.css', 'style.css'],
      ['vibex-app://app/fonts/GoogleSans.ttf', 'fonts/GoogleSans.ttf'],
      ['vibex-app://app/index.html?x=1#y', 'index.html'],
    ]) expect(appFileFor(url), url).toBe(file);
    for (const url of ['vibex-app://app/main.js', 'vibex-app://app/app.js', 'vibex-app://app/preload.js', 'vibex-app://app/../package.json', 'vibex-app://app/%2e%2e/package.json', 'vibex-app://app/fonts/..%2fapp.js', 'vibex-app://other/index.html', 'file:///etc/hosts', 'http://app/index.html', 'nonsense']) {
      expect(appFileFor(url), url).toBeNull();
    }
  });

  test('each file the window asks for is in the list', () => {
    const html = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    const css = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');
    const asked = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g), ...css.matchAll(/url\(["']?([^"')]+)/g)].map((m) => m[1].replace(/^\.\//, '')).filter((f) => !f.startsWith('data:'));
    expect(asked.length).toBeGreaterThan(3);
    for (const file of asked) expect(appFileFor(`vibex-app://app/${file}`), file).toBe(file);
  });
});
