import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './fixtures';
import { electronDir, keyPair, linuxRelease, windowsRelease } from './releaseFixture';
import { feedAllows, isNewer, offReason, stateText, UpdateFlow, type UpdateState } from '../src/main/updateFlow';
import { FeedRefused, feedFileName, PINNED_UPDATE_PUBLIC_KEY, sameRelease, signedEngine, verifyFeedSignature } from '../src/main/updateSign';

// No app window: signed updates (security review N1), the release gate (N4), and each key is made up in this test.

/// The public half of the owner's release key. The private half is on his Mac only; no test reads it.
const OWNER_PUBLIC_KEY = '0kgKWEIBvSGf8ZH5ZDsSX6SNeC76zhnpBzejfJC2QI0=';

const YML = Buffer.from(`version: 9.9.2
files:
  - url: Vibex-PCA-9.9.2-win-x64.exe
    sha512: AAAA
    size: 10
path: Vibex-PCA-9.9.2-win-x64.exe
sha512: AAAA
releaseDate: '2026-10-31T00:00:00.000Z'
`);
const INFO = { version: '9.9.2', files: [{ url: 'Vibex-PCA-9.9.2-win-x64.exe', sha512: 'AAAA', size: 10 }], path: 'Vibex-PCA-9.9.2-win-x64.exe', sha512: 'AAAA', releaseDate: '2026-10-31T00:00:00.000Z' };

