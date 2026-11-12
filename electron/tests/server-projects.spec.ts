import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startSite, startSshServer, tempDir, firstWindow, logWindowsProcesses } from './fixtures';

// A rail tile can be a folder on a server: the person works project by project there, over the system ssh.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let userData: string;
let local: string;
let ssh: Awaited<ReturnType<typeof startSshServer>>;
let site: Awaited<ReturnType<typeof startSite>>;
let downPort: number;
const commands: string[] = [];

/// The test server's home holds these folders; every other remote command is an interactive session.
function onExec(sent: string): string | null {
  // Remote commands travel as base64 for /bin/sh; keep the script they carry.
  const encoded = /printf %s (\S+) \|/.exec(sent)?.[1];
  const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : sent;
  commands.push(command);
  return command.includes('ls -1d') ? 'app-one/\nledger/\nnotes.txt\n' : null;
}

function writeProfiles(list: object[]): void {
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify(list));
}

const testServer = () => ({
  name: 'test', host: '127.0.0.1', user: 'pca', port: ssh.port, identityFile: ssh.keyFile, allowClaude: true,
  options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' },
});

async function launch(): Promise<void> {
  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: userData,
    VIBEX_MCP_PORT: '0',
    VIBEX_AGENT_COMMAND: 'echo AGENT-ON-SERVER',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
}

const tile = (name: string) => page.locator('.tile', { hasText: name });
const pane = (name: 'agent' | 'shell') => page.locator(`.terminal-pane[data-pane="${name}"]`);
const visibleTabs = (name: 'agent' | 'shell') => pane(name).locator('.tab:visible');
const terminalText = (name: 'agent' | 'shell' = 'shell') => pane(name).locator('.term.active .xterm-rows').innerText();

async function mcpClient(windowId?: string): Promise<Client> {
  const hook = await app.evaluate(() => {
    const t = (globalThis as any).__vibexTest;
    return { token: t.token as string, port: t.status.mcpPort as number };
  });
  const client = new Client({ name: 'vibex-server-test', version: '1.0.0' });
  const headers: Record<string, string> = { Authorization: `Bearer ${hook.token}` };
  if (windowId) headers['X-Vibex-Window'] = windowId;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers } }));
  return client;
}

test.beforeAll(async () => {
  dir = tempDir('vibex-server-test-');
  userData = path.join(dir, 'profile');
  mkdirSync(userData);
  local = path.join(dir, 'local-work');
  mkdirSync(local);
  local = realpathSync.native(local);
  ssh = await startSshServer(dir, onExec);
  site = await startSite();
  downPort = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  writeProfiles([testServer(), { ...testServer(), name: 'down', port: downPort, options: { ...testServer().options, ConnectTimeout: '3' } }]);
  writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [local] }));
  await launch();
});

test.afterEach(({}, info) => { if (info.status !== info.expectedStatus) logWindowsProcesses(info.title); });

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  ssh?.close();
  site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('1. the picker lists the folders in the home on the server, and only folders', async () => {
  await page.locator('#url').fill(site.url);
  await page.locator('#url').press('Enter');
  await expect(page.locator('#page-title')).toHaveText('PCA test page');
  await page.locator('#rail-open-server').click();
  await expect(page.locator('#server-picker')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  // The native page lies over everything, so it must leave while the picker shows.
  const visible = await app.evaluate(() => [...(globalThis as any).__vibexTest.browsers.values()].map((b: any) => b.view.getVisible()));
  expect(visible).toEqual([false]);
  await expect(page.locator('#picker-servers button')).toHaveText(['test', 'down']);
  await expect(page.locator('#picker-folders button')).toHaveText(['app-one', 'ledger']);
  expect(commands.some((c) => c.includes('ls -1d'))).toBe(true);
});

test('2. a server that does not answer says so in plain words; another one still works', async () => {
  await page.locator('#picker-servers button', { hasText: 'down' }).click();
  await expect(page.locator('#picker-error')).toContainText('Could not reach down', { timeout: 30_000 });
  await expect(page.locator('#picker-folders button')).toHaveCount(0);
  await page.locator('#picker-servers button', { hasText: 'test' }).click();
  await expect(page.locator('#picker-folders button')).toHaveCount(2);
  await expect(page.locator('#picker-error')).toBeHidden();
});

test('3. Cancel goes back to the project and its page', async () => {
  await page.locator('#picker-cancel').click();
  await expect(page.locator('#server-picker')).toBeHidden();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect.poll(() => app.evaluate(() => [...(globalThis as any).__vibexTest.browsers.values()].map((b: any) => b.view.getVisible()))).toEqual([true]);
});

test('4. a folder opens as a tile; Claude and the terminal run in it on the server', async () => {
  commands.length = 0;
  await page.locator('#rail-open-server').click();
  await page.locator('#picker-folders button', { hasText: 'ledger' }).click();
  await expect(page.locator('#server-picker')).toBeHidden();
  await expect(tile('ledger')).toHaveAttribute('aria-current', 'true');
  await expect(tile('ledger')).toHaveAttribute('data-server', 'test');
  await expect(tile('ledger').locator('.server-mark')).toHaveCount(1);
  await expect(tile('local-work').locator('.server-mark')).toHaveCount(0);
  await expect(page.locator('#project-name')).toHaveText('ledger · test');
  await expect(visibleTabs('agent')).toHaveCount(1);
  await expect(visibleTabs('shell')).toHaveCount(1);
  await expect.poll(() => commands.filter((c) => c.includes('"$HOME"/\'ledger\'')).length, { timeout: 30_000 }).toBe(2);
  expect(commands.some((c) => c.includes(`'echo AGENT-ON-SERVER'`))).toBe(true);
  // The keys reach the server, over the real ssh of this computer.
  await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('pca-test$');
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type('hello-ledger');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(), { timeout: 15_000 }).toContain('PCA-SSH-OK hello-ledger');
  await page.screenshot({ path: path.join(__dirname, '..', 'screens', `server-project-${process.platform}.png`) });
});

