#!/usr/bin/env bash
# Puts one built release into the feed folder on the team's server, so installed apps update. A PRODUCTION WRITE: scripts/release.sh
# runs it for the owner, and his release command is his go. It judges the installers that ship (scripts/update-release.mjs gate),
# signs each yml with the key outside the repository, and prints what it would upload. It uploads only with --go.
#   scripts/publish-update.sh <folder with latest*.yml and the installers> [--go]
#   scripts/publish-update.sh --check     only: the key is there and usable, and the feed folder is reachable
#   scripts/publish-update.sh --state <version>      only reads: what the feed holds now, and what puts it right
#   scripts/publish-update.sh --put-back <version>   the old yml pair goes back, from the .previous-<version> folder of that release
#
# With --go nothing is partial. The files go to a temp folder and are checked there. The installers then take their final names:
# they are new names, so no app reads them yet, and each is checked over HTTPS. Only then does each yml swap by a rename, with its
# signature beside it. If a yml reads wrong after that, the old pair comes back and the new files leave.
# After a good swap, .previous-<version> stays until the next release, and the installers of the last 2 versions stay.
set -euo pipefail
DIR=${1:?folder with the built release, --check, --state or --put-back}
GO=${2:-}
# This script reads files of electron/ by short names; the folder it is given stays the one the caller meant.
if [ -d "$DIR" ]; then DIR=$(cd "$DIR" && pwd); fi
cd "$(dirname "$0")/.."
# The feed address of the site file (site.local.json, never committed), else the made-up one of electron-builder.yml.
FEED=$(node scripts/update-release.mjs feed)
# An empty address would upload to the parent folder (review N9).
case "$FEED" in
  https://*/) ;;
  *) echo "REFUSED: there is no https feed address ending in /. Found: '$FEED'. Nothing was uploaded."; exit 1 ;;
esac
# Where the feed folder lives is the owner's own knowledge, and no part of the repository: the ssh login of the server, and
# the folder there that holds one folder per feed. From the environment, or from a file of NAME=value lines on this computer.
RELEASE_ENV=${VIBEX_PCA_RELEASE_ENV:-$HOME/.config/vibex-pca/release.env}
if [ -f "$RELEASE_ENV" ]; then set -a; . "$RELEASE_ENV"; set +a; fi
SERVER=${VIBEX_PCA_FEED_SSH:-}
FEED_DIR=${VIBEX_PCA_FEED_DIR:-}
case "$SERVER" in
  ?*@?*) ;;
  *) echo "REFUSED: VIBEX_PCA_FEED_SSH is not set (the ssh login of the feed server, as user@host). Set it in $RELEASE_ENV. Nothing was uploaded."; exit 1 ;;
esac
case "$FEED_DIR" in
  /?*) ;;
  *) echo "REFUSED: VIBEX_PCA_FEED_DIR is not set (the folder on the feed server that holds the feed folder). Set it in $RELEASE_ENV. Nothing was uploaded."; exit 1 ;;
esac
TARGET=${FEED_DIR%/}/$(basename "$FEED")
remote() { ssh -o ConnectTimeout=15 "$SERVER" "$1"; }

# The old pointers of one release go back: each name the swap wrote down. No list means the swap never started, so no live file moves.
# shellcheck disable=SC2016
restore_script() {
  printf '%s' "cd '$TARGET/.previous-$1' 2>/dev/null || exit 0; [ -f .swapped ] || exit 0; "
  printf '%s' 'for name in $(cat .swapped); do if [ -e "$name" ]; then mv -f "$name" "../$name"; else rm -f "../$name"; fi; done; '
}

checked_version() {
  [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "REFUSED: that is not a version: '${1:-}'."; exit 1; }
}