test.describe('N1: the feed must carry a good signature', () => {
  const good = keyPair();
  const other = keyPair();

  test('the signature check takes only the pinned key and these exact bytes', () => {
    expect(verifyFeedSignature(YML, good.signText(YML), good.raw)).toBe(true);
    expect(verifyFeedSignature(Buffer.concat([YML, Buffer.from('\n')]), good.signText(YML), good.raw)).toBe(false);
    expect(verifyFeedSignature(YML, other.signText(YML), good.raw)).toBe(false);
    for (const bad of [null, '', 'AAAA', 'not base64 !!', good.signText(YML).slice(0, 40)]) expect(verifyFeedSignature(YML, bad, good.raw), String(bad)).toBe(false);
    for (const key of ['', 'AAAA', 'x'.repeat(44)]) expect(verifyFeedSignature(YML, good.signText(YML), key), key).toBe(false);
  });

  function engine(files: Record<string, Buffer | null>, info: unknown = INFO, key = good.raw) {
    const log: string[] = [];
    return {
      log,
      engine: signedEngine({
        publicKey: key,
        fileName: 'latest.yml',
        retryMs: 0,
        fetchFile: async (name) => { log.push(`fetch ${name}`); return files[name] ?? null; },
        check: async () => { log.push('check'); return { available: true, info }; },
        download: async () => { log.push('download'); },
      }),
    };
  }
  const sig = (data: Buffer, who = good) => Buffer.from(who.signText(data));

  test('a good signature goes on to the library, and only then to a download', async () => {
    const { engine: e, log } = engine({ 'latest.yml': YML, 'latest.yml.sig': sig(YML) });
    expect(await e.latest()).toBe('9.9.2');
    await e.download(() => undefined);
    expect(log).toEqual(['fetch latest.yml', 'fetch latest.yml.sig', 'check', 'download']);
  });

  for (const [name, files] of [
    ['no signature file', { 'latest.yml': YML, 'latest.yml.sig': null }],
    ['a signature by another key', { 'latest.yml': YML, 'latest.yml.sig': sig(YML, other) }],
    ['a yml changed after signing', { 'latest.yml': Buffer.from(YML.toString().replace('AAAA', 'BBBB')), 'latest.yml.sig': sig(YML) }],
  ] as [string, Record<string, Buffer | null>][]) {
    test(`${name}: nothing downloads and the library is not asked`, async () => {
      const { engine: e, log } = engine(files);
      await expect(e.latest()).rejects.toBeInstanceOf(FeedRefused);
      await expect(e.download(() => undefined)).rejects.toBeInstanceOf(FeedRefused);
      expect(log).not.toContain('check');
      expect(log).not.toContain('download');
    });
  }

  test('a second answer to the library that differs from the signed one is refused (the feed changes between two reads)', async () => {
    const swapped = { ...INFO, sha512: 'BBBB', files: [{ ...INFO.files[0], sha512: 'BBBB' }] };
    const { engine: e, log } = engine({ 'latest.yml': YML, 'latest.yml.sig': sig(YML) }, swapped);
    await expect(e.latest()).rejects.toBeInstanceOf(FeedRefused);
    await expect(e.download(() => undefined)).rejects.toBeInstanceOf(FeedRefused);
    expect(log).not.toContain('download');
    expect(sameRelease(YML, INFO)).toBe(true);
    expect(sameRelease(YML, { ...INFO, isAdminRightsRequired: true })).toBe(false);
    expect(sameRelease(Buffer.from('{{{'), INFO)).toBe(false);
  });

  test('no yml on the feed is no alarm: nothing to refuse, and nothing downloads', async () => {
    const { engine: e, log } = engine({});
    await expect(e.latest()).rejects.not.toBeInstanceOf(FeedRefused);
    expect(log).toEqual(['fetch latest.yml']);
  });

  test('the Setup row says it plainly, also for a timed check nobody asked for', async () => {
    const seen: UpdateState[] = [];
    const { engine: e, log } = engine({ 'latest.yml': YML, 'latest.yml.sig': null });
    const flow = new UpdateFlow(e, '0.9.0', (s) => seen.push(s));
    await flow.check(false);
    expect(flow.state.kind).toBe('failed');
    expect(stateText(flow.state, '0.9.0')).toMatch(/signature/);
    expect(stateText(flow.state, '0.9.0')).toMatch(/nothing was downloaded/i);
    expect(log).not.toContain('download');
  });

  test('an offline person still hears nothing on a timed check', async () => {
    const flow = new UpdateFlow({ latest: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); }, download: async () => undefined }, '0.9.0', () => undefined);
    await flow.check(false);
    expect(flow.state.kind).toBe('idle');
  });

  test('with no pinned key a release does not update itself at all', () => {
    const can = { packaged: true, platform: 'win32', testRun: false, appImage: false, linuxPackage: false, feedFile: true };
    expect(offReason({ ...can, updateKey: true })).toBeNull();
    expect(offReason({ ...can, updateKey: false })).toMatch(/no update key/);
    expect(offReason({ ...can, platform: 'linux', appImage: true, updateKey: false })).toMatch(/no update key/);
  });

  test('the source pins the owner\'s public key, and no other', () => {
    expect(PINNED_UPDATE_PUBLIC_KEY).toBe(OWNER_PUBLIC_KEY);
    expect(execFileSync(process.execPath, ['scripts/update-release.mjs', 'pinned'], { cwd: electronDir, encoding: 'utf8' }).trim()).toBe(OWNER_PUBLIC_KEY);
  });

  test('a yml and a signature caught in the middle of a swap: it reads once more, and then the pair passes', async () => {
    const newYml = Buffer.from(YML.toString().replace('2026-10-31', '2026-11-01'));
    const reads: string[] = [];
    let round = 0;
    const e = signedEngine({
      publicKey: good.raw,
      fileName: 'latest.yml',
      retryMs: 0,
      // The first yml is the old one, and its signature the new one. The second read finds the new pair.
      fetchFile: async (name) => {
        reads.push(name);
        if (name === 'latest.yml') return round++ === 0 ? YML : newYml;
        return sig(newYml);
      },
      check: async () => ({ available: true, info: { ...INFO, releaseDate: '2026-11-01T00:00:00.000Z' } }),
      download: async () => undefined,
    });
    expect(await e.latest()).toBe('9.9.2');
    expect(reads).toEqual(['latest.yml', 'latest.yml.sig', 'latest.yml', 'latest.yml.sig']);
  });

  test('a .deb install hears that it does not update itself, and what it can do', () => {
    const line = offReason({ packaged: true, platform: 'linux', testRun: false, appImage: false, linuxPackage: true, feedFile: true, updateKey: true })!;
    expect(line).toMatch(/does not update itself/);
    expect(line).toMatch(/newer \.deb/);
    expect(line).toMatch(/AppImage/);
    expect(offReason({ packaged: true, platform: 'linux', testRun: false, appImage: true, linuxPackage: false, feedFile: true, updateKey: true })).toBeNull();
  });

  test('Restart to Update is silent on Windows and starts the app again; a quit installs it silently too', () => {
    const code = readFileSync(path.join(electronDir, 'src', 'main', 'updater.ts'), 'utf8');
    expect(code).toContain('autoUpdater.quitAndInstall(true, true)');
    expect(code).toContain('autoUpdater.autoInstallOnAppQuit = true');
    const yml = readFileSync(path.join(electronDir, 'electron-builder.yml'), 'utf8');
    // Per user: the installer never asks for admin rights, and it writes where the person can write.
    expect(yml).toMatch(/^ {2}perMachine: false$/m);
  });

  test('a test key reaches only a proof build: the release takes the pinned one, whatever the environment says', () => {
    const code = readFileSync(path.join(electronDir, 'src', 'main', 'updater.ts'), 'utf8');
    expect(code).toContain("testEnv('VIBEX_UPDATE_TEST_KEY') ?? PINNED_UPDATE_PUBLIC_KEY");
  });

  test('the yml name is the one the library asks for', () => {
    expect(feedFileName('win32', 'x64')).toBe('latest.yml');
    expect(feedFileName('linux', 'x64')).toBe('latest-linux.yml');
    expect(feedFileName('linux', 'arm64')).toBe('latest-linux-arm64.yml');
  });
});

