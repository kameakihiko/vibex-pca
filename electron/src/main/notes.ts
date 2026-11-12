import { dialog } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModuleHost, VibexModule } from './modules';
import { notesTools } from './notesTools';
import type { ProjectInfo } from './projects';

// Notes as plain Markdown files, where the macOS app keeps them (Vibex/Notes): the project's Claude memory store, and a
// notes folder inside the vault (Obsidian). Obsidian opens the same files. A note is untrusted text: nothing here runs it.

export const MIRROR_FOLDER = 'Claude Memory';
/// A folder every computer has; a person picks the real vault with the folder button of the Notes section.
const DEFAULT_VAULT = '~/Documents';
/// Big files and huge folders are left out, so a stray export cannot stall the view.
export const MAX_FILE_SIZE = 1_000_000;
const MAX_FILES = 5_000;
const MAX_WALKED = 100_000;
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';

// ---------- paths ----------

function canon(p: string): string {
  const full = path.resolve(p);
  try { return fs.realpathSync.native(full); } catch { /* not there yet: resolve the parent */ }
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canon(parent), path.basename(full));
}
const fold = (p: string) => (CASE_BLIND ? p.toLowerCase() : p);

/// The path below `folder` ("a/b.md", with "/"), or null when `file` is not below it. Symlinks are resolved first.
export function relativeTo(file: string, folder: string): string | null {
  const base = canon(folder);
  const own = canon(file);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!fold(own).startsWith(fold(prefix))) return null;
  const rest = own.slice(prefix.length);
  return rest ? rest.split(path.sep).join('/') : null;
}
export const isInside = (file: string, folder: string) => relativeTo(file, folder) !== null || fold(canon(file)) === fold(canon(folder));

const isFolder = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function expand(raw: string, base: string, home: string): string {
  const text = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(path.isAbsolute(text) ? text : path.join(base, text));
}

/// Claude Code names a folder's store after its path, every character but a letter or a digit made "-".
export const claudeSlug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

// ---------- the exclude list ----------

const WHOLE_WORDS = new Set(['key', 'keys', 'creds', 'passcode', 'pass', 'pwd', 'pw', 'pin', 'pins', 'otp', 'login', 'logins', 'ssh', 'env', 'логин', 'логины']);
const STEMS = ['password', 'passwd', 'secret', 'credential', 'token', 'apikey', 'parol', 'kalit', 'maxfiy', 'парол', 'ключ', 'токен', 'секрет', 'доступ', 'махфий', 'калит'];
const COMPOUNDS = ['sshkey', 'apikey', 'awscredential', 'githubtoken', 'accesstoken', 'privatekey', '2fa'];

/// The words of a name, lowercased: split at anything but a letter or a digit, at "aB", "ABc" and between letters and digits.
export function words(name: string): string[] {
  const chars = [...name];
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push(cur.join('').toLowerCase()); cur = []; };
  const isLetter = (c: string) => /\p{L}/u.test(c);
  const isDigit = (c: string) => /\p{N}/u.test(c);
  chars.forEach((c, i) => {
    if (!isLetter(c) && !isDigit(c)) return flush();
    const prev = cur[cur.length - 1];
    if (prev !== undefined) {
      const next = chars[i + 1];
      const camel = /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(c);
      const acronymEnd = /\p{Lu}/u.test(prev) && /\p{Lu}/u.test(c) && next !== undefined && /\p{Ll}/u.test(next);
      if (camel || acronymEnd || isDigit(prev) !== isDigit(c)) flush();
    }
    cur.push(c);
  });
  flush();
  return out;
}

