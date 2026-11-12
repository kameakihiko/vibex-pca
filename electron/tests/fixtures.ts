import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync as mkdirSyncFx } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, utils } from 'ssh2';
import type { ElectronApplication, Page } from '@playwright/test';

/// Made-up logins and ports for one test ssh server. All secrets here exist only in the tests.
export interface SshServerOptions {
  /// Accepts this password for user "pca" (ssh's "password" method).
  password?: string;
  /// Asks each of these questions over keyboard-interactive; the answers must match in order.
  questions?: { prompt: string; answer: string }[];
  /// Encrypts the client key with this passphrase.
  passphrase?: string;
  /// A file name for the key, so two servers in one folder keep two keys.
  keyName?: string;
  /// A `-L` to a server port goes to this real port on 127.0.0.1, as if a program listened on the server.
  serverPorts?: Record<number, number>;
  /// Refuses `-R` on these server ports, as a server where the port is busy does.
  busyPorts?: number[];
  /// `ssh -W` goes on to any port on 127.0.0.1, so this server can be a jump host.
  jumpHost?: boolean;
  /// Runs each command in a real /bin/sh with this home, in a session of its own, its streams piped as sshd pipes them
  /// with no terminal (the server chat). The end of a login never ends the command: as on a real server, the app must.
  shell?: { home: string; env?: Record<string, string> };
}

export interface SshServer {
  port: number;
  keyFile: string;
  knownHosts: string;
  /// The environment each login sent (`SendEnv`), in order.
  envs: Record<string, string>[];
  /// The server ports each `-R` opened; each one listens on 127.0.0.1 here, as sshd does.
  tunnels: number[];
  /// The options' maps: a test can name a port after the server started.
  serverPorts: Record<number, number>;
  busyPorts: number[];
  /// How many logins passed.
  logins: () => number;
  /// How many sessions run now, to see that a forward or a stream ended.
  live: () => number;
  /// Writes to each running remote command that holds this text; returns how many.
  writeTo: (holding: string, text: string) => number;
  close: () => void;
}

