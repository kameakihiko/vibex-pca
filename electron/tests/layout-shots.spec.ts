import { _electron as electron, expect, test } from '@playwright/test';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { firstWindow, tempDir } from './fixtures';

// Screenshots of a new project, for a before/after review page. It asserts only that the screen is there, so the same file
// runs on a commit before the chat layout and on one after it (screens/layout-*.png). Made-up folder and words only.

const FAKE = path.join(__dirname, 'fake-claude.cjs');
const posix = process.platform !== 'win32';

test('layout shots: a new project at 1440 x 900, 1093 x 614 and 900 x 560', async () => {
  const dir = realpathSync.native(tempDir('vibex-layout-shots-'));
  const shots = path.join(__dirname, '..', 'screens');
  mkdirSync(shots, { recursive: true });
  const project = path.join(dir, 'made-up-project');
  mkdirSync(project);
  const config = path.join(dir, 'cfg');
  mkdirSync(config);
  writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: { [project.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
  let fake = process.execPath;
  if (posix) {
    mkdirSync(path.join(dir, 'bin'));
    fake = path.join(dir, 'bin', 'claude');
    writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(fake, 0o755);
  }
  const env = {
    ...process.env,
    PATH: posix ? `${path.dirname(fake)}${path.delimiter}${process.env.PATH}` : process.env.PATH,
    VIBEX_TEST: '1',
    VIBEX_CHAT_FIRST: '1',
    VIBEX_CHAT_DEFAULT: '1',
    VIBEX_USER_DATA: path.join(dir, 'data'),
    VIBEX_MCP_PORT: '0',
    CLAUDE_CONFIG_DIR: config,
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  delete env.VIBEX_AGENT_COMMAND;
  if (!posix) Object.assign(env, { VIBEX_CHAT_BIN: fake, VIBEX_CHAT_SCRIPT: FAKE, VIBEX_AGENT_COMMAND: 'Write-Host made-up-terminal' });
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  const app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  try {
    const page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    const size = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h });
    const shot = (name: string) => page.screenshot({ path: path.join(shots, `layout-${name}-${process.platform}.png`) });
    await size(1440, 900);
    await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
    const chat = page.locator('.terminal-pane[data-pane="agent"] .term.active.chat-surface');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await shot('new-1440x900');
    await chat.locator('.chat-input').fill('hello');
    await chat.locator('.chat-input').press('Enter');
    await expect(chat.locator('.chat-item[data-kind="done"]')).toBeVisible();
    await shot('answer-1440x900');
    // The control a person opens for the mode: one "…" after the change, the mode button before it.
    const more = chat.locator('.chat-more');
    await ((await more.isVisible()) ? more : chat.locator('.chat-mode')).click();
    await expect(page.locator('.chat-popup')).toBeVisible();
    await shot('menu-1440x900');
    await page.locator('.chat-popup .chat-popup-row').first().press('Escape');
    await expect(page.locator('.chat-popup')).toHaveCount(0);
    for (const [w, h] of [[1093, 614], [900, 560]]) {
      await size(w, h);
      await page.waitForTimeout(400);
      await shot(`answer-${w}x${h}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await size(1440, 900);
    await page.waitForTimeout(400);
    await shot('answer-light-1440x900');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
