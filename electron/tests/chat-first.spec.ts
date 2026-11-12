import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { firstWindow, tempDir } from './fixtures';

// The chat layout of the PCA edition (chat-first plan, part P3; src/renderer/chatFirst.ts). A test run turns it on with
// VIBEX_CHAT_FIRST=1; a build a person installs has it on with no switch. All folders and words here are made up.
test.describe.configure({ mode: 'serial' });

const FAKE = path.join(__dirname, 'fake-claude.cjs');
const posix = process.platform !== 'win32';
const shots = path.join(__dirname, '..', 'screens');

let dir: string;
let userData: string;
let app: ElectronApplication | undefined;
let page: Page;

function fakeBin(): string {
  if (!posix) return process.execPath;
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

function folder(name: string): string {
  const f = path.join(dir, name);
  mkdirSync(f, { recursive: true });
  return f;
}

/// One start of the app on the same profile. `chatFirst` false is a build from before this change, as far as the layout goes.
async function start(options: { chatFirst?: boolean; chat?: boolean } = {}): Promise<void> {
  const fake = fakeBin();
  const config = path.join(dir, 'cfg');
  mkdirSync(config, { recursive: true });
  const trusted = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map((n) => [path.join(dir, n).replaceAll('\\', '/'), { hasTrustDialogAccepted: true }]));
  writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ projects: trusted }));
  const env = {
    ...process.env,
    PATH: posix ? `${path.dirname(fake)}${path.delimiter}${process.env.PATH}` : process.env.PATH,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: userData,
    VIBEX_MCP_PORT: '0',
    CLAUDE_CONFIG_DIR: config,
    FAKE_CLAUDE_LOG: path.join(dir, 'log.jsonl'),
    ...(options.chatFirst === false ? {} : { VIBEX_CHAT_FIRST: '1' }),
    ...(options.chat === false ? {} : { VIBEX_CHAT_DEFAULT: '1' }),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  delete env.VIBEX_AGENT_COMMAND;
  if (!posix) Object.assign(env, { VIBEX_CHAT_BIN: fake, VIBEX_CHAT_SCRIPT: FAKE, VIBEX_AGENT_COMMAND: 'Write-Host made-up-terminal' });
  if (options.chat === false && posix) env.VIBEX_AGENT_COMMAND = 'echo made-up-terminal';
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
}

async function stop(): Promise<void> {
  await app?.close();
  app = undefined;
}

const open = async (f: string) => {
  await page.evaluate((x) => (window as any).vibex.projects.open(x), f);
  await expect(page.locator('#workspace')).toBeVisible();
};
const tile = (name: string) => page.locator('.tile', { hasText: name });
const idOf = (name: string) => tile(name).getAttribute('data-project') as Promise<string>;
const activity = (name: string) => page.locator(`#activity [data-activity="${name}"]`);
const agent = () => page.locator('.terminal-pane[data-pane="agent"]');
const shell = () => page.locator('.terminal-pane[data-pane="shell"]');
const browser = () => page.locator('#browser-pane');
const chatOn = () => agent().locator('.term.active.chat-surface');
const offer = () => page.locator('#chat-layout-offer');
/// A menu row by its title alone: "Ask" is also inside the detail of "Accept edits".
const row = (title: string) => page.locator('.chat-popup .chat-popup-row').filter({ has: page.locator('.chat-popup-title', { hasText: new RegExp(`^${title}$`) }) });
const size = (w: number, h: number) => app!.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h });
const shot = (name: string) => page.screenshot({ path: path.join(shots, `chat-first-${name}-${process.platform}.png`) });
const frameRecord = (id: string) => page.evaluate((x) => JSON.parse(localStorage.getItem(`vibex.frame.${x}`) || 'null'), id);
const chatFirstOf = (id: string) => page.evaluate((x) => JSON.parse(localStorage.getItem(`vibex.frame.${x}`) || 'null')?.chat === true, id);