/// True when a folder or file name in `relative` looks like a credential, or holds an extra term from `.vibex.json`.
export function excludes(relative: string, extra: string[][] = []): boolean {
  return relative.split('/').filter(Boolean).some((part) => {
    const w = words(part);
    if (w.some((x) => WHOLE_WORDS.has(x))) return true;
    if (w.some((x) => STEMS.some((s) => x.startsWith(s)))) return true;
    const joined = [...part.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('');
    if (COMPOUNDS.some((c) => joined.includes(c))) return true;
    return extra.some((term) => w.some((_, i) => i + term.length <= w.length && term.every((t, j) => w[i + j] === t)));
  });
}

// ---------- settings and config ----------

export interface NotesSettings { vault?: string; folders?: Record<string, string> }
export interface NotesEnv { home: string; claudeDir: string; settingsFile: string }

export function readSettings(file: string): NotesSettings {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

export interface NotesConfig {
  project: string;
  memory: string | null;
  notes: string | null;
  vault: string;
  extra: string[][];
  /// The notes folder `.vibex.json` suggests, while no choice was made.
  suggested: string | null;
}

export function validNotesFolder(raw: string, vault: string, home: string, extra: string[][]): string | null {
  const candidate = expand(raw, vault, home);
  const relative = isFolder(candidate) ? relativeTo(candidate, vault) : null;
  if (!relative) return null;
  const parts = relative.split('/');
  if (parts.some((p) => p.startsWith('.')) || parts[0].toLowerCase() === MIRROR_FOLDER.toLowerCase() || excludes(relative, extra)) return null;
  return candidate;
}

export function claudeStore(project: string, env: NotesEnv): string {
  return path.join(env.claudeDir, 'projects', claudeSlug(project), 'memory');
}

export function loadConfig(project: string, env: NotesEnv): NotesConfig {
  let file: { memory?: unknown; notes?: unknown; notesExclude?: unknown } = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(project, '.vibex.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') file = parsed;
  } catch { /* none, or not JSON */ }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const settings = readSettings(env.settingsFile);
  const vault = expand(text(settings.vault) ?? DEFAULT_VAULT, env.home, env.home);
  const inRepo = path.join(project, '.claude', 'memory');
  const store = claudeStore(project, env);
  const rawMemory = text(file.memory);
  let memory: string | null = rawMemory ? expand(rawMemory, project, env.home) : isFolder(inRepo) ? inRepo : store;
  // The store must be in the project folder, or be Claude Code's store for it.
  if (!isFolder(memory) || !(isInside(memory, project) || isInside(memory, store))) memory = null;
  const extra = (Array.isArray(file.notesExclude) ? file.notesExclude : []).filter((t): t is string => typeof t === 'string').map(words).filter((w) => w.length);
  const chosen = settings.folders?.[canon(project)];
  const notes = text(chosen) ? validNotesFolder(chosen!, vault, env.home, extra) : null;
  let suggested: string | null = null;
  const hint = text(file.notes);
  if (chosen === undefined && hint) {
    const folder = validNotesFolder(hint, vault, env.home, extra);
    suggested = folder ? relativeTo(folder, vault) : null;
  }
  return { project, memory, notes, vault, extra, suggested };
}

// ---------- reading ----------

export interface NoteLink { target: string; shown?: string; isPath: boolean }
export interface Note {
  source: 'memory' | 'notes';
  relativePath: string;
  file: string;
  text: string;
  links: NoteLink[];
  tags: string[];
  /// The file name without ".md": what a [[wiki link]] names.
  name: string;
  /// "memory/MEMORY.md", "notes/plans/launch.md": short and unique across both sources.
  label: string;
  isIndex: boolean;
}

/// The lines of the text outside fenced code blocks, with inline code removed.
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const t = line.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) { fenced = !fenced; continue; }
    if (!fenced) out.push(line.replace(/`[^`]*`?/g, ''));
  }
  return out;
}

export function linksIn(text: string): NoteLink[] {
  const links: NoteLink[] = [];
  for (const line of proseLines(text)) {
    for (const m of line.matchAll(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g)) links.push({ target: m[1], shown: m[2], isPath: false });
    for (const m of line.matchAll(/\[([^\]\n]*)\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g)) links.push({ target: m[2], shown: m[1], isPath: true });
  }
  return links;
}

function frontMatter(text: string): { tags: string[]; lineCount: number } | null {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const clean = (t: string) => t.trim().replace(/^["'#]+|["'#]+$/g, '');
  const tags: string[] = [];
  let inList = false;
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (inList && line.startsWith('- ')) { tags.push(clean(line.slice(2))); continue; }
    inList = false;
    if (!line.toLowerCase().startsWith('tags:')) continue;
    const value = line.slice(5).trim();
    if (!value) { inList = true; continue; }
    tags.push(...value.replace(/^\[|\]$/g, '').split(',').map(clean));
  }
  return { tags: tags.filter(Boolean), lineCount: end + 1 };
}

/// `#tag` and `#area/tag` in prose (not "#" headings, not "#123"), plus `tags:` in the front matter.
export function tagsIn(text: string): string[] {
  const tags: string[] = [];
  let lines = proseLines(text);
  const front = frontMatter(text);
  if (front) { tags.push(...front.tags); lines = lines.slice(front.lineCount); }
  for (const line of lines) {
    for (const m of line.matchAll(/(?:^|[\s(,])#([\p{L}\p{N}_\-/]+)/gu)) if (/\P{N}/u.test(m[1])) tags.push(m[1]);
  }
  const seen = new Set<string>();
  return tags.filter((t) => !seen.has(t.toLowerCase()) && !!seen.add(t.toLowerCase()));
}

function makeNote(source: Note['source'], relativePath: string, file: string, text: string): Note {
  const base = relativePath.split('/').pop()!;
  return {
    source, relativePath, file, text, links: linksIn(text), tags: tagsIn(text),
    name: base.replace(/\.md$/i, ''), label: `${source}/${relativePath}`,
    isIndex: source === 'memory' && relativePath.toLowerCase() === 'memory.md',
  };
}

const byNatural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/// Markdown files below `root`: hidden names, symlinks, files on the exclude list and big files are skipped.
/// After `limit` notes the walk goes on only to collect the names the exclude list hides (up to MAX_WALKED entries).
async function scan(root: string, source: Note['source'], extra: string[][], hidden: Set<string>, limit: number): Promise<{ notes: Note[]; capped: boolean }> {
  const real = canon(root);
  const found: Note[] = [];
  let walked = 0;
  let capped = false;
  const collect = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++walked > MAX_WALKED) return;
      if (e.isDirectory()) await collect(path.join(dir, e.name));
      else if (/\.md$/i.test(e.name)) hidden.add(e.name.replace(/\.md$/i, '').toLowerCase());
    }
  };
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++walked > MAX_WALKED) return;
      if (e.name.startsWith('.')) continue;
      const relative = prefix + e.name;
      const full = path.join(dir, e.name);
      if (excludes(relative, extra)) {
        if (e.isDirectory()) await collect(full);
        else if (/\.md$/i.test(e.name)) hidden.add(e.name.replace(/\.md$/i, '').toLowerCase());
        continue;
      }
      if (e.isDirectory()) { await walk(full, relative + '/'); continue; }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      if (found.length >= limit) { capped = true; continue; }
      try {
        if ((await fs.promises.stat(full)).size > MAX_FILE_SIZE) continue;
        found.push(makeNote(source, relative, full, new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(full))));
      } catch { /* unreadable or not UTF-8 */ }
    }
  };
  await walk(real, '');
  found.sort((a, b) => (a.isIndex === b.isIndex ? byNatural(a.relativePath, b.relativePath) : a.isIndex ? -1 : 1));
  return { notes: found, capped };
}