# Reads only. It says what is true now, also when part of it cannot be read.
feed_state() {
  local version=$1 unread= at_version= name code out left
  out=$(mktemp)
  echo "What the feed holds now:"
  for name in latest.yml latest-linux.yml; do
    code=$(curl -sS -H 'Cache-Control: no-cache' -o "$out" -w '%{http_code}' "$FEED$name" 2>/dev/null) || code=
    case "$code" in
      200)
        local read_version
        read_version=$(node scripts/update-release.mjs version "$out")
        echo "  $name: version $read_version"
        [ "$read_version" != "$version" ] || at_version=1
        ;;
      404) echo "  $name: none" ;;
      *) echo "  $name: could not be read"; unread=1 ;;
    esac
  done
  rm -f "$out"
  if left=$(remote "cd '$TARGET' && for d in .incoming-$version .previous-$version; do if [ -e \"\$d\" ]; then echo \"\$d\"; fi; done"); then
    if [ -n "$left" ]; then echo "  Left in the feed folder: $(printf '%s' "$left" | tr '\n' ' ')"; else echo "  Left in the feed folder: no temp folder"; fi
  else
    echo "  The feed folder on the server: could not be read"
    unread=1
  fi
  if [ -n "$unread" ]; then
    echo "Read the feed again. If it holds version $version, put the old files back. From the repository folder, run:"
    echo "  electron/scripts/publish-update.sh --put-back $version"
  elif [ -n "$at_version" ] || [ -n "$left" ]; then
    echo "To put the old files back, from the repository folder, run:"
    echo "  electron/scripts/publish-update.sh --put-back $version"
  else
    echo "The feed did not change. It needs no repair."
  fi
}

if [ "$DIR" = --state ]; then
  checked_version "$GO"
  feed_state "$GO"
  exit 0
fi
if [ "$DIR" = --put-back ]; then
  checked_version "$GO"
  remote "$(restore_script "$GO")" || { echo "FAIL: the old files could not be put back. The server did not answer, or a file there would not move."; exit 1; }
  remote "rm -rf '$TARGET/.incoming-$GO' '$TARGET/.previous-$GO'" || echo "The old files are back, and the temp folders could not be removed."
  feed_state "$GO"
  exit 0
fi

KEY=${VIBEX_UPDATE_KEY_FILE:-$HOME/.config/vibex-pca/update-signing.pem}
if [ ! -f "$KEY" ]; then
  echo "REFUSED: no signing key at $KEY, so nothing was signed or uploaded."
  echo "Run scripts/make-update-key.sh to see the steps."
  exit 1
fi
node scripts/update-release.mjs check-key "$KEY" "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PUBLIC=$(node scripts/update-release.mjs public-key "$KEY")
if [ "$DIR" = --check ]; then
  ssh -o ConnectTimeout=15 "$SERVER" "test -d '$TARGET'" || { echo "REFUSED: the feed folder on the server cannot be reached with ssh."; exit 1; }
  exit 0
fi
node scripts/update-release.mjs gate "$DIR" "$FEED" "$PUBLIC"
FILES=()
METAS=()
for name in latest.yml latest-linux.yml; do
  meta="$DIR/$name"
  [ -f "$meta" ] || continue
  METAS+=("$meta")
  while read -r file; do
    [ -f "$DIR/$file" ] || { echo "REFUSED: missing: $file"; exit 1; }
    FILES+=("$DIR/$file")
  done < <(node scripts/update-release.mjs feed-files "$meta")
done
SIGS=()
for meta in "${METAS[@]}"; do
  node scripts/update-release.mjs sign "$KEY" "$meta"
  SIGS+=("$meta.sig")
done
printf '%s\n' "Would upload to the feed folder, installers first:" "${FILES[@]}" "${SIGS[@]}" "${METAS[@]}"
[ "$GO" = --go ] || { echo "Dry run. Nothing was uploaded."; exit 0; }

VERSION=$(node scripts/update-release.mjs version "${METAS[0]}")
INCOMING="$TARGET/.incoming-$VERSION"
PREVIOUS="$TARGET/.previous-$VERSION"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
base_names() { local f; for f in "$@"; do basename "$f"; done; }
INSTALLERS=$(base_names "${FILES[@]}" | tr '\n' ' ')
POINTERS=$(base_names "${SIGS[@]}" "${METAS[@]}" | tr '\n' ' ')

drop_incoming() { remote "rm -rf '$INCOMING' '$PREVIOUS'" || true; }
drop_installers() { remote "cd '$TARGET' && rm -f $INSTALLERS" || true; }
sha256_at_feed() { # the file as people read it
  local out="$WORK/read"
  rm -f "$out"
  curl -fsS -H 'Cache-Control: no-cache' -o "$out" "$FEED$1" || return 1
  node scripts/update-release.mjs sha256 "$out"
}

