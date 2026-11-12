import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { firstWindow, tempDir } from './fixtures';
import { previewRequestAllowed, previewUrl } from '../src/main/previewPage';

// A local .html file that vibex_preview opens may come from anyone (security review N2). It runs its own script, and it reads
// no other file and reaches no address. Made-up files, a test server on 127.0.0.1.

const SECRET = 'MADE-UP-SECRET-7';

test('the session of a preview asks for one address only', () => {
  const page = previewUrl('abc');
  expect(previewRequestAllowed(page, page)).toBe(true);
  expect(previewRequestAllowed(`${page}#part`, page)).toBe(true);
  expect(previewRequestAllowed('data:image/png;base64,AAAA', page)).toBe(true);
  for (const url of ['file:///etc/hosts', 'http://127.0.0.1:1/', 'https://example.com/', 'ws://127.0.0.1:1/', 'vibex-preview://abc/other.html', `${page}?x=1`, 'vibex-preview://other/page.html']) {
    expect(previewRequestAllowed(url, page), url).toBe(false);
  }
});

test.describe('a local file in the side browser', () => {
  test.describe.configure({ mode: 'serial' });
  let dir: string;
  let app: ElectronApplication;
  let page: Page;
  let client: Client;
  let project: string;
  let site: http.Server;
  let siteUrl: string;
  let hits: string[] = [];

  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { project_path: project, ...args } }, undefined, { timeout: 90_000 });
  const textOf = (r: any): string => (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  const say = async (name: string, args: Record<string, unknown> = {}) => textOf(await tool(name, args));

  test.beforeAll(async () => {
    dir = tempDir('vibex-preview-');
    mkdirSync(path.join(dir, 'alpha'));
    project = realpathSync.native(path.join(dir, 'alpha'));
    writeFileSync(path.join(project, 'secret.txt'), SECRET);
    site = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Set-Cookie', 'site=1');
      res.end(`<!doctype html><title>Web page</title><h1>web ${req.headers.cookie ?? 'no cookie'}</h1>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: path.join(dir, 'profile'),
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
    client = new Client({ name: 'vibex-preview-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}` } } }));
    await page.evaluate((f) => (window as any).vibex.projects.open(f), project);
    await page.waitForSelector('#workspace:not([hidden])');
  });

  test.afterAll(async () => {
    await client?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('N2: its script runs, and it reads no other file and sends nothing out', async () => {
    const secret = path.join(project, 'secret.txt').replace(/\\/g, '/');
    const fileUrl = `file://${secret.startsWith('/') ? '' : '/'}${secret}`;
    const attack = path.join(project, 'report.html');
    writeFileSync(attack, `<!doctype html><title>Report page</title><h1>The report</h1>
<img id="im" src="${siteUrl}/img"><iframe id="fr" src="${fileUrl}"></iframe><iframe src="${siteUrl}/frame"></iframe>
<form id="fo" action="${siteUrl}/form" method="post" target="_self"></form>
<script>
window.results = {};
const set = (k, v) => { window.results[k] = v; };
(async () => {
  const tryIt = async (k, f) => { try { set(k, await f()); } catch (e) { set(k, 'refused'); } };
  await tryIt('fetchFile', async () => (await fetch(${JSON.stringify(fileUrl)})).text());
  await tryIt('xhrFile', () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(fileUrl)}); x.onload = () => ok(x.responseText); x.onerror = no; x.send(); }));
  await tryIt('fetchWeb', async () => (await fetch(${JSON.stringify(`${siteUrl}/fetch`)})).text());
  await tryIt('beacon', async () => navigator.sendBeacon(${JSON.stringify(`${siteUrl}/beacon`)}, 'x'));
  await tryIt('socket', () => new Promise((ok, no) => { const w = new WebSocket(${JSON.stringify(siteUrl.replace('http', 'ws') + '/ws')}); w.onopen = () => ok('open'); w.onerror = no; }));
  await tryIt('frameRead', async () => document.getElementById('fr').contentDocument?.body?.innerText ?? 'refused');
  window.open(${JSON.stringify(`${siteUrl}/popup`)});
  set('done', true);
})();
</script>`);
    const opened = await say('vibex_preview', { url: attack });
    expect(opened).toContain('Report page');
    await say('browser_wait', { text: 'The report', timeout: 10 });
    let results: any = {};
    for (let i = 0; i < 40 && !results.done; i++) {
      await new Promise((r) => setTimeout(r, 250));
      results = JSON.parse(await say('browser_evaluate', { js: 'JSON.stringify(window.results)' }).then((t) => { try { return JSON.parse(t); } catch { return t; } }));
    }
    expect(results.done, 'the page\'s own script runs').toBe(true);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(results.fetchFile).toBe('refused');
    expect(results.xhrFile).toBe('refused');
    expect(results.fetchWeb).toBe('refused');
    expect(results.socket).toBe('refused');
    // A form and a new address do not leave the page either.
    await say('browser_evaluate', { js: `document.getElementById('fo').submit(); setTimeout(() => { location.href = ${JSON.stringify(`${siteUrl}/moved`)}; }, 50); 1` });
    await new Promise((r) => setTimeout(r, 800));
    expect(await say('browser_text')).toContain('The report');
    expect(hits, 'the test server heard nothing').toEqual([]);
    // Its address is its own: not a file address.
    expect(await say('browser_evaluate', { js: 'location.protocol' })).toContain('vibex-preview:');
  });

  test('N2: another preview has its own storage, and the next web page leaves the preview\'s session', async () => {
    const one = path.join(project, 'one.html');
    const two = path.join(project, 'two.html');
    writeFileSync(one, '<!doctype html><title>One</title><h1>one</h1><script>localStorage.setItem("k", "from one");</script>');
    writeFileSync(two, '<!doctype html><title>Two</title><h1 id="h">two</h1><script>document.getElementById("h").textContent = "two sees " + localStorage.getItem("k");</script>');
    await say('vibex_preview', { url: one });
    await say('vibex_preview', { url: two });
    expect(await say('browser_text')).toContain('two sees null');
    // In the same tab, a web address loads as a normal web page: the network is back.
    await say('browser_navigate', { url: `${siteUrl}/first` });
    expect(await say('browser_text')).toContain('web');
    expect(hits).toContain('/first');
    await say('browser_navigate', { url: `${siteUrl}/second` });
    expect(await say('browser_text')).toContain('site=1');
  });

  test('N2: a file that became a link to another file is not served', async () => {
    const page2 = path.join(project, 'turns.html');
    writeFileSync(page2, '<!doctype html><title>Turns</title><h1>first text</h1>');
    await say('vibex_preview', { url: page2 });
    rmSync(page2);
    require('node:fs').symlinkSync(path.join(project, 'secret.txt'), page2);
    await say('browser_reload').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 800));
    expect(await say('browser_text')).not.toContain(SECRET);
  });
});