/// A test ssh server on 127.0.0.1: key login for user "pca" only, plus a password or questions if asked for. Its shell
/// answers each line with "PCA-SSH-OK <line>"; "exit" ends the session.
/// `onExec` sees each remote command. A text answer goes back and the command ends; `null` makes it an interactive
/// session as a shell is, so a server project's tabs can be tested over real ssh.
export async function startSshServer(dir: string, onExec?: (command: string) => string | null, options: SshServerOptions = {}): Promise<SshServer> {
  // ssh2's own parser refuses about 1 in 250 keys it made (20 of 5000 measured, public and private part alike), so a
  // test run takes another. A host key with no second try ended a whole spec at start.
  let host = utils.generateKeyPairSync('ed25519');
  for (let i = 0; i < 20 && utils.parseKey(host.private) instanceof Error; i++) host = utils.generateKeyPairSync('ed25519');
  const makeClient = () => (options.passphrase
    ? utils.generateKeyPairSync('ed25519', { passphrase: options.passphrase, cipher: 'aes256-ctr', rounds: 2 } as any)
    : utils.generateKeyPairSync('ed25519'));
  let client = makeClient();
  const refused = () => utils.parseKey(client.public) instanceof Error || utils.parseKey(client.private, options.passphrase) instanceof Error;
  for (let i = 0; i < 20 && refused(); i++) client = makeClient();
  const keyFile = path.join(dir, options.keyName ?? 'id_test');
  writeFileSync(keyFile, client.private, { mode: 0o600 });
  if (process.platform === 'win32') {
    // Windows OpenSSH refuses a key file other accounts can read.
    execFileSync('icacls', [keyFile, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]);
  }
  const allowed = utils.parseKey(client.public);
  if (allowed instanceof Error) throw allowed;
  const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed;

  const serverPorts = options.serverPorts ?? {};
  const busyPorts = options.busyPorts ?? [];
  const methods = [...(options.passphrase || !(options.password || options.questions) ? ['publickey'] : []), ...(options.password ? ['password'] : []), ...(options.questions ? ['keyboard-interactive'] : [])] as any[];
  const envs: Record<string, string>[] = [];
  const tunnels: number[] = [];
  const listeners = new Set<net.Server>();
  let logins = 0;
  let live = 0;
  const running = new Set<{ command: string; ch: any }>();

  const server = new Server({ hostKeys: [host.private] }, (conn) => {
    const env: Record<string, string> = {};
    conn.on('authentication', (ctx) => {
      if (ctx.username !== 'pca' || !methods.includes(ctx.method)) return ctx.reject(methods);
      if (ctx.method === 'password') return ctx.password === options.password ? ctx.accept() : ctx.reject(methods);
      if (ctx.method === 'keyboard-interactive') {
        const questions = options.questions ?? [];
        ctx.prompt(questions.map((q) => ({ prompt: q.prompt, echo: false })), (answers) => {
          if (questions.every((q, i) => answers[i] === q.answer)) ctx.accept();
          else ctx.reject(methods);
        });
        return;
      }
      if (ctx.method !== 'publickey') return ctx.reject(methods);
      const pub = allowedKey.getPublicSSH();
      if (ctx.key.algo !== allowedKey.type || ctx.key.data.length !== pub.length || !timingSafeEqual(ctx.key.data, pub)) return ctx.reject();
      if (ctx.signature && ctx.blob && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
      ctx.accept();
    });
    conn.on('ready', () => {
      logins++;
      envs.push(env);
      // `-R`: this server listens on 127.0.0.1 as sshd does, and each connection goes back over the login.
      conn.on('request', (accept, reject, name, info: any) => {
        if (name !== 'tcpip-forward') return reject?.();
        if (busyPorts.includes(info.bindPort)) return reject?.();
        const listener = net.createServer((socket) => {
          conn.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (err, stream) => {
            if (err) return socket.destroy();
            socket.pipe(stream).pipe(socket);
            stream.on('error', () => socket.destroy());
            socket.on('error', () => stream.destroy());
          });
        });
        listener.on('error', () => reject?.());
        listener.listen(info.bindPort, '127.0.0.1', () => {
          listeners.add(listener);
          tunnels.push(info.bindPort);
          accept?.(info.bindPort);
        });
        conn.on('close', () => { listener.close(); listeners.delete(listener); });
      });
      // `-L` and `-W`.
      conn.on('tcpip', (accept, reject, info) => {
        const real = serverPorts[info.destPort] ?? (options.jumpHost ? info.destPort : undefined);
        if (real === undefined) return reject?.();
        const socket = net.connect(real, '127.0.0.1');
        socket.once('error', () => reject?.());
        socket.once('connect', () => {
          socket.removeAllListeners('error');
          const stream = accept();
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      conn.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept?.());
        session.on('window-change', (accept) => accept?.());
        session.on('env', (accept, _reject, info: any) => {
          env[info.key] = info.val;
          accept?.();
        });
        const interactive = (ch: any) => {
          live++;
          ch.on('close', () => { live--; });
          ch.write('pca-test$ ');
          let line = '';
          ch.on('data', (data: Buffer) => {
            for (const c of data.toString('utf8')) {
              if (c === '\r' || c === '\n') {
                const cmd = line.trim();
                line = '';
                if (cmd === 'exit') {
                  ch.write('\r\nbye\r\n');
                  ch.exit(0);
                  ch.end();
                  return;
                }
                ch.write(`\r\nPCA-SSH-OK ${cmd}\r\npca-test$ `);
              } else if (c === '\x7f') {
                line = line.slice(0, -1);
              } else {
                line += c;
                ch.write(c);
              }
            }
          });
        };
        session.on('exec', (accept, _reject, info) => {
          const ch = accept();
          if (options.shell) {
            const child = spawn('/bin/sh', ['-c', info.command], {
              cwd: options.shell.home,
              env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: options.shell.home, SHELL: '/bin/sh', LANG: 'C', ...options.shell.env, ...env },
              stdio: ['pipe', 'pipe', 'pipe'],
              detached: true,
            });
            ch.on('data', (data: Buffer) => { if (child.stdin.writable) child.stdin.write(data); });
            ch.on('end', () => child.stdin.end());
            ch.on('close', () => child.stdin.end());
            child.stdin.on('error', () => undefined);
            child.stdout.on('data', (data: Buffer) => ch.write(data));
            child.stderr.on('data', (data: Buffer) => ch.stderr.write(data));
            child.on('close', (code) => {
              try {
                ch.exit(code ?? 255);
                ch.end();
              } catch { /* the login ended */ }
            });
            return;
          }
          const answer = onExec ? onExec(info.command) : `PCA-SSH-OK ${info.command}\n`;
          if (answer === null) {
            const entry = { command: Buffer.from(/printf %s (\S+) \|/.exec(info.command)?.[1] ?? '', 'base64').toString('utf8'), ch };
            running.add(entry);
            ch.on('close', () => running.delete(entry));
            return interactive(ch);
          }
          ch.write(answer);
          ch.exit(0);
          ch.end();
        });
        session.on('shell', (accept) => {
          const ch = accept();
          const entry = { command: '', ch };
          running.add(entry);
          ch.on('close', () => running.delete(entry));
          interactive(ch);
        });
      });
    });
    conn.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    keyFile,
    knownHosts: path.join(dir, `${options.keyName ?? 'id_test'}-known_hosts`),
    envs,
    tunnels,
    serverPorts,
    busyPorts,
    logins: () => logins,
    live: () => live,
    writeTo: (holding, text) => {
      const found = [...running].filter((r) => r.command.includes(holding));
      for (const r of found) r.ch.write(text);
      return found.length;
    },
    close: () => {
      for (const l of listeners) l.close();
      server.close();
    },
  };
}

/// A small page with a form, for the browser tools.
export async function startSite(): Promise<{ url: string; close: () => void }> {
  const page = `<!doctype html><html><head><title>PCA test page</title></head><body>
<h1>PCA browser check</h1>
<label for="name">Name</label> <input id="name" type="text" placeholder="Your name">
<button id="greet" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<p id="out">Nobody greeted yet</p>
</body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

/// The long form of the path. The temp folder of a Windows account can be a short name (C:\\Users\\RUNNER~1\\...), and the app
/// names a folder by its real path.
export function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/// A POSIX sh for the scripts that run on a server: /bin/sh, or on Windows the sh of Git for Windows.
export function posixSh(): string {
  if (process.platform !== 'win32') return '/bin/sh';
  const git = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  for (let dir = path.dirname(git); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const sh = path.join(dir, 'bin', 'sh.exe');
    if (existsSync(sh)) return sh;
  }
  throw new Error(`no sh beside ${git}`);
}

/// After a failed test on Windows: what still runs, for the log. Made-up data only; a command line here holds no secret, and it is cut.
export function logWindowsProcesses(label: string): void {
  if (process.platform !== 'win32') return;
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'ssh|askpass|electron|Vibex|OpenConsole|conhost|node' } | ForEach-Object { '{0} parent {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ([string]$_.CommandLine).Substring(0, [Math]::Min(140, ([string]$_.CommandLine).Length)) }";
  try {
    console.log(`--- processes at: ${label}\n${execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true })}`);
  } catch (error) {
    console.log(`--- no process list: ${String(error).slice(0, 200)}`);
  }
}

/// The first window of an app under test. 60 s, as the ready wait: a busy computer can take longer than Playwright's 30 s.
export function firstWindow(app: ElectronApplication): Promise<Page> {
  return app.firstWindow({ timeout: 60_000 });
}

/// A long-running program for a Terminals test: POSIX sh, or on Windows cmd with ping as the timer (cmd has no sleep).
export function sleeper(): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', 'sleep 30'] };
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'ping -n 30 127.0.0.1 >nul'] };
}

/// Windows refuses to delete a folder that a process stands in. This starts such a process in `folder`.
/// `release()` ends it with its tree and waits until it has ended. Meant for win32; on POSIX it also works (a sleep).
export function holdFolder(folder: string): () => Promise<void> {
  const win = process.platform === 'win32';
  const child = win
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'ping -n 120 127.0.0.1 >nul'], { cwd: folder, windowsHide: true, stdio: 'ignore' })
    : spawn('/bin/sh', ['-c', 'sleep 120'], { cwd: folder, stdio: 'ignore' });
  const ended = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (child.exitCode === null && child.signalCode === null) {
      if (win && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* it had ended already */ }
      } else child.kill('SIGKILL');
    }
    await ended;
  };
}

/// A stand-in program called `name` in `dir`, for Windows, where a shell script cannot be the program. It is a copy (a hard link
/// if it can be) of this node as `<name>.exe`. The `NODE_OPTIONS` in `env` makes it run `script` in place of node's own work, with
/// the arguments it was given. Electron reads NODE_OPTIONS too, so the preload does nothing there. `script` is JS and sees `args`;
/// it should write with fs.writeSync, which is not lost at exit.
/// Playwright takes NODE_OPTIONS out of the environment it starts the app with, so a stand-in's goes in after the start: the app reads
/// its own environment for each program it starts.
export async function useStandIn(app: ElectronApplication, env: Record<string, string>): Promise<void> {
  await app.evaluate((_e, values) => { Object.assign(process.env, values); }, env);
}

export function standInProgram(dir: string, name: string, script: string): { file: string; env: Record<string, string> } {
  mkdirSyncFx(dir, { recursive: true });
  const file = path.join(dir, `${name}.exe`);
  if (!existsSync(file)) {
    try { linkSync(process.execPath, file); } catch { copyFileSync(process.execPath, file); }
  }
  const preload = path.join(dir, `${name}-preload.js`);
  // NODE_OPTIONS reaches every node the app starts (a dev server, say). Only a program named `<name>.exe` runs the script.
  const guard = `!process.versions.electron && require('path').basename(process.execPath).toLowerCase() === ${JSON.stringify(`${name}.exe`.toLowerCase())}`;
  writeFileSync(preload, `if (${guard}) {\n  const args = process.argv.slice(1).map((a, i) => (i === 0 ? require('path').basename(a) : a));\n  ${script}\n  process.exit(process.exitCode || 0);\n}\n`);
  // Not all in capitals: Playwright deletes that one spelling from what it starts the app with, and Windows reads any spelling.
  return { file, env: { Node_Options: `--require ${preload.replace(/\\/g, '/')}` } };
}
