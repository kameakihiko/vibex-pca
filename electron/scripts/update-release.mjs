// The checks and the signature behind release.sh, publish-update.sh and make-update-key.sh. No network, and it never prints a private key.
//   gate <release folder> <feed address> <public key>   refuses what must not reach the feed; judges the files that ship (review N2, N3)
//   appimage-gate <release folder>                      on Linux, in the build: takes out of the AppImage what the gate reads
//   sign <private key file> <yml>                       writes <yml>.sig
//   public-key <private key file>                       prints the value of PINNED_UPDATE_PUBLIC_KEY
//   pinned                                              prints the key this tree pins in src/main/updateSign.ts
//   feed                                                prints the feed address: of the site file when there is one, else of electron-builder.yml
//   set-feed                                            in a build: writes the feed address of the site file into electron-builder.yml
//   make <private key file> <repository folder>         makes a new key pair; refuses an existing file
//   check-key <private key file> <repository folder>    refuses a key inside the repository
//   above <version> <other>                             exit 0 when <version> is plainly higher
//   version <yml>                                       prints the version of a feed file
//   feed-files <yml>                                    prints the files one yml needs on the feed, one name a line
//   sha256 <file>                                       prints the SHA-256 of a file
//   sha512 <file>                                       prints the SHA-512 of a file, in hex
//   full-run <jobs.json>                                why a hosted run of vibex-pca.yml is no full run; exit 0 when it is one
//   fence-run <jobs.json>                               why a run of vibex-pca-fence.yml did not test the code; exit 0 when it did
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The whole module, not { crc32 }: a named import that Node lacks (crc32 came in 22.2) stops every command at load, and the owner's build host
// runs appimage-gate on the Node of electronuserland/builder:wine.
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { findIntegrity, isWindowsX64 } = require('./check-windows-installer.cjs');

const temporary = [];
process.on('exit', () => {
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp folder held for a moment on Windows must not change what the gate said.
    }
  }
});
function tempFolder() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibex-gate-'));
  temporary.push(dir);
  return dir;
}

function stop(message) {
  console.log(`REFUSED: ${message}`);
  process.exit(1);
}

const rawPublic = (keyFile) => createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

function insideRepository(file, repo) {
  const real = realpathSync(path.dirname(path.resolve(file)));
  const relative = path.relative(realpathSync(repo), real);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/// Words that exist only in test code. The same names as the source's test switches, read from the source of this tree.
function testWords() {
  const words = new Set(['__vibexTest', 'hubTestHooks', 'testQuestion', 'askOnClose', 'agentTabAnswer', 'VIBEX_TEST']);
  const folder = new URL('../src/main/', import.meta.url);
  for (const file of readdirSync(folder)) {
    for (const m of readFileSync(new URL(file, folder), 'utf8').matchAll(/testEnv\('([A-Z0-9_]+)'\)/g)) words.add(m[1]);
  }
  return [...words];
}

const sha512Of = (file) => createHash('sha512').update(readFileSync(file)).digest('base64');
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const VERSION = /^\d+\.\d+\.\d+$/;
/// A name of the feed goes into a command on the server, so it can hold nothing a shell reads.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readFeedFile(yml) {
  const { load } = require('js-yaml');
  let info;
  try {
    info = load(readFileSync(yml, 'utf8'));
  } catch {
    stop(`${path.basename(yml)} cannot be read.`);
  }
  const label = path.basename(yml);
  if (!info || !VERSION.test(String(info.version))) stop(`${label} has no plain version: ${info?.version}.`);
  if (!Array.isArray(info.files) || !info.files.length) stop(`${label} lists no files.`);
  for (const file of info.files) if (typeof file.url !== 'string' || !SAFE_NAME.test(file.url)) stop(`${label} holds a file name that is not plain: ${String(file.url).slice(0, 60)}.`);
  if (info.isAdminRightsRequired) stop(`${label} asks for admin rights. An update must install per user, with no UAC question.`);
  return { ...info, version: String(info.version) };
}

