#!/bin/sh
# R7-3: two containers share one HOME through a bind mount, as two machines share an NFS home. A
# sync in A holds the lock (a hook that sleeps); a sync in B, in another pid namespace, must wait
# for it. On fix/round3 B prints "removed a stale sync lock: its sync (pid N) is gone" and both run.
#
#   sh test/envs/shared-home.sh <tarball>
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
docker image inspect sf-u2-alpine22 >/dev/null 2>&1 || docker build -q -t sf-u2-alpine22 -f "$here/docker/alpine22.Dockerfile" "$here/docker" >/dev/null
S=$(mktemp -d)
mkdir -p "$S/work/s1" "$S/.claude"
printf -- "---\nname: s1\ndescription: d\n---\nv1\n" > "$S/work/s1/SKILL.md"
g() { git -c user.name=a -c user.email=a@b "$@"; }
(cd "$S/work" && g init -q -b main && g add -A && g commit -qm v1 && g init -q --bare -b main ../up.git && g push -q ../up.git main)
cat > "$S/m.json" <<'EOF'
{ "agents": ["claude-code"],
  "sources": [{ "id": "up", "git": "/shared/up.git" }],
  "hooks": [{ "name": "slow", "run": "sleep 40", "on": ["up:**"] }] }
EOF
for c in a b; do
  docker run -d --name "sf-u2-shared-$c" -u root -e HOME=/shared -v "$S:/shared" -v "$tgz:/pkg/fleetrc.tgz:ro" sf-u2-alpine22 sleep infinity >/dev/null
done
SF=/shared/.local/state/fleetrc/bin/fleetrc
docker exec sf-u2-shared-a sh -c "cd /shared && npx -y --package /pkg/fleetrc.tgz -- fleetrc init /shared/m.json --no-hooks >/dev/null 2>&1; echo init \$?"
(cd "$S/work" && echo v2 >> s1/SKILL.md && g commit -qam v2 && g push -q ../up.git main)
docker exec -d sf-u2-shared-a sh -c "$SF sync > /shared/a.out 2>&1"
sleep 5
echo "--- the lock A holds: $(cat "$S/.local/state/fleetrc/sync.lock")"
echo "--- sync in B while A runs its hook (expect: another fleetrc sync is running):"
docker exec sf-u2-shared-b sh -c "$SF sync; echo exit \$?"
docker rm -f sf-u2-shared-a sf-u2-shared-b >/dev/null
docker run --rm -u root -v "$S:/shared" sf-u2-alpine22 rm -rf /shared/.local /shared/.claude /shared/.agents /shared/.cache
rm -rf "$S"
