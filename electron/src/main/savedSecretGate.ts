import { execFile } from 'node:child_process';
import path from 'node:path';
import { endsWithApp, runnable } from './programs';
import type { SecretKind } from './serverSecrets';
import type { ServerProfile } from './servers';
import { switchesAllowed, type BuildKind } from './testSwitches';

// The gate in front of every saved server secret (fork: Servers/SavedSecretGate.swift, PR #51). Nothing reads a saved
// password or key passphrase until the person at this PC confirms it is them: Windows Hello on Windows. Linux and every
// other system cannot confirm, so there the person types the secret.
//
// Rules: one prompt per request, never shared and never cached, so a yes for one request never releases another. No answer
// by the limit (40 s) is a refusal, and the prompt is aborted. Only an exact 'ok' opens. An error is a refusal.
//
// What it adds: a process of this user that gets ssh to ask (askpass.ts) now also needs the person's confirmation, so it
// cannot take a saved secret silently. What it does not do: it proves presence, not who asked. Such a process can ask
// while the person connects, and take that one yes. The saved file itself does not change: Windows does not enforce this.

export type Presence = 'ok' | 'no' | 'unavailable';

/// Proves that the person at the keyboard is the owner of this PC. `signal` aborts the prompt (limit, or the ssh ended).
export interface Authenticator {
  confirm(reason: string, signal: AbortSignal): Promise<Presence>;
  /// False when it is known, before any call, that this PC cannot confirm (Linux, a missing helper).
  canAsk?: () => boolean;
}

/// The options of an ssh nobody watches (a port listing or a detected forward). It gets one password try only when a saved
/// secret exists and this PC can confirm it; else BatchMode, so a refusal or a gate that cannot ask never makes ssh send an
/// empty password, which a server can count toward a locked account.
export const quietLoginOptions = (saved: boolean, mayConfirm: boolean): string[] =>
  (saved && mayConfirm ? ['-o', 'NumberOfPasswordPrompts=1'] : ['-o', 'BatchMode=yes']);

/// A request nobody answers ends before the login that waits for it (as the fork's ServerGate.limit).
export const PRESENCE_LIMIT_MS = 40_000;

export interface GateClock {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realClock: GateClock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class SavedSecretGate {
  /// The last answer was 'unavailable' (no Windows Hello): only for the options of quiet logins, never to release a secret.
  private lastUnavailable = false;

  constructor(private readonly authenticator: Authenticator, private readonly limitMs: number = PRESENCE_LIMIT_MS, private readonly clock: GateClock = realClock) {}

  /// One prompt for one request. 'ok' only when the authenticator said exactly 'ok' in time; 'unavailable' when it said this
  /// PC cannot confirm; else 'no'. `ended`: the ssh that asked is gone, so the prompt goes away too.
  /// Whether a prompt can confirm on this PC, as far as is known now.
  mayConfirm(): boolean {
    return this.authenticator.canAsk?.() !== false && !this.lastUnavailable;
  }

