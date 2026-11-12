import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { SITE } from './site';

// Files of a server chat reach the server before the message does (chat-first plan, step P2). An image still goes inline, as
// base64, so it needs none of this. Any other file goes through the chat's own ssh login, on standard input, to the server's
// fixed command `pca-box chat-put`. That command keeps the file in the team's file store, in the person's folder
// uploads/<key>/chat-files/<date>/, and the login reads it at /srv/pca/uploads/<key>/chat-files/<date>/. The server
// checks the byte count, writes a temporary name, checks the size again and renames, so Claude never reads half a file.
// No Electron here: the tests run this file in Node.

/// One word for the server's shell, as servers.ts makes it (that file needs Electron, so it is not imported here).
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/// Binary megabytes. The upload page once refused files between 478 and 500 MiB because a gate counted in decimal units.
export const MIB = 1024 * 1024;
export const MAX_FILE_BYTES = 100 * MIB;
export const MAX_FILES = 10;
export const UPLOAD_PAGE = SITE.uploadPage;
/// The file store's folder uploads/ as the team login sees it (a read-only mount; its folder list is cached for 30 s).
export const SERVER_UPLOADS = '/srv/pca/uploads';
/// How long the server may take to show a stored file in the mount, in seconds.
export const VISIBLE_WAIT_S = 45;

/// What the chat's ssh login gives: the ssh program, its arguments around a script, the askpass environment of the Hello gate
/// path, and the end of that ticket. The server chat (step P1) makes it; the upload only uses it.
export interface UploadLogin {
  file: string;
  args: (script: string) => string[];
  env: Record<string, string>;
  dispose: () => void;
  /// Plain words for a login that ended before the script ran (ssh's standard error in, one sentence out).
  failure?: (stderr: string) => string;
}

export type UploadPhase = 'waiting' | 'sending' | 'saving' | 'done' | 'failed' | 'refused';

/// One file's upload, as the chip shows it.
export interface UploadState {
  phase: UploadPhase;
  sent: number;
  total: number;
  /// Plain words for the person; null while all is well.
  error: string | null;
  /// The path Claude gets, once the server stored the file.
  serverPath: string | null;
}

export const plainErrors = {
  tooLarge: `This file is larger than 100 MiB. Send it on the upload page: ${UPLOAD_PAGE}`,
  tooMany: `At most ${MAX_FILES} files go in one message. Send this file in the next message.`,
  folder: 'A folder cannot be sent. Make a zip of the folder, then attach the zip.',
  unreadable: 'This file cannot be read on this computer. Check that it is still there, then attach it again.',
  empty: 'This file is empty, so there is nothing to send.',
  notPersonFolder: 'Files go to your own folder on the team server. Open your folder (/srv/pca/people/<your key>) as the project.',
  noLogin: 'The chat is not connected to the server. Close this chat and open a new one.',
  network: 'The file did not reach the server. Check the internet connection, then press Send again.',
  timeout: 'The upload took too long. Check the internet connection, then press Send again.',
  changed: 'The file changed on this computer while it was sent. Press Send again.',
  notReady: `The server cannot take files from the chat yet. Send the file on the upload page: ${UPLOAD_PAGE}`,
  refusedName: 'The server refused this file name. Rename the file on this computer, then attach it again.',
  serverFull: 'The server has too many files of this name today. Rename the file, then attach it again.',
  unseen: 'The server saved the file, but Claude cannot see it yet. Wait one minute, then press Send again.',
  stopped: 'The upload was stopped. Press Send to try again.',
} as const;

const PERSON_FOLDER = /^\/srv\/pca\/people\/([a-z][a-z0-9-]{1,30})(?:\/|$)/;

/// The person's key from the open project's folder on the team server, or null when it is no person's folder.
export function personKeyOf(folder: string): string | null {
  return PERSON_FOLDER.exec(folder)?.[1] ?? null;
}

const NAME_CAP_BYTES = 200;
const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

