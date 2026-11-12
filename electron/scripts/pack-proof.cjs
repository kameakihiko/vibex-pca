// electron-builder's beforePack for `npm run dist:proof` only: a packaged app with test switches, for CI. publish-update.sh refuses it.
const { execFileSync } = require('node:child_process');
const { requireAskpassHelper } = require('./require-askpass-helper.cjs');
exports.default = async (context) => {
  requireAskpassHelper(context);
  execFileSync(process.execPath, ['build.mjs', '--proof'], { cwd: context.packager.info.projectDir, stdio: 'inherit' });
};
