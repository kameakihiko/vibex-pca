import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startSite, startSshServer, tempDir, firstWindow } from './fixtures';

// What a person meets on a laptop, from the laws audit of 2026-10-31: one name per thing, a way out of each dead end, and
// a window that stays usable with a sidebar open. Each test starts its own app, so a red test hides no other.

let app: ElectronApplication;
let page: Page;
let dir: string;
let userData: string;
const closers: (() => void)[] = [];
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

function folder(...parts: string[]): string {
  const f = path.join(dir, ...parts);
  mkdirSync(f, { recursive: true });
  return realpathSync.native(f);
}

async function launch(): Promise<void> {
  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: userData,
    VIBEX_MCP_PORT: '0',
    VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
}

const open = (f: string) => page.evaluate((x) => (window as any).vibex.projects.open(x), f);
const pane = (name: string) => page.locator(`.terminal-pane[data-pane="${name}"]`);
const activity = (name: string) => page.locator(`#activity [data-activity="${name}"]`);
const menuItems = () => app.evaluate(({ Menu }) => {
  const out: string[] = [];
  const walk = (m: Electron.Menu | null) => m?.items.forEach((i) => {
    if (i.label) out.push(`${i.label}${i.accelerator ? ' ' + i.accelerator : ''}`);
    walk(i.submenu ?? null);
  });
  walk(Menu.getApplicationMenu());
  return out;
});
const clickMenu = (label: string) => app.evaluate(({ Menu }, wanted) => {
  const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
    for (const i of m?.items ?? []) {
      if (i.label === wanted) return i;
      const inner = find(i.submenu ?? null);
      if (inner) return inner;
    }
    return undefined;
  };
  find(Menu.getApplicationMenu())!.click();
}, label);

test.beforeEach(() => {
  dir = tempDir('vibex-ux-');
  userData = path.join(dir, 'data');
  mkdirSync(userData);
});

test.afterEach(async () => {
  await app?.close();
  for (const close of closers.splice(0)) close();
  rmSync(dir, { recursive: true, force: true });
});

test('1. one name per thing, the Swift app\'s: MCP on the chip and in the section', async () => {
  await launch();
  await open(folder('alpha'));
  await expect(page.locator('#mcp-text')).toHaveText(/^(MCP ready|Claude Code is missing)$/);
  await activity('mcp').click();
  await expect(page.locator('#sidebar-title')).toHaveText('MCP Servers');
  await expect(page.locator('#sidebar-body')).not.toContainText('Vibex tools');
  await expect(page.locator('#sidebar-body')).not.toContainText('Claude tools');
  expect(await menuItems()).toContain(`Command Terminal CmdOrCtrl+3`);
});

test('2. a server project shows no primary Connect; a local one does', async () => {
  const ssh = await startSshServer(dir);
  closers.push(() => ssh.close());
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([{
    name: 'test', host: '127.0.0.1', user: 'pca', port: ssh.port, identityFile: ssh.keyFile, allowClaude: true,
    options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' },
  }]));
  await launch();
  await open(folder('local'));
  await expect(page.locator('button.server.primary')).toHaveCount(1);
  await page.evaluate(() => (window as any).vibex.projects.openServer('test', '~/ledger'));
  await expect(page.locator('.tile[aria-current="true"]')).toHaveAttribute('data-server', 'test');
  await expect(page.locator('button.server.primary')).toHaveCount(0);
  await page.locator('.tile', { hasText: 'local' }).click();
  await expect(page.locator('button.server.primary')).toHaveCount(1);
});

test('3. a skipped bad server entry is named on screen', async () => {
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([
    { name: 'good', host: '127.0.0.1', user: 'pca' },
    { name: 'broken-one', host: '-oProxyCommand=calc', user: 'pca' },
  ]));
  await launch();
  await open(folder('alpha'));
  await expect(page.locator('button.server')).toHaveText(['Connect good']);
  await expect(page.locator('#no-servers')).toBeVisible();
  await expect(page.locator('#no-servers')).toContainText('broken-one');
  await expect(page.locator('#no-servers')).not.toContainText('ProxyCommand');
});

test('4. a recent folder that has gone leaves the list when a person clicks it', async () => {
  const gone = folder('gone-one');
  const stays = folder('stays-one');
  writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [], recents: [gone, stays] }));
  await launch();
  const rows = page.locator('#welcome-recent-list .recent');
  await expect(rows).toHaveCount(2);
  rmSync(gone, { recursive: true, force: true });
  await rows.filter({ hasText: 'gone-one' }).click();
  await expect(page.locator('#welcome-error')).toContainText('Could not open this project');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveText(/stays-one/);
});

test('5. Back and Forward are off when there is nowhere to go', async () => {
  const site = await startSite();
  closers.push(() => site.close());
  await launch();
  await open(folder('alpha'));
  const back = page.locator('#back');
  const forward = page.locator('#forward');
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await page.locator('#url').fill(`${site.url}one`);
  await page.locator('#url').press('Enter');
  await expect(page.locator('#page-title')).toHaveText('PCA test page');
  await expect(page.locator('#url')).toHaveValue(`${site.url}one`);
  await expect(back).toBeDisabled();
  await page.locator('#url').fill(`${site.url}two`);
  await page.locator('#url').press('Enter');
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();
  await back.click();
  await expect(page.locator('#url')).toHaveValue(`${site.url}one`);
  await expect(forward).toBeEnabled();
  await expect(back).toBeDisabled();
});

