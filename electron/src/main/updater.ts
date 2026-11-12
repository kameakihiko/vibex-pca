import { app, dialog } from 'electron';
import { autoUpdater, CancellationToken } from 'electron-updater';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModuleHost, VibexModule } from './modules';
import { buildKind, isTestRun, testEnv } from './testSwitches';
import { feedAllows, feedOf, offReason, stateText, UpdateFlow, watchInstall, type UpdateEngine } from './updateFlow';
import { feedFileName, PINNED_UPDATE_PUBLIC_KEY, signedEngine } from './updateSign';

// Auto-update, Windows (NSIS) and Linux (AppImage). The feed is fixed at build time in electron-builder.yml. Nothing
// reads it from the environment, and no tool or page can start an install: only a person, through these channels,
// which main.ts accepts only from the app's own window. The feed's yml must carry a signature by the pinned key
// (./updateSign.ts); with no pinned key this stays off. The installer itself is not code-signed yet: the signed SHA-512 stands for it.

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;
/// A yml and its signature are a few kilobytes. A feed that sends more is not read to the end.
const MAX_FEED_FILE = 1024 * 1024;

/// The key the feed must be signed by. A proof build can take a made-up one for its proof on a runner; build.mjs removes the
/// switch from a release, so a release can only ever accept the pinned key.
const updateKey = () => testEnv('VIBEX_UPDATE_TEST_KEY') ?? PINNED_UPDATE_PUBLIC_KEY;

let flow: UpdateFlow | null = null;

function engine(feed: string): UpdateEngine {
  // Every request and every redirect, whatever address the feed names.
  autoUpdater.netSession.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !feedAllows(feed, details.url, buildKind === 'proof') }));
  autoUpdater.disableWebInstaller = true;
  autoUpdater.autoDownload = false;
  // Later: it installs when the person quits, and no running command is cut.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  // A failure comes back through the promises below; with no listener the library would throw it again.
  autoUpdater.on('error', () => undefined);
  // updateSign.ts passes only the progress callback on, so the flow's abort signal waits here until the download starts.
  let giveUp: AbortSignal | undefined;
  const signed = signedEngine({
    publicKey: updateKey(),
    fileName: feedFileName(process.platform, process.arch),
    fetchFile: async (name) => {
      const answer = await autoUpdater.netSession.fetch(new URL(name, feed).href, { cache: 'no-store' });
      if (!answer.ok) return null;
      const data = Buffer.from(await answer.arrayBuffer());
      return data.length > MAX_FEED_FILE ? null : data;
    },
    // The library's own answer counts too: a feed it refuses is no update.
    check: async () => {
      const found = await autoUpdater.checkForUpdates();
      return found ? { available: !!found.isUpdateAvailable, info: found.updateInfo } : null;
    },
    download: async (onPercent) => {
      const signal = giveUp;
      const progress = (p: { percent: number }) => onPercent(p.percent);
      autoUpdater.on('download-progress', progress);
      // downloadUpdate() hands a second call the first, hung promise (electron-updater AppUpdater.js:442-444), so a giving-up
      // flow cancels it here. checkForUpdates() rejoins in the same way (AppUpdater.js:257-260) but takes no token.
      const token = new CancellationToken();
      signal?.addEventListener('abort', () => token.cancel());
      try {
        await autoUpdater.downloadUpdate(token);
      } finally {
        autoUpdater.off('download-progress', progress);
      }
    },
  });
  return { latest: () => signed.latest(), download: (onPercent, signal) => { giveUp = signal; return signed.download(onPercent); } };
}

/// Windows is ending the session: it can kill a silent install in the middle of its file copy. It installs at the next quit.
export function skipInstallAtQuit(): void {
  autoUpdater.autoInstallOnAppQuit = false;
}

function start(host: ModuleHost): void {
  const resources = process.resourcesPath ?? '';
  const feedFile = path.join(resources, 'app-update.yml');
  const feed = existsSync(feedFile) ? feedOf(readFileSync(feedFile, 'utf8')) : null;
  // The Windows update proof starts the app after the install from the Start menu, with no test switch: it says its version here.
  if (buildKind === 'proof') {
    try {
      writeFileSync(path.join(app.getPath('userData'), 'last-run-version.txt'), app.getVersion());
    } catch {
      // A proof build only, and the proof then says it found no such file.
    }
  }
  const off = offReason({
    packaged: app.isPackaged,
    platform: process.platform,
    // A proof run with a test key is the one test run that updates.
    testRun: isTestRun() && !testEnv('VIBEX_UPDATE_TEST_KEY'),
    appImage: !!process.env.APPIMAGE,
    linuxPackage: existsSync(path.join(resources, 'package-type')),
    feedFile: !!feed,
    updateKey: !!updateKey(),
  });
  flow = new UpdateFlow(off ? { latest: async () => null, download: async () => undefined } : engine(feed!), app.getVersion(), (state) => {
    // The fence's update proof reads this line in the app's log.
    if (state.kind === 'failed') console.warn(`update failed: ${state.message}`);
    host.send('mod:update:state', state);
  }, off);
  host.handle('mod:update:state', () => ({ state: flow!.state, version: app.getVersion(), text: stateText(flow!.state, app.getVersion()) }));
  host.handle('mod:update:check', () => flow!.check(true));
  host.handle('mod:update:restart', async () => {
    if (flow!.state.kind !== 'ready') return;
    // The same question as Quit, because the same tabs stop. Cancel keeps all, and the update waits for the quit.
    if (!(await host.agreeToQuit())) return;
    // Silent: an update shows no wizard. It runs per user, so no UAC. The second true starts the app again after it.
    watchInstall(autoUpdater, app, () => autoUpdater.quitAndInstall(true, true), () => {
      // The app does not quit, so the next close must ask again.
      host.cancelQuit();
      flow!.installFailed();
    });
  });
  if (off) return;
  setTimeout(() => void flow!.check(false), FIRST_CHECK_MS).unref();
  setInterval(() => void flow!.check(false), EVERY_MS).unref();
}

function menu() {
  return [{
    menu: 'Help',
    items: [{
      label: 'Check for Updates…',
      click: () => {
        void flow?.check(true).then(() => {
          // The menu has no place to show the answer. A download in progress shows its button when it is ready.
          if (flow) void dialog.showMessageBox({ type: flow.state.kind === 'failed' ? 'warning' : 'info', message: 'Updates', detail: stateText(flow.state, app.getVersion()) });
        });
      },
    }],
  }];
}

export const updaterModule: VibexModule = { name: 'updater', start, menu };
