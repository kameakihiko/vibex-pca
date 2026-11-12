import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

// git, ssh and the like by an absolute path. Windows looks in the current folder before PATH for a bare name, and the
// current folder of a git run is a project that may come from anyone (security review H3). So the app reads PATH itself.

interface Lookup { platform: NodeJS.Platform; pathValue: string; isFile: (file: string) => boolean }

export const runnable = (file: string) => {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const lookups = new Set<ChildProcess>();

/// A short question to a program (ssh -V, ssh -G, claude mcp). Its limit is a timer of this process, so without this a hung
/// one lives on after a quit.
export function endsWithApp<T extends ChildProcess>(child: T): T {
  lookups.add(child);
  child.once('close', () => lookups.delete(child));
  return child;
}

export function endLookups(): void {
  for (const child of lookups) child.kill();
}

/// The first `name` in an absolute PATH folder. On Windows only name.exe: a .cmd needs cmd.exe, which parses its arguments.
export function findProgram(name: string, o: Lookup = { platform: process.platform, pathValue: process.env.PATH ?? '', isFile: runnable }): string | null {
  const windows = o.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  for (const raw of o.pathValue.split(paths.delimiter)) {
    const dir = windows ? raw.replace(/^"|"$/g, '') : raw;
    if (!(windows ? /^([a-zA-Z]:[\\/]|\\\\)/.test(dir) : paths.isAbsolute(dir))) continue;
    const file = paths.join(dir, windows ? `${name}.exe` : name);
    if (o.isFile(file)) return file;
  }
  return null;
}

/// A path to run. A missing program is an error and starts nothing: a bare name could still find a file in the current
/// folder, and any made-up path is a path someone could create (a normal user can make a folder in C:\\, review N12).
export function programPath(name: string): string {
  const found = findProgram(name);
  if (!found) throw Object.assign(new Error(`${name} was not found on this computer.`), { code: 'ENOENT' });
  return found;
}
