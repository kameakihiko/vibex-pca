import { expect, test } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { askpassEnvironment } from '../src/main/askpass';
import { tempDir } from './fixtures';

// The build people install, with its fuses on and its test switches off (H2, M7). Playwright cannot drive it: the fuse
// takes away what Playwright connects through, so these tests start it as a plain process and look from outside.
// They run only with VIBEX_RELEASE_EXECUTABLE set; the tests with VIBEX_APP_EXECUTABLE use the proof build.
const executable = process.env.VIBEX_RELEASE_EXECUTABLE;

test.describe('the release build', () => {
  test.skip(!executable, 'needs VIBEX_RELEASE_EXECUTABLE');

  /// A folder of the app's own, so the person's profile is never touched. On a Mac the stand-in key store: no Keychain.
  const profileArgs = (folder: string) => [`--user-data-dir=${folder}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])];

  async function run(args: string[], env: Record<string, string>, wait: (out: () => string) => Promise<void>) {
    const child = spawn(executable!, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let code: number | null | undefined;
    child.on('exit', (c) => { code = c; });
    try {
      await wait(() => out);
      return { out, code, alive: code === undefined, pid: child.pid! };
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const sleep = (ms: number) => () => new Promise<void>((r) => setTimeout(r, ms));

  let dir: string;
  let config: string;
  test.beforeEach(() => {
    dir = tempDir('vibex-release-');
    config = path.join(dir, 'claude-config');
    mkdirSync(config);
  });
  // Windows keeps the folder locked until the network and gpu processes of a killed app have ended too, a moment after the main one
  // (EPERM in run 41438512187). rmSync retries EPERM by itself with these two options. Only the cleanup waits; no check of the gate does.
  test.afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }));
  const quiet = () => ({ CLAUDE_CONFIG_DIR: config });

  test('the six fuses read as the release needs them', () => {
    const cli = path.join(__dirname, '..', 'node_modules', '@electron', 'fuses', 'dist', 'bin.js');
    const text = execFileSync(process.execPath, [cli, 'read', '--app', executable!], { encoding: 'utf8' }).replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toMatch(/RunAsNode is Disabled/);
    expect(text).toMatch(/EnableNodeCliInspectArguments is Disabled/);
    expect(text).toMatch(/EnableNodeOptionsEnvironmentVariable is Disabled/);
    expect(text).toMatch(/OnlyLoadAppFromAsar is Enabled/);
    expect(text).toMatch(/GrantFileProtocolExtraPrivileges is Disabled/);
    expect(text).toMatch(/EnableEmbeddedAsarIntegrityValidation is Enabled/);
  });

  test('--inspect, NODE_OPTIONS, ELECTRON_RUN_AS_NODE and SIGUSR1 give no inspector', async () => {
    const r = await run(['--inspect=0', ...profileArgs(path.join(dir, 'a'))], { ...quiet(), NODE_OPTIONS: '--inspect=0', ELECTRON_RUN_AS_NODE: '1' }, async () => {
      await sleep(5000)();
    });
    expect(r.out).not.toMatch(/Debugger listening/);
    expect(r.alive, `the app should run as an app; ${r.out}`).toBe(true);
    const usr1 = await run(profileArgs(path.join(dir, 'b')), quiet(), async () => {
      await sleep(4000)();
    }).catch((e) => ({ out: String(e), alive: false, code: 1, pid: 0 }));
    expect(usr1.alive).toBe(true);
    if (process.platform !== 'win32') {
      const child = spawn(executable!, profileArgs(path.join(dir, 'c')), { env: { ...process.env, ...quiet() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stderr.on('data', (d) => { out += d; });
      await sleep(4000)();
      child.kill('SIGUSR1');
      await sleep(2000)();
      expect(out).not.toMatch(/Debugger listening/);
      child.kill();
      await sleep(500)();
    }
  });

  test('a remote debugging port ends the run', async () => {
    const r = await run(['--remote-debugging-port=0', ...profileArgs(path.join(dir, 'a'))], quiet(), sleep(5000));
    expect(r.out).not.toMatch(/DevTools listening/);
    expect(r.alive).toBe(false);
    // 1 is the app's own exit; a kill by the system would prove nothing.
    expect(r.code).toBe(1);
  });

  test('test switches do nothing: the profile stays where the app puts it', async () => {
    const asked = path.join(dir, 'asked-by-switch');
    const real = path.join(dir, 'real');
    mkdirSync(asked);
    const r = await run(profileArgs(real), { ...quiet(), VIBEX_TEST: '1', VIBEX_USER_DATA: asked, VIBEX_TOKEN_STORE: 'memory' }, sleep(5000));
    expect(r.alive).toBe(true);
    // A blank window also stays alive: with the file-privileges fuse off, the window must not load by file://.
    expect(r.out).not.toMatch(/Failed to load URL/);
    expect(readdirSync(asked)).toEqual([]);
    expect(existsSync(path.join(real, 'Local State')) || readdirSync(real).length > 0).toBe(true);
  });

  // ssh takes the first line of what the app prints. On Windows Electron writes a line end first, so ssh runs a native helper
  // there (askpass.ts). If this goes red on Windows, Electron has changed, and the app could answer ssh itself.
  test('as ssh runs it, the app prints the answer; on Windows after a line end', async () => {
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\vibex-gate-${process.pid}` : path.join(dir, 'gate.sock');
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      s.on('data', (chunk) => { if (String(chunk).includes('\n')) s.write('OK\nfrom-the-frame\n'); });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const env = askpassEnvironment({ platform: process.platform === 'win32' ? 'linux' : process.platform, packaged: true, execPath: executable!, wrapper: null, socket, key: 'k' });
      const child = spawn(executable!, ["someone's password:"], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect({ code, out }).toEqual({ code: 0, out: process.platform === 'win32' ? '\r\nfrom-the-frame\n' : 'from-the-frame\n' });
    } finally {
      server.close();
    }
  });

  // Declared on Windows only, not skipped elsewhere: packed-window.spec reads "skipped" in this gate as a fault.
  if (process.platform === 'win32') test('Windows: the askpass helper is in the installed app, as the release asks; it is unsigned like the rest; it answers and it refuses', async () => {
    const { readHelper, report } = require('../scripts/check-askpass-exe.cjs') as { readHelper: (b: Buffer) => { signed: boolean }; report: (f: string) => string[] };
    const helper = path.join(path.dirname(executable!), 'resources', 'vibex-askpass.exe');
    expect(existsSync(helper), helper).toBe(true);
    expect(report(helper)).toEqual([]);
    expect(readHelper(readFileSync(helper)).signed).toBe(false);
    const ask = (socket: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(helper, ["pca@127.0.0.1's password: "], { env: { SystemRoot: process.env.SystemRoot ?? '', VIBEX_ASKPASS_SOCKET: socket, VIBEX_ASKPASS_KEY: 'ab'.repeat(32) }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    const socket = `\\\\.\\pipe\\vibex-gate-helper-${process.pid}`;
    expect(await ask(socket)).toEqual({ code: 1, out: '' });
    const server = net.createServer({ allowHalfOpen: true }, (s) => { s.on('data', (chunk) => { if (String(chunk).includes('\n')) s.end('OK\nfrom-the-frame\n'); }); });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await ask(socket)).toEqual({ code: 0, out: 'from-the-frame\n' });
    } finally {
      server.close();
    }
  });

  test('the code in the package is the release build, with no test code', () => {
    const asar = path.join(path.dirname(executable!), process.platform === 'darwin' ? '../Resources/app.asar' : 'resources/app.asar');
    const { extractFile } = require('@electron/asar') as { extractFile: (a: string, f: string) => Buffer };
    const code = extractFile(asar, path.join('dist', 'app.js')).toString('utf8');
    expect(code).toContain('vibex-build-kind: release');
    expect(code).not.toContain('__vibexTest');
    expect(code).not.toContain('VIBEX_AGENT_COMMAND');
    expect(extractFile(asar, path.join('dist', 'main.js')).toString('utf8')).not.toContain('__playwright_run');
  });
});
