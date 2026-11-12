import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { startSite, tempDir, firstWindow } from './fixtures';

// The frame of Vibex PCA, as macOS Vibex has it (Layout/ProjectRail, ActivityBar, Sidebar; App/WindowManager):
// one window, a project rail, an activity bar, sidebars, and tabs and a browser for each open project.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let userData: string;
let site: Awaited<ReturnType<typeof startSite>>;
let alpha: string;
let beta: string;
let gamma: string;
let port: number;
let token: string;

function mkProject(name: string): string {
  const folder = path.join(dir, name);
  mkdirSync(folder, { recursive: true });
  return realpathSync.native(folder);
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
  const hook = await app.evaluate(() => {
    const t = (globalThis as any).__vibexTest;
    return { token: t.token as string, port: t.status.mcpPort as number };
  });
  port = hook.port;
  token = hook.token;
}

const stubFolderPicker = (folders: string[]) => app.evaluate(({ dialog }, picked) => {
  (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: picked });
}, folders);

const stubCloseAnswer = (button: number) => app.evaluate(({ dialog }, answer) => {
  (dialog as any).showMessageBox = async () => ({ response: answer, checkboxChecked: false });
}, button);

async function openProject(folder: string): Promise<void> {
  await stubFolderPicker([folder]);
  await page.locator('#rail-open').click();
  await expect(page.locator('.tile', { hasText: path.basename(folder) })).toHaveCount(1);
}

const tile = (folder: string) => page.locator('.tile', { hasText: path.basename(folder) });
const idOf = (folder: string) => tile(folder).getAttribute('data-project') as Promise<string>;
const pane = (name: 'agent' | 'shell') => page.locator(`.terminal-pane[data-pane="${name}"]`);
const visibleTabs = (name: 'agent' | 'shell') => pane(name).locator('.tab:visible');
const activity = (name: string) => page.locator(`#activity [data-activity="${name}"]`);

async function terminalText(name: 'agent' | 'shell' = 'shell'): Promise<string> {
  return pane(name).locator('.term.active .xterm-rows').innerText();
}

async function mcpClient(windowId?: string): Promise<Client> {
  const client = new Client({ name: 'vibex-frame-test', version: '1.0.0' });
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (windowId !== undefined) headers['X-Vibex-Window'] = windowId;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
}

function textOf(result: Awaited<ReturnType<typeof tool>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

const printWindow = process.platform === 'win32' ? 'Write-Output "WIN=$env:VIBEX_WINDOW"; (Get-Location).Path' : 'echo "WIN=$VIBEX_WINDOW"; pwd';

/// The native browser view of a project, as the main process sees it.
const nativeView = (id: string) => app.evaluate((_e, project) => {
  const pane = (globalThis as any).__vibexTest.browsers.get(project);
  if (!pane) return null;
  const b = pane.view.getBounds();
  return { visible: pane.view.getVisible() as boolean, x: b.x, y: b.y, width: b.width, height: b.height };
}, id);

const placeholder = () => page.locator('#browser-view').evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
});

/// The native view is a layer over the page: if it does not follow the placeholder, it covers other panes.
async function expectViewOnPlaceholder(id: string): Promise<void> {
  await expect.poll(async () => {
    const view = await nativeView(id);
    return view ? { x: view.x, y: view.y, width: view.width, height: view.height } : null;
  }).toEqual(await placeholder());
}

