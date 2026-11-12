import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { firstWindow, startSshServer, tempDir } from './fixtures';

// The native chat in a project on a server, in the app (P1 of the chat-first plan): the chat tab runs Claude on the server
// through the app's own ssh login, tunnel and token. The test server runs each command in a real /bin/sh with a made-up
// home, where a made-up claude answers. The scripts themselves are proved in server-chat.spec.ts; this file proves the
// wiring of the app: the tab, the trust card from the server, the tools' tunnel, the history, and the stop at close.
test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'win32', 'the test server runs a POSIX shell; the server is Linux');

let app: ElectronApplication;
let page: Page;
let dir: string;
let userData: string;
let home: string;
let folder: string;
let ssh: Awaited<ReturnType<typeof startSshServer>>;
const log = () => path.join(dir, 'claude.jsonl');
const claudeLog = (): any[] => (existsSync(log()) ? readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const store = () => path.join(home, '.claude');

const pane = () => page.locator('.terminal-pane[data-pane="agent"]');
const chatOn = () => pane().locator('.term.active.chat-surface');
const input = () => chatOn().locator('.chat-input');
const items = (kind: string) => chatOn().locator(`.chat-item[data-kind="${kind}"]`);
/// Waits for the trust card to show, which it does once the server answered. On a failure, the chat's own words go to the log.
async function cardShows(): Promise<void> {
  try {
    await expect(chatOn().locator('.chat-trust')).toBeVisible({ timeout: 70_000 });
  } catch (error) {
    console.log('chat notices:', JSON.stringify(await items('notice').allInnerTexts()));
    console.log('chat text:', (await chatOn().innerText()).slice(0, 1500));
    throw error;
  }
}
const say = async (text: string) => {
  await input().fill(text);
  await input().press('Enter');
};
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidFiles = () => {
  const d = path.join(home, '.cache', 'vibex-chat');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.pid')).map((n) => Number(readFileSync(path.join(d, n), 'utf8'))) : [];
};

test.beforeAll(async () => {
  dir = tempDir('vibex-server-chat-');
  userData = path.join(dir, 'profile');
  home = path.join(dir, 'server-home');
  folder = path.join(home, 'people', 'ali');
  mkdirSync(userData);
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(folder, { recursive: true });
  mkdirSync(store(), { recursive: true });
  writeFileSync(path.join(home, '.profile'), 'echo BANNER-FROM-PROFILE\n');
  const claude = path.join(home, '.local', 'bin', 'claude');
  writeFileSync(claude, `#!/bin/sh
case "$1" in --version) echo '2.1.318 (Claude Code)'; exit 0 ;; --help) echo 'Commands:'; exit 0 ;; esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fake-claude.cjs'))} "$@"
`);
  chmodSync(claude, 0o755);
  ssh = await startSshServer(dir, undefined, { shell: { home, env: { FAKE_CLAUDE_LOG: log(), CLAUDE_CONFIG_DIR: store() } } });
  writeFileSync(path.join(userData, 'servers.json'), JSON.stringify([{
    name: 'test', host: '127.0.0.1', user: 'pca', port: ssh.port, identityFile: ssh.keyFile, allowClaude: true,
    options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' },
  }]));
  writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [{ server: 'test', path: folder }] }));
  const env = { ...process.env, VIBEX_TEST: '1', VIBEX_USER_DATA: userData, VIBEX_MCP_PORT: '0', VIBEX_AGENT_COMMAND: 'echo AGENT-ON-SERVER', CLAUDE_CONFIG_DIR: path.join(dir, 'local-claude-config') } as Record<string, string>;
  const executablePath = process.env.VIBEX_APP_EXECUTABLE;
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
  page = await firstWindow(app);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  for (const pid of pidFiles()) if (pid > 1) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  ssh?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('1. a new chat in a server project is a chat, and asks the server whether the folder is trusted', async () => {
  await pane().locator('.new-chat').click();
  await expect(chatOn()).toBeVisible();
  const card = chatOn().locator('.chat-trust');
  await cardShows();
  await expect(card).toContainText('not been trusted in this folder on test');
  await expect(card).toContainText('runs on the server');
  await say('hello');
  await expect(items('notice').first()).toContainText('on test');
  expect(claudeLog().filter((e) => e.start)).toHaveLength(0);
});

test('2. trusted on the server: Check Again, then the message is answered by Claude there, with the tools', async () => {
  const card = chatOn().locator('.chat-trust');
  // The send in test 1 asked the server again: wait for that answer first. Trust written before it lands would be read by
  // that check, which then hides the card for good (a race of this test, seen on the fence).
  await cardShows();
  writeFileSync(path.join(store(), '.claude.json'), JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } }));
  await card.locator('.chat-trust-check').click();
  // The card also hides while the server is asked: it must stay hidden once the answer is in (a probe takes well under 1 s).
  await expect(card).toBeHidden();
  await page.waitForTimeout(4000);
  await expect(card).toBeHidden();
  await say('hello');
  await expect(items('text').last()).toContainText('Hello from', { timeout: 30_000 });
  await expect(chatOn()).not.toContainText('BANNER');
  // The start that got the message: the start that reads the command list runs at about the same time, with no tools.
  const sender = claudeLog().find((e) => e.stdin?.type === 'user')?.pid;
  const start = claudeLog().find((e) => e.start && e.pid === sender);
  expect(start.cwd).toBe(folder);
  expect(start.argv).toContain('--mcp-config');
  // Its own tunnel port, and the project's token by SendEnv.
  expect(ssh.tunnels.some((p) => p >= 10_000 && p < 20_000)).toBe(true);
  expect(ssh.envs.some((e) => typeof e.LC_VIBEX_MCP_TOKEN === 'string' && e.LC_VIBEX_MCP_TOKEN.length > 10)).toBe(true);
});

test('3. closing the chat ends its Claude on the server: 0 processes left', async () => {
  const leaders = pidFiles();
  expect(leaders.length).toBeGreaterThan(0);
  // The tab is idle, so it closes with no question.
  await app.evaluate(() => {
    const terminals = (globalThis as any).__vibexTest.terminals;
    const chats = terminals.list().filter((t: any) => t.chat && t.alive);
    terminals.close(chats.at(-1).id);
  });
  await expect.poll(() => leaders.filter(groupAlive).length, { timeout: 20_000 }).toBe(0);
});

test('4. a new chat lists the conversation from the server, and opens its history from there', async () => {
  await pane().locator('.new-chat').click();
  await expect(chatOn()).toBeVisible();
  const recent = chatOn().locator('.chat-recent');
  await expect(recent.first()).toContainText('hello', { timeout: 30_000 });
  await recent.first().click();
  await expect(items('text').last()).toContainText('Hello from', { timeout: 30_000 });
});

test('5. the trust card\'s terminal button opens the Claude tab on the server, the fallback', async () => {
  await pane().locator('.new-chat').click();
  writeFileSync(path.join(store(), '.claude.json'), JSON.stringify({ projects: {} }));
  await cardShows();
  await chatOn().locator('.chat-trust-check').click();
  await cardShows();
  await chatOn().locator('.chat-trust-open').click();
  await expect(pane().locator('.term.active .xterm-rows')).toContainText('AGENT-ON-SERVER', { timeout: 30_000 });
});
