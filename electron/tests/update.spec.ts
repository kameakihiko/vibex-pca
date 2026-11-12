import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { feedAllows, feedOf, isNewer, offReason, plainUpdateError, stateText, UpdateFlow, type UpdateEngine, type UpdateState } from '../src/main/updateFlow';

// No app window: what auto-update decides, and what the build promises about its feed.

function setup(engine: Partial<UpdateEngine>, current = '1.2.3') {
  const seen: UpdateState[] = [];
  const full: UpdateEngine = { latest: async () => null, download: async () => undefined, ...engine };
  // Tiny timeouts, so a hung engine ends at once; the real defaults are 60 s and 30 min.
  return { seen, flow: new UpdateFlow(full, current, (s) => seen.push(s), null, { latestMs: 30, downloadMs: 30 }) };
}

test.describe('auto-update', () => {
  test('only a plainly higher version counts, so a feed cannot move a person back', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    for (const [a, b] of [['1.2.3', '1.2.3'], ['1.2.2', '1.2.3'], ['0.9.9', '1.0.0'], ['1.2.4-beta', '1.2.3'], ['1.3', '1.2.3'], ['latest', '1.2.3'], ['1.2.4', 'x']]) expect(isNewer(a, b), `${a} ${b}`).toBe(false);
  });

  test('it is off in a test run, a development build, on a Mac, for a .deb, and with no feed', () => {
    const can = { packaged: true, platform: 'win32', testRun: false, appImage: false, linuxPackage: false, feedFile: true, updateKey: true };
    expect(offReason(can)).toBeNull();
    expect(offReason({ ...can, platform: 'linux', appImage: true })).toBeNull();
    expect(offReason({ ...can, testRun: true })).toContain('test run');
    expect(offReason({ ...can, packaged: false })).toContain('development');
    expect(offReason({ ...can, platform: 'darwin' })).toContain('Mac');
    expect(offReason({ ...can, platform: 'linux' })).toContain('.deb');
    expect(offReason({ ...can, feedFile: false })).toContain('no update address');
    // A .deb started from another AppImage app inherits APPIMAGE; it must not install a package as root.
    expect(offReason({ ...can, platform: 'linux', appImage: true, linuxPackage: true })).toContain('.deb');
  });

  test('a newer version downloads by itself and waits, ready', async () => {
    const { flow, seen } = setup({ latest: async () => '1.3.0', download: async (p) => { p(41.6); } });
    await flow.check(false);
    expect(seen).toEqual([{ kind: 'downloading', version: '1.3.0', percent: 0 }, { kind: 'downloading', version: '1.3.0', percent: 42 }, { kind: 'ready', version: '1.3.0' }]);
    let again = 0;
    (flow as any).engine.latest = async () => { again += 1; return '1.4.0'; };
    await flow.check(true);
    expect(again).toBe(0);
    expect(flow.state).toEqual({ kind: 'ready', version: '1.3.0' });
  });

  test('an older or equal feed downloads nothing', async () => {
    let downloads = 0;
    const { flow } = setup({ latest: async () => '1.2.3', download: async () => { downloads += 1; } });
    await flow.check(true);
    expect(flow.state).toEqual({ kind: 'upToDate' });
    expect(downloads).toBe(0);
  });

  test('a failure is quiet at a timed check, and said in plain words to a person who asked', async () => {
    const { flow, seen } = setup({ latest: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED secret-host'); } });
    await flow.check(false);
    expect(seen).toEqual([{ kind: 'idle' }]);
    await flow.check(true);
    expect(flow.state).toEqual({ kind: 'failed', message: 'The update server did not answer. Check the connection, then try again.' });
    expect(JSON.stringify(flow.state)).not.toContain('secret-host');
  });

  test('a download that fails its check does not count as ready, and the next check tries again', async () => {
    let tries = 0;
    const { flow } = setup({ latest: async () => '1.3.0', download: async () => { tries += 1; if (tries === 1) throw new Error('sha512 checksum mismatch'); } });
    await flow.check(true);
    expect(flow.state).toEqual({ kind: 'failed', message: 'The downloaded update failed its check, so it was not installed.' });
    await flow.check(false);
    expect(flow.state).toEqual({ kind: 'ready', version: '1.3.0' });
  });

  test('two checks at one moment run once; an install that is off never asks the feed', async () => {
    let calls = 0;
    const { flow } = setup({ latest: async () => { calls += 1; return null; } });
    await Promise.all([flow.check(false), flow.check(true)]);
    expect(calls).toBe(1);
    const off = new UpdateFlow({ latest: async () => { calls += 1; return '9.9.9'; }, download: async () => undefined }, '1.0.0', () => undefined, 'off');
    await off.check(true);
    expect(calls).toBe(1);
    expect(off.state).toEqual({ kind: 'off', reason: 'off' });
  });

  test('the error text never carries the raw error', () => {
    expect(plainUpdateError(new Error('C:\\Users\\someone\\x failed'))).toBe('The update did not work. Try again later.');
  });

  test('the feed is HTTPS, fixed at build time, and no tool or environment value reaches the updater', () => {
    const root = path.join(__dirname, '..');
    const yml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    const url = /publish:\n(?:\s*-\s*)?\s*provider: generic\n\s*url: (\S+)/.exec(yml)?.[1];
    expect(url).toMatch(/^https:\/\//);
    // The repository holds a made-up address; a release build writes the real one from the site file (update-release.mjs set-feed).
    expect(url).toBe('https://updates.example.invalid/vibex-pca/');
    const updater = readFileSync(path.join(root, 'src/main/updater.ts'), 'utf8');
    expect(updater).not.toMatch(/setFeedURL|forceDevUpdateConfig|channel\s*=/);
    expect(updater).not.toContain('registerTool');
    expect(updater).not.toMatch(/process\.env\.(?!APPIMAGE\b)/);
    expect(updater).toContain('isTestRun()');
    expect(updater).toContain('onBeforeRequest');
  });

  test('only the feed origin is reached, and only over HTTPS, also after a redirect', () => {
    const feed = 'https://updates.example/x/';
    expect(feedAllows(feed, 'https://updates.example/x/latest.yml', false)).toBe(true);
    expect(feedAllows(feed, 'http://updates.example/x/latest.yml', false)).toBe(false);
    expect(feedAllows(feed, 'https://other.example/x/a.exe', false)).toBe(false);
    expect(feedAllows(feed, 'https://updates.example.other.example/a.exe', false)).toBe(false);
    expect(feedAllows(feed, 'not a url', false)).toBe(false);
    expect(feedAllows('http://updates.example/', 'http://updates.example/a', true)).toBe(false);
    expect(feedAllows('http://127.0.0.1:8765/', 'http://127.0.0.1:8765/latest.yml', true)).toBe(true);
    expect(feedOf('provider: generic\nurl: https://a.example/b/\nupdaterCacheDirName: c\n')).toBe('https://a.example/b/');
    expect(feedOf('provider: generic\n')).toBeNull();
  });

  test('a person who joins a timed check hears how it went; a failed install says so', async () => {
    let fail!: (e: Error) => void;
    const { flow } = setup({ latest: () => new Promise((_r, reject) => { fail = reject; }) });
    const timed = flow.check(false);
    const asked = flow.check(true);
    fail(new Error('ECONNREFUSED'));
    await Promise.all([timed, asked]);
    expect(flow.state.kind).toBe('failed');
    flow.installFailed();
    expect(stateText(flow.state, '1.2.3')).toContain('could not install');
  });

  test('after a failed install a timed check does nothing; only a person\'s check runs again', async () => {
    let calls = 0;
    const { flow } = setup({ latest: async () => { calls += 1; return null; } });
    flow.installFailed();
    await flow.check(false);
    await flow.check(false);
    expect(calls).toBe(0);
    expect(flow.state.kind).toBe('failed');
    await flow.check(true);
    expect(calls).toBe(1);
    expect(flow.state).toEqual({ kind: 'upToDate' });
    await flow.check(false);
    expect(calls).toBe(2);
  });

  test('a latest() that never answers ends as failed, waits for a person, and does not block their check', async () => {
    let calls = 0;
    const { flow } = setup({ latest: () => { calls += 1; return calls === 1 ? new Promise<string | null>(() => undefined) : Promise.resolve(null); } });
    await flow.check(false);
    expect(flow.state).toEqual({ kind: 'failed', message: 'The update stopped answering. Use Check for Updates to try again.' });
    await flow.check(false);
    expect(calls).toBe(1);
    await flow.check(true);
    expect(calls).toBe(2);
    expect(flow.state).toEqual({ kind: 'upToDate' });
  });

  test('a download that never answers ends as failed, waits for a person, and does not block their check', async () => {
    let downloads = 0;
    const { flow } = setup({ latest: async () => '1.3.0', download: () => { downloads += 1; return downloads === 1 ? new Promise<void>(() => undefined) : Promise.resolve(); } });
    await flow.check(false);
    expect(flow.state).toEqual({ kind: 'failed', message: 'The update stopped answering. Use Check for Updates to try again.' });
    await flow.check(false);
    expect(downloads).toBe(1);
    await flow.check(true);
    expect(downloads).toBe(2);
    expect(flow.state).toEqual({ kind: 'ready', version: '1.3.0' });
  });

  test('offline at a timed check is not a failed update: idle, and the next timed check asks again', async () => {
    let calls = 0;
    const { flow } = setup({ latest: async () => { calls += 1; throw new Error('ENOTFOUND'); } });
    await flow.check(false);
    expect(flow.state).toEqual({ kind: 'idle' });
    await flow.check(false);
    expect(calls).toBe(2);
  });

  test('a late progress event after the timeout does not bring the banner back', async () => {
    let progress!: (percent: number) => void;
    const { flow } = setup({ latest: async () => '1.3.0', download: (p) => { progress = p; return new Promise<void>(() => undefined); } });
    await flow.check(false);
    expect(flow.state.kind).toBe('failed');
    progress(55);
    expect(flow.state).toEqual({ kind: 'failed', message: 'The update stopped answering. Use Check for Updates to try again.' });
  });

  test('a timed-out download is cancelled, so a person\'s retry starts fresh', async () => {
    const aborted: boolean[] = [];
    let signal: AbortSignal | undefined;
    const { flow } = setup({ latest: async () => '1.3.0', download: (_p, s) => { signal = s; return new Promise<void>(() => undefined); } });
    const run = flow.check(false);
    await new Promise((r) => setTimeout(r, 5));
    aborted.push(signal?.aborted ?? true);
    await run;
    aborted.push(signal?.aborted ?? false);
    expect(aborted).toEqual([false, true]);
  });

  test('a failed install while a timed check runs is not overwritten by that check', async () => {
    let answer!: (v: string | null) => void;
    const { flow } = setup({ latest: () => new Promise<string | null>((r) => { answer = r; }) });
    const timed = flow.check(false);
    flow.installFailed();
    answer(null);
    await timed;
    expect(stateText(flow.state, '1.2.3')).toContain('could not install');
    // still held: a timer does not ask again
    await flow.check(false);
    expect(flow.state.kind).toBe('failed');
  });
});