test.beforeAll(async () => {
  dir = tempDir('vibex-frame-test-');
  userData = path.join(dir, 'profile');
  mkdirSync(userData);
  alpha = mkProject('alpha-project');
  beta = mkProject('beta');
  gamma = mkProject('blue_lake');
  site = await startSite();
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('1. a first launch asks for a project and starts nothing', async () => {
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#welcome button.primary')).toHaveText('Open Project');
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#activity')).toBeHidden();
  await expect(page.locator('#rail .tile')).toHaveCount(0);
  const tabs = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length);
  expect(tabs).toBe(0);
  await page.screenshot({ path: path.join(__dirname, '..', 'screens', `frame-welcome-${process.platform}.png`) });
});

test('2. a tool call with no open project is refused', async () => {
  const client = await mcpClient();
  const result = await tool(client, 'terminal_run', { command: 'echo no' });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('no project is open');
  await client.close();
});

test('3. opening a project adds its tile and starts its Claude and terminal tabs in its folder', async () => {
  await stubFolderPicker([alpha]);
  await page.locator('#welcome button.primary').click();
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(tile(alpha)).toHaveCount(1);
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  await expect(tile(alpha).locator('.mono')).toHaveText('AP');
  await expect(page.locator('#project-name')).toHaveText('alpha-project');
  await expect(visibleTabs('agent')).toHaveText(['Claude']);
  await expect(visibleTabs('shell')).toHaveCount(1);
  await expect.poll(() => terminalText('agent'), { timeout: 45_000 }).toContain('AGENT-START-OK');

  const client = await mcpClient(await idOf(alpha));
  const out = textOf(await tool(client, 'terminal_run', { command: printWindow }));
  expect(out).toContain(path.basename(alpha));
  expect(out).toContain(`WIN=${await idOf(alpha)}`);
  await client.close();

  // One open project, and a caller that does not say who it is: it can be a Claude in any other folder.
  const stranger = await mcpClient();
  const refused = await tool(stranger, 'terminal_run', { command: 'echo no' });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain('project_path');
  await stranger.close();
});

test('4. opening the same folder again selects it and adds nothing', async () => {
  await openProject(beta);
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  await openProject(alpha);
  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  await tile(beta).click();
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  await expect(tile(alpha)).not.toHaveAttribute('aria-current', 'true');
  await expect(tile(beta).locator('.mono')).toHaveText('BE');
});

test('5. each project keeps its own terminals, and what they printed, across a switch', async () => {
  // A tool's command may have left its finished tab; the person's shell is the first one.
  await visibleTabs('shell').first().click();
  await expect.poll(() => terminalText(), { timeout: 45_000 }).toMatch(/\S/);
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type(process.platform === 'win32' ? 'echo BETA-$(20+22)' : 'echo BETA-$((20+22))');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText()).toContain('BETA-42');

  const before = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length);
  await tile(alpha).click();
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  await expect(visibleTabs('shell')).not.toHaveCount(0);
  await expect.poll(() => terminalText()).not.toContain('BETA-42');
  await tile(beta).click();
  await expect.poll(() => terminalText()).toContain('BETA-42');
  // A switch shows the tabs that exist; it starts no new process.
  expect(await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length)).toBe(before);
});

test('6. a new tab goes to the project on screen, and Next Tab stays inside it', async () => {
  // A tool's finished command may have a tab here too, so the counts are relative.
  const inBeta = await visibleTabs('shell').count();
  await page.locator('.new-tab[data-pane="shell"]').click();
  await expect(visibleTabs('shell')).toHaveCount(inBeta + 1);
  await tile(alpha).click();
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  const inAlpha = await visibleTabs('shell').count();
  await page.locator('.new-tab[data-pane="shell"]').click();
  await expect(visibleTabs('shell')).toHaveCount(inAlpha + 1);
  await tile(beta).click();
  await expect(visibleTabs('shell')).toHaveCount(inBeta + 1);
  // Next Tab goes round the two tabs of this project and reaches no other project's tab.
  const pressNextTab = () => app.evaluate(({ Menu }) => {
    const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
      for (const i of m?.items ?? []) {
        if (i.label === 'Next Tab') return i;
        const inner = find(i.submenu ?? null);
        if (inner) return inner;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu())!.click();
  });
  await pane('shell').locator('.term.active .xterm').click();
  const selected = () => pane('shell').locator('.tab[aria-selected="true"]').getAttribute('data-tab');
  const start = await selected();
  await pressNextTab();
  await expect.poll(selected).not.toBe(start);
  await expect(pane('shell').locator('.tab[aria-selected="true"]')).toBeVisible();
  await pressNextTab();
  await expect.poll(selected).toBe(start);
  const closing = await pane('shell').locator('.tab:visible').last().getAttribute('data-tab');
  await pane('shell').locator(`.tab[data-tab="${closing}"] .close`).click();
  await expect(visibleTabs('shell')).toHaveCount(inBeta);
  await tile(alpha).click();
  await expect(visibleTabs('shell')).toHaveCount(inAlpha + 1); // the other project's tab did not move or close
  await pane('shell').locator('.tab:visible').last().locator('.close').click();
  await expect(visibleTabs('shell')).toHaveCount(inAlpha);
});

