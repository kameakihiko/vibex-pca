import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runGit } from './git';

// The project's files for the Files section. Ported from Vibex/Explorer: a tree opened folder by folder, git's
// ignore rules shown dimmed, a text file opened read only. Every path comes from the page, so it is checked here.

/// Never worth showing.
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']);
/// A text file bigger than this is not opened; the page would stall.
export const READ_LIMIT = 1_000_000;

export interface Entry { name: string; dir: boolean; ignored: boolean }
export type Read =
  | { kind: 'text'; text: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'big'; size: number }
  | { kind: 'error'; message: string };

const outside = () => new Error('That path is outside the project.');
const leaves = (back: string) => back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back);

/// The absolute path of `rel` inside `root`; "" is the root itself.
export function safePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw outside();
  const joined = path.resolve(root, rel);
  if (leaves(path.relative(root, joined))) throw outside();
  return joined;
}

/// A link inside the project may point out of it; the real path must stay inside.
async function inside(root: string, abs: string): Promise<string> {
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(abs)]);
  if (leaves(path.relative(realRoot, real))) throw outside();
  return real;
}

/// Which of these names, in `folder`, git ignores. Nothing is ignored when the folder is not a repository.
async function ignoredNames(folder: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  try {
    const r = await runGit(folder, ['check-ignore', '-z', '--stdin'], { input: names.join('\0') + '\0', plain: true });
    return r.code === 0 ? new Set(r.out.split('\0').filter(Boolean)) : new Set();
  } catch {
    return new Set();
  }
}

export async function listFolder(root: string, rel: string): Promise<{ entries: Entry[] }> {
  const real = await inside(root, safePath(root, rel));
  const found = (await fs.readdir(real, { withFileTypes: true })).filter((d) => !HIDDEN.has(d.name));
  const entries = await Promise.all(
    found.map(async (d) => ({
      name: d.name,
      // A link to a folder opens like a folder.
      dir: d.isSymbolicLink() ? await fs.stat(path.join(real, d.name)).then((s) => s.isDirectory(), () => false) : d.isDirectory(),
    })),
  );
  const ignored = await ignoredNames(real, entries.map((e) => e.name));
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  return { entries: entries.map((e) => ({ ...e, ignored: ignored.has(e.name) })) };
}

const looksBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

export async function readFile(root: string, rel: string): Promise<Read> {
  const abs = safePath(root, rel);
  let real: string;
  try {
    real = await inside(root, abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'error', message: 'This file is gone.' };
    throw e;
  }
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { kind: 'error', message: 'This is not a file.' };
    if (stat.size > READ_LIMIT) return { kind: 'big', size: stat.size };
    const data = await fs.readFile(real);
    if (looksBinary(data)) return { kind: 'binary', size: stat.size };
    return { kind: 'text', text: data.toString('utf8'), size: stat.size };
  } catch {
    return { kind: 'error', message: 'This file cannot be read.' };
  }
}

/// A folder's change time moves when a file appears or goes. The page asks for the stamps of the folders on
/// screen every few seconds; there is no watcher to leak or to run hot on a big tree.
export async function folderStamps(root: string, rels: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const rel of rels.slice(0, 500)) {
    result[rel] = await fs.stat(safePath(root, rel)).then((s) => (s.isDirectory() ? String(s.mtimeMs) : null), () => null);
  }
  return result;
}
