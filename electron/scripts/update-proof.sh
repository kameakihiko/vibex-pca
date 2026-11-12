#!/usr/bin/env bash
# Proves auto-update on a real packaged AppImage, in the fence container, with made-up versions and a feed on this machine:
# version A finds version B, checks its signature and hash, and replaces itself at quit. A feed with no signature, with a
# signature by another key, or with a wrong SHA-512 changes nothing.
# Linux only. Windows needs the same walk on a PC. Run from electron/, under xvfb-run, with no secret in the environment.
# It works on a copy of the tree: the made-up key, feed and versions must never stay in a tree a release is cut from (review N9).
# These are proof builds: only they may read a feed over HTTP on this machine.
set -euo pipefail
PORT=8765
OUT=$(mktemp -d)
HERE=$PWD
COPY="$OUT/tree"
mkdir -p "$COPY"
cp -r "$HERE/.." "$COPY/repo"
cd "$COPY/repo/electron"
KEY="$OUT/made-up-key.pem"
OTHER="$OUT/other-key.pem"
PUBLIC=$(node scripts/update-release.mjs make "$KEY" "$OUT/tree/repo")
node scripts/update-release.mjs make "$OTHER" "$OUT/tree/repo" >/dev/null
# Only a proof build reads this. A release has no such switch and takes the pinned key.
export VIBEX_UPDATE_TEST_KEY="$PUBLIC"
sed -i "s#url: https://[^ ]*#url: http://127.0.0.1:$PORT/#" electron-builder.yml
build() {
  npm version --no-git-tag-version --allow-same-version "$1" >/dev/null
  rm -rf release
  npx electron-builder --linux AppImage --x64 --publish never --config.beforePack=scripts/pack-proof.cjs >/dev/null
  mkdir -p "$OUT/$1"
  cp release/*.AppImage release/latest-linux.yml "$OUT/$1/"
}
build 9.9.1
build 9.9.2
A=$(ls "$OUT"/9.9.1/*.AppImage)
B=$(ls "$OUT"/9.9.2/*.AppImage)
hashB=$(sha256sum "$B" | cut -d' ' -f1)
walk() { # name, feed folder; prints the hash of the app after a run and a quit
  local app="$OUT/$1.AppImage"
  cp "$A" "$app"; chmod +x "$app"
  (cd "$2" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
  local feed=$!
  sleep 1
  CLAUDE_CONFIG_DIR="$OUT/$1-claude" ELECTRON_DISABLE_SANDBOX=1 "$app" --appimage-extract-and-run --no-sandbox --user-data-dir="$OUT/$1-profile" >"$OUT/$1.log" 2>&1 &
  local run=$!
  sleep "$3"
  # The AppImage launcher waits for the app and does not pass a signal on, so the signal goes to the app's own main process.
  local main
  main=$(pgrep -af -- "--user-data-dir=$OUT/$1-profile" | grep appimage_extracted | grep -v -- '--type=' | cut -d' ' -f1 | head -n 1 || true)
  echo "$1: main process ${main:-not found}" >&2
  [ -n "$main" ] && kill -TERM "$main" 2>/dev/null || true
  # A run that does not end stops this script with a clear line, and does not hold the runner until its limit.
  local waited=0
  while kill -0 "$run" 2>/dev/null && [ "$waited" -lt 60 ]; do sleep 1; waited=$((waited + 1)); done
  if kill -0 "$run" 2>/dev/null; then
    echo "$1: the app did not end 60 s after the signal" >&2
    tail -40 "$OUT/$1.log" >&2
    pkill -9 -f -- "--user-data-dir=$OUT/$1-profile" || true
    kill "$feed" 2>/dev/null || true
    return 1
  fi
  wait "$run" 2>/dev/null || true
  sleep 15
  kill "$feed" 2>/dev/null || true
  wait "$feed" 2>/dev/null || true
  sha256sum "$app" | cut -d' ' -f1
}
sign() { node scripts/update-release.mjs sign "$1" "$2"; }
sign "$KEY" "$OUT/9.9.2/latest-linux.yml"
good=$(walk good "$OUT/9.9.2" 60) || exit 1
if [ "$good" != "$hashB" ]; then echo "FAIL: the app did not become version B"; tail -30 "$OUT/good.log"; ls -la "$OUT"; exit 1; fi
echo "PASS 1 of 4: version 9.9.1 replaced itself with 9.9.2 at quit, hash equal"
mkdir "$OUT/bad"; cp "$B" "$OUT/bad/"
sed -E 's#^(\s*(- )?sha512: ).*#\1AAAA#' "$OUT/9.9.2/latest-linux.yml" > "$OUT/bad/latest-linux.yml"
sign "$KEY" "$OUT/bad/latest-linux.yml"
hashA=$(sha256sum "$A" | cut -d' ' -f1)
bad=$(walk bad "$OUT/bad" 60) || exit 1
if [ "$bad" != "$hashA" ]; then echo "FAIL: a wrong checksum changed the app"; exit 1; fi
# Unchanged is no proof by itself: a dead feed gives it too. The refusal must be in the log.
if ! grep -qiE 'sha512 checksum mismatch|ERR_CHECKSUM_MISMATCH' "$OUT/bad.log"; then echo "FAIL: no checksum refusal in the log"; tail -30 "$OUT/bad.log"; exit 1; fi
echo "PASS 2 of 4: a signed feed with a wrong SHA-512 left version 9.9.1 as it was"
refused() { # name: a feed that must be refused by signature, with nothing downloaded
  unsigned=$(walk "$1" "$OUT/$1" 40) || exit 1
  if [ "$unsigned" != "$hashA" ]; then echo "FAIL: $1 changed the app"; exit 1; fi
  if ! grep -q 'no valid signature' "$OUT/$1.log"; then echo "FAIL: no signature refusal in the log of $1"; tail -30 "$OUT/$1.log"; exit 1; fi
  if grep -qi 'sha512 checksum\|Downloading update' "$OUT/$1.log"; then echo "FAIL: $1 began a download"; tail -30 "$OUT/$1.log"; exit 1; fi
}
mkdir "$OUT/unsigned"; cp "$B" "$OUT/9.9.2/latest-linux.yml" "$OUT/unsigned/"
refused unsigned
echo "PASS 3 of 4: a feed with no signature downloaded nothing, and the app says why"
mkdir "$OUT/forged"; cp "$B" "$OUT/9.9.2/latest-linux.yml" "$OUT/forged/"
sign "$OTHER" "$OUT/forged/latest-linux.yml"
refused forged
echo "PASS 4 of 4: a feed signed by another key downloaded nothing"
