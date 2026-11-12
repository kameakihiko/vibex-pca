// A Windows package with no helper would lose its password box with no error at the build: electron-builder only warns of a missing extra file.
// The same for the Windows Hello helper (native/presence-win): with none, every saved secret would have to be typed.
const { existsSync } = require('node:fs');
const path = require('node:path');
exports.requireAskpassHelper = (context) => {
  if (context.electronPlatformName !== 'win32') return;
  for (const [folder, name] of [['askpass-win', 'vibex-askpass.exe'], ['presence-win', 'vibex-presence.exe']]) {
    const file = path.join(context.packager.info.projectDir, 'native', folder, 'build', name);
    if (!existsSync(file)) throw new Error(`${file} is missing. Build it first: bash native/${folder}/build.sh`);
  }
};
