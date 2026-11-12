// What auto-update decides, with no Electron in it, so it can be tested with no window. As in macOS Vibex
// (Support/Updater.swift): a check at start and every six hours, a quiet failure unless a person asked, and a running
// terminal is never cut: a person restarts, or the update installs when they quit. ./updater.ts connects it.

export type UpdateState =
  | { kind: 'off'; reason: string }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string };

export interface UpdateEngine {
  /// The newest version on the feed, or null when the feed has none.
  latest(): Promise<string | null>;
  /// Downloads it. The signal aborts when the flow gives up on a hung download, so the engine can cancel it. The engine checks its SHA-512 against the feed before it counts as downloaded.
  download(onPercent: (percent: number) => void, signal?: AbortSignal): Promise<void>;
}

/// Why this install cannot update itself, or null when it can.
export function offReason(env: { packaged: boolean; platform: string; testRun: boolean; appImage: boolean; linuxPackage: boolean; feedFile: boolean; updateKey: boolean }): string | null {
  if (env.testRun) return 'Updates are off in a test run.';
  if (!env.packaged) return 'Updates are off in a development build.';
  if (env.platform === 'darwin') return 'This build does not update itself on a Mac.';
  // The package file comes first: an APPIMAGE value can be inherited, and a package updater installs as root.
  if (env.platform === 'linux' && (env.linuxPackage || !env.appImage)) return 'A .deb install does not update itself. Install each newer .deb by hand, or use the AppImage, which updates itself.';
  if (!env.feedFile) return 'This build has no update address.';
  // An unsigned feed can run code on every PC, so with no key to check against it never installs anything.
  if (!env.updateKey) return 'This build has no update key, so it does not update itself. Install each new version by hand.';
  return null;
}

