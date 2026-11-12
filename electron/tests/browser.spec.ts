import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tempDir, firstWindow } from './fixtures';

// The browser of Vibex PCA: several page tabs per project, the 13 tab and page tools, sleeping tabs, vibex_preview.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dir: string;
let userData: string;
let project: string;
let site: { url: string; close: () => void; hits: string[] };
let client: Client;
let port: number;
let token: string;

/// A small site: two pages, a long page with a console message and two fetches, and one slow page.
async function startPages(): Promise<typeof site> {
  const hits: string[] = [];
  const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    if (url.startsWith('/api/ok')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end('{"ok":true}');
    }
    if (url.startsWith('/api/missing')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return void res.end('{"ok":false}');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.startsWith('/b')) return void res.end(html('Page B', '<h1>Second page</h1><a id="home" href="/">home</a>'));
    if (url.startsWith('/long')) {
      return void res.end(html('Long page', `<input id="box" aria-label="Search box"><p id="keys"></p>
<script>
  document.getElementById('box').addEventListener('keydown', (e) => { document.getElementById('keys').textContent += e.key + ';'; });
  console.log('hello-console');
  console.error('bad-console');
  fetch('/api/ok'); fetch('/api/missing');
  setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'late arrival'; document.body.append(p); }, 600);
</script>
<div style="height:5000px">tall</div><p id="end">the end</p>`));
    }
    res.end(html('Page A', '<h1>First page</h1><a id="next" href="/b">to b</a>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), hits };
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
  client = new Client({ name: 'vibex-browser-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: { project_path: project, ...args } }, undefined, { timeout: 90_000 });
}
const textOf = (result: Awaited<ReturnType<typeof tool>>): string => (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
const say = async (name: string, args: Record<string, unknown> = {}) => textOf(await tool(name, args));

/// What the main process knows of the project's tabs (test hook).
const inner = () => app.evaluate(() => [...(globalThis as any).__vibexTest.browsers.values()][0]?.debug() ?? null);
/// Resident memory of every process the app runs, in MB, and of one process by pid.
const memory = (pid?: number) => app.evaluate(({ app }, which) => {
  const all = app.getAppMetrics();
  const mb = (kb: number) => Math.round(kb / 1024);
  return { total: mb(all.reduce((sum, p) => sum + p.memory.workingSetSize, 0)), one: which ? mb(all.find((p) => p.pid === which)?.memory.workingSetSize ?? 0) : 0, alive: which ? all.some((p) => p.pid === which) : false };
}, pid);

test.beforeAll(async () => {
  dir = tempDir('vibex-browser-test-');
  userData = path.join(dir, 'profile');
  mkdirSync(userData);
  mkdirSync(path.join(dir, 'alpha'));
  project = realpathSync.native(path.join(dir, 'alpha'));
  site = await startPages();
  await launch();
  await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
  await page.waitForSelector('#workspace:not([hidden])');
});

test.afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('1. the server lists the 13 new browser tools and vibex_preview', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['browser_tabs', 'browser_new_tab', 'browser_select_tab', 'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload',
    'browser_scroll', 'browser_press', 'browser_wait', 'browser_evaluate', 'browser_console', 'browser_requests', 'vibex_preview']) {
    expect(names, name).toContain(name);
  }
});

test('2. tabs: open, list, select, navigate one tab, close', async () => {
  const first = await say('browser_new_tab', { url: `${site.url}/` });
  expect(first).toContain('Opened tab #1');
  const second = await say('browser_new_tab', { url: `${site.url}/b` });
  expect(second).toContain('Opened tab #2');
  const list = await say('browser_tabs');
  expect(list).toMatch(/ {2}#1 {2}Page A {2}http:\/\/127\.0\.0\.1:\d+\/\n\* #2 {2}Page B/);
  // A tool with a tab number acts on that tab and leaves the selected one alone.
  expect(await say('browser_text', { tab: 1 })).toContain('First page');
  expect(await say('browser_text')).toContain('Second page');
  expect(await say('browser_select_tab', { tab: 1 })).toBe('Selected.');
  expect(await say('browser_tabs')).toMatch(/\* #1 {2}Page A/);
  const missing = await tool('browser_text', { tab: 9 });
  expect(missing.isError).toBe(true);
  expect(textOf(missing)).toContain('no tab #9');
  expect(await say('browser_close_tab', { tab: 2 })).toBe('Closed.');
  expect(await say('browser_tabs')).not.toContain('#2');
});

test('3. back, forward and reload move one tab through its history', async () => {
  await say('browser_navigate', { url: `${site.url}/b` });
  expect(await say('browser_back')).toContain('Page A');
  expect(await say('browser_forward')).toContain('Page B');
  const before = site.hits.length;
  expect(await say('browser_reload')).toContain('Page B');
  expect(site.hits.length).toBeGreaterThan(before);
});

test('4. wait, scroll, press, evaluate, console and requests work on a long page', async () => {
  await say('browser_navigate', { url: `${site.url}/long` });
  expect(await say('browser_wait', { selector: '#late', timeout: 10 })).toBe('found');
  expect(await say('browser_wait', { text: 'late arrival', timeout: 10 })).toBe('found');
  expect(await say('browser_wait', { ms: 50 })).toBe('waited');
  const timedOut = await tool('browser_wait', { selector: '#never', timeout: 1 });
  expect(timedOut.isError).toBe(true);
  expect(textOf(timedOut)).toContain('timed out waiting for #never');

  await say('browser_scroll', { dy: 1200 });
  expect(JSON.parse(await say('browser_evaluate', { js: 'window.scrollY' }))).toBeGreaterThan(1000);

  const snap = await say('browser_snapshot');
  const box = /textbox "Search box" \[ref=(e\d+)\]/.exec(snap);
  expect(box, snap).not.toBeNull();
  await say('browser_click', { ref: box![1] });
  await say('browser_press', { key: 'Enter' });
  await say('browser_press', { key: 'a' });
  expect(JSON.parse(await say('browser_evaluate', { js: "document.getElementById('keys').textContent" }))).toBe('Enter;a;');

  expect(JSON.parse(await say('browser_evaluate', { js: 'Promise.resolve({ sum: 1 + 2 })' }))).toEqual({ sum: 3 });
  expect(await say('browser_evaluate', { js: 'undefined' })).toBe('undefined');
  expect(await say('browser_evaluate', { js: 'throw new Error("boom")' })).toContain('Error: ');

  const consoleText = await say('browser_console');
  expect(consoleText).toMatch(/\d\d:\d\d:\d\d \[log\] hello-console/);
  expect(consoleText).toMatch(/\[error\] bad-console/);
  expect(await say('browser_console', { level: 'error' })).not.toContain('hello-console');
  await say('browser_console', { clear: true });
  expect(await say('browser_console')).toBe('No console output.');

  const requests = await say('browser_requests');
  expect(requests).toMatch(/GET http:\/\/127\.0\.0\.1:\d+\/api\/ok → 200 \d+ms/);
  expect(requests).toMatch(/GET http:\/\/127\.0\.0\.1:\d+\/api\/missing → 404 \d+ms/);
  const failed = await say('browser_requests', { failedOnly: true });
  expect(failed).toContain('/api/missing');
  expect(failed).not.toContain('/api/ok');
  await say('browser_requests', { clear: true });
  expect(await say('browser_requests')).toBe('No requests recorded.');
});

test('5. the tab strip shows page tabs next to the document tabs, with one address per tab', async () => {
  await say('browser_new_tab', { url: `${site.url}/b` });
  await page.locator('#page-tabs .tab').first().click();
  await expect(page.locator('#page-tabs .tab')).toHaveCount(2);
  // The document tabs keep their place after the page tabs.
  const order = await page.locator('#browser-tabs').evaluate((nav) => {
    const kids = [...nav.querySelectorAll('#page-tabs, #doc-tabs, #new-page-tab')].map((e) => e.id);
    return kids;
  });
  expect(order).toEqual(['page-tabs', 'doc-tabs', 'new-page-tab']);
  await expect(page.locator('#page-tabs .tab[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('#url')).toHaveValue(`${site.url}/long`);
  await page.locator('#page-tabs .tab').nth(1).click();
  await expect(page.locator('#url')).toHaveValue(`${site.url}/b`);
  await expect(page.locator('#page-title')).toHaveText('Page B');
  // A tab opened by the plus button is empty and has its own address bar.
  await page.locator('#new-page-tab').click();
  await expect(page.locator('#page-tabs .tab')).toHaveCount(3);
  await expect(page.locator('#url')).toHaveValue('');
  await page.locator('#url').fill(`${site.url}/`);
  await page.locator('#url').press('Enter');
  await expect(page.locator('#page-title')).toHaveText('Page A');
  await page.locator('#page-tabs .tab').nth(1).click();
  await expect(page.locator('#url')).toHaveValue(`${site.url}/b`);
  // Closing a tab removes it; the last tab never closes into nothing.
  await page.locator('#page-tabs .tab').nth(2).locator('.close').click();
  await expect(page.locator('#page-tabs .tab')).toHaveCount(2);
  await page.screenshot({ path: path.join(__dirname, '..', 'screens', `browser-tabs-${process.platform}.png`) });
});

test('6. only the selected tab shows its native view', async () => {
  const state = await inner();
  expect(state.tabs.filter((t: any) => t.visible)).toHaveLength(1);
  expect(state.tabs.find((t: any) => t.visible).active).toBe(true);
});

test('7. a tab that is idle sleeps: its renderer process ends and the memory is freed, and it wakes where it was', async () => {
  // Tab 1 shows the long page; tab 3 is selected.
  const idle = 1;
  expect(await say('browser_tabs')).toMatch(/ {2}#1 {2}Long page/);
  // Make the idle tab heavy so that the effect is clear.
  await say('browser_evaluate', { tab: idle, js: 'window.__big = new Uint8Array(150 * 1024 * 1024).fill(7); window.__big.length' });
  const awake = (await inner()).tabs.find((t: any) => t.number === idle);
  expect(awake.pid).toBeGreaterThan(0);
  const before = await memory(awake.pid);
  expect(before.alive).toBe(true);
  console.log(`MEMORY before sleep: tab process ${before.one} MB, all processes ${before.total} MB`);
  await page.waitForTimeout(500);

  const slept = await app.evaluate(async () => [...(globalThis as any).__vibexTest.browsers.values()][0].sleepIdle(Date.now() + 11 * 60_000));
  expect(slept).toContain(idle);
  const state = (await inner()).tabs.find((t: any) => t.number === idle);
  expect(state.asleep).toBe(true);
  expect(state.pid).toBeNull();
  await expect.poll(async () => (await memory(awake.pid)).alive, { timeout: 15_000 }).toBe(false);
  const after = await memory();
  console.log(`MEMORY after sleep: tab process 0 MB (ended), all processes ${after.total} MB`);
  expect(after.total).toBeLessThan(before.total - 50);

  // The list still names the sleeping tab with its title and address.
  expect(await say('browser_tabs')).toContain(`#${idle}`);
  // A tool wakes it and finds the page again; the heavy state is gone, the page is the same.
  expect(await say('browser_text', { tab: idle })).toBeTruthy();
  expect((await inner()).tabs.find((t: any) => t.number === idle).asleep).toBe(false);
  expect(JSON.parse(await say('browser_evaluate', { tab: idle, js: 'typeof window.__big' }))).toBe('undefined');
});

test('8. the selected tab, a tab being typed in and a tab with a changed form never sleep', async () => {
  await say('browser_navigate', { url: `${site.url}/long` });
  const snap = await say('browser_snapshot');
  const box = /textbox "Search box" \[ref=(e\d+)\]/.exec(snap);
  await say('browser_type', { ref: box![1], text: 'unsent words' });
  const tabs = await say('browser_tabs');
  const current = Number(/\* #(\d+)/.exec(tabs)![1]);
  // Another tab is selected, then this one is idle with a changed field.
  await say('browser_new_tab', { url: `${site.url}/b` });
  const slept = await app.evaluate(async () => [...(globalThis as any).__vibexTest.browsers.values()][0].sleepIdle(Date.now() + 11 * 60_000));
  expect(slept).not.toContain(current);
  expect(slept).not.toContain(Number(/\* #(\d+)/.exec(await say('browser_tabs'))![1]));
});

test('9. tabs come back after a restart, and only the selected one loads', async () => {
  const urls = (await say('browser_tabs')).split('\n').length;
  expect(urls).toBeGreaterThan(2);
  await page.waitForTimeout(600);
  const hitsBefore = site.hits.length;
  await client.close();
  await app.close();
  await launch();
  await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
  await page.waitForSelector('#workspace:not([hidden])');
  await expect(page.locator('#page-tabs .tab')).toHaveCount(urls);
  await expect.poll(async () => (await inner())?.tabs.filter((t: any) => t.pid).length).toBe(1);
  const state = await inner();
  expect(state.tabs.filter((t: any) => t.pending)).toHaveLength(urls - 1);
  // Only the selected tab made a request; the others wait.
  expect(site.hits.length - hitsBefore).toBeLessThanOrEqual(1 + 3);
  // Using a waiting tab loads it.
  const waiting = state.tabs.find((t: any) => t.pending).number;
  expect(await say('browser_text', { tab: waiting })).toBeTruthy();
  expect((await inner()).tabs.find((t: any) => t.number === waiting).pending).toBe(false);
});

test('10. the page cannot leave http and https, and a tool cannot open a file', async () => {
  const refused = await tool('browser_navigate', { url: 'file:///etc/hosts' });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain('only web addresses');
  const newTab = await tool('browser_new_tab', { url: 'file:///etc/hosts' });
  expect(newTab.isError).toBe(true);
  // A page that tries to go to a file stays where it is.
  await say('browser_navigate', { url: `${site.url}/b` });
  await say('browser_evaluate', { js: "setTimeout(() => { location.href = 'file:///etc/hosts'; }, 0); 1" });
  await new Promise((r) => setTimeout(r, 500));
  expect(await say('browser_text')).toContain('Second page');
  // Permissions stay denied.
  expect(await say('browser_evaluate', { js: "navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)" })).not.toContain('granted');
});

test('11. vibex_preview opens a web address or a local html file in a new tab, and refuses a phone', async () => {
  const web = await say('vibex_preview', { url: `${site.url}/b`, device: 'desktop' });
  expect(web).toContain('Page B');
  const file = path.join(dir, 'review.html');
  writeFileSync(file, '<!doctype html><title>Review page</title><h1>Before and after</h1>');
  const local = await say('vibex_preview', { url: file });
  expect(local).toContain('Review page');
  expect(await say('browser_text')).toContain('Before and after');
  // The file tab is allowed only for that file.
  await say('browser_evaluate', { js: "setTimeout(() => { location.href = 'file:///etc/hosts'; }, 0); 1" });
  await new Promise((r) => setTimeout(r, 500));
  expect(await say('browser_text')).toContain('Before and after');
  // The tab with a local file is not kept after a restart (it is not a web page).
  for (const device of ['phone', 'tablet']) {
    const refusal = await tool('vibex_preview', { url: site.url, device });
    expect(refusal.isError).toBe(true);
    expect(textOf(refusal)).toContain('no Simulator');
  }
  const notHtml = await tool('vibex_preview', { url: path.join(dir, 'notes.txt') });
  expect(notHtml.isError).toBe(true);
  const relative = await tool('vibex_preview', { url: 'review.html' });
  expect(relative.isError).toBe(true);
  const scheme = await tool('vibex_preview', { url: 'javascript:alert(1)' });
  expect(scheme.isError).toBe(true);
});

test('12. H5: the console and the request list belong to one page: a move clears them, a move inside the page does not', async () => {
  await say('browser_navigate', { url: `${site.url}/long` });
  await say('browser_wait', { selector: '#late', timeout: 10 });
  expect(await say('browser_console')).toContain('hello-console');
  expect(await say('browser_requests')).toContain('/api/ok');
  // A move inside the page is the same page.
  await say('browser_evaluate', { js: "location.hash = '#part'; 1" });
  await new Promise((r) => setTimeout(r, 200));
  expect(await say('browser_console')).toContain('hello-console');
  // A new page starts with empty lists.
  await say('browser_navigate', { url: `${site.url}/b` });
  // (A run from source also logs Electron's own warning on each page.)
  expect(await say('browser_console')).not.toContain('hello-console');
  expect(await say('browser_requests')).toBe('No requests recorded.');
  // The same holds for back.
  await say('browser_navigate', { url: `${site.url}/long` });
  await say('browser_wait', { selector: '#late', timeout: 10 });
  await say('browser_back');
  expect(await say('browser_console')).not.toContain('hello-console');
  expect(await say('browser_requests')).not.toContain('/api/ok');
});
