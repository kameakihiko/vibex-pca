import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './fixtures';
import { electronDir, FEED, keyPair, linuxRelease, windowsRelease } from './releaseFixture';

// scripts/release.sh, the owner's one command, end to end with no network: a copy of the tree in a new git repository, and
// stand-ins on PATH for gh, ssh, scp, curl and the network side of git. The private key here is made up, and pinned only in
// that copy. The stand-in server is a temp folder. No test reads the owner's real key, and none reaches a real feed.

const FOLDER = path.basename(FEED);
// Made up, as VIBEX_PCA_FEED_DIR in playwright.config.ts.
const SERVER_FOLDER = `/srv/feed/vibex-updates/${FOLDER}`;
const OWNER_PUBLIC_KEY = '0kgKWEIBvSGf8ZH5ZDsSX6SNeC76zhnpBzejfJC2QI0=';

test.describe('release.sh', () => {
  test.skip(process.platform === 'win32', 'the owner runs it on his Mac; nothing runs it on Windows');

  let dir: string;
  let tree: string;
  let state: string;
  let bin: string;
  let feedDir: string;
  let keyFile: string;
  let keep: string;
  const key = keyPair();

  function stub(name: string, body: string) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\nSTATE='${state}'\necho "${name} $*" >> "$STATE/calls.log"\n${body}\n`);
    chmodSync(file, 0o755);
  }

  const git = (...args: string[]) => execFileSync('git', args, { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  function makeTree(pinned = key.raw) {
    const electron = path.join(tree, 'electron');
    mkdirSync(path.join(electron, 'src'), { recursive: true });
    cpSync(path.join(electronDir, 'scripts'), path.join(electron, 'scripts'), { recursive: true });
    cpSync(path.join(electronDir, 'src', 'main'), path.join(electron, 'src', 'main'), { recursive: true });
    for (const file of ['electron-builder.yml', 'package.json', 'package-lock.json']) cpSync(path.join(electronDir, file), path.join(electron, file));
    const sign = path.join(electron, 'src', 'main', 'updateSign.ts');
    writeFileSync(sign, readFileSync(sign, 'utf8').replace(/PINNED_UPDATE_PUBLIC_KEY = '[^']*'/, `PINNED_UPDATE_PUBLIC_KEY = '${pinned}'`));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    git('add', '-A');
    git('commit', '-q', '-m', 'made-up start');
    // As in a worktree of the repository: the link is untracked, and it is not a change.
    symlinkSync(path.join(electronDir, 'node_modules'), path.join(electron, 'node_modules'));
  }

  function makeStubs() {
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', env: { ...process.env } }).trim();
    stub('git', `
case "$1" in
  push)
    touch "$STATE/pushed"
    [ -z "\${FAKE_PEER_EDIT:-}" ] || echo 'a peer line' >> "$FAKE_PEER_EDIT"
    [ -z "\${FAKE_PUSH_FAIL:-}" ] || exit 1
    # What GitHub holds after the push: each tag at the commit pushed.
    for ref in "$@"; do case "$ref" in refs/tags/*) echo "$('${realGit}' rev-parse HEAD) $ref" >> "$STATE/pushed-tags" ;; esac; done
    exit 0 ;;
  commit) [ -z "\${FAKE_COMMIT_FAIL:-}" ] || exit 1 ;;
  tag) [ -z "\${FAKE_TAG_FAIL:-}" ] || [ "$2" = -d ] || exit 1 ;;
  ls-remote)
    if [ -n "\${FAKE_REMOTE_HEAD:-}" ]; then echo "$FAKE_REMOTE_HEAD refs/heads/x"; exit 0; fi
    case "$*" in *refs/tags/*)
      [ -f "$STATE/remote-tag" ] && echo "abc refs/tags/x"
      for ref; do :; done
      [ -f "$STATE/pushed-tags" ] && grep " $ref\$" "$STATE/pushed-tags" | tail -n 1
      exit 0 ;;
    esac
    echo "$('${realGit}' rev-parse HEAD) refs/heads/x"; exit 0 ;;
esac
exec '${realGit}' "$@"`);
    stub('gh', `
[ -z "\${FAKE_GH_DOWN:-}" ] || { echo 'HTTP 401: Bad credentials' >&2; exit 1; }
case "$1 $2" in
  "run list")
    case "$*" in
      *"--workflow vibex-pca-fence.yml"*"--event pull_request"*)
        # The fence run of a pull request: 5050. Its jobs are red when GitHub refused the artifact upload; the steps tell.
        sha=; prev=
        for a in "$@"; do [ "$prev" = --commit ] && sha=$a; prev=$a; done
        [ -z "\${FAKE_NO_FENCE_RUN:-}" ] || exit 0
        [ -z "\${FAKE_GREEN_SHA:-}" ] || [ "$FAKE_GREEN_SHA" = "$sha" ] || exit 0
        printf '5050\\t%s\\t%s\\t%s\\n' "$sha" "\${FAKE_FENCE_STATUS:-completed}" "\${FAKE_FENCE_CONCLUSION:-failure}"
        exit 0 ;;
      *"--event pull_request"*)
        # The full run of a pull request, by the commit it names.
        sha=; prev=
        for a in "$@"; do [ "$prev" = --commit ] && sha=$a; prev=$a; done
        [ -z "\${FAKE_NO_FULL_RUN:-}" ] || exit 0
        [ -z "\${FAKE_GREEN_SHA:-}" ] || [ "$FAKE_GREEN_SHA" = "$sha" ] || exit 0
        printf '4040\\t%s\\t%s\\t%s\\n' "$sha" "\${FAKE_FULL_STATUS:-completed}" "\${FAKE_FULL_CONCLUSION:-success}"
        exit 0 ;;
      *"--event push"*) [ -f "$STATE/pushed" ] && echo 4141; [ -z "\${FAKE_OLD_TAG_RUN:-}" ] || echo 4141; exit 0 ;;
    esac
    exit 0 ;;
  "run view")
    case "$*" in
      *jobs*) if [ "$3" = 5050 ]; then cat "$STATE/fence-run.json"; else cat "$STATE/full-run.json"; fi; exit 0 ;;
    esac
    echo "\${FAKE_RUN_RESULT:-completed success}"; exit 0 ;;
  "run download") echo 'a run keeps no installers since the storage limit' >&2; exit 1 ;;
  "release view")
    # The draft release that the job release-assets made of the tag, with the run in its notes.
    [ -d "$STATE/artifacts" ] && [ -z "\${FAKE_NO_RELEASE:-}" ] || { echo 'release not found' >&2; exit 1; }
    echo "Built by run \${FAKE_RELEASE_RUN:-4141} of vibex-pca.yml, from the tag $3. A draft."; exit 0 ;;
  "release download")
    shift 2; out=
    while [ $# -gt 0 ]; do case "$1" in -D) out=$2; shift ;; esac; shift; done
    mkdir -p "$out"
    # Flat files, as release assets are: the folder appimage-gate comes as one tar, as the job packs it.
    for system in Windows Linux; do cp -R "$STATE/artifacts/vibex-pca-installers-$system/." "$out/"; done
    if [ -d "$out/appimage-gate" ]; then (cd "$out" && tar -czf appimage-gate.tar.gz appimage-gate && rm -rf appimage-gate); fi
    [ -z "\${FAKE_NO_GATE_TAR:-}" ] || rm -f "$out/appimage-gate.tar.gz"
    exit 0 ;;
esac
exit 1`);
    // The server: the same commands in a temp folder.
    stub('ssh', `
while [ "$1" = -o ]; do shift 2; done
case "$1" in
  *@fence.invalid | *@other.invalid)
    # The fence: no Docker here. A build copies the made-up release files of the fixtures into its out folder.
    out="$STATE/fence-out"
    case "$2" in
      ": fence-check;"*)
        [ -z "\${FAKE_FENCE_DOWN:-}" ] || exit 255
        echo "/dev/sda1 15728640 1000 \${FAKE_FENCE_FREE_KB:-12000000} 20% /"
        [ -z "\${FAKE_FENCE_BUSY:-}" ] || echo 0123abcd
        exit 0 ;;
      ": fence-receive;"*) cat > "$STATE/fence-src.tar"; exit 0 ;;
      ": fence-pull;"*)
        echo "image electronuserland/builder@sha256:made-up-digest"
        echo "/dev/sda1 15728640 1000 \${FAKE_FENCE_FREE_AFTER_PULL_KB:-11000000} 30% /"
        exit 0 ;;
      ": fence-run;"*)
        [ -z "\${FAKE_FENCE_CI_STARTED:-}" ] || { echo 'a CI job runs'; exit 3; }
        # The build, at once: the made-up release files of the fixtures, and a log of three lines.
        rm -rf "$out"; mkdir -p "$out"
        printf 'node v22\\nthe made-up build log\\n' > "$out/build.log"
        code=0
        if [ -n "\${FAKE_FENCE_BUILD_FAIL:-}" ]; then echo "FAIL: made up" >> "$out/build.log"; code=1
        else for system in Linux Windows; do cp -R "$STATE/artifacts/vibex-pca-installers-$system/." "$out/"; done; echo "pass made up" > "$out/proof.txt"; echo "the build ended" >> "$out/build.log"; fi
        echo "$code" > "$out/exit-code"
        # Running at the first look, then exited; or gone, as after a reap or a next job.
        echo 0 > "$STATE/fence-looks"
        echo "$code" > "$STATE/fence-code"
        echo 0123456789abcdef
        exit 0 ;;
      ": fence-follow;"*)
        looks=$(( $(cat "$STATE/fence-looks") + 1 )); echo "$looks" > "$STATE/fence-looks"
        [ "$looks" -gt "\${FAKE_FENCE_DROP:-0}" ] || exit 255
        seen=$(printf '%s' "$2" | sed -n 's/.*-v s=\\([0-9]*\\).*/\\1/p')
        if [ -n "\${FAKE_FENCE_GONE:-}" ] && [ "$looks" -gt "\${FAKE_FENCE_DROP:-0}" ]; then
          echo "@@fence-lines 0"; echo "@@fence-container gone $(cat "$out/exit-code" 2>/dev/null || echo unknown)"; exit 0
        fi
        awk -v s="$seen" 'NR > s { print } END { print "@@fence-lines", NR }' "$out/build.log"
        if [ "$looks" -le "$(( \${FAKE_FENCE_DROP:-0} + 1 ))" ]; then echo "@@fence-container running 0"; else echo "@@fence-container exited $(cat "$STATE/fence-code")"; fi
        exit 0 ;;
      ": fence-send;"*) tar -cf - -C "$out" . ; exit ;;
      ": fence-clean;"*) rm -rf "$out"; touch "$STATE/fence-cleaned"; exit 0 ;;
    esac
    exit 1 ;;
