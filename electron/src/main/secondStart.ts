import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A second start while another copy holds the lock. Electron passes data to the first copy and gives nothing back, so the first
// answers with a small file in the shared profile folder. No answer in the time means a copy that is stuck, or that stayed after its quit.

/// How long a second start waits for the answer. A first copy that is still starting answers too.
export const SECOND_START_MS = 5000;
const POLL_MS = 100;
const START_KEY = /^[0-9a-f]{32}$/;
const PID_FILE = 'main-process.pid';

export const newStartKey = () => randomBytes(16).toString('hex');
const answerFile = (folder: string, key: string) => path.join(folder, `second-start-${key}.answer`);

/// In the first copy. It answers only while it can still show a window. What comes in is from another process: only the exact shape
/// makes a file name.
export function answerSecondStart(folder: string, data: unknown, quitting: boolean): boolean {
  const key = (data as { vibexStart?: unknown } | null | undefined)?.vibexStart;
  if (quitting || typeof key !== 'string' || !START_KEY.test(key)) return false;
  try {
    writeFileSync(answerFile(folder, key), '');
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/// In the second copy. Takes the answer away with it.
export async function firstAnswered(folder: string, key: string, ms: number): Promise<boolean> {
  const file = answerFile(folder, key);
  const end = Date.now() + ms;
  for (;;) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      return true;
    }
    if (Date.now() >= end) return false;
    await pause(POLL_MS);
  }
}

/// The holder of the lock notes its process, so that a second start can end that one and no other.
export function noteHolder(folder: string, pid: number = process.pid): void {
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, PID_FILE), String(pid));
  } catch { /* with no note, the box offers only a restart */ }
}

export function holderPid(folder: string): number | null {
  try {
    const text = readFileSync(path.join(folder, PID_FILE), 'utf8').trim();
    const pid = Number(text);
    return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/// The person chose this in the box. The lock is held, so the noted process is the holder: it noted itself after it took the lock.
export function endHolder(folder: string, own: number = process.pid, kill: (pid: number) => void = (pid) => { process.kill(pid); }): boolean {
  const pid = holderPid(folder);
  if (pid === null || pid === own) return false;
  try {
    kill(pid);
    return true;
  } catch {
    return false;
  }
}

/// True when the noted process has left, so that a new start can take the lock.
export async function holderGone(folder: string, ms = 5000): Promise<boolean> {
  const pid = holderPid(folder);
  if (pid === null) return false;
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= end) return false;
    await pause(POLL_MS);
  }
}