const keyOf = (p: string) => fold(path.resolve(p));
const withoutMd = (p: string) => p.toLowerCase().replace(/\.md$/, '');

export interface Match { note: Note; lines: { number: number; text: string }[] }

export class NoteLibrary {
  private byPath = new Map<string, number>();
  private byName = new Map<string, number[]>();
  private outgoing: number[][] = [];
  constructor(readonly config: NotesConfig, readonly notes: Note[], readonly capped = false) {
    notes.forEach((n, i) => {
      this.byPath.set(keyOf(n.file), i);
      const names = new Set([n.name.toLowerCase(), withoutMd(n.relativePath)]);
      const inVault = relativeTo(n.file, config.vault);
      if (inVault) names.add(withoutMd(inVault));
      for (const name of names) this.byName.set(name, [...(this.byName.get(name) ?? []), i]);
    });
    this.outgoing = notes.map((n) => n.links.map((l) => this.index(l, n)).filter((i): i is number => i !== null));
  }

  static async load(config: NotesConfig): Promise<NoteLibrary> {
    const hidden = new Set<string>();
    const notes: Note[] = [];
    let capped = false;
    if (config.memory) { const r = await scan(config.memory, 'memory', config.extra, hidden, MAX_FILES); notes.push(...r.notes); capped ||= r.capped; }
    if (config.notes) { const r = await scan(config.notes, 'notes', config.extra, hidden, Math.max(MAX_FILES - notes.length, 0)); notes.push(...r.notes); capped ||= r.capped; }
    return new NoteLibrary(config, notes, capped);
  }

