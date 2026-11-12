import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './fixtures';

// terminal_run never stops work and never types into a shell, from the laws audit of 2026-10-31: each command has a tab,
// a process and an exit code of its own, as a Swift run has its own script and log.
const win = process.platform === 'win32';
const sleepThenTouch = (seconds: number, file: string) => (win ? `Start-Sleep ${seconds}; New-Item -ItemType File '${file}' | Out-Null; Write-Output late-part` : `sleep ${seconds}; touch '${file}'; echo late-part`);

let app: ElectronApplication;
let page: Page;
let client: Client;
let dir: string;
let alpha: string;
let beta: string;

async function call(name: string, args: Record<string, unknown>, project = alpha) {
  const result = await client.callTool({ name, arguments: { project_path: project, ...args } }, undefined, { timeout: 90_000 });
  const content = result.content as { type: string; text?: string }[];
  return { isError: !!result.isError, text: content.find((c) => c.type === 'text')?.text ?? '' };
}

const shellPane = () => page.locator('.terminal-pane[data-pane="shell"]');
const shellTabs = (project: string) => app.evaluate((_e, p) => {
  const t = (globalThis as any).__vibexTest;
  const id = t.projects.list().find((x: any) => x.path === p).id;
  return t.terminals.list().filter((x: any) => x.project === id && x.pane === 'shell').map((x: any) => x.id as number);
}, project);
const bufferOf = (id: number) => app.evaluate((_e, i) => (globalThis as any).__vibexTest.terminals.buffer(i) as string, id);
const runNumber = (text: string) => Number(/run (\d+)/.exec(text)?.[1]);

