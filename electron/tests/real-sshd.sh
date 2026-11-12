#!/bin/sh
# Runs the "through a real sshd" part of tests/server-chat.spec.ts: an OpenSSH sshd as this user, on 127.0.0.1 only, with
# its own host key, one made-up client key, and a ForceCommand that gives the session a made-up home, so the real
# Claude of this computer never starts. Everything lives in one temporary folder, removed at the end.
# Usage (from electron/): sh tests/real-sshd.sh
set -eu
SSHD=${SSHD:-/usr/sbin/sshd}
[ -x "$SSHD" ] || { echo "no sshd at $SSHD"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/vpca-sshd.XXXXXX")
root=$(cd "$root" && pwd -P)
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT INT TERM
home="$root/home"
mkdir -p "$home/.local/bin" "$home/people/ali"
echo 'echo BANNER-FROM-PROFILE' > "$home/.profile"
node=$(command -v node)
cat > "$home/.local/bin/claude" <<EOF
#!/bin/sh
case "\$1" in --version) echo '2.1.318 (Claude Code)'; exit 0 ;; --help) echo 'Commands:'; exit 0 ;; esac
exec '$node' '$here/fake-claude.cjs' "\$@"
EOF
chmod 755 "$home/.local/bin/claude"
ssh-keygen -q -t ed25519 -N '' -f "$root/host" -C vpca-test-host
ssh-keygen -q -t ed25519 -N '' -f "$root/client" -C vpca-test-client
cp "$root/client.pub" "$root/authorized_keys"
port=$((40000 + $$ % 5000))
log="$root/claude.jsonl"
cat > "$root/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $root/host
PidFile $root/sshd.pid
AuthorizedKeysFile $root/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowTcpForwarding yes
AcceptEnv LANG LC_*
ClientAliveInterval 0
ForceCommand exec env HOME=$home SHELL=/bin/sh FAKE_CLAUDE_LOG=$log /bin/sh -c "\$SSH_ORIGINAL_COMMAND"
EOF
echo "[127.0.0.1]:$port $(cut -d' ' -f1-2 "$root/host.pub")" > "$root/known_hosts"
"$SSHD" -f "$root/sshd_config" -D -e 2> "$root/sshd.log" &
pid=$!
i=0
until ssh -n -o BatchMode=yes -o UserKnownHostsFile="$root/known_hosts" -o IdentitiesOnly=yes -i "$root/client" -p "$port" "$(id -un)@127.0.0.1" true 2>/dev/null; do
  i=$((i + 1)); [ $i -lt 50 ] || { echo 'sshd did not start:'; cat "$root/sshd.log"; exit 1; }
  sleep 0.2
done
VIBEX_REAL_SSHD=$(printf '{"port":%s,"user":"%s","key":"%s","knownHosts":"%s","home":"%s","log":"%s"}' "$port" "$(id -un)" "$root/client" "$root/known_hosts" "$home" "$log")
export VIBEX_REAL_SSHD
ELECTRON_OVERRIDE_DIST_PATH=${ELECTRON_OVERRIDE_DIST_PATH:-/nonexistent-electron} npx playwright test tests/server-chat.spec.ts -g 'through a real sshd' --reporter=line
