import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  limitError, MAX_FILE_BYTES, MAX_FILES, MIB, newMark, personKeyOf, plainErrors, readUploadOutput, safeFileName, sendFiles, timeLimitMs,
  uploadFile, uploadScript, visibleScript, type UploadLogin, type UploadRun, type UploadState,
  UPLOAD_PAGE,
} from '../src/main/chatUpload';
import { uploadLine } from '../src/renderer/chatUploadText';

// Files of a server chat go to the server before the message (chat-first plan P2). Node only, no app window: the "ssh" here is
// /bin/sh, and a made-up sudo plays the server's `pca-box chat-put` (the real one has its own tests on the server side). Made-up data only.

const posix = process.platform !== 'win32';
const DAY = '2026-11-05';
const FAKE_SUDO = `#!/bin/sh
echo "$*" >> "$FAKE_BOX/sudo.log"
if [ "$1" != -n ] || [ "$2" != -u ] || [ "$3" != pca-ops ] || [ "$4" != /opt/pca-team/bin/pca-box ] || [ "$5" != chat-put ]; then
  echo "sudo: a password is required"; exit 1
fi
mode=$(cat "$FAKE_BOX/mode" 2>/dev/null)
case "$mode" in
  unknown) cat >/dev/null; echo "unknown verb" >&2; exit 2 ;;
  slow) sleep 4; exit 1 ;;
esac
dir="$FAKE_BOX/uploads/$6/chat-files/${DAY}"
mkdir -p "$dir"
tmp="$FAKE_BOX/part"
cat > "$tmp"
if [ "$mode" = saveslow ]; then sleep 13; fi
n=$(wc -c < "$tmp" | tr -d ' ')
if [ "$n" != "$8" ]; then rm -f "$tmp"; echo "refused: size differs" >&2; exit 3; fi
if [ "$mode" = hidden ]; then dest="$FAKE_BOX/hidden"; else dest="$dir/$7"; fi
mv "$tmp" "$dest"
echo "stored uploads/$6/chat-files/${DAY}/$7 bytes $n sha256 $(shasum -a 256 < "$dest" | cut -c1-64)"
`;

let root: string;
let box: string;
let disposed: number;

function login(env: Record<string, string> = {}): UploadLogin {
  return {
    file: '/bin/sh',
    args: (script) => ['-c', script],
    env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, FAKE_BOX: box, ...env },
    dispose: () => { disposed++; },
  };
}

const mode = (m: string) => writeFileSync(path.join(box, 'mode'), m);
const sudoCalls = () => (existsSync(path.join(box, 'sudo.log')) ? readFileSync(path.join(box, 'sudo.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function madeUpFile(name: string, bytes: number): string {
  const file = path.join(root, 'pc', name);
  mkdirSync(path.dirname(file), { recursive: true });
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + 7) & 0xff;
  writeFileSync(file, data);
  return file;
}

test.beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'chat-upload-'));
  box = path.join(root, 'box');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(box);
  writeFileSync(path.join(root, 'bin', 'sudo'), FAKE_SUDO);
  chmodSync(path.join(root, 'bin', 'sudo'), 0o755);
  disposed = 0;
});

test.afterEach(() => rmSync(root, { recursive: true, force: true }));