  find(file: string): Note | null {
    const i = this.byPath.get(keyOf(file)) ?? this.byPath.get(keyOf(canon(file)));
    return i === undefined ? null : this.notes[i];
  }

  private index(link: NoteLink, from: Note): number | null {
    let target = link.target;
    const hash = target.indexOf('#');
    if (hash >= 0) target = target.slice(0, hash);
    try { target = decodeURIComponent(target); } catch { /* keep */ }
    target = target.trim();
    if (!target) return null;
    if (link.isPath) {
      if (target.includes('://')) return null;
      return this.byPath.get(keyOf(path.join(path.dirname(from.file), target))) ?? null;
    }
    const candidates = this.byName.get(withoutMd(target)) ?? [];
    return candidates.find((i) => this.notes[i].source === from.source) ?? candidates[0] ?? null;
  }

  /// The note a link opens: a wiki link by file name or path (the same source wins), a markdown link by path.
  resolve(link: NoteLink, from: Note): Note | null {
    const i = this.index(link, from);
    return i === null ? null : this.notes[i];
  }

  backlinks(note: Note): Note[] {
    const self = this.byPath.get(keyOf(note.file));
    if (self === undefined) return [];
    return this.notes.filter((_, i) => i !== self && this.outgoing[i].includes(self));
  }

  /// Notes whose name, path or text holds every word of `query`, ignoring case; "#tag" matches that tag. Name matches first.
  search(query: string, linesPerNote = 3): Match[] {
    const ws = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!ws.length) return [];
    const byNameHits: Match[] = [];
    const byTextHits: Match[] = [];
    for (const note of this.notes) {
      const hay = note.label.toLowerCase() + '\n' + note.text.toLowerCase();
      const tags = new Set(note.tags.map((t) => t.toLowerCase()));
      const ok = ws.every((w) => {
        if (w.startsWith('#') && w.length > 1) { const t = w.slice(1); return tags.has(t) || [...tags].some((x) => x.startsWith(t + '/')); }
        return hay.includes(w);
      });
      if (!ok) continue;
      const lines: Match['lines'] = [];
      for (const [i, line] of note.text.split(/\r\n|\n|\r/).entries()) {
        const lower = line.toLowerCase();
        if (ws.some((w) => lower.includes(w))) {
          const t = line.trim();
          lines.push({ number: i + 1, text: t.length > 160 ? t.slice(0, 160) + '…' : t });
          if (lines.length >= linesPerNote) break;
        }
      }
      (ws.some((w) => note.label.toLowerCase().includes(w)) ? byNameHits : byTextHits).push({ note, lines });
    }
    return [...byNameHits, ...byTextHits];
  }
}

// ---------- saving ----------

export class Refusal extends Error {
  constructor(message: string, readonly conflict = false) { super(message); }
}