test.describe('N9: only a proof build may use a feed over HTTP on this machine', () => {
  test('a release refuses HTTP, and any other origin', () => {
    expect(feedAllows('http://127.0.0.1:8765/', 'http://127.0.0.1:8765/latest.yml', false)).toBe(false);
    expect(feedAllows('http://127.0.0.1:8765/', 'http://127.0.0.1:8765/latest.yml', true)).toBe(true);
    expect(feedAllows('https://pca.example.invalid/f/', 'https://pca.example.invalid/f/latest.yml', false)).toBe(true);
    expect(feedAllows('https://pca.example.invalid/f/', 'https://other.example.invalid/f/latest.yml', true)).toBe(false);
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
  });
});

test.describe('N2, N3, N4: publish-update.sh is the choke point, and it judges the files that ship', () => {
  let dir: string;
  let keyFile: string;
  let release: string;
  const key = keyPair();

  /// A release folder as the hosted job's two artifacts hold it.
  async function build(o: Partial<Parameters<typeof linuxRelease>[2]> = {}) {
    const options = { pinned: key.raw, ...o };
    await windowsRelease(release, dir, options);
    await linuxRelease(release, dir, options);
  }
  const publish = (env: Record<string, string> = {}) => spawnSync('bash', ['scripts/publish-update.sh', release], { cwd: electronDir, encoding: 'utf8', env: { ...process.env, VIBEX_UPDATE_KEY_FILE: keyFile, ...env } });

  test.beforeEach(() => {
    dir = tempDir('vibex-publish-');
    release = path.join(dir, 'release');
    keyFile = path.join(dir, 'made-up-key.pem');
    mkdirSync(release);
    writeFileSync(keyFile, key.pem, { mode: 0o600 });
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a release with its fuses, its feed and the pinned key passes, signs both ymls, and uploads nothing with no --go', async () => {
    await build();
    const r = publish();
    expect(r.stdout + r.stderr, r.stdout + r.stderr).toContain('Dry run');
    expect(r.status).toBe(0);
    for (const name of ['latest.yml', 'latest-linux.yml']) {
      const yml = readFileSync(path.join(release, name));
      expect(verifyFeedSignature(yml, readFileSync(path.join(release, `${name}.sig`), 'utf8'), key.raw)).toBe(true);
      expect(r.stdout).toContain(`${name}.sig`);
    }
    expect(r.stdout).toContain('.deb');
    expect(r.stdout).toContain('.exe.blockmap');
    expect(r.stdout).not.toContain('appimage-gate');
  });

  test('N2: the artifact alone is enough: no win-unpacked folder is needed or read', async () => {
    await build();
    expect(existsSync(path.join(release, 'win-unpacked'))).toBe(false);
    expect(publish().status).toBe(0);
  });

  test('N3: an old installer with a new unpacked folder is refused, because the gate reads the installer', async () => {
    const options = { pinned: key.raw, kind: 'proof' };
    await windowsRelease(release, dir, options);
    // A good folder beside it, as a person could leave one, must change nothing.
    const good = path.join(release, 'win-unpacked', 'resources');
    mkdirSync(good, { recursive: true });
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/proof build/);
    expect(existsSync(path.join(release, 'latest.yml.sig'))).toBe(false);
  });

  test('N3: what was taken out of the AppImage must come from this AppImage', async () => {
    await build();
    writeFileSync(path.join(release, 'Vibex-PCA-9.9.2-linux-x86_64.AppImage'), 'other  AppImage!');
    // The yml agrees with the new file, so only the mark of the taken-out files can show it.
    const yml = readFileSync(path.join(release, 'latest-linux.yml'), 'utf8');
    const sha = require('node:crypto').createHash('sha512').update('other  AppImage!').digest('base64');
    const first = /sha512: (\S+)/.exec(yml)![1];
    writeFileSync(path.join(release, 'latest-linux.yml'), yml.split(first).join(sha));
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/not taken out of this AppImage/);
  });

  test('N3: a .deb that holds other code than the AppImage is refused', async () => {
    await linuxRelease(release, dir, { pinned: key.raw }, { extra: 'const other = 1;' });
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/\.deb and the AppImage hold different code/);
  });

  for (const [name, options, why] of [
    ['no asar integrity list', { integrity: 'none' }, /no asar integrity list/],
    ['an asar integrity list for another asar', { integrity: 'wrong' }, /asar integrity/],
    ['no password helper', { helper: 'none' }, /vibex-askpass\.exe/],
    ['a console helper', { helper: 'console' }, /vibex-askpass\.exe.*console/],
    ['no ConPTY files', { conpty: false }, /conpty/],
  ] as [string, Parameters<typeof windowsRelease>[2], RegExp][]) {
    test(`Windows: ${name} is refused, and nothing is signed`, async () => {
      await windowsRelease(release, dir, { ...options, pinned: key.raw });
      const r = publish();
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stdout).toMatch(why);
      expect(existsSync(path.join(release, 'latest.yml.sig'))).toBe(false);
    });
  }

  test('an installer that asks for admin rights is refused: an update must not raise a UAC question', async () => {
    await windowsRelease(release, dir, { pinned: key.raw });
    const yml = path.join(release, 'latest.yml');
    writeFileSync(yml, `${readFileSync(yml, 'utf8')}isAdminRightsRequired: true\n`);
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/admin rights/);
  });

  test('a file name in a yml that a shell could read as more than a name is refused', async () => {
    await windowsRelease(release, dir, { pinned: key.raw });
    const yml = path.join(release, 'latest.yml');
    writeFileSync(yml, readFileSync(yml, 'utf8').replace(/url: \S+/, 'url: a;reboot.exe'));
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/file name/);
  });

  const refusals: [string, Parameters<typeof build>[0], RegExp][] = [
    ['a proof build', { kind: 'proof' }, /proof build/],
    ['a build for tests', { kind: 'dev' }, /not a release build/],
    ['hook code left in the bundle', { extra: 'globalThis.__vibexTest = 1;' }, /test code/],
    ['a switch left in the bundle', { extra: 'x("VIBEX_AGENT_COMMAND");' }, /test code/],
    ['the inspector fuse on', { fuses: { 3: '1' } }, /EnableNodeCliInspectArguments/],
    ['asar integrity off', { fuses: { 4: '0' } }, /EnableEmbeddedAsarIntegrityValidation/],
    ['file privileges on', { fuses: { 7: '1' } }, /GrantFileProtocolExtraPrivileges/],
    ['another feed in the build', { feed: 'http://127.0.0.1:8765/' }, /address/],
    ['no pinned key in the app', { pinned: '' }, /does not hold this key/],
    ['a build with a key other than the signing key', { pinned: keyPair().raw }, /does not hold this key/],
  ];
  for (const [name, options, why] of refusals) {
    test(`${name} is refused, and nothing is signed`, async () => {
      await build(options);
      const r = publish();
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(why);
      expect(existsSync(path.join(release, 'latest.yml.sig'))).toBe(false);
      expect(existsSync(path.join(release, 'latest-linux.yml.sig'))).toBe(false);
    });
  }

  test('an installer that does not match the yml is refused', async () => {
    await build();
    writeFileSync(path.join(release, 'Vibex-PCA-9.9.2-win-x64.exe'), 'another file');
    const r = publish();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/SHA-512/);
  });

  test('no signing key: a plain refusal with the next step', async () => {
    await build();
    const r = publish({ VIBEX_UPDATE_KEY_FILE: path.join(dir, 'absent.pem') });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/no signing key/i);
    expect(r.stdout + r.stderr).toContain('make-update-key.sh');
  });

  test('a signing key inside the repository is refused', async () => {
    await build();
    const inside = path.join(electronDir, 'scripts', 'made-up-key-test.pem');
    writeFileSync(inside, key.pem, { mode: 0o600 });
    try {
      const r = publish({ VIBEX_UPDATE_KEY_FILE: inside });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/outside the repository/);
    } finally {
      rmSync(inside, { force: true });
    }
  });

  test('make-update-key.sh prints the steps and makes nothing, and with --make it refuses the repository and an existing file', () => {
    const steps = spawnSync('bash', ['scripts/make-update-key.sh'], { cwd: electronDir, encoding: 'utf8' });
    expect(steps.status).toBe(0);
    expect(steps.stdout).toContain('PINNED_UPDATE_PUBLIC_KEY');
    const made = path.join(dir, 'new-key.pem');
    const first = spawnSync('bash', ['scripts/make-update-key.sh', '--make', made], { cwd: electronDir, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).not.toContain('PRIVATE');
    const raw = /PINNED_UPDATE_PUBLIC_KEY = '([A-Za-z0-9+/=]{44})'/.exec(first.stdout)?.[1];
    expect(raw).toBeTruthy();
    expect(spawnSync('bash', ['scripts/make-update-key.sh', '--make', made], { cwd: electronDir, encoding: 'utf8' }).status).not.toBe(0);
    const inside = path.join(electronDir, 'scripts', 'never.pem');
    expect(spawnSync('bash', ['scripts/make-update-key.sh', '--make', inside], { cwd: electronDir, encoding: 'utf8' }).status).not.toBe(0);
    expect(existsSync(inside)).toBe(false);
    // The pair works together.
    const signed = execFileSync(process.execPath, ['scripts/update-release.mjs', 'public-key', made], { cwd: electronDir, encoding: 'utf8' }).trim();
    expect(signed).toBe(raw);
  });
});

