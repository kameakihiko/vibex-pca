import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Made-up release folders, as the hosted job's artifacts hold them: a real 7z inside a made-up NSIS stub, a real .deb layout,
// and what the job took out of the AppImage. Each key here is made up. No file here runs on any system.

export const electronDir = path.join(__dirname, '..');
export const FEED = /^ *url: (https:\/\/\S+)/m.exec(readFileSync(path.join(electronDir, 'electron-builder.yml'), 'utf8'))![1];

export function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // The last 32 bytes of the SPKI form are the raw public key.
  const raw = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const pem = (privateKey as KeyObject).export({ format: 'pem', type: 'pkcs8' }).toString();
  return { raw, pem, signText: (data: Buffer) => sign(null, data, privateKey).toString('base64') };
}

/// Sentinel, then version 1, length, and one byte per fuse, as in @electron/fuses.
export function fuseWire(state: { [fuse: number]: '0' | '1' }) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const bytes = Array.from({ length: 9 }, (_, i) => (state[i] ?? '1').charCodeAt(0));
  return Buffer.concat([Buffer.alloc(16), sentinel, Buffer.from([1, 9, ...bytes]), Buffer.alloc(16)]);
}
// RunAsNode 0, CookieEncryption 1, NodeOptions 2, Inspect 3, AsarIntegrity 4, OnlyAsar 5, V8Snapshot 6, GrantFile 7, WasmTrap 8.
const RELEASE_FUSES = { 0: '0', 2: '0', 3: '0', 4: '1', 5: '1', 7: '0' } as const;

/// A Windows x64 program as scripts/check-askpass-exe.cjs reads it: no console, ASLR and DEP on, relocations, no imports.
export function madeUpProgram(tail: Buffer = Buffer.alloc(0), console_ = false): Buffer {
  const pe = 0x40;
  const opt = pe + 24;
  const head = Buffer.alloc(opt + 240);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(pe, 0x3c);
  head.write('PE\0\0', pe, 'latin1');
  head.writeUInt16LE(0x8664, pe + 4);
  head.writeUInt16LE(240, pe + 20);
  head.writeUInt16LE(0x20b, opt);
  head.writeUInt16LE(console_ ? 3 : 2, opt + 68);
  head.writeUInt16LE(0x160, opt + 70);
  head.writeUInt32LE(4096, opt + 112 + 5 * 8);
  head.writeUInt32LE(64, opt + 116 + 5 * 8);
  return Buffer.concat([head, tail]);
}

function which(tool: string): boolean {
  return spawnSync(tool, ['--version'], { stdio: 'ignore' }).error === undefined;
}

/// A 7z of the folder's contents, by whichever tool this system has.
function make7z(folder: string, out: string): void {
  if (which('bsdtar')) execFileSync('bsdtar', ['--format', '7zip', '-cf', out, '-C', folder, '.'], { stdio: 'pipe' });
  else {
    // On Windows the new asar can stay held for a moment after its stream closed (run 41450943947: "being used by another process").
    // -ssw reads a held file, and the second try is for a holder that allows no reading at all.
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('7z', ['a', '-bd', '-ssw', out, '.'], { cwd: folder, stdio: 'pipe' });
        return;
      } catch (error) {
        if (attempt === 5) throw error;
        rmSync(out, { force: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
  }
}

function sha512(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64');
}

function yml(version: string, files: [string, Buffer][]): string {
  const list = files.map(([url, data]) => `  - url: ${url}\n    sha512: ${sha512(data)}\n    size: ${data.length}\n`).join('');
  return `version: ${version}\nfiles:\n${list}path: ${files[0][0]}\nsha512: ${sha512(files[0][1])}\nreleaseDate: '2026-11-02T00:00:00.000Z'\n`;
}

/// A very small `ar` file: what a .deb is.
function arFile(members: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    parts.push(Buffer.from(`${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`));
    parts.push(data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

export interface BuildOptions {
  version?: string;
  kind?: string;
  extra?: string;
  fuses?: Record<number, '0' | '1'>;
  feed?: string;
  pinned: string;
  /// Windows only.
  integrity?: 'right' | 'wrong' | 'none';
  helper?: 'right' | 'console' | 'none';
  /// The Windows Hello helper (native/presence-win), which a release must hold too.
  presence?: 'right' | 'none';
  conpty?: boolean;
}

async function appAsar(work: string, out: string, o: BuildOptions, version: string) {
  const { createPackage } = require('@electron/asar') as { createPackage: (src: string, dest: string) => Promise<void> };
  const app = path.join(work, `app-${path.basename(path.dirname(path.dirname(out)))}`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(path.join(app, 'dist'), { recursive: true });
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(app, 'dist', 'app.js'), `// vibex-build-kind: ${o.kind ?? 'release'}\nconst k = "${o.pinned}";${o.extra ?? ''}\n`);
  writeFileSync(path.join(app, 'dist', 'main.js'), `// vibex-build-kind: ${o.kind ?? 'release'}\nrequire("./app.js");\n`);
  await createPackage(app, out);
  rmSync(app, { recursive: true, force: true });
}

const updateYml = (o: BuildOptions) => `provider: generic\nurl: ${o.feed ?? FEED}\nupdaterCacheDirName: vibex-pca-updater\n`;

/// A release folder's Windows half: an installer with the app as a 7z inside it, and latest.yml. Gives the installer's name.
export async function windowsRelease(release: string, work: string, o: BuildOptions): Promise<string> {
  const { getRawHeader } = require('@electron/asar') as { getRawHeader: (file: string) => { headerString: string } };
  const version = o.version ?? '9.9.2';
  const payload = path.join(work, 'win-payload');
  rmSync(payload, { recursive: true, force: true });
  const resources = path.join(payload, 'resources');
  mkdirSync(resources, { recursive: true });
  await appAsar(work, path.join(resources, 'app.asar'), o, version);
  writeFileSync(path.join(resources, 'app-update.yml'), updateYml(o));
  if ((o.helper ?? 'right') !== 'none') writeFileSync(path.join(resources, 'vibex-askpass.exe'), madeUpProgram(Buffer.alloc(0), o.helper === 'console'));
  if ((o.presence ?? 'right') !== 'none') writeFileSync(path.join(resources, 'vibex-presence.exe'), madeUpProgram(Buffer.from('Windows.Security.Credentials.UI.UserConsentVerifier', 'utf16le')));
  if (o.conpty !== false) {
    const conpty = path.join(resources, 'app.asar.unpacked', 'node_modules', '@lydell', 'node-pty-win32-x64', 'conpty');
    mkdirSync(conpty, { recursive: true });
    for (const name of ['conpty.dll', 'conpty.node', 'OpenConsole.exe']) writeFileSync(path.join(conpty, name), madeUpProgram());
  }
  const hash = createHash('sha256').update(getRawHeader(path.join(resources, 'app.asar')).headerString).digest('hex');
  const list = (o.integrity ?? 'right') === 'none' ? '' : JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: o.integrity === 'wrong' ? 'f'.repeat(64) : hash }]);
  writeFileSync(path.join(payload, 'Vibex PCA.exe'), madeUpProgram(Buffer.concat([fuseWire({ ...RELEASE_FUSES, ...o.fuses }), Buffer.from(list)])));
  const archive = path.join(work, 'win-app.7z');
  rmSync(archive, { force: true });
  make7z(payload, archive);
  rmSync(payload, { recursive: true, force: true });
  const name = `Vibex-PCA-${version}-win-x64.exe`;
  const installer = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(1024), readFileSync(archive), Buffer.alloc(64)]);
  rmSync(archive, { force: true });
  writeFileSync(path.join(release, name), installer);
  writeFileSync(path.join(release, `${name}.blockmap`), 'made-up blockmap');
  writeFileSync(path.join(release, 'latest.yml'), yml(version, [[name, installer]]));
  return name;
}

