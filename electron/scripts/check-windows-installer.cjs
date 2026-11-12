// What can be proved of a Windows installer on Linux, from its bytes: nothing here runs it. A line starts with pass, FAIL or
// "cannot read". Only FAIL makes the exit code 1. Usage: node scripts/check-windows-installer.cjs <release folder>
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/// As electron-builder.yml asks, and as tests/release-gate.spec.ts checks on Linux.
const FUSES = {
  RunAsNode: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  OnlyLoadAppFromAsar: 'Enabled',
  GrantFileProtocolExtraPrivileges: 'Disabled',
  EnableEmbeddedAsarIntegrityValidation: 'Enabled',
};
/// Kill criterion 4 of PROOF.md: 200 MB or larger.
const LIMIT = 200 * 1024 * 1024;

/// The list electron-builder writes as the INTEGRITY resource of the exe: plain JSON in the bytes of the file.
function findIntegrity(bytes) {
  const at = bytes.indexOf('"alg":"SHA256"');
  if (at < 0) return null;
  const start = bytes.lastIndexOf('[{', at);
  const end = bytes.indexOf('}]', at);
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(bytes.subarray(start, end + 2).toString('utf8'));
  } catch {
    return null;
  }
}

/// A Windows program or dll: MZ, then at the offset in 0x3c the PE mark. Its machine, or null.
function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = bytes.readUInt32LE(0x3c);
  return pe + 6 <= bytes.length && bytes.toString('latin1', pe, pe + 4) === 'PE\0\0' ? bytes.readUInt16LE(pe + 4) : null;
}
const isWindowsX64 = (bytes) => peMachine(bytes) === 0x8664;

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(folder, e.name)) : [path.join(folder, e.name)]));
}

