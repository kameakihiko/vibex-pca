#!/usr/bin/env bash
# The owner's one command for a Vibex PCA update, run from his Mac in the right-hand Vibex terminal. Running it is his go for the
# update feed: it asks nothing. It stops at the first failure with one plain line, and it publishes nothing partial.
#   electron/scripts/release.sh <version>                   build on GitHub, check, sign, publish
#   electron/scripts/release.sh --dry-run <tag>             check and sign the draft release of a tag that exists. It spends no version, commit, tag or job.
#   electron/scripts/release.sh --fence <version>           build on your own Linux build host (the fence), check, sign, and STOP before the upload
#   electron/scripts/release.sh --publish-kept <version>    upload the copy that --fence kept, after the hand test on a Windows PC
#
# In order: refuses a dirty tree, another branch than main, a version not above the feed's, or a commit with no green
# full run of its pull request; sets the version; commits and tags vibex-pca-v<version>; the tag starts the hosted job from the tag's own
# copy of the workflow (no workflow on main is needed); waits; downloads the draft release that the job made of the tag (never a run
# artifact: installers are too large to keep as run artifacts); the gate judges the installers that ship; signs
# latest*.yml with the local key; uploads with a swap, and reads each file back over HTTPS.
#
# --fence is for when GitHub's hosted jobs cannot be used. The test proof is a run of vibex-pca-fence.yml from a pull
# request, judged by its two steps that test and build (fence-run in update-release.mjs), not by its jobs' conclusions. It sets the
# version and makes the commit and the tag on this Mac only, sends that exact commit to the fence with git archive, and builds
# there in electronuserland/builder:wine (scripts/fence-release-build.sh). It brings the files back into the kept folder, checks
# the versions, runs the gate and signs. Only then does it push the commit and the tag: a build that fails spends no version.
# The tag also starts the hosted workflow, which GitHub refuses; nothing waits for it. Nothing goes to the feed: the copy waits
# for a hand test on a Windows PC, and --publish-kept uploads it. The fence folder and the image are removed after each build.
set -euo pipefail
cd "$(dirname "$0")/.."

# The owner's own values, which are no part of the repository: a file of NAME=value lines on this computer (VIBEX_FENCE_HOST,
# VIBEX_PCA_FEED_SSH, VIBEX_PCA_FEED_DIR, VIBEX_PCA_REPO). The environment works too.
RELEASE_ENV=${VIBEX_PCA_RELEASE_ENV:-$HOME/.config/vibex-pca/release.env}
if [ -f "$RELEASE_ENV" ]; then set -a; . "$RELEASE_ENV"; set +a; fi

REPO=${VIBEX_PCA_REPO:-kameakihiko/vibex-pca}
REMOTE=git@github.com:$REPO.git
RELEASE_BRANCH=main
# Near the job's limits: installers 25 minutes, tests 75, each on two systems.
MAX_WAIT_SECONDS=$((3 * 60 * 60))
POLL=${RELEASE_POLL_SECONDS:-30}
# The signed copy of the last release stays here until the next release. It holds no secret.
KEEP=${VIBEX_RELEASE_KEEP:-$HOME/.cache/vibex-pca/releases}

# The fence: a Linux build host of your own, reached over ssh as VIBEX_FENCE_HOST (user@host), with Docker there as the
# rootless user ci. The repository names no host: --fence refuses to start without one.
FENCE=${VIBEX_FENCE_HOST:-}
FENCE_IMAGE=electronuserland/builder:wine
# A release build holds two trees, node_modules twice and both installers.
FENCE_MIN_FREE_KB=$((9 * 1024 * 1024))
# Run on the fence before each Docker command. Single quotes: the fence expands it.
# shellcheck disable=SC2016
FENCE_ENV='u=$(id -u ci) && export XDG_RUNTIME_DIR=/run/user/$u DOCKER_HOST=unix:///run/user/$u/docker.sock && cd /tmp'

VERSION=
DRY=
MODE=hosted
ARGS_PROBLEM=
for arg in "$@"; do
  case "$arg" in
    --dry-run | --fence | --publish-kept)
      [ "$MODE" = hosted ] || ARGS_PROBLEM="use one of --dry-run, --fence and --publish-kept, not two."
      MODE=${arg#--}
      ;;
    -*) ARGS_PROBLEM="unknown option $arg." ;;
    *)
      [ -z "$VERSION" ] || ARGS_PROBLEM="one version only. Found: '$VERSION' and '$arg'."
      VERSION=$arg
      ;;
  esac
