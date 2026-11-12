import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { firstWindow, tempDir } from './fixtures';

// Self-update on a real Windows, from the installer people get to the app that runs after it. scripts/update-proof-windows.sh
// builds two PROOF builds, 9.9.1 and 9.9.2, whose feed is http://127.0.0.1:8765/, signs with a made-up key, and starts this.
// Not exercised here: the release build, the owner's key and the real feed. A release takes neither the key nor the address.

const KEY = process.env.VIBEX_UPDATE_TEST_KEY;
const proof = process.env.VIBEX_UPDATE_PROOF_DIR;
const PORT = 8765;

test.describe('self-update on Windows', () => {
  test.skip(!KEY || !proof || process.platform !== 'win32', 'needs scripts/update-proof-windows.sh on Windows');
  test.describe.configure({ mode: 'serial' });
  // One install, two refused feeds, and one real update with its restart.
  test.setTimeout(600_000);

  const installed = () => path.join(process.env.LOCALAPPDATA!, 'Programs', 'Vibex PCA');
  const exe = () => path.join(installed(), 'Vibex PCA.exe');
  const installedVersion = () => {
    const { extractFile } = require('@electron/asar') as { extractFile: (a: string, f: string) => Buffer };
    return JSON.parse(extractFile(path.join(installed(), 'resources', 'app.asar'), 'package.json').toString('utf8')).version as string;
  };
  /// What Windows itself says of the program file.
  const fileVersion = () => execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe()}').VersionInfo.FileVersion`], { encoding: 'utf8', windowsHide: true }).trim();

  let server: http.Server | null = null;
  function serve(folder: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        const name = path.basename(new URL(request.url!, 'http://x').pathname);
        const file = path.join(folder, name);
        if (!existsSync(file)) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file));
      });
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', () => {
        expect((server!.address() as AddressInfo).port).toBe(PORT);
        resolve();
      });
    });
  }
  const stopServing = () => new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
    server = null;
  });

  let work: string;
  let app: ElectronApplication;
  let page: Page;

  async function launch(name: string): Promise<void> {
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_UPDATE_TEST_KEY: KEY!,
      VIBEX_USER_DATA: path.join(work, `${name}-data`),
      VIBEX_MCP_PORT: '0',
      VIBEX_CLAUDE_MISSING: '1',
      VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
      CLAUDE_CONFIG_DIR: path.join(work, `${name}-claude`),
    } as Record<string, string>;
    app = await electron.launch({ executablePath: exe(), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  }
  const invoke = (channel: string) => page.evaluate((c) => (window as any).vibex.mod.invoke(c), channel);
  const state = async () => (await invoke('mod:update:state')) as { state: { kind: string; message?: string; version?: string }; version: string; text: string };

  /// A feed folder from the 9.9.2 build: the installer, and a yml the given change makes.
  function feedFolder(name: string, change: (yml: string) => string, signer: string): string {
    const folder = path.join(work, name);
    mkdirSync(folder, { recursive: true });
    const source = path.join(proof!, '9.9.2');
    cpSync(path.join(source, 'Vibex-PCA-9.9.2-win-x64.exe'), path.join(folder, 'Vibex-PCA-9.9.2-win-x64.exe'));
    const yml = path.join(folder, 'latest.yml');
    writeFileSync(yml, change(readFileSync(path.join(source, 'latest.yml'), 'utf8')));
    execFileSync(process.execPath, ['scripts/update-release.mjs', 'sign', signer, yml], { cwd: path.join(__dirname, '..') });
    return folder;
  }

  test.beforeAll(() => {
    work = tempDir('vibex-update-win-');
    rmSync(installed(), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    execFileSync(path.join(proof!, '9.9.1', 'Vibex-PCA-9.9.1-win-x64.exe'), ['/S'], { stdio: 'inherit', windowsHide: true });
  });

  test.afterEach(async () => {
    await stopServing();
  });

  test.afterAll(() => {
    try {
      execFileSync('taskkill', ['/F', '/IM', 'Vibex PCA.exe'], { stdio: 'ignore' });
    } catch {
      // Nothing was running.
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  test('the older build installs with no question, per user, in the person\'s own folder', async () => {
    await expect.poll(() => existsSync(exe()), { timeout: 60_000 }).toBe(true);
    expect(installedVersion()).toBe('9.9.1');
    expect(exe().startsWith(process.env.LOCALAPPDATA!)).toBe(true);
    expect(fileVersion()).toMatch(/^9\.9\.1/);
  });

  test('a feed signed by another key downloads nothing, says why, and the app stays as it was', async () => {
    await serve(feedFolder('forged', (yml) => yml, path.join(proof!, 'other-key.pem')));
    await launch('forged');
    await invoke('mod:update:check');
    await expect.poll(async () => (await state()).state.kind, { timeout: 60_000 }).toBe('failed');
    expect((await state()).text).toMatch(/no valid signature/);
    await expect(page.locator('#update-now')).toHaveCount(0);
    await app.close();
    await new Promise((r) => setTimeout(r, 15_000));
    expect(installedVersion()).toBe('9.9.1');
    expect(fileVersion()).toMatch(/^9\.9\.1/);
  });

  test('a signed feed with a wrong hash fails its check, and the app stays as it was', async () => {
    await serve(feedFolder('bad-hash', (yml) => yml.replace(/sha512: \S+/g, 'sha512: AAAA'), path.join(proof!, 'made-up-key.pem')));
    await launch('bad-hash');
    await invoke('mod:update:check');
    await expect.poll(async () => (await state()).state.kind, { timeout: 180_000, intervals: [2000] }).toBe('failed');
    expect((await state()).text).toMatch(/failed its check/);
    await expect(page.locator('#update-now')).toHaveCount(0);
    await app.close();
    await new Promise((r) => setTimeout(r, 15_000));
    expect(installedVersion()).toBe('9.9.1');
    expect(fileVersion()).toMatch(/^9\.9\.1/);
  });

  test('a good feed: it downloads by itself, one button restarts it with a tab running, and the new version runs', async () => {
    await serve(feedFolder('good', (yml) => yml, path.join(proof!, 'made-up-key.pem')));
    await launch('good');
    // A real tab with a program that does not end: nothing it holds may block the install.
    const project = path.join(work, 'project');
    mkdirSync(project, { recursive: true });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
    await expect(page.locator('.terminal-pane[data-pane="shell"] .tab')).toHaveCount(1);
    const id = await page.evaluate(async () => (await (window as any).vibex.term.list()).find((t: any) => t.pane === 'shell' && t.alive).id);
    await page.evaluate((i) => (window as any).vibex.term.input(i, 'ping -t 127.0.0.1\r'), id);
    await expect.poll(() => page.evaluate((i) => (window as any).vibex.term.buffer(i), id), { timeout: 30_000 }).toContain('127.0.0.1');

    // The timed first check, 10 s after the start: no person asks.
    const button = page.locator('#update-now');
    await expect(button).toBeVisible({ timeout: 180_000 });
    expect((await state()).state).toEqual({ kind: 'ready', version: '9.9.2' });

    // The quit question for running tabs is a system dialog, which no test can press: Restart.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any; });
    const closed = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await button.click();
    await closed;

    // With no question and no window: the installer runs silently, and it replaces the files.
    await expect.poll(() => { try { return installedVersion(); } catch { return 'in the middle of the install'; } }, { timeout: 240_000, intervals: [3000] }).toBe('9.9.2');
    await expect.poll(fileVersion, { timeout: 60_000, intervals: [2000] }).toMatch(/^9\.9\.2/);

    // The app that started after the install says its own version: the proof build writes it at each start.
    const seen = path.join(process.env.APPDATA!, 'Vibex PCA', 'last-run-version.txt');
    await expect.poll(() => (existsSync(seen) ? readFileSync(seen, 'utf8').trim() : 'no file yet'), { timeout: 120_000, intervals: [2000] }).toBe('9.9.2');
  });
});