test.describe('N4, N5: the build kinds', () => {
  let dir: string;
  test.beforeAll(() => {
    dir = tempDir('vibex-bundle-');
    execFileSync(process.execPath, ['build.mjs', '--release', `--out=${dir}`], { cwd: electronDir, stdio: 'pipe' });
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /// Every switch named in the source; a new one is checked with no change here.
  const switchNames = () => {
    const names = new Set<string>();
    for (const file of require('node:fs').readdirSync(path.join(electronDir, 'src', 'main'))) {
      for (const m of readFileSync(path.join(electronDir, 'src', 'main', file), 'utf8').matchAll(/testEnv\('([A-Z0-9_]+)'\)/g)) names.add(m[1]);
    }
    return [...names];
  };

  test('the release bundle holds no test hook and no test switch', () => {
    const names = switchNames();
    expect(names.length).toBeGreaterThan(5);
    for (const bundle of ['main.js', 'app.js', 'preload.js', 'renderer.js']) {
      const code = readFileSync(path.join(dir, bundle), 'utf8');
      for (const word of ['__vibexTest', 'testHooks', 'hubTestHooks', 'testQuestion', 'askOnClose', 'agentTabAnswer', 'testEnv', 'isTestRun', 'VIBEX_TEST', ...names]) expect(code.includes(word), `${bundle}: ${word}`).toBe(false);
    }
  });

  test('the release bundle holds the owner\'s key, and the switch for a test key is gone', () => {
    const code = readFileSync(path.join(dir, 'app.js'), 'utf8');
    expect(code).toContain(`"${OWNER_PUBLIC_KEY}"`);
    expect(code).not.toContain('VIBEX_UPDATE_TEST_KEY');
  });

  test('the release bundle names its kind and refuses a debugging port with no look at the file name', () => {
    const main = readFileSync(path.join(dir, 'main.js'), 'utf8');
    expect(main).toContain('vibex-build-kind: release');
    expect(main).toContain('remote-debugging-port');
    expect(main).not.toMatch(/isPackaged\s*&&/);
  });

  test('a plain electron-builder run packs the release build whatever dist/ holds', () => {
    const yml = readFileSync(path.join(electronDir, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^beforePack: scripts\/pack-release\.cjs$/m);
    const pkg = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
    expect(pkg.scripts['dist:proof']).toContain('--config.beforePack=scripts/pack-proof.cjs');
    expect(pkg.scripts['dist:proof']).toContain('--config.appId=uz.pca.vibex.proof');
  });

  test('the fuses in electron-builder.yml: file privileges off, asar integrity on', () => {
    const yml = readFileSync(path.join(electronDir, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^ {2}grantFileProtocolExtraPrivileges: false$/m);
    expect(yml).toMatch(/^ {2}enableEmbeddedAsarIntegrityValidation: true$/m);
  });
});

// electron-builder lists a .deb twice in latest-linux.yml, and the upload moves each name once: the second move failed the first real publish.
test('feed-files names each file once, as a real latest-linux.yml with its .deb twice', () => {
  const dir = tempDir('vibex-feed-files-');
  try {
    const sha = Buffer.alloc(64, 1).toString('base64');
    const entry = (name: string) => `  - url: ${name}\n    sha512: ${sha}\n    size: 10\n`;
    const yml = path.join(dir, 'latest-linux.yml');
    writeFileSync(yml, `version: 9.9.2\nfiles:\n${entry('Vibex-PCA-9.9.2-linux-x86_64.AppImage')}${entry('Vibex-PCA-9.9.2-linux-amd64.deb')}${entry('Vibex-PCA-9.9.2-linux-amd64.deb')}path: Vibex-PCA-9.9.2-linux-x86_64.AppImage\nsha512: ${sha}\nreleaseDate: '2026-11-03T00:00:00.000Z'\n`);
    const r = spawnSync(process.execPath, ['scripts/update-release.mjs', 'feed-files', yml], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim().split('\n')).toEqual(['Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'Vibex-PCA-9.9.2-linux-amd64.deb']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