/// Why `file` may not be edited here, or null.
export function refusal(file: string, config: NotesConfig): string | null {
  if (isInside(file, path.join(config.vault, MIRROR_FOLDER))) {
    return `This is a copy in "${MIRROR_FOLDER}/": the nightly memory sync replaces it. Edit the fact in the project's memory store instead.`;
  }
  const roots = [config.memory, config.notes].filter((r): r is string => !!r);
  const root = roots.find((r) => relativeTo(file, r) !== null);
  const relative = root ? relativeTo(file, root) : null;
  if (!root || !relative) return "Only notes in this project's memory store or notes folder can be edited here.";
  if (excludes(relative, config.extra)) return 'This file is on the exclude list.';
  if (root === config.notes) {
    const inVault = relativeTo(file, config.vault);
    if (inVault && excludes(inVault, config.extra)) return 'This file is on the exclude list.';
    if (inVault?.split('/').some((p) => p.startsWith('.'))) return 'Files in hidden folders cannot be edited here.';
  }
  if (!/\.md$/i.test(file)) return 'Only markdown notes can be edited here.';
  return null;
}

/// What reading `file` needs: a markdown file of a root, not hidden, not on the exclude list.
export function readRefusal(file: string, config: NotesConfig): string | null {
  const roots = [config.memory, config.notes].filter((r): r is string => !!r);
  const relative = roots.map((r) => relativeTo(file, r)).find((r) => r !== null);
  if (!relative || relative.split('/').some((p) => p.startsWith('.')) || excludes(relative, config.extra) || !/\.md$/i.test(file)) {
    return 'That file is not one of this project\'s notes.';
  }
  return null;
}

type Fs = Pick<typeof fs, 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/// Writes to a temp file in the same folder, flushes it, then renames it over the note: the note is the old text or the
/// new text, never half of one. The mode stays. On failure the temp file goes and the note is untouched.
export function writeAtomic(file: string, text: string, ops: Fs = fs): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file */ }
  let fd: number | null = null;
  try {
    fd = ops.openSync(tmp, 'wx', mode);
    const data = Buffer.from(text, 'utf8');
    let done = 0;
    while (done < data.length) done += ops.writeSync(fd, data, done);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = null;
    // Windows refuses a rename over a file another program has open for a moment (an indexer, Obsidian).
    for (let attempt = 0; ; attempt++) {
      try { ops.renameSync(tmp, file); break; } catch (e: any) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
        pause(40 * (attempt + 1));
      }
    }
  } catch (e) {
    if (fd !== null) try { ops.closeSync(fd); } catch { /* already closed */ }
    try { ops.unlinkSync(tmp); } catch { /* never made */ }
    throw e;
  }
}

/// Writes `text` to `file`. `expected` is the text the editor started from: if the file changed on disk since,
/// nothing is written, so an edit made in Obsidian meanwhile is not lost.
export function saveNote(text: string, file: string, expected: string | null, config: NotesConfig, ops: Fs = fs): string {
  const why = refusal(file, config);
  if (why) throw new Refusal(why);
  if (Buffer.byteLength(text) > MAX_FILE_SIZE) throw new Refusal('This note is over 1 MB. The notes view hides files that big, so it is not saved. Cut it, or edit the file in another program.');
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  /// A byte order mark (Notepad, PowerShell 5.1) is not part of the text the editor shows; the file keeps it.
  const bom = current !== null && current.charCodeAt(0) === 0xfeff;
  if (bom) current = current!.slice(1);
  // The file already holds this text (a second save of the same edit): nothing to write and nothing in conflict.
  if (current === text) return 'Saved.';
  if (expected !== null && current !== expected) {
    throw new Refusal(current === null ? 'The file was moved or removed after it was opened. Your text is kept here.' : 'The file changed on disk after it was opened. Your text is kept here.', true);
  }
  writeAtomic(file, bom ? `\ufeff${text}` : text, ops);
  return 'Saved.';
}