test('7. the activity bar names its sections, and the panes show and hide without losing the last one', async () => {
  await expect(page.locator('#activity button .activity-label')).toHaveText(['Projects', 'Claude', 'Browser', 'Command', 'Files', 'Git', 'Agents', 'Skills', 'MCP', 'Notes', 'Inbox', 'Servers']);
  await expect(activity('agent')).toHaveAttribute('aria-pressed', 'true');
  await activity('agent').click();
  await expect(pane('agent')).toBeHidden();
  await expect(activity('agent')).toHaveAttribute('aria-pressed', 'false');
  await activity('browser').click();
  await expect(page.locator('#browser-pane')).toBeHidden();
  // The only pane left stays: a window with no pane has no way to type.
  await activity('shell').click();
  await expect(pane('shell')).toBeVisible();
  await expect(page.locator('#workspace > .splitter:visible')).toHaveCount(0);
  const wide = await pane('shell').evaluate((e) => e.getBoundingClientRect().width);
  await activity('agent').click();
  await expect(pane('agent')).toBeVisible();
  await expect(page.locator('#workspace > .splitter:visible')).toHaveCount(1);
  expect(await pane('shell').evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(wide);
  await activity('browser').click();
  await expect(page.locator('#workspace > .splitter:visible')).toHaveCount(2);
});

test('8. the rail hides and shows, and the panes take its width', async () => {
  const left = () => page.locator('#activity').evaluate((e) => e.getBoundingClientRect().left);
  await expect(page.locator('#rail')).toBeVisible();
  expect(await left()).toBe(64);
  await activity('rail').click();
  await expect(page.locator('#rail')).toBeHidden();
  expect(await left()).toBe(0);
  await expect(activity('rail')).toHaveAttribute('aria-pressed', 'false');
  await activity('rail').click();
  await expect(page.locator('#rail')).toBeVisible();
});

test('9. a sidebar opens from its button, hides on a second click, and resizes', async () => {
  await expect(page.locator('#sidebar')).toBeHidden();
  await activity('files').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#sidebar-title')).toHaveText('Files');
  await expect(page.locator('#sidebar-body')).toContainText(path.basename(alpha), { ignoreCase: true });
  await expect(activity('files')).toHaveAttribute('aria-pressed', 'true');

  await activity('git').click();
  await expect(page.locator('#sidebar-title')).toHaveText('Source Control');
  await expect(page.locator('#sidebar-body')).toContainText('Create a repository');
  await expect(activity('files')).toHaveAttribute('aria-pressed', 'false');

  await activity('mcp').click();
  await expect(page.locator('#sidebar-body')).toContainText(`127.0.0.1:${port}`);

  // What the person set, and not what shows: at 1200 px or less the sheet caps the sidebar at 210, and a CI screen can be 1024 wide.
  const width = () => page.locator('#sidebar').evaluate((e) => parseFloat((e as HTMLElement).style.width));
  const before = await width();
  const box = (await page.locator('#sidebar-splitter').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 100, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await width()) - before)).toBeGreaterThanOrEqual(50);

  await activity('mcp').click();
  await expect(page.locator('#sidebar')).toBeHidden();
});

test('10. the Files sidebar opens the folder in the system file manager', async () => {
  await app.evaluate(({ shell }) => {
    (shell as any).openPath = async (p: string) => { (globalThis as any).__opened = p; return ''; };
  });
  await activity('files').click();
  await page.locator('#sidebar-body button.side-button').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toBe(alpha);
});

test('11. panes and sidebar are kept per project; the rail is the same for all', async () => {
  await expect(page.locator('#sidebar')).toBeVisible();
  await activity('browser').click();
  await expect(page.locator('#browser-pane')).toBeHidden();
  await tile(beta).click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#browser-pane')).toBeVisible();
  await tile(alpha).click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#browser-pane')).toBeHidden();
  await activity('browser').click();
  await activity('files').click();
});

test('12. each project has its own page; the other page stays hidden behind the switch', async () => {
  const [a, b] = [await idOf(alpha), await idOf(beta)];
  await page.locator('#url').fill(site.url);
  await page.locator('#url').press('Enter');
  await expect(page.locator('#page-title')).toHaveText('PCA test page');
  await expect.poll(async () => (await nativeView(a))?.visible).toBe(true);
  await expectViewOnPlaceholder(a);

  await tile(beta).click();
  await expect(page.locator('#browser-empty')).toBeVisible();
  await expect(page.locator('#url')).toHaveValue('');
  await expect(page.locator('#page-title')).toHaveText('New Tab');
  expect((await nativeView(a))?.visible).toBe(false);
  // No page was asked for here, so no browser view exists for this project yet.
  expect(await nativeView(b)).toBeNull();

  await tile(alpha).click();
  await expect(page.locator('#url')).toHaveValue(site.url);
  await expect(page.locator('#page-title')).toHaveText('PCA test page');
  expect((await nativeView(a))?.visible).toBe(true);
});

test('13. the native page follows its place when the frame changes', async () => {
  const a = await idOf(alpha);
  await activity('files').click();
  await expectViewOnPlaceholder(a);
  await activity('files').click();
  await expectViewOnPlaceholder(a);
  await activity('rail').click();
  await expectViewOnPlaceholder(a);
  await activity('rail').click();
  await expectViewOnPlaceholder(a);
  await activity('agent').click();
  await expectViewOnPlaceholder(a);
  await activity('agent').click();
  await expectViewOnPlaceholder(a);
  // A hidden pane takes its page with it, or the page floats over the other columns.
  await activity('browser').click();
  await expect.poll(async () => (await nativeView(a))?.visible).toBe(false);
  await activity('browser').click();
  await expect.poll(async () => (await nativeView(a))?.visible).toBe(true);
  await expectViewOnPlaceholder(a);
});