async function launch(extra: Record<string, string> = {}): Promise<void> {
  dir = realpathSync.native(tempDir('vibex-termrun-'));
  alpha = path.join(dir, 'alpha');
  beta = path.join(dir, 'beta');
  mkdirSync(alpha);
  mkdirSync(beta);
  const env = {
    ...process.env,
    VIBEX_TEST: '1',
    VIBEX_USER_DATA: path.join(dir, 'data'),
    VIBEX_MCP_PORT: '0',
    VIBEX_AGENT_COMMAND: '',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    ...(process.platform === 'darwin' ? { VIBEX_TOKEN_STORE: 'memory' } : {}),
    ...extra,
  } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  await page.evaluate((f) => (window as any).vibex.projects.open(f), alpha);
  await expect(shellPane().locator('.tab')).toHaveCount(1);
  const hook = await app.evaluate(() => {
    const t = (globalThis as any).__vibexTest;
    return { token: t.token as string, port: t.status.mcpPort as number };
  });
  client = new Client({ name: 'vibex-terminal-run-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${hook.token}` } } }));
}

test.afterEach(async () => {
  await client?.close();
  await app?.close();
});

test('1. a command that outlives the wait keeps running, and terminal_output reads its result', async () => {
  await launch();
  const file = path.join(dir, 'long-done');
  const first = await call('terminal_run', { command: sleepThenTouch(3, file), wait: 1 });
  expect(first.text).toMatch(/still running after 1 s; it keeps going/);
  expect(first.text).not.toContain('may still run');
  const run = runNumber(first.text);
  expect((await call('terminal_output', { run })).text).toContain('[still running]');
  await expect.poll(() => existsSync(file), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await call('terminal_output', { run })).text, { timeout: 10_000 }).toBe('late-part\n[finished, exit code 0]');
});

test('2. a command the person started is left alone, also while the tool runs another one', async () => {
  await launch();
  const mine = path.join(dir, 'mine-done');
  await shellPane().locator('.term.active .xterm').click();
  await page.keyboard.type(sleepThenTouch(4, mine));
  await page.keyboard.press('Enter');
  const [person] = await shellTabs(alpha);
  await page.waitForTimeout(500);
  // Exactly this: no login text, prompt, user name or host name.
  expect((await call('terminal_run', { command: 'echo from-the-agent', wait: 20 })).text).toBe('from-the-agent\n[exit code 0]');
  await expect.poll(() => existsSync(mine), { timeout: 15_000 }).toBe(true);
  const buffer = await bufferOf(person);
  expect(buffer).not.toContain('^C');
  expect(buffer).not.toContain('from-the-agent');
});

test('3. the keyboard of a person who types in the column stays in their tab', async () => {
  await launch();
  await shellPane().locator('.term.active .xterm').click();
  const [person] = await shellTabs(alpha);
  await call('terminal_run', { command: 'echo one', wait: 20 });
  await page.keyboard.type('still-mine');
  await expect.poll(() => bufferOf(person)).toContain('till-mine'); // bash redraws the first key apart
  await call('terminal_run', { command: 'echo two', wait: 20 });
  await page.keyboard.type('-again');
  await expect.poll(() => bufferOf(person)).toContain('-again');
  await expect(shellPane().locator('.tab[aria-selected="true"]')).toHaveCount(1);
});

test('4. a tool tab does not take the keyboard from Claude, also when a finished one makes way', async () => {
  await launch();
  const agent = page.locator('.terminal-pane[data-pane="agent"]');
  await agent.locator('.term.active .xterm').click();
  await call('terminal_run', { command: 'echo one', wait: 20 });
  await call('terminal_run', { command: 'echo two', wait: 20 });
  const inAgent = await page.evaluate(() => !!document.activeElement?.closest('.terminal-pane[data-pane="agent"]'));
  expect(inAgent).toBe(true);
});

test('5. finished command tabs make way, so the strip does not grow, and a run still reads', async () => {
  await launch();
  const first = await call('terminal_run', { command: 'echo first', wait: 20 });
  const run = (await call('terminal_run', { command: 'echo second', wait: 20 }));
  for (let i = 0; i < 4; i++) await call('terminal_run', { command: `echo n${i}`, wait: 20 });
  expect((await shellTabs(alpha)).length).toBe(2);
  expect(first.text).toBe('first\n[exit code 0]');
  expect(run.text).toBe('second\n[exit code 0]');
});

test('6. output comes back exactly: no final newline, several lines, a compound command, repeats of its own text', async () => {
  await launch();
  const same = async (command: string, want: string) => expect((await call('terminal_run', { command, wait: 20 })).text).toBe(want);
  // Each line: the POSIX command, then its PowerShell form for Windows.
  await same(win ? "[Console]::Out.Write('hello')" : 'printf hello', 'hello\n[exit code 0]');
  await same("printf 'a\\nb'", 'a\nb\n[exit code 0]');
  await same(win ? 'Write-Output first; Write-Output last' : 'echo first; echo last', 'first\nlast\n[exit code 0]');
  await same(win ? 'Write-Output a\nWrite-Output b' : 'echo a\necho b', 'a\nb\n[exit code 0]');
  await same(win ? 'foreach ($i in 1,2) {\n Write-Output v$i\n}' : 'for i in 1 2; do\n echo v$i\ndone', 'v1\nv2\n[exit code 0]');
  await same(win ? 'Write-Output "Write-Output same"' : 'echo "echo same"', win ? 'Write-Output same\n[exit code 0]' : 'echo same\n[exit code 0]');
  await same(win ? '$null' : 'true', '[exit code 0]');
  // A table waits in PowerShell's formatter, and an `exit` in the script lost it.
  if (win) expect((await call('terminal_run', { command: 'Get-Item .', wait: 20 })).text).toMatch(/Directory:[\s\S]*LastWriteTime[\s\S]*\[exit code 0\]$/);
  await same(win ? 'Write-Output text; exit 7' : 'echo text; exit 7', 'text\n[exit code 7]');
  // The two lines with \b and \r use printf escapes, and a terminal that redraws is a POSIX matter: left to POSIX.
  if (win) return;
  await same("printf '10%%\\b\\b\\b20%%\\n'", '20%\n[exit code 0]');
  await same("printf 'step 1\\rstep 2\\n'", 'step 2\n[exit code 0]');
});

test('7. login text stays out of the result', async () => {
  test.skip(win, 'POSIX setup files');
  const home = realpathSync.native(tempDir('vibex-termrun-home-'));
  writeFileSync(path.join(home, '.zprofile'), 'echo LOGIN-BANNER\nsleep 1\necho SECOND-BANNER\n');
  writeFileSync(path.join(home, '.bash_profile'), 'echo LOGIN-BANNER\nsleep 1\necho SECOND-BANNER\n');
  await launch({ HOME: home, ZDOTDIR: home });
  expect((await call('terminal_run', { command: 'echo hello', wait: 20 })).text).toBe('hello\n[exit code 0]');
});

test('8. an unclosed quote fails at once with its error, and the next call works', async () => {
  await launch();
  // PowerShell reads the unclosed string as a parse error, which must also be a non-zero exit.
  const stuck = await call('terminal_run', { command: win ? 'Write-Output "open' : 'echo "open', wait: 20 });
  expect(stuck.text).toMatch(/\[exit code [1-9]\d*\]$/);
  expect((await call('terminal_run', { command: 'echo next', wait: 20 })).text).toBe('next\n[exit code 0]');
});

test('9. a person presses Ctrl+C in a run: it ends for the agent', async () => {
  await launch();
  const run = runNumber((await call('terminal_run', { command: win ? 'Start-Sleep 60' : 'sleep 60', wait: 1 })).text);
  await shellPane().locator('.term.active .xterm').click();
  await page.keyboard.press('Control+c');
  await expect.poll(async () => (await call('terminal_output', { run })).text, { timeout: 10_000 }).toMatch(/\[finished, exit code -?\d+\]/); // Windows: STATUS_CONTROL_C_EXIT reads as a negative number.
});

test('10. a command that reads input gets it from the person in its tab', async () => {
  await launch();
  const run = runNumber((await call('terminal_run', { command: win ? '$x = Read-Host; Write-Output "got:$x"' : 'read x; echo "got:$x"', wait: 1 })).text);
  await expect.poll(() => shellPane().locator('.tab[aria-selected="true"] .label').innerText()).toContain(win ? 'Read-Host' : 'read x');
  await shellPane().locator('.term.active .xterm').click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await call('terminal_output', { run })).text, { timeout: 10_000 }).toContain('got:hello');
});