/// A name the server takes, close to the person's own: letters of any script stay, so "Hisobot Отчёт.xlsx" stays as it is.
/// Characters that Windows refuses, control and format marks, and rclone's quote mark (U+201B) become "_". The server checks
/// the same rules again (pca-box check_chat_name).
export function safeFileName(raw: string): string {
  let name = raw.normalize('NFC').replace(/[\p{C}\u2028\u2029\\/:*?"<>|\u201b]/gu, '_').replace(/\.vibexpart/gi, '_vibexpart');
  name = name.replace(/^[.\- ]+/, '').replace(/[. ]+$/, '');
  if (!name) name = 'file';
  if (bytesOf(name) > NAME_CAP_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    let stem = ext ? name.slice(0, dot) : name;
    while (bytesOf(stem + ext) > NAME_CAP_BYTES) stem = [...stem].slice(0, -1).join('');
    name = (stem.replace(/[. ]+$/, '') || 'file') + ext;
  }
  return name;
}

/// Why a picked file cannot go to the server, or null. `filesBefore` counts the files (not images) already on the message.
export function limitError(size: { bytes: number; isFile: boolean } | null, filesBefore: number): string | null {
  if (!size) return plainErrors.unreadable;
  if (!size.isFile) return plainErrors.folder;
  if (size.bytes > MAX_FILE_BYTES) return plainErrors.tooLarge;
  if (size.bytes === 0) return plainErrors.empty;
  if (filesBefore >= MAX_FILES) return plainErrors.tooMany;
  return null;
}

export function sizeOf(file: string): { bytes: number; isFile: boolean } | null {
  try {
    const st = statSync(file);
    return { bytes: st.size, isFile: st.isFile() };
  } catch {
    return null;
  }
}

const POLL = (file: string, size: number, waitS: number, mark: string) => `VIBEX_I=0
while [ "$VIBEX_I" -lt ${waitS} ]; do
  VIBEX_S=$(wc -c < ${file} 2>/dev/null | tr -d ' ')
  if [ "$VIBEX_S" = ${size} ]; then echo '${mark} ok' >&3; exit 0; fi
  sleep 1
  VIBEX_I=$((VIBEX_I + 1))
done
echo '${mark} unseen' >&3`;

/// What every script here starts with: its own lines go to descriptor 3, the real standard output, and anything else (a
/// login file that prints) goes to standard error. As the server chat's probe script does (serverChat.ts). A login file can
/// still print before the script starts, so each reply line also opens with a mark that is new for each upload.
const QUIET = 'exec 3>&1 1>&2';
const MARK = /^vibex-[0-9a-f]{16}$/;
export const newMark = () => `vibex-${randomBytes(8).toString('hex')}`;

/// The script the upload runs on the server, as the team login. Standard input is the file. It prints only its own lines:
/// "<mark> stored ..." (pca-box's line), then "<mark> ok" or "<mark> unseen"; or one "<mark> failed <exit> <last line>".
export function uploadScript(key: string, name: string, size: number, mark: string, uploads = SERVER_UPLOADS, waitS = VISIBLE_WAIT_S): string {
  if (!MARK.test(mark)) throw new Error('bad mark');
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(key)) throw new Error('bad key');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new Error('bad size');
  if (safeFileName(name) !== name) throw new Error('bad name');
  return `${QUIET}
# While pca-box works after the last byte, one line every 10 s keeps the app's idle limit from ending a good upload. The
# sleep holds no pipe, so a kill of the loop ends it at once; the loop also ends when this shell has gone.
( while kill -0 $$ 2>/dev/null; do sleep 10 </dev/null >/dev/null 2>&1 3>&-; echo '${mark} wait' >&3 || exit 0; done ) </dev/null &
VIBEX_BEAT=$!
VIBEX_OUT=$(sudo -n -u pca-ops /opt/pca-team/bin/pca-box chat-put ${shellWord(key)} ${shellWord(name)} ${size} 2>&1)
VIBEX_RC=$?
kill "$VIBEX_BEAT" 2>/dev/null
# The whole line: a stored line holds the name (up to 200 bytes) and a 64-letter hash, so a cut would lose the hash.
VIBEX_LAST=$(printf '%s\\n' "$VIBEX_OUT" | tail -n 1 | tr -d '\\r' | cut -c1-1024)
if [ "$VIBEX_RC" -ne 0 ]; then printf '%s failed %s %s\\n' '${mark}' "$VIBEX_RC" "$VIBEX_LAST" >&3; exit 0; fi
printf '%s %s\\n' '${mark}' "$VIBEX_LAST" >&3
VIBEX_REL=$(printf '%s\\n' "$VIBEX_LAST" | sed -n 's|^stored uploads/\\(.*\\) bytes [0-9][0-9]* sha256 [0-9a-f]*$|\\1|p')
if [ -z "$VIBEX_REL" ]; then echo '${mark} failed 1 no stored line' >&3; exit 0; fi
VIBEX_FILE=${shellWord(uploads)}/"$VIBEX_REL"
${POLL('"$VIBEX_FILE"', size, waitS, mark)}
`;
}

/// The second try after "unseen": the file is stored, so only its arrival in the mount is waited for.
export function visibleScript(serverPath: string, size: number, mark: string, uploads = SERVER_UPLOADS, waitS = VISIBLE_WAIT_S): string {
  if (!MARK.test(mark)) throw new Error('bad mark');
  if (!serverPath.startsWith(`${uploads}/`) || /[\x00-\x1f]/.test(serverPath)) throw new Error('bad path');
  return `${QUIET}\n${POLL(shellWord(serverPath), size, waitS, mark)}\n`;
}

export type UploadResult =
  | { kind: 'ok'; serverPath: string }
  | { kind: 'unseen'; serverPath: string }
  | { kind: 'error'; error: string };

const STORED = /^stored uploads\/([a-z][a-z0-9-]{1,30}\/chat-files\/\d{4}-\d{2}-\d{2}\/[^\n/]+) bytes (\d+) sha256 [0-9a-f]{64}$/;

/// What the server's lines mean: only lines that open with this upload's mark count. An exit of ssh itself, with no line,
/// is the network's. A stored line must name this person's folder and this size.
export function readUploadOutput(stdout: string, o: { size: number; mark: string; key: string; uploads?: string; knownPath?: string | null }): UploadResult {
  const uploads = o.uploads ?? SERVER_UPLOADS;
  const size = o.size;
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(`${o.mark} `)).map((l) => l.slice(o.mark.length + 1));
  const failed = lines.find((l) => l.startsWith('failed '));
  if (failed) {
    const [, code, ...rest] = failed.split(' ');
    const why = rest.join(' ');
    if (/over 100 MiB/.test(why)) return { kind: 'error', error: plainErrors.tooLarge };
    if (/size differs/.test(why)) return { kind: 'error', error: plainErrors.changed };
    if (/bad name/.test(why)) return { kind: 'error', error: plainErrors.refusedName };
    if (/too many files of this name/.test(why)) return { kind: 'error', error: plainErrors.serverFull };
    // sudo's own refusal, an old server with no chat-put (exit 2: unknown verb), or a missing tool on the server.
    if (code === '2' || /not ready|not allowed|sudo|password is required|unknown verb/i.test(why)) return { kind: 'error', error: plainErrors.notReady };
    return { kind: 'error', error: plainErrors.network };
  }
  let serverPath = o.knownPath ?? null;
  for (const line of lines) {
    const m = STORED.exec(line);
    if (m && Number(m[2]) === size && m[1].startsWith(`${o.key}/`)) serverPath = `${uploads}/${m[1]}`;
  }
  if (!serverPath) return { kind: 'error', error: plainErrors.network };
  if (lines.includes('ok')) return { kind: 'ok', serverPath };
  if (lines.includes('unseen')) return { kind: 'unseen', serverPath };
  return { kind: 'error', error: plainErrors.network };
}