/// The 7z the NSIS installer stores as it is, found by its header's own checksum, so a chance match in the stub does not count.
function sliceSevenZip(installer, out) {
  const bytes = readFileSync(installer);
  const magic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 1)) {
    if (at + 32 > bytes.length) break;
    if (zlib.crc32(bytes.subarray(at + 12, at + 32)) !== bytes.readUInt32LE(at + 8)) continue;
    const end = at + 32 + Number(bytes.readBigUInt64LE(at + 12)) + Number(bytes.readBigUInt64LE(at + 20));
    if (end > bytes.length) continue;
    writeFileSync(out, bytes.subarray(at, end));
    return true;
  }
  return false;
}

/// bsdtar is on every Mac, and on hosted Windows and Linux there is 7z. Each reads the 7z of electron-builder.
function extractSevenZip(archive, folder) {
  const tools = [['bsdtar', ['-xf', archive, '-C', folder]], ['7z', ['x', '-y', `-o${folder}`, archive]], ['7zz', ['x', '-y', `-o${folder}`, archive]]];
  const tried = [];
  for (const [tool, args] of tools) {
    const r = spawnSync(tool, args, { stdio: 'pipe', windowsHide: true });
    if (r.status === 0) return;
    tried.push(`${tool}: ${r.error ? 'not on this computer' : String(r.stderr).trim().split('\n').slice(-1)[0]}`);
  }
  stop(`the app inside the installer cannot be read (${tried.join('; ')}).`);
}

/// An `ar` file: its first member with this start of a name, written to a file.
function debMember(deb, start, folder) {
  const bytes = readFileSync(deb);
  if (bytes.toString('latin1', 0, 8) !== '!<arch>\n') stop(`${path.basename(deb)} is not a .deb.`);
  for (let at = 8; at + 60 <= bytes.length;) {
    const name = bytes.toString('latin1', at, at + 16).trim().replace(/\/$/, '');
    const size = Number(bytes.toString('latin1', at + 48, at + 58).trim());
    if (name.startsWith(start) && SAFE_NAME.test(name)) {
      const out = path.join(folder, name);
      writeFileSync(out, bytes.subarray(at + 60, at + 60 + size));
      return name;
    }
    at += 60 + size + (size % 2);
  }
  stop(`${path.basename(deb)} has no ${start} part.`);
}

/// Checks one app, as it comes out of its installer: the same for each system.
async function judgeApp(label, root, program, feed, version, publicKey) {
  const { extractFile } = require('@electron/asar');
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const resources = path.join(root, 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!existsSync(asar)) stop(`${label}: the app has no resources/app.asar.`);
  for (const bundle of ['main.js', 'app.js']) {
    const code = extractFile(asar, path.join('dist', bundle)).toString('utf8');
    const kind = /vibex-build-kind: (\w+)/.exec(code)?.[1];
    if (kind === 'proof') stop(`${label} is a proof build (${bundle}). It takes test switches and a debugging port on every PC.`);
    if (kind !== 'release') stop(`${label}: dist/${bundle} is not a release build. Run electron-builder again; it builds the release itself.`);
    const left = testWords().filter((word) => code.includes(word));
    if (left.length) stop(`${label}: test code is left in dist/${bundle}: ${left.join(', ')}.`);
  }
  if (!extractFile(asar, path.join('dist', 'app.js')).toString('utf8').includes(`"${publicKey}"`)) {
    stop(`${label}: the app does not hold this key: an app with another key refuses this release, and an app with none never updates. The key belongs in PINNED_UPDATE_PUBLIC_KEY in src/main/updateSign.ts.`);
  }
  if (!existsSync(path.join(root, program))) stop(`${label}: the program ${program} is not in the app.`);
  const wire = await getCurrentFuseWire(path.join(root, program));
  const want = {
    RunAsNode: [FuseV1Options.RunAsNode, false],
    EnableNodeOptionsEnvironmentVariable: [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    EnableNodeCliInspectArguments: [FuseV1Options.EnableNodeCliInspectArguments, false],
    EnableEmbeddedAsarIntegrityValidation: [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
    OnlyLoadAppFromAsar: [FuseV1Options.OnlyLoadAppFromAsar, true],
    GrantFileProtocolExtraPrivileges: [FuseV1Options.GrantFileProtocolExtraPrivileges, false],
  };
  for (const [name, [fuse, on]] of Object.entries(want)) {
    if ((wire[fuse] === 49) !== on) stop(`${label}: the fuse ${name} must be ${on ? 'on' : 'off'} in a release.`);
  }
  const updateFile = path.join(resources, 'app-update.yml');
  if (!existsSync(updateFile)) stop(`${label}: resources/app-update.yml is missing, so the app has no update address.`);
  const address = /^url:\s*['"]?([^'"\s]+)/m.exec(readFileSync(updateFile, 'utf8'))?.[1];
  if (address !== feed) stop(`${label}: the update address in the build is ${address}, and the feed is ${feed}.`);
  const inApp = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version;
  if (inApp !== version) stop(`${label}: the yml says version ${version}, and the app in the installer is ${inApp}.`);
}

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(folder, e.name)) : [path.join(folder, e.name)]));
}