test('6. Find in Terminal finds text, counts it, and gives the keyboard back', async () => {
  await launch();
  await open(folder('alpha'));
  await expect(pane('shell').locator('.tab')).toHaveCount(1);
  await pane('shell').locator('.term.active .xterm').click();
  // The shell must work the number out, or the command line would be a hit too. The tab is PowerShell on Windows.
  await page.keyboard.type(process.platform === 'win32' ? 'echo "needle-$(40+2) needle-$(40+2)"' : 'echo needle-$((40+2)) needle-$((40+2))');
  await page.keyboard.press('Enter');
  await expect.poll(() => pane('shell').locator('.term.active .xterm-rows').innerText()).toMatch(/needle-42 needle-42/);
  await clickMenu('Find in Terminal');
  const box = pane('shell').locator('.term-find input');
  await expect(box).toBeFocused();
  await box.fill('needle-42');
  await expect(pane('shell').locator('.term-find-count')).toHaveText('2 of 2');
  await box.press('Enter');
  await expect(pane('shell').locator('.term-find-count')).toHaveText('1 of 2');
  await box.fill('not-in-this-tab');
  await expect(pane('shell').locator('.term-find-count')).toHaveText('No results');
  await box.press('Escape');
  await expect(pane('shell').locator('.term-find')).toBeHidden();
  await expect(pane('shell').locator('.term.active .xterm-helper-textarea')).toBeFocused();
});

test('7. a web address in a terminal opens in the side browser with Ctrl or Cmd and a click, and not with a plain click', async () => {
  const site = await startSite();
  closers.push(() => site.close());
  await launch();
  await open(folder('alpha'));
  await expect(pane('shell').locator('.tab')).toHaveCount(1);
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type(`clear; echo ${site.url}linked`);
  await page.keyboard.press('Enter');
  const row = pane('shell').locator('.term.active .xterm-rows > div', { hasText: /^http/ }).first();
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  const at = { x: box.x + 30, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);
  await expect(page.locator('#url')).toHaveValue('');
  await page.keyboard.down(mod);
  await page.mouse.move(at.x + 2, at.y);
  await page.mouse.click(at.x + 2, at.y);
  await page.keyboard.up(mod);
  await expect(page.locator('#url')).toHaveValue(`${site.url}linked`);
});

test('8. two projects with one name show their parent folder', async () => {
  await launch();
  await open(folder('client-a', 'app'));
  await open(folder('client-b', 'app'));
  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(page.locator('.tile', { hasText: 'client-a' })).toHaveCount(1);
  await expect(page.locator('.tile', { hasText: 'client-b' })).toHaveCount(1);
  await expect(page.locator('#project-name')).toContainText('client-b');
  // One name alone needs no parent.
  await open(folder('client-c', 'solo'));
  await expect(page.locator('.tile', { hasText: 'client-c' })).toHaveCount(0);
});

// Where the limits come from. Each column keeps at least PANE_MIN of frame.ts, 170 px: about 20 columns of text, where the tab
// strip and its + button still fit. If the grid lets a column go under that, the layout has failed. Claude's column at a
// usual laptop (1366 x 768 at 125 %): 30 columns of 8 px, the least where the Claude Code screen wraps only at its long lines.
const PANE_FLOOR = 170;
const CLAUDE_AT_LAPTOP = 240;
for (const [width, height, claude] of [[900, 560, PANE_FLOOR], [1093, 614, CLAUDE_AT_LAPTOP]] as const) {
  test(`9. a laptop window of ${width} x ${height} with a sidebar open stays usable`, async () => {
    await launch();
    await open(folder('alpha'));
    await activity('files').click();
    await expect(page.locator('#sidebar')).toBeVisible();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width + 20);
    const measured = await page.evaluate(() => {
      const rect = (e: Element) => e.getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        panes: [...document.querySelectorAll('#workspace > .pane')].map((p) => Math.round(rect(p).width)),
        claude: Math.round(rect(document.querySelector('.terminal-pane[data-pane="agent"]')!).width),
        plus: [...document.querySelectorAll('.terminal-pane .new-tab')].map((b) => rect(b).right),
        right: Math.max(...[...document.querySelectorAll('#workspace > .pane')].map((p) => rect(p).right)),
        lowestActivity: Math.max(...[...document.querySelectorAll('#activity button')].map((b) => rect(b).bottom)),
        address: Math.round(rect(document.querySelector('#url')!).width),
      };
    });
    expect(measured.right).toBeLessThanOrEqual(measured.width);
    // Each activity button can be pressed with no scrolling.
    expect(measured.lowestActivity).toBeLessThanOrEqual(measured.height);
    // Three columns, or the checks below read an empty list and pass.
    expect(measured.panes).toHaveLength(3);
    for (const p of measured.panes) expect(p).toBeGreaterThanOrEqual(PANE_FLOOR);
    expect(measured.claude).toBeGreaterThanOrEqual(claude);
    // Each column's + can be pressed.
    expect(measured.plus.length).toBeGreaterThanOrEqual(2);
    for (const right of measured.plus) expect(right).toBeLessThanOrEqual(measured.width);
    expect(measured.address).toBeGreaterThanOrEqual(80);
    await page.screenshot({ path: path.join(__dirname, '..', 'screens', `laptop-${width}-${process.platform}.png`) });
  });
}

test('10. shortcuts: columns are 1, 2 and 3 with no gap, and Agents has one', async () => {
  await launch();
  const items = await menuItems();
  for (const want of ['Claude CmdOrCtrl+1', 'Browser CmdOrCtrl+2', 'Command Terminal CmdOrCtrl+3', 'Agents CmdOrCtrl+Shift+A']) expect(items).toContain(want);
  await open(folder('alpha'));
  await expect(activity('browser')).toHaveAttribute('title', /\+2\)/);
  await expect(activity('shell')).toHaveAttribute('title', /\+3\)/);
  await expect(activity('agents')).toHaveAttribute('title', /\+Shift\+A\)/);
});