/// The time limit for one file: 2 minutes, plus 10 s for each MiB (about 100 KiB/s, a slow line).
export const timeLimitMs = (bytes: number) => 120_000 + Math.ceil(bytes / MIB) * 10_000;
/// The upload also ends when no byte moved for this long.
export const IDLE_LIMIT_MS = 90_000;

export interface UploadRun {
  done: Promise<UploadResult>;
  stop: () => void;
}

/// Sends one file through the login. `progress` gets the bytes handed to ssh; after the last one the phase is "saving".
export function uploadFile(
  login: UploadLogin,
  o: { file: string; key: string; name: string; size: number; serverPath?: string | null; uploads?: string; visibleWaitS?: number; limitMs?: number; idleMs?: number },
  progress: (sent: number, phase: 'sending' | 'saving') => void,
): UploadRun {
  const waitOnly = !!o.serverPath;
  const mark = newMark();
  const script = waitOnly ? visibleScript(o.serverPath!, o.size, mark, o.uploads, o.visibleWaitS) : uploadScript(o.key, o.name, o.size, mark, o.uploads, o.visibleWaitS);
  let stopped = false;
  let stopFn: () => void = () => { stopped = true; };
  const done = new Promise<UploadResult>((resolve) => {
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; login.dispose(); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(login.file, login.args(script), { env: { ...process.env, ...login.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      dispose();
      resolve({ kind: 'error', error: plainErrors.network });
      return;
    }
    let out = '';
    let err = '';
    let ended: UploadResult | null = null;
    let sent = 0;
    let answered = false;
    const answer = (result: UploadResult) => {
      if (answered) return;
      answered = true;
      resolve(result);
    };
    const finish = (result: UploadResult) => {
      if (!ended) ended = result;
    };
    /// Stop and the time limits answer at once; the login still ends only when ssh has closed.
    const end = (result: UploadResult) => {
      finish(result);
      answer(ended!);
      kill();
    };
    let read: ReturnType<typeof createReadStream> | null = null;
    const kill = () => {
      read?.destroy();
      try { child.kill(); } catch { /* it ended */ }
    };
    const limit = setTimeout(() => end({ kind: 'error', error: plainErrors.timeout }), o.limitMs ?? timeLimitMs(o.size));
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => end({ kind: 'error', error: plainErrors.timeout }), o.idleMs ?? IDLE_LIMIT_MS);
    };
    touch();
    stopFn = () => end({ kind: 'error', error: plainErrors.stopped });
    if (stopped) stopFn();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => { out = (out + text).slice(-8192); touch(); });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => { err = (err + text).slice(-8192); touch(); });
    child.stdin!.on('error', () => { /* ssh ended first: its exit says why */ });
    if (waitOnly) {
      child.stdin!.end();
      progress(o.size, 'saving');
    } else {
      // Exactly the bytes that were counted: a file that grew sends its first `size` bytes, and the server refuses a short one.
      read = createReadStream(o.file, { start: 0, end: o.size - 1, highWaterMark: 256 * 1024 });
      read.on('data', (chunk) => {
        sent += chunk.length;
        touch();
        progress(sent, 'sending');
      });
      read.on('error', () => { finish({ kind: 'error', error: plainErrors.unreadable }); kill(); });
      read.on('end', () => {
        if (sent !== o.size) finish({ kind: 'error', error: plainErrors.changed });
        else progress(sent, 'saving');
      });
      read.pipe(child.stdin!);
    }
    child.on('error', () => finish({ kind: 'error', error: plainErrors.network }));
    const settle = () => {
      read?.destroy();
      clearTimeout(limit);
      if (idle) clearTimeout(idle);
      dispose();
      // No line of this upload's mark at all: the login itself ended (a refused key, a host key, the network).
      const ran = out.split(/\r?\n/).some((l) => l.trim().startsWith(`${mark} `));
      if (!ended && !ran && login.failure) ended = { kind: 'error', error: login.failure(err) };
      answer(ended ?? readUploadOutput(out, { size: o.size, mark, key: o.key, uploads: o.uploads, knownPath: o.serverPath ?? null }));
    };
    // The login ends when ssh ends. Its pipes close a moment later, and the reply is read then; a pipe that another process
    // still holds must not keep the ticket or the answer waiting.
    child.on('exit', () => {
      dispose();
      setTimeout(settle, 2000).unref?.();
    });
    child.on('close', settle);
  });
  return { done, stop: () => stopFn() };
}

