import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlLine, userLine } from '../src/main/chatEvents';
import { claudeArgs } from '../src/main/chatModel';
import { loadServerTranscript, parseProbe, plainLoginFailure, probeServerFolder, startRemoteClaude, type ChatLogin, type ChatSpawn } from '../src/main/serverChat';
import { chatLoginArgs, chatPorts, chatProbeScript, chatScript, chatStopScript, safeChatId, serverPorts, shellPorts, type ServerProfile } from '../src/main/servers';
import { startSshServer, tempDir } from './fixtures';

// The native chat on a server (P1 of the chat-first plan), with no app window: the scripts run in a real /bin/sh, behind a
// made-up ssh that runs the "server" side on this computer in a session of its own, as sshd does. The server is Linux; these
// need a POSIX shell, so they do not run on Windows (the Windows side is the ssh client only, covered by the argument checks).

const FAKE_SSH = path.join(__dirname, 'fake-ssh.cjs');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.cjs');
const profile: ServerProfile = { name: 'pca-test', host: 'pca.invalid', user: 'pca', allowClaude: true };
const posixOnly = () => test.skip(process.platform === 'win32', 'the server side is a POSIX shell');

interface FakeServer { root: string; home: string; folder: string; log: string; sshLog: string }

function fakeServer(): FakeServer {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vpca-chat-')));
  const home = path.join(root, 'home');
  const folder = path.join(home, 'people', 'ali');
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(folder, { recursive: true });
  // A login shell that prints, as a team server's start files often do. It must never reach the stream.
  writeFileSync(path.join(home, '.profile'), 'echo BANNER-FROM-PROFILE\n');
  const claude = path.join(home, '.local', 'bin', 'claude');
  writeFileSync(claude, `#!/bin/sh
case "$1" in
  --version) echo "\${FAKE_CLAUDE_VERSION:-2.1.318} (Claude Code)"; exit 0 ;;
  --help) echo 'Commands:'; exit 0 ;;
esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"
`);
  chmodSync(claude, 0o755);
  return { root, home, folder, log: path.join(root, 'claude.jsonl'), sshLog: path.join(root, 'ssh.jsonl') };
}

