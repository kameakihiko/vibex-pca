#!/usr/bin/env bash
# Proves self-update on a real Windows runner: two PROOF builds, a made-up key, a feed on this machine. tests/update-windows.spec.ts
# walks it. A proof build is the only build that takes a test key and an HTTP feed on 127.0.0.1, and a release has neither.
# NOT proved here: the release build, the owner's key, the real feed. It changes this checkout, so it runs only on a CI runner.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_OS:-}" != Windows ]; then
  echo "REFUSED: this changes the checkout, so it runs only on a Windows CI runner."
  exit 1
fi
export CSC_IDENTITY_AUTO_DISCOVERY=false
OUT=$(mktemp -d)
OUT=$(cd "$OUT" && pwd -W)
KEY="$OUT/made-up-key.pem"
OTHER="$OUT/other-key.pem"
PUBLIC=$(node scripts/update-release.mjs make "$KEY" "$(git rev-parse --show-toplevel)")
node scripts/update-release.mjs make "$OTHER" "$(git rev-parse --show-toplevel)" >/dev/null
sed -i 's#url: https://[^ ]*#url: http://127.0.0.1:8765/#' electron-builder.yml
grep -q 'url: http://127.0.0.1:8765/' electron-builder.yml
bash native/askpass-win/build.sh
bash native/presence-win/build.sh
build() {
  npm version --no-git-tag-version --allow-same-version "$1" >/dev/null
  rm -rf release
  npx electron-builder --win nsis --x64 --publish never --config.beforePack=scripts/pack-proof.cjs --config.electronFuses.enableNodeCliInspectArguments=true >/dev/null
  mkdir -p "$OUT/$1"
  cp release/Vibex-PCA-"$1"-win-x64.exe release/latest.yml "$OUT/$1/"
}
build 9.9.1
build 9.9.2
export VIBEX_UPDATE_TEST_KEY="$PUBLIC"
export VIBEX_UPDATE_PROOF_DIR="$OUT"
npx playwright test tests/update-windows.spec.ts