/// True only for a plainly higher version: a feed can never move a person back. A version with a suffix, or any other
/// shape, is not newer.
export function isNewer(version: string, than: string): boolean {
  const parts = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const a = parts(version);
  const b = parts(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/// Only the feed's own origin, for every request and redirect, and only over HTTPS. Only a proof build's feed on this
/// machine may use HTTP. A feed can name any file address, and a redirect can go anywhere, so the build's address decides.
export function feedAllows(feed: string, url: string, proofBuild: boolean): boolean {
  try {
    const f = new URL(feed);
    const u = new URL(url);
    const local = proofBuild && f.protocol === 'http:' && f.hostname === '127.0.0.1';
    return (f.protocol === 'https:' || local) && u.protocol === f.protocol && u.host === f.host;
  } catch {
    return false;
  }
}

/// The address in app-update.yml, or null.
export function feedOf(appUpdateYml: string): string | null {
  return /^url:\s*['"]?([^'"\s]+)/m.exec(appUpdateYml)?.[1] ?? null;
}

export function stateText(state: UpdateState, version: string): string {
  if (state.kind === 'off') return state.reason;
  if (state.kind === 'checking') return 'Checking for updates…';
  if (state.kind === 'upToDate') return `Version ${version} is the newest.`;
  if (state.kind === 'downloading') return `Downloading version ${state.version}: ${state.percent}%.`;
  if (state.kind === 'ready') return `Version ${state.version} is ready. It installs when you quit, or restart now.`;
  if (state.kind === 'failed') return state.message;
  return `Version ${version}. Updates install by themselves.`;
}

export interface UpdateTimeouts { latestMs: number; downloadMs: number }
export const DEFAULT_TIMEOUTS: UpdateTimeouts = { latestMs: 60_000, downloadMs: 30 * 60_000 };

const STOPPED_ANSWERING = 'The update stopped answering. Use Check for Updates to try again.';

class UpdateTimeout extends Error {
  constructor() { super(STOPPED_ANSWERING); this.name = 'UpdateTimeout'; }
}

/// The promise, or a rejection when it has not answered in time. The late answer of a hung engine is dropped.
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateTimeout()), ms);
    timer.unref?.();
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export class UpdateFlow {
  state: UpdateState;
  private running: Promise<void> | null = null;
  private asked = false;
  /// Rule from the Swift updater: a failed or hung update is not offered again in the background. Only a
  /// person's own check starts it again.
  private heldForPerson = false;
  private round = 0;

  constructor(private engine: UpdateEngine, private current: string, private changed: (state: UpdateState) => void, off: string | null = null, private timeouts: UpdateTimeouts = DEFAULT_TIMEOUTS) {
    this.state = off ? { kind: 'off', reason: off } : { kind: 'idle' };
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.changed(state);
  }

  /// One check at a time. A person's check waits for the one that runs, and then says how it went.
  check(byPerson: boolean): Promise<void> {
    if (this.state.kind === 'off' || this.state.kind === 'ready') return Promise.resolve();
    // A held update does not ask the engine on the timer. A person's check clears the hold and runs.
    if (!byPerson && this.heldForPerson) return Promise.resolve();
    if (byPerson) this.heldForPerson = false;
    // A person who joins a timed check still gets its answer.
    this.asked ||= byPerson;
    if (byPerson && this.state.kind !== 'downloading') this.set({ kind: 'checking' });
    this.running ??= this.run().finally(() => { this.running = null; this.asked = false; });
    return this.running;
  }

  /// The install at Restart failed: the download stays, and the person hears why.
  installFailed(): void {
    this.heldForPerson = true;
    // A timed check that still runs must not write over this message when it ends.
    this.round++;
    this.set({ kind: 'failed', message: 'The update could not install. Check that you can write to the folder that holds the app, then try again.' });
  }

  private async run(): Promise<void> {
    const round = ++this.round;
    try {
      const latest = await within(this.engine.latest(), this.timeouts.latestMs);
      if (round !== this.round) return;
      if (!latest || !isNewer(latest, this.current)) {
        this.set(this.asked ? { kind: 'upToDate' } : { kind: 'idle' });
        return;
      }
      this.set({ kind: 'downloading', version: latest, percent: 0 });
      // A hung download that wakes up after its timeout must not move the state again.
      // The library hands a second download call the first, hung one, so a timeout cancels it: a person's retry starts fresh.
      const abort = new AbortController();
      try {
        await within(this.engine.download((percent) => { if (round === this.round) this.set({ kind: 'downloading', version: latest, percent: Math.round(percent) }); }, abort.signal), this.timeouts.downloadMs);
      } catch (error) {
        if (error instanceof UpdateTimeout) abort.abort();
        throw error;
      }
      if (round !== this.round) return;
      this.set({ kind: 'ready', version: latest });
    } catch (error) {
      if (round !== this.round) return;
      // A person offline at start must not get an alarm; the next check tries again. A refused feed always shows: nobody
      // asked, and yet someone may be attacking the feed.
      const refused = error instanceof Error && error.name === 'FeedRefused';
      // What holds the update for a person: a hang (no one can tell what state it is in) and an install that failed.
      // What does not: an offline timed check (not a failed update; the next timer asks again), a refused feed (always
      // shown, and a person's check clears it), and an error a person already heard about (a bad checksum or no network
      // while they asked): their next timed retry only downloads again and offers nothing until it is ready.
      if (error instanceof UpdateTimeout) {
        // Shown even when nobody asked (a blackholed network): the brief wants a hung update to be seen. Raising the round
        // makes a late progress event from the hung engine harmless.
        this.round++;
        this.heldForPerson = true;
        this.set({ kind: 'failed', message: STOPPED_ANSWERING });
        return;
      }
      this.set(this.asked || refused ? { kind: 'failed', message: plainUpdateError(error) } : { kind: 'idle' });
    }
  }
}

export function plainUpdateError(error: unknown): string {
  if (error instanceof Error && error.name === 'FeedRefused') return error.message;
  const text = String(error);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME_NOT|ERR_CONNECTION/.test(text)) return 'The update server did not answer. Check the connection, then try again.';
  if (/sha512|checksum/i.test(text)) return 'The downloaded update failed its check, so it was not installed.';
  return 'The update did not work. Try again later.';
}

interface Events { on(event: string, listener: (...args: any[]) => void): unknown; once(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown }

/// How long a failed start holds back the quit that the library has already asked for.
const HOLD_QUIT_MS = 2000;

/// Starts the install. The library starts the installer later than this call returns and quits on the next turn, so a failed
/// start comes after the call, and just before that quit. Then the person gets the line, and the app stays.
export function watchInstall(updater: Events, app: Events, install: () => void, failed: () => void): void {
  const stop = () => {
    updater.off('error', failure);
    app.off('before-quit', stop);
  };
  const failure = () => {
    stop();
    const hold = (event: { preventDefault(): void }) => event.preventDefault();
    app.once('before-quit', hold);
    setTimeout(() => app.off('before-quit', hold), HOLD_QUIT_MS).unref?.();
    failed();
  };
  updater.once('error', failure);
  app.once('before-quit', stop);
  install();
}
