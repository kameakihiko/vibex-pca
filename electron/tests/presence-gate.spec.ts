import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AskpassService } from '../src/main/askpass';
import type { Answer, QuestionForm } from '../src/main/serverQuestions';
import type { ServerProfile } from '../src/main/servers';
import { fakePresence, noPresence, quietLoginOptions, hwndText, presenceAuthenticator, presenceReason, SavedSecretGate, windowsPresence, type Authenticator, type Presence } from '../src/main/savedSecretGate';
import { EventEmitter } from 'node:events';
import { SecretStore } from '../src/main/serverSecrets';
import { PortWatcher, ServerForwards } from '../src/main/serverPorts';
import { listFoldersArgs, loginArgs, runLaunch, serverLaunch, tunnelLaunch } from '../src/main/servers';
import { tempDir } from './fixtures';

// Swift PR #51 carried (row 1): no saved server secret is read until the person at the PC confirms. One prompt per
// request, never shared; no answer by the limit is a refusal; a refusal ends that ssh; a PC that cannot confirm makes the
// person type the secret. No Electron here: a real askpass service on a real socket, made-up secrets, a fake authenticator.

const isWindows = process.platform === 'win32';
const profile = (name: string): ServerProfile => ({ name, host: `${name}.example`, user: name, authentication: 'password' } as ServerProfile);
const passwordPrompt = (name: string) => `${name}@${name}.example's password:`;

/// An authenticator a test answers by hand: each prompt waits until the test settles it.
function handAuthenticator() {
  const prompts: { reason: string; signal: AbortSignal; settle: (a: Presence) => void }[] = [];
  const authenticator: Authenticator = {
    confirm: (reason, signal) => new Promise<Presence>((resolve) => prompts.push({ reason, signal, settle: resolve })),
  };
  return { authenticator, prompts };
}

const fixed = (answer: Presence | 'throw'): Authenticator => ({
  confirm: async () => {
    if (answer === 'throw') throw new Error('made-up failure');
    return answer;
  },
});

async function service(authenticator: Authenticator, profiles: ServerProfile[], o: { limitMs?: number; typed?: (form: QuestionForm, beforeShow?: () => Answer | null) => Answer } = {}) {
  const notes: string[] = [];
  const forms: QuestionForm[] = [];
  let reads = 0;
  const askpass = new AskpassService({
    secrets: { get: (p: ServerProfile, kind: string) => { reads++; return `${kind}-of-${p.name}`; }, has: () => true, available: () => true, set: () => undefined } as any,
    questions: {
      ask: async (form: QuestionForm, options: { beforeShow?: () => Answer | null } = {}) => {
        forms.push(form);
        return o.typed ? o.typed(form, options.beforeShow) : { refused: 'no person in this test' };
      },
    } as any,
    profiles: () => profiles,
    notify: (title, message) => notes.push(`${title}. ${message}`),
    gate: new SavedSecretGate(authenticator, o.limitMs),
  }, { helper: process.execPath, packaged: true, execPath: process.execPath, appPath: '' });
  await askpass.start();
  expect(askpass.problem).toBeNull();
  return { askpass, notes, forms, reads: () => reads };
}