  confirm(reason: string, ended?: AbortSignal): Promise<Presence> {
    const prompt = new AbortController();
    return new Promise<Presence>((resolve) => {
      let done = false;
      let timer: unknown = undefined;
      const onEnded = () => finish('no', true);
      const finish = (answer: Presence, abort: boolean) => {
        if (done) return;
        done = true;
        if (timer !== undefined) this.clock.clear(timer);
        ended?.removeEventListener('abort', onEnded);
        if (abort) prompt.abort();
        if (answer === 'unavailable') this.lastUnavailable = true;
        else if (answer === 'ok') this.lastUnavailable = false;
        resolve(answer);
      };
      if (ended?.aborted) return finish('no', true);
      ended?.addEventListener('abort', onEnded, { once: true });
      timer = this.clock.set(() => finish('no', true), this.limitMs);
      let pending: Promise<Presence>;
      try {
        pending = Promise.resolve(this.authenticator.confirm(reason, prompt.signal));
      } catch {
        return finish('no', true);
      }
      pending.then(
        (answer) => finish(answer === 'ok' ? 'ok' : answer === 'unavailable' ? 'unavailable' : 'no', false),
        () => finish('no', true),
      );
    });
  }
}

/// What the prompt says. A name can hold line breaks, direction marks or great length.
export function presenceReason(profile: ServerProfile, kind: SecretKind): string {
  const clean = (text: string, count: number) => [...String(text ?? '')].filter((c) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"]/u.test(c)).slice(0, count).join('');
  const what = kind === 'password' ? 'password' : 'key passphrase';
  return `Vibex PCA wants to use the saved ${what} of ${clean(profile.name, 40)} (${clean(profile.user, 32)}@${clean(profile.host, 64)}).`;
}

/// This PC cannot confirm: Linux, macOS in this edition, and a Windows build with no helper.
export const noPresence: Authenticator = { confirm: async () => 'unavailable', canAsk: () => false };

/// A test stand-in. 'hang' never answers until the prompt is aborted.
export function fakePresence(value: string): Authenticator {
  return {
    canAsk: () => value === 'ok' || value === 'no' || value === 'hang',
    confirm: (_reason, signal) => {
      if (value === 'ok' || value === 'no' || value === 'unavailable') return Promise.resolve(value);
      if (value !== 'hang') return Promise.resolve('unavailable');
      return new Promise((resolve) => {
        if (signal.aborted) return resolve('no');
        signal.addEventListener('abort', () => resolve('no'), { once: true });
      });
    },
  };
}

/// The authenticator of this build. A release build never takes the fake, whatever it is given (testSwitches.ts).
export function presenceAuthenticator(o: { kind: BuildKind; fake: string | undefined; platform: NodeJS.Platform; windows: () => Authenticator }): Authenticator {
  if (switchesAllowed(o.kind) && o.fake !== undefined) return fakePresence(o.fake);
  if (o.platform === 'win32') return o.windows();
  return noPresence;
}

const WINDOWS_HELPER = 'vibex-presence.exe';

/// The Windows Hello helper: in the resources of a package, in its build folder in a source run.
export const presenceHelperPath = (packaged: boolean, resourcesPath: string, appPath: string) =>
  (packaged ? path.win32.join(resourcesPath, WINDOWS_HELPER) : path.win32.join(appPath, 'native', 'presence-win', 'build', WINDOWS_HELPER));

/// The window handle from BrowserWindow.getNativeWindowHandle, as the decimal number the helper reads. null: no window.
export function hwndText(handle: Buffer | null | undefined): string | null {
  if (!handle) return null;
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.length >= 4 ? BigInt(handle.readUInt32LE(0)) : 0n;
  return value === 0n ? null : value.toString();
}

/// Windows Hello through the native helper (native/presence-win): the app window's handle and the reason as its two
/// arguments, its answer on stdout. Any other output, any exit code but 0, a missing helper or no window: 'unavailable', so
/// the person types the secret. On abort the app closes the helper's stdin: the helper then cancels its Windows Hello prompt
/// and exits. A kill alone would leave the prompt on screen. After a grace it is killed anyway.
export const HELPER_GRACE_MS = 1_000;

export function windowsPresence(o: { helper: string; window: () => string | null; graceMs?: number }): Authenticator {
  return {
    canAsk: () => runnable(o.helper),
    confirm: (reason, signal) => new Promise<Presence>((resolve) => {
      const hwnd = o.window();
      if (!hwnd || !/^[0-9]+$/.test(hwnd) || !runnable(o.helper)) return resolve('unavailable');
      if (signal.aborted) return resolve('no');
      let child: ReturnType<typeof execFile> | null = null;
      let grace: NodeJS.Timeout | null = null;
      const onAbort = () => {
        resolve('no');
        const running = child;
        if (!running) return;
        running.stdin?.end();
        grace = setTimeout(() => running.kill(), o.graceMs ?? HELPER_GRACE_MS);
        running.once('exit', () => { if (grace) clearTimeout(grace); });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        child = endsWithApp(execFile(o.helper, [hwnd, reason], { windowsHide: true, maxBuffer: 256, encoding: 'utf8' }, (error, stdout) => {
          signal.removeEventListener('abort', onAbort);
          if (error) return resolve('unavailable');
          const answer = String(stdout).trim();
          resolve(answer === 'ok' ? 'ok' : answer === 'no' ? 'no' : 'unavailable');
        }));
      } catch {
        signal.removeEventListener('abort', onAbort);
        resolve('unavailable');
      }
    }),
  };
}