test.describe('limits: 100 MiB per file and 10 files per message', () => {
  test('100 MiB is 104,857,600 bytes, not 100,000,000', () => {
    expect(MIB).toBe(1_048_576);
    expect(MAX_FILE_BYTES).toBe(104_857_600);
    expect(limitError({ bytes: 104_857_600, isFile: true }, 0)).toBeNull();
    // A decimal gate would refuse what lies between 100 MB and 100 MiB.
    expect(limitError({ bytes: 104_000_000, isFile: true }, 0)).toBeNull();
    expect(limitError({ bytes: 104_857_601, isFile: true }, 0)).toBe(plainErrors.tooLarge);
  });
  test('the larger file gets a pointer to the upload page', () => {
    expect(plainErrors.tooLarge).toContain(UPLOAD_PAGE);
    expect(plainErrors.tooLarge).toContain('100 MiB');
  });
  test('the 11th file of a message is refused, the 10th is not', () => {
    expect(MAX_FILES).toBe(10);
    expect(limitError({ bytes: 5, isFile: true }, 9)).toBeNull();
    expect(limitError({ bytes: 5, isFile: true }, 10)).toBe(plainErrors.tooMany);
  });
  test('a folder, an empty file and an unreadable file each get their own words', () => {
    expect(limitError({ bytes: 96, isFile: false }, 0)).toBe(plainErrors.folder);
    expect(limitError({ bytes: 0, isFile: true }, 0)).toBe(plainErrors.empty);
    expect(limitError(null, 0)).toBe(plainErrors.unreadable);
  });
  test('the script refuses a size over the limit before anything runs', () => {
    expect(() => uploadScript('ali-test', 'a.bin', MAX_FILE_BYTES + 1, newMark())).toThrow('bad size');
    expect(uploadScript('ali-test', 'a.bin', MAX_FILE_BYTES, newMark())).toContain(' 104857600 ');
  });
  test('the time limit grows with the size', () => {
    expect(timeLimitMs(1)).toBe(130_000);
    expect(timeLimitMs(MAX_FILE_BYTES)).toBe(120_000 + 100 * 10_000);
  });
});

test.describe('names and folders', () => {
  test('the person key comes from the open project folder only', () => {
    expect(personKeyOf('/srv/pca/people/person-a')).toBe('person-a');
    expect(personKeyOf('/srv/pca/people/ali-test/clients/x')).toBe('ali-test');
    for (const folder of ['/srv/pca/people', '/srv/pca/people/', '/srv/pca', '~', '~/team', '/srv/pca/people/Person-a', '/srv/pca/people/../x', '/home/pca/srv/pca/people/ali'])
      expect(personKeyOf(folder), folder).toBeNull();
  });

  /// The server's rules (pca-box check_chat_name), so a name the app makes is never refused there.
  const serverTakes = (n: string) => Buffer.byteLength(n) >= 1 && Buffer.byteLength(n) <= 200 && n.normalize('NFC') === n
    && !/[\p{C}\u2028\u2029/\\:\u201b]/u.test(n) && !n.includes('.vibexpart') && !/^[.\- ]/.test(n) && !/[. ]$/.test(n);

  const cases: [string, string][] = [
    ['Hisobot 2026 Отчёт.xlsx', 'Hisobot 2026 Отчёт.xlsx'],
    ['a/b:c*?.txt', 'a_b_c__.txt'],
    ['.hidden', 'hidden'],
    ['-x.pdf', 'x.pdf'],
    ['end. ', 'end'],
    ['x.vibexpart', 'x_vibexpart'],
    ['tab\there.csv', 'tab_here.csv'],
    ['quote\u201bmark.doc', 'quote_mark.doc'],
    ['e\u0301.txt', '\u00e9.txt'],
    ['', 'file'],
    ['...', 'file'],
  ];
  for (const [given, made] of cases) {
    test(`safe name: ${JSON.stringify(given)}`, () => {
      expect(safeFileName(given)).toBe(made);
      expect(serverTakes(safeFileName(given))).toBe(true);
    });
  }
  test('a long name is cut to 200 bytes and keeps its extension', () => {
    const made = safeFileName(`${'Ж'.repeat(150)}.xlsx`);
    expect(Buffer.byteLength(made)).toBeLessThanOrEqual(200);
    expect(made.endsWith('.xlsx')).toBe(true);
    expect(serverTakes(made)).toBe(true);
  });
  test('the script takes only a safe name and a valid key', () => {
    expect(() => uploadScript('ali-test', 'a/b.txt', 3, newMark())).toThrow('bad name');
    expect(() => uploadScript('Ali', 'a.txt', 3, newMark())).toThrow('bad key');
    expect(() => uploadScript('ali-test', 'a.txt', 3, "x'; rm -rf ~; '")).toThrow('bad mark');
    expect(() => visibleScript('/etc/passwd', 3, newMark())).toThrow('bad path');
  });
});