done
[ "$MODE" != dry-run ] || DRY=1

PUSHED=
UPLOADING=
UNDO_ON_STOP=
FENCE_USED=
stop() {
  echo
  echo "STOPPED: $1"
  fence_cleanup
  if [ -n "$UNDO_ON_STOP" ] && [ -z "$PUSHED" ]; then
    UNDO_ON_STOP=
    undo_own_work
    echo "This script's commit and tag were never pushed, and they are gone. The version is not spent."
  fi
  if [ -n "$UPLOADING" ]; then
    bash scripts/publish-update.sh --state "$VERSION" || echo "The feed could not be read. Look at it now: it may hold version $VERSION."
  else
    echo "Nothing went to the feed."
  fi
  if [ -n "$PUSHED" ]; then echo "The commit and the tag vibex-pca-v$VERSION stay on GitHub. The next try needs a higher version."; fi
  exit 1
}
say() { echo "$*"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fence() { # one command on the fence; stdin and stdout go through. A dead link shows after about 2 minutes.
  ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o BatchMode=yes "$FENCE" "$1"
}
# Gives the fence its room back: a container left by a stop, the build folder, and the builder image, as the fence job does.
fence_cleanup() {
  [ -n "$FENCE_USED" ] || return 0
  FENCE_USED=
  if fence ": fence-clean; $FENCE_ENV; sudo -E -u ci docker rm -f '$FENCE_NAME' >/dev/null 2>&1; rm -rf '$FENCE_DIR'; sudo -E -u ci docker rmi $FENCE_IMAGE >/dev/null 2>&1; test ! -e '$FENCE_DIR'" </dev/null; then
    echo "   The build folder on the fence and the builder image are gone."
  else
    echo "The build folder $FENCE_DIR on the fence ($FENCE) could not be removed. Remove it and the image $FENCE_IMAGE there."
  fi
}

[ -z "$ARGS_PROBLEM" ] || stop "$ARGS_PROBLEM"
if [ "$MODE" = fence ]; then
  case "$FENCE" in
    ?*@?*) ;;
    *) stop "--fence needs VIBEX_FENCE_HOST, the ssh login of your build host (user@host). Set it in $RELEASE_ENV." ;;
  esac
fi
if [ -n "$DRY" ]; then
  [[ "$VERSION" =~ ^vibex-pca-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || stop "a dry run takes a tag, as in --dry-run vibex-pca-v0.9.3. A run id no longer works: a run keeps no installers, the draft release of its tag does. It never makes a version. Found: '$VERSION'."
  TAG=$VERSION
else
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || stop "the version must be three plain numbers, as in 0.9.1. Found: '$VERSION'."
  TAG=vibex-pca-v$VERSION
fi

for tool in node git gh ssh scp curl; do
  command -v "$tool" >/dev/null || stop "$tool is not on this computer."
done
# What the gate reads. No Electron: --ignore-scripts skips its download.
if [ ! -d node_modules/@electron/asar ] || [ ! -d node_modules/js-yaml ]; then
  npm ci --no-audit --no-fund --ignore-scripts >/dev/null || stop "npm ci did not work."
fi

check_key_and_feed() {
  KEY=${VIBEX_UPDATE_KEY_FILE:-$HOME/.config/vibex-pca/update-signing.pem}
  [ -f "$KEY" ] || stop "no signing key at $KEY."
  PINNED=$(node scripts/update-release.mjs pinned)
  PUBLIC=$(node scripts/update-release.mjs public-key "$KEY") || stop "the signing key at $KEY cannot be read."
  [ "$PUBLIC" = "$PINNED" ] || stop "the signing key at $KEY is not the key pinned in src/main/updateSign.ts. Apps would refuse this release."
  bash scripts/publish-update.sh --check || stop "the feed folder on the server cannot be reached."
  FEED=$(node scripts/update-release.mjs feed)
  [ -n "$FEED" ] || stop "electron-builder.yml has no https feed address."
}

# A stale login would loop for 15 minutes after the push, with the version spent.
check_gh() {
  gh run list -L 1 -R "$REPO" --json databaseId --jq length >/dev/null 2>&1 || stop "gh cannot read $REPO on GitHub. Log in again with: gh auth login"
}

# A version that is not above what the feed holds would be refused by every app.
check_above_feed() {
  local name code on_feed
  for name in latest.yml latest-linux.yml; do
    code=$(curl -sS -H 'Cache-Control: no-cache' -o "$WORK/$name" -w '%{http_code}' "$FEED$name") || stop "could not read the feed: $name."
    case "$code" in
      404) continue ;;
      200) ;;
      *) stop "could not read the feed: $name answered $code." ;;
    esac
    on_feed=$(node scripts/update-release.mjs version "$WORK/$name")
    node scripts/update-release.mjs above "$VERSION" "$on_feed" || stop "version $VERSION is not above the version on the feed, $on_feed."
  done
}