/// One request as the helper sends it: a framed line, and the socket stays open both ways.
function ask(env: Record<string, string>, prompt: string, waitMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(env.VIBEX_ASKPASS_SOCKET);
    let out = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(`no reply in time; had ${JSON.stringify(out)}`); }, waitMs);
    socket.on('error', reject);
    socket.on('data', (d) => { out += d; });
    socket.on('close', () => { clearTimeout(timer); resolve(out); });
    socket.write(`${JSON.stringify({ key: env.VIBEX_ASKPASS_KEY, hint: '', prompt })}\n`);
  });
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test.describe('presence gate before a saved secret', () => {
  test.skip(isWindows, 'the socket service runs here on a Unix socket; Windows runs the same code over a pipe in askpass-win');

  test('(a) a refusal ends that ssh with "not confirmed", and the secret is never read', async () => {
    const a = profile('alpha');
    const s = await service(fixed('no'), [a]);
    try {
      const { env } = s.askpass.ticket(a);
      expect(await ask(env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(s.notes).toEqual(['alpha: not confirmed. The saved password was not used.']);
      // ssh asks again after a failed answer: that ssh is over, with no sheet.
      expect(await ask(env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(s.forms).toEqual([]);
      expect(s.reads()).toBe(0);
    } finally {
      s.askpass.stop();
    }
  });

  test('(a) an authenticator that throws counts as a refusal', async () => {
    const a = profile('alpha');
    const s = await service(fixed('throw'), [a]);
    try {
      expect(await ask(s.askpass.ticket(a).env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(s.notes.join('\n')).toMatch(/alpha: not confirmed/);
      expect(s.reads()).toBe(0);
    } finally {
      s.askpass.stop();
    }
  });

  test('(b) two requests at once get two prompts, each with its own signal', async () => {
    const a = profile('alpha');
    const b = profile('beta');
    const hand = handAuthenticator();
    const s = await service(hand.authenticator, [a, b]);
    try {
      const first = ask(s.askpass.ticket(a).env, passwordPrompt('alpha'));
      const second = ask(s.askpass.ticket(b).env, passwordPrompt('beta'));
      await until(() => hand.prompts.length === 2);
      expect(hand.prompts[0].signal).not.toBe(hand.prompts[1].signal);
      expect(hand.prompts.map((p) => p.reason).sort().join('\n')).toMatch(/alpha[\s\S]*beta/);
      for (const p of hand.prompts) p.settle('ok');
      expect(await first).toBe('OK\npassword-of-alpha\n');
      expect(await second).toBe('OK\npassword-of-beta\n');
      expect(s.reads()).toBe(2);
    } finally {
      s.askpass.stop();
    }
  });

  test('(c) a yes for request A does not release request B', async () => {
    const a = profile('alpha');
    const b = profile('beta');
    const hand = handAuthenticator();
    const s = await service(hand.authenticator, [a, b]);
    try {
      const first = ask(s.askpass.ticket(a).env, passwordPrompt('alpha'));
      const second = ask(s.askpass.ticket(b).env, passwordPrompt('beta'));
      await until(() => hand.prompts.length === 2);
      const promptOf = (name: string) => hand.prompts.find((p) => p.reason.includes(name))!;
      promptOf('alpha').settle('ok');
      expect(await first).toBe('OK\npassword-of-alpha\n');
      let secondDone = false;
      void second.then(() => { secondDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone, 'B was answered on the strength of A').toBe(false);
      expect(s.reads()).toBe(1);
      promptOf('beta').settle('no');
      expect(await second).toBe('NO\n');
      expect(s.reads()).toBe(1);
      // Each request had its own prompt; none was shared or added.
      expect(hand.prompts.length).toBe(2);
    } finally {
      s.askpass.stop();
    }
  });

  test('(d) no answer by the limit is a refusal, and the prompt is aborted', async () => {
    const a = profile('alpha');
    const hand = handAuthenticator();
    const s = await service(hand.authenticator, [a], { limitMs: 300 });
    try {
      expect(await ask(s.askpass.ticket(a).env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(hand.prompts.length).toBe(1);
      expect(hand.prompts[0].signal.aborted).toBe(true);
      expect(s.notes).toEqual(['alpha: not confirmed. The saved password was not used.']);
      // A late yes changes nothing.
      hand.prompts[0].settle('ok');
      expect(s.reads()).toBe(0);
    } finally {
      s.askpass.stop();
    }
  });

  test('(d) the gate alone: 40 s by default, an injected clock, the end of the ssh aborts the prompt', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const clock = { set: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, clear: () => undefined };
    const hand = handAuthenticator();
    const gate = new SavedSecretGate(hand.authenticator, undefined, clock);
    const late = gate.confirm('use the saved password of alpha');
    expect(timers[0].ms).toBe(40_000);
    timers[0].fn();
    expect(await late).toBe('no');
    expect(hand.prompts[0].signal.aborted).toBe(true);

    const ended = new AbortController();
    const gone = gate.confirm('use the saved password of beta', ended.signal);
    ended.abort();
    expect(await gone).toBe('no');
    expect(hand.prompts[1].signal.aborted).toBe(true);
    // Any answer that is not exactly 'ok' never opens.
    expect(await new SavedSecretGate({ confirm: async () => 'OK' as Presence }).confirm('x')).toBe('no');
    expect(await new SavedSecretGate({ confirm: async () => 'unavailable' }).confirm('x')).toBe('unavailable');
  });

  test('(e) a PC that cannot confirm makes the person type it; the saved secret is not read, not even to fill the sheet', async () => {
    const a = profile('alpha');
    let filled: Answer | null = null;
    const s = await service(fixed('unavailable'), [a], {
      typed: (_form, beforeShow) => {
        filled = beforeShow?.() ?? null;
        return { typed: 'typed-by-person', save: false };
      },
    });
    try {
      expect(await ask(s.askpass.ticket(a).env, passwordPrompt('alpha'))).toBe('OK\ntyped-by-person\n');
      expect(s.forms.length).toBe(1);
      expect(s.forms[0]).toMatchObject({ kind: 'typed', note: 'This PC cannot confirm it is you, so type it.' });
      expect(filled).toBeNull();
      expect(s.reads()).toBe(0);
    } finally {
      s.askpass.stop();
    }
  });

  test('(f) a background (silent) ticket never reads without a yes, and never shows a sheet', async () => {
    const a = profile('alpha');
    for (const answer of ['no', 'unavailable', 'throw'] as const) {
      const s = await service(fixed(answer), [a]);
      try {
        expect(await ask(s.askpass.ticket(a, undefined, true).env, passwordPrompt('alpha')), answer).toBe('NO\n');
        expect(s.forms, answer).toEqual([]);
        expect(s.reads(), answer).toBe(0);
      } finally {
        s.askpass.stop();
      }
    }
    const hand = handAuthenticator();
    const s = await service(hand.authenticator, [a], { limitMs: 300 });
    try {
      expect(await ask(s.askpass.ticket(a, undefined, true).env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(hand.prompts[0].signal.aborted).toBe(true);
      expect(s.reads()).toBe(0);
    } finally {
      s.askpass.stop();
    }
    const ok = await service(fixed('ok'), [a]);
    try {
      expect(await ask(ok.askpass.ticket(a, undefined, true).env, passwordPrompt('alpha'))).toBe('OK\npassword-of-alpha\n');
      expect(ok.reads()).toBe(1);
    } finally {
      ok.askpass.stop();
    }
  });

  test('(N1) nothing saved: no prompt at all, the sheet says so, and nothing fills it', async () => {
    const a = profile('alpha');
    const hand = handAuthenticator();
    let reads = 0;
    let saved: string | null = null;
    const fills: (Answer | null)[] = [];
    const forms: QuestionForm[] = [];
    const askpass = new AskpassService({
      secrets: { get: () => { reads++; return saved; }, has: () => saved !== null, available: () => true, set: () => undefined } as any,
      questions: { ask: async (f: QuestionForm, o: { beforeShow?: () => Answer | null } = {}) => { forms.push(f); saved = 'saved-meanwhile'; fills.push(o.beforeShow?.() ?? null); return { typed: 'typed-by-person', save: false }; } } as any,
      profiles: () => [a],
      notify: () => undefined,
      gate: new SavedSecretGate(hand.authenticator),
    }, { helper: process.execPath, packaged: true, execPath: process.execPath, appPath: '' });
    await askpass.start();
    try {
      expect(await ask(askpass.ticket(a).env, passwordPrompt('alpha'))).toBe('OK\ntyped-by-person\n');
      expect(hand.prompts.length).toBe(0);
      expect(forms[0]).toMatchObject({ kind: 'typed', note: 'No password is saved for alpha.' });
      // A secret saved meanwhile by another tab is not read without a prompt.
      expect(fills).toEqual([null]);
      saved = null;
      expect(await ask(askpass.ticket(a, undefined, true).env, passwordPrompt('alpha'))).toBe('NO\n');
      expect(hand.prompts.length).toBe(0);
      expect(reads).toBe(0);
    } finally {
      askpass.stop();
    }
  });
});

test.describe('the authenticator a build may use', () => {
  test('(g) a release build never takes the fake; Linux and others cannot confirm', async () => {
    const windows = fixed('ok');
    const signal = new AbortController().signal;
    for (const fake of ['ok', 'no', 'hang', 'anything']) {
      const linux = presenceAuthenticator({ kind: 'release', fake, platform: 'linux', windows: () => windows });
      expect(await linux.confirm('x', signal), fake).toBe('unavailable');
      expect(presenceAuthenticator({ kind: 'release', fake, platform: 'win32', windows: () => windows }), fake).toBe(windows);
    }
    expect(await presenceAuthenticator({ kind: 'release', fake: undefined, platform: 'darwin', windows: () => windows }).confirm('x', signal)).toBe('unavailable');
    expect(await presenceAuthenticator({ kind: 'dev', fake: 'ok', platform: 'linux', windows: () => windows }).confirm('x', signal)).toBe('ok');
    expect(await presenceAuthenticator({ kind: 'proof', fake: 'no', platform: 'win32', windows: () => windows }).confirm('x', signal)).toBe('no');
    expect(await presenceAuthenticator({ kind: 'dev', fake: 'something', platform: 'linux', windows: () => windows }).confirm('x', signal)).toBe('unavailable');
    const hang = new AbortController();
    const hung = presenceAuthenticator({ kind: 'dev', fake: 'hang', platform: 'linux', windows: () => windows }).confirm('x', hang.signal);
    hang.abort();
    expect(await hung).toBe('no');
  });

  test('(g) main.ts reads the fake only through a test switch, and the release bundle holds none of it', () => {
    const main = readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
    expect(main).toMatch(/testEnv\('VIBEX_TEST_PRESENCE'\)/);
    expect(main).not.toMatch(/process\.env\.VIBEX_TEST_PRESENCE|process\.env\[['"]VIBEX_TEST_PRESENCE/);
    const hub = readFileSync(path.join(__dirname, '..', 'src', 'main', 'serverHub.ts'), 'utf8');
    expect(hub).toMatch(/this\.gate = new SavedSecretGate\(d\.presence\);[\s\S]*gate: this\.gate,/);
    const out = tempDir('vibex-presence-release-');
    try {
      execFileSync(process.execPath, ['build.mjs', '--release', `--out=${out}`], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
      const code = readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(out, f), 'utf8')).join('\n');
      expect(code).toContain('vibex-build-kind: release');
      expect(code).not.toContain('VIBEX_TEST_PRESENCE');
      expect(code).toContain('vibex-presence.exe');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('the Windows authenticator: the window and the reason as arguments, only an exact answer counts, killed on abort', async () => {
    test.skip(isWindows, 'the stand-in helper is a shell script');
    const dir = tempDir('vibex-presence-helper-');
    try {
      const helper = (body: string) => {
        const file = path.join(dir, `h-${Math.random().toString(16).slice(2)}`);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
        return file;
      };
      const signal = () => new AbortController().signal;
      const args = path.join(dir, 'args');
      const echoArgs = helper(`printf '%s\\n' "$@" > '${args}'; echo ok`);
      expect(await windowsPresence({ helper: echoArgs, window: () => '4242' }).confirm('use the saved password of alpha', signal())).toBe('ok');
      expect(readFileSync(args, 'utf8')).toBe('4242\nuse the saved password of alpha\n');
      expect(await windowsPresence({ helper: helper('echo no'), window: () => '1' }).confirm('x', signal())).toBe('no');
      expect(await windowsPresence({ helper: helper('echo unavailable'), window: () => '1' }).confirm('x', signal())).toBe('unavailable');
      expect(await windowsPresence({ helper: helper('echo okay'), window: () => '1' }).confirm('x', signal())).toBe('unavailable');
      expect(await windowsPresence({ helper: helper('echo ok; exit 3'), window: () => '1' }).confirm('x', signal())).toBe('unavailable');
      expect(await windowsPresence({ helper: path.join(dir, 'missing.exe'), window: () => '1' }).confirm('x', signal())).toBe('unavailable');
      expect(await windowsPresence({ helper: echoArgs, window: () => null }).confirm('x', signal())).toBe('unavailable');
      const marker = path.join(dir, 'still-running');
      const slow = helper(`sleep 3; touch '${marker}'; echo ok`);
      const abort = new AbortController();
      const pending = windowsPresence({ helper: slow, window: () => '1' }).confirm('x', abort.signal);
      setTimeout(() => abort.abort(), 200);
      expect(await pending).toBe('no');
      await new Promise((r) => setTimeout(r, 3500));
      expect(readdirSync(dir)).not.toContain('still-running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the window handle and the reason in plain, bounded text', () => {
    const eight = Buffer.alloc(8);
    eight.writeBigUInt64LE(0x1234n);
    expect(hwndText(eight)).toBe(String(0x1234));
    const four = Buffer.alloc(4);
    four.writeUInt32LE(77);
    expect(hwndText(four)).toBe('77');
    expect(hwndText(Buffer.alloc(8))).toBeNull();
    expect(hwndText(Buffer.alloc(3))).toBeNull();
    const reason = presenceReason({ name: 'al‮pha\nx'.padEnd(80, 'y'), user: 'u', host: 'h.example' } as ServerProfile, 'passphrase');
    expect(reason).toMatch(/^Vibex PCA wants to use the saved key passphrase of /);
    expect(reason).not.toMatch(/[\n‮]/);
    expect(reason.length).toBeLessThan(200);
  });
});

test.describe('the Windows Hello helper, from its source (no compiler on this computer)', () => {
  const root = path.join(__dirname, '..');
  const source = () => readFileSync(path.join(root, 'native', 'presence-win', 'vibex-presence.c'), 'utf8');

  /// A WinRT parameterised IID: SHA-1 of the WinRT namespace GUID and the type's signature, as a version 5 UUID.
  const winrtIid = (signature: string) => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const b = createHash('sha1').update(Buffer.concat([Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex'), Buffer.from(signature)])).digest().subarray(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = b.toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  };
  /// The IID a C initialiser holds, in the usual text form.
  const iidOf = (name: string) => {
    const m = new RegExp(`static const IID ${name} = \\{(0x[0-9a-f]+), (0x[0-9a-f]+), (0x[0-9a-f]+), \\{([^}]*)\\}\\};`).exec(source());
    expect(m, name).not.toBeNull();
    const hex = (v: string, n: number) => Number(v).toString(16).padStart(n, '0');
    const tail = m![4].split(',').map((v) => hex(v.trim(), 2)).join('');
    return `${hex(m![1], 8)}-${hex(m![2], 4)}-${hex(m![3], 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
  };

  test('the IIDs: the derivation is right, and the result operation IID is the one it gives', () => {
    const asyncOperation = '{9fc2b0bb-e446-44e2-aa61-9cab8f636af2}';
    // A well-known one checks the derivation itself: IAsyncOperation<String>.
    expect(winrtIid(`pinterface(${asyncOperation};string)`)).toBe('3e1fe603-f897-5263-b328-0806426b8a79');
    expect(iidOf('IID_op_result')).toBe(winrtIid(`pinterface(${asyncOperation};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))`));
    expect(iidOf('IID_statics')).toBe('af4f3f91-564c-4ddc-b8b5-973447627c65');
    expect(iidOf('IID_interop')).toBe('39e050c3-4e74-441a-8dc0-b81104df949c');
    expect(iidOf('IID_async_info')).toBe('00000036-0000-0000-c000-000000000046');
  });

  test('it prints only ok, no or unavailable, imports no DLL by link but kernel32 and shell32, and reads no secret', () => {
    const text = source();
    const said = [...text.matchAll(/say\(([^;]*)\);/g)].map((m) => m[1]).join(' ');
    expect([...new Set([...said.matchAll(/"([^"]*)"/g)].map((m) => m[1]))].sort()).toEqual(['no\\n', 'ok\\n', 'unavailable\\n']);
    expect(text).toMatch(/LoadLibraryExW\(L"combase\.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32\)/);
    expect(text).not.toMatch(/CredUI|LogonUser|ReadConsole|GetEnvironmentVariable/);
    // The one read: its own stdin, to learn that the app closed it (N4).
    expect([...text.matchAll(/ReadFile\(([^,]*),/g)].map((m) => m[1])).toEqual(['input']);
    expect(text).toMatch(/result == VERIFIED\) word = "ok"/);
    expect(text).toMatch(/availability != AVAILABLE\) goto done/);
  });

  test('it is built and shipped the same way as the askpass helper', () => {
    const flags = (file: string) => readFileSync(path.join(root, file), 'utf8').split('\n').filter((l) => /^\s*("\$CC"|-ffreestanding|-Wl,)/.test(l)).map((l) => l.replace(/ap_entry|vp_entry/, 'ENTRY').replace(/vibex-askpass|vibex-presence/g, 'NAME').replace(/askpass-win|presence-win/g, 'DIR').trim());
    expect(flags('native/presence-win/build.sh')).toEqual(flags('native/askpass-win/build.sh'));
    expect(readFileSync(path.join(root, 'native/presence-win/build.sh'), 'utf8')).toMatch(/node scripts\/check-presence-exe\.cjs "\$out\/vibex-presence\.exe"/);
    expect(readFileSync(path.join(root, 'scripts/fence-windows-installer.sh'), 'utf8')).toMatch(/CC=x86_64-w64-mingw32-gcc-win32 bash native\/presence-win\/build\.sh\n/);
    expect(readFileSync(path.join(root, 'scripts/update-proof-windows.sh'), 'utf8')).toMatch(/\nbash native\/presence-win\/build\.sh\n/);
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['dist:win']).toMatch(/bash native\/presence-win\/build\.sh && electron-builder/);
    expect(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')).toMatch(/ {4}- from: native\/presence-win\/build\/vibex-presence\.exe\n {6}to: vibex-presence\.exe\n/);
    const workflow = readFileSync(path.join(root, '..', '.github', 'workflows', 'vibex-pca.yml'), 'utf8');
    expect(workflow.match(/run: bash native\/presence-win\/build\.sh/g)?.length).toBe(workflow.match(/run: bash native\/askpass-win\/build\.sh/g)?.length);
    const { presenceProblems } = require(path.join(root, 'scripts', 'check-presence-exe.cjs'));
    expect(() => presenceProblems(Buffer.from('not a program'))).toThrow(/not a Windows program/);
  });
});

test.describe('fix round of the security review', () => {
  test('(B1) has() decrypts nothing', () => {
    const dir = tempDir('vibex-presence-secrets-');
    try {
      let decrypts = 0;
      let on = true;
      const crypt = { available: () => on, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => { decrypts++; return b.toString(); } };
      const store = new SecretStore(path.join(dir, 'server-secrets.json'), crypt);
      const a = profile('alpha');
      store.set(a, 'password', 'made-up');
      expect(store.has(a, 'password')).toBe(true);
      expect(store.has(a, 'passphrase')).toBe(false);
      expect(store.has({ ...a, host: 'other.example' }, 'password')).toBe(false);
      expect(store.has(profile('beta'), 'password')).toBe(false);
      on = false;
      expect(store.has(a, 'password')).toBe(false);
      // A second store reads the file: has() still decrypts nothing.
      on = true;
      expect(new SecretStore(path.join(dir, 'server-secrets.json'), crypt).has(a, 'password')).toBe(true);
      expect(decrypts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(N2) a refused background listing stops until the person acts', async () => {
    const tickets: { silent: boolean; onRefused?: () => void }[] = [];
    const children: (EventEmitter & { kill: () => void; stdout: EventEmitter })[] = [];
    let up = true;
    const launch = () => {
      const child = Object.assign(new EventEmitter(), { kill: () => undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child);
      return child as any;
    };
    const p = { name: 'alpha', host: '127.0.0.1', port: 1, user: 'alpha', authentication: 'password' } as ServerProfile;
    const watcher = new PortWatcher({
      forwards: { portMap: new Map(), heldBack: new Set() } as any,
      profile: p,
      ignored: new Set(),
      isUp: () => up,
      ticket: (silent: boolean, onRefused?: () => void) => { tickets.push({ silent, onRefused }); return { env: {}, dispose: () => undefined }; },
      quiet: () => [],
      changed: () => undefined,
      announce: () => undefined,
      launch,
    } as any, true);
    const tick = () => (watcher as any).tick();
    const again = () => { (watcher as any).retryAfter = 0; tick(); };
    try {
      tick();
      expect(tickets.length).toBe(1);
      expect(tickets[0].silent).toBe(true);
      // The gate refuses this listing's saved secret, and its ssh ends.
      tickets[0].onRefused?.();
      children[0].emit('close', 255);
      again();
      again();
      expect(tickets.length, 'the watcher asked again with no action from the person').toBe(1);
      expect(watcher.lastError).toMatch(/not confirmed/);
      // The person presses Detect Ports: one listing, and the stream may start again.
      const detected = watcher.detectNow();
      children[children.length - 1].emit('close', 0);
      await detected;
      again();
      expect(tickets.filter((t) => t.silent).length).toBe(2);
      // A new connection also starts it again.
      tickets[tickets.length - 1].onRefused?.();
      children[children.length - 1].emit('close', 255);
      again();
      expect(tickets.filter((t) => t.silent).length).toBe(2);
      up = false;
      tick();
      up = true;
      again();
      expect(tickets.filter((t) => t.silent).length).toBe(3);
    } finally {
      watcher.stop();
    }
  });

  test('(N3) a login through a jump waits 60 s for the server, 15 s with none', () => {
    const p = profile('alpha');
    const jump = profile('gate');
    const timeout = (args: string[]) => args.filter((a) => a.startsWith('ConnectTimeout=')).map((a) => a.slice(15));
    expect(timeout(loginArgs(p, jump, [], 'true'))[0]).toBe('60');
    expect(timeout(loginArgs(p, undefined, [], 'true'))[0]).toBe('15');
    expect(timeout(runLaunch(p, jump, '/srv', undefined, 'true').args)[0]).toBe('60');
    expect(timeout(runLaunch(p, undefined, '/srv', undefined, 'true').args)[0]).toBe('15');
    const o = { remotePort: 40000, localPort: 40001, windowId: 'w', token: 'made-up', agentCommand: '' };
    expect(timeout(tunnelLaunch(p, jump, '/srv', 'shell', o).args)[0]).toBe('60');
    expect(timeout(tunnelLaunch(p, undefined, '/srv', 'shell', o).args)[0]).toBe('15');
    expect(timeout(serverLaunch(p, '/srv', 'shell', '').args)[0]).toBe('15');
  });

  test('(N4) on abort the stdin of the helper closes first, and it is killed after a grace', async () => {
    test.skip(isWindows, 'the stand-in helper is a shell script');
    const dir = tempDir('vibex-presence-stdin-');
    try {
      const file = path.join(dir, 'helper');
      writeFileSync(file, `#!/bin/sh\nread x || touch '${path.join(dir, 'stdin-closed')}'\nsleep 3\ntouch '${path.join(dir, 'outlived')}'\n`);
      chmodSync(file, 0o755);
      const abort = new AbortController();
      const pending = windowsPresence({ helper: file, window: () => '1' }).confirm('x', abort.signal);
      await new Promise((r) => setTimeout(r, 300));
      abort.abort();
      expect(await pending).toBe('no');
      await new Promise((r) => setTimeout(r, 500));
      expect(readdirSync(dir), 'stdin was not closed before the kill').toContain('stdin-closed');
      await new Promise((r) => setTimeout(r, 3000));
      expect(readdirSync(dir), 'the helper was not killed after the grace').not.toContain('outlived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(N4) the C helper cancels the prompt when stdin closes or at its own limit', () => {
    const text = readFileSync(path.join(__dirname, '..', 'native', 'presence-win', 'vibex-presence.c'), 'utf8');
    expect(text).toMatch(/GetStdHandle\(STD_INPUT_HANDLE\)/);
    expect(text).toMatch(/info->v->Cancel\(info\)/);
    expect(text).toMatch(/stop_requested/);
  });

  test('(N5) a Windows package with no Hello helper stops the build, and the installer check asks for it', () => {
    const dir = tempDir('vibex-presence-pack-');
    try {
      const { requireAskpassHelper } = require('../scripts/require-askpass-helper.cjs');
      const built = path.join(dir, 'native', 'askpass-win', 'build');
      require('node:fs').mkdirSync(built, { recursive: true });
      writeFileSync(path.join(built, 'vibex-askpass.exe'), 'x');
      const context = { electronPlatformName: 'win32', packager: { info: { projectDir: dir } } };
      expect(() => requireAskpassHelper(context)).toThrow(/vibex-presence\.exe/);
      const hello = path.join(dir, 'native', 'presence-win', 'build');
      require('node:fs').mkdirSync(hello, { recursive: true });
      writeFileSync(path.join(hello, 'vibex-presence.exe'), 'x');
      expect(() => requireAskpassHelper(context)).not.toThrow();
      const code = readFileSync(path.join(__dirname, '..', 'scripts', 'check-windows-installer.cjs'), 'utf8');
      expect(code).toMatch(/path\.join\(unpacked, 'resources', 'vibex-presence\.exe'\)/);
      expect(code).toMatch(/require\('\.\/check-presence-exe\.cjs'\)\.report\(/);
      expect(code).toMatch(/!packed\.includes\('vibex-presence\.exe'\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('second fix round of the review', () => {
  test('(B-1) a refused auto-forward makes no second gate call after the retry time, until the person acts', async () => {
    const tickets: { silent: boolean; refused?: () => void }[] = [];
    const children: any[] = [];
    const launch = () => {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, pid: 1, kill: () => undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child);
      return child as any;
    };
    const end = (child: any) => { child.exitCode = 255; child.emit('close', 255); };
    const p = { name: 'alpha', host: '127.0.0.1', port: 1, user: 'alpha', authentication: 'password' } as ServerProfile;
    const ticket = (silent: boolean, refused?: () => void) => { tickets.push({ silent, refused }); return { env: {}, dispose: () => undefined }; };
    const forwards = new ServerForwards({ profile: p, ticket, quiet: () => [], changed: () => undefined, launch } as any);
    let up = true;
    const watcher = new PortWatcher({ forwards, profile: p, ignored: new Set(), isUp: () => up, ticket, quiet: () => [], changed: () => undefined, announce: () => undefined, launch } as any, true);
    const listing = 'tcp 0 0 127.0.0.1:8790 0.0.0.0:* LISTEN\n';
    const forwardTickets = () => tickets.filter((t) => t.silent).length;
    /// One listing with the new port, as if the retry time had passed, then the forward's login ends.
    const offer = async () => {
      (watcher as any).failures.clear();
      const before = children.length;
      watcher.apply(listing);
      await until(() => children.length > before || !(watcher as any).pending.size, 3000).catch(() => undefined);
      return children.length > before ? children[children.length - 1] : null;
    };
    try {
      watcher.apply('');
      const first = await offer();
      expect(first).not.toBeNull();
      expect(forwardTickets()).toBe(1);
      // The gate refuses the forward's saved secret.
      tickets[0].refused?.();
      end(first);
      await until(() => !(watcher as any).pending.size);
      expect(await offer(), 'a second forward login after a refusal').toBeNull();
      expect(forwardTickets()).toBe(1);
      // The person presses Detect Ports: auto-forward may try again.
      const detected = watcher.detectNow();
      end(children[children.length - 1]);
      await detected;
      const second = await offer();
      expect(second).not.toBeNull();
      expect(forwardTickets()).toBe(2);
      tickets[tickets.length - 1].refused?.();
      end(second);
      await until(() => !(watcher as any).pending.size);
      expect(await offer()).toBeNull();
      // A new connection clears it too.
      up = false;
      (watcher as any).tick();
      up = true;
      expect(await offer()).not.toBeNull();
      expect(forwardTickets()).toBe(3);
    } finally {
      watcher.stop();
      forwards.close();
    }
  });

  test('(2) a login nobody watches never sends an empty password when this PC cannot confirm', async () => {
    expect(quietLoginOptions(true, true)).toEqual(['-o', 'NumberOfPasswordPrompts=1']);
    expect(quietLoginOptions(true, false)).toEqual(['-o', 'BatchMode=yes']);
    expect(quietLoginOptions(false, true)).toEqual(['-o', 'BatchMode=yes']);
    expect(new SavedSecretGate(noPresence).mayConfirm()).toBe(false);
    expect(new SavedSecretGate(fakePresence('unavailable')).mayConfirm()).toBe(false);
    const ok = new SavedSecretGate(fakePresence('ok'));
    expect(ok.mayConfirm()).toBe(true);
    // A PC that answered 'unavailable' (no Windows Hello) is known unable, until a yes comes.
    let answer: Presence = 'unavailable';
    const hello = new SavedSecretGate({ confirm: async () => answer });
    expect(hello.mayConfirm()).toBe(true);
    await hello.confirm('x');
    expect(hello.mayConfirm()).toBe(false);
    answer = 'ok';
    await hello.confirm('x');
    expect(hello.mayConfirm()).toBe(true);
    // A missing Windows helper is known before any call.
    expect(new SavedSecretGate(windowsPresence({ helper: path.join(tempDir('vibex-no-helper-'), 'gone.exe'), window: () => '1' })).mayConfirm()).toBe(false);
    const hub = readFileSync(path.join(__dirname, '..', 'src', 'main', 'serverHub.ts'), 'utf8');
    expect(hub).toMatch(/quietLoginOptions\(this\.secrets\.has\(profile, expectedSecret\(profile\)\), this\.gate\.mayConfirm\(\)\)/);
  });

  test('(4) the folder listing through a jump waits 60 s for the server, 10 s with none', () => {
    const timeout = (args: string[]) => args.filter((a) => a.startsWith('ConnectTimeout=')).map((a) => a.slice(15));
    expect(timeout(listFoldersArgs(profile('alpha'), profile('gate'), true))).toEqual(['60']);
    expect(timeout(listFoldersArgs(profile('alpha'), undefined, true))).toEqual(['10']);
    expect(listFoldersArgs(profile('alpha'), undefined, false).slice(0, 3)).toEqual(['-n', '-o', 'BatchMode=yes']);
  });

  test('(5) the release gate refuses a Windows installer with no Hello helper', () => {
    const code = readFileSync(path.join(__dirname, '..', 'scripts', 'update-release.mjs'), 'utf8');
    expect(code).toMatch(/path\.join\(root, 'resources', 'vibex-presence\.exe'\)/);
    expect(code).toMatch(/no vibex-presence\.exe/);
    expect(code).toMatch(/require\('\.\/check-presence-exe\.cjs'\)\.report\(/);
  });
});
