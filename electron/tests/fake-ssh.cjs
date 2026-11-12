#!/usr/bin/env node
// A made-up `ssh` for the server chat tests. It runs the remote command on this computer, as sshd does with no terminal:
// `/bin/sh -c <command>` in a session of its own (setsid), its three streams piped through. It never ends the remote
// command: when this process ends, the command loses its parent and its pipes, as on a real server when the
// connection drops. With -R it says what a real ssh -v says about the remote forward.
// FAKE_SSH_HOME: the "server" home. FAKE_SSH_SHELL: the login shell (default /bin/sh). FAKE_SSH_SH: the /bin/sh to run.
// FAKE_SSH_BUSY: server ports that are taken (comma list). FAKE_SSH_RACE=1: start the command before the forward fails.
// FAKE_SSH_LOG: one JSON line per run with the arguments.
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const argv = process.argv.slice(2);
const at = argv.indexOf('--');
const options = at >= 0 ? argv.slice(0, at) : argv;
const command = at >= 0 ? argv[at + 2] : undefined;
const remote = options.includes('-R') ? options[options.indexOf('-R') + 1] : null;
const port = remote ? Number(remote.split(':')[1]) : null;
const verbose = options.includes('-v');
const option = (name) => options.flatMap((o, i) => (options[i - 1] === '-o' && o.startsWith(`${name}=`) ? [o.slice(name.length + 1)] : []))[0];
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ pid: process.pid, options, hasCommand: !!command, askpass: !!process.env.SSH_ASKPASS, token: process.env.LC_VIBEX_MCP_TOKEN ?? null })}\n`);
if (!command) {
  process.stderr.write('fake ssh: no command\n');
  process.exit(255);
}

const busy = (process.env.FAKE_SSH_BUSY ?? '').split(',').filter(Boolean).map(Number);
const failing = port !== null && busy.includes(port);
const say = (line) => process.stderr.write(`${line}\n`);
if (verbose) say('OpenSSH_9.9p1 fake');

let child = null;
function run() {
  if (verbose) say(`debug1: Sending command: ${command.slice(0, 40)}`);
  const env = { PATH: process.env.PATH, HOME: process.env.FAKE_SSH_HOME, SHELL: process.env.FAKE_SSH_SHELL || '/bin/sh', LANG: 'C', ...(option('SendEnv') && process.env.LC_VIBEX_MCP_TOKEN ? { LC_VIBEX_MCP_TOKEN: process.env.LC_VIBEX_MCP_TOKEN } : {}) };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FAKE_CLAUDE_')) env[k] = v;
  child = spawn(process.env.FAKE_SSH_SH || '/bin/sh', ['-c', command], { cwd: process.env.FAKE_SSH_HOME, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => undefined);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('close', (code) => process.exit(code ?? 255));
}

if (failing) {
  if (process.env.FAKE_SSH_RACE === '1') run();
  setTimeout(() => {
    say(`Error: remote port forwarding failed for listen port ${port}`);
    process.exit(255);
  }, 400);
} else {
  run();
  if (port !== null && verbose) setTimeout(() => say(`debug1: remote forward success for: listen 127.0.0.1:${port}, connect ${remote.split(':').slice(2).join(':')}`), 150);
}
process.on('SIGTERM', () => process.exit(255));