async function judgeWindows(release, info, feed, publicKey) {
  const { getRawHeader } = require('@electron/asar');
  const installer = path.join(release, info.path);
  const work = tempFolder();
  const archive = path.join(work, 'app.7z');
  if (!sliceSevenZip(installer, archive)) stop(`${info.path} holds no app that this script can find.`);
  const root = path.join(work, 'app');
  mkdirSync(root);
  extractSevenZip(archive, root);
  const label = 'the Windows installer';
  const program = 'Vibex PCA.exe';
  await judgeApp(label, root, program, feed, info.version, publicKey);
  const exe = readFileSync(path.join(root, program));
  if (!isWindowsX64(exe)) stop(`${label}: ${program} is not a Windows x64 program.`);
  const entry = findIntegrity(exe)?.find((e) => /app\.asar$/.test(e.file));
  if (!entry) stop(`${label}: no asar integrity list in the program, and its fuse is on: Windows would refuse to start it.`);
  const hash = createHash('sha256').update(getRawHeader(path.join(root, 'resources', 'app.asar')).headerString).digest('hex');
  if (hash !== entry.value) stop(`${label}: asar integrity: the program holds ${entry.value}, and the app hashes to ${hash}.`);
  const helper = path.join(root, 'resources', 'vibex-askpass.exe');
  if (!existsSync(helper)) stop(`${label}: no vibex-askpass.exe, so password questions would go to the tab.`);
  const problems = require('./check-askpass-exe.cjs').report(helper, () => undefined);
  if (problems.length) stop(`${label}: vibex-askpass.exe: ${problems.join('; ')}.`);
  const presence = path.join(root, 'resources', 'vibex-presence.exe');
  if (!existsSync(presence)) stop(`${label}: no vibex-presence.exe, so no saved secret could be confirmed and each would have to be typed.`);
  const presenceProblems = require('./check-presence-exe.cjs').report(presence, () => undefined);
  if (presenceProblems.length) stop(`${label}: vibex-presence.exe: ${presenceProblems.join('; ')}.`);
  const unpacked = existsSync(path.join(root, 'resources', 'app.asar.unpacked')) ? walk(path.join(root, 'resources', 'app.asar.unpacked')) : [];
  for (const name of ['conpty.dll', 'conpty.node', 'OpenConsole.exe']) {
    const found = unpacked.filter((f) => path.basename(f) === name && /node-pty-win32-x64/.test(f));
    if (!found.length || !found.every((f) => isWindowsX64(readFileSync(f)))) stop(`${label}: no Windows x64 ${name} of conpty, so no terminal would open.`);
  }
  console.log(`Gate passed: ${info.path}: release build, 6 fuses, asar integrity, helper, conpty, feed address, pinned key.`);
}

