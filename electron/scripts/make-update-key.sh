#!/usr/bin/env bash
# The release key for auto-update. With no argument it prints the steps and makes nothing. The OWNER runs --make, once, by hand.
#   scripts/make-update-key.sh
#   scripts/make-update-key.sh --make <path outside the repository>
set -euo pipefail
cd "$(dirname "$0")/.."
DEFAULT="$HOME/.config/vibex-pca/update-signing.pem"
if [ "${1:-}" = --make ]; then
  FILE=${2:-$DEFAULT}
  mkdir -p "$(dirname "$FILE")"
  PUBLIC=$(node scripts/update-release.mjs make "$FILE" "$(git rev-parse --show-toplevel 2>/dev/null || pwd)") || { echo "$PUBLIC"; exit 1; }
  echo "Made the private key at $FILE (mode 600). Keep a copy offline. Nothing else can make this key again."
  echo "Paste this line into src/main/updateSign.ts, in place of the empty value:"
  echo "  export const PINNED_UPDATE_PUBLIC_KEY = '$PUBLIC';"
  exit 0
fi
cat <<STEPS
Auto-update stays off until these steps are done. The app holds only the public half of the key.

1. Choose a place outside this repository, on a computer you trust. The default is:
   $DEFAULT
2. Run: scripts/make-update-key.sh --make $DEFAULT
3. Keep a copy of that file offline. If you lose it, or someone copies it, installed apps need a new installer by hand.
4. Paste the line it prints into src/main/updateSign.ts (PINNED_UPDATE_PUBLIC_KEY), commit it, and build a release.
   Apps built before this step do not update themselves; install this release by hand once.
5. Publish with scripts/release.sh <version>. It reads the key from VIBEX_UPDATE_KEY_FILE, else from the default path.
   It refuses with no key, with a key that the built app does not hold, and with a proof build.
STEPS