test('14. a tool call acts on the project its header names, and the screen stays where it is', async () => {
  const [a, b] = [await idOf(alpha), await idOf(beta)];
  await tile(beta).click();
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  const fromAlpha = await mcpClient(a);

  // A page opened by Claude in another project does not appear over this one.
  await tool(fromAlpha, 'browser_navigate', { url: `${site.url}?from=alpha` });
  expect(await nativeView(b)).toBeNull();
  expect((await nativeView(a))?.visible).toBe(false);
  await expect(page.locator('#browser-empty')).toBeVisible();
  await expect(page.locator('#url')).toHaveValue('');
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');

  const snap = textOf(await tool(fromAlpha, 'browser_snapshot'));
  const box = /textbox "Name" \[ref=(e\d+)\]/.exec(snap);
  const button = /button "Greet" \[ref=(e\d+)\]/.exec(snap);
  await tool(fromAlpha, 'browser_type', { ref: box![1], text: 'alpha' });
  await tool(fromAlpha, 'browser_click', { ref: button![1] });
  expect(textOf(await tool(fromAlpha, 'browser_text'))).toContain('Hello, alpha');

  const out = textOf(await tool(fromAlpha, 'terminal_run', { command: printWindow }));
  expect(out).toContain(path.basename(alpha));
  expect(out).toContain(`WIN=${a}`);
  await expect.poll(() => terminalText()).not.toContain(`WIN=${a}`);

  const listed = textOf(await tool(fromAlpha, 'terminal_tabs'));
  const tabs = await app.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().filter((t: any) => t.project === project).map((t: any) => t.id), a);
  expect(listed.trim().split('\n').map((line) => Number(line.split('\t')[0])).sort()).toEqual([...tabs].sort());
  await fromAlpha.close();
});

test('15. a screenshot of a project in the background is a real picture', async () => {
  const fromAlpha = await mcpClient(await idOf(alpha));
  const shot = await tool(fromAlpha, 'browser_screenshot', { maxWidth: 640 });
  const image = (shot.content as { type: string; data?: string }[])[0];
  expect(image.type).toBe('image');
  const colours = await app.evaluate(({ nativeImage }, data) => {
    const bitmap = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap();
    const seen = new Set<number>();
    for (let i = 0; i < bitmap.length; i += 4) seen.add(bitmap.readUInt32LE(i));
    return seen.size;
  }, image.data!);
  expect(colours).toBeGreaterThan(2);
  await fromAlpha.close();
});

test('16. with no way to tell the project, a tool call is refused and nothing acts', async () => {
  const [a] = [await idOf(alpha)];
  const before = textOf(await tool(await mcpClient(a), 'browser_text'));

  const bare = await mcpClient();
  const refused = await tool(bare, 'browser_navigate', { url: `${site.url}?from=nowhere` });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain('project_path');
  await bare.close();

  const stale = await mcpClient('0000000000000000');
  const staleResult = await tool(stale, 'terminal_run', { command: 'echo no' });
  expect(staleResult.isError).toBe(true);
  await stale.close();

  const empty = await mcpClient('');
  expect((await tool(empty, 'browser_text')).isError).toBe(true);
  const unknownPath = await tool(empty, 'browser_text', { project_path: dir });
  expect(unknownPath.isError).toBe(true);
  expect(textOf(unknownPath)).toContain('open project');

  // project_path names the project, as in macOS Vibex.
  expect(textOf(await tool(empty, 'browser_text', { project_path: alpha }))).toBe(before);
  await empty.close();
});

test('17. a tool call cannot type into a tab of another project', async () => {
  const b = await idOf(beta);
  const otherTab = await app.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().find((t: any) => t.project === project && t.pane === 'shell').id, b);
  const fromAlpha = await mcpClient(await idOf(alpha));
  const result = await tool(fromAlpha, 'terminal_run', { command: 'echo no', tab: otherTab });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('takes no tab');
  await fromAlpha.close();
});

test('18. terminal_run and browser_navigate show their pane again if the person hid it', async () => {
  const b = await idOf(beta);
  await activity('shell').click();
  await expect(pane('shell')).toBeHidden();
  const client = await mcpClient(b);
  await tool(client, 'terminal_run', { command: 'echo shown-again' });
  await expect(pane('shell')).toBeVisible();
  await activity('browser').click();
  await expect(page.locator('#browser-pane')).toBeHidden();
  await tool(client, 'browser_navigate', { url: site.url });
  await expect(page.locator('#browser-pane')).toBeVisible();
  await expect.poll(async () => (await nativeView(b))?.visible).toBe(true);
  await expectViewOnPlaceholder(b);
  await client.close();
});

