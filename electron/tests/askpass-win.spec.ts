import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AskpassService, askpassEnvironment, sshCanStart, usableAnswer, windowsHelperPath, wireReply } from '../src/main/askpass';
import { programPath } from '../src/main/programs';
import { startSshServer, tempDir } from './fixtures';

// The native Windows helper (native/askpass-win): what it does as a program, and what the real Windows ssh does with it. The
// first part reads no program and runs everywhere. Made-up secrets only; the ssh server is the test one on 127.0.0.1.
const { readHelper, helperProblems } = require('../scripts/check-askpass-exe.cjs') as {
  readHelper: (bytes: Buffer) => { machine: number; subsystem: number; aslr: boolean; highEntropy: boolean; nx: boolean; relocations: boolean; signed: boolean; imports: string[] };
  helperProblems: (facts: ReturnType<typeof readHelper>) => string[];
};

test.describe('the helper, read from outside', () => {
  test('Windows ssh starts only a path it can read', () => {
    expect(sshCanStart('C:\\Users\\Ali Valiyev\\AppData\\Local\\Programs\\Vibex PCA\\resources\\vibex-askpass.exe')).toBe(true);
    // Measured with the real ssh further down: "CreateProcessW failed error:2".
    expect(sshCanStart('C:\\Users\\Али\\vibex-askpass.exe')).toBe(false);
    // build_commandline_string closes its quote at the first space after the first ".exe".
    expect(sshCanStart('C:\\tools.exe dir\\vibex-askpass.exe')).toBe(false);
    expect(sshCanStart('C:\\a"b\\vibex-askpass.exe')).toBe(false);
    expect(sshCanStart('')).toBe(false);
    // A short name has a capital .EXE, and ssh looks for the small one only.
    expect(sshCanStart('C:\\Users\\A8F2~1\\AppData\\Local\\Programs\\VIBEXP~1\\RESOUR~1\\VIBEX-~1.EXE')).toBe(true);
  });

  test('a package reads the helper from its resources, a source run from the build folder', () => {
    expect(windowsHelperPath(true, 'C:\\p\\resources', 'C:\\ignored')).toBe('C:\\p\\resources\\vibex-askpass.exe');
    expect(windowsHelperPath(false, 'C:\\ignored', 'C:\\src\\electron')).toBe('C:\\src\\electron\\native\\askpass-win\\build\\vibex-askpass.exe');
  });

  test('on Windows ssh runs the helper, never the app; the app is not told to act as one', () => {
    const helper = 'C:\\Users\\Ali Valiyev\\AppData\\Local\\Programs\\Vibex PCA\\resources\\vibex-askpass.exe';
    for (const packaged of [true, false]) {
      const env = askpassEnvironment({ platform: 'win32', packaged, execPath: 'C:\\p\\Vibex PCA.exe', wrapper: null, helper, socket: '\\\\.\\pipe\\vibex-askpass-abc', key: 'ab' });
      expect(env.SSH_ASKPASS).toBe(helper);
      expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(env.VIBEX_ASKPASS_HELPER).toBeUndefined();
      expect(env.VIBEX_ASKPASS_SOCKET).toBe('\\\\.\\pipe\\vibex-askpass-abc');
      expect(env.VIBEX_ASKPASS_KEY).toBe('ab');
    }
    expect(() => askpassEnvironment({ platform: 'win32', packaged: true, execPath: 'C:\\p\\Vibex PCA.exe', wrapper: null, socket: 's', key: 'k' })).toThrow(/helper/);
  });

  // Open sockets must not outlive the service. This does not cure the quit hang of servers test 29: that one came back with it (run 41438512187).
  test('stop ends a connection that is still open', async () => {
    const service = new AskpassService({ secrets: {} as any, questions: {} as any, profiles: () => [], notify: () => undefined }, { packaged: false, execPath: process.execPath, appPath: __dirname, helper: process.execPath });
    await service.start();
    expect(service.problem).toBeNull();
    const socket = net.connect(service.socketPath);
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // No whole line yet: the service still waits for this one. Give it time to take the connection.
    socket.write('{');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      socket.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    service.stop();
    expect(await closed).toBe(true);
    socket.destroy();
  });

  test('an answer longer than ssh reads is not used: ssh would cut it and send the rest as the password', () => {
    expect(usableAnswer('я'.repeat(511))).toBe(true);
    expect(usableAnswer('я'.repeat(512))).toBe(false);
    expect(usableAnswer('a'.repeat(1022))).toBe(true);
    expect(usableAnswer('a'.repeat(1023))).toBe(false);
  });

  test('the package holds the helper on Windows only, and the Windows build stops with no helper', () => {
    const yml = readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^win:\n(?: .*\n)*? {2}extraResources:\n {4}- from: native\/askpass-win\/build\/vibex-askpass\.exe\n {6}to: vibex-askpass\.exe\n/m);
    for (const script of ['pack-release.cjs', 'pack-proof.cjs']) expect(readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8'), script).toContain('requireAskpassHelper');
    const { requireAskpassHelper } = require('../scripts/require-askpass-helper.cjs') as { requireAskpassHelper: (c: { electronPlatformName: string; packager: { info: { projectDir: string } } }) => void };
    const missing = { packager: { info: { projectDir: tempDirGone } } };
    expect(() => requireAskpassHelper({ ...missing, electronPlatformName: 'win32' })).toThrow(/vibex-askpass\.exe/);
    expect(() => requireAskpassHelper({ ...missing, electronPlatformName: 'linux' })).not.toThrow();
  });

  test('no binary of the helper is in the repo, and its build folder is ignored', () => {
    expect(readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')).toContain('native/askpass-win/build/');
  });

  /// The smallest file with the parts the reader looks at. Each field can be set by a test.
  function pe(o: { machine?: number; subsystem?: number; dll?: number; characteristics?: number; relocSize?: number; certSize?: number; imports?: string[] } = {}): Buffer {
    const bytes = Buffer.alloc(0x800);
    bytes.write('MZ', 0, 'latin1');
    const at = 0x80;
    bytes.writeUInt32LE(at, 0x3c);
    bytes.write('PE\0\0', at, 'latin1');
    bytes.writeUInt16LE(o.machine ?? 0x8664, at + 4);
    bytes.writeUInt16LE(1, at + 6);
    const optionalSize = 240;
    bytes.writeUInt16LE(optionalSize, at + 20);
    bytes.writeUInt16LE(o.characteristics ?? 0x22, at + 22);
    const opt = at + 24;
    bytes.writeUInt16LE(0x20b, opt);
    bytes.writeUInt16LE(o.subsystem ?? 2, opt + 68);
    bytes.writeUInt16LE(o.dll ?? 0x160, opt + 70);
    bytes.writeUInt32LE(16, opt + 108);
    const rva = 0x1000;
    const raw = 0x400;
    bytes.writeUInt32LE(rva, opt + 112 + 8);
    bytes.writeUInt32LE(0x100, opt + 112 + 12);
    bytes.writeUInt32LE(o.certSize ?? 0, opt + 112 + 36);
    bytes.writeUInt32LE(o.relocSize ?? 12, opt + 112 + 44);
    const section = opt + optionalSize;
    bytes.writeUInt32LE(0x400, section + 8);
    bytes.writeUInt32LE(rva, section + 12);
    bytes.writeUInt32LE(0x400, section + 16);
    bytes.writeUInt32LE(raw, section + 20);
    const names = o.imports ?? ['KERNEL32.dll', 'SHELL32.dll'];
    let text = 0x200;
    names.forEach((name, i) => {
      bytes.writeUInt32LE(rva + text, raw + i * 20 + 12);
      bytes.write(`${name}\0`, raw + text, 'latin1');
      text += name.length + 1;
    });
    return bytes;
  }

  test('the reader of the program: what the build asks for passes, each thing that is missing is named', () => {
    const good = readHelper(pe());
    expect(good).toEqual({ machine: 0x8664, subsystem: 2, aslr: true, highEntropy: true, nx: true, relocations: true, signed: false, imports: ['kernel32.dll', 'shell32.dll'] });
    expect(helperProblems(good)).toEqual([]);
    const said = (o: Parameters<typeof pe>[0]) => helperProblems(readHelper(pe(o))).join(' ');
    expect(said({ machine: 0x14c })).toContain('x64');
    expect(said({ subsystem: 3 })).toContain('console');
    expect(said({ dll: 0x120 })).toContain('ASLR');
    expect(said({ dll: 0x60 })).toContain('DEP');
    expect(said({ dll: 0x140 })).toContain('high-entropy');
    expect(said({ relocSize: 0 })).toContain('relocation');
    expect(said({ characteristics: 0x23 })).toContain('relocation');
    expect(said({ imports: ['KERNEL32.dll', 'msvcrt.dll'] })).toContain('msvcrt.dll');
    // Unsigned, like the rest: a fact the gate states, not a fault.
    expect(helperProblems(readHelper(pe({ certSize: 16 })))).toEqual([]);
    expect(readHelper(pe({ certSize: 16 })).signed).toBe(true);
    expect(() => readHelper(Buffer.from('not a program'))).toThrow();
  });
});
const tempDirGone = path.join(__dirname, 'no-such-folder-for-this-test');

test.describe('the helper on Windows', () => {
  test.skip(process.platform !== 'win32', 'the helper is a Windows program');
  test.describe.configure({ mode: 'serial' });

  const exe = windowsHelperPath(false, '', path.join(__dirname, '..'));
  const KEY = 'ab'.repeat(32);
  let dir: string;
  let pipes = 0;
  test.beforeAll(() => { dir = tempDir('vibex-askpass-'); });
  test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const pipeName = () => `\\\\.\\pipe\\vibex-askpass-test-${process.pid}-${++pipes}`;
  /// A stand-in for the app's pipe: `reply` answers each whole line. It keeps what came.
  async function fakeApp(reply: (line: string) => string | Buffer | null) {
    const name = pipeName();
    const lines: string[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('error', () => undefined);
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        const end = text.indexOf('\n');
        if (end < 0) return;
        const line = text.slice(0, end);
        lines.push(line);
        const out = reply(line);
        if (out !== null) socket.end(out);
      });
    });
    await new Promise<void>((resolve) => server.listen(name, resolve));
    return { name, lines, close: () => server.close() };
  }

  /// The helper as ssh runs it: a prompt, a pipe for stdout. Every byte of stdout comes back.
  async function run(args: string[], env: Record<string, string>, program = exe): Promise<{ code: number | string; out: Buffer; err: Buffer }> {
    const child = spawn(program, args, { env: { SystemRoot: process.env.SystemRoot ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const code = await new Promise<number | string>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve('still waiting after 15 s'); }, 15_000);
      child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 'killed'); });
    });
    return { code, out: Buffer.concat(out), err: Buffer.concat(err) };
  }
  const empty = (r: { code: number | string; out: Buffer }) => {
    expect(r.out.length, 'stdout').toBe(0);
    expect(r.code).toBe(1);
  };

  test('the program is there, and is what the release asks for', () => {
    expect(existsSync(exe), exe).toBe(true);
    const facts = readHelper(readFileSync(exe));
    expect(helperProblems(facts)).toEqual([]);
    expect(facts.signed).toBe(false);
  });

  test('a prompt outside ASCII reaches the app as one UTF-8 string; stdout is the answer and one newline, no other byte', async () => {
    const prompt = '(pca@сервер) Ваш код "ü" \\ 日本語 😀: ';
    const app = await fakeApp(() => 'OK\nмой ответ\n');
    try {
      const r = await run([prompt], { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
      expect(r.code).toBe(0);
      expect(r.out.equals(Buffer.from('мой ответ\n', 'utf8')), r.out.toString('hex')).toBe(true);
      expect(r.err.length).toBe(0);
      expect(JSON.parse(app.lines[0])).toEqual({ key: KEY, hint: '', prompt });
      expect(app.lines).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  test('a control character in a prompt stays inside its JSON string', async () => {
    const prompt = 'line one\nline two\ttab\u0001 \u007f end';
    const app = await fakeApp(() => 'OK\nyes\n');
    try {
      const r = await run([prompt], { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY, SSH_ASKPASS_PROMPT: 'confirm' });
      expect(r.code).toBe(0);
      expect(JSON.parse(app.lines[0])).toEqual({ key: KEY, hint: 'confirm', prompt });
    } finally {
      app.close();
    }
  });

  test('no pipe: empty stdout and a failure', async () => {
    empty(await run(['a prompt'], { VIBEX_ASKPASS_SOCKET: pipeName(), VIBEX_ASKPASS_KEY: KEY }));
  });

  test('a bad ticket or pipe name is never sent anywhere', async () => {
    const app = await fakeApp(() => 'OK\nmust-not-arrive\n');
    try {
      const bad: Record<string, string>[] = [
        {},
        { VIBEX_ASKPASS_SOCKET: app.name },
        { VIBEX_ASKPASS_KEY: KEY },
        { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: '' },
        { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: 'not-hex' },
        { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: 'a'.repeat(129) },
        { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: `${KEY}","hint":"x` },
        // A pipe of another computer would take this login's NTLM hash along.
        { VIBEX_ASKPASS_SOCKET: '\\\\made-up-host.invalid\\pipe\\x', VIBEX_ASKPASS_KEY: KEY },
        { VIBEX_ASKPASS_SOCKET: `${app.name}\\..\\x`, VIBEX_ASKPASS_KEY: KEY },
        { VIBEX_ASKPASS_SOCKET: path.join(dir, 'a-file'), VIBEX_ASKPASS_KEY: KEY },
      ];
      for (const env of bad) empty(await run(['a prompt'], env));
      expect(app.lines).toEqual([]);
    } finally {
      app.close();
    }
  });

  test('a ticket the app does not know gets nothing; the right one gets the answer (the real service)', async () => {
    const profile = { name: 'alpha', host: 'alpha.example', user: 'alpha', authentication: 'password' as const };
    const service = new AskpassService({
      secrets: { get: () => 'made-up-saved', available: () => true } as any,
      questions: { ask: async () => ({ refused: 'no person in this test' }) } as any,
      profiles: () => [profile],
      notify: () => undefined,
    }, { packaged: false, execPath: process.execPath, appPath: '', helper: exe });
    await service.start();
    try {
      expect(service.problem).toBeNull();
      const { env } = service.ticket(profile);
      expect(env.SSH_ASKPASS).toBe(exe);
      const socket = { VIBEX_ASKPASS_SOCKET: env.VIBEX_ASKPASS_SOCKET };
      empty(await run(["alpha@alpha.example's password:"], { ...socket, VIBEX_ASKPASS_KEY: 'cd'.repeat(32) }));
      // A prompt that names another login.
      empty(await run(["other@other.example's password:"], env));
      const good = await run(["alpha@alpha.example's password:"], env);
      expect(good.code).toBe(0);
      expect(good.out.toString('utf8')).toBe('made-up-saved\n');
      // The saved secret goes once per ssh; the next ask needs a person, and here there is none.
      empty(await run(["alpha@alpha.example's password:"], env));
    } finally {
      service.stop();
    }
  });

  test('a refusal or a reply out of form: empty stdout and a failure', async () => {
    for (const reply of ['NO\n', 'OK\n', 'OK\n\n', 'OK\nno-end', 'OK\na\r\n', 'OK\na\nb\n', 'OK\na\0b\n', 'ok\na\n', 'OK', '', `OK\n${'a'.repeat(1023)}\n`, `OK\n${'a'.repeat(70_000)}\n`]) {
      const app = await fakeApp(() => reply);
      try {
        const r = await run(['a prompt'], { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
        expect(r.out.length, JSON.stringify(reply.slice(0, 20))).toBe(0);
        expect(r.code, JSON.stringify(reply.slice(0, 20))).toBe(1);
      } finally {
        app.close();
      }
    }
  });

  test('the longest answer ssh reads goes through whole', async () => {
    const answer = 'a'.repeat(1022);
    const app = await fakeApp(() => wireReply(answer));
    try {
      const r = await run(['a prompt'], { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
      expect(r.code).toBe(0);
      expect(r.out.toString('latin1')).toBe(`${answer}\n`);
    } finally {
      app.close();
    }
  });

  test('a prompt too long, none, or split in two is not sent; a notice with no question ends quietly', async () => {
    const app = await fakeApp(() => 'OK\nmust-not-arrive\n');
    try {
      const env = { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY };
      empty(await run(['p'.repeat(4097)], env));
      empty(await run([], env));
      empty(await run([''], env));
      empty(await run(['one', 'two'], env));
      const notice = await run(['Confirm user presence'], { ...env, SSH_ASKPASS_PROMPT: 'none' });
      expect(notice.code).toBe(0);
      expect(notice.out.length).toBe(0);
      expect(app.lines).toEqual([]);
    } finally {
      app.close();
    }
  });

  test('the app that goes away while a question is open: empty stdout and a failure', async () => {
    const name = pipeName();
    const server = net.createServer((socket) => { socket.on('error', () => undefined); socket.on('data', () => socket.destroy()); });
    await new Promise<void>((resolve) => server.listen(name, resolve));
    try {
      empty(await run(['a prompt'], { VIBEX_ASKPASS_SOCKET: name, VIBEX_ASKPASS_KEY: KEY }));
    } finally {
      server.close();
    }
  });

  // ---------- the real ssh.exe ----------

  const real = () => programPath('ssh');
  const sshArgs = (port: number, known: string, method: 'password' | 'keyboard-interactive') => [
    '-p', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`, '-o', 'PubkeyAuthentication=no', '-o', `PreferredAuthentications=${method}`,
    '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=15', 'pca@127.0.0.1', 'echo from-the-server',
  ];
  /// Not spawnSync: the test ssh server and the stand-in pipe live in this process, and need its event loop.
  function ssh(args: string[], env: Record<string, string>): Promise<{ code: number | string; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(real(), args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 'killed', out, err }); });
    });
  }

  test('the ssh of these tests is the one of Windows, with SSH_ASKPASS_REQUIRE', () => {
    const r = spawnSync(real(), ['-V'], { encoding: 'utf8', windowsHide: true });
    const version = `${r.stdout}${r.stderr}`;
    console.log(`ssh: ${real()} ${version.trim()}`);
    expect(version).toMatch(/OpenSSH_for_Windows_/);
  });

  test('an answer with spaces, a quote and letters outside ASCII reaches ssh byte for byte; no log holds it', async () => {
    const password = ' made-up "кавычка" ü\\ 日本 1 ';
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_bytes', password });
    const prompts: string[] = [];
    const app = await fakeApp((line) => { prompts.push(JSON.parse(line).prompt); return wireReply(password); });
    try {
      const r = await ssh(['-vvv', ...sshArgs(server.port, server.knownHosts, 'password')], { SSH_ASKPASS: exe, SSH_ASKPASS_REQUIRE: 'force', VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
      expect(prompts).toEqual(["pca@127.0.0.1's password: "]);
      expect(server.logins(), r.err.split('\n').slice(-12).join('\n')).toBe(1);
      expect(r.code).toBe(0);
      expect(r.out).toContain('from-the-server');
      expect(`${r.out}${r.err}`).not.toContain(password);
      expect(`${r.out}${r.err}`).not.toContain('кавычка');
    } finally {
      app.close();
      server.close();
    }
  });

  test('a server question outside ASCII reaches the app as ssh shows it, and its answer reaches the server', async () => {
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_question', questions: [{ prompt: 'Ваш код (ü): ', answer: 'Жавоб 42' }] });
    const prompts: string[] = [];
    const app = await fakeApp((line) => { prompts.push(JSON.parse(line).prompt); return wireReply('Жавоб 42'); });
    try {
      const r = await ssh(sshArgs(server.port, server.knownHosts, 'keyboard-interactive'), { SSH_ASKPASS: exe, SSH_ASKPASS_REQUIRE: 'force', VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
      expect(server.logins(), r.err).toBe(1);
      expect(prompts).toEqual(['(pca@127.0.0.1) Ваш код (ü): ']);
    } finally {
      app.close();
      server.close();
    }
  });

  test('a refused answer: ssh gets no password, and the server sees no login', async () => {
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_refused', password: 'made-up-refused' });
    const app = await fakeApp(() => wireReply(null));
    try {
      const r = await ssh(sshArgs(server.port, server.knownHosts, 'password'), { SSH_ASKPASS: exe, SSH_ASKPASS_REQUIRE: 'force', VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY });
      expect(server.logins()).toBe(0);
      expect(r.code).not.toBe(0);
      expect(app.lines).toHaveLength(1);
    } finally {
      app.close();
      server.close();
    }
  });

  // The listing of folders hung once on this ssh (server-projects test 4, run 41422051308). The stdin a Node child gets stays open.
  test('a listing with -n ends each time; the same with stdin left open is measured', async () => {
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_list' });
    const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${server.knownHosts}`, '-o', 'IdentitiesOnly=yes', '-i', server.keyFile, '-p', String(server.port), 'pca@127.0.0.1', 'list'];
    const once = (first: string[], stdin: 'pipe' | 'ignore') => new Promise<boolean>((resolve) => {
      const child = spawn(real(), [...first, ...args], { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 8_000);
      child.on('close', () => { clearTimeout(timer); resolve(true); });
      child.stdout!.on('data', () => undefined);
      child.stderr!.on('data', () => undefined);
    });
    try {
      const count = 20;
      let open = 0;
      for (let i = 0; i < count; i++) if (await once([], 'pipe')) open++;
      console.log(`stdin left open: ${open} of ${count} ended`);
      let closed = 0;
      for (let i = 0; i < count; i++) if (await once(['-n'], 'pipe')) closed++;
      console.log(`with -n: ${closed} of ${count} ended`);
      expect(closed).toBe(count);
    } finally {
      server.close();
    }
  });

  test('a folder with spaces and Cyrillic: the app gives ssh a path it can start, or says that the person types in the tab', async () => {
    const folder = path.join(dir, 'Папка с пробелом');
    mkdirSync(folder);
    const copy = path.join(folder, 'vibex-askpass.exe');
    copyFileSync(exe, copy);
    const password = 'made-up-from-a-cyrillic-folder';
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_folder', password });
    const app = await fakeApp(() => wireReply(password));
    const base = { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY, SSH_ASKPASS_REQUIRE: 'force' };
    const profile = { name: 'folder', host: '127.0.0.1', user: 'pca', port: server.port, authentication: 'password' as const };
    const service = new AskpassService({ secrets: {} as any, questions: {} as any, profiles: () => [profile], notify: () => undefined }, { packaged: false, execPath: process.execPath, appPath: '', helper: copy });
    try {
      // The long form, as a measure: what this ssh does with it decides nothing in the app, which never gives it such a path.
      const long = await ssh(sshArgs(server.port, server.knownHosts, 'password'), { ...base, SSH_ASKPASS: copy });
      console.log(`long form with Cyrillic: exit ${long.code}, logins ${server.logins()}, stderr: ${long.err.trim().split('\n').slice(-3).join(' | ')}`);
      const before = server.logins();

      await service.start();
      const given = service.ticket(profile).env.SSH_ASKPASS;
      if (given === undefined) {
        // This disk keeps no short names.
        console.log(`no short name here: ${service.problem}`);
        expect(service.problem).toMatch(/Type the password in the tab/);
      } else {
        console.log(`short form: ${given}`);
        expect(sshCanStart(given)).toBe(true);
        const r = await ssh(sshArgs(server.port, server.knownHosts, 'password'), { ...base, SSH_ASKPASS: given });
        expect(server.logins(), r.err).toBe(before + 1);
      }
    } finally {
      service.stop();
      app.close();
      server.close();
    }
  });

  test('a path with spaces, as an install has it: ssh starts it', async () => {
    const folder = path.join(dir, 'Vibex PCA', 'resources');
    mkdirSync(folder, { recursive: true });
    const copy = path.join(folder, 'vibex-askpass.exe');
    copyFileSync(exe, copy);
    const password = 'made-up-from-a-spaced-folder';
    const server = await startSshServer(dir, () => 'from-the-server\n', { keyName: 'id_spaced', password });
    const app = await fakeApp(() => wireReply(password));
    try {
      const r = await ssh(sshArgs(server.port, server.knownHosts, 'password'), { VIBEX_ASKPASS_SOCKET: app.name, VIBEX_ASKPASS_KEY: KEY, SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: copy });
      expect(server.logins(), r.err).toBe(1);
    } finally {
      app.close();
      server.close();
    }
  });

  test('with the helper gone: the Servers section says so, and ssh asks in the tab', async () => {
    const service = new AskpassService({ secrets: {} as any, questions: {} as any, profiles: () => [], notify: () => undefined }, { packaged: false, execPath: process.execPath, appPath: '', helper: path.join(dir, 'no-such-helper.exe') });
    await service.start();
    expect(service.problem).toMatch(/helper/);
    expect(service.problem).toMatch(/Type the password in the tab/);
    expect(service.ticket({ name: 'x', host: 'h', user: 'u' }).env).toEqual({});
    service.stop();
  });
});