function main(release) {
  let failed = false;
  const pass = (text) => console.log(`pass ${text}`);
  const fail = (text) => { failed = true; console.log(`FAIL ${text}`); };
  const unread = (text) => console.log(`cannot read ${text}`);
  const electronDir = path.join(__dirname, '..');
  const readFuses = (exe) => {
    const text = execFileSync(process.execPath, [path.join(electronDir, 'node_modules/@electron/fuses/dist/bin.js'), 'read', '--app', exe], { encoding: 'utf8' }).replace(/\u001b\[[0-9;]*m/g, '');
    return Object.entries(FUSES).filter(([fuse, want]) => !new RegExp(`${fuse} is ${want}`).test(text)).map(([fuse, want]) => `${fuse} is not ${want}`);
  };

  const installer = readdirSync(release).filter((f) => f.endsWith('.exe')).map((f) => path.join(release, f))[0];
  if (!installer) { fail('no installer in the release folder'); return 1; }
  const size = statSync(installer).size;
  console.log(`installer ${path.basename(installer)}: ${size} bytes, ${(size / 1048576).toFixed(1)} MB, sha256 ${createHash('sha256').update(readFileSync(installer)).digest('hex')}`);
  (size < LIMIT ? pass : fail)(`size against the kill limit of 200 MB (PROOF.md, criterion 4)`);
  // The NSIS stub is a 32-bit program on every target, so the machine of the installer itself says nothing.
  (peMachine(readFileSync(installer)) !== null ? pass : fail)('the installer is a Windows program');

  const unpacked = path.join(release, 'win-unpacked');
  const exe = path.join(unpacked, 'Vibex PCA.exe');
  if (!existsSync(exe)) { fail(`no ${exe}`); return 1; }
  const exeBytes = readFileSync(exe);
  (isWindowsX64(exeBytes) ? pass : fail)('Vibex PCA.exe is a Windows x64 program');
  const wrong = readFuses(exe);
  if (wrong.length) fail(`fuses of the exe: ${wrong.join('; ')}`);
  else pass(`the ${Object.keys(FUSES).length} fuses of the exe read as the release needs`);

  const asarUnpacked = path.join(unpacked, 'resources', 'app.asar.unpacked');
  const files = existsSync(asarUnpacked) ? walk(asarUnpacked) : [];
  // What @lydell's win32 package holds: conpty.node and conpty_console_list.node, and no pty.node.
  for (const name of ['conpty.dll', 'conpty.node', 'OpenConsole.exe']) {
    const found = files.filter((f) => path.basename(f) === name && /node-pty-win32-x64/.test(f));
    if (found.length && found.every((f) => isWindowsX64(readFileSync(f)))) pass(`${name} of the win32 package is unpacked, for x64: ${path.relative(unpacked, found[0])}`);
    else fail(`${name}: ${found.length} files of the win32 package unpacked, for x64 or not`);
  }
  (existsSync(path.join(unpacked, 'resources', 'pca', 'managed-settings.json')) ? pass : fail)('the PCA folder is in the resources');

  // The password helper: built from source in this job, unsigned like the rest (native/askpass-win).
  const helper = path.join(unpacked, 'resources', 'vibex-askpass.exe');
  if (!existsSync(helper)) fail('no vibex-askpass.exe in the resources: password prompts would go to the tab');
  else {
    const problems = require('./check-askpass-exe.cjs').report(helper);
    if (problems.length) fail(`vibex-askpass.exe: ${problems.join('; ')}`);
    else pass('vibex-askpass.exe is in the resources: x64, no console, ASLR and DEP on, system DLLs only');
  }

  // The Windows Hello helper before a saved secret is read: built from source in this job, unsigned (native/presence-win).
  const presence = path.join(unpacked, 'resources', 'vibex-presence.exe');
  if (!existsSync(presence)) fail('no vibex-presence.exe in the resources: every saved secret would have to be typed');
  else {
    const problems = require('./check-presence-exe.cjs').report(presence);
    if (problems.length) fail(`vibex-presence.exe: ${problems.join('; ')}`);
    else pass('vibex-presence.exe is in the resources: x64, no console, ASLR and DEP on, kernel32 and shell32 only');
  }

  const list = findIntegrity(exeBytes);
  const entry = list?.find((e) => /app\.asar$/.test(e.file));
  if (!entry) fail('no asar integrity list in the bytes of the exe, and its fuse is on: Windows would refuse to start it');
  else {
    const asar = require(path.join(electronDir, 'node_modules/@electron/asar'));
    const hash = createHash('sha256').update(asar.getRawHeader(path.join(unpacked, 'resources', 'app.asar')).headerString).digest('hex');
    if (hash === entry.value) pass(`asar integrity: the exe holds the hash of the header of app.asar (${hash})`);
    else fail(`asar integrity: the exe holds ${entry.value}, the header of app.asar hashes to ${hash}`);
  }

  // The same program inside the installer, if a 7z with the NSIS reader is here.
  const look = mkdtempSync(path.join(os.tmpdir(), 'vibex-installer-'));
  try {
    execFileSync('7z', ['x', '-y', `-o${look}`, installer], { stdio: 'pipe' });
    const archive = walk(look).find((f) => /app-64\.7z$/.test(f));
    if (!archive) throw new Error(`no app-64.7z among ${walk(look).length} files of the installer`);
    execFileSync('7z', ['x', '-y', `-o${path.join(look, 'app')}`, archive], { stdio: 'pipe' });
    const inside = path.join(look, 'app', 'Vibex PCA.exe');
    const same = createHash('sha256').update(readFileSync(inside)).digest('hex') === createHash('sha256').update(exeBytes).digest('hex');
    const packed = walk(path.join(look, 'app')).map((f) => path.basename(f));
    if (!same) fail('the exe inside the installer is not the exe that was checked');
    else if (!packed.includes('conpty.dll') || !packed.includes('conpty.node')) fail('the installer has no conpty.dll or conpty.node');
    else if (!packed.includes('vibex-askpass.exe')) fail('the installer has no vibex-askpass.exe');
    else if (!packed.includes('vibex-presence.exe')) fail('the installer has no vibex-presence.exe');
    else pass('inside the installer: the same exe, byte for byte, with conpty.dll, conpty.node, vibex-askpass.exe and vibex-presence.exe');
  } catch (error) {
    unread(`inside the installer (no 7z with an NSIS reader, or another layout): ${String(error.stderr || error.stdout || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
  } finally {
    rmSync(look, { recursive: true, force: true });
  }
  console.log('cannot read from here: if Windows accepts the exe, SmartScreen, Defender, ConPTY at run time. Nothing here ran on Windows.');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv[2] ?? 'release'));
module.exports = { FUSES, LIMIT, findIntegrity, isWindowsX64, peMachine };