test('19. vibex_projects lists the projects and marks the caller; vibex_open_project opens one', async () => {
  const a = await idOf(alpha);
  const client = await mcpClient(a);
  const listed = textOf(await tool(client, 'vibex_projects'));
  expect(listed).toContain(`* alpha-project  ${alpha}`);
  expect(listed).toContain(`  beta  ${beta}`);

  const bad = await tool(client, 'vibex_open_project', { path: path.join(dir, 'no-such-folder') });
  expect(bad.isError).toBe(true);
  expect(textOf(bad)).toContain('not a folder');

  // Someone may be typing: a tool adds the tile and leaves the screen and the keyboard where they are.
  await pane('shell').locator('.term.active .xterm').click();
  const onScreen = await page.locator('.tile[aria-current="true"]').getAttribute('data-project');
  expect(textOf(await tool(client, 'vibex_open_project', { path: gamma }))).toContain('blue_lake');
  await expect(tile(gamma).locator('.mono')).toHaveText('MC');
  expect(await page.locator('.tile[aria-current="true"]').getAttribute('data-project')).toBe(onScreen);
  await expect(pane('shell').locator('.term.active .xterm-helper-textarea')).toBeFocused();
  await client.close();
});

test('20. every frame command is in the menu bar', async () => {
  const items = await app.evaluate(({ Menu }) => {
    const out: string[] = [];
    const walk = (m: Electron.Menu | null) => m?.items.forEach((i) => {
      if (i.label) out.push(`${i.label}${i.accelerator ? ' ' + i.accelerator : ''}`);
      walk(i.submenu ?? null);
    });
    walk(Menu.getApplicationMenu());
    return out;
  });
  for (const want of [
    `Open Project… ${process.platform === 'darwin' ? 'Cmd+O' : 'Ctrl+Shift+O'}`, 'Close Project',
    'Next Project Ctrl+PageDown', 'Previous Project Ctrl+PageUp', `Project Rail ${process.platform === 'darwin' ? 'Cmd+Alt+P' : 'Ctrl+Shift+B'}`,
    'Claude CmdOrCtrl+1', 'Browser CmdOrCtrl+2', 'Command Terminal CmdOrCtrl+3',
    'Files CmdOrCtrl+Shift+E', 'Source Control CmdOrCtrl+Shift+G', 'Skills CmdOrCtrl+Shift+K', 'MCP Servers CmdOrCtrl+Shift+M',
  ]) expect(items).toContain(want);
  // Next Project goes round in the rail's order.
  await tile(alpha).click();
  await app.evaluate(({ Menu }) => {
    const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
      for (const i of m?.items ?? []) {
        if (i.label === 'Next Project') return i;
        const inner = find(i.submenu ?? null);
        if (inner) return inner;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu())!.click();
  });
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
});

test('21. the frame stays usable in the smallest window, dark and light', async () => {
  await tile(alpha).click();
  await activity('files').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 560));
  // Window borders differ per platform, so the page is about 900 wide, not exactly.
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(920);
  // Nothing runs past the right edge of the window.
  const room = await page.evaluate(() => ({
    right: Math.max(...[...document.querySelectorAll('#workspace > .pane')].map((p) => p.getBoundingClientRect().right)),
    width: window.innerWidth,
  }));
  expect(room.right).toBeLessThanOrEqual(room.width);
  await expect(activity('mcp')).toBeVisible();
  await activity('mcp').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(__dirname, '..', 'screens', `frame-small-${process.platform}.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 245, 247)');
  await page.screenshot({ path: path.join(__dirname, '..', 'screens', `frame-small-light-${process.platform}.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await activity('files').click();
});

test('22. closing a project asks first; Cancel keeps it, Close ends its tabs and its page', async () => {
  const g = await idOf(gamma);
  await tile(gamma).click();
  await expect(visibleTabs('shell')).toHaveCount(1);

  await stubCloseAnswer(1);
  await page.evaluate((id) => (window as any).vibex.projects.close(id), g);
  await expect(tile(gamma)).toHaveCount(1);
  const alive = () => app.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().filter((t: any) => t.project === project).length, g);
  expect(await alive()).toBe(2);
  // Not only the list: the processes end too.
  const pids: number[] = await app.evaluate((_e, project) => {
    const t = (globalThis as any).__vibexTest.terminals;
    return t.list().filter((x: any) => x.project === project).map((x: any) => t.tabs.get(x.id).proc.pid);
  }, g);

  const client = await mcpClient(g);
  await tool(client, 'browser_navigate', { url: site.url });
  await client.close();
  await stubCloseAnswer(0);
  await page.evaluate((id) => (window as any).vibex.projects.close(id), g);
  await expect(tile(gamma)).toHaveCount(0);
  expect(await alive()).toBe(0);
  const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await expect.poll(() => pids.filter(running), { timeout: 15_000 }).toEqual([]);
  expect(await nativeView(g)).toBeNull();
  // The next tile takes the screen, and its tabs are the ones on screen.
  await expect(page.locator('.tile[aria-current="true"]')).toHaveCount(1);
  await expect(visibleTabs('shell')).not.toHaveCount(0);
});