async function judgeLinux(release, info, feed, publicKey) {
  const appImage = info.files.map((f) => f.url).find((name) => name.endsWith('.AppImage'));
  const debName = info.files.map((f) => f.url).find((name) => name.endsWith('.deb'));
  if (!appImage) stop('latest-linux.yml names no AppImage.');
  // An AppImage opens only on Linux, so the build takes these files out of it and marks them with its hash (appimage-gate).
  const gate = path.join(release, 'appimage-gate');
  const mark = path.join(gate, 'appimage.sha512');
  if (!existsSync(mark)) stop(`the files taken out of the AppImage are not in the release (appimage-gate). The hosted job makes them.`);
  if (readFileSync(mark, 'utf8').trim() !== sha512Of(path.join(release, appImage))) stop(`the files in appimage-gate were not taken out of this AppImage.`);
  await judgeApp('the AppImage', gate, 'vibex-pca', feed, info.version, publicKey);
  console.log(`Gate passed: ${appImage}: release build, 6 fuses, feed address, pinned key (read from what the hosted job took out of it).`);
  if (!debName) return;
  const work = tempFolder();
  const member = debMember(path.join(release, debName), 'data.tar', work);
  // A relative path: GNU tar on Windows reads the colon of C:\ as a remote host.
  execFileSync('tar', ['-xf', member], { cwd: work, stdio: 'pipe', windowsHide: true });
  const root = path.join(work, 'opt', 'Vibex PCA');
  await judgeApp('the .deb', root, 'vibex-pca', feed, info.version, publicKey);
  if (sha256Of(path.join(root, 'resources', 'app.asar')) !== sha256Of(path.join(gate, 'resources', 'app.asar'))) stop('the .deb and the AppImage hold different code.');
  console.log(`Gate passed: ${debName}: read by this computer, with the same code as the AppImage.`);
}

/// Judges the files that ship, and only those: no folder beside them counts (review N2, N3).
async function gate(release, feed, publicKey) {
  const found = ['latest.yml', 'latest-linux.yml'].filter((name) => existsSync(path.join(release, name)));
  if (!found.length) stop(`no latest.yml or latest-linux.yml in ${release}.`);
  const seen = new Set();
  for (const name of found) {
    const info = readFeedFile(path.join(release, name));
    seen.add(info.version);
    if (info.files[0].url !== info.path) stop(`${name}: its path and its first file differ.`);
    for (const file of info.files) {
      const local = path.join(release, file.url);
      if (!existsSync(local)) stop(`the installer ${file.url} is not in this folder.`);
      if (sha512Of(local) !== file.sha512) stop(`the SHA-512 of ${file.url} does not match ${name}.`);
      if (statSync(local).size !== file.size) stop(`the size of ${file.url} does not match ${name}.`);
    }
    if (sha512Of(path.join(release, info.path)) !== info.sha512) stop(`the SHA-512 of ${info.path} does not match ${name}.`);
    await (name === 'latest.yml' ? judgeWindows : judgeLinux)(release, info, feed, publicKey);
  }
  if (seen.size > 1) stop(`the two systems have different versions: ${[...seen].join(', ')}.`);
}

/// In the hosted Linux job, before the upload. It runs the AppImage's own --appimage-extract.
function takeOutOfAppImage(release) {
  const name = readdirSync(release).find((file) => file.endsWith('.AppImage'));
  if (!name) stop(`no AppImage in ${release}.`);
  const file = path.resolve(release, name);
  chmodSync(file, 0o755);
  const work = tempFolder();
  execFileSync(file, ['--appimage-extract'], { cwd: work, stdio: 'pipe' });
  const out = path.join(release, 'appimage-gate');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'resources'), { recursive: true });
  const from = path.join(work, 'squashfs-root');
  cpSync(path.join(from, 'vibex-pca'), path.join(out, 'vibex-pca'));
  for (const part of ['app.asar', 'app-update.yml']) cpSync(path.join(from, 'resources', part), path.join(out, 'resources', part));
  writeFileSync(path.join(out, 'appimage.sha512'), `${sha512Of(file)}\n`);
}

