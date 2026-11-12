#!/bin/bash
# A release build on the owner's Linux build host for scripts/release.sh --fence. It runs in the container electronuserland/builder:wine,
# with the version commit at /src (read only) and the output at /out. Nothing here runs the app, signs or publishes.
# Linux first, in a clean tree: the AppImage, the .deb, latest-linux.yml and what the gate reads out of the AppImage. Then the
# Windows installer, cross-built as scripts/fence-windows-installer.sh does it: the NSIS exe, its blockmap and latest.yml.
# Unlike the fence workflow, this build KEEPS latest*.yml and the blockmaps: the update feed needs them. The owner's computer judges and
# signs them (scripts/publish-update.sh), and nothing reaches the feed before his hand test.
# FENCE_SRC, FENCE_OUT and FENCE_BUILD move the three folders, for the test of this script only.
set -euo pipefail
SRC=${FENCE_SRC:-/src}
OUT=${FENCE_OUT:-/out}
BUILD=${FENCE_BUILD:-/build}
mkdir -p "$OUT"
exec > >(tee "$OUT/build.log") 2>&1
# At the end, also after a failure: the room left, the exit code (release.sh reads it when the container is gone already), and
# every file readable, for the owner's computer reads /out as the user ci.
# shellcheck disable=SC2329 # it runs from the EXIT trap
on_exit() {
  local code=$?
  echo "== Room at the end:"
  df -Pk "$OUT" | tail -n 1
  echo "$code" >"$OUT/exit-code"
  chmod -R a+rX "$OUT" 2>/dev/null || true
}
trap on_exit EXIT
echo "node $(node --version), npm $(npm --version), wine $(wine --version 2>/dev/null || echo none)"
# The room at the start and at the end (in the trap above): the first real build measures what a release needs on the build host.
echo "== Room at the start:"
df -Pk "$OUT" | tail -n 1

rm -rf "$BUILD"
cp -r "$SRC" "$BUILD"
cd "$BUILD/electron"
export CSC_IDENTITY_AUTO_DISCOVERY=false
shopt -s nullglob
# The feed address of the site file, when release.sh sent one beside the commit. In this copy only.
node scripts/update-release.mjs set-feed

echo "== Linux: the AppImage and the .deb"
npm ci --no-audit --no-fund
npx electron-builder --linux AppImage deb --x64 --publish never
# An AppImage opens only on Linux, so the files the gate must read leave it here, marked with its hash (as the hosted job does).
node scripts/update-release.mjs appimage-gate release
linux=(release/*.AppImage release/*.deb)
[ "${#linux[@]}" = 2 ] || { echo "FAIL: the Linux build made ${#linux[@]} packages, and 2 were expected: ${linux[*]:-none}."; exit 1; }
[ -f release/latest-linux.yml ] || { echo "FAIL: the Linux build made no latest-linux.yml."; exit 1; }
cp "${linux[@]}" release/latest-linux.yml "$OUT/"
for map in release/*.AppImage.blockmap release/*.deb.blockmap; do cp "$map" "$OUT/"; done
cp -r release/appimage-gate "$OUT/"

echo "== Windows: the NSIS installer, under Wine"
# The win32 pty package is an optional dependency for another system, so it comes after npm ci, at the version of the lock.
npm i --no-save --force @lydell/node-pty-win32-x64@1.2.0-beta.15 --no-audit --no-fund
ls node_modules/@lydell
# The two helpers, from source, with one exact compiler (the image is Ubuntu 22.04). Nothing of them is in the repo.
apt-get update -qq
apt-get install -y -qq --no-install-recommends gcc-mingw-w64-x86-64-win32=10.3.0-14ubuntu1+24.3 gcc-mingw-w64-base=10.3.0-14ubuntu1+24.3 binutils-mingw-w64-x86-64=2.38-3ubuntu1+9build1 mingw-w64-x86-64-dev=8.0.0-1 >/dev/null
CC=x86_64-w64-mingw32-gcc-win32 bash native/askpass-win/build.sh
CC=x86_64-w64-mingw32-gcc-win32 bash native/presence-win/build.sh
npx electron-builder --win nsis --x64 --publish never
ls -la release
exes=(release/*.exe)
[ "${#exes[@]}" = 1 ] || { echo "FAIL: the Windows build made ${#exes[@]} installers, and 1 was expected: ${exes[*]:-none}."; exit 1; }
exe=${exes[0]}
[ -f release/latest.yml ] || { echo "FAIL: the Windows build made no latest.yml."; exit 1; }
[ -f "$exe.blockmap" ] || { echo "FAIL: the Windows build made no $(basename "$exe").blockmap."; exit 1; }
cp "$exe" "$exe.blockmap" release/latest.yml "$OUT/"

# 7z with the NSIS reader: optional. Without it the check says that it could not look inside the installer.
(apt-get update -qq && apt-get install -y -qq p7zip-full) >/dev/null 2>&1 || echo "no p7zip-full for this run"
(cd "$OUT" && sha256sum -- *.exe *.AppImage *.deb > SHA256.txt)
status=0
node scripts/check-windows-installer.cjs release 2>&1 | tee "$OUT/proof.txt" || status=$?
echo "== In $OUT:"
ls -la "$OUT"
exit "$status"
