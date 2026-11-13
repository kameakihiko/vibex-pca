import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startSite, startSshServer, tempDir, firstWindow } from './fixtures';

// The proof build's acceptance checks, in the order of PORT-PLAN.md step 1. One app for the whole file.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let port: number;
let token: string;
let mcp: Client;
let ssh: Awaited<ReturnType<typeof startSshServer>>;
let site: Awaited<ReturnType<typeof startSite>>;
let dir: string;
let readyMs: number;

const shots = path.join(__dirname, '..', 'screens');

const pane = (name: 'agent' | 'shell') => page.locator(`.terminal-pane[data-pane="${name}"]`);

/// Text drawn in the active tab of the command terminal (right column) unless another pane is named.
async function terminalText(name: 'agent' | 'shell' = 'shell'): Promise<string> {
  return pane(name).locator('.term.active .xterm-rows').innerText();
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return mcp.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
}

function firstText(result: Awaited<ReturnType<typeof callTool>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

test.beforeAll(async () => {
  dir = tempDir('vibex-pca-test-');
  mkdirSync(shots, { recursive: true });
  ssh = await startSshServer(dir);
  site = await startSite();
  const userData = path.join(dir, 'profile');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([
    {
      name: 'test',
      host: '127.0.0.1',
      user: 'pca',
      port: ssh.port,
      identityFile: ssh.keyFile,
      options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' },
    },
    { name: 'bad', host: '-oProxyCommand=calc', user: 'pca' },
  ]));
  // These checks work inside one open project; tests/frame.spec.ts covers the welcome view and several projects.
  const project = path.join(dir, 'project');
  mkdirSync(project);
  writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [project] }));

  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: userData,
    VIBEX_MCP_PORT: '0',
    // The Claude tab starts a plain shell in tests; the real app starts `claude` there.
    VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
    // Claude registration (Windows and Linux) writes to a throw-away Claude config, never the real one.
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    // macOS dev runs only: keep the Keychain out of automated runs. Windows and Linux use the real store.
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
  } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  const started = Date.now();
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  readyMs = Date.now() - started;

  const hook = await app.evaluate(() => {
    const t = (globalThis as any).__vibexTest;
    return { token: t.token as string, port: t.status.mcpPort as number, error: t.status.mcpError as string | null, project: t.projects.current().id as string };
  });
  expect(hook.error).toBeNull();
  port = hook.port;
  token = hook.token;
  mcp = new Client({ name: 'vibex-pca-test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    // As a Claude started in a tab of this project sends it.
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Vibex-Window': hook.project } },
  }));
});