const envOf = (s: FakeServer, extra: Record<string, string> = {}) => ({ ...(process.env as Record<string, string>), FAKE_SSH_HOME: s.home, FAKE_SSH_LOG: s.sshLog, FAKE_CLAUDE_LOG: s.log, ...extra });
const newId = () => [...Array(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

function spawnOf(s: FakeServer, chatId: string, args: string[], o: { ports?: number[]; extra?: Record<string, string>; p?: ServerProfile } = {}) {
  return (attempt: number): ChatSpawn => {
    const port = o.ports && attempt < o.ports.length ? o.ports[attempt] : null;
    const script = chatScript({ profile: o.p ?? profile, folder: s.folder, chatId, claudeArgs: args, remotePort: port, windowId: 'w1' });
    return { file: process.execPath, args: [FAKE_SSH, ...chatLoginArgs(o.p ?? profile, undefined, script, { asks: true, tunnel: port === null ? undefined : { remotePort: port, localPort: 5150 } })], env: envOf(s, { LC_VIBEX_MCP_TOKEN: 'made-up-token', ...o.extra }), dispose: () => undefined, tunnel: port };
  };
}

function loginOf(s: FakeServer, extra: Record<string, string> = {}): ChatLogin {
  return { file: process.execPath, args: (script) => [FAKE_SSH, '-n', ...chatLoginArgs(profile, undefined, script, { asks: true })], env: envOf(s, extra), folder: s.folder, dispose: () => undefined };
}

function runStop(s: FakeServer, chatId: string): string {
  return execFileSync(process.execPath, [FAKE_SSH, '-n', ...chatLoginArgs(profile, undefined, chatStopScript(chatId), { asks: false })], { env: envOf(s), encoding: 'utf8', timeout: 20_000 }).trim();
}

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

const pidFile = (s: FakeServer, chatId: string) => path.join(s.home, '.cache', 'vibex-chat', `${chatId}.pid`);
const claudeLog = (s: FakeServer): any[] => (existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sshLog = (s: FakeServer): any[] => (existsSync(s.sshLog) ? readFileSync(s.sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

interface Run { lines: string[]; ended: Promise<{ stderr: string; spawnError: string | null }>; notices: string[]; proc: ReturnType<typeof startRemoteClaude> }

function startChat(spawnFor: (attempt: number) => ChatSpawn, attempts: number, stop: () => void = () => undefined): Run {
  const lines: string[] = [];
  const notices: string[] = [];
  let done!: (v: { stderr: string; spawnError: string | null }) => void;
  const ended = new Promise<{ stderr: string; spawnError: string | null }>((r) => { done = r; });
  const proc = startRemoteClaude({ spawn: spawnFor, attempts, stopRemote: stop, server: profile.name, on: { line: (l) => lines.push(l), ended: (stderr, spawnError) => done({ stderr, spawnError }), notice: (t) => notices.push(t) } });
  return { lines, ended, notices, proc };
}

const answered = (run: Run) => run.lines.some((l) => l.includes('Hello from **fake** Claude'));
const say = (run: Run, text: string) => run.proc.write(userLine(text, []));

let servers: FakeServer[] = [];
test.afterEach(() => {
  for (const s of servers) {
    // Whatever a failed test left: every group a pid file names.
    const dir = path.join(s.home, '.cache', 'vibex-chat');
    if (existsSync(dir)) {
      for (const name of execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter((n) => n.endsWith('.pid'))) {
        const pid = Number(readFileSync(path.join(dir, name), 'utf8'));
        if (pid > 1) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    rmSync(s.root, { recursive: true, force: true });
  }
  servers = [];
});
const server = () => {
  const s = fakeServer();
  servers.push(s);
  return s;
};

test.describe('server chat: the ssh arguments', () => {
  test('a chat login has no terminal and no -t, and asks only through the app', () => {
    const args = chatLoginArgs(profile, undefined, 'true', { asks: true });
    expect(args).toContain('-T');
    expect(args).not.toContain('-t');
    expect(args).not.toContain('-tt');
    expect(args).not.toContain('BatchMode=yes');
    expect(args.indexOf('--')).toBe(args.length - 3);
  });

  test('one password try per login, first, so a refused prompt never sends a row of empty passwords (review B2)', () => {
    const args = chatLoginArgs({ ...profile, options: { NumberOfPasswordPrompts: '3' } }, undefined, 'true', { asks: true });
    // ssh keeps the first value it reads: the profile's own 3 comes too late.
    expect(args.slice(0, 2)).toEqual(['-o', 'NumberOfPasswordPrompts=1']);
  });

  // One word of the jump's command line, as servers.ts quotes it for the shell that ssh gives the line to: cmd.exe on
  // Windows, /bin/sh elsewhere.
  const jumpWord = (text: string) => (process.platform === 'win32' ? `"${text}"` : `'${text}'`);

  test('the hub\'s background rule decides the tries: BatchMode with no saved secret, first, also for the jump (the cautious option)', () => {
    const jump: ServerProfile = { name: 'jump', host: 'jump.invalid', user: 'pca' };
    const args = chatLoginArgs(profile, jump, 'true', { asks: true, quiet: ['-o', 'BatchMode=yes'] });
    expect(args.slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
    expect(args).not.toContain('NumberOfPasswordPrompts=1');
    expect(args.find((a) => a.startsWith('ProxyCommand='))).toContain(jumpWord('BatchMode=yes'));
  });

  test('a jump server\'s own ssh gets the same quiet options (review N4)', () => {
    const jump: ServerProfile = { name: 'jump', host: 'jump.invalid', user: 'pca' };
    const proxy = (asks: boolean) => chatLoginArgs(profile, jump, 'true', { asks }).find((a) => a.startsWith('ProxyCommand='))!;
    expect(proxy(false)).toContain(jumpWord('BatchMode=yes'));
    expect(proxy(true)).toContain(jumpWord('NumberOfPasswordPrompts=1'));
    // Before the jump's own options, so its BatchMode=no or a higher count cannot win.
    const own = chatLoginArgs(profile, { ...jump, options: { BatchMode: 'no' } }, 'true', { asks: false }).find((a) => a.startsWith('ProxyCommand='))!;
    expect(own.indexOf(jumpWord('BatchMode=yes'))).toBeGreaterThan(-1);
    expect(own.indexOf(jumpWord('BatchMode=yes'))).toBeLessThan(own.indexOf(jumpWord('BatchMode=no')));
    expect(own.indexOf(jumpWord('BatchMode=yes'))).toBeLessThan(own.indexOf(jumpWord('-l')));
  });

  test('with no way to answer a prompt, BatchMode: a hidden ssh never waits for a passphrase', () => {
    const args = chatLoginArgs({ ...profile, identityFile: '~/.ssh/id_ed25519', authentication: 'key' }, undefined, 'true', { asks: false });
    expect(args.slice(args.indexOf('BatchMode=yes') - 1, args.indexOf('BatchMode=yes') + 1)).toEqual(['-o', 'BatchMode=yes']);
  });

  test('a tunnel: -v for the forward line, its own -R, ExitOnForwardFailure and the token by SendEnv only', () => {
    const args = chatLoginArgs({ ...profile, forward: [3000] }, undefined, 'true', { asks: true, tunnel: { remotePort: 12345, localPort: 5150 } });
    expect(args).toContain('-v');
    expect(args).toContain('127.0.0.1:12345:127.0.0.1:5150');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('SendEnv=LC_VIBEX_MCP_TOKEN');
    expect(args).toContain('127.0.0.1:3000:127.0.0.1:3000');
    expect(args.join(' ')).not.toContain('made-up');
    const plain = chatLoginArgs(profile, undefined, 'true', { asks: true });
    for (const word of ['-v', '-R', 'ExitOnForwardFailure=yes', 'SendEnv=LC_VIBEX_MCP_TOKEN']) expect(plain).not.toContain(word);
  });

  test('chat ports: 3 of their own, never in the ranges of the Claude tab and the shell tabs', () => {
    const ports = chatPorts('window-1', '7');
    expect(new Set(ports).size).toBe(3);
    for (const p of ports) expect(p >= 10_000 && p < 20_000).toBe(true);
    for (const p of [...serverPorts('window-1'), ...shellPorts('window-1', 'x')]) expect(p >= 20_000).toBe(true);
    expect(chatPorts('window-1', '8')).not.toEqual(ports);
  });

  test('a chat id is hex only, so it can name a file and an environment line', () => {
    expect(safeChatId('a'.repeat(24))).toBe(true);
    for (const bad of ['', 'abc', 'A'.repeat(24), `${'a'.repeat(20)};rm`, `${'a'.repeat(20)}/../x`]) expect(safeChatId(bad)).toBe(false);
    expect(() => chatScript({ profile, folder: '/srv', chatId: 'x;y', claudeArgs: [], remotePort: null, windowId: 'w' })).toThrow();
    expect(() => chatStopScript('../../x')).toThrow();
    expect(() => chatProbeScript('/srv', '../x')).toThrow();
  });

  test('the script moves its standard output aside first, and has no tools or token without a tunnel', () => {
    const script = chatScript({ profile, folder: '/srv/pca/people/ali', chatId: 'b'.repeat(24), claudeArgs: claudeArgs({ resume: null, mode: 'default', model: '' }), remotePort: null, windowId: 'w' });
    expect(script.split('\n')[0]).toBe('exec 3>&1 1>&2');
    expect(script).not.toContain('--mcp-config');
    expect(script).toContain('unset LC_VIBEX_MCP_TOKEN');
    const tools = chatScript({ profile, folder: '/srv/pca/people/ali', chatId: 'b'.repeat(24), claudeArgs: [], remotePort: 12345, windowId: 'w' });
    expect(tools).toContain('--mcp-config "$VIBEX_MCP_CONFIG"');
    expect(tools).toContain('127.0.0.1:12345/mcp');
    expect(tools).not.toContain('made-up-token');
  });

  test('plain words for a failed login', () => {
    expect(plainLoginFailure('debug1: x\npca@h: Permission denied (publickey).', 'pca-ai-2')).toContain('refused the login');
    expect(plainLoginFailure('ssh: Could not resolve hostname x', 'pca-ai-2')).toContain('Could not reach pca-ai-2');
    expect(plainLoginFailure('Host key verification failed.', 'pca-ai-2')).toContain('host key');
    expect(plainLoginFailure('Vibex: no claude found on this server.', 'pca-ai-2')).toBe('no claude found on this server.');
  });
});

test.describe('server chat: the quiet script in a real shell', () => {
  test.beforeEach(posixOnly);

  test('only Claude writes to the stream: no login banner, and a message is answered', async () => {
    const s = server();
    const chatId = newId();
    const run = startChat(spawnOf(s, chatId, claudeArgs({ resume: null, mode: 'default', model: '' })), 0);
    say(run, 'hello');
    await until(() => answered(run), 20_000, 'an answer');
    for (const line of run.lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(run.lines.join('\n')).not.toContain('BANNER');
    const start = claudeLog(s).find((e) => e.start);
    expect(start.cwd).toBe(s.folder);
    expect(start.argv).toContain('--append-system-prompt');
    expect(start.argv).not.toContain('--mcp-config');
    run.proc.end();
    await run.ended;
  });

  test('a folder that is not there: words on standard error, nothing on the stream', async () => {
    const s = server();
    rmSync(s.folder, { recursive: true });
    const run = startChat(spawnOf(s, newId(), []), 0);
    const ended = await run.ended;
    expect(run.lines).toEqual([]);
    expect(ended.stderr).toContain('is not on this server');
  });

  test('confirmCommands: an old Claude does not start, and says why', async () => {
    const s = server();
    const run = startChat(spawnOf(s, newId(), [], { p: { ...profile, confirmCommands: true }, extra: { FAKE_CLAUDE_VERSION: '2.0.1' } }), 0);
    const ended = await run.ended;
    expect(run.lines).toEqual([]);
    expect(ended.stderr).toContain('older than');
    expect(claudeLog(s).some((e) => e.start)).toBe(false);
  });

  test('confirmCommands: a new Claude starts in Ask mode with the settings that make it ask, whatever mode the chat had (review N2)', async () => {
    const s = server();
    const run = startChat(spawnOf(s, newId(), claudeArgs({ resume: null, mode: 'acceptEdits', model: '' }), { p: { ...profile, confirmCommands: true } }), 0);
    say(run, 'hello');
    await until(() => answered(run), 20_000, 'an answer');
    const argv: string[] = claudeLog(s).find((e) => e.start).argv;
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default');
    run.proc.end();
    await run.ended;
  });
});

test.describe('server chat: Stop and close leave 0 Claude processes on the server', () => {
  test.beforeEach(posixOnly);

  test('close while Claude ignores the end of its input: the guard ends Claude and its child', async () => {
    const s = server();
    const chatId = newId();
    const run = startChat(spawnOf(s, chatId, claudeArgs({ resume: null, mode: 'default', model: '' })), 0);
    say(run, 'child');
    await until(() => claudeLog(s).some((e) => e.childPid), 20_000, 'the child');
    const leader = Number(readFileSync(pidFile(s, chatId), 'utf8'));
    const childPid = claudeLog(s).find((e) => e.childPid).childPid;
    expect(groupAlive(leader)).toBe(true);
    run.proc.end();
    await run.ended;
    await until(() => !groupAlive(leader) && !pidAlive(childPid), 12_000, 'the group to end');
    expect(existsSync(pidFile(s, chatId))).toBe(false);
  });

  test('the stop login ends the group while its ssh still lives, and says stopped', async () => {
    const s = server();
    const chatId = newId();
    const run = startChat(spawnOf(s, chatId, claudeArgs({ resume: null, mode: 'default', model: '' })), 0);
    say(run, 'stubborn');
    await until(() => run.lines.some((l) => l.includes('"text":"."')), 20_000, 'work');
    const leader = Number(readFileSync(pidFile(s, chatId), 'utf8'));
    expect(runStop(s, chatId)).toBe('stopped');
    expect(groupAlive(leader)).toBe(false);
    await run.ended;
  });

  test('Stop that Claude does not answer, then the app ends it: end() runs the stop login once', async () => {
    const s = server();
    const chatId = newId();
    let stops = 0;
    const run = startChat(spawnOf(s, chatId, claudeArgs({ resume: null, mode: 'default', model: '' })), 0, () => { stops++; runStop(s, chatId); });
    say(run, 'stubborn');
    await until(() => run.lines.some((l) => l.includes('"text":"."')), 20_000, 'work');
    run.proc.write(controlLine('interrupt'));
    const leader = Number(readFileSync(pidFile(s, chatId), 'utf8'));
    run.proc.end();
    run.proc.end();
    await run.ended;
    expect(stops).toBe(1);
    await until(() => !groupAlive(leader), 12_000, 'the group to end');
  });

  test('the stop never ends a process that is not this chat\'s, even with its pid in the file', async () => {
    const s = server();
    const chatId = newId();
    const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    // A killed child of this test stays a zombie until it is reaped, and a zombie answers kill -0: watch its exit instead.
    let exited = false;
    other.on('exit', () => { exited = true; });
    try {
      mkdirSync(path.dirname(pidFile(s, chatId)), { recursive: true });
      writeFileSync(pidFile(s, chatId), `${other.pid}\n`);
      expect(runStop(s, chatId)).toBe('stopped');
      await new Promise((r) => setTimeout(r, 1000));
      expect(exited).toBe(false);
      expect(existsSync(pidFile(s, chatId))).toBe(false);
    } finally {
      other.kill('SIGKILL');
    }
  });

  test('a pid file that says 1 or 0 ends nothing (review N1)', async () => {
    const s = server();
    for (const value of ['1', '0']) {
      const chatId = newId();
      mkdirSync(path.dirname(pidFile(s, chatId)), { recursive: true });
      writeFileSync(pidFile(s, chatId), `${value}\n`);
      expect(runStop(s, chatId)).toBe('stopped');
      expect(existsSync(pidFile(s, chatId))).toBe(false);
    }
  });
});

test.describe('server chat: its own tunnel port, with a retry that keeps the turn', () => {
  test.beforeEach(posixOnly);

  test('a busy port: the next port, and the message reaches Claude once', async () => {
    const s = server();
    const chatId = newId();
    const ports = chatPorts('w1', '1');
    const run = startChat(spawnOf(s, chatId, claudeArgs({ resume: null, mode: 'default', model: '' }), { ports, extra: { FAKE_SSH_BUSY: String(ports[0]), FAKE_SSH_RACE: '1' } }), ports.length);
    say(run, 'hello');
    await until(() => answered(run), 20_000, 'an answer');
    const runs = sshLog(s).filter((r) => r.hasCommand);
    expect(runs.map((r) => r.options[r.options.indexOf('-R') + 1])).toEqual([`127.0.0.1:${ports[0]}:127.0.0.1:5150`, `127.0.0.1:${ports[1]}:127.0.0.1:5150`]);
    const sent = claudeLog(s).filter((e) => e.stdin?.type === 'user');
    expect(sent.length).toBe(1);
    expect(run.notices).toEqual([]);
    // The Claude of the failed login, which got nothing, ended with its session.
    const starts = claudeLog(s).filter((e) => e.start).map((e) => e.pid);
    run.proc.end();
    await run.ended;
    await until(() => starts.every((p) => !pidAlive(p)), 12_000, 'every Claude to end');
  });

  test('no free port: one login with no tunnel, a notice, and the message is answered', async () => {
    const s = server();
    const ports = chatPorts('w1', '2');
    const run = startChat(spawnOf(s, newId(), claudeArgs({ resume: null, mode: 'default', model: '' }), { ports, extra: { FAKE_SSH_BUSY: ports.join(',') } }), ports.length);
    say(run, 'hello');
    await until(() => answered(run), 30_000, 'an answer');
    const runs = sshLog(s).filter((r) => r.hasCommand);
    expect(runs.length).toBe(4);
    expect(runs.at(-1).options).not.toContain('-R');
    expect(run.notices.length).toBe(1);
    expect(run.notices[0]).toContain('no free tunnel port');
    expect(claudeLog(s).filter((e) => e.stdin?.type === 'user').length).toBe(1);
    run.proc.end();
    await run.ended;
  });
});

// The same path through a real OpenSSH sshd: tests/real-sshd.sh starts one as this user on 127.0.0.1 with a made-up home
// and sets VIBEX_REAL_SSHD. It proves what the made-up ssh cannot: ssh's real words about the forward, and that a real
// sshd ends its session when the client dies, so the guard ends Claude.
test.describe('server chat: through a real sshd', () => {
  const real = process.env.VIBEX_REAL_SSHD ? JSON.parse(process.env.VIBEX_REAL_SSHD) as { port: number; user: string; key: string; knownHosts: string; home: string; log: string } : null;
  test.skip(!real, 'set by tests/real-sshd.sh');
  const p = (): ServerProfile => ({ name: 'real-sshd', host: '127.0.0.1', port: real!.port, user: real!.user, identityFile: real!.key, authentication: 'key', allowClaude: true, options: { UserKnownHostsFile: real!.knownHosts, StrictHostKeyChecking: 'yes' } });
  const folder = () => path.join(real!.home, 'people', 'ali');
  const realSpawn = (chatId: string, ports: number[]) => (attempt: number): ChatSpawn => {
    const port = attempt < ports.length ? ports[attempt] : null;
    const script = chatScript({ profile: p(), folder: folder(), chatId, claudeArgs: claudeArgs({ resume: null, mode: 'default', model: '' }), remotePort: port, windowId: 'w1' });
    return { file: 'ssh', args: chatLoginArgs(p(), undefined, script, { asks: false, tunnel: port === null ? undefined : { remotePort: port, localPort: 9 } }), env: { ...(process.env as Record<string, string>), LC_VIBEX_MCP_TOKEN: 'made-up-token' }, dispose: () => undefined, tunnel: port };
  };
  const realLog = () => (existsSync(real!.log) ? readFileSync(real!.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const realPid = (chatId: string) => Number(readFileSync(path.join(real!.home, '.cache', 'vibex-chat', `${chatId}.pid`), 'utf8'));

  test('ssh says the forward is up, the input goes, and the answer comes', async () => {
    const chatId = newId();
    const run = startChat(realSpawn(chatId, chatPorts('real', '1')), 3);
    say(run, 'hello');
    await until(() => answered(run), 30_000, 'an answer');
    for (const line of run.lines) expect(() => JSON.parse(line)).not.toThrow();
    run.proc.end();
    await run.ended;
  });

  test('a port taken on the server: ssh\'s real failure, the next port, one message', async () => {
    const ports = chatPorts('real', '2');
    const net = await import('node:net');
    const holder = net.createServer().listen(ports[0], '127.0.0.1');
    await new Promise((r) => holder.once('listening', r));
    try {
      const before = realLog().filter((e) => e.stdin?.type === 'user').length;
      const run = startChat(realSpawn(newId(), ports), 3);
      say(run, 'hello');
      await until(() => answered(run), 40_000, 'an answer');
      expect(realLog().filter((e) => e.stdin?.type === 'user').length - before).toBe(1);
      run.proc.end();
      await run.ended;
    } finally {
      holder.close();
    }
  });

  test('the client dies: the real sshd ends the session, and the guard ends Claude and its child', async () => {
    const chatId = newId();
    const children = realLog().filter((e) => e.childPid).length;
    const run = startChat(realSpawn(chatId, chatPorts('real', '3')), 3);
    say(run, 'child');
    await until(() => realLog().filter((e) => e.childPid).length > children, 30_000, 'the child');
    const entry = realLog().filter((e) => e.childPid).at(-1);
    const leader = realPid(chatId);
    expect(groupAlive(leader)).toBe(true);
    // No stop login: only the end of the connection.
    process.kill(run.proc.pid, 'SIGKILL');
    await run.ended;
    await until(() => !groupAlive(leader) && !pidAlive(entry.childPid), 15_000, 'the group to end');
  });
});

test.describe('server chat: trust and conversations come from the server', () => {
  test.beforeEach(posixOnly);
  test.skip(() => { try { execFileSync('python3', ['-c', '1']); return false; } catch { return true; } }, 'needs python3, as the server has');

  function store(s: FakeServer, projects: Record<string, unknown>) {
    writeFileSync(path.join(s.home, '.claude.json'), JSON.stringify({ projects, oauthAccount: { emailAddress: 'made-up@example.invalid' } }));
  }

  function transcript(s: FakeServer, id: string, lines: unknown[], mtime: number) {
    const slug = [...s.folder].map((c) => (/[A-Za-z0-9]/.test(c) ? c : '-')).join('');
    const dir = path.join(s.home, '.claude', 'projects', slug);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    execFileSync('touch', ['-t', new Date(mtime).toISOString().replace(/[-:T]/g, '').slice(0, 12), file]);
  }

  test('a trusted folder, its titles newest first, and nothing about another person\'s folder', async () => {
    const s = server();
    store(s, { [s.folder]: { hasTrustDialogAccepted: true }, [path.join(s.home, 'people', 'vali')]: { hasTrustDialogAccepted: true, history: ['private words'] } });
    transcript(s, 'old-one', [{ type: 'user', message: { role: 'user', content: 'Oylik hisobot' } }], Date.UTC(2026, 9, 1));
    transcript(s, 'new-one', [{ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Kassa\nqoldig\'i' }] } }], Date.UTC(2026, 10, 1));
    transcript(s, 'command', [{ type: 'user', message: { role: 'user', content: '/compact' } }], Date.UTC(2026, 10, 2));
    const raw = execFileSync(process.execPath, [FAKE_SSH, '-n', ...chatLoginArgs(profile, undefined, chatProbeScript(s.folder), { asks: true })], { env: envOf(s), encoding: 'utf8' });
    expect(raw).not.toContain('vali');
    expect(raw).not.toContain('made-up@');
    expect(raw).not.toContain('BANNER');
    const info = await probeServerFolder(loginOf(s));
    expect(info.trusted).toBe(true);
    expect(info.real).toBe(s.folder);
    expect(info.sessions.map((x) => [x.id, x.title])).toEqual([['new-one', "Kassa qoldig'i"], ['old-one', 'Oylik hisobot']]);
  });

  test('the probe through the ssh2 test server and the real ssh client, with an askpass as the app sets it, answers within seconds', async () => {
    const dir = tempDir('vibex-probe-ssh2-');
    const home = path.join(dir, 'home');
    const folder = path.join(home, 'people', 'ali');
    mkdirSync(folder, { recursive: true });
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } }));
    const ssh = await startSshServer(dir, undefined, { shell: { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') } } });
    const p: ServerProfile = { name: 'test', host: '127.0.0.1', user: 'pca', port: ssh.port, identityFile: ssh.keyFile, allowClaude: true, options: { StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: ssh.knownHosts, IdentitiesOnly: 'yes' } };
    const env = { ...(process.env as Record<string, string>), SSH_ASKPASS: '/bin/false', SSH_ASKPASS_REQUIRE: 'force', SHELL: '/bin/sh' };
    try {
      for (let round = 0; round < 2; round++) {
        const started = Date.now();
        const info = await probeServerFolder({ file: 'ssh', args: (script) => ['-n', ...chatLoginArgs(p, undefined, script, { asks: true, quiet: ['-o', 'BatchMode=yes'] })], env, folder, dispose: () => undefined });
        expect(info.trusted).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);
      }
    } finally {
      ssh.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the probe loads no code from the folder it checks (review B1)', async () => {
    const s = server();
    store(s, { [s.folder]: { hasTrustDialogAccepted: true } });
    const marker = path.join(s.root, 'planted-code-ran');
    for (const name of ['json.py', 'unicodedata.py', 'os.py']) writeFileSync(path.join(s.folder, name), `open(${JSON.stringify(marker)}, 'w').write('ran')\n`);
    const info = await probeServerFolder(loginOf(s, { PYTHONPATH: s.folder, PYTHONSTARTUP: path.join(s.folder, 'json.py') }));
    expect(info.trusted).toBe(true);
    await loadServerTranscript(loginOf(s), 'any-1');
    expect(existsSync(marker)).toBe(false);
  });

  test('not trusted: no entry, or trust only above the repository root', async () => {
    const s = server();
    store(s, {});
    expect((await probeServerFolder(loginOf(s))).trusted).toBe(false);
    store(s, { [path.join(s.home, 'people')]: { hasTrustDialogAccepted: true } });
    expect((await probeServerFolder(loginOf(s))).trusted).toBe(true);
    mkdirSync(path.join(s.folder, '.git'));
    expect((await probeServerFolder(loginOf(s))).trusted).toBe(false);
  });

  test('no store at all is not trusted, and a reply from the server is checked field by field', async () => {
    const s = server();
    expect((await probeServerFolder(loginOf(s))).trusted).toBe(false);
    expect(parseProbe('not json')).toBeNull();
    expect(parseProbe(JSON.stringify({ real: 'relative', projects: {}, gits: [], sessions: [] }))).toBeNull();
    const odd = parseProbe(JSON.stringify({ real: '/srv/x', projects: { '/srv/x': { hasTrustDialogAccepted: 'yes' } }, gits: [], sessions: [{ id: '../x', title: 't', date: 1 }, { id: 'ok', title: 'a\u0007b', date: 2 }] }));
    expect(odd!.trusted).toBe(false);
    expect(odd!.sessions).toEqual([{ id: 'ok', title: 'a b', date: 2 }]);
  });

  test('a conversation\'s history comes from the server transcript', async () => {
    const s = server();
    transcript(s, 'abc-1', [{ type: 'user', message: { role: 'user', content: 'Kassa' } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Javob' }] } }], Date.now());
    const events = await loadServerTranscript(loginOf(s), 'abc-1');
    expect(events.filter((e) => e.type === 'userText' || e.type === 'text').map((e: any) => e.text)).toEqual(['Kassa', 'Javob']);
    expect(await loadServerTranscript(loginOf(s), 'missing')).toEqual([]);
  });
});
