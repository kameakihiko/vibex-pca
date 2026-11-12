import { app } from 'electron';
import { runAskpassHelper } from './askpassHelper';

// The first code of the app. ssh runs the app as SSH_ASKPASS for its own prompts, and that run loads nothing else: it is
// quicker, and a native module that fails to load cannot stop a login behind an error dialog. A packaged app gets the
// prompt as its first argument; a development run has the app folder before it.
// A release build also refuses a debugging port: with it, any program of this user could press Go and read the page of any
// tab. The Electron fuses close --inspect the same way. Only a proof build, which CI tests with Playwright, and a test
// build take it. This reads the kind of build, not the file name: a copy named electron.exe is still a release.
// It is no wall against a program of this user: `--mcp-headers` gives that program the MCP key by design (README, "What a program of this user can do").
declare const VIBEX_BUILD_KIND: string;
const release = typeof VIBEX_BUILD_KIND !== 'undefined' && VIBEX_BUILD_KIND === 'release';
// A proof build under Playwright: no window until Playwright has connected. From source its loader holds the app back, and that
// loader does not reach a package. On Windows a window made during the connect reads as a crashed target, so Playwright never
// reports a page (Inspector.targetCrashed, run 41400652008). A release build holds none of this: the condition is false at build time.
if (typeof VIBEX_BUILD_KIND !== 'undefined' && VIBEX_BUILD_KIND === 'proof' && app.commandLine.hasSwitch('remote-debugging-port')) {
  const ready = app.whenReady.bind(app);
  let go = () => {};
  const connected = new Promise<void>((resolve) => { go = resolve; });
  (globalThis as any).__playwright_run = () => go();
  setTimeout(() => go(), 5000);
  app.whenReady = () => connected.then(ready);
}
if (process.env.VIBEX_ASKPASS_HELPER === '1') runAskpassHelper(process.argv[app.isPackaged ? 1 : 2]);
else if (release && (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe'))) app.exit(1);
else require('./app.js');
