#!/bin/sh
# `fleetrc fleet` over real SSH, against sshd containers with key-only auth and a throwaway key.
#
#   sh test/envs/fleet.sh <tarball>
#
# Hosts (published on 127.0.0.1, rootless Docker):
#   sf-u2-h-ok      port 22221  fleetrc installed (init + self-install) as user `fleet`
#   sf-u2-h-bare    port 22222  node and git, no fleetrc (until `fleet init` sets it up)
#   sf-u2-h-nonode  port 22223  no node at all
#   127.0.0.1:22229             nothing listening
#   10.255.255.1                a blackhole, for --timeout
# The controller is a throwaway HOME on this machine. ssh reads ~/.ssh from the passwd entry, not
# $HOME, so the controller goes through FLEETRC_SSH, a wrapper that passes `-F` with its own
# config and known_hosts. A second controller runs in a container with plain `ssh` and ~/.ssh.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cli="$(cd "$here/../.." && pwd)/dist/cli.mjs"
T="${SF_FLEET_DIR:-$(mktemp -d /tmp/sf-fleet.XXXXXX)}"
mkdir -p "$T"
net=sf-u2-net

docker build -q -t sf-u2-sshd -f "$here/docker/sshd.Dockerfile" "$here/docker" >/dev/null
docker image inspect sf-u2-alpine22 >/dev/null 2>&1 || docker build -q -t sf-u2-alpine22 -f "$here/docker/alpine22.Dockerfile" "$here/docker" >/dev/null
docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null

rm -f "$T/key" "$T/key.pub"
ssh-keygen -q -t ed25519 -N '' -C sf-u2-throwaway -f "$T/key"

host() { # host <name> <port>
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" --hostname "$1" --network "$net" -p "127.0.0.1:$2:22" \
    -v "$tgz:/pkg/fleetrc.tgz:ro" sf-u2-sshd >/dev/null
  docker cp "$T/key.pub" "$1:/home/fleet/.ssh/authorized_keys"
  docker exec "$1" sh -c 'chown fleet /home/fleet/.ssh/authorized_keys && chmod 600 /home/fleet/.ssh/authorized_keys'
}
host sf-u2-h-ok 22221
host sf-u2-h-bare 22222
host sf-u2-h-nonode 22223
docker exec sf-u2-h-nonode sh -c 'rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack'

# The installed host: its own manifest with one local skill, then init and the launcher.
docker exec -u fleet sf-u2-h-ok sh -c '
set -e
cd ~ && mkdir -p .claude .fleetrc skills/host-skill
printf -- "---\nname: host-skill\ndescription: d\n---\n" > skills/host-skill/SKILL.md
echo "{\"sources\":[{\"id\":\"host\",\"local\":\"$HOME/skills\"}]}" > .fleetrc/manifest.json
npx -y --package /pkg/fleetrc.tgz -- fleetrc init ~ --no-hooks >/dev/null
npx -y --package /pkg/fleetrc.tgz -- fleetrc self-install'

# Wait for sshd.
for port in 22221 22222 22223; do
  i=0
  until ssh-keyscan -p "$port" 127.0.0.1 >/dev/null 2>&1 || [ $i -gt 20 ]; do i=$((i + 1)); sleep 0.5; done
done

# --- the controller on this machine --------------------------------------------------------------
H="$T/home"
rm -rf "$H"
mkdir -p "$H/.claude" "$H/l/c-skill"
printf -- '---\nname: c-skill\ndescription: d\n---\n' >"$H/l/c-skill/SKILL.md"
: >"$T/known_hosts"
for port in 22221 22222 22223; do ssh-keyscan -p "$port" 127.0.0.1 2>/dev/null >>"$T/known_hosts"; done
cat >"$T/ssh_config" <<EOF
Host alias-ok
  HostName 127.0.0.1
  Port 22221
  User fleet
Host alias-unknown-key
  HostName 127.0.0.1
  Port 22221
  User fleet
  UserKnownHostsFile $T/known_hosts.empty
Host *
  IdentityFile $T/key
  IdentitiesOnly yes
  UserKnownHostsFile $T/known_hosts
  GlobalKnownHostsFile /dev/null
EOF
: >"$T/known_hosts.empty"
cat >"$T/ssh" <<EOF
#!/bin/sh
exec ssh -F "$T/ssh_config" "\$@"
EOF
chmod +x "$T/ssh"

mkdir -p "$H/.fleetrc"
cat >"$H/.fleetrc/manifest.json" <<EOF
{ "sources": [{ "id": "l", "local": "$H/l" }],
  "fleet": ["ssh://fleet@127.0.0.1:22221", "ssh://fleet@127.0.0.1:22222", "ssh://fleet@127.0.0.1:22223"] }