test.beforeAll(() => {
  dir = realpathSync.native(tempDir('vibex-chat-first-'));
  userData = path.join(dir, 'data');
  mkdirSync(userData);
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await stop().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('1. an older build opens a project with three columns; its layout is a saved layout', async () => {
  await start({ chatFirst: false });
  await open(folder('alpha'));
  await expect(agent()).toBeVisible();
  await expect(browser()).toBeVisible();
  await expect(shell()).toBeVisible();
  await expect(offer()).toBeHidden();
  // The mode and the model keep their own buttons where the edition is off.
  await expect(chatOn().locator('.chat-mode')).toBeVisible({ timeout: 20_000 });
  await expect(chatOn().locator('.chat-more')).toBeHidden();
  // A second project, closed again: it is only a recent folder at the next start.
  await open(folder('epsilon'));
  const epsilon = await idOf('epsilon');
  await page.evaluate((x) => (window as any).vibex.projects.close(x), epsilon);
  await expect(tile('epsilon')).toHaveCount(0);
  // No record at all, as every project opened before records were saved at once.
  await page.evaluate(([a, e]) => { localStorage.removeItem(`vibex.frame.${a}`); localStorage.removeItem(`vibex.frame.${e}`); }, [await idOf('alpha'), epsilon]);
  await stop();
});

test('2. the first chat-first start keeps the older project as it was, with one quiet offer', async () => {
  await start();
  await tile('alpha').click();
  await expect(browser()).toBeVisible();
  await expect(shell()).toBeVisible();
  await expect(offer()).toBeVisible();
  await expect(offer()).toContainText('Use the chat layout');
  await expect(offer()).toHaveAttribute('role', 'note');
  expect(await chatFirstOf(await idOf('alpha'))).toBe(false);
  await size(1440, 900);
  await shot('older-project-offer');
});

test('2b. a recent project from before keeps its three columns when it opens again', async () => {
  await open(folder('epsilon'));
  await expect(browser()).toBeVisible();
  await expect(shell()).toBeVisible();
  await expect(offer()).toBeVisible();
  // It closes again, so the later tests see the same rail.
  await page.evaluate(async (x) => (window as any).vibex.projects.close(x), await idOf('epsilon'));
  await tile('alpha').click();
});

test('3. a new project shows only Claude, full width; browser and terminal wait on their buttons', async () => {
  await open(folder('beta'));
  await expect(chatOn()).toBeVisible({ timeout: 20_000 });
  await expect(browser()).toBeHidden();
  await expect(shell()).toBeHidden();
  await expect(page.locator('#workspace > .splitter:visible')).toHaveCount(0);
  await expect(offer()).toBeHidden();
  for (const [name, pressed] of [['agent', 'true'], ['browser', 'false'], ['shell', 'false']]) {
    await expect(activity(name)).toBeVisible();
    await expect(activity(name)).toHaveAttribute('aria-pressed', pressed);
  }
  const id = await idOf('beta');
  expect(await chatFirstOf(id)).toBe(true);
  // The terminal tab runs, hidden: a tool or the Command button finds it ready.
  const tabs = await app!.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().filter((t: any) => t.project === project).map((t: any) => t.pane), id);
  expect(tabs).toContain('shell');
  expect(tabs).toContain('agent');
  // Claude has the whole width of the workspace, and the chat reads in a centred column of about 760 px.
  const room = (await page.locator('#workspace').boundingBox())!;
  const column = (await agent().boundingBox())!;
  expect(column.width).toBeGreaterThan(room.width - 20);
  const composer = (await chatOn().locator('.chat-composer').boundingBox())!;
  expect(composer.width).toBeLessThanOrEqual(761);
  expect(composer.width).toBeGreaterThan(700);
  const left = composer.x - column.x;
  const right = column.x + column.width - (composer.x + composer.width);
  expect(Math.abs(left - right)).toBeLessThan(4);
  await shot('new-project-1440x900');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('new-project-light-1440x900');
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('4. mode and model are one "…" control; another mode stays in sight on it', async () => {
  const chat = chatOn();
  await expect(chat.locator('.chat-mode')).toBeHidden();
  await expect(chat.locator('.chat-model')).toBeHidden();
  const more = chat.locator('.chat-more');
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-label', 'Mode and model');
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  // The default mode has no word on the button.
  await expect(more).toHaveText('');
  await chat.locator('.chat-input').fill('hello');
  await chat.locator('.chat-input').press('Enter');
  await expect(chat.locator('.chat-item[data-kind="done"]')).toBeVisible();
  await more.click();
  const popup = page.locator('.chat-popup');
  await expect(popup.locator('.chat-popup-group').first()).toHaveText('Mode');
  await expect(popup.locator('.chat-popup-group', { hasText: 'Model' })).toHaveCount(1);
  for (const m of ['Ask', 'Accept edits', 'Plan', 'Auto']) await expect(row(m)).toHaveCount(1);
  await shot('more-menu-1440x900');
  await row('Plan').click();
  await expect(more).toHaveText('Plan');
  await expect(more).toHaveAttribute('aria-label', 'Mode and model, mode Plan');
  // Back to Ask, and the word goes.
  await more.click();
  await row('Ask').click();
  await expect(more).toHaveText('');
});

test('5. the browser and the terminal open on their buttons, and the choice is kept', async () => {
  await activity('shell').click();
  await expect(shell()).toBeVisible();
  await expect(shell().locator('.tab:visible')).toHaveCount(1);
  await activity('browser').click();
  await expect(browser()).toBeVisible();
  await expect(page.locator('#workspace > .splitter:visible')).toHaveCount(2);
  const id = await idOf('beta');
  // Still a chat-first project: the person opened panes, the project did not go back to an older layout.
  expect(await chatFirstOf(id)).toBe(true);
  await activity('browser').click();
  await activity('shell').click();
  await expect(browser()).toBeHidden();
  await expect(shell()).toBeHidden();
  // The last pane stays: Claude cannot be hidden when it is alone.
  await activity('agent').click();
  await expect(agent()).toBeVisible();
});

test('6. small window: Claude alone keeps the composer whole', async () => {
  for (const [w, h] of [[900, 560], [1093, 614]]) {
    await size(w, h);
    await page.waitForTimeout(300);
    const box = (await chatOn().locator('.chat-composer').boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(h);
    const room = (await agent().boundingBox())!;
    for (const control of ['.chat-send', '.chat-more', '.chat-attach']) {
      const b = (await chatOn().locator(control).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(room.x + room.width);
    }
    await shot(`new-project-${w}x${h}`);
  }
  await size(1440, 900);
});

test('7. after a restart: the new project stays chat-first, the older one keeps its columns and its offer', async () => {
  await stop();
  await start();
  await tile('beta').click();
  await expect(browser()).toBeHidden();
  await expect(shell()).toBeHidden();
  await expect(offer()).toBeHidden();
  await tile('alpha').click();
  await expect(browser()).toBeVisible();
  await expect(shell()).toBeVisible();
  await expect(offer()).toBeVisible();
});

test('8. "Use the chat layout" gives Claude the window and is kept', async () => {
  await page.locator('#chat-layout-use').click();
  await expect(browser()).toBeHidden();
  await expect(shell()).toBeHidden();
  await expect(offer()).toBeHidden();
  await expect(agent()).toBeVisible();
  const id = await idOf('alpha');
  expect(await chatFirstOf(id)).toBe(true);
  // The person's widths stay for the next time a pane opens.
  expect((await frameRecord(id)).panes).toEqual({ agent: true, browser: false, shell: false });
  await stop();
  await start();
  await tile('alpha').click();
  await expect(browser()).toBeHidden();
  await expect(offer()).toBeHidden();
});

test('9. "Keep this layout" closes the offer for good, in that project only', async () => {
  await stop();
  // gamma: another project from an older build.
  await start({ chatFirst: false });
  await open(folder('gamma'));
  await expect(browser()).toBeVisible();
  await stop();
  await start();
  await tile('gamma').click();
  await expect(offer()).toBeVisible();
  // Only Claude open by hand: the offer would change nothing, so it goes; it comes back with a second pane.
  await activity('browser').click();
  await activity('shell').click();
  await expect(offer()).toBeHidden();
  await activity('browser').click();
  await activity('shell').click();
  await expect(offer()).toBeVisible();
  await page.locator('#chat-layout-close').click();
  await expect(offer()).toBeHidden();
  await expect(browser()).toBeVisible();
  await expect(shell()).toBeVisible();
  expect(await chatFirstOf(await idOf('gamma'))).toBe(false);
  await stop();
  await start();
  await tile('gamma').click();
  await expect(offer()).toBeHidden();
  await expect(browser()).toBeVisible();
});

test('10. until the chat is the default tab (part P6), a new project shows the terminal Claude alone', async () => {
  await stop();
  await start({ chat: false });
  await open(folder('delta'));
  await expect(agent().locator('.term.active .xterm')).toBeVisible({ timeout: 20_000 });
  await expect(browser()).toBeHidden();
  await expect(shell()).toBeHidden();
  await shot('new-project-terminal-claude-1440x900');
});