test('23. a restart brings back the projects and the front one; the others start when shown', async () => {
  const [a, b] = [await idOf(alpha), await idOf(beta)];
  await tile(beta).click();
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  await activity('rail').click(); // the rail hidden stays hidden
  await activity('skills').click();
  await page.waitForFunction(() => localStorage.getItem('vibex.rail.hidden') === 'true');
  await app.close();

  await launch();
  await expect(page.locator('#rail')).toBeHidden();
  await activity('rail').click();
  await expect(page.locator('.tile .name')).toHaveText(['alpha-project', 'beta']);
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#sidebar-title')).toHaveText('Skills'); // per project, as it was left
  const tabsOf = (id: string) => app.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().filter((t: any) => t.project === project).length, id);
  expect(await tabsOf(b)).toBe(2);
  // No Claude starts for a project nobody asked for yet.
  expect(await tabsOf(a)).toBe(0);
  await tile(alpha).click();
  await expect(visibleTabs('shell')).toHaveCount(1);
  expect(await tabsOf(a)).toBe(2);
  await expect.poll(() => terminalText('agent'), { timeout: 45_000 }).toContain('AGENT-START-OK');
});

test('24. a saved folder that is gone drops off the rail and stays out of the list', async () => {
  await tile(beta).click();
  await app.close();
  rmSync(beta, { recursive: true, force: true });
  await launch();
  await expect(page.locator('.tile .name')).toHaveText(['alpha-project']);
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  await expect(visibleTabs('shell')).toHaveCount(1);
  mkdirSync(beta);
});

test('25. closing the last project goes back to the welcome view, with the recent projects', async () => {
  await stubCloseAnswer(0);
  await page.evaluate((id) => (window as any).vibex.projects.close(id), await idOf(alpha));
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#project-name')).toHaveText('');
  await expect(page.locator('#welcome .recent', { hasText: 'alpha-project' })).toHaveCount(1);
  await page.locator('#welcome .recent', { hasText: 'alpha-project' }).click();
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  await expect(visibleTabs('shell')).toHaveCount(1);
});

