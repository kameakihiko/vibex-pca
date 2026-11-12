import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { firstWindow, tempDir } from './fixtures';

// A packaged app with the release's off runAsNode fuse, as the proof build has it (the release build cannot be driven).
// It runs only with VIBEX_APP_EXECUTABLE. On Linux node-pty's kill does not fork, so the windows_ part of W1 runs only on a Windows runner.
const executable = process.env.VIBEX_APP_EXECUTABLE;

test.describe('the packaged app', () => {
  test.skip(!executable, 'needs VIBEX_APP_EXECUTABLE');
  test.describe.configure({ mode: 'serial' });

  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let log: string;

  test.beforeAll(async () => {
    dir = realpathSync.native(tempDir('vibex-smoke-'));
    const data = path.join(dir, 'data');
    log = path.join(data, 'vibex-errors.log');
    mkdirSync(path.join(dir, 'alpha'));
    const env = { ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: data, VIBEX_MCP_PORT: '0', VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK', CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config') } as Record<string, string>;
    app = await electron.launch({ executablePath: executable!, env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.evaluate((f) => (window as any).vibex.projects.open(f), path.join(dir, 'alpha'));
    await expect(page.locator('.terminal-pane[data-pane="shell"] .tab')).toHaveCount(1);
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the fuse is off here: fork refuses, as it does in what people install', async () => {
    const text = await app.evaluate(() => {
      try {
        (process as any).getBuiltinModule('node:child_process').fork('/no-such-file');
        return 'fork ran';
      } catch (error) {
        return String(error);
      }
    });
    expect(text).toMatch(/runAsNode fuse/);
  });

  test('closing a live tab leaves no fault, and the app goes on', async () => {
    const tabs = () => page.evaluate(async () => (await (window as any).vibex.term.list()).filter((t: any) => t.pane === 'shell' && t.alive).length);
    const id = await page.evaluate(async () => (await (window as any).vibex.term.list()).find((t: any) => t.pane === 'shell' && t.alive).id);
    await expect.poll(() => page.evaluate((i) => (window as any).vibex.term.buffer(i), id)).not.toBe('');
    await page.evaluate((i) => (window as any).vibex.term.close(i), id);
    await expect.poll(tabs).toBe(0);
    await page.waitForTimeout(1500);
    expect(existsSync(log), existsSync(log) ? readFileSync(log, 'utf8') : '').toBe(false);
    const created = await page.evaluate(() => (window as any).vibex.term.create('shell'));
    await expect.poll(() => page.evaluate((i) => (window as any).vibex.term.buffer(i), created.id)).not.toBe('');
  });

  test("the fork refusal of node-pty's kill says nothing to the person; any other fault says one plain line", async () => {
    await app.evaluate(() => { void Promise.reject(new Error('child_process.fork() is not supported when the runAsNode fuse is disabled')); });
    await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('child_process.fork()');
    await expect(page.locator('#toasts .toast')).toHaveCount(0);
    await app.evaluate(() => { void Promise.reject(new Error('made-up fault')); });
    await expect(page.locator('#toasts .toast')).toHaveCount(1);
    await expect(page.locator('#toasts .toast')).not.toContainText('made-up fault');
  });
});
