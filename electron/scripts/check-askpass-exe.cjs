// What the askpass helper is, from its bytes: nothing here runs it. Usage: node scripts/check-askpass-exe.cjs <file>. Prints size, SHA-256 and
// what it found; exit code 1 when the build is not what the release asks for. Unsigned is stated, not a fault: nothing in this build is signed.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

/// Size limit of a helper that does one thing. A big one means a runtime came along.
const MAX_BYTES = 64 * 1024;
const ALLOWED_IMPORTS = ['kernel32.dll', 'shell32.dll'];

function readHelper(bytes) {
  if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a Windows program');
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a Windows program');
  const machine = bytes.readUInt16LE(pe + 4);
  const sections = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const characteristics = bytes.readUInt16LE(pe + 22);
  const opt = pe + 24;
  if (bytes.readUInt16LE(opt) !== 0x20b) throw new Error('not a 64-bit program');
  const dll = bytes.readUInt16LE(opt + 70);
  const directory = (index) => ({ at: bytes.readUInt32LE(opt + 112 + index * 8), size: bytes.readUInt32LE(opt + 116 + index * 8) });
  const table = opt + optionalSize;
  const fileOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const head = table + i * 40;
      const start = bytes.readUInt32LE(head + 12);
      const size = Math.max(bytes.readUInt32LE(head + 8), bytes.readUInt32LE(head + 16));
      if (rva >= start && rva < start + size) return bytes.readUInt32LE(head + 20) + rva - start;
    }
    throw new Error(`no section holds ${rva}`);
  };
  const imports = [];
  if (directory(1).at) {
    for (let at = fileOffset(directory(1).at); bytes.readUInt32LE(at + 12) !== 0; at += 20) {
      const name = fileOffset(bytes.readUInt32LE(at + 12));
      imports.push(bytes.toString('latin1', name, bytes.indexOf(0, name)).toLowerCase());
    }
  }
  return {
    machine,
    subsystem: bytes.readUInt16LE(opt + 68),
    aslr: !!(dll & 0x40),
    highEntropy: !!(dll & 0x20),
    nx: !!(dll & 0x100),
    relocations: directory(5).size > 0 && !(characteristics & 1),
    signed: directory(4).size > 0,
    imports,
  };
}

function helperProblems(facts) {
  const problems = [];
  if (facts.machine !== 0x8664) problems.push('it is not an x64 program');
  if (facts.subsystem !== 2) problems.push('it is a console program, so a window can flash');
  if (!facts.aslr) problems.push('ASLR is off');
  if (!facts.highEntropy) problems.push('high-entropy ASLR is off');
  if (!facts.nx) problems.push('DEP is off');
  if (!facts.relocations) problems.push('it has no relocation table, so ASLR cannot move it');
  for (const name of facts.imports) if (!ALLOWED_IMPORTS.includes(name)) problems.push(`it needs ${name}`);
  return problems;
}

/// What the build and the gates print. The list of problems, empty when the file is right.
function report(file, say = console.log) {
  const bytes = readFileSync(file);
  const facts = readHelper(bytes);
  const problems = helperProblems(facts);
  if (bytes.length >= MAX_BYTES) problems.push(`it is ${bytes.length} bytes, and the limit is ${MAX_BYTES}`);
  say(`vibex-askpass.exe: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
  say(`imports ${facts.imports.join(', ')}; ASLR ${facts.aslr}, high entropy ${facts.highEntropy}, DEP ${facts.nx}, relocations ${facts.relocations}; ${facts.signed ? 'signed' : 'unsigned, like the rest of this build'}`);
  return problems;
}

if (require.main === module) {
  const problems = report(process.argv[2]);
  for (const problem of problems) console.log(`FAIL ${problem}`);
  process.exit(problems.length ? 1 : 0);
}
module.exports = { readHelper, helperProblems, report };