test.describe('the server lines', () => {
  const mark = 'vibex-0123456789abcdef';
  const read = (text: string, size = 3) => readUploadOutput(text, { size, mark, key: 'ali-test' });
  const line = `${mark} stored uploads/ali-test/chat-files/${DAY}/r.xlsx bytes 3 sha256 ${'a'.repeat(64)}`;
  test('stored and visible: the server path', () => {
    expect(read(`${line}\n${mark} ok\n`)).toEqual({ kind: 'ok', serverPath: `/srv/pca/uploads/ali-test/chat-files/${DAY}/r.xlsx` });
  });
  test('stored but not visible yet', () => {
    expect(read(`${line}\n${mark} unseen\n`).kind).toBe('unseen');
  });
  test('a stored line of another size is not taken', () => {
    expect(read(`${line}\n${mark} ok\n`, 4)).toEqual({ kind: 'error', error: plainErrors.network });
  });
  test("a stored line in another person's folder is not taken", () => {
    expect(read(`${line.replace('/ali-test/', '/vali-test/')}\n${mark} ok\n`)).toEqual({ kind: 'error', error: plainErrors.network });
  });
  test('lines without this upload\'s mark are not read', () => {
    const other = 'vibex-ffffffffffffffff';
    expect(read(`${line.replace(mark, other)}\n${other} ok\nstored uploads/ali-test/chat-files/${DAY}/r.xlsx bytes 3 sha256 ${'a'.repeat(64)}\nok\n`)).toEqual({ kind: 'error', error: plainErrors.network });
  });
  test('refusals in plain words', () => {
    expect(read(`${mark} failed 3 refused: size differs`)).toEqual({ kind: 'error', error: plainErrors.changed });
    expect(read(`${mark} failed 3 refused: over 100 MiB; use the upload page`)).toEqual({ kind: 'error', error: plainErrors.tooLarge });
    expect(read(`${mark} failed 2 unknown verb`)).toEqual({ kind: 'error', error: plainErrors.notReady });
    expect(read(`${mark} failed 1 sudo: a password is required`)).toEqual({ kind: 'error', error: plainErrors.notReady });
    expect(read(`${mark} failed 1 chat upload is not ready on this server`)).toEqual({ kind: 'error', error: plainErrors.notReady });
    expect(read('')).toEqual({ kind: 'error', error: plainErrors.network });
  });
  test('no error shows raw server text', () => {
    for (const words of Object.values(plainErrors)) expect(words).not.toMatch(/refused:|exit|sudo|rclone|stderr/i);
  });
});