test.afterAll(async () => {
  await mcp?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  ssh?.close();
  site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('1. the window opens with a Claude tab, a terminal tab and the MCP server running', async () => {
  await expect(pane('agent').locator('.tab')).toHaveText(['Claude']);
  await expect(pane('shell').locator('.tab')).toHaveCount(1);
  await expect(page.locator('#mcp-chip')).toHaveText('MCP ready');
  // The Claude tab ran its start command through the real launch path (bash -l -c / pwsh -NoExit -Command).
  await expect.poll(() => terminalText('agent'), { timeout: 45_000 }).toContain('AGENT-START-OK');
  await expect(page.locator('#mcp-chip')).toHaveAttribute('title', new RegExp(`127\\.0\\.0\\.1:${port}`));
  const store = await app.evaluate(() => (globalThis as any).__vibexTest.status.tokenStore);
  // Windows (DPAPI) must use the OS store; Linux CI has no keyring, so memory is the expected fallback there.
  if (process.platform === 'win32') expect(store).toBe('os-store');
  test.info().annotations.push({ type: 'token store', description: String(store) });
});

test('2. keys typed in the terminal reach the shell and its output is drawn', async () => {
  await expect.poll(() => terminalText(), { timeout: 45_000 }).toMatch(/\S/);
  await pane('shell').locator('.term.active .xterm').click();
  // The shell computes 42, so the drawn result cannot be the typed echo of the command.
  await page.keyboard.type(process.platform === 'win32' ? 'echo PCA-TERM-$(20+22)' : 'echo PCA-TERM-$((20+22))');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('PCA-TERM-42');
});

test('3. the MCP server refuses calls without the token, from a browser, or with a foreign Host', async () => {
  expect(await rawPost({})).toBe(401);
  expect(await rawPost({ Authorization: 'Bearer wrong' })).toBe(401);
  expect(await rawPost({ Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).toBe(403);
  expect(await rawPost({ Authorization: `Bearer ${token}`, Host: `evil.example:${port}` })).toBe(403);
});

test('4. the MCP server lists the proof tools, the browser module\'s tools and the 2 project tools', async () => {
  const { tools } = await mcp.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    'browser_back', 'browser_click', 'browser_close_tab', 'browser_console', 'browser_evaluate', 'browser_forward', 'browser_navigate',
    'browser_new_tab', 'browser_press', 'browser_reload', 'browser_requests', 'browser_screenshot', 'browser_scroll', 'browser_select_tab',
    'browser_snapshot', 'browser_tabs', 'browser_text', 'browser_type', 'browser_wait',
    'notes_search', 'server_connect', 'server_list', 'terminal_output', 'terminal_run', 'terminal_tabs', 'vibex_focus', 'vibex_go_status', 'vibex_layout', 'vibex_notify',
    'vibex_open_project', 'vibex_preview', 'vibex_projects', 'vibex_request_go', 'vibex_run', 'vibex_run_status', 'vibex_stop', 'vibex_usage', 'vibex_view',
  ]);
});

test('5. terminal_run runs a command in the visible tab and returns its output', async () => {
  const out = firstText(await callTool('terminal_run', { command: 'echo mcp-run-ok' }));
  expect(out).toContain('mcp-run-ok');
  // A tab of its own, in the column the person watches.
  await expect(pane('shell').locator('.tab .label', { hasText: '$ echo mcp-run-ok' })).toHaveCount(1);
});

test('6. claude starts in the terminal', async () => {
  const out = firstText(await callTool('terminal_run', { command: 'claude --version', wait: 50 }));
  const found = /\d+\.\d+\.\d+/.test(out) && /claude/i.test(out);
  if (!found && process.env.VIBEX_EXPECT_CLAUDE !== '1') test.skip(true, `claude is not installed here: ${out.slice(0, 200)}`);
  expect(out).toMatch(/\d+\.\d+\.\d+ \(Claude Code\)/);
});

test('7. a server profile opens an ssh tab and the remote shell answers', async () => {
  // The profile with a bad host is dropped; the first profile is the one primary button.
  await expect(page.locator('button.server')).toHaveText(['Connect test']);
  await expect(page.locator('button.server.primary')).toHaveCount(1);
  // A tool's finished command may have a tab here too.
  const before = await pane('shell').locator('.tab').count();
  await page.locator('button.server', { hasText: 'Connect test' }).click();
  await expect(pane('shell').locator('.tab')).toHaveCount(before + 1);
  await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('pca-test$');
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type('hello-from-vibex');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(), { timeout: 15_000 }).toContain('PCA-SSH-OK hello-from-vibex');
  await page.screenshot({ path: path.join(shots, `ssh-${process.platform}.png`) });
});

test('8. the browser tools drive a page: navigate, snapshot, type, click, text, screenshot', async () => {
  expect(firstText(await callTool('browser_navigate', { url: site.url }))).toContain('PCA test page');
  const snap = firstText(await callTool('browser_snapshot'));
  const box = /textbox "Name" \[ref=(e\d+)\]/.exec(snap);
  const button = /button "Greet" \[ref=(e\d+)\]/.exec(snap);
  expect(box, snap).not.toBeNull();
  expect(button, snap).not.toBeNull();
  await callTool('browser_type', { ref: box![1], text: 'PCA' });
  await callTool('browser_click', { ref: button![1] });
  expect(firstText(await callTool('browser_text'))).toContain('Hello, PCA');
  const shot = await callTool('browser_screenshot', { maxWidth: 640 });
  const image = (shot.content as { type: string; data?: string; mimeType?: string }[])[0];
  expect(image.type).toBe('image');
  expect(image.mimeType).toBe('image/jpeg');
  const jpeg = Buffer.from(image.data!, 'base64');
  expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
  // The window screenshot below cannot see the native browser view, so keep the tool's own image too.
  writeFileSync(path.join(shots, `browser-${process.platform}.jpg`), jpeg);
  await expect(page.locator('#url')).toHaveValue(site.url);
  await page.screenshot({ path: path.join(shots, `window-${process.platform}.png`) });
});

test('9. a stale ref gives a clear error instead of clicking the wrong element', async () => {
  const result = await callTool('browser_click', { ref: 'e9999' });
  expect(result.isError).toBe(true);
  expect(firstText(result)).toContain('call browser_snapshot again');
});

test('10. a wrong address shows why next to the address bar and keeps what was typed', async () => {
  await page.locator('#url').fill('http://127.0.0.1:1/');
  await page.locator('#url').press('Enter');
  await expect(page.locator('#browser-error')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#browser-error')).toContainText('Could not open http://127.0.0.1:1/: the browser blocks this port for safety');
  await expect(page.locator('#url')).toHaveValue('http://127.0.0.1:1/');
  await expect(page.locator('#urlbar')).not.toHaveClass(/loading/);
});

test('11. an ended ssh connection reconnects with Enter', async () => {
  await pane('shell').locator('.tab', { hasText: 'test' }).click();
  await pane('shell').locator('.term.active .xterm').click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  // A narrow column wraps the notice across rows, so compare without line breaks.
  await expect.poll(async () => (await terminalText()).replace(/\n/g, ''), { timeout: 15_000 }).toContain('Press Enter to reconnect');
  const before = await pane('shell').locator('.tab').count();
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('pca-test$');
  await expect(pane('shell').locator('.tab')).toHaveCount(before); // the old tab is replaced, not left behind
  await page.keyboard.type('again');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(), { timeout: 15_000 }).toContain('PCA-SSH-OK again');
});

// Kill criteria for Electron versus Tauri, written in electron/PROOF.md before the first CI run.
test('12. start time and memory stay inside the kill criteria', async () => {
  // The memory that is the app's own: private memory. A working set also counts the pages a process shares, and each process
  // of the app counts the same shared pages again (Chromium's code, the maps of the GPU process), so that sum says more than
  // the app takes, by an amount that changes with the computer. Windows gives the private bytes of a process; on Linux
  // /proc gives them. Where neither is there (macOS), or one process cannot be read, the working set is judged, which is stricter.
  const parts = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, workingKb: m.memory.workingSetSize, privateKb: m.memory.privateBytes ?? null })));
  const linuxPrivateKb = (pid: number): number | null => {
    try {
      const lines = [...readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+) kB$/gm)];
      return lines.length ? lines.reduce((sum, line) => sum + Number(line[1]), 0) : null;
    } catch {
      return null;
    }
  };
  const own = parts.map((part) => part.privateKb ?? (process.platform === 'linux' ? linuxPrivateKb(part.pid) : null));
  const measure = parts.length > 0 && own.every((kb) => kb !== null) ? 'private' : 'working set';
  const workingSetMb = Math.round(parts.reduce((sum, part) => sum + part.workingKb, 0) / 1024);
  const memoryMb = measure === 'private' ? Math.round(own.reduce((sum: number, kb) => sum + (kb ?? 0), 0) / 1024) : workingSetMb;
  const metrics = { platform: process.platform, packaged: !!process.env.VIBEX_APP_EXECUTABLE, readyMs, memoryMb, measure, workingSetMb, processes: parts.length };
  console.log(`metrics ${JSON.stringify(metrics)}`);
  writeFileSync(path.join(shots, `metrics-${process.platform}-${metrics.packaged ? 'installed' : 'source'}.json`), JSON.stringify(metrics, null, 2));
  test.info().annotations.push({ type: 'metrics', description: JSON.stringify(metrics) });
  expect(readyMs).toBeLessThan(15_000);
  expect(memoryMb, JSON.stringify(metrics)).toBeLessThan(800);
});