EOF
sf() { env -i PATH="$PATH" HOME="$H" FLEETRC_SSH="$T/ssh" DO_NOT_TRACK=1 node "$cli" "$@"; }
sf init "$H" --no-hooks >/dev/null

pass=0
fail=0
# step <name> <grep pattern>... : runs the command in $cmd, prints its output, and passes when the
# exit code is $want and every pattern is in the output.
step() {
  name="$1"
  shift
  echo "--- $name"
  out="$(eval "$cmd" 2>&1)"
  code=$?
  printf '%s\nexit %s\n' "$out" "$code"
  missing=""
  for pattern in "$@"; do printf '%s' "$out" | grep -q -- "$pattern" || missing="$missing [$pattern]"; done
  if [ "$code" = "$want" ] && [ -z "$missing" ]; then pass=$((pass + 1)); echo "PASS $name"; else
    fail=$((fail + 1))
    echo "FAIL $name: exit $code (want $want)${missing:+, missing$missing}"
  fi
}

want=1 cmd='sf fleet status --timeout 10'
step "1. fleet status, ssh:// URLs with ports (ok, no fleetrc, no node)" \
  "22221: last run" "22222: fleetrc is not installed there" "22223: fleetrc is not installed there, and node is not on the PATH"
want=1 cmd='sf fleet sync --timeout 60'
step "2. fleet sync, same hosts" "22221: last run" "22222: fleetrc is not installed there" "22223: .*node is not on the PATH"
want=1 cmd='sf fleet status "fleet@127.0.0.1:22221" --timeout 10'
step "3. user@host:port, the way scp writes it" "has a port; write it as ssh://fleet@127.0.0.1:22221"
want=0 cmd='sf fleet sync alias-ok --timeout 30'
step "4. an ssh_config alias" "alias-ok: last run"
want=1 cmd='sf fleet status alias-unknown-key --timeout 10'
step "5. unknown host key" "unreachable (Host key verification failed"
want=1 cmd='sf fleet status "ssh://fleet@127.0.0.1:22229" "fleet@10.255.255.1" --timeout 3'
step "6. nothing listening, and a blackhole with --timeout 3" "Connection refused" "no answer within 3 s"
want=1 cmd='sf fleet sync alias-ok "ssh://fleet@127.0.0.1:22223" --timeout 30 --json'
step "7. two hosts, one failing, --json" '"host": "alias-ok"' '"ok": true' '"error": "fleetrc is not installed there, and node'
want=1 cmd='sf fleet upgrade alias-ok --timeout 60'
step "8. fleet upgrade from a development build" "development or preview build (0.0.0)"
want=1 cmd='sf fleet add "fleet@127.0.0.1:22221"'
step "9. fleet add with a port" "has a port; write it as ssh://fleet@127.0.0.1:22221"
grep -A4 '"fleet"' "$H/.fleetrc/manifest.json"

# A host whose sync fails for one source answers with its report: reachable, synced with errors.
docker exec -u fleet sf-u2-h-ok sh -c 'cd ~ && echo "{\"sources\":[{\"id\":\"host\",\"local\":\"$HOME/skills\"},{\"id\":\"gone\",\"local\":\"$HOME/gone\"}]}" > .fleetrc/manifest.json'
want=1 cmd='sf fleet sync alias-ok --timeout 30'
step "10. a host with one failing source is reachable, with errors" "alias-ok: last run .*, 1 skills, with errors"
want=1 cmd='sf fleet sync alias-ok --timeout 30 --json'
step "11. the same, --json" '"reachable": true' '"ok": false' '"gone: '

# --- a controller in a container with plain ssh ---------------------------------------------------
docker rm -f sf-u2-ctl >/dev/null 2>&1
ctl() {
  docker run --rm --name sf-u2-ctl --network "$net" -v "$tgz:/pkg/fleetrc.tgz:ro" \
  -e "KEY=$(cat "$T/key")" sf-u2-alpine22 sh -c '
set -e
mkdir -p ~/.ssh ~/.claude ~/l/c && printf "%s\n" "$KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
printf "Host okhost\n  HostName sf-u2-h-ok\n  Port 22\n  User fleet\n" > ~/.ssh/config
ssh-keyscan sf-u2-h-ok sf-u2-h-bare 2>/dev/null > ~/.ssh/known_hosts
printf -- "---\nname: c\ndescription: d\n---\n" > ~/l/c/SKILL.md
echo "{\"sources\":[{\"local\":\"$HOME/l\"}],\"fleet\":[\"okhost\",\"fleet@sf-u2-h-bare\"]}" > ~/m.json
npx -y --package /pkg/fleetrc.tgz -- fleetrc init ~/m.json --no-hooks >/dev/null
set +e
npx -y --package /pkg/fleetrc.tgz -- fleetrc fleet sync --timeout 60; echo "exit $?"
npx -y --package /pkg/fleetrc.tgz -- fleetrc fleet status; echo "exit $?"'
}
want=0 cmd=ctl
step "12. container controller, plain ssh, ~/.ssh/config with Port" "okhost: last run" "fleet@sf-u2-h-bare: fleetrc is not installed there"