esac
shift
command=$(printf '%s' "$*" | sed "s#/srv/feed#$STATE/server/srv/feed#g")
# The real server is Linux. A Mac with no coreutils has only shasum.
command -v sha256sum >/dev/null || { sha256sum() { shasum -a 256 "$@"; }; export -f sha256sum; }
exec bash -c "$command"`);
    stub('scp', `
for last; do :; done
target=\${last#*:}
for file in "$@"; do
  [ "$file" = -q ] && continue
  [ "$file" = "$last" ] && continue
  cp "$file" "$STATE/server$target"
  case "\${FAKE_SCP_DAMAGES:-}" in "$(basename "$file")") printf x >> "$STATE/server$target/$(basename "$file")" ;; esac
done`);
    stub('curl', `
out=; write=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -w) write=$2; shift ;; -*) ;; *) url=$1 ;; esac; shift; done
name=\${url##*/}
file="$STATE/server${SERVER_FOLDER}/$name"
[ -z "\${FAKE_CURL_DOWN_AFTER_SCP:-}" ] || ! grep -q '^scp ' "$STATE/calls.log" || exit 7
if [ ! -f "$file" ]; then
  [ -n "$write" ] && { printf 404; exit 0; }
  exit 22
fi
cp "$file" "$out"
case "\${FAKE_HTTPS_DAMAGES:-}" in "$name") printf x >> "$out" ;; esac
[ -z "$write" ] || printf 200`);
  }

  async function artifacts(o: { version?: string; kind?: string; pinned?: string } = {}) {
    const options = { pinned: key.raw, version: '9.9.2', ...o };
    const win = path.join(state, 'artifacts', 'vibex-pca-installers-Windows');
    const linux = path.join(state, 'artifacts', 'vibex-pca-installers-Linux');
    mkdirSync(win, { recursive: true });
    mkdirSync(linux, { recursive: true });
    const work = path.join(dir, 'fixture');
    mkdirSync(work, { recursive: true });
    await windowsRelease(win, work, options);
    await linuxRelease(linux, work, options);
  }

  /// A full run of a pull request, as gh gives it. Each job and each long step is green unless a test says otherwise.
  function fullRun(change: (jobs: any[]) => void = () => undefined) {
    const steps = (names: string[]) => names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
    const jobs = [
      { name: 'installers (windows-latest)', status: 'completed', conclusion: 'success', steps: [] },
      { name: 'installers (ubuntu-24.04)', status: 'completed', conclusion: 'success', steps: [] },
      ...['windows-latest', 'ubuntu-24.04'].map((os) => ({ name: `tests (${os})`, status: 'completed', conclusion: 'success', steps: steps(['Test the installed app is locked', 'Close a live tab on the package', 'Test from source', 'Go checks with a real focus']) })),
    ];
    change(jobs);
    return { jobs };
  }

  /// A run of vibex-pca-fence.yml, as gh gives it while GitHub refuses artifact uploads: each job red from its upload step, and the
  /// steps that test and build green unless a test says otherwise.
  function fenceRun(change: (jobs: any[]) => void = () => undefined) {
    const job = (name: string, step: string, upload: string) => ({
      name,
      status: 'completed',
      conclusion: 'failure',
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success' },
        { name: step, status: 'completed', conclusion: 'success' },
        { name: upload, status: 'completed', conclusion: 'failure' },
      ],
    });
    const jobs = [
      job('linux-suite', 'Run the suite and the package checks in a container, under Xvfb', 'Keep the logs and the screenshots'),
      job('windows-installer', 'Cross-build the NSIS installer and read what it holds', 'Keep the proof of the installer'),
    ];
    change(jobs);
    return { jobs };
  }

  /// What the feed holds, before a run.
  function oldFeed(version = '9.9.1') {
    writeFileSync(path.join(feedDir, 'latest.yml'), `version: ${version}\npath: old.exe\n`);
    writeFileSync(path.join(feedDir, 'latest.yml.sig'), 'old signature\n');
    writeFileSync(path.join(feedDir, 'latest-linux.yml'), `version: ${version}\npath: old.AppImage\n`);
    writeFileSync(path.join(feedDir, 'latest-linux.yml.sig'), 'old linux signature\n');
    writeFileSync(path.join(feedDir, 'old.exe'), 'old installer');
    return snapshot();
  }
  const snapshot2 = () => Object.fromEntries(readdirSync(feedDir).sort().map((name) => [name, statSync(path.join(feedDir, name)).isDirectory() ? '' : readFileSync(path.join(feedDir, name), 'utf8')]));
  const snapshot = () => Object.fromEntries(readdirSync(feedDir).sort().map((name) => [name, readFileSync(path.join(feedDir, name), 'utf8')]));

  function run(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('bash', ['scripts/release.sh', ...args], {
      cwd: path.join(tree, 'electron'),
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBEX_UPDATE_KEY_FILE: keyFile, VIBEX_RELEASE_KEEP: keep, RELEASE_POLL_SECONDS: '0', VIBEX_FENCE_HOST: 'root@fence.invalid', ...env },
    });
    const calls = existsSync(path.join(state, 'calls.log')) ? readFileSync(path.join(state, 'calls.log'), 'utf8') : '';
    return { ...r, out: r.stdout + r.stderr, calls };
  }

  test.beforeEach(async () => {
    dir = tempDir('vibex-release-');
    tree = path.join(dir, 'tree');
    state = path.join(dir, 'state');
    bin = path.join(dir, 'bin');
    feedDir = path.join(state, 'server', SERVER_FOLDER);
    mkdirSync(tree);
    mkdirSync(bin);
    mkdirSync(state);
    mkdirSync(feedDir, { recursive: true });
    keep = path.join(dir, 'kept-releases');
    writeFileSync(path.join(state, 'full-run.json'), JSON.stringify(fullRun()));
    writeFileSync(path.join(state, 'fence-run.json'), JSON.stringify(fenceRun()));
    keyFile = path.join(dir, 'made-up-key.pem');
    writeFileSync(keyFile, key.pem, { mode: 0o600 });
    makeStubs();
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const dryRunSpendsNothing = (r: ReturnType<typeof run>, before: Record<string, string>, head: string) => {
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(readFileSync(path.join(tree, 'electron', 'package.json'), 'utf8')).version).not.toBe('9.9.2');
    expect(git('tag', '--list').trim()).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain', '--', 'electron/package.json', 'electron/package-lock.json').trim()).toBe('');
    expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
    expect(r.calls).not.toMatch(/^gh workflow/m);
    expect(r.calls).toContain('gh release download vibex-pca-v9.9.2');
    expect(r.calls).not.toMatch(/^gh run download/m);
    expect(r.calls).not.toMatch(/^gh release (create|edit|upload|delete)/m);
    expect(r.calls).not.toMatch(/^scp /m);
    expect(snapshot()).toEqual(before);
    expect(r.out).toMatch(/Dry run/);
    expect(r.out).toMatch(/9\.9\.2/);
    expect(r.out).toMatch(/nothing went to the feed/i);
    expect(r.out).not.toContain('PRIVATE');
    expect(r.out).not.toContain(key.pem.split('\n')[1]);
  };

  test('--dry-run with a run id is refused: a run keeps no installers since the storage limit, the draft release of its tag does', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const r = run(['--dry-run', '4141']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/takes a tag/);
    expect(r.calls).not.toMatch(/^gh (run|release) download/m);
    expect(snapshot()).toEqual(before);
  });

  test('--dry-run with a tag finds the run of that tag, judges and signs its draft release, and spends nothing', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--dry-run', 'vibex-pca-v9.9.2'], { FAKE_OLD_TAG_RUN: '1' });
    dryRunSpendsNothing(r, before, head);
    expect(r.calls).toMatch(/gh run list .*--branch vibex-pca-v9\.9\.2/);
  });

  test('--dry-run with a plain version, or with nothing, is refused: it never makes a version', () => {
    makeTree();
    for (const args of [['9.9.2', '--dry-run'], ['--dry-run']]) {
      const r = run(args);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/takes a tag/);
      expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
    }
  });

  test('--dry-run of a proof build stops at the gate, unsigned, and it spends nothing', async () => {
    makeTree();
    await artifacts({ kind: 'proof' });
    const before = oldFeed();
    const r = run(['--dry-run', 'vibex-pca-v9.9.2'], { FAKE_OLD_TAG_RUN: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/proof build/);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(snapshot()).toEqual(before);
  });

  test('a tag with no release, a release of another run, or a release with no appimage-gate.tar.gz stops it before the gate', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    for (const [env, said] of [
      [{ FAKE_NO_RELEASE: '1' }, /has no release on GitHub/],
      [{ FAKE_RELEASE_RUN: '9999' }, /not made by run 4141/],
      [{ FAKE_NO_GATE_TAR: '1' }, /no appimage-gate\.tar\.gz/],
    ] as const) {
      const r = run(['--dry-run', 'vibex-pca-v9.9.2'], { FAKE_OLD_TAG_RUN: '1', ...env });
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(said);
      expect(r.out).not.toMatch(/Gate passed/);
      expect(snapshot()).toEqual(before);
    }
  });

  test('the real run asks nothing, swaps the feed, checks each file by SHA-256 over HTTPS, and leaves no temp folder', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const r = run(['9.9.2']);
    expect(r.status, r.out).toBe(0);
    const after = readdirSync(feedDir);
    for (const name of ['Vibex-PCA-9.9.2-win-x64.exe', 'Vibex-PCA-9.9.2-win-x64.exe.blockmap', 'Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'Vibex-PCA-9.9.2-linux-amd64.deb', 'latest.yml', 'latest.yml.sig', 'latest-linux.yml', 'latest-linux.yml.sig']) expect(after, name).toContain(name);
    // Only the old pair of this release stays, so a bad release can be taken off the feed (--put-back).
    expect(after.filter((name) => name.startsWith('.'))).toEqual(['.previous-9.9.2']);
    expect(readFileSync(path.join(feedDir, '.previous-9.9.2', 'latest.yml'), 'utf8')).toContain('version: 9.9.1');
    // The app that is out there can still download what it read a moment ago.
    expect(after).toContain('old.exe');
    expect(readFileSync(path.join(feedDir, 'latest.yml'), 'utf8')).toContain('version: 9.9.2');
    const { verifyFeedSignature } = require('../src/main/updateSign');
    expect(verifyFeedSignature(readFileSync(path.join(feedDir, 'latest.yml')), readFileSync(path.join(feedDir, 'latest.yml.sig'), 'utf8'), key.raw)).toBe(true);
    expect(verifyFeedSignature(readFileSync(path.join(feedDir, 'latest-linux.yml')), readFileSync(path.join(feedDir, 'latest-linux.yml.sig'), 'utf8'), key.raw)).toBe(true);
    // Each file came back over HTTPS, and the installers before the yml went live.
    const https = r.calls.split('\n').filter((line) => line.startsWith('curl -fsS'));
    expect(https.length).toBe(8);
    const swap = r.calls.search(/mv -f '[^']*\.incoming-9\.9\.2\/latest/);
    expect(swap).toBeGreaterThan(0);
    expect(r.calls.indexOf('Vibex-PCA-9.9.2-win-x64.exe', r.calls.indexOf('curl -fsS'))).toBeLessThan(swap);
    expect(r.calls.lastIndexOf('curl -fsS')).toBeGreaterThan(swap);
    expect(r.out).toMatch(/Verified at the feed: 8 of 8/);
    expect(r.out).toMatch(/Version 9\.9\.2 is on the feed/);
    // The steps of the first walk need this address for the hand install.
    expect(r.out).toContain(`${FEED}Vibex-PCA-9.9.2-win-x64.exe`);
    expect(r.out).toMatch(/run 4040/);
    expect(r.out).not.toContain('PRIVATE');
  });

  test('an empty feed is the first release, and it goes through', async () => {
    makeTree();
    await artifacts();
    const r = run(['9.9.2']);
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(feedDir)).toContain('latest.yml');
  });

  const refusedBeforeAnyPush = (r: ReturnType<typeof run>, why: RegExp) => {
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(why);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.calls).not.toMatch(/^git push/m);
    expect(r.calls).not.toMatch(/^gh /m);
    expect(r.calls).not.toMatch(/^scp /m);
  };

  test('a dirty tree is refused, tracked or new, before anything else', () => {
    makeTree();
    const before = oldFeed();
    writeFileSync(path.join(tree, 'electron', 'scripts', 'release.sh'), `${readFileSync(path.join(tree, 'electron', 'scripts', 'release.sh'), 'utf8')}\n# a change\n`);
    refusedBeforeAnyPush(run(['9.9.2']), /uncommitted/);
    git('checkout', '--', '.');
    writeFileSync(path.join(tree, 'new-file.txt'), 'x');
    refusedBeforeAnyPush(run(['9.9.2']), /uncommitted/);
    expect(snapshot()).toEqual(before);
  });

  for (const [name, version, feedVersion] of [['the same version as the feed', '9.9.2', '9.9.2'], ['a lower version', '9.9.1', '9.9.2'], ['a version with a suffix', '9.9.3-beta', '9.9.2'], ['no version shape at all', 'next', '9.9.2']] as const) {
    test(`${name} is refused`, () => {
      makeTree();
      oldFeed(feedVersion);
      refusedBeforeAnyPush(run([version]), /version/i);
    });
  }

  test('a version that is not above the version in the tree is refused', () => {
    makeTree();
    const version = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
    refusedBeforeAnyPush(run([version]), /version/i);
  });

  test('a feed that cannot be read stops it: an unknown feed version is not a clean one', () => {
    makeTree();
    stub('curl', 'exit 7');
    refusedBeforeAnyPush(run(['9.9.2']), /could not read the feed/i);
  });

  test('another branch is refused: a release is on main', () => {
    makeTree();
    for (const branch of ['develop', 'feat/pca-release', 'feat/pca-native-chat']) {
      git('checkout', '-q', '-b', branch);
      refusedBeforeAnyPush(run(['9.9.2']), /only from main\b|\bmain\b/);
    }
  });

  const refusedAtTheTestRun = (r: ReturnType<typeof run>, why: RegExp) => {
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(why);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
    expect(r.calls).not.toMatch(/^scp /m);
  };

  test('no full run of the pull request for this commit: refused, whatever a tag run said', () => {
    makeTree();
    oldFeed();
    const r = run(['9.9.2'], { FAKE_NO_FULL_RUN: '1', FAKE_OLD_TAG_RUN: '1' });
    refusedAtTheTestRun(r, /no full test run/i);
    expect(r.calls).toMatch(/gh run list .*--event pull_request/);
  });

  for (const [name, env, why] of [
    ['a red full run', { FAKE_FULL_CONCLUSION: 'failure' }, /run 4040.*failure/],
    ['a cancelled full run', { FAKE_FULL_CONCLUSION: 'cancelled' }, /run 4040.*cancelled/],
    ['a full run that still runs', { FAKE_FULL_STATUS: 'in_progress', FAKE_FULL_CONCLUSION: '' }, /run 4040.*has not ended/],
  ] as const) {
    test(`${name} is refused`, () => {
      makeTree();
      oldFeed();
      refusedAtTheTestRun(run(['9.9.2'], env), why);
    });
  }

  for (const [name, change, why] of [
    ['a green run with the long suite skipped', (jobs: any[]) => { jobs[2].steps.find((s: any) => s.name === 'Test from source').conclusion = 'skipped'; }, /Test from source/],
    ['a green run with a job gone', (jobs: any[]) => { jobs.splice(3, 1); }, /tests \(ubuntu-24\.04\)/],
    ['a green run with a red job', (jobs: any[]) => { jobs[3].conclusion = 'failure'; }, /tests \(ubuntu-24\.04\)/],
    ['a green run with no Go check', (jobs: any[]) => { jobs[3].steps = jobs[3].steps.filter((s: any) => s.name !== 'Go checks with a real focus'); }, /Go checks/],
  ] as const) {
    test(`${name} is not a full run`, () => {
      makeTree();
      oldFeed();
      writeFileSync(path.join(state, 'full-run.json'), JSON.stringify(fullRun(change)));
      refusedAtTheTestRun(run(['9.9.2']), why);
    });
  }

  test('a code commit above the green one is refused: the run must be for this exact commit', () => {
    makeTree();
    oldFeed();
    const green = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(tree, 'electron', 'scripts', 'extra.txt'), 'new code');
    git('add', 'electron/scripts/extra.txt');
    git('commit', '-q', '-m', 'an untested change');
    refusedAtTheTestRun(run(['9.9.2'], { FAKE_GREEN_SHA: green }), /no full test run/i);
  });

  const versionCommit = (version: string, also?: () => void) => {
    const electron = path.join(tree, 'electron');
    for (const file of ['package.json', 'package-lock.json']) {
      const data = JSON.parse(readFileSync(path.join(electron, file), 'utf8'));
      data.version = version;
      if (data.packages?.['']) data.packages[''].version = version;
      writeFileSync(path.join(electron, file), `${JSON.stringify(data, null, 2)}\n`);
    }
    also?.();
    git('add', '-A', '--', 'electron/package.json', 'electron/package-lock.json', 'electron/scripts');
    git('commit', '-q', '-m', `Vibex PCA ${version}`);
  };

  test('the commit of an earlier release counts as tested when it changed the version and nothing else: the next release of the same code', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const green = git('rev-parse', 'HEAD').trim();
    versionCommit('9.9.1');
    const r = run(['9.9.2'], { FAKE_GREEN_SHA: green });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(green.slice(0, 10));
  });

  test('a commit named as a release that changes anything else does not count', () => {
    makeTree();
    oldFeed();
    const green = git('rev-parse', 'HEAD').trim();
    versionCommit('9.9.1', () => writeFileSync(path.join(tree, 'electron', 'scripts', 'extra.txt'), 'hidden code'));
    refusedAtTheTestRun(run(['9.9.2'], { FAKE_GREEN_SHA: green }), /no full test run/i);
    git('reset', '-q', '--hard', green);
    const electron = path.join(tree, 'electron');
    const data = JSON.parse(readFileSync(path.join(electron, 'package.json'), 'utf8'));
    data.version = '9.9.1';
    data.scripts = { ...data.scripts, postinstall: 'node hidden.js' };
    writeFileSync(path.join(electron, 'package.json'), JSON.stringify(data, null, 2));
    git('add', '--', 'electron/package.json');
    git('commit', '-q', '-m', 'Vibex PCA 9.9.1');
    refusedAtTheTestRun(run(['9.9.2'], { FAKE_GREEN_SHA: green }), /no full test run/i);
  });

  test('a merge commit counts only when its files are the same as the tested head it merged', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const base = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'feat/x');
    writeFileSync(path.join(tree, 'electron', 'scripts', 'extra.txt'), 'tested');
    git('add', 'electron/scripts/extra.txt');
    git('commit', '-q', '-m', 'the tested head');
    const tested = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge PR', 'feat/x');
    const same = run(['9.9.2'], { FAKE_GREEN_SHA: tested });
    expect(same.status, same.out).toBe(0);
    expect(same.out).toContain(tested.slice(0, 10));
    // Back, and a merge with other files in it.
    git('reset', '-q', '--hard', base);
    git('tag', '-d', 'vibex-pca-v9.9.2');
    rmSync(path.join(state, 'calls.log'));
    writeFileSync(path.join(tree, 'electron', 'scripts', 'base-moved.txt'), 'untested');
    git('add', 'electron/scripts/base-moved.txt');
    git('commit', '-q', '-m', 'the base moved');
    git('merge', '-q', '--no-ff', '-m', 'Merge PR', 'feat/x');
    refusedAtTheTestRun(run(['9.9.3'], { FAKE_GREEN_SHA: tested }), /no full test run/i);
  });

  test('a gh with a stale login stops step 1, before a version is spent', () => {
    makeTree();
    oldFeed();
    const r = run(['9.9.2'], { FAKE_GH_DOWN: '1' });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/gh .*log|gh auth login/i);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
  });

  test('a tree that differs from GitHub is refused: a release is what is on GitHub', () => {
    makeTree();
    refusedBeforeAnyPush(run(['9.9.2'], { FAKE_REMOTE_HEAD: '0123456789012345678901234567890123456789' }), /GitHub/);
  });

  test('a tag that exists is refused', () => {
    makeTree();
    git('tag', 'vibex-pca-v9.9.2');
    refusedBeforeAnyPush(run(['9.9.2']), /tag/);
    git('tag', '-d', 'vibex-pca-v9.9.2');
    writeFileSync(path.join(state, 'remote-tag'), '');
    refusedBeforeAnyPush(run(['9.9.2']), /tag/);
  });

  test('no signing key stops it before any minute is spent', () => {
    makeTree();
    refusedBeforeAnyPush(run(['9.9.2'], { VIBEX_UPDATE_KEY_FILE: path.join(dir, 'absent.pem') }), /signing key/);
  });

  test('a release can never accept a test key: with the owner\'s public key pinned, a made-up key stops it at once', () => {
    makeTree(OWNER_PUBLIC_KEY);
    refusedBeforeAnyPush(run(['9.9.2']), /signing key .*pinned/);
  });

  test('a server the script cannot reach stops it before any minute is spent', () => {
    makeTree();
    stub('ssh', 'exit 255');
    refusedBeforeAnyPush(run(['9.9.2']), /server/);
  });

  test('a push that fails leaves the tree as it was', () => {
    makeTree();
    const head = git('rev-parse', 'HEAD');
    const r = run(['9.9.2'], { FAKE_PUSH_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/push/i);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('tag', '--list').trim()).toBe('');
    expect(JSON.parse(readFileSync(path.join(tree, 'electron', 'package.json'), 'utf8')).version).not.toBe('9.9.2');
  });

  test('a failed push keeps a peer\'s uncommitted line, and undoes only its own commit, version and tag', () => {
    makeTree();
    const head = git('rev-parse', 'HEAD');
    const peer = path.join(tree, 'electron', 'scripts', 'update-proof.sh');
    const r = run(['9.9.2'], { FAKE_PUSH_FAIL: '1', FAKE_PEER_EDIT: peer });
    expect(r.status).not.toBe(0);
    expect(readFileSync(peer, 'utf8')).toContain('a peer line');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('tag', '--list').trim()).toBe('');
    expect(git('status', '--porcelain', '--', 'electron/package.json', 'electron/package-lock.json').trim()).toBe('');
    expect(readFileSync(path.join(electronDir, 'scripts', 'release.sh'), 'utf8')).not.toContain('reset -q --hard');
    expect(readFileSync(path.join(electronDir, 'scripts', 'release.sh'), 'utf8')).not.toMatch(/reset [^\n]*--hard/);
  });

  for (const [what, env] of [['commit', { FAKE_COMMIT_FAIL: '1' }], ['tag', { FAKE_TAG_FAIL: '1' }]] as const) {
    test(`a failed ${what} leaves the version and the branch as they were, and says so`, () => {
      makeTree();
      const head = git('rev-parse', 'HEAD');
      const r = run(['9.9.2'], env);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(new RegExp(`the ${what} did not work`));
      expect(r.out).toMatch(/Nothing went to the feed/);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain', '--', 'electron/package.json', 'electron/package-lock.json').trim()).toBe('');
      expect(git('tag', '--list').trim()).toBe('');
    });
  }

  test('a red hosted job stops it, and nothing goes to the feed', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const r = run(['9.9.2'], { FAKE_RUN_RESULT: 'completed failure' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/hosted job/);
    expect(r.out).toMatch(/4141/);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.calls).not.toContain('gh run download');
    expect(r.calls).not.toContain('gh release download');
    expect(snapshot()).toEqual(before);
  });

  test('a proof build in the artifact stops it at the gate, unsigned, and nothing goes to the feed', async () => {
    makeTree();
    await artifacts({ kind: 'proof' });
    const before = oldFeed();
    const r = run(['9.9.2']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/proof build/);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.calls).not.toMatch(/^scp /m);
    expect(snapshot()).toEqual(before);
  });

  test('a build of another version in the artifact is refused', async () => {
    makeTree();
    await artifacts({ version: '9.9.1' });
    const before = oldFeed('9.9.0');
    const r = run(['9.9.2']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/9\.9\.1/);
    expect(snapshot()).toEqual(before);
  });

  test('an upload damaged on the way stops before the feed changes, and leaves no temp folder', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const r = run(['9.9.2'], { FAKE_SCP_DAMAGES: 'Vibex-PCA-9.9.2-win-x64.exe' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Vibex-PCA-9\.9\.2-win-x64\.exe/);
    expect(r.out).not.toMatch(/Nothing went to the feed/);
    expect(r.out).toMatch(/latest\.yml: version 9\.9\.1/);
    expect(r.out).toMatch(/needs no repair/);
    expect(snapshot()).toEqual(before);
  });

  test('an installer that reads wrong over HTTPS stops before the yml changes, and the new files leave again', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const r = run(['9.9.2'], { FAKE_HTTPS_DAMAGES: 'Vibex-PCA-9.9.2-linux-amd64.deb' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Vibex-PCA-9\.9\.2-linux-amd64\.deb/);
    expect(snapshot()).toEqual(before);
  });

  test('a yml that reads wrong over HTTPS after the swap: the old pair comes back, and nothing partial stays', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const r = run(['9.9.2'], { FAKE_HTTPS_DAMAGES: 'latest-linux.yml.sig' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/put back/);
    expect(r.out).not.toMatch(/Nothing went to the feed/);
    expect(r.out).toMatch(/latest\.yml: version 9\.9\.1/);
    expect(snapshot()).toEqual(before);
  });

  /// As B3 measured: the swap is done, a read fails, and the restore fails too.
  const restoreFails = () => {
    const real = readFileSync(path.join(bin, 'ssh'), 'utf8');
    writeFileSync(path.join(bin, 'ssh'), real.replace('command=$(printf', `if [ ! -f "$STATE/restore-works" ]; then case "$*" in *"cat .swapped"*) exit 1 ;; esac; fi\ncommand=$(printf`));
  };

  test('the swap is done and the restore fails: it says what the feed holds, and the command that puts it right works', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    restoreFails();
    const r = run(['9.9.2'], { FAKE_HTTPS_DAMAGES: 'latest-linux.yml.sig' });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toMatch(/Nothing went to the feed/);
    expect(r.out).toMatch(/could not be put back/);
    expect(r.out).toMatch(/latest\.yml: version 9\.9\.2/);
    expect(r.out).toMatch(/latest-linux\.yml: version 9\.9\.2/);
    expect(r.out).toMatch(/\.incoming-9\.9\.2/);
    expect(r.out).toMatch(/\.previous-9\.9\.2/);
    expect(r.out).toContain('electron/scripts/publish-update.sh --put-back 9.9.2');
    expect(r.out).toMatch(/stay on GitHub/);
    // The command it names, when the server answers again.
    writeFileSync(path.join(state, 'restore-works'), '');
    const fix = spawnSync('bash', ['scripts/publish-update.sh', '--put-back', '9.9.2'], { cwd: path.join(tree, 'electron'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBEX_UPDATE_KEY_FILE: keyFile } });
    expect(fix.status, fix.stdout + fix.stderr).toBe(0);
    expect(fix.stdout).toMatch(/latest\.yml: version 9\.9\.1/);
    const after = snapshot2();
    expect(after['latest.yml']).toBe(before['latest.yml']);
    expect(after['latest.yml.sig']).toBe(before['latest.yml.sig']);
    expect(after['latest-linux.yml']).toBe(before['latest-linux.yml']);
    expect(Object.keys(after).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test('a live feed file that is a link stops the publish: root never reads or writes through it', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const hostFile = path.join(dir, 'host-file');
    const secret = 'version: 9.9.1\npath: old.exe\n# HOST SECRET\n'; // reads as a feed file, so only the link check can stop it
    writeFileSync(hostFile, secret);
    rmSync(path.join(feedDir, 'latest.yml'));
    symlinkSync(hostFile, path.join(feedDir, 'latest.yml'));
    const r = run(['9.9.2']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/is a link/);
    expect(readFileSync(hostFile, 'utf8')).toBe(secret);
    expect(lstatSync(path.join(feedDir, 'latest.yml')).isSymbolicLink()).toBe(true);
    const copied = path.join(feedDir, '.previous-9.9.2', 'latest.yml');
    expect(existsSync(copied)).toBe(false);
  });

  test('a feed that cannot be read after a failure says that, not a guess', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const r = run(['9.9.2'], { FAKE_SCP_DAMAGES: 'latest.yml', FAKE_CURL_DOWN_AFTER_SCP: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toMatch(/Nothing went to the feed/);
    expect(r.out).toMatch(/latest\.yml: could not be read/);
    expect(r.out).not.toMatch(/needs no repair/);
  });

  test('--put-back takes a whole bad release off the feed, and on a release before any swap it touches no live file', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    expect(run(['9.9.2']).status).toBe(0);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBEX_UPDATE_KEY_FILE: keyFile };
    const putBack = () => spawnSync('bash', ['scripts/publish-update.sh', '--put-back', '9.9.2'], { cwd: path.join(tree, 'electron'), encoding: 'utf8', env });
    const fix = putBack();
    expect(fix.status, fix.stdout + fix.stderr).toBe(0);
    expect(readFileSync(path.join(feedDir, 'latest.yml'), 'utf8')).toBe(before['latest.yml']);
    // A folder left by an upload that never reached the swap: no marker, so the live pair stays.
    mkdirSync(path.join(feedDir, '.previous-9.9.2'));
    mkdirSync(path.join(feedDir, '.incoming-9.9.2'));
    const quiet = putBack();
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(readFileSync(path.join(feedDir, 'latest.yml'), 'utf8')).toBe(before['latest.yml']);
    expect(existsSync(path.join(feedDir, '.incoming-9.9.2'))).toBe(false);
    // A word that is not a version never reaches the server.
    const calls = readFileSync(path.join(state, 'calls.log'), 'utf8').length;
    const bad = spawnSync('bash', ['scripts/publish-update.sh', '--put-back', "1.2.3'; rm -rf /"], { cwd: path.join(tree, 'electron'), encoding: 'utf8', env });
    expect(bad.status).not.toBe(0);
    expect(readFileSync(path.join(state, 'calls.log'), 'utf8').length).toBe(calls);
  });

  test('after a release the last 2 versions of the installers stay, the older ones and older .previous folders leave, and a name it does not know stays', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const old = (v: string) => [`Vibex-PCA-${v}-win-x64.exe`, `Vibex-PCA-${v}-win-x64.exe.blockmap`, `Vibex-PCA-${v}-linux-x86_64.AppImage`, `Vibex-PCA-${v}-linux-amd64.deb`];
    for (const v of ['9.8.0', '9.9.0', '9.9.1', '9.10.0-note']) for (const name of old(v)) writeFileSync(path.join(feedDir, name), 'old');
    writeFileSync(path.join(feedDir, 'readme.txt'), 'stays');
    mkdirSync(path.join(feedDir, '.previous-9.9.1'));
    const r = run(['9.9.2']);
    expect(r.status, r.out).toBe(0);
    const after = readdirSync(feedDir);
    for (const name of old('9.9.1')) expect(after, name).toContain(name);
    for (const name of old('9.9.0').concat(old('9.8.0'))) expect(after, name).not.toContain(name);
    for (const name of old('9.10.0-note')) expect(after, name).toContain(name);
    expect(after).toContain('readme.txt');
    expect(after).toContain('old.exe');
    expect(after.filter((name) => name.startsWith('.'))).toEqual(['.previous-9.9.2']);
    expect(r.out).toMatch(/Verified at the feed: 8 of 8/);
  });

  test('a release and its prune touch only Vibex-PCA names: the files of the Mac updater in the same folder stay, byte for byte', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const mac: Record<string, string> = {
      'vibex-mac.json': '{"version":"1.0.0"}',
      'vibex-mac.json.sig': 'mac signature',
      'Vibex-1.0.0-mac.zip': 'mac zip',
      'Vibex-0.1.0-mac.zip': 'an older mac zip',
      '.mac-incoming-1.0.0/Vibex-1.0.0-mac.zip': 'mac upload',
      '.mac-previous-1.0.0/vibex-mac.json': 'old mac pointer',
      '.mac-previous-0.1.0/vibex-mac.json': 'older mac pointer',
    };
    for (const [name, text] of Object.entries(mac)) {
      mkdirSync(path.dirname(path.join(feedDir, name)), { recursive: true });
      writeFileSync(path.join(feedDir, name), text);
    }
    for (const v of ['9.8.0', '9.9.0', '9.9.1']) writeFileSync(path.join(feedDir, `Vibex-PCA-${v}-win-x64.exe`), 'old');
    mkdirSync(path.join(feedDir, '.previous-9.9.1'));
    const check = () => { for (const [name, text] of Object.entries(mac)) expect(readFileSync(path.join(feedDir, name), 'utf8'), name).toBe(text); };
    const r = run(['9.9.2']);
    expect(r.status, r.out).toBe(0);
    check();
    const after = readdirSync(feedDir);
    // The prune did run in this test.
    expect(after).not.toContain('Vibex-PCA-9.8.0-win-x64.exe');
    expect(after).not.toContain('Vibex-PCA-9.9.0-win-x64.exe');
    expect(after).toContain('Vibex-PCA-9.9.1-win-x64.exe');
    expect(after).not.toContain('.previous-9.9.1');
    // The way back touches them no more than the release.
    const fix = spawnSync('bash', ['scripts/publish-update.sh', '--put-back', '9.9.2'], { cwd: path.join(tree, 'electron'), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBEX_UPDATE_KEY_FILE: keyFile } });
    expect(fix.status, fix.stdout + fix.stderr).toBe(0);
    check();
  });

  test('a prune that fails says so, and the release stands', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    for (const v of ['9.8.0', '9.9.0']) writeFileSync(path.join(feedDir, `Vibex-PCA-${v}-win-x64.exe`), 'old');
    const real = readFileSync(path.join(bin, 'ssh'), 'utf8');
    writeFileSync(path.join(bin, 'ssh'), real.replace('command=$(printf', `case "$*" in *"Vibex-PCA-9.8.0"*) exit 1 ;; esac\ncommand=$(printf`));
    const r = run(['9.9.2']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/older installers .* stay/i);
    expect(r.out).toMatch(/Version 9\.9\.2 is on the feed/);
  });

  test('the local signed copy stays after a release, also after a failed one, and leaves only at the next release', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const failed = run(['9.9.2'], { FAKE_SCP_DAMAGES: 'latest.yml' });
    expect(failed.status).not.toBe(0);
    expect(readdirSync(path.join(keep, '9.9.2'))).toContain('latest.yml.sig');
    rmSync(path.join(state, 'pushed'));
    // Same bytes as a higher version: a new run of the script, with a new artifact.
    rmSync(path.join(state, 'artifacts'), { recursive: true });
    await artifacts({ version: '9.9.3' });
    const first = run(['9.9.3']);
    expect(first.status, first.out).toBe(0);
    expect(readdirSync(keep)).toEqual(['9.9.3']);
    expect(readdirSync(path.join(keep, '9.9.3'))).toEqual(expect.arrayContaining(['latest.yml', 'latest.yml.sig', 'Vibex-PCA-9.9.3-win-x64.exe']));
    expect(first.out).toContain(path.join(keep, '9.9.3'));
    // A name in the folder that is no release stays.
    writeFileSync(path.join(keep, 'note.txt'), 'x');
    rmSync(path.join(state, 'artifacts'), { recursive: true });
    await artifacts({ version: '9.9.4' });
    expect(run(['9.9.4']).status).toBe(0);
    expect(readdirSync(keep).sort()).toEqual(['9.9.4', 'note.txt']);
  });

  test('on an empty feed the same failure leaves it empty again', async () => {
    makeTree();
    await artifacts();
    const r = run(['9.9.2'], { FAKE_HTTPS_DAMAGES: 'latest.yml' });
    expect(r.status).not.toBe(0);
    expect(snapshot()).toEqual({});
  });

  // --fence: the build on the owner's own build host, for when hosted jobs cannot be used. The ssh stand-in plays the fence.
  const fenceCalls = (calls: string) => calls.split('\n').filter((line) => /^ssh .*: fence-/.test(line)).map((line) => /: (fence-[a-z]+);/.exec(line)![1]);
  const kept = (version = '9.9.2') => path.join(keep, version);

  test('--fence: judged by the fence run\'s steps, built on the fence from the version commit, signed, pushed after the build, and stopped before any upload', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const start = git('rev-parse', 'HEAD').trim();
    const r = run(['--fence', '9.9.2']);
    expect(r.status, r.out).toBe(0);
    // The test proof is the fence run 5050, whose jobs are red from a refused upload and whose two steps are green.
    expect(r.calls).toMatch(/gh run list .*--workflow vibex-pca-fence\.yml --event pull_request/);
    expect(r.calls).not.toMatch(/--workflow vibex-pca\.yml/);
    expect(r.out).toMatch(/Tested by run 5050/);
    // The fence: read first, then the code, the build, the files back, and the room given back. The host of VIBEX_FENCE_HOST.
    expect(fenceCalls(r.calls)).toEqual(['fence-check', 'fence-receive', 'fence-pull', 'fence-run', 'fence-follow', 'fence-follow', 'fence-send', 'fence-clean']);
    // Detached, with the labels that keep the deployed CI runner from removing it, and no mu-ci-repo label (its reap would read one).
    const start_ = r.calls.split('\n').find((line) => line.includes(': fence-run;'))!;
    expect(start_).toContain("docker ps -q --filter label=mu-ci-runner=1)\" ]; then echo 'a CI job runs'; exit 3; fi");
    expect(start_.indexOf('docker ps -q --filter label=mu-ci-runner=1')).toBeLessThan(start_.indexOf('docker run'));
    expect(start_).not.toContain('--rm');
    expect(start_).not.toContain('mu-ci-repo');
    expect(r.calls).toMatch(/^ssh .*root@fence\.invalid : fence-run;.*sudo -E -u ci docker run -d --name 'vibex-pca-release-9\.9\.2' --label mu-ci-runner=1 --label mu-ci-name=vibex-pca-release -v '\/home\/ci\/vibex-pca-release-9\.9\.2\/src:\/src:ro' -v '\/home\/ci\/vibex-pca-release-9\.9\.2\/out:\/out'.*electronuserland\/builder:wine timeout 7200 bash \/src\/electron\/scripts\/fence-release-build\.sh$/m);
    expect(r.calls).toMatch(/: fence-clean;.*docker rmi electronuserland\/builder:wine.*rm -rf|: fence-clean;.*rm -rf '\/home\/ci\/vibex-pca-release-9\.9\.2'.*docker rmi electronuserland\/builder:wine/);
    expect(existsSync(path.join(state, 'fence-cleaned'))).toBe(true);
    // What reached the fence is the version commit, whole: package.json says 9.9.2, and the build script is in it.
    const listing = execFileSync('tar', ['-tf', path.join(state, 'fence-src.tar')], { encoding: 'utf8' });
    expect(listing).toContain('electron/scripts/fence-release-build.sh');
    const sent = JSON.parse(execFileSync('tar', ['-xOf', path.join(state, 'fence-src.tar'), 'electron/package.json'], { encoding: 'utf8' }));
    expect(sent.version).toBe('9.9.2');
    expect(git('log', '-1', '--format=%s').trim()).toBe('Vibex PCA 9.9.2');
    expect(git('rev-parse', 'HEAD~1').trim()).toBe(start);
    expect(git('tag', '--list').trim()).toBe('vibex-pca-v9.9.2');
    // The push comes after the build and the gate, so a failed build spends no version.
    expect(r.calls.indexOf('git push')).toBeGreaterThan(r.calls.lastIndexOf(': fence-follow;'));
    // The log came over by the follow calls, each line once.
    expect(r.out.split('the made-up build log').length - 1).toBe(1);
    expect(r.out).toContain('the build ended');
    expect(r.calls).toMatch(/^git push --atomic .* HEAD:refs\/heads\/main refs\/tags\/vibex-pca-v9\.9\.2$/m);
    // No wait for the hosted job of the tag, and nothing on the feed.
    expect(r.calls).not.toMatch(/--event push/);
    expect(r.calls).not.toMatch(/^scp /m);
    expect(r.calls).not.toMatch(/^gh release/m);
    expect(snapshot()).toEqual(before);
    // The signed copy waits in the kept folder, with the yml, the blockmap, the gate's files, the logs and what it was built from.
    const files = readdirSync(kept());
    for (const name of ['Vibex-PCA-9.9.2-win-x64.exe', 'Vibex-PCA-9.9.2-win-x64.exe.blockmap', 'Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'Vibex-PCA-9.9.2-linux-amd64.deb', 'latest.yml', 'latest.yml.sig', 'latest-linux.yml', 'latest-linux.yml.sig', 'appimage-gate', 'build.log', 'proof.txt', 'fence-ssh.log', 'fence-release.txt']) expect(files, name).toContain(name);
    const { verifyFeedSignature } = require('../src/main/updateSign');
    expect(verifyFeedSignature(readFileSync(path.join(kept(), 'latest.yml')), readFileSync(path.join(kept(), 'latest.yml.sig'), 'utf8'), key.raw)).toBe(true);
    const info = readFileSync(path.join(kept(), 'fence-release.txt'), 'utf8');
    expect(info).toContain(`commit ${git('rev-parse', 'HEAD').trim()}`);
    expect(info).toContain('tested-run 5050');
    expect(info).toContain('image electronuserland/builder@sha256:made-up-digest');
    const { createHash } = require('node:crypto');
    for (const name of ['latest.yml', 'latest-linux.yml']) expect(info).toContain(`sha512-${name} ${createHash('sha512').update(readFileSync(path.join(kept(), name))).digest('hex')}`);
    expect(r.out).toMatch(/Gate passed: Vibex-PCA-9\.9\.2-win-x64\.exe/);
    expect(r.out).toMatch(/NOT on the feed/);
    expect(r.out).toContain(path.join(kept(), 'Vibex-PCA-9.9.2-win-x64.exe'));
    expect(r.out).toContain('electron/scripts/release.sh --publish-kept 9.9.2');
    expect(r.out).toContain('electronuserland/builder@sha256:made-up-digest');
    expect(r.out).not.toMatch(/Version 9\.9\.2 is on the feed/);
    expect(r.out).not.toContain('PRIVATE');
  });

  test('--fence with VIBEX_FENCE_HOST goes to that host only', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const r = run(['--fence', '9.9.2'], { VIBEX_FENCE_HOST: 'ci@other.invalid' });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toMatch(/^ssh .*ci@other\.invalid : fence-run;/m);
    expect(r.calls).not.toContain('fence.invalid');
  });

  test('--fence with no VIBEX_FENCE_HOST starts nothing: the repository names no host', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const r = run(['--fence', '9.9.2'], { VIBEX_FENCE_HOST: '' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/STOPPED: --fence needs VIBEX_FENCE_HOST/);
    expect(r.calls).not.toMatch(/^ssh /m);
    expect(existsSync(path.join(state, 'pushed'))).toBe(false);
  });

  const refusedBeforeTheFence = (r: ReturnType<typeof run>, why: RegExp) => {
    refusedAtTheTestRun(r, why);
    expect(r.calls).not.toMatch(/: fence-(receive|pull|run);/);
    expect(git('tag', '--list').trim()).toBe('');
  };

  for (const [name, env, change, why] of [
    ['no fence run of the pull request, whatever the hosted full run said', { FAKE_NO_FENCE_RUN: '1' }, undefined, /no fence test run of the pull request/],
    ['a fence run that still runs', { FAKE_FENCE_STATUS: 'in_progress' }, undefined, /fence test run 5050 .*has not ended/],
    ['a fence run whose suite step failed', {}, (jobs: any[]) => { jobs[0].steps[1].conclusion = 'failure'; }, /linux-suite, the step Run the suite .* ended as failure/],
    ['a fence run whose Windows build step failed', {}, (jobs: any[]) => { jobs[1].steps[1].conclusion = 'failure'; }, /windows-installer, the step Cross-build the NSIS installer .* ended as failure/],
    ['a fence run whose suite step was skipped', {}, (jobs: any[]) => { jobs[0].steps[1].conclusion = 'skipped'; }, /ended as skipped/],
    ['a fence run with no Windows job', {}, (jobs: any[]) => { jobs.splice(1, 1); }, /no job windows-installer/],
  ] as const) {
    test(`--fence: ${name} is refused before the fence`, async () => {
      makeTree();
      await artifacts();
      oldFeed();
      if (change) writeFileSync(path.join(state, 'fence-run.json'), JSON.stringify(fenceRun(change)));
      refusedBeforeTheFence(run(['--fence', '9.9.2'], env), why);
    });
  }

  test('--fence: a code commit above the tested one is refused, as in the hosted mode', async () => {
    makeTree();
    oldFeed();
    const tested = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(tree, 'electron', 'scripts', 'extra.txt'), 'new code');
    git('add', 'electron/scripts/extra.txt');
    git('commit', '-q', '-m', 'an untested change');
    refusedBeforeTheFence(run(['--fence', '9.9.2'], { FAKE_GREEN_SHA: tested }), /no fence test run/);
  });

  for (const [name, env, why] of [
    ['under 9 GB free on the fence', { FAKE_FENCE_FREE_KB: String(8 * 1024 * 1024) }, /8 GB free in \/home\/ci, and a release build needs 9 GB/],
    ['a fence that runs a CI job now', { FAKE_FENCE_BUSY: '1' }, /runs 1 container/],
    ['a fence that does not answer', { FAKE_FENCE_DOWN: '1' }, /fence .* cannot be read/],
  ] as const) {
    test(`--fence: ${name} stops it before the version commit`, async () => {
      makeTree();
      await artifacts();
      const before = oldFeed();
      const head = git('rev-parse', 'HEAD');
      const r = run(['--fence', '9.9.2'], env);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(why);
      expect(fenceCalls(r.calls)).toEqual(['fence-check']);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('tag', '--list').trim()).toBe('');
      expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
      expect(snapshot()).toEqual(before);
    });
  }

  const fenceUndone = (r: ReturnType<typeof run>, head: string, before: Record<string, string>) => {
    expect(r.status, r.out).not.toBe(0);
    expect(r.calls).not.toMatch(/^git push/m);
    expect(r.calls).not.toMatch(/^scp /m);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('tag', '--list').trim()).toBe('');
    expect(git('status', '--porcelain', '--', 'electron/package.json', 'electron/package-lock.json').trim()).toBe('');
    expect(r.out).toMatch(/never pushed, and they are gone/);
    expect(r.out).toMatch(/Nothing went to the feed/);
    expect(r.out).not.toMatch(/stay on GitHub/);
    // The room on the fence is given back after a failure too.
    expect(fenceCalls(r.calls).at(-1)).toBe('fence-clean');
    expect(existsSync(path.join(state, 'fence-cleaned'))).toBe(true);
    expect(snapshot()).toEqual(before);
  };

  test('--fence: a failed build spends no version, brings its log back, and gives the fence its room back', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_BUILD_FAIL: '1' });
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/the build on the fence failed/);
    expect(readFileSync(path.join(kept(), 'build.log'), 'utf8')).toContain('FAIL: made up');
  });

  test('--fence: a proof build from the fence stops at the gate, before the push', async () => {
    makeTree();
    await artifacts({ kind: 'proof' });
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2']);
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/proof build/);
  });

  test('--fence: a build of another version is refused before the push', async () => {
    makeTree();
    await artifacts({ version: '9.9.1' });
    const before = oldFeed('9.9.0');
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2']);
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/the fence built 9\.9\.1/);
  });

  test('--fence: a push that fails after the build undoes its own commit and tag, and uploads nothing', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_PUSH_FAIL: '1' });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/the push to GitHub did not work/);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('tag', '--list').trim()).toBe('');
    expect(snapshot()).toEqual(before);
    // Its kept copy was never pushed, so --publish-kept refuses it.
    const p = run(['--publish-kept', '9.9.2']);
    expect(p.status, p.out).not.toBe(0);
    expect(p.out).toMatch(/tag vibex-pca-v9\.9\.2 on GitHub is not the commit/);
    expect(snapshot()).toEqual(before);
  });

  test('--fence: a CI job that started since step 1 stops it at the start of the build, with the version undone and the fence cleaned', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_CI_STARTED: '1' });
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/the build did not start on the fence\. If a CI job started there since step 1/);
    expect(fenceCalls(r.calls)).not.toContain('fence-follow');
  });

  test('--fence: too little room after the image pull stops it before the build', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_FREE_AFTER_PULL_KB: String(5 * 1024 * 1024) });
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/after the image, the fence has 5242880 KB free/);
    expect(fenceCalls(r.calls)).not.toContain('fence-run');
  });

  test('--fence: a connection that drops for a while does not lose the build', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_DROP: '3' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/did not answer \(3 of 10\)/);
    expect(fenceCalls(r.calls).filter((c) => c === 'fence-follow').length).toBe(5);
    expect(r.out).toMatch(/NOT on the feed/);
  });

  test('--fence: a connection that stays down stops it, undone, and still asks the fence to clean up', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_DROP: '99' });
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/did not answer 10 times in a row/);
    expect(fenceCalls(r.calls).filter((c) => c === 'fence-follow').length).toBe(10);
  });

  test('--fence: a container that is gone when it ended (a reap or a next job) is judged by the exit code it left in /out', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    const ok = run(['--fence', '9.9.2'], { FAKE_FENCE_GONE: '1' });
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toMatch(/NOT on the feed/);
  });

  test('--fence: a gone container with a failed exit code is a failed build', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    const r = run(['--fence', '9.9.2'], { FAKE_FENCE_GONE: '1', FAKE_FENCE_BUILD_FAIL: '1' });
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/the build on the fence failed \(gone, exit code 1\)/);
  });

  test('--fence: a Ctrl-C during the gate and the signing undoes the local commit and tag, and pushes nothing', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    const head = git('rev-parse', 'HEAD');
    // A node that passes everything through, and sends the Ctrl-C to release.sh at the first signature.
    const realNode = process.execPath;
    stub('node', `if [ "$1" = scripts/update-release.mjs ] && [ "$2" = sign ] && [ ! -f "$STATE/interrupted" ]; then
  touch "$STATE/interrupted"
  kill -INT "$(ps -o ppid= -p $PPID | tr -d ' ')"
fi
exec '${realNode}' "$@"`);
    const r = run(['--fence', '9.9.2']);
    expect(existsSync(path.join(state, 'interrupted'))).toBe(true);
    fenceUndone(r, head, before);
    expect(r.out).toMatch(/STOPPED: interrupted/);
  });

  test('--publish-kept refuses a kept copy whose installers and yml were replaced after --fence judged them, even by a build the gate would pass', async () => {
    makeTree();
    await artifacts();
    const before = oldFeed();
    expect(run(['--fence', '9.9.2']).status).toBe(0);
    // Another valid release build of the same version: the gate alone would let it through.
    await windowsRelease(kept(), path.join(dir, 'fixture'), { pinned: key.raw, version: '9.9.2', extra: '// other bytes' });
    const r = run(['--publish-kept', '9.9.2']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/latest\.yml in .* is not the file that --fence judged and signed/);
    expect(r.calls).not.toMatch(/^scp /m);
    expect(snapshot()).toEqual(before);
  });

  test('--publish-kept uploads the copy that --fence kept, as a release does, and builds or pushes nothing', async () => {
    makeTree();
    await artifacts();
    oldFeed();
    expect(run(['--fence', '9.9.2']).status).toBe(0);
    rmSync(path.join(state, 'calls.log'));
    writeFileSync(path.join(keep, '9.9.1'), 'an older kept copy');
    const r = run(['--publish-kept', '9.9.2']);
    expect(r.status, r.out).toBe(0);
    const after = readdirSync(feedDir);
    for (const name of ['Vibex-PCA-9.9.2-win-x64.exe', 'Vibex-PCA-9.9.2-win-x64.exe.blockmap', 'Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'Vibex-PCA-9.9.2-linux-amd64.deb', 'latest.yml', 'latest.yml.sig', 'latest-linux.yml', 'latest-linux.yml.sig']) expect(after, name).toContain(name);
    expect(after.filter((name) => name.startsWith('.'))).toEqual(['.previous-9.9.2']);
    const { verifyFeedSignature } = require('../src/main/updateSign');
    expect(verifyFeedSignature(readFileSync(path.join(feedDir, 'latest.yml')), readFileSync(path.join(feedDir, 'latest.yml.sig'), 'utf8'), key.raw)).toBe(true);
    expect(r.out).toMatch(/Verified at the feed: 8 of 8/);
    expect(r.out).toMatch(/Version 9\.9\.2 is on the feed/);
    expect(r.out).toContain(`${FEED}Vibex-PCA-9.9.2-win-x64.exe`);
    expect(r.out).toMatch(/Tested by run 5050, and built on the fence from commit [0-9a-f]{10} with electronuserland\/builder@sha256:made-up-digest/);
    expect(r.out).toContain(`The signed copy stays in ${kept()}`);
    expect(r.calls).not.toMatch(/: fence-/);
    expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
    expect(r.calls).not.toMatch(/^gh /m);
    // The older kept copy leaves, as after a hosted release.
    expect(readdirSync(keep)).toEqual(['9.9.2']);
  });

  test('--publish-kept refuses a missing kept copy, one with a yml gone, and a version not above the feed, and uploads nothing', async () => {
    makeTree();
    await artifacts();
    let before = oldFeed();
    const missing = run(['--publish-kept', '9.9.2']);
    expect(missing.status, missing.out).not.toBe(0);
    expect(missing.out).toMatch(/no kept copy of version 9\.9\.2/);
    expect(missing.out).toMatch(/Nothing went to the feed/);
    expect(missing.calls).not.toMatch(/^scp /m);
    expect(snapshot()).toEqual(before);
    expect(run(['--fence', '9.9.2']).status).toBe(0);
    rmSync(path.join(kept(), 'latest-linux.yml'));
    const gone = run(['--publish-kept', '9.9.2']);
    expect(gone.status, gone.out).not.toBe(0);
    expect(gone.out).toMatch(/has no latest-linux\.yml/);
    expect(snapshot()).toEqual(before);
    before = oldFeed('9.9.2');
    const same = run(['--publish-kept', '9.9.2']);
    expect(same.status, same.out).not.toBe(0);
    expect(same.out).toMatch(/not above the version on the feed, 9\.9\.2/);
    expect(snapshot()).toEqual(before);
  });

  test('--fence and --publish-kept take one plain version, and no other mode with them', () => {
    makeTree();
    for (const args of [['--fence'], ['--fence', 'next'], ['--publish-kept'], ['--fence', '--dry-run', '9.9.2'], ['--fence', '--publish-kept', '9.9.2'], ['--fence', '9.9.2', '9.9.3'], ['--go', '9.9.2']]) {
      const r = run(args);
      expect(r.status, `${args.join(' ')}: ${r.out}`).not.toBe(0);
      expect(r.out).toMatch(/version|not two|unknown option/);
      expect(r.calls).not.toMatch(/^git (push|commit|tag)/m);
      expect(r.calls).not.toMatch(/: fence-/);
    }
  });
});

