// The only file that reads a test switch (security review M7, N5). What decides is the kind of build, set at build time, and
// not app.isPackaged: that is a test of the file name, and a program can copy the app as electron.exe.
// - release: what people install. build.mjs removes each call to this file from the bundle, so no environment can reach it.
// - proof: a packaged app that takes the switches, for CI only. publish-update.sh refuses it.
// - dev: `npm run build` and the tests. electron-builder never packs it: its beforePack step builds a release first.
export type BuildKind = 'dev' | 'proof' | 'release';
declare const VIBEX_BUILD_KIND: BuildKind;
export const buildKind: BuildKind = typeof VIBEX_BUILD_KIND === 'undefined' ? 'dev' : VIBEX_BUILD_KIND;

export const switchesAllowed = (kind: BuildKind) => kind !== 'release';

/// A test switch, or undefined when this build takes none.
export const testEnv = (name: string): string | undefined => (switchesAllowed(buildKind) ? process.env[name] : undefined);

export const isTestRun = () => testEnv('VIBEX_TEST') === '1';