/// Keeps `text` next to `file` under a new name, after a conflict. Never replaces a file.
export function saveCopy(text: string, file: string, config: NotesConfig): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const base = file.replace(/\.md$/i, '');
  for (let n = 0; n < 50; n++) {
    const copy = `${base} (conflict ${stamp}${n ? `-${n}` : ''}).md`;
    if (fs.existsSync(copy)) continue;
    saveNote(text, copy, null, config);
    return copy;
  }
  throw new Refusal('Could not find a free name for the copy.');
}

// ---------- the module ----------

let env: NotesEnv | null = null;

export function notesEnv(): NotesEnv {
  if (!env) throw new Error('Notes are not ready yet.');
  return env;
}

/// A server project keeps its memory on the server; this build does not read it.
export const SERVER_NOTE = 'Notes of a server project are not in this build. Open the folder on this computer to use its notes.';

export function configFor(project: ProjectInfo): NotesConfig {
  if (project.server) throw new Refusal(SERVER_NOTE);
  return loadConfig(canon(project.path), notesEnv());
}

/// The library is read again when it is older than this, so a burst of reads (a list, then a note) scans once.
const FRESH_MS = 1500;
const cache = new Map<string, { at: number; library: Promise<NoteLibrary> }>();

export function libraryFor(project: ProjectInfo): Promise<NoteLibrary> {
  const config = configFor(project);
  const key = project.id + '|' + JSON.stringify([config.memory, config.notes, config.extra]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.library;
  cache.clear();
  const library = NoteLibrary.load(config);
  cache.set(key, { at: Date.now(), library });
  return library;
}

const forget = () => cache.clear();
const asId = (v: unknown) => (typeof v === 'string' && v && v.length < 4096 ? v : null);

export const notesModule: VibexModule = {
  name: 'notes',
  tools: notesTools,
  start(host: ModuleHost) {
    env = {
      home: os.homedir(),
      claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      settingsFile: path.join(host.userData, 'notes.json'),
    };
    /// A project that closes while its note tab is open: the tab saves its last edit after the close, so the project
    /// stays known for that one write. Only ids that opened a note here are kept.
    const seen = new Map<string, ProjectInfo>();
    const projectOf = (id: unknown): ProjectInfo => {
      const project = typeof id === 'string' ? host.projects.get(id) ?? seen.get(id) : null;
      if (!project) throw new Error('That project is not open.');
      seen.set(project.id, project);
      return project;
    };
    /// Runs a handler; a refusal becomes a plain answer, anything else too, so the page never sees a stack.
    const guarded = <T>(fn: () => T | Promise<T>) => async () => {
      try { return await fn(); } catch (e: any) {
        return { ok: false, conflict: e instanceof Refusal && e.conflict, message: e instanceof Refusal ? e.message : `Could not do that: ${e?.message ?? e}` };
      }
    };

    host.handle('mod:notes:list', (projectId: unknown) => guarded(async () => {
      const project = projectOf(projectId);
      if (project.server) return { ok: true, unsupported: SERVER_NOTE, items: [] };
      const lib = await libraryFor(project);
      const c = lib.config;
      return {
        ok: true, memory: c.memory, notes: c.notes, vault: c.vault, suggested: c.suggested, capped: lib.capped,
        items: lib.notes.map((n) => ({ id: n.file, source: n.source, relativePath: n.relativePath, name: n.name, label: n.label, isIndex: n.isIndex, tags: n.tags })),
      };
    })());

    host.handle('mod:notes:search', (projectId: unknown, query: unknown) => guarded(async () => {
      const lib = await libraryFor(projectOf(projectId));
      const matches = typeof query === 'string' ? lib.search(query.slice(0, 500)) : [];
      return { ok: true, matches: matches.map((m) => ({ id: m.note.file, lines: m.lines })) };
    })());

    host.handle('mod:notes:read', (projectId: unknown, id: unknown) => guarded(async () => {
      const project = projectOf(projectId);
      const file = asId(id);
      const lib = await libraryFor(project);
      const bad = file ? readRefusal(file, lib.config) : 'No note.';
      if (bad || !file) throw new Refusal(bad ?? 'No note.');
      const known = lib.find(file);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
      const note = known && known.text === text ? known : makeNote(known?.source ?? 'memory', known?.relativePath ?? path.basename(file), file, text);
      return {
        ok: true, id: file, name: note.name, label: note.label, text, tags: note.tags, refusal: refusal(file, lib.config),
        links: note.links.map((l) => ({ ...l, id: lib.resolve(l, note)?.file ?? null })),
        backlinks: lib.backlinks(note).map((n) => ({ id: n.file, label: n.label })),
      };
    })());

    host.handle('mod:notes:save', (projectId: unknown, id: unknown, text: unknown, expected: unknown) => guarded(() => {
      const config = configFor(projectOf(projectId));
      if (!asId(id) || typeof text !== 'string' || (expected !== null && typeof expected !== 'string')) throw new Refusal('That save was not understood.');
      const message = saveNote(text, id as string, expected as string | null, config);
      forget();
      return { ok: true, message };
    })());

    host.handle('mod:notes:save-copy', (projectId: unknown, id: unknown, text: unknown) => guarded(() => {
      const config = configFor(projectOf(projectId));
      if (!asId(id) || typeof text !== 'string') throw new Refusal('That save was not understood.');
      const copy = saveCopy(text, id as string, config);
      forget();
      return { ok: true, id: copy, message: `Your text is saved as ${path.basename(copy)}.` };
    })());

    /// The page is closing: write what is unsaved now, with the same checks. No answer is read.
    host.on('mod:notes:flush', (projectId: unknown, id: unknown, text: unknown, expected: unknown) => {
      try {
        if (asId(id) && typeof text === 'string' && (expected === null || typeof expected === 'string')) {
          saveNote(text, id as string, expected as string | null, configFor(projectOf(projectId)));
          forget();
        }
      } catch { /* a conflict keeps the file as it is on disk */ }
    });

    /// A folder in the vault becomes this project's notes folder. "" means none (the suggestion is not offered again).
    const choose = (project: ProjectInfo, relative: string) => {
      const config = configFor(project);
      if (relative && !validNotesFolder(relative, config.vault, notesEnv().home, config.extra)) {
        throw new Refusal(`That folder cannot be the notes folder: pick a folder inside the vault ${config.vault}, not a hidden one, not "${MIRROR_FOLDER}", and not one on the exclude list.`);
      }
      const folder = relative ? relativeTo(validNotesFolder(relative, config.vault, notesEnv().home, config.extra)!, config.vault)! : '';
      const settings = readSettings(notesEnv().settingsFile);
      writeAtomic(notesEnv().settingsFile, JSON.stringify({ ...settings, folders: { ...settings.folders, [canon(project.path)]: folder } }, null, 2));
      forget();
      return { ok: true, folder };
    };
    host.handle('mod:notes:choose', (projectId: unknown, relative: unknown) => guarded(() => {
      if (typeof relative !== 'string') throw new Refusal('That folder was not understood.');
      return choose(projectOf(projectId), relative.trim());
    })());
    host.handle('mod:notes:pick', (projectId: unknown) => guarded(async () => {
      const project = projectOf(projectId);
      const config = configFor(project);
      const answer = await dialog.showOpenDialog({
        title: 'Notes folder', message: `Choose this project's notes folder, inside the vault ${config.vault}.`,
        defaultPath: config.notes ?? config.vault, properties: ['openDirectory'], buttonLabel: 'Use as notes folder',
      });
      if (answer.canceled || !answer.filePaths[0]) return { ok: true, folder: null };
      const relative = relativeTo(answer.filePaths[0], config.vault);
      if (!relative) throw new Refusal(`Pick a folder inside the vault ${config.vault}.`);
      return choose(project, relative);
    })());
  },
};