test('27. hiding the column with the keyboard in it moves the keyboard; Close Tab never ends a hidden tab', async () => {
  const focusIn = () => page.evaluate(() => document.activeElement?.closest('.terminal-pane')?.getAttribute('data-pane') ?? null);
  await pane('agent').locator('.term.active .xterm').click();
  expect(await focusIn()).toBe('agent');
  await activity('agent').click();
  await expect(pane('agent')).toBeHidden();
  await expect.poll(focusIn).toBe('shell');
  const id = await idOf(alpha);
  const count = (which: string) => app.evaluate((_e, [project, name]) => (globalThis as any).__vibexTest.terminals.list().filter((t: any) => t.project === project && t.pane === name).length, [id, which]);
  const claudeTabs = await count('agent');
  await pane('shell').locator('.new-tab').click();
  await expect(visibleTabs('shell')).toHaveCount(2);
  const closeTab = () => app.evaluate(({ Menu }) => {
    const find = (m: Electron.Menu | null): Electron.MenuItem | undefined => {
      for (const i of m?.items ?? []) {
        if (i.label === 'Close Tab') return i;
        const inner = find(i.submenu ?? null);
        if (inner) return inner;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu())!.click();
  });
  await closeTab();
  await expect(visibleTabs('shell')).toHaveCount(1);
  expect(await count('agent')).toBe(claudeTabs);
  await activity('agent').click();
  await expect.poll(focusIn).toBe('agent');
});

test('28. a tab that a tool call starts does not take the keyboard', async () => {
  const id = await idOf(alpha);
  await pane('shell').locator('.tab:visible .close').click();
  await expect(visibleTabs('shell')).toHaveCount(0);
  await pane('agent').locator('.term.active .xterm').click();
  const client = await mcpClient(id);
  expect(textOf(await tool(client, 'terminal_run', { command: 'echo from-tool' }))).toContain('from-tool');
  await expect(visibleTabs('shell')).toHaveCount(1);
  await expect(pane('agent').locator('.term.active .xterm-helper-textarea')).toBeFocused();
  await client.close();
});

test('29. with several projects open, a tool result names the project that acted', async () => {
  await openProject(beta);
  const client = await mcpClient(await idOf(alpha));
  expect(textOf(await tool(client, 'terminal_run', { command: 'echo named' }))).toContain('[project: alpha-project]');
  await client.close();
  await tile(alpha).click();
});

test('30. the page stays on its place at another zoom', async () => {
  const a = await idOf(alpha);
  const client = await mcpClient(a);
  await tool(client, 'browser_navigate', { url: site.url });
  await client.close();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await expect.poll(async () => {
    const [view, area] = [await nativeView(a), await placeholder()];
    return Math.abs(view!.width - area.width * 1.25) < 3 && Math.abs(view!.x - area.x * 1.25) < 3;
  }).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await expectViewOnPlaceholder(a);
});

test('32. shortcuts pressed in a terminal reach the app, and not the shell', async () => {
  // sendInputEvent goes the way a real key does, through the event the app reads; page.keyboard skips that event.
  const press = (keyCode: string, modifiers: string[]) => app.evaluate(({ BrowserWindow }, [key, mods]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key as string, modifiers: mods as any });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key as string, modifiers: mods as any });
  }, [keyCode, modifiers] as const);
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  await tile(alpha).click();
  await pane('agent').locator('.term.active .xterm').click();
  await press('3', [mod]);
  await expect(pane('shell')).toBeHidden();
  await press('3', [mod]);
  await expect(pane('shell')).toBeVisible();
  await pane('agent').locator('.term.active .xterm').click();
  await press('PageDown', ['control']);
  await expect(tile(beta)).toHaveAttribute('aria-current', 'true');
  await press('PageUp', ['control']);
  await expect(tile(alpha)).toHaveAttribute('aria-current', 'true');
  // A key that is no shortcut of the app stays with the terminal. Test 28 closed this project's shell, and the tabs of
  // tests 28 and 29 hold finished commands, which take no keys, so a person presses + here, as the tab itself says.
  await pane('shell').locator('.new-tab').click();
  await expect(pane('shell').locator('.tab[aria-selected="true"] .label')).not.toContainText('$ ');
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type('echo KEY-');
  await press('A', []);
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText()).toMatch(/KEY-a/i);

  // Each shortcut does its work, and nothing goes to the shell. All keys for a tab pass Terminals.write, so that is where
  // to look. A column that changes size makes a shell redraw, so its output says nothing.
  await app.evaluate(() => {
    const t = (globalThis as any).__vibexTest.terminals;
    const write = t.write.bind(t);
    (globalThis as any).__inputs = [];
    t.write = (id: number, data: string) => { (globalThis as any).__inputs.push(data); write(id, data); };
  });
  // PowerShell on Windows asks for focus reports, so xterm tells it when a column hides and shows (ESC [ I, ESC [ O). No key is in them.
  const inputs = () => app.evaluate(() => (globalThis as any).__inputs.splice(0).filter((d: string) => !/^\x1b\[[IO]$/.test(d)) as string[]);
  await pane('shell').locator('.term.active .xterm').click();
  // The witness: a plain key is seen here, so an empty list below means something.
  await press('X', []);
  await expect.poll(inputs).toEqual(['x']);
  await press('Backspace', []);
  await expect.poll(inputs).toHaveLength(1);
  const nothingReached = async () => {
    await page.waitForTimeout(300);
    expect(await inputs()).toEqual([]);
  };
  await press('3', [mod]);
  await expect(pane('shell')).toBeHidden();
  await press('3', [mod]);
  await expect(pane('shell')).toBeVisible();
  await nothingReached();
  if (mod === 'control') {
    await pane('shell').locator('.term.active .xterm').click();
    // Project Rail
    const railWidth = () => page.locator('#rail').evaluate((e) => e.getBoundingClientRect().width);
    const railBefore = await railWidth();
    await press('B', ['control', 'shift']);
    await expect.poll(railWidth).not.toBe(railBefore);
    await press('B', ['control', 'shift']);
    await expect.poll(railWidth).toBe(railBefore);
    await nothingReached();
    // Open Project asks for a folder.
    await app.evaluate(({ dialog }) => {
      (globalThis as any).__picked = 0;
      (dialog as any).showOpenDialog = async () => { (globalThis as any).__picked++; return { canceled: true, filePaths: [] }; };
    });
    await pane('shell').locator('.term.active .xterm').click();
    await press('O', ['control', 'shift']);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__picked)).toBe(1);
    await nothingReached();
    // Open Address takes the keyboard to the address bar.
    await pane('shell').locator('.term.active .xterm').click();
    await press('L', ['control', 'shift']);
    await expect(page.locator('#url')).toBeFocused();
    await nothingReached();
    // Open Server Project shows the picker.
    await pane('shell').locator('.term.active .xterm').click();
    await press('J', ['control', 'shift']);
    await expect(page.locator('#server-picker')).toBeVisible();
    await page.locator('#picker-cancel').click();
    await expect(page.locator('#server-picker')).toBeHidden();
    await nothingReached();
    // Reopen Closed Tab brings back the tab just closed.
    const fresh = await page.evaluate(() => (window as any).vibex.term.create('shell'));
    const count = async () => pane('shell').locator('.tab:visible').count();
    await expect.poll(count).toBeGreaterThan(0);
    const open = await count();
    await page.evaluate((id) => (window as any).vibex.term.close(id), fresh.id);
    await expect.poll(count).toBe(open - 1);
    await press('Y', ['control', 'shift']);
    await expect.poll(count).toBe(open);
  }
  await app.evaluate(() => { delete (globalThis as any).__vibexTest.terminals.write; });
});

