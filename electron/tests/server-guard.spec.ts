import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { startSshServer, tempDir, type SshServer } from './fixtures';

// The root rule: Claude on a server never reads or reaches a page of this computer or the LAN. Each test is an attack of
// the security review (.scratch/2026-10-31-vibex-pca-finish/review-security.md); its finding id is in the test's name.
// A "public" page cannot exist here, because the tests stay on 127.0.0.1: the pages Claude may use are the project's
// forward, and "leak.example" is a name the resolver maps to 127.0.0.1, as a public DNS name of an attacker does.

const SECRET = 'LOCAL-SECRET';
const LEAK_NAME = 'leak.example';

test.describe('the addresses', () => {
  const load = () => import('../src/main/serverGuard');

  test('H1: private, loopback and link-local ranges of IPv4 and IPv6 are private; the rest is not', async () => {
    const { isPrivateAddress } = await load();
    for (const ip of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fe80::1%en0', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0:1::1', 'not an address', '']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.167.1.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  test('H1: a name is judged by every address it resolves to, a forward only by its literal address', async () => {
    const { addressAllowed } = await load();
    const answers = (...ips: string[]) => async () => ips;
    expect(await addressAllowed('https://example.com/', [], answers('93.184.216.34'))).toBe(true);
    expect(await addressAllowed('wss://example.com/', [], answers('93.184.216.34'))).toBe(true);
    expect(await addressAllowed('http://127.0.0.1.nip.io:8069/', [], answers('127.0.0.1'))).toBe(false);
    expect(await addressAllowed('ws://rebind.example/', [], answers('10.0.0.1'))).toBe(false);
    // One private answer among public ones is enough: Chromium may take either.
    expect(await addressAllowed('https://two.example/', [], answers('93.184.216.34', 'fd00::1'))).toBe(false);
    // No answer, or a failed lookup, is no proof.
    expect(await addressAllowed('https://none.example/', [], answers())).toBe(false);
    expect(await addressAllowed('https://fail.example/', [], async () => { throw new Error('no name'); })).toBe(false);
    expect(await addressAllowed('http://127.0.0.1:51000/', [51000], answers())).toBe(true);
    expect(await addressAllowed('http://127.0.0.1:51001/', [51000], answers())).toBe(false);
    expect(await addressAllowed('ws://127.0.0.1:51000/', [51000], answers())).toBe(true);
    // A forwarded port does not open the same port under a name.
    expect(await addressAllowed('http://forward.example:51000/', [51000], answers('127.0.0.1'))).toBe(false);
    expect(await addressAllowed('file:///etc/passwd', [], answers())).toBe(false);
  });

  test('H4: a server project has its own partition, stable and not the shared one; local projects share one', async () => {
    const { partitionFor } = await load();
    expect(partitionFor('aaa', false)).toBe('persist:vibex-browser');
    expect(partitionFor('bbb', false)).toBe('persist:vibex-browser');
    expect(partitionFor('aaa', true)).toMatch(/^persist:vibex-server-[0-9a-f]+$/);
    expect(partitionFor('aaa', true)).toBe(partitionFor('aaa', true));
    expect(partitionFor('aaa', true)).not.toBe(partitionFor('bbb', true));
  });
});

test.describe('Claude on a server', () => {
  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let userData: string;
  let localOne: string;
  let localTwo: string;
  let runFolder: string;
  let plain: SshServer;
  let local: { url: string; port: number; hits: string[]; sockets: () => number; close: () => void };
  let pub: { port: number; close: () => void };
  let c: Client;
  let ledgerId: string;
  /// How Claude on the server names its page: the app maps this to the forward.
  const forward = 'http://localhost:7777/';
  /// The same forward as the person sees it, on this computer.
  let macForward: string;

  /// A service of this computer: what must stay out of reach. It counts every request.
  async function startLocal(): Promise<typeof local> {
    const hits: string[] = [];
    let sockets = 0;
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '/');
      if (req.url?.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end('{}');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>LOCAL-TITLE</title><body><h1>${SECRET}</h1><script>console.log('${SECRET}-LOG'); fetch('/api/${SECRET}-REQUEST');</script></body>`);
    });
    server.on('upgrade', (_req, socket) => {
      sockets++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/`, port, hits, sockets: () => sockets, close: () => server.close() };
  }

  /// What the server project serves, reached through its forward. Its pages try to lead to the local service.
  async function startPublic(): Promise<typeof pub> {
    const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/to-local')) {
        res.writeHead(302, { Location: local.url });
        return void res.end();
      }
      if (url.startsWith('/to-name')) {
        res.writeHead(302, { Location: `http://${LEAK_NAME}:${local.port}/` });
        return void res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (url.startsWith('/link')) return void res.end(html('Link page', `<a href="${local.url}">go home</a>`));
      if (url.startsWith('/frame')) return void res.end(html('Frame page', `<iframe src="${local.url}" width="600" height="300"></iframe>`));
      if (url.startsWith('/later')) return void res.end(html('Later page', `<p>public</p><script>setTimeout(() => { location.href = ${JSON.stringify(local.url)}; }, 1000);</script>`));
      if (url.startsWith('/cookie')) return void res.end(html('Cookie page', '<p>cookie</p>'));
      res.end(html('Forward page', '<h1>PUBLIC-OK</h1><script>console.log("PUBLIC-LOG");</script>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { port: (server.address() as AddressInfo).port, close: () => server.close() };
  }

  function onExec(sent: string): string | null {
    const encoded = /printf %s (\S+) \|/.exec(sent)?.[1];
    const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : sent;
    if (command.includes('vibex_list') && !command.includes('while :')) return '#vibex-ports ss\n';
    return null;
  }

  const tile = (name: string) => page.locator('.tile', { hasText: name });
  const text = (r: any): string => (r.content as { type: string; text?: string }[]).find((x) => x.type === 'text')?.text ?? '';

  async function openServerProject(folder: string): Promise<string> {
    await page.evaluate((f) => (window as any).vibex.projects.openServer('plain', f), folder);
    const name = folder.split('/').pop()!;
    await expect(tile(name)).toHaveAttribute('aria-current', 'true');
    return (await tile(name).getAttribute('data-project'))!;
  }

  /// Claude on the server: it reaches the app through the `-R` tunnel, with the token ssh sent.
  async function serverClient(name: string): Promise<Client> {
    await expect.poll(() => app.evaluate((_e, n) => {
      const t = (globalThis as any).__vibexTest;
      return t.servers.tunnelPort(t.projects.list().find((x: any) => x.name === n).id) ?? 0;
    }, name), { timeout: 30_000 }).toBeGreaterThan(0);
    // The app knows the port before ssh has opened it.
    const port = await app.evaluate((_e, n) => {
      const t = (globalThis as any).__vibexTest;
      return t.servers.tunnelPort(t.projects.list().find((x: any) => x.name === n).id) as number;
    }, name);
    await expect.poll(() => plain.tunnels.includes(port), { timeout: 30_000 }).toBe(true);
    const hook = await app.evaluate((_e, n) => {
      const t = (globalThis as any).__vibexTest;
      const id = t.projects.list().find((x: any) => x.name === n).id;
      return { token: t.servers.tokenFor(id) as string, tunnel: t.servers.tunnelPort(id) as number };
    }, name);
    const client = new Client({ name: 'claude-on-the-server', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.tunnel}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}` } } }));
    return client;
  }

  async function fullClient(): Promise<Client> {
    const hook = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest;
      return { token: t.token as string, port: t.status.mcpPort as number };
    });
    const client = new Client({ name: 'claude-on-this-computer', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}` } } }));
    return client;
  }

  const call = (name: string, args: Record<string, unknown> = {}, client: Client = c) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const say = async (name: string, args: Record<string, unknown> = {}) => text(await call(name, args));

  /// The person types an address in the bar of the project on screen.
  async function personOpens(url: string): Promise<void> {
    await page.locator('#url').fill(url);
    await page.locator('#url').press('Enter');
    await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id).state().url, ledgerId)).toBe(url);
    await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id).state().loading, ledgerId)).toBe(false);
    await page.waitForTimeout(300);
  }

  /// How many requests the local service got while `act` ran. In-flight requests of an earlier page settle first.
  async function hitsDuring(act: () => Promise<void>): Promise<number> {
    await page.waitForTimeout(200);
    const before = local.hits.length;
    await act();
    await page.waitForTimeout(400);
    return local.hits.length - before;
  }

  /// A new tab on the forward, selected; every attack starts from a page Claude may use.
  async function freshForwardTab(sub = ''): Promise<number> {
    const opened = await say('browser_new_tab', { url: `${forward}${sub}` });
    return Number(/#(\d+)/.exec(opened)![1]);
  }

  test.beforeAll(async () => {
    dir = tempDir('vibex-server-guard-');
    userData = path.join(dir, 'profile');
    mkdirSync(userData);
    localOne = path.join(dir, 'local-one');
    localTwo = path.join(dir, 'local-two');
    // The folder on the server has the path of a folder here. On Windows a server path such as /x reads as the root of this
    // drive, and only there: that is the same trap.
    runFolder = process.platform === 'win32' ? path.resolve('/', `vibex-l6-${path.basename(dir)}`) : path.join(dir, 'run-folder');
    for (const folder of [localOne, localTwo, runFolder]) mkdirSync(folder);
    localOne = realpathSync.native(localOne);
    localTwo = realpathSync.native(localTwo);
    runFolder = realpathSync.native(runFolder);
    writeFileSync(path.join(runFolder, '.vibex.json'), JSON.stringify({ run: { kind: 'command', command: 'node LOCAL-FOLDER-MARKER.js' } }));
    local = await startLocal();
    pub = await startPublic();
    plain = await startSshServer(dir, onExec, { keyName: 'id_plain', serverPorts: { 7777: pub.port } });
    const options = { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: plain.knownHosts, IdentitiesOnly: 'yes' };
    writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([{ name: 'plain', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, allowClaude: true, options }]));
    writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [localOne, localTwo] }));
    const env = {
      ...process.env,
      VIBEX_TEST: '1',
      VIBEX_USER_DATA: userData,
      VIBEX_MCP_PORT: '0',
      VIBEX_AGENT_COMMAND: 'echo AGENT-ON-SERVER',
      VIBEX_SECRET_CRYPT: 'test',
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
      ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    } as Record<string, string>;
    // The name an attacker would point at this computer.
    const args = ['.', `--host-resolver-rules=MAP ${LEAK_NAME} 127.0.0.1`];
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, args: args.slice(1), env } : { args, cwd: path.join(__dirname, '..'), env });
    page = await app.firstWindow();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    ledgerId = await openServerProject('~/ledger');
    c = await serverClient('ledger');
    const out = await say('browser_navigate', { url: 'http://localhost:7777/' });
    macForward = /opened it as (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)![1];
  });

  test.afterAll(async () => {
    await c?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    plain?.close();
    if (process.platform === 'win32' && runFolder) rmSync(runFolder, { recursive: true, force: true });
    pub?.close();
    local?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the project\'s forward still works: it opens, reads, and a tab argument names a page Claude may use', async () => {
    const number = await freshForwardTab();
    expect(await say('browser_text')).toContain('PUBLIC-OK');
    expect(await say('browser_text', { tab: number })).toContain('PUBLIC-OK');
    expect(await say('browser_console', { tab: number })).toContain('PUBLIC-LOG');
  });

  test('H1: a name that resolves to this computer does not open, and the service gets no request', async () => {
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_navigate', { url: `http://${LEAK_NAME}:${local.port}/` }); });
    expect(text(result)).not.toContain('LOCAL-TITLE');
    expect(result.isError).toBe(true);
    expect(hits).toBe(0);
    const read = await call('browser_text');
    expect(text(read)).not.toContain(SECRET);
  });

  test('H1: a page Claude may use cannot reach this computer by a request, by name or by address', async () => {
    await freshForwardTab();
    for (const target of [`http://${LEAK_NAME}:${local.port}/api/by-name`, `http://127.0.0.1:${local.port}/api/by-address`, `http://[::1]:${local.port}/api/v6`]) {
      const hits = await hitsDuring(async () => { await say('browser_evaluate', { js: `fetch(${JSON.stringify(target)}, { mode: 'no-cors' }).then(() => 'reached', (e) => 'failed')` }); });
      expect(hits, target).toBe(0);
    }
  });

  test('H1: a WebSocket from a page Claude may use does not reach this computer', async () => {
    await freshForwardTab();
    const before = local.sockets();
    await say('browser_evaluate', { js: `new Promise((done) => { const s = new WebSocket(${JSON.stringify(`ws://${LEAK_NAME}:${local.port}/`)}); s.onerror = s.onclose = () => done('ended'); setTimeout(() => done('waited'), 1500); })` });
    await say('browser_evaluate', { js: `new Promise((done) => { const s = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${local.port}/`)}); s.onerror = s.onclose = () => done('ended'); setTimeout(() => done('waited'), 1500); })` });
    expect(local.sockets()).toBe(before);
  });

  test('H1: a redirect from a page Claude may use to a name of this computer is refused', async () => {
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_navigate', { url: `${forward}to-name` }); });
    expect(hits).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('LOCAL-TITLE');
  });

  test('H1: an address that answers from this computer after the lookup said public is caught by the address the request used', async () => {
    await app.evaluate((_e, id) => {
      const pane = (globalThis as any).__vibexTest.browsers.get(id);
      if (pane.guard) pane.guard.resolve = async () => ['93.184.216.34'];
    }, ledgerId);
    try {
      const result = await call('browser_navigate', { url: `http://${LEAK_NAME}:${local.port}/` });
      expect(text(result)).not.toContain('LOCAL-TITLE');
      expect(result.isError).toBe(true);
      expect(text(await call('browser_text'))).not.toContain(SECRET);
      expect(await say('browser_tabs')).not.toContain(LEAK_NAME);
    } finally {
      await app.evaluate((_e, id) => {
        const pane = (globalThis as any).__vibexTest.browsers.get(id);
        if (pane.guard) pane.guard.resolve = null;
      }, ledgerId);
    }
  });

  test('H1: through a proxy the address is the proxy\'s, so a public name still opens', async () => {
    await app.evaluate(async (_e, [id, port]) => {
      const pane = (globalThis as any).__vibexTest.browsers.get(id as string);
      pane.guard.resolve = async () => ['93.184.216.34'];
      await pane.view.webContents.session.setProxy({ proxyRules: `http://127.0.0.1:${port}` });
    }, [ledgerId, pub.port] as const);
    try {
      expect(await say('browser_navigate', { url: 'http://proxied.example/' })).toContain('Forward page');
      await page.waitForTimeout(300);
      expect(await say('browser_text')).toContain('PUBLIC-OK');
    } finally {
      await app.evaluate(async (_e, id) => {
        const pane = (globalThis as any).__vibexTest.browsers.get(id);
        pane.guard.resolve = null;
        await pane.view.webContents.session.setProxy({ mode: 'system' });
      }, ledgerId);
    }
  });

  test('H1: the person may open a page of this computer in the tab; Claude does not read it', async () => {
    await freshForwardTab();
    await personOpens(local.url);
    await expect(page.locator('#page-title')).toHaveText('LOCAL-TITLE');
    for (const [name, args] of [['browser_text', {}], ['browser_snapshot', {}], ['browser_evaluate', { js: 'document.body.innerText' }], ['browser_console', {}], ['browser_requests', {}], ['browser_screenshot', {}]] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain('cannot read');
      expect(text(r), name).not.toContain(SECRET);
    }
    // The list does not say what the person has open.
    const tabs = await say('browser_tabs');
    expect(tabs).not.toContain('LOCAL-TITLE');
    expect(tabs).not.toContain(String(local.port));
  });

  test('M1: browser_navigate with a tab has the check after the move, as without one', async () => {
    const other = await freshForwardTab();
    await freshForwardTab();
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_navigate', { url: `${forward}to-local`, tab: other }); });
    expect(text(result)).not.toContain('LOCAL-TITLE');
    expect(result.isError).toBe(true);
    expect(hits).toBe(0);
  });

  test('M1: any read with a tab argument obeys the same rule', async () => {
    const number = await freshForwardTab();
    await personOpens(local.url);
    await freshForwardTab();
    for (const [name, args] of [['browser_text', {}], ['browser_console', {}], ['browser_requests', {}], ['browser_evaluate', { js: 'document.title' }], ['browser_screenshot', {}]] as const) {
      const r = await call(name, { ...args, tab: number });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain('cannot read');
    }
  });

  test('M2: a click on a link to this computer does not reach it, and the reply does not show it', async () => {
    await freshForwardTab('link');
    const snap = await say('browser_snapshot');
    const ref = /link "go home" \[ref=(e\d+)\]/.exec(snap);
    expect(ref, snap).not.toBeNull();
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_click', { ref: ref![1] }); await page.waitForTimeout(500); });
    expect(hits).toBe(0);
    expect(text(result)).not.toContain('LOCAL-TITLE');
    expect(text(await call('browser_text'))).not.toContain(SECRET);
  });

  test('M2: back to a page of this computer is refused, and the page is left', async () => {
    await freshForwardTab();
    await personOpens(local.url);
    const next = await say('browser_navigate', { url: forward });
    expect(next).toContain('Forward page');
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_back'); });
    expect(hits).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('LOCAL-TITLE');
    expect(text(await call('browser_text'))).not.toContain(SECRET);
  });

  test('M2: forward to a page of this computer is refused', async () => {
    await freshForwardTab();
    await personOpens(local.url);
    await personOpens(macForward);
    // The person goes back twice, so the next forward entry is the page of this computer.
    for (const url of [local.url, macForward]) {
      await app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id).back(), ledgerId);
      await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id).state().url, ledgerId)).toBe(url);
      await page.waitForTimeout(300);
    }
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_forward'); });
    expect(hits).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('LOCAL-TITLE');
    expect(text(await call('browser_text'))).not.toContain(SECRET);
  });

  test('M2: reload of a page of this computer is refused', async () => {
    await freshForwardTab();
    await personOpens(local.url);
    let result: any;
    const hits = await hitsDuring(async () => { result = await call('browser_reload'); });
    expect(hits).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('LOCAL-TITLE');
  });

  test('M3: browser_wait is no oracle when a page moves to this computer during the wait', async () => {
    let result: any;
    const hits = await hitsDuring(async () => {
      await freshForwardTab('later');
      result = await call('browser_wait', { text: SECRET, timeout: 3 });
    });
    expect(hits).toBe(0);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toBe('found');
  });

  test('M3: browser_wait is no oracle when the person opens a page of this computer during the wait', async () => {
    await freshForwardTab();
    const waiting = call('browser_wait', { text: SECRET, timeout: 6 });
    await page.waitForTimeout(300);
    await personOpens(local.url);
    const result: any = await waiting;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('cannot read');
  });

  test('M4: a frame of this computer in a page Claude may use is not loaded, and no read shows it', async () => {
    let opened: any;
    const hits = await hitsDuring(async () => {
      opened = await call('browser_new_tab', { url: `${forward}frame` });
      await page.waitForTimeout(400);
    });
    expect(hits).toBe(0);
    // A page with such a frame is refused as a whole: nothing shows the frame, and a read of the page says so.
    expect(opened.isError).toBe(true);
    const shot = await call('browser_screenshot');
    if (!shot.isError) expect((shot.content as any[])[0].type).toBe('image');
    expect(text(await call('browser_text'))).not.toContain(SECRET);
  });

  test('M5: vibex_preview with a local path, or with no scheme, is refused for a server token', async () => {
    const file = path.join(dir, 'secret.html');
    // The picture tells whether the file ever loaded, also for a moment.
    writeFileSync(file, `<!doctype html><title>Local file</title><h1>${SECRET}</h1><img src="${local.url}api/file-loaded">`);
    for (const url of [file, `  ${file}`, `file://${file}`, 'localhost:7777', 'example.com/x.html']) {
      let r: any;
      const hits = await hitsDuring(async () => { r = await call('vibex_preview', { url }); });
      expect(hits, url).toBe(0);
      expect(r.isError, url).toBe(true);
      expect(text(r), url).not.toContain('Local file');
    }
    // An address with a scheme still goes through.
    expect(await say('vibex_preview', { url: 'http://localhost:7777/' })).toContain('Forward page');
    expect(await say('browser_text')).not.toContain(SECRET);
  });

  test('N11: a link in a server project\'s terminal has the server\'s rights: a page of this computer does not load', async () => {
    const link = (url: string) => page.evaluate((u) => (window as any).vibex.mod.invoke('mod:browser:terminal-link', u), url);
    let answer: any;
    const hits = await hitsDuring(async () => { answer = await link(`${local.url}api/file-loaded`); });
    expect(hits).toBe(0);
    expect(answer.opened).toBe(false);
  });

  test('H5: the console and the request list of a page of this computer are gone after a move', async () => {
    await freshForwardTab();
    await personOpens(local.url);
    await say('browser_navigate', { url: forward });
    const consoleLines = await say('browser_console');
    const requests = await say('browser_requests');
    expect(consoleLines).not.toContain(SECRET);
    expect(requests).not.toContain(SECRET);
    const tabs = await app.evaluate((_e, id) => (globalThis as any).__vibexTest.browsers.get(id).tabs.map((t: any) => ({ url: t.url, localPage: t.localPage, tainted: t.tainted, pending: t.pending })), ledgerId);
    expect(consoleLines, JSON.stringify(tabs)).toContain('PUBLIC-LOG');
  });

  test('H4: a login on this computer\'s projects does not reach a server project, or one server project another', async () => {
    const full = await fullClient();
    try {
      // A local project sets a cookie for 127.0.0.1; a cookie is not bound to a port.
      await call('browser_navigate', { url: local.url, project_path: localOne }, full);
      await call('browser_evaluate', { js: "document.cookie = 'local-login=1; max-age=600'; document.cookie", project_path: localOne }, full);
      // The other local project shares it: the owner's decision.
      await call('browser_navigate', { url: local.url, project_path: localTwo }, full);
      expect(text(await call('browser_evaluate', { js: 'document.cookie', project_path: localTwo }, full))).toContain('local-login=1');
      // The server project does not, on its forward on the same host.
      await say('browser_navigate', { url: `${forward}cookie` });
      expect(await say('browser_evaluate', { js: 'document.cookie' })).not.toContain('local-login');
      await say('browser_evaluate', { js: "document.cookie = 'ledger-login=1; max-age=600'; document.cookie" });
      // Nor does a second server project, and it keeps no trace of the first.
      await openServerProject('~/other');
      const second = await serverClient('other');
      try {
        const out = text(await second.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost:7777/cookie' } }));
        expect(out).toMatch(/forwarded port 7777/i);
        const cookies = text(await second.callTool({ name: 'browser_evaluate', arguments: { js: 'document.cookie' } }));
        expect(cookies).not.toContain('ledger-login');
        expect(cookies).not.toContain('local-login');
      } finally {
        await second.close();
      }
      // The local project does not get the server project's login back.
      expect(text(await call('browser_evaluate', { js: 'document.cookie', project_path: localTwo }, full))).not.toContain('ledger-login');
    } finally {
      await full.close();
      await tile('ledger').click();
    }
  });

  test('L6: vibex_run_status with a server token does not read a folder of this computer', async () => {
    // The folder on the server has the same path as a folder here.
    const onServer = process.platform === 'win32' ? `/${path.basename(runFolder)}` : runFolder;
    await openServerProject(onServer);
    const name = path.posix.basename(onServer);
    const client = await serverClient(name);
    try {
      const out = text(await client.callTool({ name: 'vibex_run_status', arguments: {} }));
      expect(out).not.toContain('LOCAL-FOLDER-MARKER');
      expect(out).toContain('server');
    } finally {
      await client.close();
    }
  });
});
