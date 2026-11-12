import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './fixtures';

// The packed app, with the fuses people get (security review N2, N5). It packs here, so it runs only on the Linux fence and on
// Linux CI, never on the owner's Mac. The proof build differs from a release only in test code and the inspector fuse.
const electronDir = path.join(__dirname, '..');
const onFence = !!process.env.CI && process.platform === 'linux';

test.describe('the packed app', () => {
  test.skip(!onFence, 'packs an app: Linux CI only');
  const proofOut = path.join(electronDir, 'release-proof');
  const releaseOut = path.join(electronDir, 'release-fence');
  const proofExe = path.join(proofOut, 'linux-unpacked', 'vibex-pca');
  const releaseExe = path.join(releaseOut, 'linux-unpacked', 'vibex-pca');
  const pack = (args: string[]) => execFileSync('npx', ['electron-builder', '--dir', '--linux', '--publish', 'never', ...args], { cwd: electronDir, stdio: 'pipe', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });

  test.beforeAll(() => {
    test.setTimeout(900_000);
    execFileSync('npm', ['run', 'dist:proof', '--', '--linux'], { cwd: electronDir, stdio: 'pipe', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    pack([`--config.directories.output=release-fence`]);
  });
  test.afterAll(() => {
    test.setTimeout(300_000);
    rmSync(proofOut, { recursive: true, force: true });
    rmSync(releaseOut, { recursive: true, force: true });
    // Each pack left its own build in dist/; the specs after this one need the build for tests.
    execFileSync(process.execPath, ['build.mjs'], { cwd: electronDir, stdio: 'pipe' });
  });

  test('N5: the whole release gate holds for the packed release', () => {
    test.setTimeout(240_000);
    const out = tempDir('vibex-gate-output-');
    const r = spawnSync('npx', ['playwright', 'test', 'tests/release-gate.spec.ts', '--reporter=line', `--output=${out}`], { cwd: electronDir, encoding: 'utf8', timeout: 220_000, env: { ...process.env, VIBEX_RELEASE_EXECUTABLE: releaseExe } });
    rmSync(out, { recursive: true, force: true });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(/skipped/);
  });

  test('N5: a release named electron still takes no switch and no debugging port', async () => {
    const renamed = path.join(path.dirname(releaseExe), 'electron');
    expect(existsSync(releaseExe)).toBe(true);
    renameSync(releaseExe, renamed);
    const dir = tempDir('vibex-renamed-');
    const asked = path.join(dir, 'asked');
    mkdirSync(asked);
    const start = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; alive: boolean }>((resolve) => {
      const child = spawn(renamed, [`--user-data-dir=${path.join(dir, 'real')}`, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'c'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      let code: number | null | undefined;
      child.on('exit', (c) => { code = c; });
      setTimeout(() => {
        const alive = code === undefined;
        child.kill();
        setTimeout(() => resolve({ code: code ?? null, out, alive }), 500);
      }, 6000);
    });
    try {
      const port = await start(['--remote-debugging-port=0']);
      expect(port.out).not.toMatch(/DevTools listening/);
      expect(port.alive).toBe(false);
      expect(port.code).toBe(1);
      const switches = await start([], { VIBEX_TEST: '1', VIBEX_USER_DATA: asked });
      expect(switches.alive, switches.out).toBe(true);
      expect(require('node:fs').readdirSync(asked)).toEqual([]);
    } finally {
      renameSync(renamed, releaseExe);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('N2: with file privileges off, the window loads whole, and vibex_preview shows a file from inside the asar app', async () => {
    test.setTimeout(300_000);
    const step = (text: string) => console.log(`packed: ${text}`);
    const fuses = execFileSync(process.execPath, [path.join(electronDir, 'node_modules', '@electron', 'fuses', 'dist', 'bin.js'), 'read', '--app', proofExe], { encoding: 'utf8' }).replace(/\u001b\[[0-9;]*m/g, '');
    expect(fuses).toMatch(/GrantFileProtocolExtraPrivileges is Disabled/);
    expect(fuses).toMatch(/EnableEmbeddedAsarIntegrityValidation is Enabled/);
    const dir = tempDir('vibex-packed-');
    const project = path.join(dir, 'alpha');
    mkdirSync(project);
    const app = await electron.launch({
      executablePath: proofExe,
      env: { ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: path.join(dir, 'profile'), VIBEX_MCP_PORT: '0', VIBEX_AGENT_COMMAND: 'echo OK', CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config') } as Record<string, string>,
    });
    // Taken now: after a close, Playwright has no process to give.
    const child = app.process();
    try {
      const output: string[] = [];
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', (d) => output.push(String(d)));
      const page = await app.firstWindow({ timeout: 45_000 }).catch(async (error) => {
        // What the app itself knows: a window with no page event is another fault than no window.
        const known = await Promise.race([
          app.evaluate(({ app: a, BrowserWindow }) => ({ ready: a.isReady(), windows: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()), hook: !!(globalThis as any).__vibexTest })),
          new Promise((r) => setTimeout(() => r('evaluate did not answer'), 10_000)),
        ]);
        step(`no window: ${JSON.stringify(known)}\n${output.join('').slice(-3000)}`);
        throw error;
      });
      step('window open');
      await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      step('window ready');
      const state = await page.evaluate(async () => {
        // A font that fails to load shows as an error; each font of the page is asked for by name.
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
        await Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined)));
        const faces = [...document.fonts].map((f) => `${f.family} ${f.status}`);
        return { protocol: location.protocol, faces, icons: document.querySelectorAll('[data-icon] svg').length, cssRules: document.styleSheets.length };
      });
      step(`state ${JSON.stringify(state)}`);
      expect(state.protocol).toBe('vibex-app:');
      expect(state.cssRules, 'both style files load').toBeGreaterThanOrEqual(2);
      expect(state.icons, 'the renderer ran').toBeGreaterThan(0);
      expect(state.faces.filter((f) => f.endsWith('error')), `fonts: ${state.faces.join(', ')}`).toEqual([]);
      const hook = await app.evaluate(() => {
        const t = (globalThis as any).__vibexTest;
        return { token: t.token as string, port: t.status.mcpPort as number };
      });
      step('asking the tool server');
      const client = new Client({ name: 'packed', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}` } } }));
      const real = realpathSync.native(project);
      await page.evaluate((f) => (window as any).vibex.projects.open(f), real);
      await page.waitForSelector('#workspace:not([hidden])');
      writeFileSync(path.join(real, 'made-up-note.txt'), 'MADE-UP-NOTE');
      const file = path.join(real, 'report.html');
      writeFileSync(file, `<!doctype html><title>Packed page</title><h1>Packed report</h1><script>fetch('file://${path.join(real, 'made-up-note.txt')}').then((r) => r.text()).then((t) => { document.title = t; }, () => { document.title = 'FETCH-BLOCKED'; });</script>`);
      const say = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: { project_path: real, ...args } }, undefined, { timeout: 60_000 })).content as { text?: string }[])[0]?.text ?? '';
      // The tool answers with the title, which the page's own script may have changed by then. Any other answer is a refusal.
      expect(await say('vibex_preview', { url: file })).toMatch(/Packed page|FETCH-BLOCKED/);
      expect(await say('browser_text', {})).toContain('Packed report');
      expect(await say('browser_evaluate', { js: 'new Promise((r) => setTimeout(() => r(document.title), 500))' })).toContain('FETCH-BLOCKED');
      await client.close();
      step('preview done');
    } finally {
      await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]);
      child.kill('SIGKILL');
      step('closed');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