test.describe('the hosted job a release waits for', () => {
  const yml = readFileSync(path.join(electronDir, '..', '.github', 'workflows', 'vibex-pca.yml'), 'utf8');
  const script = readFileSync(path.join(electronDir, 'scripts', 'release.sh'), 'utf8');

  test('a tag starts it, from the tag\'s own copy: no workflow on main is needed', () => {
    expect(yml).toMatch(/tags: \['vibex-pca-v\*'\]/);
    expect(script).not.toContain('gh workflow run');
    expect(script).toContain('vibex-pca-v');
  });

  test('what a release asks of the full run is what the workflow has: no step name of the check drifts from the file', () => {
    const steps = readFileSync(path.join(electronDir, 'scripts', 'update-release.mjs'), 'utf8').match(/FULL_RUN_STEPS = \[([^\]]*)\]/)![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1));
    expect(steps.length).toBeGreaterThan(3);
    for (const name of steps) expect(yml, name).toContain(`name: ${name}`);
    expect(yml).toMatch(/pull_request:\n\s+branches: \[main\]/);
    expect(script).toContain('--event pull_request');
  });

  test('a tag does not spend the long suites, and keeps the smoke test of the package', () => {
    const steps = yml.split(/\n(?=      - )/);
    const step = (name: string) => steps.find((s) => s.includes(`name: ${name}`))!;
    for (const name of ['Test from source', 'Go checks with a real focus']) expect(step(name), name).toContain("!startsWith(github.ref, 'refs/tags/')");
    expect(step('Test the whole suite on the package (manual run)')).toContain("github.event_name == 'workflow_dispatch'");
    expect(step('Close a live tab on the package')).not.toContain('refs/tags');
  });

  test('the installers job runs the gate on what it uploads, on both systems, and takes the AppImage apart first', () => {
    const job = yml.slice(yml.indexOf('  installers:'), yml.indexOf('  tests:'));
    expect(job.indexOf('appimage-gate release')).toBeLessThan(job.indexOf('name: Keep the installers for the next jobs'));
    expect(job).toContain('electron/release/appimage-gate/');
    expect(job.indexOf('update-release.mjs gate release')).toBeGreaterThan(job.indexOf('name: Keep the installers for the next jobs'));
  });

  test('the packaged tests on Windows stay off the real feed', () => {
    const job = yml.slice(yml.indexOf('  tests:'));
    expect(job).toMatch(/drivers\\etc\\hosts/);
    expect(job.indexOf('drivers\\etc\\hosts')).toBeLessThan(job.indexOf('name: Test the installed app is locked'));
  });
});