test('13. every command is in the menu bar with its shortcut', async () => {
  const items = await app.evaluate(({ Menu }) => {
    const out: string[] = [];
    const walk = (m: Electron.Menu | null) => m?.items.forEach((i) => {
      if (i.label) out.push(`${i.label}${i.accelerator ? ' ' + i.accelerator : ''}`);
      walk(i.submenu ?? null);
    });
    walk(Menu.getApplicationMenu());
    return out;
  });
  for (const want of ['New Claude Tab CmdOrCtrl+Shift+N', 'New Terminal Tab CmdOrCtrl+Shift+T', 'Close Tab CmdOrCtrl+Shift+W', 'Next Tab Ctrl+Tab', 'Connect test', `Open Address ${process.platform === 'darwin' ? 'Cmd+L' : 'Ctrl+Shift+L'}`, 'Reload Page F5']) {
    expect(items).toContain(want);
  }
});

test('14. the light system appearance gets the light palette; terminals stay dark as in macOS Vibex', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 245, 247)');
  await expect(pane('shell').locator('.term.active .xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(18, 18, 22)');
  await page.screenshot({ path: path.join(shots, `window-light-${process.platform}.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('15. the Vibex look: Untitled UI icons, Google Sans, three columns that resize', async () => {
  expect(await page.locator('.tab-icon svg').count()).toBeGreaterThanOrEqual(3);
  expect(await page.locator('#urlbar .icon-button svg').count()).toBe(3);
  expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('13px "Google Sans"'); })).toBe(true);
  const widthOf = () => pane('agent').evaluate((e) => e.getBoundingClientRect().width);
  const before = await widthOf();
  const box = (await page.locator('.splitter').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await widthOf()) - before)).toBeGreaterThanOrEqual(70);
  await page.locator('.splitter').first().dblclick(); // back to the default widths
  await page.screenshot({ path: path.join(shots, `window-dark-${process.platform}.png`) });
});

test('16. terminal_run stays correct after a big output, and a failing command returns at once', async () => {
  const big = process.platform === 'win32' ? "Write-Output ('x' * 500000)" : "head -c 500000 /dev/zero | tr '\\0' 'x'; echo";
  await callTool('terminal_run', { command: big, wait: 50 });
  const after = firstText(await callTool('terminal_run', { command: 'echo after-big-output', wait: 30 }));
  expect(after).toContain('after-big-output');
  expect(after).not.toContain('timed out');
  const started = Date.now();
  const failing = process.platform === 'win32' ? "Get-Item C:\\no-such-file -ErrorAction Stop" : 'false # a trailing comment';
  const out = firstText(await callTool('terminal_run', { command: failing, wait: 30 }));
  expect(out).not.toContain('timed out');
  expect(Date.now() - started).toBeLessThan(15_000);
});

test('17. the side browser refuses local files and other apps\' links', async () => {
  const result = await callTool('browser_navigate', { url: process.platform === 'win32' ? 'file:///C:/Windows/win.ini' : 'file:///etc/hosts' });
  expect(result.isError).toBe(true);
  expect(firstText(result)).toContain('only web addresses');
});

test('18. Claude Code reaches the MCP server through the registration (key fetched from the system store)', async () => {
  // The registration runs beside the window: two `claude mcp` runs, and on Windows the first read of the key, which on a new
  // profile waits for Chromium to write its key file (src/main/claude.ts). This test starts about 16 s after the app.
  const status = () => app.evaluate(() => (globalThis as any).__vibexTest.status.claude as string);
  await expect.poll(status, { timeout: 90_000 }).not.toBe('registering with Claude Code');
  const claudeStatus: string = await status();
  test.info().annotations.push({ type: 'claude registration', description: claudeStatus });
  if (claudeStatus !== 'registered') {
    // Windows CI has the native claude.exe and DPAPI, so there it must register.
    expect(process.platform === 'win32' && process.env.VIBEX_EXPECT_CLAUDE === '1').toBe(false);
    test.skip(true, claudeStatus);
  }
  const { findClaude } = await import('../src/main/claude');
  const { execFileSync } = await import('node:child_process');
  const listed = execFileSync(findClaude()!, ['mcp', 'list'], {
    // Claude runs the helper with this environment. The key is in the test profile, not where a real app keeps it.
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'), VIBEX_TEST: '1', VIBEX_USER_DATA: path.join(dir, 'profile') },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(listed).toMatch(/vibex.*Connected/);
});