test('11. terminal_output reads only runs of this project; a closed tab ends its run; a command never runs twice', async () => {
  await launch();
  const run = runNumber((await call('terminal_run', { command: win ? 'Start-Sleep 60' : 'sleep 60', wait: 0 })).text);
  await page.evaluate((f) => (window as any).vibex.projects.open(f), beta);
  await expect.poll(async () => (await shellTabs(beta)).length).toBe(1);
  const foreign = await call('terminal_output', { run }, beta);
  expect(foreign.isError).toBe(true);
  expect(foreign.text).toContain('no run');
  expect((await call('terminal_output', { run: 9999 })).isError).toBe(true);
  const tab = (await shellTabs(alpha)).pop()!;
  await app.evaluate((_e, id) => (globalThis as any).__vibexTest.terminals.close(id), tab);
  await expect.poll(async () => (await call('terminal_output', { run })).text, { timeout: 5000 }).toContain('[ended: its tab was closed]');
  // Only the person's shell comes back, never the command.
  const reopened = await app.evaluate((_e, p) => {
    const t = (globalThis as any).__vibexTest;
    return t.terminals.reopenClosed(t.projects.list().find((x: any) => x.path === p).id);
  }, alpha);
  expect(reopened).toBeNull();
});

test('12. a palette line goes beside a busy tab, not into it; a script named like the shell counts as busy', async () => {
  test.skip(win, 'ConPTY does not tell what runs');
  await launch();
  const [tab] = await shellTabs(alpha);
  await shellPane().locator('.term.active .xterm').click();
  await page.keyboard.type("bash -c 'sleep 6'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  await page.keyboard.type("bash -c 'sleep 6'");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await app.evaluate((_e, id) => (globalThis as any).__vibexTest.terminals.busy(id), tab)).toBe(true);
  const id = await app.evaluate(() => (globalThis as any).__vibexTest.projects.current().id as string);
  await page.evaluate(([p, t]) => (window as any).vibex.mod.invoke('mod:palette:shell', p, 'echo from-palette', t), [id, tab] as const);
  await expect.poll(async () => (await shellTabs(alpha)).length).toBe(2);
  expect(await bufferOf(tab)).not.toContain('from-palette');
});

test('13. a tab number is refused; a wait above the limit is cut; a big output returns its tail with a note', async () => {
  await launch();
  const [tab] = await shellTabs(alpha);
  const named = await call('terminal_run', { command: 'echo no', tab });
  expect(named.isError).toBe(true);
  expect(named.text).toContain('takes no tab');
  expect(await bufferOf(tab)).not.toContain('echo no');
  const big = await call('terminal_run', { command: win ? "Write-Output ('x' * 40000)" : 'yes x | head -c 40000', wait: 20 });
  expect(big.text).toMatch(/^\[last 8000 of \d+ characters; terminal_output with run \d+/);
  expect(big.text.length).toBeLessThan(8200);
  const started = Date.now();
  const cut = await call('terminal_run', { command: win ? 'Start-Sleep 53' : 'sleep 53', wait: 200 });
  expect(cut.text).toContain('still running after 50 s');
  expect(Date.now() - started).toBeLessThan(52_000);
});

test('14. cwd: relative to the project, a bad folder fails, and it holds for that one command', async () => {
  await launch();
  const pwd = win ? '(Get-Location).Path' : 'pwd';
  mkdirSync(path.join(alpha, 'sub'));
  expect((await call('terminal_run', { command: pwd, cwd: 'sub', wait: 20 })).text).toContain(path.join(alpha, 'sub'));
  expect((await call('terminal_run', { command: pwd, wait: 20 })).text).toBe(`${alpha}\n[exit code 0]`);
  expect((await call('terminal_run', { command: pwd, cwd: 'nope', wait: 20 })).text).toMatch(/\[exit code 1\]$/);
});

test('15. a finished tab that makes way leaves the keyboard where a person types, also outside the column', async () => {
  await launch();
  await shellPane().locator('.term.active .xterm').click();
  await page.locator('#url').click();
  await call('terminal_run', { command: win ? 'Write-Output one' : 'echo one', wait: 20 });
  await expect(shellPane().locator('.tab')).toHaveCount(2);
  await page.keyboard.type('typed-');
  await call('terminal_run', { command: win ? 'Write-Output two' : 'echo two', wait: 20 });
  await expect(shellPane().locator('.tab', { hasText: 'one' })).toHaveCount(0);
  await page.keyboard.type('still');
  await expect(page.locator('#url')).toBeFocused();
  await expect(page.locator('#url')).toHaveValue('typed-still');
});

test('16. a tool call in a project not yet shown does not use up its shell tab', async () => {
  await launch();
  // A tool opens it on the rail, and it is not shown yet, so its own tabs have not started.
  await client.callTool({ name: 'vibex_open_project', arguments: { path: beta } });
  const early = await call('terminal_run', { command: win ? 'Write-Output early' : 'echo early', wait: 20 }, beta);
  expect(early.text).toContain('early');
  expect(early.isError).toBe(false);
  expect((await shellTabs(beta)).length).toBe(1);
  await page.locator('.tile', { hasText: 'beta' }).click();
  // The finished command, and the person's own live shell beside it.
  await expect.poll(async () => (await shellTabs(beta)).length).toBe(2);
  const live = await app.evaluate((_e, p) => {
    const t = (globalThis as any).__vibexTest;
    const id = t.projects.list().find((x: any) => x.path === p).id;
    return t.terminals.list().filter((x: any) => x.project === id && x.pane === 'shell' && x.kind !== 'none' && x.alive).length as number;
  }, beta);
  expect(live).toBe(1);
});

test('17. a tab that finished before its view was ready shows the output first, and says it ended once', async () => {
  await launch();
  await page.evaluate((f) => (window as any).vibex.projects.open(f), beta);
  await expect.poll(async () => (await shellTabs(beta)).length).toBe(1);
  await page.locator('.tile', { hasText: 'alpha' }).click();
  await call('terminal_run', { command: win ? 'Write-Output in-the-back' : 'echo in-the-back', wait: 20 }, beta);
  await page.locator('.tile', { hasText: 'beta' }).click();
  await shellPane().locator('.tab', { hasText: 'in-the-back' }).click();
  const text = () => shellPane().locator('.term.active .xterm-rows').innerText();
  await expect.poll(text).toMatch(/Session ended/);
  const shown = (await text()).replace(/\s+/g, ' ');
  expect(shown.indexOf('in-the-back')).toBeGreaterThanOrEqual(0);
  expect(shown.indexOf('Session ended')).toBeGreaterThan(shown.lastIndexOf('in-the-back'));
  expect(shown.match(/Session ended/g)?.length).toBe(1);
});