test.describe('one file through the login', () => {
  test.skip(!posix, 'the made-up server is a POSIX shell');

  test('the bytes arrive whole, under the dated folder, and the login ends once', async () => {
    const file = madeUpFile('Hisobot Отчёт.xlsx', 3 * MIB + 17);
    const seen: [number, string][] = [];
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'Hisobot Отчёт.xlsx', size: 3 * MIB + 17, uploads: path.join(box, 'uploads'), visibleWaitS: 3 }, (sent, phase) => seen.push([sent, phase]));
    const result = await run.done;
    const stored = path.join(box, 'uploads', 'ali-test', 'chat-files', DAY, 'Hisobot Отчёт.xlsx');
    expect(result).toEqual({ kind: 'ok', serverPath: stored });
    expect(sha(stored)).toBe(sha(file));
    expect(seen.at(-1)).toEqual([3 * MIB + 17, 'saving']);
    const sending = seen.filter(([, p]) => p === 'sending').map(([n]) => n);
    expect(sending.length).toBeGreaterThan(1);
    expect(sending).toEqual([...sending].sort((a, b) => a - b));
    expect(disposed).toBe(1);
  });

  test('a login file that prints on standard output does not confuse the reply', async () => {
    const file = madeUpFile('a.txt', 10);
    const noisy = { ...login(), args: (script: string) => ['-c', `echo 'stored uploads/x-y/chat-files/2000-01-01/evil bytes 10 sha256 ${'b'.repeat(64)}'; echo vibex-upload-ok; ${script}`] };
    const run = uploadFile(noisy, { file, key: 'ali-test', name: 'a.txt', size: 10, uploads: path.join(box, 'uploads'), visibleWaitS: 2 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'ok', serverPath: path.join(box, 'uploads', 'ali-test', 'chat-files', DAY, 'a.txt') });
  });

  test('a printed fake "ok" cannot hide a refusal', async () => {
    mode('unknown');
    const file = madeUpFile('a.txt', 10);
    const fake = `stored uploads/ali-test/chat-files/${DAY}/a.txt bytes 10 sha256 ${'b'.repeat(64)}`;
    const noisy = { ...login(), args: (script: string) => ['-c', `echo '${fake}'; echo ok; echo vibex-upload-ok; ${script}`] };
    const run = uploadFile(noisy, { file, key: 'ali-test', name: 'a.txt', size: 10, uploads: path.join(box, 'uploads'), visibleWaitS: 1 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.notReady });
  });

  test('the first progress shows within 400 ms', async () => {
    const file = madeUpFile('big.bin', 20 * MIB);
    const start = Date.now();
    let first = 0;
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'big.bin', size: 20 * MIB, uploads: path.join(box, 'uploads'), visibleWaitS: 3 }, () => { if (!first) first = Date.now(); });
    await run.done;
    expect(first).toBeGreaterThan(0);
    expect(first - start).toBeLessThan(400);
  });

  test('a 200-byte name (the longest the app makes) comes back whole', async () => {
    const name = safeFileName(`${'Ж'.repeat(120)} hisobot.xlsx`);
    expect(Buffer.byteLength(name)).toBeGreaterThan(190);
    const file = madeUpFile('long.xlsx', 1_234_567);
    const run = uploadFile(login(), { file, key: 'person-b', name, size: 1_234_567, uploads: path.join(box, 'uploads'), visibleWaitS: 3 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'ok', serverPath: path.join(box, 'uploads', 'person-b', 'chat-files', DAY, name) });
    expect(sudoCalls()).toBe(1);
  });

  test('a slow save on the server is not cut by the idle limit: the script says it still waits', async () => {
    mode('saveslow');
    const file = madeUpFile('a.txt', 10);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'a.txt', size: 10, uploads: path.join(box, 'uploads'), visibleWaitS: 2, idleMs: 11_500 }, () => undefined);
    expect((await run.done).kind).toBe('ok');
  });

  test('a file of exactly 100 MiB goes through', async () => {
    const file = madeUpFile('limit.bin', MAX_FILE_BYTES);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'limit.bin', size: MAX_FILE_BYTES, uploads: path.join(box, 'uploads'), visibleWaitS: 3 }, () => undefined);
    const result = await run.done;
    expect(result.kind).toBe('ok');
    expect(sha(path.join(box, 'uploads', 'ali-test', 'chat-files', DAY, 'limit.bin'))).toBe(sha(file));
  });

  test('a file that shrank after it was counted is refused, and nothing is stored', async () => {
    const file = madeUpFile('shrink.txt', 1000);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'shrink.txt', size: 2000, uploads: path.join(box, 'uploads'), visibleWaitS: 1 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.changed });
    expect(existsSync(path.join(box, 'uploads', 'ali-test', 'chat-files', DAY, 'shrink.txt'))).toBe(false);
  });

  test('an old server with no chat-put says so in plain words', async () => {
    mode('unknown');
    const file = madeUpFile('a.txt', 10);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'a.txt', size: 10, visibleWaitS: 1 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.notReady });
  });

  test('Stop ends the upload, and the login ends once', async () => {
    mode('slow');
    const file = madeUpFile('a.txt', 10);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'a.txt', size: 10, visibleWaitS: 1 }, () => undefined);
    setTimeout(() => run.stop(), 200);
    const at = Date.now();
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.stopped });
    expect(Date.now() - at).toBeLessThan(1000);
    await expect.poll(() => disposed, { timeout: 10_000 }).toBe(1);
  });

  test('the time limit ends a stuck upload', async () => {
    mode('slow');
    const file = madeUpFile('a.txt', 10);
    const run = uploadFile(login(), { file, key: 'ali-test', name: 'a.txt', size: 10, visibleWaitS: 1, limitMs: 300 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.timeout });
  });

  test('a login refused before the script runs shows the login\'s own words', async () => {
    const file = madeUpFile('a.txt', 10);
    const refused = { ...login(), args: () => ['-c', 'cat >/dev/null; echo "pca@server: Permission denied (publickey)." >&2; exit 255'], failure: (stderr: string) => (/permission denied/i.test(stderr) ? 'LOGIN WORDS' : 'OTHER') };
    const run = uploadFile(refused, { file, key: 'ali-test', name: 'a.txt', size: 10 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: 'LOGIN WORDS' });
  });

  test('a script that ran keeps its own answer, whatever the login printed on standard error', async () => {
    mode('unknown');
    const file = madeUpFile('a.txt', 10);
    const noisy = { ...login(), failure: () => 'LOGIN WORDS' };
    const run = uploadFile(noisy, { file, key: 'ali-test', name: 'a.txt', size: 10, visibleWaitS: 1 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.notReady });
  });

  test('ssh that cannot start is a network error, and the login ends once', async () => {
    const file = madeUpFile('a.txt', 10);
    const broken = { ...login(), file: path.join(root, 'no-such-ssh') };
    const run = uploadFile(broken, { file, key: 'ali-test', name: 'a.txt', size: 10 }, () => undefined);
    expect(await run.done).toEqual({ kind: 'error', error: plainErrors.network });
    expect(disposed).toBe(1);
  });
});