// the storage limit: the artifact storage of the account is 500 MB for all repos together, and one run of installers was 430 MB.
test.describe('no installer is a run artifact; a tag puts them on a draft release', () => {
  const workflows = path.join(electronDir, '..', '.github', 'workflows');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const yaml = require('js-yaml');
  const flow = (name: string) => yaml.load(readFileSync(path.join(workflows, name), 'utf8'));
  const uploads = (wf: any) => Object.entries<any>(wf.jobs).flatMap(([job, j]) => (j.steps || []).filter((s: any) => String(s.uses || '').startsWith('actions/upload-artifact')).map((s: any) => ({ job, ...s })));

  test('each artifact of each PCA workflow keeps 3 days or less, and none holds an installer: anyone can download an artifact of a public repository', () => {
    let count = 0;
    for (const name of readdirSync(workflows).filter((n) => n.startsWith('vibex-pca'))) {
      for (const step of uploads(flow(name))) {
        count++;
        const days = Number(step.with?.['retention-days']);
        expect(days, `${name} ${step.name}`).toBeGreaterThan(0);
        expect(days, `${name} ${step.name}`).toBeLessThanOrEqual(3);
        expect(String(step.with?.path), `${name} ${step.name}`).not.toMatch(/\.(exe|deb|AppImage)\b|vibex-pca-installers|\.win-out\s*$/m);
      }
    }
    // 1 in vibex-pca.yml, 2 in the fence, 1 in the update proof. A count of 0 would pass every check above.
    expect(count).toBe(4);
  });

  test('the installers go from job to job in the cache of the run, with the same files on both sides', () => {
    const wf = flow('vibex-pca.yml');
    const save = wf.jobs.installers.steps.find((s: any) => s.uses === 'actions/cache/save@v4');
    const restores = [...wf.jobs.tests.steps, ...wf.jobs['release-assets'].steps].filter((s: any) => s.uses === 'actions/cache/restore@v4');
    expect(save.with.key).toBe('vibex-pca-installers-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(restores).toHaveLength(3);
    for (const r of restores) {
      // A cache is found only by the same path list and the same archive kind.
      expect(r.with.path).toBe(save.with.path);
      expect(r.with.enableCrossOsArchive).toBe(true);
      expect(r.with['fail-on-cache-miss']).toBe(true);
      expect(r.with.key).toContain('${{ github.run_id }}');
    }
    expect(save.with.enableCrossOsArchive).toBe(true);
    for (const file of ['*.exe', '*.deb', '*.AppImage', '*.blockmap', 'latest.yml', 'latest-linux.yml', 'appimage-gate/']) expect(save.with.path).toContain(`electron/release/${file}`);
  });

  test('only the release job holds a write token, only on a tag, and it runs no code of the repo', () => {
    const wf = flow('vibex-pca.yml');
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries<any>(wf.jobs)) if (name !== 'release-assets') expect(job.permissions, name).toBeUndefined();
    const job = wf.jobs['release-assets'];
    expect(job.permissions).toEqual({ contents: 'write' });
    expect(job.needs).toBe('installers');
    expect(job.if).toContain("startsWith(github.ref, 'refs/tags/vibex-pca-v')");
    expect(job.if).toContain("needs.installers.result == 'success'");
    const text = JSON.stringify(job.steps);
    expect(text).not.toMatch(/actions\/checkout|npm |npx |node |publish-update|scp |ssh /);
    expect(text).toContain('--draft');
  });

  // The script of the release job, run with a made-up gh in a temp folder.
  function releaseJob(o: { existing?: string; dropSize?: string; missing?: string } = {}) {
    const work = tempDir('vibex-release-assets-');
    const files = path.join(work, 'release');
    const bin = path.join(work, 'bin');
    mkdirSync(path.join(files, 'appimage-gate', 'resources'), { recursive: true });
    mkdirSync(bin);
    for (const name of ['Vibex-PCA-9.9.2-win-x64.exe', 'Vibex-PCA-9.9.2-win-x64.exe.blockmap', 'Vibex-PCA-9.9.2-linux-amd64.deb', 'Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'latest.yml', 'latest-linux.yml', 'appimage-gate/appimage.sha512', 'appimage-gate/resources/app.asar']) {
      if (name !== o.missing) writeFileSync(path.join(files, name), `made-up ${name}\n`);
    }
    const assets = path.join(work, 'assets');
    mkdirSync(assets);
    if (o.existing !== undefined) writeFileSync(path.join(work, 'body'), o.existing);
    writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> '${work}/calls.log'
case "$1 $2" in
  "release view")
    case "$*" in
      *body*) [ -f '${work}/body' ] || exit 1; cat '${work}/body'; exit 0 ;;
      *assets*) for f in '${assets}'/*; do n=$(basename "$f"); s=$(wc -c < "$f" | tr -d ' '); [ "$n" = "${o.dropSize ?? ''}" ] && s=1; echo "$n $s"; done; exit 0 ;;
    esac ;;
  "release create") printf '%s' "$*" > '${work}/body'; exit 0 ;;
  "release upload") shift 3; for f in "$@"; do [ "$f" = --clobber ] || cp "$f" '${assets}/'; done; exit 0 ;;
esac
exit 1
`);
    chmodSync(path.join(bin, 'gh'), 0o755);
    const step = flow('vibex-pca.yml').jobs['release-assets'].steps.find((s: any) => s.name === 'Put the installers on a draft release of the tag');
    const r = spawnSync('bash', ['-c', step.run], { cwd: files, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG: 'vibex-pca-v9.9.2', RUN: '4141' } });
    const calls = existsSync(path.join(work, 'calls.log')) ? readFileSync(path.join(work, 'calls.log'), 'utf8') : '';
    const out = { ...r, out: r.stdout + r.stderr, calls, assets: readdirSync(assets).sort() };
    rmSync(work, { recursive: true, force: true });
    return out;
  }

  test('a tag run makes one draft release that names its run, uploads 7 flat files, and reads each one back', () => {
    const r = releaseJob();
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toMatch(/^gh release create vibex-pca-v9\.9\.2 --draft --verify-tag .*Built by run 4141 of vibex-pca\.yml/m);
    expect(r.assets).toEqual(['Vibex-PCA-9.9.2-linux-amd64.deb', 'Vibex-PCA-9.9.2-linux-x86_64.AppImage', 'Vibex-PCA-9.9.2-win-x64.exe', 'Vibex-PCA-9.9.2-win-x64.exe.blockmap', 'appimage-gate.tar.gz', 'latest-linux.yml', 'latest.yml']);
    expect(r.out.match(/On the draft release/g)).toHaveLength(7);
  });

  test('a re-run of the same run replaces its files; a release of another run stays as it is', () => {
    const again = releaseJob({ existing: 'Built by run 4141 of vibex-pca.yml, from the tag vibex-pca-v9.9.2. A draft.' });
    expect(again.status, again.out).toBe(0);
    expect(again.calls).not.toMatch(/release create/);
    const other = releaseJob({ existing: 'Built by run 4000 of vibex-pca.yml, from the tag vibex-pca-v9.9.2.' });
    expect(other.status).not.toBe(0);
    expect(other.out).toMatch(/another run made it/);
    expect(other.calls).not.toMatch(/release (create|upload)/);
  });

  test('a missing file, or a file that reads back at another size, makes the job red', () => {
    const missing = releaseJob({ missing: 'latest-linux.yml' });
    expect(missing.status).not.toBe(0);
    expect(missing.out).toMatch(/no latest-linux\.yml came from the installers job/);
    expect(missing.calls).not.toMatch(/release (create|upload)/);
    const short = releaseJob({ dropSize: 'latest.yml' });
    expect(short.status).not.toBe(0);
    expect(short.out).toMatch(/latest\.yml is not on the release/);
  });
});

// release.sh --fence: what it reads of the fence workflow, and the build script it runs there.
test.describe('the fence build a release can use', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const yaml = require('js-yaml');
  const fenceFlow = yaml.load(readFileSync(path.join(electronDir, '..', '.github', 'workflows', 'vibex-pca-fence.yml'), 'utf8'));
  const script = readFileSync(path.join(electronDir, 'scripts', 'fence-release-build.sh'), 'utf8');

  test('each step release.sh --fence judges is in its job of vibex-pca-fence.yml: no name drifts from the file', () => {
    const source = readFileSync(path.join(electronDir, 'scripts', 'update-release.mjs'), 'utf8');
    const pairs = [...source.match(/FENCE_RUN_STEPS = \{([^}]*)\}/)![1].matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBe(2);
    for (const [job, step] of pairs) {
      expect(fenceFlow.jobs[job], job).toBeTruthy();
      expect(fenceFlow.jobs[job].steps.map((s: any) => s.name), `${job}: ${step}`).toContain(step);
      // The step itself must not be allowed to fail: its success is the proof.
      expect(fenceFlow.jobs[job].steps.find((s: any) => s.name === step)['continue-on-error'], step).toBeUndefined();
    }
    expect(fenceFlow.on.pull_request.branches).toEqual(['main']);
  });

  test('a refused artifact upload no longer turns a fence job red: every upload step may fail', () => {
    const uploads = Object.values<any>(fenceFlow.jobs).flatMap((j) => j.steps.filter((s: any) => String(s.uses || '').startsWith('actions/upload-artifact')));
    expect(uploads.length).toBe(2);
    for (const step of uploads) expect(step['continue-on-error'], step.name).toBe(true);
  });

  test('the release build keeps latest*.yml and the blockmaps, builds Linux first, and takes the gate\'s files out of the AppImage', () => {
    expect(script).not.toMatch(/grep -E 'latest\|blockmap'/);
    expect(script.indexOf('--linux AppImage deb --x64 --publish never')).toBeGreaterThan(0);
    expect(script.indexOf('--linux AppImage deb')).toBeLessThan(script.indexOf('--win nsis --x64 --publish never'));
    expect(script.indexOf('appimage-gate release')).toBeLessThan(script.indexOf('@lydell/node-pty-win32-x64'));
    // The same pinned compiler and pty package as the proven Windows build of the fence job.
    const proven = readFileSync(path.join(electronDir, 'scripts', 'fence-windows-installer.sh'), 'utf8');
    for (const line of [/npm i --no-save --force @lydell\/node-pty-win32-x64@\S+/, /apt-get install -y -qq --no-install-recommends gcc-mingw[^\n]*/]) expect(script.match(line)![0]).toBe(proven.match(line)![0]);
  });

  // The script itself, in a real shell, with stand-ins for npm, npx, node and apt-get: what reaches /out, and in what order.
  function buildRun(o: { check?: number; noWinYml?: boolean } = {}) {
    const work = tempDir('vibex-fence-build-');
    const src = path.join(work, 'src');
    const bin = path.join(work, 'bin');
    const out = path.join(work, 'out');
    const log = path.join(work, 'calls.log');
    mkdirSync(path.join(src, 'electron', 'scripts'), { recursive: true });
    mkdirSync(bin);
    cpSync(path.join(electronDir, 'scripts', 'fence-release-build.sh'), path.join(src, 'electron', 'scripts', 'fence-release-build.sh'));
    for (const helper of ['askpass-win', 'presence-win']) {
      mkdirSync(path.join(src, 'electron', 'native', helper), { recursive: true });
      writeFileSync(path.join(src, 'electron', 'native', helper, 'build.sh'), `echo "helper ${helper} CC=$CC" >> '${log}'\n`);
    }
    const tool = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> '${log}'\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    tool('npm', `case "$1" in --version) echo 11.0.0 ;; i) mkdir -p node_modules/@lydell/node-pty-win32-x64 ;; esac`);
    tool('node', `case "$1" in
  --version) echo v22.12.0 ;;
  scripts/update-release.mjs) mkdir -p release/appimage-gate/resources && echo hash > release/appimage-gate/appimage.sha512 ;;
  scripts/check-windows-installer.cjs) echo "pass made-up check"; exit ${o.check ?? 0} ;;
esac`);
    tool('npx', `mkdir -p release
case "$*" in
  *--linux*) for f in Vibex-PCA-1.0.0-linux-x86_64.AppImage Vibex-PCA-1.0.0-linux-amd64.deb latest-linux.yml; do echo "$f" > "release/$f"; done ;;
  *--win*) mkdir -p release/win-unpacked; for f in Vibex-PCA-1.0.0-win-x64.exe Vibex-PCA-1.0.0-win-x64.exe.blockmap ${o.noWinYml ? '' : 'latest.yml'}; do echo "$f" > "release/$f"; done ;;
esac`);
    tool('apt-get', '');
    tool('wine', 'echo wine-9.0');
    // The container has sha256sum; a Mac has shasum.
    if (spawnSync('sha256sum', ['--version']).error) tool('sha256sum', 'shasum -a 256 "$@"');
    const r = spawnSync('bash', [path.join(src, 'electron', 'scripts', 'fence-release-build.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FENCE_SRC: src, FENCE_OUT: out, FENCE_BUILD: path.join(work, 'build') },
    });
    const result = { ...r, out: r.stdout + r.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8') : '', files: existsSync(out) ? readdirSync(out).sort() : [], read: (name: string) => readFileSync(path.join(out, name), 'utf8') };
    return { result, done: () => rmSync(work, { recursive: true, force: true }) };
  }

  test('a real run of the build script on made-up tools: Linux, then Windows, and every file the feed needs reaches /out', () => {
    const { result: r, done } = buildRun();
    try {
      expect(r.status, r.out).toBe(0);
      expect(r.files).toEqual(['SHA256.txt', 'Vibex-PCA-1.0.0-linux-amd64.deb', 'Vibex-PCA-1.0.0-linux-x86_64.AppImage', 'Vibex-PCA-1.0.0-win-x64.exe', 'Vibex-PCA-1.0.0-win-x64.exe.blockmap', 'appimage-gate', 'build.log', 'exit-code', 'latest-linux.yml', 'latest.yml', 'proof.txt']);
      expect(r.read('exit-code').trim()).toBe('0');
      expect(r.read('build.log')).toMatch(/== Room at the start:\n\S+[^\n]*\n[\s\S]*== Room at the end:/);
      const order = ['npm ci', 'npx electron-builder --linux AppImage deb --x64 --publish never', 'node scripts/update-release.mjs appimage-gate release', 'npm i --no-save --force @lydell/node-pty-win32-x64', 'apt-get install', 'helper askpass-win CC=x86_64-w64-mingw32-gcc-win32', 'helper presence-win CC=x86_64-w64-mingw32-gcc-win32', 'npx electron-builder --win nsis --x64 --publish never', 'node scripts/check-windows-installer.cjs release'];
      const at = order.map((step) => r.calls.indexOf(step));
      for (const [i, step] of order.entries()) expect(at[i], step).toBeGreaterThanOrEqual(0);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(r.read('proof.txt')).toContain('pass made-up check');
      expect(r.read('build.log')).toContain('== Windows');
      expect(r.read('SHA256.txt')).toMatch(/Vibex-PCA-1\.0\.0-win-x64\.exe/);
    } finally {
      done();
    }
  });

  test('a real run where the installer check fails, or the Windows build gives no latest.yml, ends red', () => {
    for (const o of [{ check: 1 }, { noWinYml: true }]) {
      const { result: r, done } = buildRun(o);
      try {
        expect(r.status, JSON.stringify(o)).not.toBe(0);
        expect(r.files).toContain('build.log');
        if (o.noWinYml) expect(r.read('build.log')).toMatch(/no latest\.yml/);
        // The exit code stays in /out for release.sh, when the container is gone already.
        expect(r.read('exit-code').trim()).not.toBe('0');
      } finally {
        done();
      }
    }
  });
});