/// A release folder's Linux half: an AppImage with what the job took out of it, a real .deb layout, and latest-linux.yml.
export async function linuxRelease(release: string, work: string, o: BuildOptions, deb: Partial<BuildOptions> = {}): Promise<{ appImage: string; deb: string }> {
  const version = o.version ?? '9.9.2';
  const appImage = `Vibex-PCA-${version}-linux-x86_64.AppImage`;
  const appImageBytes = Buffer.from('made-up AppImage');
  const gate = path.join(release, 'appimage-gate');
  mkdirSync(path.join(gate, 'resources'), { recursive: true });
  await appAsar(work, path.join(gate, 'resources', 'app.asar'), o, version);
  writeFileSync(path.join(gate, 'resources', 'app-update.yml'), updateYml(o));
  writeFileSync(path.join(gate, 'vibex-pca'), fuseWire({ ...RELEASE_FUSES, ...o.fuses }));
  writeFileSync(path.join(gate, 'appimage.sha512'), `${sha512(appImageBytes)}\n`);

  const debRoot = path.join(work, 'deb-root');
  rmSync(debRoot, { recursive: true, force: true });
  const opt = path.join(debRoot, 'opt', 'Vibex PCA');
  mkdirSync(path.join(opt, 'resources'), { recursive: true });
  const d = { ...o, ...deb };
  if (Object.keys(deb).length) await appAsar(work, path.join(opt, 'resources', 'app.asar'), d, version);
  else cpSync(path.join(gate, 'resources', 'app.asar'), path.join(opt, 'resources', 'app.asar'));
  writeFileSync(path.join(opt, 'resources', 'app-update.yml'), updateYml(d));
  writeFileSync(path.join(opt, 'resources', 'package-type'), 'deb');
  writeFileSync(path.join(opt, 'vibex-pca'), fuseWire({ ...RELEASE_FUSES, ...d.fuses }));
  // Relative paths: GNU tar on Windows reads the colon of C:\\ as a remote host.
  const tarball = path.join(work, 'data.tar.gz');
  execFileSync('tar', ['-czf', 'data.tar.gz', '-C', 'deb-root', 'opt'], { cwd: work, stdio: 'pipe' });
  const debName = `Vibex-PCA-${version}-linux-amd64.deb`;
  const debBytes = arFile([['debian-binary', Buffer.from('2.0\n')], ['data.tar.gz', readFileSync(tarball)]]);
  rmSync(debRoot, { recursive: true, force: true });
  rmSync(tarball, { force: true });
  writeFileSync(path.join(release, appImage), appImageBytes);
  writeFileSync(path.join(release, debName), debBytes);
  writeFileSync(path.join(release, 'latest-linux.yml'), yml(version, [[appImage, appImageBytes], [debName, debBytes]]));
  return { appImage, deb: debName };
}