test.describe('sending the files of a message', () => {
  test.skip(!posix, 'the made-up server is a POSIX shell');

  function chat(list: any[], folder = '/srv/pca/people/ali-test') {
    const state = { list, uploads: new Map<string, UploadState>(), runs: new Map<string, UploadRun>(), changes: 0, hasLogin: true };
    const deps = {
      attachments: () => state.list,
      setAttachments: (next: any[]) => { state.list = next; },
      uploads: state.uploads,
      runs: state.runs,
      folder,
      login: () => (state.hasLogin ? login() : null),
      changed: () => { state.changes++; },
      uploadsRoot: path.join(box, 'uploads'),
      visibleWaitS: 2,
    };
    return { state, deps };
  }

  test('two files go, the image stays inline, and Claude gets the server paths', async () => {
    const a = madeUpFile('a.pdf', 4000);
    const b = madeUpFile('b.xlsx', 5000);
    const image = { id: 'i1', kind: 'image', name: null, mediaType: 'image/png', data: 'AAAA' };
    const { state, deps } = chat([image, { id: 'f1', kind: 'file', name: 'a.pdf', path: a }, { id: 'f2', kind: 'file', name: 'b.xlsx', path: b }]);
    expect(await sendFiles(deps)).toBe(true);
    const folder = path.join(box, 'uploads', 'ali-test', 'chat-files', DAY);
    expect(state.list).toEqual([image, { id: 'f1', kind: 'file', name: 'a.pdf', path: path.join(folder, 'a.pdf') }, { id: 'f2', kind: 'file', name: 'b.xlsx', path: path.join(folder, 'b.xlsx') }]);
    expect(state.uploads.get('f1')?.phase).toBe('done');
    expect(sudoCalls()).toBe(2);
    expect(state.changes).toBeGreaterThan(3);
  });

  test('the chip says "Sending" before any byte reaches the server', async () => {
    mode('slow');
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }]);
    const phases: string[] = [];
    deps.changed = () => { phases.push(`${state.uploads.get('f1')?.phase}:${state.uploads.get('f1')?.sent}`); };
    const sending = sendFiles(deps);
    // The first change the chip hears is "sending, 0 bytes". No check of the server's log here: the upload starts at once,
    // and on a busy machine its process can write before this line runs (seen on the fence, 2026-11-06).
    expect(phases[0]).toBe('sending:0');
    state.runs.get('f1')?.stop();
    expect(await sending).toBe(false);
  });

  test('an 11th file is refused at Send too, before any byte goes', async () => {
    const list = Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, kind: 'file', name: `f${i}.txt`, path: madeUpFile(`f${i}.txt`, 5) }));
    const { state, deps } = chat(list);
    await expect(sendFiles(deps)).rejects.toThrow('Remove the files marked in red');
    expect(state.uploads.get('f10')).toMatchObject({ phase: 'refused', error: plainErrors.tooMany });
    expect(state.uploads.get('f9')).toBeUndefined();
    expect(sudoCalls()).toBe(0);
  });

  test('a red chip stops the message before any byte goes', async () => {
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }]);
    state.uploads.set('f1', { phase: 'refused', sent: 0, total: 10, error: plainErrors.tooLarge, serverPath: null });
    await expect(sendFiles(deps)).rejects.toThrow('Remove the files marked in red');
    expect(sudoCalls()).toBe(0);
  });

  test('a file that grew past 100 MiB after it was attached turns red', async () => {
    const a = madeUpFile('grew.bin', MAX_FILE_BYTES + 1);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'grew.bin', path: a }]);
    state.uploads.set('f1', { phase: 'waiting', sent: 0, total: 10, error: null, serverPath: null });
    expect(await sendFiles(deps)).toBe(false);
    expect(state.uploads.get('f1')).toMatchObject({ phase: 'refused', error: plainErrors.tooLarge });
    expect(sudoCalls()).toBe(0);
  });

  test('a project that is no person folder sends nothing', async () => {
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }], '/srv/pca');
    expect(await sendFiles(deps)).toBe(false);
    expect(state.uploads.get('f1')?.error).toBe(plainErrors.notPersonFolder);
    expect(sudoCalls()).toBe(0);
  });

  test('no login: plain words, nothing sent', async () => {
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }]);
    state.hasLogin = false;
    expect(await sendFiles(deps)).toBe(false);
    expect(state.uploads.get('f1')?.error).toBe(plainErrors.noLogin);
  });

  test('a file that went is not sent again when the second one failed', async () => {
    const a = madeUpFile('a.pdf', 10);
    const b = madeUpFile('b.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }, { id: 'f2', kind: 'file', name: 'b.pdf', path: b }]);
    // f2 fails once: the made-up server refuses its first try.
    let tries = 0;
    deps.login = () => { tries++; return tries === 2 ? { ...login(), file: path.join(root, 'no-such-ssh') } : login(); };
    expect(await sendFiles(deps)).toBe(false);
    expect(state.uploads.get('f1')?.phase).toBe('done');
    expect(state.uploads.get('f2')).toMatchObject({ phase: 'failed', error: plainErrors.network });
    expect(await sendFiles(deps)).toBe(true);
    expect(sudoCalls()).toBe(2);
  });

  test('stored but not visible: the next Send only waits, it does not store a second copy', async () => {
    mode('hidden');
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }]);
    expect(await sendFiles(deps)).toBe(false);
    const up = state.uploads.get('f1')!;
    expect(up.error).toBe(plainErrors.unseen);
    expect(up.serverPath).toBe(path.join(box, 'uploads', 'ali-test', 'chat-files', DAY, 'a.pdf'));
    // The mount shows it now.
    mkdirSync(path.dirname(up.serverPath!), { recursive: true });
    renameSync(path.join(box, 'hidden'), up.serverPath!);
    expect(await sendFiles(deps)).toBe(true);
    expect(sudoCalls()).toBe(1);
    expect(state.list[0].path).toBe(up.serverPath);
  });

  test('a chip removed while it goes stops the message, and its state is gone', async () => {
    mode('slow');
    const a = madeUpFile('a.pdf', 10);
    const { state, deps } = chat([{ id: 'f1', kind: 'file', name: 'a.pdf', path: a }]);
    const sending = sendFiles(deps);
    await new Promise((r) => setTimeout(r, 200));
    state.list = [];
    state.runs.get('f1')?.stop();
    state.uploads.delete('f1');
    expect(await sending).toBe(false);
    expect(state.uploads.has('f1')).toBe(false);
    expect(readdirSync(box).includes('uploads')).toBe(false);
  });
});

test.describe('the chip words', () => {
  test('each phase', () => {
    expect(uploadLine(null)).toBeNull();
    expect(uploadLine({ phase: 'waiting', percent: 0, mib: 3.2, error: null })).toBeNull();
    expect(uploadLine({ phase: 'sending', percent: 42, mib: 3.2, error: null })).toEqual({ text: 'Sending 42% of 3.2 MiB', tone: 'busy', bar: 42 });
    expect(uploadLine({ phase: 'saving', percent: 100, mib: 3.2, error: null })).toEqual({ text: 'Saving on the server', tone: 'busy', bar: 100 });
    expect(uploadLine({ phase: 'done', percent: 100, mib: 3.2, error: null })).toEqual({ text: 'On the server', tone: 'ok', bar: null });
    expect(uploadLine({ phase: 'failed', percent: 0, mib: 3.2, error: plainErrors.network })).toEqual({ text: plainErrors.network, tone: 'error', bar: null });
    expect(uploadLine({ phase: 'refused', percent: 0, mib: 120, error: plainErrors.tooLarge })?.text).toContain(UPLOAD_PAGE);
  });
});