function isAbove(version, other) {
  const parts = (v) => (VERSION.test(v) ? v.split('.').map(Number) : null);
  const a = parts(version);
  const b = parts(other);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/// What a release asks of a run of vibex-pca.yml: every job on both systems, and the long steps that a tag run skips.
const FULL_RUN_JOBS = ['installers (windows-latest)', 'installers (ubuntu-24.04)', 'tests (windows-latest)', 'tests (ubuntu-24.04)'];
const FULL_RUN_STEPS = ['Test the installed app is locked', 'Close a live tab on the package', 'Test from source', 'Go checks with a real focus'];

/// Why a run that says success is not a full one, or null when it is.
function fullRunProblem(run) {
  const jobs = Array.isArray(run?.jobs) ? run.jobs : [];
  for (const name of FULL_RUN_JOBS) {
    const job = jobs.find((j) => j?.name === name);
    if (!job) return `it has no job ${name}`;
    if (job.conclusion !== 'success') return `its job ${name} ended as ${job.conclusion || 'nothing'}`;
    if (!name.startsWith('tests')) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const wanted of FULL_RUN_STEPS) {
      const step = steps.find((s) => s?.name === wanted);
      if (!step) return `its job ${name} has no step ${wanted}`;
      if (step.conclusion !== 'success') return `in its job ${name}, the step ${wanted} ended as ${step.conclusion || 'nothing'}`;
    }
  }
  return null;
}

/// What release.sh --fence asks of a run of vibex-pca-fence.yml: in each job, the step that tests or builds. A job's conclusion
/// does not count: before the uploads had continue-on-error, an upload that GitHub refused made a job red
/// after its real work passed, and those runs still stand for their commits.
const FENCE_RUN_STEPS = {
  'linux-suite': 'Run the suite and the package checks in a container, under Xvfb',
  'windows-installer': 'Cross-build the NSIS installer and read what it holds',
};

/// Why a fence run did not test this code, or null when it did.
function fenceRunProblem(run) {
  const jobs = Array.isArray(run?.jobs) ? run.jobs : [];
  for (const [name, wanted] of Object.entries(FENCE_RUN_STEPS)) {
    const job = jobs.find((j) => j?.name === name);
    if (!job) return `it has no job ${name}`;
    const step = (Array.isArray(job.steps) ? job.steps : []).find((s) => s?.name === wanted);
    if (!step) return `its job ${name} has no step ${wanted}`;
    if (step.conclusion !== 'success') return `in its job ${name}, the step ${wanted} ended as ${step.conclusion || 'nothing'}`;
  }
  return null;
}

/// True when two copies of package.json or package-lock.json differ in the version alone, and the new one is `version`.
function differsInVersionOnly(before, after, version) {
  const bare = (text) => {
    const data = JSON.parse(text);
    const own = data.version;
    delete data.version;
    if (data.packages?.['']) delete data.packages[''].version;
    return { own, text: JSON.stringify(data) };
  };
  const [a, b] = [bare(before), bare(after)];
  return a.text === b.text && b.own === version;
}

const INSTALLER_NAME = /^Vibex-PCA-(\d+\.\d+\.\d+)-(?:win-x64\.exe(?:\.blockmap)?|linux-x86_64\.AppImage(?:\.blockmap)?|linux-amd64\.deb(?:\.blockmap)?)$/;

