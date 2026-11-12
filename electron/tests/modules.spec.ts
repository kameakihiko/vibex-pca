import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tempDir, firstWindow } from './fixtures';

// The seams that features plug into: the renderer's module bridge and the document tabs of the middle column.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const dir = tempDir('vibex-modules-');
  const folder = path.join(dir, 'alpha');
  mkdirSync(folder);
  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: path.join(dir, 'data'),
    VIBEX_MCP_PORT: '0',
    VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  await page.evaluate((f) => (window as any).vibex.projects.open(f), realpathSync.native(folder));
  await page.waitForSelector('#workspace:not([hidden])');
});

test.afterAll(async () => {
  await app?.close();
});

test('the module bridge refuses a channel outside mod:', async () => {
  const refused = await page.evaluate(() => {
    try {
      void (window as any).vibex.mod.invoke('term:list');
      return false;
    } catch {
      return true;
    }
  });
  expect(refused).toBe(true);
});
