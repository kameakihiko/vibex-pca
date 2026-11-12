// What the Windows Hello helper is, from its bytes: nothing here runs it. Usage: node scripts/check-presence-exe.cjs <file>. Prints size,
// SHA-256 and what it found; exit code 1 when the build is not what the release asks for. The PE reading is the askpass helper's check.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readHelper, helperProblems } = require('./check-askpass-exe.cjs');

const MAX_BYTES = 64 * 1024;
/// combase.dll is loaded from System32 at run time (vibex-presence.c), so it must not be an import.
const ALLOWED_IMPORTS = ['kernel32.dll', 'shell32.dll'];

function presenceProblems(bytes) {
  const facts = readHelper(bytes);
  const problems = helperProblems(facts).filter((p) => !p.startsWith('it needs '));
  for (const name of facts.imports) if (!ALLOWED_IMPORTS.includes(name)) problems.push(`it needs ${name}`);
  if (bytes.length >= MAX_BYTES) problems.push(`it is ${bytes.length} bytes, and the limit is ${MAX_BYTES}`);
  // The class it asks Windows for, as the UTF-16 text WindowsCreateString gets.
  if (!bytes.includes(Buffer.from('Windows.Security.Credentials.UI.UserConsentVerifier', 'utf16le'))) problems.push('it does not name UserConsentVerifier');
  return { facts, problems };
}

function report(file, say = console.log) {
  const bytes = readFileSync(file);
  const { facts, problems } = presenceProblems(bytes);
  say(`vibex-presence.exe: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
  say(`imports ${facts.imports.join(', ')}; ASLR ${facts.aslr}, high entropy ${facts.highEntropy}, DEP ${facts.nx}, relocations ${facts.relocations}; ${facts.signed ? 'signed' : 'unsigned, like the rest of this build'}`);
  return problems;
}

if (require.main === module) {
  const problems = report(process.argv[2]);
  for (const problem of problems) console.log(`FAIL ${problem}`);
  process.exit(problems.length ? 1 : 0);
}
module.exports = { presenceProblems, report };