/// What sendFiles needs of a chat. The chat service gives its own; the tests give made-up ones.
export interface SendFilesDeps {
  attachments: () => { id: string; kind: 'image' | 'file'; name: string | null; path?: string }[];
  setAttachments: (list: any[]) => void;
  uploads: Map<string, UploadState>;
  runs: Map<string, UploadRun>;
  /// The open project's folder on the server.
  folder: string;
  login: () => UploadLogin | null;
  changed: () => void;
  /// Tests only: the mount folder and the wait for a stored file to show there.
  uploadsRoot?: string;
  visibleWaitS?: number;
}

/// Sends each file of the message that is not on the server yet, one at a time. True when all are there; then each file's
/// path is its server path. False with a plain error on the chip when one did not go: the message waits, and the words stay.
/// A file that went before is not sent again.
export async function sendFiles(d: SendFilesDeps): Promise<boolean> {
  const files = d.attachments().flatMap((a) => (a.kind === 'file' && a.path ? [{ id: a.id, name: a.name ?? 'file', path: a.path }] : []));
  if (!files.length) return true;
  // The count is checked again here: an attach path that skipped it must still not send an 11th file.
  for (const extra of files.slice(MAX_FILES)) {
    const known = d.uploads.get(extra.id);
    d.uploads.set(extra.id, { phase: 'refused', sent: 0, total: known?.total ?? 0, error: plainErrors.tooMany, serverPath: null });
  }
  if (files.length > MAX_FILES) d.changed();
  if (files.some((f) => d.uploads.get(f.id)?.phase === 'refused')) throw new Error('Remove the files marked in red, then press Send again.');
  const key = personKeyOf(d.folder);
  const present = (id: string) => d.attachments().some((a) => a.id === id);
  for (const file of files) {
    const known = d.uploads.get(file.id);
    if (known?.phase === 'done' && known.serverPath) continue;
    const fail = (phase: 'failed' | 'refused', error: string, serverPath: string | null, total: number) => {
      if (present(file.id)) d.uploads.set(file.id, { phase, sent: 0, total, error, serverPath });
      d.changed();
      return false;
    };
    if (!key) return fail('failed', plainErrors.notPersonFolder, null, known?.total ?? 0);
    // The size is read again: the file may have changed since it was attached.
    const size = sizeOf(file.path);
    const error = limitError(size, 0);
    if (error) return fail('refused', error, null, size?.bytes ?? 0);
    const login = d.login();
    if (!login) return fail('failed', plainErrors.noLogin, known?.serverPath ?? null, size!.bytes);
    const state: UploadState = { phase: 'sending', sent: 0, total: size!.bytes, error: null, serverPath: null };
    d.uploads.set(file.id, state);
    d.changed();
    const run = uploadFile(login, {
      file: file.path, key, name: safeFileName(file.name), size: size!.bytes, serverPath: known?.serverPath ?? null,
      uploads: d.uploadsRoot, visibleWaitS: d.visibleWaitS,
    }, (sent, phase) => {
      state.sent = sent;
      state.phase = phase;
      d.changed();
    });
    d.runs.set(file.id, run);
    const result = await run.done;
    d.runs.delete(file.id);
    // Removed while it went: the message does not go, and the words stay.
    if (!present(file.id)) {
      d.changed();
      return false;
    }
    if (result.kind === 'error') return fail('failed', result.error, known?.serverPath ?? null, state.total);
    if (result.kind === 'unseen') return fail('failed', plainErrors.unseen, result.serverPath, state.total);
    d.uploads.set(file.id, { ...state, phase: 'done', sent: state.total, serverPath: result.serverPath });
    d.changed();
  }
  d.setAttachments(d.attachments().map((a) => {
    const path = a.kind === 'file' ? d.uploads.get(a.id)?.serverPath : null;
    return a.kind === 'file' && path ? { ...a, path } : a;
  }));
  return true;
}
