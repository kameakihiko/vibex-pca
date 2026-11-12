// electron-builder's beforePack: what goes in the package is always a fresh release build, whatever dist/ holds (review N4).
const { execFileSync } = require('node:child_process');
const { requireAskpassHelper } = require('./require-askpass-helper.cjs');
exports.default = async (context) => {
  requireAskpassHelper(context);
  execFileSync(process.execPath, ['build.mjs', '--release'], { cwd: context.packager.info.projectDir, stdio: 'inherit' });
};