test('26. a real Claude Code sends the project header together with its key', async () => {
  const { findClaude, mcpEntry } = await import('../src/main/claude');
  const claude = findClaude();
  if (!claude) test.skip(true, 'claude is not installed here');
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const config = path.join(dir, 'claude-header-check');
  mkdirSync(config);
  const helper = path.join(dir, 'helper.js');
  writeFileSync(helper, 'process.stdout.write(JSON.stringify({ Authorization: "Bearer from-helper" }));');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, VIBEX_WINDOW: 'project-under-test' };
  const entry = JSON.stringify(mcpEntry((server.address() as AddressInfo).port, `"${process.execPath.replace(/\\/g, '/')}" "${helper.replace(/\\/g, '/')}"`));
  // Not the sync call: the test server lives in this process and must answer while Claude waits.
  const run = (...args: string[]) => new Promise<void>((resolve) => {
    // The test server answers 401 on purpose, so a failed check is expected; only what Claude sent counts here.
    execFile(claude!, args, { env, timeout: 60_000 }, () => resolve());
  });
  await run('mcp', 'add-json', '--scope', 'user', 'vibex', entry);
  await run('mcp', 'list');
  server.close();
  const sent = seen.find((h) => h['x-vibex-window']);
  expect(sent?.['x-vibex-window']).toBe('project-under-test');
  expect(sent?.authorization).toBe('Bearer from-helper');
});

test('31. the window close button asks while work runs; Cancel keeps everything', async () => {
  // Only busy work asks (Swift #49 A1, A2): one command that keeps running in each of the two projects makes it busy.
  // Idle shell tabs alone ask nothing; running-work.spec.ts proves that count without a window, and a window
  // test for it would need the app to close for real, which ends this file's app.
  for (const folder of [alpha, beta]) {
    const client = await mcpClient(await idOf(folder));
    expect(textOf(await tool(client, 'terminal_run', { command: process.platform === 'win32' ? 'Start-Sleep 120' : 'sleep 120', wait: 0 }))).not.toBe('');
    await client.close();
  }
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__vibexTest.askOnClose = true;
    (globalThis as any).__asked = '';
    (dialog as any).showMessageBox = async (_w: unknown, o: { message: string; detail: string }) => {
      (globalThis as any).__asked = `${o.message} ${o.detail}`;
      return { response: 1, checkboxChecked: false };
    };
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(() => (globalThis as any).__asked)).toContain('Quit Vibex PCA?');
  expect(await app.evaluate(() => (globalThis as any).__asked)).toMatch(/commands? runs? in 2 projects/);
  await expect(page.locator('#workspace')).toBeVisible();
  const tabs = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().length);
  expect(tabs).toBeGreaterThan(0);

  // Exit, then Cancel: the tools must still work afterwards.
  await app.evaluate(({ app: a }) => a.quit());
  await page.waitForTimeout(300);
  const client = await mcpClient(await idOf(alpha));
  expect(textOf(await tool(client, 'terminal_run', { command: 'echo still-here' }))).toContain('still-here');
  await client.close();

  await app.evaluate(({ dialog }) => {
    (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
});

test('33. a signal from the system ends the app, with no question to wait for', async () => {
  test.skip(process.platform === 'win32', 'Windows has no SIGTERM');
  await launch();
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__vibexTest.askOnClose = true;
    (dialog as any).showMessageBox = () => new Promise(() => undefined); // nobody answers
  });
  const closed = app.waitForEvent('close');
  app.process().kill('SIGTERM');
  await closed;
});