download_installers() { # into $1: the draft release of $TAG, which the job release-assets of run $RUN made
  mkdir -p "$1"
  local body
  body=$(gh release view "$TAG" -R "$REPO" --json body --jq .body 2>/dev/null) || stop "the tag $TAG has no release on GitHub. The job release-assets of run $RUN makes it: read https://github.com/$REPO/actions/runs/$RUN"
  [[ "$body" == *"Built by run $RUN of vibex-pca.yml"* ]] || stop "the release of $TAG was not made by run $RUN. Its files may be other bytes, so nothing is judged."
  gh release download "$TAG" -R "$REPO" -D "$1" --clobber || stop "the files of the release $TAG did not download."
  [ -f "$1/appimage-gate.tar.gz" ] || stop "the release $TAG has no appimage-gate.tar.gz."
  tar -xzf "$1/appimage-gate.tar.gz" -C "$1" || stop "appimage-gate.tar.gz of the release $TAG did not unpack."
  rm -f "$1/appimage-gate.tar.gz"
  [ -f "$1/latest.yml" ] || stop "the release $TAG has no latest.yml."
  [ -f "$1/latest-linux.yml" ] || stop "the release $TAG has no latest-linux.yml."
}

# The upload and what stays after it: steps 7 and 8 of a release, and the end of --publish-kept.
# $1 and $2 are the labels of the two steps, $3 the line that says where the files came from.
upload_and_finish() {
  say "$1: uploading."
  UPLOADING=1
  bash scripts/publish-update.sh "$RELEASE" --go || stop "the publish did not finish. Its line above says what happened."
  UPLOADING=

  say "$2: done."
  # The next release is here, so the signed copy before it may leave. A name that is no version is not ours.
  local old name installer
  for old in "$KEEP"/*; do
    name=$(basename "$old")
    if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$name" != "$VERSION" ]; then rm -rf "$old"; fi
  done
  installer=$(node scripts/update-release.mjs feed-files "$RELEASE/latest.yml" | grep -v '\.blockmap$' | head -n 1)
  echo
  echo "Version $VERSION is on the feed. Each app with the pinned key downloads it within 6 hours, shows Restart to Update, and installs at quit."
  echo "$3"
  echo "For a hand install: $FEED$installer"
  echo "The signed copy stays in $RELEASE until the next release."
}

# What --fence wrote beside the files it kept: commit, tested-run, tested-commit, image, sha512-latest.yml, sha512-latest-linux.yml.
kept_info() { awk -v k="$1" '$1 == k { print $2; exit }' "$RELEASE/fence-release.txt"; }

if [ -n "$DRY" ]; then
  say "1 of 3: checking the key, the feed and gh."
  check_key_and_feed
  check_gh
  RUN=$(gh run list -R "$REPO" --workflow vibex-pca.yml --event push --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$RUN" ] || stop "no hosted run of the tag $TAG."
  say "2 of 3: downloading the draft release of $TAG, made by run $RUN."
  RELEASE="$WORK/release"
  download_installers "$RELEASE"
  say "3 of 3: checking each installer and signing, in a temp folder."
  bash scripts/publish-update.sh "$RELEASE" || stop "the check of the installers refused them."
  BUILT=$(node scripts/update-release.mjs version "$RELEASE/latest.yml")
  echo
  echo "Dry run of run $RUN: version $BUILT passed the gate, and its files were signed. Nothing went to the feed. It spent no version, commit, tag or job."
  exit 0
fi

# The copy that --fence kept, after the owner's hand test. It builds nothing and pushes nothing.
if [ "$MODE" = publish-kept ]; then
  RELEASE="$KEEP/$VERSION"
  say "1 of 4: checking the key, the feed, the kept copy in $RELEASE and its tag on GitHub."
  check_key_and_feed
  check_above_feed
  [ -d "$RELEASE" ] || stop "no kept copy of version $VERSION in $RELEASE. electron/scripts/release.sh --fence $VERSION makes it."
  for name in latest.yml latest-linux.yml; do
    [ -f "$RELEASE/$name" ] || stop "the kept copy in $RELEASE has no $name."
    BUILT=$(node scripts/update-release.mjs version "$RELEASE/$name")
    [ "$BUILT" = "$VERSION" ] || stop "the kept copy in $RELEASE holds version $BUILT in $name, and this release is $VERSION."
  done
  [ -f "$RELEASE/fence-release.txt" ] || stop "the kept copy in $RELEASE has no fence-release.txt: release.sh --fence did not finish it."
  for name in latest.yml latest-linux.yml; do
    WANT=$(kept_info "sha512-$name")
    [ -n "$WANT" ] && [ "$(node scripts/update-release.mjs sha512 "$RELEASE/$name")" = "$WANT" ] || stop "$name in $RELEASE is not the file that --fence judged and signed. Nothing of it goes to the feed."
  done
  BUILT_FROM=$(kept_info commit)
  AT_GITHUB=$(git ls-remote "$REMOTE" "refs/tags/$TAG" | cut -f1 | cut -d' ' -f1) || stop "GitHub cannot be read over ssh."
  [ -n "$BUILT_FROM" ] && [ "$AT_GITHUB" = "$BUILT_FROM" ] || stop "the tag $TAG on GitHub is not the commit the kept copy was built from (${BUILT_FROM:-none}). Only a pushed release goes to the feed."
  say "2 of 4: checking each installer again, and signing."
  bash scripts/publish-update.sh "$RELEASE" || stop "the check of the installers refused them."
  upload_and_finish "3 of 4" "4 of 4" "Tested by run $(kept_info tested-run), and built on the fence from commit ${BUILT_FROM:0:10} with $(kept_info image)."
  exit 0
fi

# The run that stands for this commit. A run counts for the exact commit it names. Above it, only two kinds of commit are the same code:
# a commit of an earlier release that changed the version and nothing else, and a merge with the same files as the head it merged.
TESTED_RUN=
TESTED_COMMIT=
same_code_as_parent() { # $1 commit. Prints the commit below it with the same code, or nothing.
  local commit=$1 parents version
  read -r -a parents <<<"$(git rev-list --parents -n 1 "$commit" | cut -d' ' -f2-)"
  if [ "${#parents[@]}" = 2 ] && [ "$(git rev-parse "$commit^{tree}")" = "$(git rev-parse "${parents[1]}^{tree}")" ]; then
    echo "${parents[1]}"
    return
  fi
  [ "${#parents[@]}" = 1 ] || return 0
  version=$(git log -1 --format=%s "$commit")
  [[ "$version" =~ ^Vibex\ PCA\ ([0-9]+\.[0-9]+\.[0-9]+)$ ]] || return 0
  version=${BASH_REMATCH[1]}
  [ "$(git diff --name-only "${parents[0]}" "$commit" | tr '\n' ' ')" = 'electron/package-lock.json electron/package.json ' ] || return 0
  for file in package.json package-lock.json; do
    git show "${parents[0]}:electron/$file" >"$WORK/before.json"
    git show "$commit:electron/$file" >"$WORK/after.json"
    node scripts/update-release.mjs version-only "$WORK/before.json" "$WORK/after.json" "$version" || return 0
  done
  echo "${parents[0]}"
}
# Hosted: the newest run of vibex-pca.yml must be green and full. Fence: the newest run of vibex-pca-fence.yml must have ended with
# its suite step and its Windows build step green. Its jobs' conclusions do not count: before the uploads had continue-on-error, a
# refused artifact upload turned a job red after its real work passed, and the steps are what tested and built.
find_full_run() {
  local commit=$1 line run sha state conclusion problem below hops=0 workflow=vibex-pca.yml
  [ "$MODE" != fence ] || workflow=vibex-pca-fence.yml
  while [ "$hops" -lt 40 ]; do
    hops=$((hops + 1))
    line=$(gh run list -R "$REPO" --workflow "$workflow" --event pull_request --commit "$commit" --limit 20 --json databaseId,headSha,status,conclusion --jq '.[] | [.databaseId, .headSha, .status, .conclusion] | @tsv') || stop "gh cannot read the runs of $REPO on GitHub."
    # The newest run of this commit decides.
    line=$(printf '%s\n' "$line" | awk -F'\t' -v c="$commit" '!found && $2 == c { print; found = 1 }')
    if [ -n "$line" ]; then
      IFS=$'\t' read -r run sha state conclusion <<<"$line"
      if [ "$MODE" = fence ]; then
        [ "$state" = completed ] || stop "the fence test run $run of commit $commit has not ended. Wait for it: https://github.com/$REPO/actions/runs/$run"
        gh run view "$run" -R "$REPO" --json jobs >"$WORK/fence-run.json" || stop "gh cannot read the jobs of run $run."
        problem=$(node scripts/update-release.mjs fence-run "$WORK/fence-run.json") || stop "the fence test run $run of commit $commit did not test this code: $problem. https://github.com/$REPO/actions/runs/$run"
      else
        [ "$state" = completed ] || stop "the full test run $run of commit $commit has not ended. Wait for it: https://github.com/$REPO/actions/runs/$run"
        [ "$conclusion" = success ] || stop "the full test run $run of commit $commit ended as $conclusion. A release needs it green: https://github.com/$REPO/actions/runs/$run"
        gh run view "$run" -R "$REPO" --json jobs >"$WORK/full-run.json" || stop "gh cannot read the jobs of run $run."
        problem=$(node scripts/update-release.mjs full-run "$WORK/full-run.json") || stop "run $run of commit $commit is green, but it is no full run: $problem."
      fi
      TESTED_RUN=$run
      TESTED_COMMIT=$commit
      return
    fi
    below=$(same_code_as_parent "$commit")
    [ -n "$below" ] || break
    commit=$below
  done
  [ "$MODE" != fence ] || stop "no fence test run of the pull request for commit $commit. A fence release needs a run of vibex-pca-fence.yml for this exact code, with its suite step and its Windows build step green: open a pull request into $RELEASE_BRANCH, and wait for it."
  stop "no full test run of the pull request for commit $commit. A release needs a green run of vibex-pca.yml for this exact code: open a pull request into $RELEASE_BRANCH, and wait for it to pass."
}

# Read only: room on the fence, and no other container there.
check_fence() {
  local answer free busy
  answer=$(fence ": fence-check; $FENCE_ENV && df -Pk /home/ci | tail -n 1 && sudo -E -u ci docker ps -q" </dev/null) || stop "the fence ($FENCE) cannot be read over ssh, or its Docker does not answer."
  free=$(printf '%s\n' "$answer" | head -n 1 | awk '{ print $4 }')
  busy=$(printf '%s\n' "$answer" | tail -n +2 | grep -c . || true)
  [[ "$free" =~ ^[0-9]+$ ]] || stop "the fence did not say how much room /home/ci has."
  [ "$free" -ge "$FENCE_MIN_FREE_KB" ] || stop "the fence has $((free / 1048576)) GB free in /home/ci, and a release build needs 9 GB. Nothing was started."
  [ "$busy" = 0 ] || stop "the fence runs $busy container(s) now, most likely a CI job. Try again when it ends."
}

if [ "$MODE" = fence ]; then
  say "1 of 6: checking the tree, the branch, the key, the feed, gh, the fence test run and the room on the fence."
else
  say "1 of 8: checking the tree, the branch, the key, the feed, gh and the test run."
fi
# The link to node_modules of a worktree is untracked, and it is not a change.
DIRTY=$(git status --porcelain | grep -v '^?? electron/node_modules$' || true)
[ -z "$DIRTY" ] || stop "the tree has uncommitted changes. Commit them or remove them first."
BRANCH=$(git symbolic-ref --short -q HEAD || true)
[ "$BRANCH" = "$RELEASE_BRANCH" ] || stop "a release comes from the branch $RELEASE_BRANCH. This is '${BRANCH:-no branch}'."
HEAD_NOW=$(git rev-parse HEAD)
AT_GITHUB=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1 | cut -d' ' -f1) || stop "GitHub cannot be read over ssh."
[ "$HEAD_NOW" = "$AT_GITHUB" ] || stop "this tree and $BRANCH on GitHub differ. A release is what is on GitHub: push or pull first."
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || [ -n "$(git ls-remote "$REMOTE" "refs/tags/$TAG")" ]; then
  stop "the tag $TAG exists. Use a higher version."
fi

check_key_and_feed
NOW=$(node -p "require('./package.json').version")
node scripts/update-release.mjs above "$VERSION" "$NOW" || stop "version $VERSION is not above the version in the tree, $NOW."
check_above_feed
check_gh
find_full_run "$HEAD_NOW"
say "   Tested by run $TESTED_RUN, at commit ${TESTED_COMMIT:0:10}: https://github.com/$REPO/actions/runs/$TESTED_RUN"
if [ "$MODE" = fence ]; then
  FENCE_DIR=/home/ci/vibex-pca-release-$VERSION
  FENCE_NAME=vibex-pca-release-$VERSION
  check_fence
fi

# Only what this script did: the two version files, its commit and its tag. Anything else in the tree stays.
undo_own_work() {
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then git tag -d "$TAG" >/dev/null || true; fi
  if [ -n "${OWN_COMMIT:-}" ] && [ "$(git rev-parse HEAD)" = "$OWN_COMMIT" ]; then git reset -q --soft "$HEAD_NOW"; fi
  git restore --source="$HEAD_NOW" --staged --worktree -- package.json package-lock.json
}
push_own_work() {
  # From the push on, a Ctrl-C must not undo: the commit and the tag may be on GitHub already.
  trap - INT TERM HUP
  if ! git push --atomic "$REMOTE" "HEAD:refs/heads/$BRANCH" "refs/tags/$TAG"; then
    UNDO_ON_STOP=
    undo_own_work
    stop "the push to GitHub did not work. This script's commit and tag are gone, and other changes in the tree stay."
  fi
  PUSHED=1
}

if [ "$MODE" = fence ]; then
  say "2 of 6: setting version $VERSION, with its commit and tag, on this Mac only."
  # From here to the push, a stop or a Ctrl-C takes back what this script made: the version files, the commit and the tag.
  UNDO_ON_STOP=1
  # HUP too: a closed terminal tab must not leave a labelled container that holds every CI job of the fence (review 2, item 1).
  trap 'stop "interrupted."' INT TERM HUP
else
  say "2 of 8: setting version $VERSION, with its commit and tag."
fi
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null || { undo_own_work; stop "npm version did not work."; }
git add package.json package-lock.json
git commit -q -m "Vibex PCA $VERSION" -- package.json package-lock.json || { undo_own_work; stop "the commit did not work. The version files are back as they were."; }
OWN_COMMIT=$(git rev-parse HEAD)
git tag "$TAG" || { undo_own_work; stop "the tag did not work. The version files and the branch are back as they were."; }

# The build container on the fence, run detached and followed by short ssh calls, so a dropped connection does not lose the build.
# The labels keep a job runner on the same host away from it, if the owner runs one: such a runner starts a job only when no
# container with the label mu-ci-runner=1 runs, and it removes only exited labelled containers. When the build has
# exited, such a runner may remove the container, so the build script writes its exit code to /out/exit-code too.
FENCE_FOLLOW_TRIES=10
MAX_BUILD_SECONDS=$((2 * 60 * 60))
fence_follow() { # prints the new log lines; sets BUILD_STATE (running, exited or gone) and BUILD_CODE. Returns 1 when ssh failed.
  local answer line
  # shellcheck disable=SC2016
  answer=$(fence ": fence-follow; $FENCE_ENV && st=\$(sudo -E -u ci docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' '$FENCE_NAME' 2>/dev/null || echo \"gone \$(cat '$FENCE_DIR/out/exit-code' 2>/dev/null || echo unknown)\") && { sudo -E -u ci docker logs '$FENCE_NAME' 2>&1 || true; } | awk -v s=$LOG_SEEN 'NR > s { print } END { print \"@@fence-lines\", NR }' && echo \"@@fence-container \$st\"" </dev/null) || return 1
  BUILD_STATE=
  while IFS= read -r line; do
    case "$line" in
      "@@fence-lines "*) LOG_SEEN=$(( ${line#@@fence-lines } > LOG_SEEN ? ${line#@@fence-lines } : LOG_SEEN )) ;;
      "@@fence-container "*) read -r BUILD_STATE BUILD_CODE <<<"${line#@@fence-container }" ;;
      *) printf '%s\n' "$line" | tee -a "$RELEASE/fence-ssh.log" ;;
    esac
  done <<<"$answer"
  [ -n "$BUILD_STATE" ] || return 1
}

if [ "$MODE" = fence ]; then
  RELEASE="$KEEP/$VERSION"
  rm -rf "$RELEASE"
  mkdir -p "$RELEASE"
  : >"$RELEASE/fence-ssh.log"
  say "3 of 6: sending commit ${OWN_COMMIT:0:10} to the fence ($FENCE), and building there: Linux, then Windows. About 40 minutes."
  FENCE_USED=1
  # The site file is no part of the commit, so it rides beside it: the build on the fence reads it as a build here would.
  SITE_FILE=${VIBEX_PCA_SITE_FILE:-$PWD/site.local.json}
  SITE_ARGS=()
  if [ -f "$SITE_FILE" ]; then
    [ "$(basename "$SITE_FILE")" = site.local.json ] || stop "for a fence build the site file must have the name site.local.json. Found: $SITE_FILE."
    SITE_ARGS=(--prefix=electron/ "--add-file=$SITE_FILE" --prefix=)
  fi
  git -C "$(git rev-parse --show-toplevel)" archive --format=tar ${SITE_ARGS[@]+"${SITE_ARGS[@]}"} "$OWN_COMMIT" |
    fence ": fence-receive; cd /tmp && rm -rf '$FENCE_DIR' && sudo -u ci mkdir -p '$FENCE_DIR/src' '$FENCE_DIR/out' && chmod 777 '$FENCE_DIR/out' && sudo -u ci tar -xf - -C '$FENCE_DIR/src'" ||
    stop "the code did not reach the fence."
  # The image, its digest, and the room left after it. 9 GB is an estimate, not a measure yet: the first fence build measures it
  # (the df lines in build.log).
  # shellcheck disable=SC2016
  ANSWER=$(fence ": fence-pull; $FENCE_ENV && sudo -E -u ci docker pull -q $FENCE_IMAGE >/dev/null && echo \"image \$(sudo -E -u ci docker image inspect --format '{{index .RepoDigests 0}}' $FENCE_IMAGE)\" && df -Pk /home/ci | tail -n 1" </dev/null) || stop "the image $FENCE_IMAGE did not reach the fence."
  printf '%s\n' "$ANSWER" >>"$RELEASE/fence-ssh.log"
  IMAGE_DIGEST=$(printf '%s\n' "$ANSWER" | awk '$1 == "image" { print $2; exit }')
  FREE=$(printf '%s\n' "$ANSWER" | tail -n 1 | awk '{ print $4 }')
  [[ "$FREE" =~ ^[0-9]+$ ]] && [ "$FREE" -ge "$FENCE_MIN_FREE_KB" ] || stop "after the image, the fence has ${FREE:-an unknown number of} KB free in /home/ci, and a release build needs 9 GB."
  # A CI job may have started since step 1. Checked in the same ssh call as the start, so no job can slip in between.
  # shellcheck disable=SC2016
  # timeout 7200 inside the container: the label above makes a job runner on the host wait for this container, so a hung build
  # would hold every job there with no end if the Mac side is gone (review 2, item 1). It exits 124 then.
  fence ": fence-run; $FENCE_ENV && if [ -n \"\$(sudo -E -u ci docker ps -q --filter label=mu-ci-runner=1)\" ]; then echo 'a CI job runs'; exit 3; fi && sudo -E -u ci docker rm -f '$FENCE_NAME' >/dev/null 2>&1; sudo -E -u ci docker run -d --name '$FENCE_NAME' --label mu-ci-runner=1 --label mu-ci-name=vibex-pca-release -v '$FENCE_DIR/src:/src:ro' -v '$FENCE_DIR/out:/out' -e CSC_IDENTITY_AUTO_DISCOVERY=false -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 $FENCE_IMAGE timeout 7200 bash /src/electron/scripts/fence-release-build.sh" </dev/null >>"$RELEASE/fence-ssh.log" ||
    stop "the build did not start on the fence. If a CI job started there since step 1, try again when it ends."
  LOG_SEEN=0
  FAILS=0
  WAITED=0
  while :; do
    if fence_follow; then
      FAILS=0
      [ "$BUILD_STATE" = running ] || [ "$BUILD_STATE" = created ] || break
    else
      FAILS=$((FAILS + 1))
      echo "   The fence did not answer ($FAILS of $FENCE_FOLLOW_TRIES). The build goes on there; asking again."
      [ "$FAILS" -lt "$FENCE_FOLLOW_TRIES" ] || stop "the fence did not answer $FENCE_FOLLOW_TRIES times in a row, so the build is lost from here."
    fi
    [ "$WAITED" -lt "$MAX_BUILD_SECONDS" ] || stop "the build on the fence did not end in 2 hours."
    sleep "$POLL"
    WAITED=$((WAITED + POLL + 1))
  done
  BUILD_OK=
  [ "$BUILD_CODE" != 0 ] || BUILD_OK=1
  # Also after a failed build: its log comes back, so the owner can read it.
  if ! fence ": fence-send; cd '$FENCE_DIR/out' && tar -cf - ." </dev/null | tar -xf - -C "$RELEASE"; then
    [ -z "$BUILD_OK" ] || stop "the files of the build did not come back from the fence."
  fi
  [ -n "$BUILD_OK" ] || stop "the build on the fence failed ($BUILD_STATE, exit code $BUILD_CODE). Its log is in $RELEASE/build.log and $RELEASE/fence-ssh.log."
  fence_cleanup
  say "   Built with $FENCE_IMAGE, ${IMAGE_DIGEST:-digest unknown}."

  say "4 of 6: checking the versions and each installer, and signing."
  for name in latest.yml latest-linux.yml; do
    [ -f "$RELEASE/$name" ] || stop "the fence build gave no $name."
    BUILT=$(node scripts/update-release.mjs version "$RELEASE/$name")
    [ "$BUILT" = "$VERSION" ] || stop "the fence built $BUILT in $name, and this release is $VERSION."
  done
  bash scripts/publish-update.sh "$RELEASE" || stop "the check of the installers refused them."
  # The SHA-512 of each yml as the gate judged it. Signing writes a .sig beside a yml and does not change the yml, so this is also
  # the signed yml. --publish-kept refuses a yml that differs: the files it uploads are the files this run judged.
  {
    printf 'commit %s\ntested-run %s\ntested-commit %s\nimage %s\n' "$OWN_COMMIT" "$TESTED_RUN" "$TESTED_COMMIT" "${IMAGE_DIGEST:-unknown}"
    for name in latest.yml latest-linux.yml; do printf 'sha512-%s %s\n' "$name" "$(node scripts/update-release.mjs sha512 "$RELEASE/$name")"; done
  } >"$RELEASE/fence-release.txt"

  say "5 of 6: pushing the commit and the tag to GitHub."
  push_own_work
  say "6 of 6: stopped before the upload, on purpose."
  INSTALLER=$(node scripts/update-release.mjs feed-files "$RELEASE/latest.yml" | grep -v '\.blockmap$' | head -n 1)
  echo
  echo "Version $VERSION is built on the fence, checked and signed. It is NOT on the feed."
  echo "It waits in $RELEASE for the owner's hand test on a Windows PC. The installer: $RELEASE/$INSTALLER"
  echo "Tested by run $TESTED_RUN, and built on the fence from commit ${OWN_COMMIT:0:10} with ${IMAGE_DIGEST:-an image of unknown digest}."
  echo "The commit and the tag $TAG are on GitHub. The tag also starts the hosted job, and GitHub refuses it: nothing waits for it."
  echo "After the hand test, put this copy on the feed with: electron/scripts/release.sh --publish-kept $VERSION"
  exit 0
fi

say "3 of 8: pushing them to GitHub."
push_own_work
COMMIT=$(git rev-parse HEAD)

say "4 of 8: waiting for the hosted job on GitHub to start."
RUN=
for _ in $(seq 1 30); do
  RUN=$(gh run list -R "$REPO" --workflow vibex-pca.yml --event push --branch "$TAG" --limit 5 --json databaseId,headSha --jq ".[] | select(.headSha == \"$COMMIT\") | .databaseId" 2>/dev/null | head -n 1 || true)
  [ -n "$RUN" ] && break
  sleep "$POLL"
done
[ -n "$RUN" ] || stop "no hosted job started for $TAG. Look at the Actions page of the repository."

say "5 of 8: hosted job $RUN runs: the installers, then a test of each package. This takes about 30 minutes."
WAITED=0
FAILS=0
while :; do
  ANSWER=$(gh run view "$RUN" -R "$REPO" --json status,conclusion --jq '.status + " " + .conclusion' 2>/dev/null) || ANSWER=
  case "$ANSWER" in
    "completed success") break ;;
    completed*) stop "the hosted job $RUN ended as '${ANSWER#completed }'. Read it: https://github.com/$REPO/actions/runs/$RUN" ;;
    "")
      FAILS=$((FAILS + 1))
      [ "$FAILS" -lt 20 ] || stop "GitHub did not answer about the hosted job $RUN."
      ;;
    *) FAILS=0 ;;
  esac
  [ "$WAITED" -lt "$MAX_WAIT_SECONDS" ] || stop "the hosted job $RUN did not end in 3 hours."
  sleep "$POLL"
  WAITED=$((WAITED + POLL + 1))
done

say "6 of 8: downloading the draft release of $TAG (the Windows and Linux installers), checking each one, and signing."
RELEASE="$KEEP/$VERSION"
rm -rf "$RELEASE"
download_installers "$RELEASE"
for name in latest.yml latest-linux.yml; do
  BUILT=$(node scripts/update-release.mjs version "$RELEASE/$name")
  [ "$BUILT" = "$VERSION" ] || stop "the hosted job built $BUILT, and this release is $VERSION."
done
bash scripts/publish-update.sh "$RELEASE" || stop "the check of the installers refused them."

upload_and_finish "7 of 8" "8 of 8" "Tested by run $TESTED_RUN, and built by run $RUN."
