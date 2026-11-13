import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir, firstWindow, standInProgram, useStandIn } from './fixtures';

// What a person meets first, from the laws audit of 2026-10-31: a chip that tells the truth about Claude Code,
// a question before a running tab closes, a way to get the tab back, and a button in an empty column.

let app: ElectronApplication;
let page: Page;
const pane = (name: string) => page.locator(`.pane[data-pane="${name}"]`);

async function launch(extra: Record<string, string> = {}, openFirst = true): Promise<string> {
  const dir = tempDir('vibex-firstrun-');
  const folder = path.join(dir, 'alpha');
  mkdirSync(folder);
  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: path.join(dir, 'data'),
    VIBEX_MCP_PORT: '0',
    VIBEX_AGENT_COMMAND: 'echo AGENT-START-OK',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    ...extra,
  } as Record<string, string>;
  // Windows keeps one PATH under any letter case: a second key, from `extra`, would be a twin in the environment block.
  if (process.platform === 'win32' && 'PATH' in extra) for (const k of Object.keys(env)) if (k !== 'PATH' && k.toLowerCase() === 'path') delete env[k];
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  if (openFirst) {
    await page.evaluate((f) => (window as any).vibex.projects.open(f), realpathSync.native(folder));
    await expect(pane('shell').locator('.tab')).toHaveCount(1);
  }
  return dir;
}

test.afterEach(async () => {
  await app?.close();
});

test('1. the chip says so when Claude Code is missing, and a click opens Setup', async () => {
  await launch({ VIBEX_CLAUDE_MISSING: '1' });
  await expect(page.locator('#mcp-chip')).toHaveClass(/warn/);
  await expect(page.locator('#mcp-text')).toHaveText('Claude Code is missing');
  await page.locator('#mcp-chip').click();
  await expect(page.locator('#doc-tabs .tab[data-doc="setup"]')).toBeVisible();
});

test('2. closing a running Claude tab asks; Cancel keeps it, Close ends it, and Reopen brings it back', async () => {
  await launch();
  await expect(pane('agent').locator('.tab')).toHaveCount(1);
  const answer = (button: number) => app.evaluate(({ dialog }, b) => {
    (globalThis as any).__vibexTest.askOnClose = true;
    (globalThis as any).__asked = 0;
    (dialog as any).showMessageBox = async () => {
      (globalThis as any).__asked++;
      return { response: b, checkboxChecked: false };
    };
  }, button);
  const id = await page.evaluate(async () => (await (window as any).vibex.term.list()).find((t: any) => t.pane === 'agent').id);
  await answer(1);
  await page.evaluate((i) => (window as any).vibex.term.close(i), id);
  await expect.poll(() => app.evaluate(() => (globalThis as any).__asked)).toBe(1);
  await expect(pane('agent').locator('.tab')).toHaveCount(1);
  await answer(0);
  await page.evaluate((i) => (window as any).vibex.term.close(i), id);
  await expect(pane('agent').locator('.tab')).toHaveCount(0);
  await page.evaluate(() => (window as any).vibex.mod.send('mod:tabs:reopen'));
  await expect(pane('agent').locator('.tab')).toHaveCount(1);
});

test('3. a shell tab with nothing running closes without a question', async () => {
  test.skip(process.platform === 'win32', 'ConPTY does not report the foreground program');
  await launch();
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__vibexTest.askOnClose = true;
    (globalThis as any).__asked = 0;
    (dialog as any).showMessageBox = async () => {
      (globalThis as any).__asked++;
      return { response: 0, checkboxChecked: false };
    };
  });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const shell = (await (window as any).vibex.term.list()).find((t: any) => t.pane === 'shell');
    (window as any).vibex.term.close(shell.id);
  });
  await expect(pane('shell').locator('.tab')).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).__asked)).toBe(0);
});