/// Of the names in the feed folder, the installers of all versions but the newest `keep`. A name of another shape is not ours.
function oldInstallers(names, keep) {
  const versions = [...new Set(names.map((n) => INSTALLER_NAME.exec(n)?.[1]).filter(Boolean))];
  versions.sort((a, b) => (isAbove(a, b) ? -1 : isAbove(b, a) ? 1 : 0));
  const kept = new Set(versions.slice(0, keep));
  return names.filter((n) => {
    const version = INSTALLER_NAME.exec(n)?.[1];
    return version && !kept.has(version);
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === 'gate') {
  await gate(...args);
} else if (command === 'appimage-gate') {
  takeOutOfAppImage(args[0]);
} else if (command === 'pinned') {
  const source = readFileSync(new URL('../src/main/updateSign.ts', import.meta.url), 'utf8');
  console.log(/PINNED_UPDATE_PUBLIC_KEY = '([^']*)'/.exec(source)?.[1] ?? '');
} else if (command === 'feed' || command === 'set-feed') {
  // The repository holds a made-up feed address. The real one is in the site file (site.example.json shows its shape), which is
  // never committed: site.local.json beside package.json, or the file that VIBEX_PCA_SITE_FILE names.
  const builderFile = new URL('../electron-builder.yml', import.meta.url);
  const yml = readFileSync(builderFile, 'utf8');
  const line = /^( *url: )(https:\/\/\S+\/)[ \t]*$/m;
  const siteFile = process.env.VIBEX_PCA_SITE_FILE || fileURLToPath(new URL('../site.local.json', import.meta.url));
  let own = null;
  if (existsSync(siteFile)) {
    own = JSON.parse(readFileSync(siteFile, 'utf8')).feedUrl;
    if (typeof own !== 'string' || !/^https:\/\/[^\s'"$`\\]+\/$/.test(own)) stop(`${siteFile}: "feedUrl" must be an https address that ends in /.`);
  }
  if (command === 'feed') {
    console.log(own ?? line.exec(yml)?.[2] ?? '');
  } else if (!own) {
    console.log('No site file: electron-builder.yml keeps the made-up feed address of the repository.');
  } else {
    if (!line.test(yml)) stop('electron-builder.yml has no https feed address to replace.');
    writeFileSync(builderFile, yml.replace(line, (_all, start) => `${start}${own}`));
    console.log('electron-builder.yml now holds the feed address of the site file.');
  }
} else if (command === 'above') {
  process.exit(isAbove(args[0], args[1]) ? 0 : 1);
} else if (command === 'version') {
  console.log(/^version:\s*['"]?([^'"\s]+)/m.exec(readFileSync(args[0], 'utf8'))?.[1] ?? '');
} else if (command === 'feed-files') {
  const folder = path.dirname(args[0]);
  // electron-builder lists a .deb twice in latest-linux.yml; the upload moves each name once.
  for (const url of new Set(readFeedFile(args[0]).files.map((file) => file.url))) {
    console.log(url);
    if (existsSync(path.join(folder, `${url}.blockmap`))) console.log(`${url}.blockmap`);
  }
} else if (command === 'full-run' || command === 'fence-run') {
  let problem;
  try {
    problem = (command === 'full-run' ? fullRunProblem : fenceRunProblem)(JSON.parse(readFileSync(args[0], 'utf8')));
  } catch {
    problem = 'gh gave an answer that cannot be read';
  }
  if (problem) {
    console.log(problem);
    process.exit(1);
  }
} else if (command === 'version-only') {
  const [before, after, version] = args;
  try {
    process.exit(differsInVersionOnly(readFileSync(before, 'utf8'), readFileSync(after, 'utf8'), version) ? 0 : 1);
  } catch {
    process.exit(1);
  }
} else if (command === 'old-installers') {
  for (const name of oldInstallers(readFileSync(0, 'utf8').split('\n').filter(Boolean), Number(args[0]))) console.log(name);
} else if (command === 'sha256') {
  console.log(sha256Of(args[0]));
} else if (command === 'sha512') {
  console.log(createHash('sha512').update(readFileSync(args[0])).digest('hex'));
} else if (command === 'sign') {
  const [keyFile, yml] = args;
  const key = createPrivateKey(readFileSync(keyFile));
  const data = readFileSync(yml);
  const signature = sign(null, data, key);
  if (!verify(null, data, createPublicKey(key), signature)) stop('the signature does not check out against its own key.');
  writeFileSync(`${yml}.sig`, `${signature.toString('base64')}\n`);
} else if (command === 'public-key') {
  console.log(rawPublic(args[0]));
} else if (command === 'check-key') {
  if (insideRepository(args[0], args[1])) stop(`the signing key must stay outside the repository: ${args[0]}`);
  try {
    if (createPrivateKey(readFileSync(args[0])).asymmetricKeyType !== 'ed25519') stop('the signing key is not an Ed25519 key.');
  } catch {
    stop(`${args[0]} is not a private key this script can read.`);
  }
} else if (command === 'make') {
  const [keyFile, repo] = args;
  if (existsSync(keyFile)) stop(`${keyFile} exists. A new key would stop every installed app from updating, so this does not replace it.`);
  if (insideRepository(keyFile, repo)) stop(`the signing key must stay outside the repository: ${keyFile}`);
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  console.log(rawPublic(keyFile));
} else {
  stop('unknown command');
}
