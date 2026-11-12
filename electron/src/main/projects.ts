import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkServerFolder } from './servers';

export interface ProjectInfo {
  /// Stable hash of the folder; also VIBEX_WINDOW in the project's tabs and the X-Vibex-Window header.
  id: string;
  name: string;
  /// The folder. On a server project it is a path on that server ("~/app"), never one on this computer.
  path: string;
  /// The saved server the folder is on; absent for a local project.
  server?: string;
  monogram: string;
  /// Which of the rail's 6 colours this project has, the same every launch.
  tint: number;
}

const RECENTS_LIMIT = 8;
/// What the file may bring back: enough for the recents after a few are gone, and no more stat calls than this.
const RECENTS_KEPT = 32;

/// Two capital letters for the rail tile: the first letters of the first two words ("north-wind" gives "NW"),
/// else the first two letters ("vibex" gives "VI"). As in macOS Vibex (ProjectRailEntry).
export function monogram(name: string): string {
  const words = name.split(/[-_. ]/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const letters = (words[0] ?? name).slice(0, 2);
  return letters ? letters.toUpperCase() : '?';
}

export function tintIndex(id: string): number {
  let seed = 0;
  for (const c of id) seed = (seed * 31 + c.codePointAt(0)!) & 0xffff;
  return seed % 6;
}

/// Windows folder names differ only by case in the path a person types, so the id ignores case there.
export function projectId(folder: string): string {
  const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function isFolder(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function describe(folder: string): ProjectInfo {
  const id = projectId(folder);
  const name = path.basename(folder) || folder;
  return { id, name, path: folder, monogram: monogram(name), tint: tintIndex(id) };
}

function describeServer(server: string, folder: string): ProjectInfo {
  // Not projectId: paths on the server are case sensitive, also when this computer runs Windows.
  const id = createHash('sha256').update(`ssh|${server}|${folder}`).digest('hex').slice(0, 16);
  const name = folder === '~' || folder === '/' ? server : path.posix.basename(folder);
  return { id, name, path: folder, server, monogram: monogram(name), tint: tintIndex(id) };
}

/// A saved project or recent folder: a local path, or a folder on a saved server.
type Saved = string | { server: string; path: string };

const savedOf = (p: ProjectInfo): Saved => (p.server ? { server: p.server, path: p.path } : p.path);
const sameSaved = (a: Saved, b: Saved) => JSON.stringify(a) === JSON.stringify(b);

/// The open projects in opening order, the one on screen, and the recent folders. Saved to one JSON file after
/// each change. Knows nothing about windows or tabs, so it can be tested without Electron.
export class Projects {
  private open_: ProjectInfo[] = [];
  private currentId: string | null = null;
  private recentEntries: Saved[] = [];
  /// Saved projects on a server that is not in servers.json now. One typo in that file must not lose them for good,
  /// so they stay in the saved list and come back when the server does.
  private parked: Saved[] = [];
  /// The ids of every entry the saved file named at start (open, held back, recent), also folders missing then.
  /// Worked out once at load: a path on a drive that is gone must not hold the main process at each switch.
  private knownAtStart: string[] = [];

  /// `knownServer` tells which saved servers exist: a project on any other server does not come back at a start.
  constructor(private readonly file: string, private readonly knownServer: (name: string) => boolean = () => false) {
    this.load();
  }

  list(): ProjectInfo[] {
    return [...this.open_];
  }

  current(): ProjectInfo | null {
    return this.open_.find((p) => p.id === this.currentId) ?? null;
  }

  get(id: string): ProjectInfo | null {
    return this.open_.find((p) => p.id === id) ?? null;
  }

  /// The ids of every project this computer knew before: open, held back, recent, or named at start. The chat layout
  /// (renderer/chatFirst.ts) keeps the three columns of each of them at its first start.
  knownIds(): string[] {
    return [...new Set([...this.open_.map((p) => p.id), ...this.knownAtStart])];
  }

  /// Recent folders that still exist and are not open, the latest first.
  recents(): { name: string; path: string; server?: string }[] {
    const out: { name: string; path: string; server?: string }[] = [];
    for (const entry of this.recentEntries) {
      if (out.length === RECENTS_LIMIT) break;
      if (this.open_.some((o) => sameSaved(savedOf(o), entry))) continue;
      if (typeof entry === 'string') {
        if (isFolder(entry)) out.push({ name: path.basename(entry) || entry, path: entry });
      } else if (this.knownServer(entry.server)) {
        out.push({ name: describeServer(entry.server, entry.path).name, path: entry.path, server: entry.server });
      }
    }
    return out;
  }

  /// Opens a folder, or selects it if it is already open. It ends up on screen, unless `background` is set and
  /// another project is on screen.
  open(folder: string, background = false): ProjectInfo {
    let real: string;
    try {
      real = realpathSync.native(folder);
    } catch {
      this.forgetGone(folder);
      throw new Error(`not a folder: ${folder}`);
    }
    if (!isFolder(real)) {
      this.forgetGone(folder);
      throw new Error(`not a folder: ${folder}`);
    }
    return this.add(describe(real), background);
  }

  /// Opens a folder on a saved server, or selects it if it is already open. Nothing connects here; the tabs do.
  openServer(server: string, folder: string): ProjectInfo {
    const problem = checkServerFolder(folder);
    if (problem) throw new Error(problem);
    return this.add(describeServer(server, folder.replace(/\/+$/, '') || '/'));
  }

  private add(info: ProjectInfo, background = false): ProjectInfo {
    const existing = this.get(info.id);
    if (!existing) this.open_.push(info);
    if (!background || !this.currentId) this.currentId = info.id;
    this.remember(savedOf(info));
    this.save();
    return existing ?? info;
  }

  select(id: string): ProjectInfo | null {
    const found = this.get(id);
    if (!found) return null;
    this.currentId = id;
    this.save();
    return found;
  }

  /// The next or previous project in the rail's order, going round. It becomes the one on screen.
  adjacent(step: number): ProjectInfo | null {
    if (!this.open_.length) return null;
    const at = this.open_.findIndex((p) => p.id === this.currentId);
    const next = this.open_[(at + step + this.open_.length) % this.open_.length];
    this.currentId = next.id;
    this.save();
    return next;
  }

  /// Removes a project from the list. If it was on screen, the next one takes its place, else the one before.
  close(id: string): void {
    const at = this.open_.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.remember(savedOf(this.open_[at]));
    const gone = this.open_[at];
    // A server project that was parked and opened must not come back at the next start after it was closed.
    this.parked = this.parked.filter((e) => !sameSaved(e, savedOf(gone)));
    this.open_.splice(at, 1);
    if (this.currentId === id) this.currentId = (this.open_[at] ?? this.open_[at - 1])?.id ?? null;
    this.save();
  }

  /// Which project a tool call is for: project_path, then the X-Vibex-Window header of the session. With neither,
  /// the call is refused and nothing acts, even with one project open: the caller can be a Claude in any other
  /// folder of this computer, and this app cannot tell, so acting would write into the wrong project.
  route(windowHeader: string | undefined, projectPath: string | undefined): ProjectInfo {
    if (projectPath !== undefined) {
      if (!path.isAbsolute(projectPath)) throw new Error(`project_path must be an absolute folder; nothing acted: ${projectPath}`);
      let real: string | null = null;
      try {
        real = realpathSync.native(projectPath);
      } catch {
        // Not a folder, so no open project has it.
      }
      const named = real ? this.get(projectId(real)) : null;
      if (!named) throw new Error(`project_path must name an open project's absolute folder; nothing acted: ${projectPath}`);
      return named;
    }
    if (windowHeader) {
      const named = this.get(windowHeader);
      if (!named) throw new Error('this session belongs to a project that is not open; open it, or pass project_path; nothing acted');
      return named;
    }
    if (!this.open_.length) throw new Error('no project is open; open one first with vibex_open_project');
    throw new Error('this call does not say which project it is for; pass project_path with the absolute folder of an open project (vibex_projects lists them); nothing acted');
  }

  /// A person clicked a recent folder that has gone. An entry only hidden may come back with its drive; this one was tried.
  private forgetGone(folder: string): void {
    const before = this.recentEntries.length;
    this.recentEntries = this.recentEntries.filter((entry) => entry !== folder);
    if (this.recentEntries.length !== before) this.save();
  }

  private remember(entry: Saved): void {
    this.recentEntries = [entry, ...this.recentEntries.filter((p) => !sameSaved(p, entry))].slice(0, RECENTS_LIMIT + 1);
  }

  private load(): void {
    let saved: any;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // No list yet, or a damaged one: start empty.
    }
    if (!saved || typeof saved !== 'object') return;
    const entries = (v: unknown): Saved[] => (Array.isArray(v) ? v : []).flatMap((x): Saved[] => {
      if (typeof x === 'string') return path.isAbsolute(x) ? [x] : [];
      // The file is plain JSON a person can edit, and the path goes into a remote command: same check as a typed one.
      if (x && typeof x.server === 'string' && typeof x.path === 'string' && !checkServerFolder(x.path)) return [{ server: x.server, path: x.path }];
      return [];
    });
    this.recentEntries = entries(saved.recents).slice(0, RECENTS_KEPT);
    const known = new Set<string>();
    for (const entry of [...entries(saved.open), ...this.recentEntries]) {
      if (typeof entry !== 'string') {
        known.add(describeServer(entry.server, entry.path).id);
        continue;
      }
      known.add(projectId(entry));
      try {
        known.add(projectId(realpathSync.native(entry)));
      } catch { /* a folder that is gone keeps the id of its saved path */ }
    }
    this.knownAtStart = [...known];
    for (const entry of entries(saved.open)) {
      let info: ProjectInfo;
      if (typeof entry === 'string') {
        if (!isFolder(entry)) continue;
        try {
          info = describe(realpathSync.native(entry));
        } catch {
          continue; // Some drives answer stat but not realpath; one such folder must not stop the app.
        }
      } else {
        if (!this.knownServer(entry.server)) {
          this.parked.push(entry);
          continue;
        }
        info = describeServer(entry.server, entry.path);
      }
      if (!this.get(info.id)) this.open_.push(info);
    }
    const front = typeof saved.front === 'string' ? this.get(saved.front) : null;
    this.currentId = (front ?? this.open_[0])?.id ?? null;
  }

  /// Never throws: the person's selection is real even if the disk says no. On Windows, an antivirus or the indexer
  /// often holds the file for a moment, so the rename gets a second try. A lost save costs only the next restore.
  private save(): void {
    const temp = `${this.file}.tmp`;
    const data = JSON.stringify({ open: [...this.open_.map(savedOf), ...this.parked], front: this.currentId, recents: this.recentEntries }, null, 2);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temp, data);
      try {
        renameSync(temp, this.file);
      } catch {
        renameSync(temp, this.file);
      }
    } catch (error) {
      console.error(`Vibex PCA: could not save the project list: ${String(error)}`);
    }
  }
}