# --- fleet init: a fresh host goes from no fleetrc to synced -----------------------------------
# The manifest is a repository on sf-u2-h-ok, which the controller reaches as alias-ok and the bare
# host as alias-ok in its own ~/.ssh/config: a manifest in a repository, as fleet init requires.
docker exec -u fleet sf-u2-h-ok sh -c '
set -e
cd ~ && rm -rf m.git m-work && git init -q --bare -b main m.git && git init -q -b main m-work && cd m-work
mkdir -p .fleetrc skills/team-skill
printf -- "---\nname: team-skill\ndescription: d\n---\n" > skills/team-skill/SKILL.md
echo "{\"agents\":[\"claude-code\"],\"sources\":[{\"id\":\"team\",\"git\":\"alias-ok:/home/fleet/m.git\",\"skills\":\"skills/*\"}]}" > .fleetrc/manifest.json
git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git push -q ../m.git main'
docker cp "$T/key" sf-u2-h-bare:/home/fleet/.ssh/id_ed25519
docker exec sf-u2-h-bare sh -c '
chown fleet /home/fleet/.ssh/id_ed25519 && chmod 600 /home/fleet/.ssh/id_ed25519
printf "Host alias-ok\n  HostName sf-u2-h-ok\n  User fleet\n" > /home/fleet/.ssh/config
ssh-keyscan sf-u2-h-ok 2>/dev/null > /home/fleet/.ssh/known_hosts
chown fleet /home/fleet/.ssh/config /home/fleet/.ssh/known_hosts && chmod 600 /home/fleet/.ssh/config /home/fleet/.ssh/known_hosts'
H2="$T/home2"
rm -rf "$H2"
mkdir -p "$H2/.claude"
spec="alias-ok:/home/fleet/m.git//.fleetrc/manifest.json"
sf2() { env -i PATH="$PATH" HOME="$H2" FLEETRC_SSH="$T/ssh" GIT_SSH_COMMAND="$T/ssh" FLEETRC_PACKAGE=/pkg/fleetrc.tgz DO_NOT_TRACK=1 node "$cli" "$@"; }
sf2 init "$spec" --no-hooks >"$T/init2.log" 2>&1 || { echo "controller init failed:"; cat "$T/init2.log"; }

want=0 cmd='sf2 fleet init "ssh://fleet@127.0.0.1:22222" --no-hooks --dry-run'
step "13. fleet init --dry-run names the command" "would run npx -y --package /pkg/fleetrc.tgz -- fleetrc init $spec --no-hooks --json"
want=0 cmd='sf2 fleet init "ssh://fleet@127.0.0.1:22222" --no-hooks --timeout 300'
step "14. fleet init sets up a host with no fleetrc" "22222: set up; last run .*, 1 skills" 'Add \["ssh://fleet@127.0.0.1:22222"\] to "fleet"'
want=0 cmd='docker exec -u fleet sf-u2-h-bare sh -c "cat ~/.config/fleetrc/config.json; ls ~/.claude/skills; ~/.local/state/fleetrc/bin/fleetrc status"'
step "15. the host has the manifest, the launcher and the skill" "$spec" "team-skill" "last run"
want=0 cmd='sf2 fleet init "ssh://fleet@127.0.0.1:22222" --timeout 120'
step "16. fleet init again only syncs" "22222: already set up; last run .*, 1 skills"
want=1 cmd='sf2 fleet init "ssh://fleet@127.0.0.1:22223" alias-ok --timeout 60'
step "17. no node, and a host with another manifest" "22223: .*install Node.js 22.12 or newer" "alias-ok: it has the manifest .*; pass --force"

if [ -z "${SF_KEEP:-}" ]; then
  docker rm -f sf-u2-h-ok sf-u2-h-bare sf-u2-h-nonode >/dev/null
  docker network rm "$net" >/dev/null
  rm -rf "$T"
fi
echo "SUMMARY pass=$pass fail=$fail"
