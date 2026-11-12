import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { askpassEnvironment, classify, classifyJump, parseSshVersion, supportsAskpass, usableAnswer, wireReply } from '../src/main/askpass';
import { parseListing, offered, PortDetection, TUNNEL_PORTS } from '../src/main/serverPorts';
import { liveToggleRefusal, lookUp, needsQuestion, unsafeCharacters, visible } from '../src/main/serverQuestions';
import { SecretStore } from '../src/main/serverSecrets';
import { planForward, serverMayCall, serverMayOpen } from '../src/main/serverTools';
import { checkProfile, claudeSettings, isValid, jumpCommand, runScript, savedProfile, serverLaunch, serverPorts, serverScript, shellPorts, sshLaunch, toolsScript, updateProfiles, viaSh } from '../src/main/servers';
import { createHash } from 'node:crypto';
import { startSite, startSshServer, tempDir, type SshServer, firstWindow, posixSh, logWindowsProcesses } from './fixtures';

// Made-up logins only. Nothing here reaches a real server, a real Keychain entry or the person's own config.
const PASSWORD = 'made-up-password-1';
const PASSPHRASE = 'made-up-passphrase-2';

test.describe('the servers file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-servers-unit-'));
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const base = { name: 'pca', host: 'server.example', user: 'me' };

  test('the fields of the fork pass the checks; a bad value makes the entry invalid', () => {
    expect(isValid({ ...base, allowClaude: true, projectPath: '~/app', forward: [3000, 8080], confirmCommands: true, jump: 'bastion', authentication: 'password' })).toBe(true);
    for (const bad of [
      { allowClaude: 'yes' }, { confirmCommands: 1 }, { projectPath: 'relative' }, { projectPath: '/srv/a\nreboot' }, { forward: [0] }, { forward: [70000] }, { forward: '3000' },
      { forward: Array.from({ length: 33 }, (_, i) => 3000 + i) }, { jump: 'a\nb' }, { jump: 7 }, { authentication: 'magic' }, { identityFile: '/a\nb' },
    ]) expect(isValid({ ...base, ...bad }), JSON.stringify(bad)).toBe(false);
  });

  test('the form check says what is wrong in plain words', () => {
    const others = [{ name: 'other', host: 'h', user: 'u' }];
    expect(checkProfile({ ...base }, others, null)).toBeNull();
    expect(checkProfile({ ...base, name: '' }, others, null)).toContain('name');
    expect(checkProfile({ ...base, host: '-oProxyCommand=x' }, others, null)).toContain('host');
    expect(checkProfile({ ...base, user: 'a b' }, others, null)).toContain('user');
    expect(checkProfile({ ...base, port: 99999 } as any, others, null)).toContain('port');
    expect(checkProfile({ ...base, name: 'OTHER' }, others, null)).toContain('already');
    expect(checkProfile({ ...base, jump: 'pca' }, others, null)).toContain('itself');
    expect(checkProfile({ ...base, jump: 'nobody' }, others, null)).toContain('nobody');
    expect(checkProfile({ ...base, authentication: 'key' }, others, null)).toContain('key file');
    expect(checkProfile({ ...base, name: 'other' }, others, 'other')).toBeNull();
  });

  test('a file that cannot be read is never overwritten', () => {
    for (const text of ['{ not json', '{"a":1}']) {
      const file = path.join(dir, 'bad.json');
      writeFileSync(file, text);
      expect(() => updateProfiles(file, (list) => list)).toThrow(/cannot be read|not a list/);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });

  test('a save keeps every other entry and key, also one the app cannot use, and the file is private', () => {
    const file = path.join(dir, 'keep.json');
    const odd = { name: 'bad name\n', host: 'x' };
    writeFileSync(file, `\uFEFF${JSON.stringify([odd, { ...base, options: { IdentitiesOnly: 'yes' }, notes: 'kept' }])}`);
    updateProfiles(file, (list) => savedProfile(list, { ...base, host: 'new.example' }, 'pca'));
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after[0]).toEqual(odd);
    expect(after[1]).toEqual({ ...base, host: 'new.example', options: { IdentitiesOnly: 'yes' }, notes: 'kept' });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

test.describe('ssh arguments', () => {
  const base = { name: 'pca', host: 'server.example', user: 'me' };

  test('a password login turns key login off; a plain profile stays as it was', () => {
    expect(sshLaunch(base).args).toEqual(['--', 'me@server.example']);
    const args = sshLaunch({ ...base, authentication: 'password' }).args.join(' ');
    expect(args).toContain('PubkeyAuthentication=no');
    expect(args).toContain('PreferredAuthentications=keyboard-interactive,password');
  });

  test('a jump goes through a command with the jump server\'s own key, every word quoted', () => {
    const line = jumpCommand({ name: 'j', host: 'jump.example', user: 'me', port: 2200, identityFile: "/k/it's 50%", options: { UserKnownHostsFile: '/k/known' } }, 'darwin');
    expect(line).toContain(`'-l' 'me'`);
    expect(line).toContain(`'/k/it'\\''s 50%%'`);
    expect(line).toContain(`-W '[%h]:%p' -- 'jump.example'`);
    expect(line).toContain(`'2200'`);
    expect(() => jumpCommand({ ...base, host: '-oProxyCommand=x' }, 'darwin')).toThrow();
    // On Windows the words are in double quotes, and a character cmd reads is refused.
    expect(jumpCommand({ name: 'j', host: 'jump.example', user: 'me' }, 'win32')).toContain('"jump.example"');
    expect(() => jumpCommand({ name: 'j', host: 'jump.example', user: 'me', identityFile: 'C:\\a&calc.exe' }, 'win32')).toThrow();
  });

  test('tunnel ports stay in the fork\'s ranges and differ by project and tab', () => {
    const a = serverPorts('project-a');
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
    for (const p of a) expect(p >= 20000 && p < 60000).toBe(true);
    expect(serverPorts('project-b')).not.toEqual(a);
    for (const p of shellPorts('project-a', 'tab-1')) expect(p >= 60000 && p < 65000).toBe(true);
    expect(shellPorts('project-a', 'tab-1')).not.toEqual(shellPorts('project-a', 'tab-2'));
  });
});

test.describe('the script on the server', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-script-unit-'));
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const profile = { name: 'pca', host: 'server.example', user: 'me' };

  /// A fake claude that writes its arguments and the token it can see, one per line, then ends.
  function home(version = '2.1.310'): { home: string; log: string } {
    const root = mkdtempSync(path.join(dir, 'home-'));
    mkdirSync(path.join(root, '.local', 'bin'), { recursive: true });
    mkdirSync(path.join(root, 'app'));
    const log = path.join(root, 'log');
    const fake = path.join(root, '.local', 'bin', 'claude');
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version} (Claude Code)'; exit 0; fi\nif [ "$1" = --help ]; then printf 'Commands:\\n  mcp\\n  agents\\n'; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\necho "pwd=$PWD" >> '${log}'\n`);
    chmodSync(fake, 0o755);
    return { home: root, log };
  }

  const run = (script: string, h: string) => spawnSync(posixSh(), ['-c', viaSh(script)], { env: { PATH: process.env.PATH, HOME: h, SHELL: '/bin/sh', LC_VIBEX_MCP_TOKEN: 'made-up-token', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, encoding: 'utf8', input: '', timeout: 20_000 });

  test('Claude starts in the folder with the tools; the config holds a reference to the token, never the token', () => {
    const h = home();
    const script = toolsScript({ profile, folder: '~/app', pane: 'agent', remotePort: 45678, windowId: 'abc123', forward: [3000] });
    expect(script).not.toContain('made-up-token');
    run(script, h.home);
    const log = readFileSync(h.log, 'utf8');
    expect(log).toContain('"Authorization":"Bearer ${LC_VIBEX_MCP_TOKEN}"');
    expect(log).toContain('"X-Vibex-Window":"abc123"');
    expect(log).toContain('"url":"http://127.0.0.1:45678/mcp"');
    expect(log).toContain('--append-system-prompt');
    expect(log).toContain('--mcp-config');
    expect(log).toMatch(/pwd=.*\/app\n/);
    // --mcp-config takes several values, so it stays last.
    const lines = log.trim().split('\n');
    expect(lines[lines.findIndex((l) => l === '--mcp-config') + 2]).toMatch(/^pwd=/);
  });

  test('confirmCommands: the permission options go in, before --mcp-config', () => {
    const h = home();
    run(toolsScript({ profile: { ...profile, confirmCommands: true }, folder: '~/app', pane: 'agent', remotePort: 45678, windowId: 'abc123', forward: [] }), h.home);
    const lines = readFileSync(h.log, 'utf8').trim().split('\n');
    expect(lines).toContain('--permission-mode');
    expect(lines).toContain('default');
    expect(lines[lines.indexOf('--settings') + 1]).toBe(claudeSettings);
    expect(lines.indexOf('--settings')).toBeLessThan(lines.indexOf('--mcp-config'));
    expect(JSON.parse(claudeSettings).permissions.ask).toEqual(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  });

  test('confirmCommands: a Claude Code older than the floor does not start', () => {
    const h = home('2.0.1');
    const out = run(toolsScript({ profile: { ...profile, confirmCommands: true }, folder: '~/app', pane: 'agent', remotePort: 45678, windowId: 'abc123', forward: [] }), h.home);
    expect(out.stdout).toContain('Vibex does not start it');
    expect(existsSync(h.log)).toBe(false);
  });

  test('a shell tab starts no Claude; a folder with a quote stays one folder', () => {
    const h = home();
    mkdirSync(path.join(h.home, "it's"));
    run(toolsScript({ profile, folder: "~/it's", pane: 'shell', remotePort: 61000, windowId: 'abc123', forward: [] }), h.home);
    expect(existsSync(h.log)).toBe(false);
  });

  test('a run keeps its words: the command reaches the shell unchanged, in the folder, with its exit code', () => {
    const h = home();
    const out = run(runScript('~/app', 'sub', `mkdir -p sub; cd .; pwd; echo "a'b $HOME"; exit 7`), h.home);
    // The folder must exist for the cd.
    expect(out.status).toBe(1);
    mkdirSync(path.join(h.home, 'app', 'sub'));
    const ok = run(runScript('~/app', 'sub', `pwd; echo "a'b $HOME"; exit 7`), h.home);
    expect(ok.stdout).toMatch(/\/app\/sub\n/);
    // Git's sh on Windows writes the home folder in its own form.
    expect(ok.stdout).toContain(process.platform === 'win32' ? "a'b /" : `a'b ${h.home}`);
    expect(ok.status).toBe(7);
    const absolute = run(runScript('~/app', '/tmp', 'pwd'), h.home);
    expect(absolute.stdout).toMatch(/\/tmp/);
  });

  test('a profile with no tools still has the old script', () => {
    const launch = serverLaunch(profile, '/srv/app', 'shell');
    expect(launch.args.slice(-1)).toEqual([viaSh(serverScript('/srv/app', 'shell', ''))]);
  });
});

test.describe('ssh\'s prompts', () => {
  const password = { name: 'pca', host: 'server.example', user: 'me', authentication: 'password' as const };
  const key = { name: 'k', host: 'key.example', user: 'me', authentication: 'key' as const, identityFile: '/keys/id' };
  const req = (prompt: string, hint = '') => ({ key: 'x', hint, prompt });

  test('only this server\'s own secret is a saved secret', () => {
    expect(classify(req("me@server.example's password:"), password)).toEqual({ kind: 'secret', secret: 'password' });
    expect(classify(req("ME@SERVER.EXAMPLE's password:"), password)).toEqual({ kind: 'secret', secret: 'password' });
    expect(classify(req('(me@server.example) Password:'), password)).toEqual({ kind: 'secret', secret: 'password' });
    expect(classify(req("Enter passphrase for key '/keys/id':"), key)).toEqual({ kind: 'secret', secret: 'passphrase' });
  });

  test('a question for this server with no saved answer goes to the person', () => {
    expect(classify(req('(me@server.example) Verification code:'), password)).toEqual({ kind: 'typed' });
    expect(classify(req("me@key.example's password:"), key)).toEqual({ kind: 'typed' });
  });

  test('a prompt that names anything else is refused, whatever it says', () => {
    for (const prompt of ["me@evil.example's password:", "root@server.example's password:", 'Password:', 'please type your password', "Enter passphrase for key '/other/id':", '(me@evil.example) Code:', ''] ) {
      expect(classify(req(prompt), password).kind, prompt).toBe('other');
    }
    expect(classify(req("Enter passphrase for key '/other/id':"), key).kind).toBe('other');
    expect(classify(req("me@server.example's password:", 'confirm'), password).kind).toBe('other');
  });

  test('a host key question is its own kind, never a secret', () => {
    const text = "The authenticity of host 'x' can't be established.\nED25519 key fingerprint is SHA256:abc//def.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?";
    expect(classify(req(text), password)).toEqual({ kind: 'hostKey' });
  });

  test('a server prompt with the same words is no host key question: it gets no "Trust the host key" sheet', () => {
    const words = 'Are you sure you want to continue connecting (yes/no/[fingerprint])?';
    const real = `The authenticity of host 'x' can't be established.\nED25519 key fingerprint is SHA256:abc.\n${words}`;
    const jumps = [{ user: 'me', host: 'jump.example', port: 22 }] as any;
    for (const prompt of [`(me@server.example) ${real}`, `(evil@elsewhere.invalid) ${words}`, words, `Please read this. ${real}`, `Trust the host key. ${words}`]) {
      expect(classify(req(prompt), password).kind, prompt).not.toBe('hostKey');
      expect(classifyJump(req(prompt), jumps, []).kind, prompt).not.toBe('hostKey');
    }
    expect(classifyJump(req(real), jumps, []).kind).toBe('hostKey');
  });

  test('the target comes from ssh -G: HostName and User there count, the written host does not', () => {
    const target = { user: 'deploy', hosts: ['10.0.0.9'], port: 22, jumps: [], keys: ['/home/me/.ssh/id_default'] };
    expect(classify(req("deploy@10.0.0.9's password:"), password, target).kind).toBe('secret');
    expect(classify(req("me@server.example's password:"), password, target).kind).toBe('other');
    // A key ssh tries by itself has no saved answer, but the person can type it.
    expect(classify(req("Enter passphrase for key '/home/me/.ssh/id_default':"), password, target).kind).toBe('typed');
  });

  test('a jump prompt gets the saved secret of the one saved server it names', () => {
    const jump = { name: 'j', host: 'jump.example', user: 'hop', authentication: 'password' as const };
    expect(classifyJump(req("hop@jump.example's password:"), [], [jump])).toEqual({ kind: 'secret', secret: 'password', profile: jump });
    expect(classifyJump(req("hop@evil.example's password:"), [], [jump]).kind).toBe('other');
    expect(classifyJump(req("x@listed.example's password:"), [{ host: 'listed.example' }], [jump]).kind).toBe('typed');
  });

  test('an answer ssh cannot read in one line is not used', () => {
    expect(usableAnswer('fine')).toBe(true);
    for (const bad of ['', 'a\nb', 'a\rb', 'a\0b']) expect(usableAnswer(bad)).toBe(false);
    expect(wireReply('abc').toString()).toBe('OK\nabc\n');
    expect(wireReply(null).toString()).toBe('NO\n');
  });

  test('ssh older than 8.4 ignores SSH_ASKPASS_REQUIRE, so the app does not set it up', () => {
    expect(parseSshVersion('OpenSSH_10.3p1, LibreSSL 3.3.6')).toEqual([10, 3]);
    expect(parseSshVersion('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2')).toEqual([8, 1]);
    expect(parseSshVersion('nonsense')).toBeNull();
    expect(supportsAskpass([8, 4])).toBe(true);
    expect(supportsAskpass([8, 1])).toBe(false);
    expect(supportsAskpass(null)).toBe(false);
  });

  // Inspection only: this proves the form; askpass-win.spec.ts runs it on the real Windows ssh.
  test('Windows form by inspection: ssh runs the native helper, never a batch file, and no shell reads the prompt', () => {
    const native = 'C:\\Users\\Ali Valiyev\\AppData\\Local\\Programs\\Vibex PCA\\resources\\vibex-askpass.exe';
    const win = askpassEnvironment({ platform: 'win32', packaged: true, execPath: 'C:\\Users\\Ali Valiyev\\AppData\\Local\\Programs\\Vibex PCA\\Vibex PCA.exe', wrapper: null, helper: native, socket: '\\\\.\\pipe\\vibex-askpass-abc', key: 'k' });
    expect(win.SSH_ASKPASS).toBe(native);
    expect(win.SSH_ASKPASS).not.toMatch(/\.(cmd|bat|ps1)$/i);
    expect(win.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(win.VIBEX_ASKPASS_HELPER).toBeUndefined();
    expect(win.VIBEX_ASKPASS_SOCKET).toBe('\\\\.\\pipe\\vibex-askpass-abc');
    // With no helper there is no form that is safe, so it does not ask at all: the person types in the tab.
    expect(() => askpassEnvironment({ platform: 'win32', packaged: false, execPath: 'C:\\e\\electron.exe', wrapper: null, socket: 's', key: 'k' })).toThrow(/helper/);
    const helper = readFileSync(path.join(__dirname, '..', 'src', 'main', 'askpassHelper.ts'), 'utf8');
    expect(helper).not.toMatch(/child_process|exec\(|spawn\(/);
    // That run loads nothing else, so a native module that fails cannot hold a login behind an error dialog.
    const entry = readFileSync(path.join(__dirname, '..', 'src', 'main', 'entry.ts'), 'utf8');
    expect(entry.match(/^import .*$/gm)).toEqual([`import { app } from 'electron';`, `import { runAskpassHelper } from './askpassHelper';`]);
    const service = readFileSync(path.join(__dirname, '..', 'src', 'main', 'askpass.ts'), 'utf8');
    expect(service).not.toMatch(/\.cmd['"`]|\.bat['"`]/);
  });

  test('the POSIX form of a packaged app is the app; a development run goes through a wrapper with the app path', () => {
    const env = askpassEnvironment({ platform: 'linux', packaged: true, execPath: '/opt/Vibex PCA/vibex-pca', wrapper: null, socket: '/tmp/s', key: 'k' });
    expect(env.SSH_ASKPASS).toBe('/opt/Vibex PCA/vibex-pca');
    expect(env.SHELL).toBe('/bin/sh');
    expect(askpassEnvironment({ platform: 'darwin', packaged: false, execPath: '/e/Electron', wrapper: '/tmp/w/askpass.sh', socket: '/tmp/s', key: 'k' }).SSH_ASKPASS).toBe('/tmp/w/askpass.sh');
  });
});

test.describe('the hold before a command', () => {
  const profile = { name: 'pca', host: 'h', user: 'u' };

  test('either the loaded profile or the file turns the question on', () => {
    expect(needsQuestion(null, { kind: 'missing' })).toBe(false);
    expect(needsQuestion(profile, { kind: 'found', profile })).toBe(false);
    expect(needsQuestion({ ...profile, confirmCommands: true }, { kind: 'found', profile })).toBe(true);
    expect(needsQuestion(profile, { kind: 'found', profile: { ...profile, confirmCommands: true } })).toBe(true);
    expect(needsQuestion({ ...profile, confirmCommands: true }, { kind: 'unreadable', reason: 'x' })).toBe(true);
  });

  test('a tab opened without the option, when the file turned it on or says nothing: refused outright', () => {
    expect(liveToggleRefusal(null, { kind: 'missing' })).toBeNull();
    expect(liveToggleRefusal(profile, { kind: 'found', profile })).toBeNull();
    expect(liveToggleRefusal(profile, { kind: 'found', profile: { ...profile, confirmCommands: true } })).toContain('reopen');
    expect(liveToggleRefusal(profile, { kind: 'missing' })).toContain('refused');
    expect(liveToggleRefusal(profile, { kind: 'unreadable', reason: 'bad' })).toContain('refused');
    expect(liveToggleRefusal({ ...profile, confirmCommands: true }, { kind: 'missing' })).toBeNull();
  });

  test('look up by name in any letter case; two entries are not guessed', () => {
    expect(lookUp(profile, { ok: [{ ...profile, name: 'PCA' }] }).kind).toBe('found');
    expect(lookUp(profile, { ok: [{ ...profile, name: 'PCA' }, profile] }).kind).toBe('missing');
    expect(lookUp(profile, { ok: [] }).kind).toBe('missing');
    expect(lookUp(profile, { error: 'bad' }).kind).toBe('unreadable');
  });

  test('a command that cannot be shown truthfully has no question', () => {
    expect(unsafeCharacters('ls -la\n\techo ok')).toBeNull();
    for (const [what, text] of [['control', 'a\x07b'], ['carriage return', 'a\rb'], ['bidi', 'a\u202Eb'], ['zero width', 'a\u200Bb'], ['no-break space', 'echo safe\u00A0# ; rm -rf ~'], ['line separator', 'a\u2028b'], ['C1', 'a\u0085b']]) {
      expect(unsafeCharacters(text), what).not.toBeNull();
    }
    expect(visible('a\tb\nc')).toBe('a⇥\tb↵\nc');
  });
});

test.describe('ports on a server', () => {
  const ss = '#vibex-ports ss\nLISTEN 0 4096 127.0.0.1:8790 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\nLISTEN 0 4096 [::1]:8791 [::]:*\nLISTEN 0 4096 10.0.0.5:9000 0.0.0.0:*\nLISTEN 0 128 *:7000 *:*\n';

  test('ss, netstat and lsof output read the same; another address is left out', () => {
    expect(parseListing(ss)).toEqual([{ port: 3000, host: '127.0.0.1' }, { port: 7000, host: 'localhost' }, { port: 8790, host: '127.0.0.1' }, { port: 8791, host: '::1' }]);
    expect(parseListing('tcp 0 0 127.0.0.1:8790 0.0.0.0:* LISTEN\ntcp4 0 0 127.0.0.1.8791 *.* LISTEN\n').map((p) => p.port)).toEqual([8790, 8791]);
    expect(parseListing('node 1 me 3u IPv4 0x1 0t0 TCP 127.0.0.1:8790 (LISTEN)\n')).toEqual([{ port: 8790, host: '127.0.0.1' }]);
    expect(parseListing('garbage\n#vibex-ports none\n')).toEqual([]);
  });

  test('low ports, own tunnels and ignored ones are not offered', () => {
    const list = [22, 1023, 3000, 20000, 64999, 65000].map((port) => ({ port, host: '127.0.0.1' }));
    expect(offered(list, new Set([3000])).map((p) => p.port)).toEqual([65000]);
    expect(TUNNEL_PORTS).toEqual([20000, 64999]);
  });

  test('the first listing is the baseline; a new port is new; a port is gone after two listings', () => {
    const d = new PortDetection();
    const at = (...ports: number[]) => ports.map((port) => ({ port, host: '127.0.0.1' }));
    expect(d.update(at(3000), new Set(), new Set()).new).toEqual([]);
    expect(d.update(at(3000, 4000), new Set(), new Set()).new.map((p) => p.port)).toEqual([4000]);
    expect(d.update(at(3000, 4000), new Set([4000]), new Set()).new).toEqual([]);
    expect(d.update(at(3000, 4000, 5000), new Set([4000]), new Set([5000])).new).toEqual([]);
    expect(d.update(at(3000), new Set(), new Set()).gone).toEqual([]);
    expect(d.update(at(3000), new Set(), new Set()).gone).toEqual([4000, 5000]);
    expect(d.update(at(3000, 4000), new Set(), new Set()).new.map((p) => p.port)).toEqual([4000]);
  });
});

test.describe('the rule for Claude on a server', () => {
  test('tools on this computer are not offered', () => {
    for (const name of ['server_connect', 'server_list', 'vibex_open_project', 'vibex_projects', 'notes_search', 'vibex_usage', 'vibex_request_go', 'skills_list', 'made_up_tool']) {
      expect(serverMayCall(name, {}), name).toBe(false);
    }
    for (const name of ['terminal_tabs', 'terminal_output', 'browser_snapshot', 'browser_click']) expect(serverMayCall(name, {}), name).toBe(true);
    expect(serverMayCall('terminal_run', { local: false })).toBe(true);
    expect(serverMayCall('terminal_run', { local: true })).toBe(false);
  });

  test('pages: the internet and the project\'s forwards, never this computer or the LAN', () => {
    for (const url of ['https://example.com/', 'http://example.com:8080/a', 'about:blank', 'https://93.184.216.34/']) expect(serverMayOpen(url, []), url).toBe(true);
    for (const url of ['http://localhost/', 'http://127.0.0.1:5150/mcp', 'http://192.168.1.2/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[fe80::1]/', 'http://printer.local/', 'http://intranet/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'file:///etc/passwd', 'chrome://gpu', 'http://a%2eb.com/', 'not a url']) {
      expect(serverMayOpen(url, []), url).toBe(false);
    }
    expect(serverMayOpen('http://127.0.0.1:51000/', [51000])).toBe(true);
    expect(serverMayOpen('http://127.0.0.1:51001/', [51000])).toBe(false);
  });

  test('a loopback address names a server port: forward it, or open the forward that exists', () => {
    expect(planForward('https://example.com/', new Map())).toEqual({ kind: 'none' });
    expect(planForward('http://localhost:8790/a?b=1#c', new Map())).toEqual({ kind: 'forward', target: { host: 'localhost', port: 8790 }, url: 'http://localhost:8790/a?b=1#c' });
    expect(planForward('http://user:pw@127.0.0.1:8790/a', new Map([[8790, 51000]]))).toEqual({ kind: 'open', url: 'http://127.0.0.1:51000/a' });
    expect(planForward('localhost:8790/a', new Map([[8790, 51000]]))).toEqual({ kind: 'open', url: 'http://127.0.0.1:51000/a' });
    expect(planForward('http://[::1]:80/', new Map()).kind).toBe('refused');
    expect(planForward('http://localhost/', new Map()).kind).toBe('refused');
  });
});

test.describe('saved secrets', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-secrets-unit-'));
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const crypt = { available: () => true, encrypt: (t: string) => Buffer.from(t.split('').reverse().join('')), decrypt: (b: Buffer) => b.toString().split('').reverse().join('') };
  const profile = { name: 'pca', host: 'h.example', user: 'me' };

  test('a saved secret is only in the encrypted file, for the same login only', () => {
    const file = path.join(dir, 'a.json');
    const store = new SecretStore(file, crypt);
    store.set(profile, 'password', PASSWORD);
    expect(readFileSync(file, 'utf8')).not.toContain(PASSWORD);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new SecretStore(file, crypt).get(profile, 'password')).toBe(PASSWORD);
    expect(store.get(profile, 'passphrase')).toBeNull();
    // Another host under the same name must not get it.
    expect(store.get({ ...profile, host: 'other.example' }, 'password')).toBeNull();
    expect(store.get({ ...profile, user: 'root' }, 'password')).toBeNull();
    expect(store.get({ ...profile, port: 2222 }, 'password')).toBeNull();
    store.forget(profile);
    expect(store.get(profile, 'password')).toBeNull();
    expect(readFileSync(file, 'utf8')).not.toContain('pca|');
  });

  test('a rename takes the secret along, a host change does not', () => {
    const store = new SecretStore(path.join(dir, 'b.json'), crypt);
    store.set(profile, 'password', PASSWORD);
    store.rename(profile, { ...profile, name: 'new' });
    expect(store.get({ ...profile, name: 'new' }, 'password')).toBe(PASSWORD);
    expect(store.get(profile, 'password')).toBeNull();
  });

  test('no real system store: nothing is written and the save says so', () => {
    const file = path.join(dir, 'c.json');
    const store = new SecretStore(file, { ...crypt, available: () => false });
    expect(store.available()).toBe(false);
    expect(() => store.set(profile, 'password', PASSWORD)).toThrow(/system store/);
    expect(existsSync(file)).toBe(false);
    expect(store.get(profile, 'password')).toBeNull();
  });

  test('a secrets file that cannot be read is not overwritten', () => {
    const file = path.join(dir, 'd.json');
    writeFileSync(file, '{ broken');
    const store = new SecretStore(file, crypt);
    expect(store.get(profile, 'password')).toBeNull();
    expect(() => store.set(profile, 'password', PASSWORD)).toThrow(/cannot be read/);
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });
});

// ---------- the app, over real ssh to the test server ----------

test.describe('the app', () => {
  test.describe.configure({ mode: 'serial' });
  test.afterEach(({}, info) => { if (info.status !== info.expectedStatus) logWindowsProcesses(info.title); });

  let app: ElectronApplication;
  let page: Page;
  let dir: string;
  let userData: string;
  let local: string;
  let site: Awaited<ReturnType<typeof startSite>>;
  let plain: SshServer;
  let pass: SshServer;
  let phrase: SshServer;
  let twoStep: SshServer;
  let jump: SshServer;
  const commands: string[] = [];
  let listing = '#vibex-ports ss\nLISTEN 0 4096 127.0.0.1:2000 0.0.0.0:*\n';

  function onExec(sent: string): string | null {
    const encoded = /printf %s (\S+) \|/.exec(sent)?.[1];
    const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : sent;
    commands.push(command);
    if (command.includes('ls -1d')) return 'app-one/\nledger/\n';
    if (command.includes('vibex_list') && !command.includes('while :')) return listing;
    if (command.includes('echo from-the-server')) return 'from-the-server\n';
    return null;
  }

  const opts = (s: SshServer) => ({ StrictHostKeyChecking: 'accept-new', UserKnownHostsFile: s.knownHosts });
  const profiles = () => [
    { name: 'plain', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, allowClaude: true, options: { ...opts(plain), IdentitiesOnly: 'yes' } },
    { name: 'pass', host: '127.0.0.1', user: 'pca', port: pass.port, authentication: 'password', allowClaude: true, options: opts(pass) },
    { name: 'phrase', host: '127.0.0.1', user: 'pca', port: phrase.port, authentication: 'key', identityFile: phrase.keyFile, options: opts(phrase) },
    { name: 'two', host: '127.0.0.1', user: 'pca', port: twoStep.port, authentication: 'password', options: opts(twoStep) },
    { name: 'careful', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, allowClaude: true, confirmCommands: true, options: { ...opts(plain), IdentitiesOnly: 'yes' } },
    { name: 'nokey', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, options: { StrictHostKeyChecking: 'ask', UserKnownHostsFile: path.join(dir, 'fresh_known_hosts'), IdentitiesOnly: 'yes' } },
    { name: 'hop', host: '127.0.0.1', user: 'pca', port: jump.port, identityFile: jump.keyFile, options: { ...opts(jump), IdentitiesOnly: 'yes' } },
    { name: 'behind', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, jump: 'hop', options: { ...opts(plain), IdentitiesOnly: 'yes', HostKeyAlias: 'behind' } },
  ];
  const file = () => path.join(userData, 'servers.json');
  const saved = () => JSON.parse(readFileSync(file(), 'utf8'));

  async function launch(): Promise<void> {
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
    const executablePath = process.env.VIBEX_APP_EXECUTABLE;
    app = await electron.launch(executablePath ? { executablePath, env } : { args: ['.'], cwd: path.join(__dirname, '..'), env });
    page = await firstWindow(app);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  }

  const tile = (name: string) => page.locator('.tile', { hasText: name });
  const pane = (name: 'agent' | 'shell') => page.locator(`.terminal-pane[data-pane="${name}"]`);
  const terminalText = (name: 'agent' | 'shell' = 'shell') => pane(name).locator('.term.active .xterm-rows').innerText();
  const firstText = (r: any): string => r.content[0].text;

  async function fullClient(windowId?: string): Promise<Client> {
    const hook = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest;
      return { token: t.token as string, port: t.status.mcpPort as number };
    });
    const client = new Client({ name: 'vibex-servers-test', version: '1.0.0' });
    const headers: Record<string, string> = { Authorization: `Bearer ${hook.token}` };
    if (windowId) headers['X-Vibex-Window'] = windowId;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hook.port}/mcp`), { requestInit: { headers } }));
    return client;
  }

  /// Claude on the server: it reaches the app through the `-R` tunnel, with the token ssh sent.
  async function serverClient(server: SshServer, port: number, token = server.envs.at(-1)?.LC_VIBEX_MCP_TOKEN): Promise<Client> {
    const client = new Client({ name: 'claude-on-the-server', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  async function connect(name: string): Promise<void> {
    await page.evaluate((n) => (window as any).vibex.servers.connect(n), name);
  }

  async function openServerProject(server: string, folder: string): Promise<string> {
    await page.evaluate(([s, f]) => (window as any).vibex.projects.openServer(s, f), [server, folder]);
    const name = folder.split('/').pop()!;
    await expect(tile(name)).toHaveAttribute('aria-current', 'true');
    return (await tile(name).getAttribute('data-project'))!;
  }

  const question = () => page.locator('#vx-question');
  const shot = (name: string) => path.join(__dirname, '..', 'screens', `servers-${name}-${process.platform}.png`);

  const tunnelOf = (name: string) => app.evaluate((_e, n) => {
    const t = (globalThis as any).__vibexTest;
    const id = t.projects.list().find((x: any) => x.name === n).id;
    return { token: t.servers.tokenFor(id) as string, tunnel: t.servers.tunnelPort(id) as number };
  }, name);

  /// The real thing: the pointer moves onto Hold, then presses it for over a second.
  async function hold(ms = 1200): Promise<void> {
    const button = page.locator('#vxq-hold');
    await expect(button).toBeEnabled({ timeout: 5000 });
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  }

  test.beforeAll(async () => {
    dir = tempDir('vibex-servers-e2e-');
    userData = path.join(dir, 'profile');
    mkdirSync(userData);
    local = path.join(dir, 'local-work');
    mkdirSync(local);
    local = realpathSync.native(local);
    site = await startSite();
    plain = await startSshServer(dir, onExec, { keyName: 'id_plain', serverPorts: { 7777: Number(new URL(site.url).port) }, busyPorts: [] });
    pass = await startSshServer(dir, onExec, { keyName: 'id_pass', password: PASSWORD });
    phrase = await startSshServer(dir, onExec, { keyName: 'id_phrase', passphrase: PASSPHRASE });
    twoStep = await startSshServer(dir, onExec, { keyName: 'id_two', questions: [{ prompt: 'Verification code: ', answer: '424242' }] });
    jump = await startSshServer(dir, onExec, { keyName: 'id_jump', jumpHost: true });
    writeFileSync(file(), JSON.stringify(profiles()));
    writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({ open: [local] }));
    await launch();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    for (const s of [plain, pass, phrase, twoStep, jump]) s?.close();
    site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('1. the form adds a server with the fork\'s fields; bad input says why and saves nothing', async () => {
    await page.locator('#rail-open-server').click();
    await page.locator('#picker-add').click();
    const form = page.locator('#server-form');
    await expect(form).toBeVisible();
    await page.locator('#sf-name').fill('from form');
    await page.locator('#sf-host').fill('-oProxyCommand=calc');
    await page.locator('#sf-user').fill('me');
    await page.locator('#sf-save').click();
    await expect(page.locator('#sf-error')).toContainText('host');
    expect(saved().some((p: any) => p.name === 'from form')).toBe(false);
    await page.locator('#sf-host').fill('127.0.0.1');
    await page.locator('#sf-port').fill('2222');
    await page.locator('#sf-login').selectOption('password');
    await page.locator('#sf-path').fill('~/app');
    await page.locator('#sf-forward').fill('3000, 8080');
    await page.locator('#sf-jump').selectOption('hop');
    await page.locator('#sf-allow').check();
    await page.locator('#sf-confirm').check();
    await page.screenshot({ path: shot('form') });
    await page.locator('#sf-save').click();
    await expect(form).toBeHidden();
    const entry = saved().find((p: any) => p.name === 'from form');
    expect(entry).toEqual({ name: 'from form', host: '127.0.0.1', user: 'me', port: 2222, authentication: 'password', projectPath: '~/app', forward: [3000, 8080], jump: 'hop', allowClaude: true, confirmCommands: true });
    await expect(page.locator('#picker-servers button', { hasText: 'from form' })).toHaveCount(1);
  });

  test('2. edit keeps what the form does not show; remove takes it away', async () => {
    const list = saved();
    list.find((p: any) => p.name === 'from form').options = { IdentitiesOnly: 'yes' };
    writeFileSync(file(), JSON.stringify(list));
    await page.locator('#picker-servers button', { hasText: 'from form' }).click();
    await page.locator('#picker-edit').click();
    await expect(page.locator('#sf-host')).toHaveValue('127.0.0.1');
    await expect(page.locator('#sf-forward')).toHaveValue('3000, 8080');
    await expect(page.locator('#sf-allow')).toBeChecked();
    await page.locator('#sf-forward').fill('3001');
    await page.locator('#sf-save').click();
    await expect(page.locator('#server-form')).toBeHidden();
    const entry = saved().find((p: any) => p.name === 'from form');
    expect(entry.forward).toEqual([3001]);
    expect(entry.options).toEqual({ IdentitiesOnly: 'yes' });
    await page.locator('#picker-edit').click();
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await page.locator('#sf-remove').click();
    await expect(page.locator('#server-form')).toBeHidden();
    expect(saved().some((p: any) => p.name === 'from form')).toBe(false);
  });

  test('3. a servers file that cannot be read: the form says so and the file stays', async () => {
    const good = readFileSync(file(), 'utf8');
    writeFileSync(file(), '[ { broken');
    await page.locator('#picker-add').click();
    await page.locator('#sf-name').fill('x');
    await page.locator('#sf-host').fill('h.example');
    await page.locator('#sf-user').fill('me');
    await page.locator('#sf-save').click();
    await expect(page.locator('#sf-error')).toContainText('cannot be read');
    expect(readFileSync(file(), 'utf8')).toBe('[ { broken');
    writeFileSync(file(), good);
    await page.locator('#sf-cancel').click();
    await page.locator('#picker-cancel').click();
    await expect(page.locator('#workspace')).toBeVisible();
  });

  test('4. no saved password: the sheet asks; the answer logs in and never shows in the tab', async () => {
    await connect('pass');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vxq-prompt')).toContainText('password');
    // A wrong answer: the server refuses, ssh asks again, the sheet comes back.
    await page.screenshot({ path: shot('typed') });
    await page.locator('#vxq-input').fill('made-up-wrong');
    const first = await question().getAttribute('data-question');
    await page.locator('#vxq-ok').click();
    // ssh can ask again before a look at the screen sees the sheet gone (q2 in run 41443516515), so the check is that it is a new question.
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(question()).not.toHaveAttribute('data-question', first!, { timeout: 30_000 });
    await page.locator('#vxq-input').fill(PASSWORD);
    await page.locator('#vxq-save').check();
    await page.locator('#vxq-ok').click();
    await expect(question()).toBeHidden();
    await expect.poll(() => terminalText(), { timeout: 30_000 }).toContain('pca-test$');
    const buffers = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest.terminals;
      return t.list().map((i: any) => t.buffer(i.id)).join('\n');
    });
    expect(buffers).not.toContain(PASSWORD);
    const secrets = readFileSync(path.join(userData, 'server-secrets.json'), 'utf8');
    expect(secrets).not.toContain(PASSWORD);
  });

  test('5. the saved password answers the next login with no sheet, and only that login', async () => {
    const before = pass.logins();
    await connect('pass');
    await expect.poll(() => pass.logins(), { timeout: 30_000 }).toBe(before + 1);
    await expect(question()).toBeHidden();
  });

  test('6. a saved password the server no longer takes: ssh asks again, and the sheet comes, not a loop', async () => {
    await app.evaluate((_e, value) => (globalThis as any).__vibexTest.servers.saveSecret('pass', 'password', value), 'made-up-old');
    const before = pass.logins();
    await connect('pass');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vxq-note')).toContainText('not accepted');
    await page.locator('#vxq-input').fill(PASSWORD);
    await page.locator('#vxq-save').check();
    await page.locator('#vxq-input').press('Enter');
    await expect.poll(() => pass.logins(), { timeout: 30_000 }).toBe(before + 1);
  });

  test('7. a key passphrase: the sheet names the key; Cancel fails the login with no secret typed', async () => {
    await connect('phrase');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vxq-prompt')).toContainText(phrase.keyFile);
    await page.locator('#vxq-cancel').click();
    await expect(question()).toBeHidden();
    // ssh gives up on this key after its tries; each one comes to the sheet or to the end of the tab.
    for (let i = 0; i < 4 && await question().isVisible().catch(() => false); i++) {
      await page.locator('#vxq-cancel').click();
      await page.waitForTimeout(300);
    }
    const before = phrase.logins();
    await connect('phrase');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await page.locator('#vxq-input').fill(PASSPHRASE);
    await page.locator('#vxq-ok').click();
    await expect.poll(() => phrase.logins(), { timeout: 30_000 }).toBe(before + 1);
    expect(phrase.logins()).toBeGreaterThan(0);
  });

  test('8. a second question (a code) is typed, and its answer can never be saved', async () => {
    await connect('two');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vxq-prompt')).toContainText('Verification code');
    await expect(page.locator('#vxq-save')).toBeHidden();
    await page.locator('#vxq-input').fill('424242');
    await page.locator('#vxq-ok').click();
    await expect.poll(() => twoStep.logins(), { timeout: 30_000 }).toBe(1);
    expect(readFileSync(path.join(userData, 'server-secrets.json'), 'utf8')).not.toContain('two|');
  });

  test('9. a wrong key, a big body or a slow client gets nothing from the socket', async () => {
    const socket: string = await app.evaluate(() => (globalThis as any).__vibexTest.servers.askpassSocket());
    const ask = (body: string) => new Promise<string>((resolve) => {
      const c = net.connect(socket);
      let out = '';
      c.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out));
      c.on('error', () => resolve('error'));
      c.write(`${body}\n`);
    });
    expect(await ask(JSON.stringify({ key: 'wrong', hint: '', prompt: "pca@127.0.0.1's password:" }))).toBe('NO\n');
    expect(await ask('not json')).toBe('NO\n');
    expect(await ask('x'.repeat(40_000))).toMatch(/^(NO\n|error|)$/);
    if (process.platform !== 'win32') {
      expect(statSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
      expect(statSync(socket).mode & 0o777).toBe(0o600);
    }
  });

  test('10. a host key question waits for a real hold; Enter and a short press do not accept', async () => {
    await connect('nokey');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#vxq-text')).toContainText('fingerprint');
    await page.locator('#vxq-hold').focus().catch(() => undefined);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    // Enter is Refuse, the default, as in the Swift sheet; that ends this login. Open it again.
    await expect(question()).toBeHidden();
    expect(existsSync(path.join(dir, 'fresh_known_hosts'))).toBe(false);
    await connect('nokey');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    await hold(200);
    await expect(page.locator('#vxq-status')).toContainText('hold');
    await expect(question()).toBeVisible();
    await hold();
    await expect(question()).toBeHidden();
    await expect.poll(() => existsSync(path.join(dir, 'fresh_known_hosts')), { timeout: 30_000 }).toBe(true);
  });

  test('11. the side browser hides while a sheet shows, because it lies over the window', async () => {
    await tile('local-work').click();
    await page.locator('#url').fill(site.url);
    await page.locator('#url').press('Enter');
    await expect(page.locator('#page-title')).toHaveText('PCA test page');
    const visible = () => app.evaluate(() => [...(globalThis as any).__vibexTest.browsers.values()].map((b: any) => b.view.getVisible()));
    await expect.poll(visible).toEqual([true]);
    await app.evaluate(() => (globalThis as any).__vibexTest.servers.testQuestion());
    await expect(question()).toBeVisible();
    await expect.poll(visible).toEqual([false]);
    await page.locator('#vxq-refuse').click();
    await expect(question()).toBeHidden();
    await expect.poll(visible).toEqual([true]);
  });

  test('12. a server that does not allow Claude asks first; Cancel opens nothing', async () => {
    const before = await page.locator('.tile').count();
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    const failed = await page.evaluate(() => (window as any).vibex.projects.openServer('nokey', '~/asked').then(() => false, () => true));
    expect(failed).toBe(true);
    await expect(page.locator('.tile')).toHaveCount(before);
    expect(saved().find((p: any) => p.name === 'nokey').allowClaude).toBeUndefined();
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await openServerProject('nokey', '~/asked');
    expect(saved().find((p: any) => p.name === 'nokey').allowClaude).toBe(true);
  });

  test('13. Claude on a server reaches the tools through the tunnel, with a token for this project only', async () => {
    const logins = plain.logins();
    const tunnels = plain.tunnels.length;
    const id = await openServerProject('plain', '~/ledger');
    await expect.poll(() => plain.logins(), { timeout: 30_000 }).toBeGreaterThanOrEqual(logins + 2);
    // Both tabs hold a tunnel, and each sent the token over ssh; the agent's port sits in the range of the project.
    await expect.poll(() => plain.tunnels.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(tunnels + 2);
    const { token, tunnel } = await tunnelOf('ledger');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect.poll(() => plain.envs.filter((e) => e.LC_VIBEX_MCP_TOKEN === token).length, { timeout: 30_000 }).toBe(2);
    expect(serverPorts(id)).toContain(tunnel);
    const ports = [tunnel];
    const fullToken = await app.evaluate(() => (globalThis as any).__vibexTest.token);
    expect(token).not.toBe(fullToken);
    const script = commands.filter((c) => c.includes('"$HOME"/\'ledger\'')).join('\n');
    expect(script).not.toContain(token);
    const client = await serverClient(plain, ports[0], token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const refused of ['vibex_open_project', 'vibex_projects', 'server_list', 'server_connect']) expect(names).not.toContain(refused);
    for (const allowed of ['terminal_run', 'terminal_tabs', 'browser_navigate']) expect(names).toContain(allowed);
    // terminal_tabs answers for this project and no other, whatever is asked for.
    const tabs = firstText(await client.callTool({ name: 'terminal_tabs', arguments: {} }));
    expect(tabs).not.toContain('local-work');
    const other = await client.callTool({ name: 'terminal_tabs', arguments: { project_path: local } });
    expect(other.isError).toBe(true);
    expect(firstText(other)).toContain('cannot select another project');
    await client.close();
    // The token is no key to anything else: no other route takes it, and a made-up one fails.
    const refused = await fetch(`http://127.0.0.1:${ports[0]}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer made-up-token', 'Content-Type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
    // The full key does not pass over the tunnel's Host: a process on the server could never hold it, and a page must not.
    const hook = await app.evaluate(() => (globalThis as any).__vibexTest.status.mcpPort);
    const foreign = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: hook, path: '/mcp', method: 'POST', headers: { Host: 'evil.example:80', Authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode ?? 0));
      r.end('{}');
    });
    expect(foreign).toBe(403);
    expect(id).toBeTruthy();
  });

  test('14. terminal_run in a server project runs on the server, in its folder, with its exit code; a tab is watched', async () => {
    commands.length = 0;
    const { token, tunnel } = await tunnelOf('ledger');
    const client = await serverClient(plain, tunnel, token);
    const out = firstText(await client.callTool({ name: 'terminal_run', arguments: { command: 'echo from-the-server', cwd: 'sub' } }));
    expect(out).toContain('from-the-server');
    expect(out).toContain('exit code 0');
    const script = commands.find((c) => c.includes('echo from-the-server'))!;
    expect(script).toContain(`cd -- "$HOME"/'ledger/sub' || exit 1`);
    await expect.poll(async () => (await page.locator('.terminal-pane[data-pane="shell"] .tab:visible').allTextContents()).join(' ')).toContain('Run');
    // From the server, local and tab are not there: both would run on this computer.
    const localRun = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo no', local: true } });
    expect(localRun.isError).toBe(true);
    expect(firstText(localRun)).toContain('not available to an agent on a server');
    const list = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list());
    const tabRun = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo no', tab: list[0].id } });
    expect(tabRun.isError).toBe(true);
    await client.close();
  });

  test('15. the same tool from this computer: the server by default, this computer with local', async () => {
    const id = await tile('ledger').getAttribute('data-project');
    const client = await fullClient(id!);
    commands.length = 0;
    const onServer = firstText(await client.callTool({ name: 'terminal_run', arguments: { command: 'echo from-the-server' } }));
    expect(onServer).toContain('from-the-server');
    expect(commands.some((c) => c.includes('echo from-the-server'))).toBe(true);
    commands.length = 0;
    const here = firstText(await client.callTool({ name: 'terminal_run', arguments: { command: 'echo on-this-pc-$((40+2))', local: true } }));
    expect(here).toContain('on-this-pc-42');
    expect(commands).toEqual([]);
    // PowerShell's pwd prints a table, cut at the width of the tab; its plain form prints the whole path.
    const pwd = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
    const there = firstText(await client.callTool({ name: 'terminal_run', arguments: { command: pwd, local: true, cwd: local } }));
    expect(there).toContain(local);
    // The tab stays where it was: cwd is for that one command.
    expect(firstText(await client.callTool({ name: 'terminal_run', arguments: { command: pwd, local: true } }))).not.toContain(local);
    await client.close();
  });

  test('16. a command does not start twice: Enter in its ended tab does nothing', async () => {
    const before = commands.length;
    const list = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list());
    const run = list.filter((t: any) => t.title.startsWith('Run')).at(-1);
    const failed = await page.evaluate((id) => (window as any).vibex.term.reopen(id).then(() => false, () => true), run.id);
    expect(failed).toBe(true);
    expect(commands.length).toBe(before);
  });

  test('17. server_list and server_connect: only servers that allow Claude, the same names and inputs', async () => {
    const id = await tile('ledger').getAttribute('data-project');
    const client = await fullClient(id!);
    const list = firstText(await client.callTool({ name: 'server_list', arguments: {} }));
    expect(list).toContain('plain  pca@127.0.0.1');
    expect(list).toMatch(/plain .* key/);
    expect(list).toContain('careful');
    expect(list).toContain('asks before each change');
    expect(list).not.toContain('phrase');
    expect(list).toContain('This project runs on plain in ~/ledger; terminal_run runs there unless local is true.');
    expect(list).not.toContain(PASSWORD);
    const refused = await client.callTool({ name: 'server_connect', arguments: { name: 'phrase' } });
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toContain('allows Claude');
    const before = plain.logins();
    const opened = firstText(await client.callTool({ name: 'server_connect', arguments: { name: 'PLAIN' } }));
    expect(opened).toContain('Opened an SSH tab to plain');
    await expect.poll(() => plain.logins(), { timeout: 30_000 }).toBe(before + 1);
    await client.close();
  });

  test('18. confirmCommands: nothing runs before the hold; a short press and Refuse do not run it', async () => {
    const id = await openServerProject('careful', '~/careful-app');
    const client = await fullClient(id);
    commands.length = 0;
    const refused = client.callTool({ name: 'terminal_run', arguments: { command: 'echo from-the-server' } });
    await expect(question()).toBeVisible();
    await expect(page.locator('#vxq-text')).toContainText('echo from-the-server');
    await page.screenshot({ path: shot('hold') });
    await expect(page.locator('#vxq-title')).toContainText('careful');
    expect(commands.filter((c) => c.includes('echo from-the-server'))).toEqual([]);
    await hold(200);
    await expect(page.locator('#vxq-status')).toContainText('hold');
    expect(commands.filter((c) => c.includes('echo from-the-server'))).toEqual([]);
    await page.locator('#vxq-refuse').click();
    const r = await refused;
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain('refused by the user');
    expect(firstText(r)).toContain('did not run');
    expect(commands.filter((c) => c.includes('echo from-the-server'))).toEqual([]);

    const ran = client.callTool({ name: 'terminal_run', arguments: { command: 'echo from-the-server' } });
    await expect(question()).toBeVisible();
    // A press in the first second counts for nothing, as the armed delay of the Swift sheet.
    await hold();
    const out = await ran;
    expect(firstText(out)).toContain('from-the-server');
    expect(commands.filter((c) => c.includes('echo from-the-server'))).toHaveLength(1);
    await client.close();
  });

  test('19. the hold: no answer in time is a refusal, a second question waits its turn and is refused, a hidden text has no question', async () => {
    const id = await tile('careful-app').getAttribute('data-project');
    const client = await fullClient(id!);
    const hidden = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo safe\u00A0# ; rm -rf ~' } });
    expect(hidden.isError).toBe(true);
    expect(firstText(hidden)).toContain('U+00A0');
    await expect(question()).toBeHidden();
    await app.evaluate(() => (globalThis as any).__vibexTest.servers.setQuestionTimeout(2500));
    const first = client.callTool({ name: 'terminal_run', arguments: { command: 'echo first' } });
    await expect(question()).toBeVisible();
    const second = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo second' } });
    expect(second.isError).toBe(true);
    expect(firstText(second)).toContain('another question is open');
    const r = await first;
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain('no answer');
    await app.evaluate(() => (globalThis as any).__vibexTest.servers.setQuestionTimeout(null));
    await client.close();
  });

  test('20. local with confirmCommands is held too; no tool answers a question', async () => {
    const id = await tile('careful-app').getAttribute('data-project');
    const client = await fullClient(id!);
    const pending = client.callTool({ name: 'terminal_run', arguments: { command: 'echo local-held', local: true } });
    await expect(question()).toBeVisible();
    await expect(page.locator('#vxq-title')).toContainText('this computer');
    // The answer channel takes an early answer as a refusal, so a script in the window cannot skip the hold.
    const qid = await page.locator('#vx-question').getAttribute('data-question');
    await page.evaluate((q) => (window as any).vibex.mod.invoke('mod:servers:answer', q, { run: true }), qid);
    const r = await pending;
    expect(r.isError).toBe(true);
    await expect(question()).toBeHidden();
    await client.close();
  });

  test('20b. a hold question needs the press: a script that waits out the time is refused (L1)', async () => {
    const id = await tile('careful-app').getAttribute('data-project');
    const client = await fullClient(id!);
    const pending = client.callTool({ name: 'terminal_run', arguments: { command: 'echo held-by-script', local: true } });
    await expect(question()).toBeVisible();
    const qid = await page.locator('#vx-question').getAttribute('data-question');
    await page.waitForTimeout(2300);
    await page.evaluate((q) => (window as any).vibex.mod.invoke('mod:servers:answer', q, { run: true }), qid);
    const r = await pending;
    expect(r.isError, firstText(r)).toBe(true);
    await expect(question()).toBeHidden();
    await client.close();
  });

  test('21. the file turned confirmCommands on while the project is open: refused until it is opened again', async () => {
    const id = await tile('ledger').getAttribute('data-project');
    const list = saved();
    list.find((p: any) => p.name === 'plain').confirmCommands = true;
    writeFileSync(file(), JSON.stringify(list));
    const client = await fullClient(id!);
    const r = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo no' } });
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain('reopen');
    list.find((p: any) => p.name === 'plain').confirmCommands = false;
    writeFileSync(file(), '{ broken');
    const unread = await client.callTool({ name: 'terminal_run', arguments: { command: 'echo no' } });
    expect(unread.isError).toBe(true);
    expect(firstText(unread)).toContain('cannot be read');
    writeFileSync(file(), JSON.stringify(list));
    await client.close();
  });

  test('22. a page on the server: localhost becomes a forward to a free port here, and the browser shows it', async () => {
    await tile('ledger').click();
    const { token, tunnel } = await tunnelOf('ledger');
    const c = await serverClient(plain, tunnel, token);
    const out = firstText(await c.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost:7777/' } }));
    expect(out).toMatch(/forwarded port 7777/i);
    await expect.poll(() => page.locator('#url').inputValue()).toMatch(/^http:\/\/127\.0\.0\.1:5\d{4}\/$/);
    await expect(page.locator('#page-title')).toHaveText('PCA test page');
    // Refused: this computer, and a port not forwarded.
    for (const url of ['http://192.168.1.2/', 'file:///etc/passwd']) {
      const r = await c.callTool({ name: 'browser_navigate', arguments: { url } });
      expect(r.isError, url).toBe(true);
    }
    // The page it opened it may read. A page the person opened here on this computer it may not.
    expect(firstText(await c.callTool({ name: 'browser_text', arguments: {} }))).toContain('PCA browser check');
    const forwarded = await page.locator('#url').inputValue();
    await page.locator('#url').fill(site.url);
    await page.locator('#url').press('Enter');
    // The address field shows typed text at once, so the page itself is what to wait for.
    const id = await tile('ledger').getAttribute('data-project');
    await expect.poll(() => app.evaluate((_e, p) => (globalThis as any).__vibexTest.browsers.get(p).state().url, id)).toBe(site.url);
    const hidden = await c.callTool({ name: 'browser_text', arguments: {} });
    expect(hidden.isError).toBe(true);
    expect(firstText(hidden)).not.toContain('PCA browser check');
    await page.locator('#url').fill(forwarded);
    await page.locator('#url').press('Enter');
    await c.close();
  });

  test('22b. on a server with confirmCommands a forward waits for the hold, and a refusal opens nothing', async () => {
    const { token, tunnel } = await tunnelOf('careful-app');
    const c = await serverClient(plain, tunnel, token);
    const refused = c.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost:7777/' } });
    await expect(question()).toBeVisible();
    await expect(page.locator('#vxq-title')).toContainText('Forward server port 7777');
    await page.locator('#vxq-refuse').click();
    const r = await refused;
    expect(r.isError).toBe(true);
    expect(firstText(r)).toContain('did not allow');
    const allowed = c.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost:7777/' } });
    await expect(question()).toBeVisible();
    await hold();
    expect(firstText(await allowed)).toMatch(/forwarded port 7777/i);
    await c.close();
  });

  test('23. the Servers section lists the forward; Stop ends it, and detection leaves it alone', async () => {
    await page.locator('#activity [data-activity="servers"]').click();
    const row = page.locator('.sv-forward[data-server-port="7777"]');
    await expect(row).toBeVisible();
    const before = plain.live();
    await row.locator('.sv-stop').click();
    await expect(row).toHaveCount(0);
    await expect.poll(() => plain.live(), { timeout: 15_000 }).toBeLessThan(before);
  });

  test('24. the person forwards a port by number; a bad number says why', async () => {
    await page.locator('#sv-forward-port').fill('80');
    await page.locator('#sv-forward-go').click();
    await expect(page.locator('#sv-error')).toContainText('1024');
    await page.locator('#sv-forward-port').fill('7777');
    await page.locator('#sv-forward-go').click();
    await expect(page.locator('.sv-forward[data-server-port="7777"]')).toBeVisible({ timeout: 30_000 });
  });

  test('25. detection: the first listing is the baseline, a new port shows and is forwarded, an old one is only offered', async () => {
    listing = '#vibex-ports ss\nLISTEN 0 4096 127.0.0.1:7000 0.0.0.0:*\n';
    await page.locator('#sv-detect').click();
    await expect(page.locator('.sv-port[data-port="7000"]')).toBeVisible({ timeout: 30_000 });
    listing = '#vibex-ports ss\nLISTEN 0 4096 127.0.0.1:7000 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7777 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8888 0.0.0.0:*\n';
    await page.locator('#sv-detect').click();
    await expect(page.locator('.sv-port[data-port="8888"]')).toBeVisible({ timeout: 30_000 });
    // 8888 has no server program here, but ssh binds it all the same: a forward exists.
    await expect(page.locator('.sv-forward[data-server-port="8888"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sv-forward[data-server-port="7000"]')).toHaveCount(0);
    await page.screenshot({ path: shot('section') });
    await page.locator('#activity [data-activity="servers"]').click();
  });

  test('25b. the running listing: one login, a new port forwards by itself and says so, in a real stream', async () => {
    // The login that lists runs on its own while a tab of the project runs.
    await expect.poll(() => plain.writeTo('while :', ''), { timeout: 20_000 }).toBeGreaterThan(0);
    const end = '#vibex-ports-end\n';
    await expect.poll(() => plain.writeTo('while :', `LISTEN 0 4096 127.0.0.1:7100 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7000 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7777 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8888 0.0.0.0:*\n${end}`)).toBeGreaterThan(0);
    await page.waitForTimeout(4200);
    plain.writeTo('while :', `LISTEN 0 4096 127.0.0.1:7100 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7200 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7000 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:7777 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8888 0.0.0.0:*\n${end}`);
    await expect(page.locator('.vx-toast', { hasText: '7200 to 127.0.0.1' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('25c. a login nobody watches never sends an empty password', async () => {
    const quiet = (name: string) => app.evaluate((_e, n) => (globalThis as any).__vibexTest.servers.quietOptions(n), name);
    expect(await quiet('pass')).toEqual(['-o', 'NumberOfPasswordPrompts=1']);
    expect(await quiet('phrase')).toEqual(['-o', 'BatchMode=yes']);
  });

  test('26. "forward" in the profile opens the port with the Claude tab', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    plain.serverPorts[free] = Number(new URL(site.url).port);
    const list = saved();
    list.push({ name: 'with-forward', host: '127.0.0.1', user: 'pca', port: plain.port, identityFile: plain.keyFile, allowClaude: true, forward: [free], options: { ...opts(plain), IdentitiesOnly: 'yes' } });
    writeFileSync(file(), JSON.stringify(list));
    await openServerProject('with-forward', '~/forwarded');
    await expect.poll(async () => {
      try {
        return await (await fetch(`http://127.0.0.1:${free}/`)).text();
      } catch {
        return '';
      }
    }, { timeout: 30_000 }).toContain('PCA test page');
    const args = await app.evaluate(() => (globalThis as any).__vibexTest.servers.agentArgs({ name: 'x', host: 'h', user: 'u', allowClaude: true, forward: [3000] }, '~/a'));
    expect(args.join(' ')).toContain('-L 127.0.0.1:3000:127.0.0.1:3000');
    expect(args.join(' ')).toMatch(/-R 127\.0\.0\.1:\d+:127\.0\.0\.1:\d+/);
    expect(args.join(' ')).toContain('ExitOnForwardFailure=yes');
    expect(args.join(' ')).toContain('SendEnv=LC_VIBEX_MCP_TOKEN');
  });

  test('26b. a busy tunnel port on the server moves to the next; a shell tab with none free has no token', async () => {
    const project = createHash('sha256').update('ssh|plain|~/busy').digest('hex').slice(0, 16);
    const ports = serverPorts(project);
    plain.busyPorts.push(ports[0]);
    await openServerProject('plain', '~/busy');
    await expect.poll(async () => (await tunnelOf('busy')).tunnel, { timeout: 30_000 }).toBe(ports[1]);
    await expect.poll(() => plain.tunnels.includes(ports[1]), { timeout: 30_000 }).toBe(true);
    expect(plain.tunnels).not.toContain(ports[0]);
    await expect(pane('agent').locator('.tab:visible')).toHaveCount(1);
    plain.busyPorts.length = 0;
  });

  test('26c. the sheet goes away when the ssh that asked is gone', async () => {
    await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest;
      return t.servers.forget('pass');
    });
    await tile('local-work').click();
    const before = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().map((x: any) => x.id));
    await connect('pass');
    await expect(question()).toBeVisible({ timeout: 30_000 });
    const opened = await app.evaluate((_e, ids) => (globalThis as any).__vibexTest.terminals.list().find((x: any) => !ids.includes(x.id)).id, before);
    await page.evaluate((id) => (window as any).vibex.term.close(id), opened);
    await expect(question()).toBeHidden({ timeout: 10_000 });
    await app.evaluate((_e, value) => (globalThis as any).__vibexTest.servers.saveSecret('pass', 'password', value), PASSWORD);
  });

  test('27. a connection through a jump server uses its own login', async () => {
    const before = plain.logins();
    const hop = jump.logins();
    await connect('behind');
    await expect.poll(() => jump.logins(), { timeout: 30_000 }).toBe(hop + 1);
    await expect.poll(() => plain.logins(), { timeout: 30_000 }).toBe(before + 1);
  });

  test('28. closing a project ends its token and its forwards', async () => {
    const token = await app.evaluate((_e, name) => {
      const t = (globalThis as any).__vibexTest;
      return t.servers.tokenFor(t.projects.list().find((x: any) => x.name === name).id);
    }, 'ledger');
    const live = plain.live();
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    const id = await tile('ledger').getAttribute('data-project');
    await page.evaluate((p) => (window as any).vibex.projects.close(p), id);
    await expect(tile('ledger')).toHaveCount(0);
    await expect.poll(() => plain.live(), { timeout: 15_000 }).toBeLessThan(live);
    const port = await app.evaluate(() => (globalThis as any).__vibexTest.status.mcpPort);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  test('29. a restart keeps the saved password, and the first login needs no sheet', async () => {
    await app.close();
    const before = pass.logins();
    await launch();
    await connect('pass').catch(() => undefined);
    // No project is needed for this check when one is open; open the local one when the list is empty.
    await expect.poll(() => pass.logins(), { timeout: 30_000 }).toBe(before + 1);
    await expect(question()).toBeHidden();
    const raw = execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(userData, 'server-secrets.json'))},'utf8'))`], { encoding: 'utf8' });
    expect(raw).not.toContain(PASSWORD);
  });

  test('29b. a server that prints a fake prompt in its shell gets nothing, and no sheet comes (M6)', async () => {
    const before = await app.evaluate(() => (globalThis as any).__vibexTest.terminals.list().map((x: any) => x.id));
    const logins = pass.logins();
    await connect('pass');
    await expect.poll(() => pass.logins(), { timeout: 30_000 }).toBe(logins + 1);
    await expect.poll(() => app.evaluate((_e, ids) => (globalThis as any).__vibexTest.terminals.list().filter((x: any) => !ids.includes(x.id)).length, before)).toBeGreaterThan(0);
    const heard = pass.writeTo('', "\r\npca@127.0.0.1's password: ");
    expect(heard).toBeGreaterThan(0);
    pass.writeTo('', "\r\nEnter passphrase for key 'made-up':\r\n");
    await page.waitForTimeout(2000);
    await expect(question()).toBeHidden();
    const buffers = await app.evaluate(() => {
      const t = (globalThis as any).__vibexTest.terminals;
      return t.list().map((i: any) => t.buffer(i.id)).join('\n');
    });
    expect(buffers).toContain('Enter passphrase for key');
    expect(buffers).not.toContain(PASSWORD);
    expect(buffers).not.toContain(`PCA-SSH-OK ${PASSWORD}`);
  });

  test('29c. no secret is in any file the app wrote, a log or a store', async () => {
    await app.close();
    const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(folder, e.name)) : e.isFile() ? [path.join(folder, e.name)] : []));
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(5);
    const secrets = [PASSWORD, PASSPHRASE, 'made-up-wrong', 'made-up-old'].flatMap((s) => [Buffer.from(s, 'utf8'), Buffer.from(s, 'utf16le')]);
    const holding = files.filter((f) => {
      const bytes = readFileSync(f);
      return secrets.some((s) => bytes.includes(s));
    });
    expect(holding).toEqual([]);
  });
});