test('4. an empty column has a button that starts a tab', async () => {
  await launch();
  await app.evaluate(({ dialog }) => {
    (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await page.evaluate(async () => {
    for (const t of await (window as any).vibex.term.list()) if (t.pane === 'agent') (window as any).vibex.term.close(t.id);
  });
  const start = pane('agent').locator('.pane-empty button');
  await expect(start).toHaveText('New Claude Tab');
  await start.click();
  await expect(pane('agent').locator('.tab')).toHaveCount(1);
  await expect(pane('agent').locator('.pane-empty')).toBeHidden();
});

const check = () => page.locator('.tool-head button[title="Check again"], .tool-head [aria-label="Check again"]').first();
const lastTabText = (name: string) => page.evaluate(async (n) => {
  const list = (await (window as any).vibex.term.list()).filter((t: any) => t.pane === n);
  return (window as any).vibex.term.buffer(list[list.length - 1].id) as Promise<string>;
}, name);

test('5. Claude Code that an installer puts in ~/.local/bin while the app runs: the chip clears and a new Claude tab starts it, with no restart', async () => {
  const win = process.platform === 'win32';
  // As after a real install: nothing changes in the running app. Only a file appears in the folder of the installer.
  const home = tempDir('vibex-firstrun-home-');
  const calls = path.join(home, 'calls.txt');
  const bare = (process.env.PATH ?? '').split(path.delimiter).filter((d) => !existsSync(path.join(d, win ? 'claude.exe' : 'claude'))).join(path.delimiter);
  // Windows: the stand-in is a copy of node as claude.exe. It is made in a side folder before the start, because its NODE_OPTIONS
  // must be in the app from the start; the .exe itself is put in ~/.local/bin only after, as an installer would.
  const standIn = win
    ? standInProgram(path.join(home, 'stage'), 'claude', [
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');`,
      "if (args[0] === '--version') fs.writeSync(1, '2.0.0 (Claude Code)\\n');",
      "else if (args.length === 0) fs.writeSync(1, 'STAND-IN-CLAUDE-STARTED\\n');",
    ].join('\n  '))
    : null;
  await launch({ HOME: home, ...(win ? { USERPROFILE: home } : {}), PATH: bare, VIBEX_AGENT_COMMAND: undefined as unknown as string, VIBEX_REGISTER_CLAUDE: '1' });
  if (standIn) await useStandIn(app, standIn.env);
  await expect(page.locator('#mcp-text')).toHaveText('Claude Code is missing');
  await page.locator('#mcp-chip').click();
  await expect(page.locator('[data-setup="claude"]')).toHaveAttribute('data-status', 'needed');
  await expect(pane('agent').locator('.tab')).toHaveCount(1);
  const bin = path.join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  if (win) copyFileSync(standIn!.file, path.join(bin, 'claude.exe'));
  else {
    writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$1" = --version ]; then echo "2.0.0 (Claude Code)"; exit 0; fi\n[ "$#" = 0 ] && echo STAND-IN-CLAUDE-STARTED\nexit 0\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);
  }
  await check().click();
  await expect(page.locator('[data-setup="claude"]')).toHaveAttribute('data-status', 'ready');
  // On Windows a new profile says "MCP ready" only after another process could read the key (src/main/claude.ts).
  await expect(page.locator('#mcp-text')).toHaveText('MCP ready', { timeout: 60_000 });
  // The left column works now: a new tab, in front, with the full path, in a shell that has the old PATH.
  await expect(pane('agent').locator('.tab')).toHaveCount(2);
  await expect(pane('agent').locator('.tab[aria-selected="true"]')).toHaveCount(1);
  await expect.poll(() => lastTabText('agent')).toContain('STAND-IN-CLAUDE-STARTED');
  const status = () => app.evaluate(() => (globalThis as any).__vibexTest.status as { claude: string; tokenStore: string });
  await expect.poll(async () => (await status()).claude).not.toContain('Claude Code is not installed');
  // Claude can only fetch the key from a system store, and the fence has none: there the app says so and registers nothing.
  if ((await status()).tokenStore === 'os-store') expect(readFileSync(calls, 'utf8')).toContain('mcp add-json');
  else expect((await status()).claude).toContain('no system key store');
  // Checking again starts nothing more.
  await check().click();
  await expect(page.locator('[data-setup="claude"]')).toHaveAttribute('data-status', 'ready');
  await page.waitForTimeout(300);
  await expect(pane('agent').locator('.tab')).toHaveCount(2);
});

test('6. Setup with no project open: it shows, and Install asks for a folder, then runs the installer there', async () => {
  const dir = await launch({ VIBEX_CLAUDE_MISSING: '1', VIBEX_INSTALL_COMMAND: 'echo INSTALL-RAN' }, false);
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('#welcome-setup-open').click();
  await expect(page.locator('#welcome-setup [data-setup]')).toHaveCount(4);
  await expect(page.locator('#welcome-setup [data-setup="claude"]')).toHaveAttribute('data-status', 'needed');
  // The chip works here too.
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator('#mcp-chip').click();
  await expect(page.locator('#welcome-setup [data-setup]')).toHaveCount(4);
  const pick = (folders: string[]) => app.evaluate(({ dialog }, picked) => {
    (dialog as any).showOpenDialog = async () => ({ canceled: picked.length === 0, filePaths: picked });
  }, folders);
  // Cancel in the picker: nothing runs, and the person reads why.
  await pick([]);
  await page.locator('#welcome-setup [data-setup="claude"] button').click();
  await expect(page.locator('#welcome-setup .setup-message')).toContainText('No folder was chosen');
  await expect(page.locator('#welcome')).toBeVisible();
  // A folder: the project opens, Setup follows it as a tab, and the installer runs in its command terminal.
  await pick([realpathSync.native(path.join(dir, 'alpha'))]);
  await page.locator('#welcome-setup [data-setup="claude"] button').click();
  await expect(page.locator('#doc-tabs .tab[data-doc="setup"]')).toBeVisible();
  await expect(pane('shell').locator('.tab')).toHaveCount(1);
  await expect.poll(() => lastTabText('shell')).toContain('INSTALL-RAN');
  await expect(page.locator('.setup-message:visible')).toContainText('The installer runs in the command terminal');
});

test('7. Check for Updates is in the Help menu, and its answer shows', async () => {
  await launch();
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((i) => i.label.replace('&', '') === 'Help')?.submenu?.items.map((i) => i.label));
  expect(labels).toContain('Check for Updates…');
  const said = await app.evaluate(({ dialog, Menu }) => new Promise<string>((resolve) => {
    (dialog as any).showMessageBox = async (o: { detail: string }) => { resolve(o.detail); return { response: 0, checkboxChecked: false }; };
    Menu.getApplicationMenu()!.items.find((i) => i.label.replace('&', '') === 'Help')!.submenu!.items[0].click();
  }));
  expect(said.length).toBeGreaterThan(0);
});

test('8. a fault in the main process: no box, the app goes on, one plain line, and a log', async () => {
  const dir = await launch();
  await app.evaluate(() => { void Promise.reject(new Error('made-up first fault')); });
  await expect(page.locator('#toasts .toast')).toHaveCount(1);
  await expect(page.locator('#toasts .toast')).toContainText('Something went wrong');
  await expect(page.locator('#toasts .toast')).not.toContainText('made-up');
  await app.evaluate(() => { void Promise.reject(new Error('made-up second fault')); });
  const log = path.join(dir, 'data', 'vibex-errors.log');
  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('made-up second fault');
  await expect(page.locator('#toasts .toast')).toHaveCount(1);
  // The window still answers, and tabs still start.
  const made = await page.evaluate(() => (window as any).vibex.term.create('shell'));
  expect(made.alive).toBe(true);
});

test('9. a ready update shows Restart to Update in the title bar, clear of the window buttons', async () => {
  await launch();
  await expect(page.locator('#update-now')).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mod:update:state', { kind: 'ready', version: '9.9.9' }));
  const button = page.locator('#title-actions #update-now');
  await expect(button).toHaveText('Restart to Update');
  await expect(button).toHaveAttribute('title', /9\.9\.9/);
  // A real click lands on it: nothing covers it, and it is inside what the title bar overlay leaves free.
  const box = (await button.boundingBox())!;
  const overlay = await page.evaluate(() => (navigator as any).windowControlsOverlay?.getTitlebarAreaRect?.().right ?? window.innerWidth);
  if (overlay > 0) expect(box.x + box.width).toBeLessThanOrEqual(overlay);
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#update-now') !== null, [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
  await button.click();
  // In a test run the flow is off, so the press changes nothing: no quit, no box. A later state takes the button away.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mod:update:state', { kind: 'idle' }));
  await expect(page.locator('#update-now')).toHaveCount(0);
});

test('10. a hanging ssh does not hold the window, and does not outlive the app', async () => {
  // Node takes -V itself, so a stand-in of node never hangs there. review3.spec 'item 1' covers on Windows that a short question ends with the app.
  test.skip(process.platform === 'win32', 'the stand-in ssh is a shell script');
  const fake = tempDir('vibex-firstrun-ssh-');
  const started = path.join(fake, 'started');
  writeFileSync(path.join(fake, 'ssh'), `#!/bin/sh\necho $$ > '${started}'\nexec sleep 30\n`);
  chmodSync(path.join(fake, 'ssh'), 0o755);
  await launch({ PATH: `${fake}${path.delimiter}${process.env.PATH}` }, false);
  // ssh -V has a limit of 5 s. Started before that limit runs out, or the window waited for it.
  const waited = Date.now() - statSync(started).mtimeMs;
  expect(waited).toBeLessThan(4500);
  // Measured on the fence: with the page still loading, the quit made loadURL fail, and the error box froze the app (runs
  // 41172648103 and 41176685833). With the page loaded the app ended in 1 s, and its ssh lived on for its 30 s (41174361640).
  const child = app.process();
  // Say so in the log when this quit came during the load of the page, the case that held the app for good before.
  child.stderr?.on('data', (d) => { if (/the quit ended the start/.test(String(d))) console.log(`test 10: ${String(d).trim().slice(0, 240)}`); });
  const ssh = Number(readFileSync(started, 'utf8'));
  const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
  if (!closed) {
    console.log(execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,etimes,wchan:18,args', '--forest'], { encoding: 'utf8' }).split('\n').map((l) => l.slice(0, 170)).join('\n'));
    process.kill(-child.pid!, 'SIGKILL');
  }
  expect(closed, 'the app and all it started are gone within 15 s').toBe(true);
  app = undefined as unknown as ElectronApplication;
  const alive = () => {
    try {
      process.kill(ssh, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive(), 'the stand-in ssh ended with the app').toBe(false);
});