test('4b. the screen says that Claude on the server has the tools, because it does', async () => {
  await expect(page.locator('#mcp-chip')).toHaveText('MCP ready');
  await expect(page.locator('#browser-empty-text')).toContainText('ask Claude');
  await page.locator('#activity [data-activity="mcp"]').click();
  await expect(page.locator('#sidebar-body')).toContainText('reaches the Vibex tools through the ssh connection');
  await page.locator('#activity [data-activity="mcp"]').click();
  await tile('local-work').click();
  await expect(page.locator('#mcp-chip')).toHaveText('MCP ready');
  await expect(page.locator('#browser-empty-text')).toContainText('ask Claude');
  await tile('ledger').click();
});

test('4c. picking a tile, or Escape, leaves the picker', async () => {
  await page.locator('#rail-open-server').click();
  await expect(page.locator('#server-picker')).toBeVisible();
  await tile('local-work').click();
  await expect(page.locator('#server-picker')).toBeHidden();
  await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('#rail-open-server').click();
  await page.locator('#picker-path').press('Escape');
  await expect(page.locator('#server-picker')).toBeHidden();
  await tile('ledger').click();
});

test('5. a typed folder with a quote in its name stays one folder; a bad one is refused', async () => {
  commands.length = 0;
  await page.locator('#rail-open-server').click();
  await page.locator('#picker-path').fill('relative/path');
  await page.locator('#picker-path').press('Enter');
  await expect(page.locator('#picker-error')).toContainText('folder');
  await expect(page.locator('#server-picker')).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(2);
  await page.locator('#picker-path').fill("/srv/it's mine");
  await page.locator('#picker-open').click();
  await expect(tile("it's mine")).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => commands.filter((c) => c.includes(`cd -- '/srv/it'\\''s mine' || {`)).length, { timeout: 30_000 }).toBe(2);
});

