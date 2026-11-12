import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A running app keeps the PATH of the moment it started. An installer changes the registry, so Setup and each new tab read
// the registry: Git, ssh and Claude installed while the app runs work with no restart. Windows only.
// `reg export` and not `reg query`: the query prints in the OEM code page, which turns a Cyrillic folder into question
// marks, and the export file is UTF-16.

export type Hive = 'machine' | 'user';

const KEYS: Record<Hive, string> = {
  machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  user: 'HKCU\\Environment',
};

/// The text of the Path value in a `.reg` export: REG_EXPAND_SZ as hex(2) (UTF-16 bytes, over several lines), or REG_SZ as a string.
export function parseRegExport(text: string): string | null {
  const found = /^"Path"=((?:.*\\\r?\n)*.*)/im.exec(text);
  if (!found) return null;
  const value = found[1].replace(/\\\r?\n\s*/g, '').trim();
  if (value.startsWith('"')) return value.slice(1, value.lastIndexOf('"')).replace(/\\(["\\])/g, '$1');
  const hex = /^hex\(2\):(.*)$/i.exec(value);
  if (!hex) return null;
  const bytes = Buffer.from(hex[1].split(',').filter(Boolean).map((b) => parseInt(b, 16)));
  return bytes.toString('utf16le').replace(/\0+$/, '');
}

/// `%name%` as Windows expands it: any letter case, and an unknown name stays as it is.
export function expandEnvText(value: string, env: Record<string, string | undefined>): string {
  const names = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => names.get(name.toLowerCase()) ?? whole);
}

const absolute = (dir: string) => /^([a-zA-Z]:[\\/]|\\\\)/.test(dir.replace(/^"/, ''));

/// As a new login has it: machine, then user. What this app's own PATH adds stays behind them. No relative folder: Windows
/// would look for a program in whatever folder is current.
export function mergePath(machine: string, user: string, current: string): string {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const dir of `${machine};${user};${current}`.split(';')) {
    const key = dir.replace(/[\\/]+$/, '').toLowerCase();
    if (!dir || !absolute(dir) || seen.has(key)) continue;
    seen.add(key);
    list.push(dir);
  }
  return list.join(';');
}

function exportHive(hive: Hive, env: Record<string, string | undefined>): string | null {
  const file = path.join(os.tmpdir(), `vibex-path-${randomBytes(8).toString('hex')}.reg`);
  try {
    // By its full path: the current folder of the app must not give another reg.exe.
    const reg = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFileSync(reg, ['export', KEYS[hive], file, '/y'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    return readFileSync(file).toString('utf16le');
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

interface Source {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /// The export of one hive, or null when it cannot be read.
  read: (hive: Hive) => string | null;
}

/// One new tab reads it twice (its launch, then its start), and two tabs start together: the second read is the same.
const FRESH_MS = 1000;
let readAt = 0;

/// Sets this process's PATH from the registry, so a new tab and each program lookup see it. A registry that cannot be read
/// (a company policy can forbid reg.exe) leaves it as it is.
export function refreshWindowsPath(given?: Source): void {
  const source = given ?? { platform: process.platform, env: process.env, read: (hive: Hive) => exportHive(hive, process.env) };
  if (source.platform !== 'win32') return;
  if (!given) {
    if (Date.now() - readAt < FRESH_MS) return;
    readAt = Date.now();
  }
  const machineText = source.read('machine');
  const userText = source.read('user');
  if (machineText === null && userText === null) return;
  const value = (text: string | null) => expandEnvText((text === null ? null : parseRegExport(text)) ?? '', source.env);
  source.env.PATH = mergePath(value(machineText), value(userText), source.env.PATH ?? '');
}
