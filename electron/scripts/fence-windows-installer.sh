#!/bin/bash
# In the container electronuserland/builder:wine (the fence suite on a hosted runner, or the owner's build host), with the repo at /src and the output at /out. Nothing here
# runs the app. Only the installer, its checksum and these logs reach /out: no latest.yml, no blockmap, so no update feed.
set -euo pipefail
exec > >(tee /out/build.log) 2>&1
echo "node $(node --version), npm $(npm --version), wine $(wine --version 2>/dev/null || echo none)"
cp -r /src /build && cd /build/electron

# Plain npm ci: the build needs the Linux esbuild, and --os=win32 would leave it out. The win32 pty package is an optional
# dependency for another system, so it comes after that, at the version of the lock.
npm ci --no-audit --no-fund
npm i --no-save --force @lydell/node-pty-win32-x64@1.2.0-beta.15 --no-audit --no-fund
ls node_modules/@lydell

# The password helper, from source, with one exact compiler (the image is Ubuntu 22.04). Nothing of it is in the repo.
apt-get update -qq
apt-get install -y -qq --no-install-recommends gcc-mingw-w64-x86-64-win32=10.3.0-14ubuntu1+24.3 gcc-mingw-w64-base=10.3.0-14ubuntu1+24.3 binutils-mingw-w64-x86-64=2.38-3ubuntu1+9build1 mingw-w64-x86-64-dev=8.0.0-1 >/dev/null
CC=x86_64-w64-mingw32-gcc-win32 bash native/askpass-win/build.sh
# The Windows Hello check before a saved secret, with the same compiler (native/presence-win).
CC=x86_64-w64-mingw32-gcc-win32 bash native/presence-win/build.sh

npx electron-builder --win nsis --x64 --publish never
ls -la release
exe=$(ls release/*.exe | head -n 1)

# 7z with the NSIS reader: optional. Without it the check says that it could not look inside the installer.
(apt-get update -qq && apt-get install -y -qq p7zip-full) >/dev/null 2>&1 || echo "no p7zip-full for this run"

cp "$exe" /out/
(cd /out && sha256sum "$(basename "$exe")" > SHA256.txt)
status=0
node scripts/check-windows-installer.cjs release 2>&1 | tee /out/proof.txt || status=$?
chmod -R a+rX /out
exit "$status"