test('6. the same folder again selects its tile; each project keeps its own tabs', async () => {
  await page.locator('#rail-open-server').click();
  await expect(page.locator('#picker-folders button, #picker-error:not([hidden])').first()).toBeVisible({ timeout: 25_000 });
  if (await page.locator('#picker-error:not([hidden])').count()) {
    // Seen twice on Windows, then not again: this says why, in place of a bare time-out.
    // Not spawnSync: the made-up ssh server runs in this Node process, and a synchronous run would stop it from answering.
    const said = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('ssh', ['-v', '-o', 'BatchMode=yes', '-o', `UserKnownHostsFile=${ssh.knownHosts}`, '-o', 'IdentitiesOnly=yes', '-i', ssh.keyFile, '-p', String(ssh.port), 'pca@127.0.0.1', 'ls -1d */'], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 20_000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${e.message}` }); });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    console.log(`the list failed: ${await page.locator('#picker-error').innerText()}\nssh by hand: ${said.status} ${said.stdout} ${said.stderr}`);
  }
  await page.locator('#picker-folders button', { hasText: 'ledger' }).click();
  await expect(page.locator('.tile')).toHaveCount(3);
  await expect(tile('ledger')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => terminalText()).toContain('PCA-SSH-OK hello-ledger');
  await tile('local-work').click();
  await expect.poll(() => terminalText()).not.toContain('PCA-SSH-OK hello-ledger');
  await tile('ledger').click();
  await expect.poll(() => terminalText()).toContain('PCA-SSH-OK hello-ledger');
});

test('7. the Files sidebar names the server and the folder, and offers no local file manager', async () => {
  await page.locator('#activity [data-activity="files"]').click();
  await expect(page.locator('#sidebar-body')).toContainText('test');
  await expect(page.locator('#sidebar-body')).toContainText('~/ledger');
  await expect(page.locator('#sidebar-body button')).toHaveCount(0);
  await page.locator('#activity [data-activity="files"]').click();
});

test('8. an ended connection reconnects with Enter, to the same folder', async () => {
  commands.length = 0;
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await terminalText()).replace(/\n/g, ''), { timeout: 15_000 }).toContain('Press Enter to reconnect');
  await page.keyboard.press('Enter');
  await expect.poll(() => commands.filter((c) => c.includes('"$HOME"/\'ledger\'')).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('pca-test$');
  await expect(visibleTabs('shell')).toHaveCount(1);
});

test('9. tools see a server project, run a command there in a login of its own, and cannot type into it or open one', async () => {
  const id = await tile('ledger').getAttribute('data-project');
  const client = await mcpClient(id!);
  const listed = await client.callTool({ name: 'vibex_projects', arguments: {} });
  expect((listed.content as { text: string }[])[0].text).toContain('* ledger  test:~/ledger');
  commands.length = 0;
  const run = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo yes', timeout: 2 } });
  expect(run.isError).toBeFalsy();
  await expect.poll(() => commands.filter((c) => c.includes('echo yes')).length, { timeout: 15_000 }).toBe(1);
  // The path of a folder on a server is not a local folder.
  const open = await client.callTool({ name: 'vibex_open_project', arguments: { path: '/srv/made-up-by-a-tool' } });
  expect(open.isError).toBe(true);
  await expect(page.locator('.tile')).toHaveCount(3);
  // A tab number of the server project does not help: an ssh tab takes no typed tool command.
  const tab = await app.evaluate((_e, project) => (globalThis as any).__vibexTest.terminals.list().find((t: any) => t.project === project && t.pane === 'shell').id, id);
  const byTab = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo no', tab } });
  expect(byTab.isError).toBe(true);
  expect(commands.filter((c) => c.includes('echo no'))).toEqual([]);
  await client.close();
});

test('10. a restart restores the tiles; a server project connects when it is first shown', async () => {
  await tile('ledger').click();
  await tile('local-work').click();
  await app.close();
  commands.length = 0;
  await launch();
  await expect(page.locator('.tile .name')).toHaveText(['local-work', 'ledger', "it's mine"]);
  await expect(tile('ledger').locator('.server-mark')).toHaveCount(1);
  await expect(tile('local-work')).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(800);
  expect(commands).toEqual([]);
  await tile('ledger').click();
  await expect.poll(() => commands.filter((c) => c.includes('"$HOME"/\'ledger\'')).length, { timeout: 30_000 }).toBe(2);
});

test('11. a closed server project is in the recents with its server, and opens from there', async () => {
  await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  for (const name of ["it's mine", 'ledger', 'local-work']) {
    const id = await tile(name).getAttribute('data-project');
    await page.evaluate((p) => (window as any).vibex.projects.close(p), id);
    await expect(tile(name)).toHaveCount(0);
  }
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#welcome-open-server')).toBeVisible();
  const recent = page.locator('#welcome .recent', { hasText: 'ledger' });
  await expect(recent).toContainText('test:~/ledger');
  await recent.click();
  await expect(tile('ledger')).toHaveAttribute('aria-current', 'true');
  await expect(visibleTabs('shell')).toHaveCount(1);
});

test('12. a server whose profile is gone leaves the rail at the next start, and no ssh runs', async () => {
  await app.close();
  writeProfiles([]);
  commands.length = 0;
  await launch();
  await expect(page.locator('.tile')).toHaveCount(0);
  await expect(page.locator('#welcome')).toBeVisible();
  expect(commands).toEqual([]);
  // The way to the form that adds the first server stays.
  await page.locator('#welcome-open-server').click();
  await expect(page.locator('#picker-add')).toBeVisible();
  await expect(page.locator('#picker-edit')).toBeHidden();
  await expect(page.locator('#picker-form')).toBeHidden();
  await page.locator('#picker-cancel').click();
});