remote "rm -rf '$INCOMING' '$PREVIOUS' && mkdir -p '$INCOMING' '$PREVIOUS'"
scp -q "${FILES[@]}" "${SIGS[@]}" "${METAS[@]}" "$SERVER:$INCOMING/" || { drop_incoming; echo "FAIL: the upload did not finish, and the feed did not change."; exit 1; }
for file in "${FILES[@]}" "${SIGS[@]}" "${METAS[@]}"; do
  name=$(basename "$file")
  want=$(node scripts/update-release.mjs sha256 "$file")
  got=$(remote "sha256sum '$INCOMING/$name'" | cut -d' ' -f1) || got=
  [ "$want" = "$got" ] || { drop_incoming; echo "FAIL: $name came to the server damaged, and the feed did not change."; exit 1; }
done
# The feed folder is also the web server's folder. Root reads and changes only plain files there, never through a link.
ALL_NAMES="$INSTALLERS $POINTERS"
remote "cd '$INCOMING' && for f in $ALL_NAMES; do [ ! -L \"\$f\" ] && chmod 644 \"\$f\" || exit 3; done; cd '$TARGET' && for f in $ALL_NAMES; do [ ! -L \"\$f\" ] || exit 3; done" || { drop_incoming; echo "FAIL: a file in the feed folder is a link, or could not be prepared, so nothing moved. Look at the feed folder on the server. The feed did not change."; exit 1; }
remote "cd '$INCOMING' && mv -f $INSTALLERS '$TARGET/'" || { drop_incoming; drop_installers; echo "FAIL: the installers did not take their names, and the feed did not change."; exit 1; }
COUNT=0
for file in "${FILES[@]}"; do
  name=$(basename "$file")
  want=$(node scripts/update-release.mjs sha256 "$file")
  got=$(sha256_at_feed "$name") || got=
  [ "$want" = "$got" ] || { drop_incoming; drop_installers; echo "FAIL: $name reads wrong over HTTPS at the feed, and the feed did not change."; exit 1; }
  COUNT=$((COUNT + 1))
done

# Each signature and its yml: two renames, a moment apart. An app that reads between them reads once more (signedEngine).
SWAP=
for name in $POINTERS; do
  SWAP="$SWAP if [ -e '$TARGET/$name' ]; then rm -f '$PREVIOUS/$name'; cp -Pp '$TARGET/$name' '$PREVIOUS/$name'; fi;"
done
# Written after each copy and before the first rename: --put-back reads it, and with no list no live file moves.
SWAP="$SWAP echo '$POINTERS' > '$PREVIOUS/.swapped';"
for name in $POINTERS; do SWAP="$SWAP mv -f '$INCOMING/$name' '$TARGET/$name';"; done
put_back() {
  if remote "$(restore_script "$VERSION")"; then
    drop_installers
    drop_incoming
    echo "FAIL: $1 reads wrong over HTTPS at the feed. The old files were put back. Nothing partial stays."
  else
    echo "FAIL: $1 reads wrong over HTTPS at the feed, and the old files could not be put back. The feed may be wrong: look at it now."
  fi
  exit 1
}
remote "set -e; $SWAP" || put_back 'a yml'
for file in "${SIGS[@]}" "${METAS[@]}"; do
  name=$(basename "$file")
  want=$(node scripts/update-release.mjs sha256 "$file")
  got=$(sha256_at_feed "$name") || got=
  [ "$want" = "$got" ] || put_back "$name"
  COUNT=$((COUNT + 1))
done
TOTAL=$(( ${#FILES[@]} + ${#SIGS[@]} + ${#METAS[@]} ))
echo "Verified at the feed: $COUNT of $TOTAL files, by SHA-256, over HTTPS."

# The release stands from here. What follows only tidies, and a failure says so and changes nothing else.
remote "rm -rf '$INCOMING'; cd '$TARGET' && find . -maxdepth 1 -name '.previous-*' ! -name '.previous-$VERSION' -exec rm -rf {} +" || echo "Older .previous folders stay in the feed folder: they could not be removed. The release is fine."
if NAMES=$(remote "cd '$TARGET' && ls -A"); then
  OLD=$(printf '%s\n' "$NAMES" | node scripts/update-release.mjs old-installers 2 | tr '\n' ' ')
  if [ -n "$OLD" ]; then
    # Each name passed the check in old-installers: letters, digits, dots and dashes.
    remote "cd '$TARGET' && rm -f -- $OLD" || echo "The older installers could not be removed, so they stay. The release is fine."
  fi
else
  echo "The older installers stay: the feed folder could not be listed. The release is fine."
fi
