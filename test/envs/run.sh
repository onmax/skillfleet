#!/bin/sh
# Runs scenario.sh against a packed tarball in Linux containers.
#
#   sh test/envs/run.sh <tarball> [env...]
#
# Envs: alpine22 bookworm24-nogit ubuntu22 node20 node18 oddpaths noexec-tmp readonly-agent
#       pnpm-dlx global offline fleet systemd. With none, all of them run. Needs Docker (rootless
#       is fine; systemd needs --privileged, which rootless Docker maps to the user namespace).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
shift
envs="${*:-alpine22 bookworm24-nogit ubuntu22 node20 node18 oddpaths noexec-tmp readonly-agent pnpm-dlx global offline fleet systemd}"

image() { docker image inspect "$1" >/dev/null 2>&1 || docker build -q -t "$1" -f "$here/docker/$2.Dockerfile" "$here/docker" >/dev/null; }
image sf-u2-alpine22 alpine22
image sf-u2-ubuntu22 ubuntu22

# scenario <image> [docker run args...] -- [env for scenario.sh...]
scenario() {
  img="$1"
  shift
  dargs=""
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    dargs="$dargs $1"
    shift
  done
  [ "${1:-}" = "--" ] && shift
  # shellcheck disable=SC2086
  docker run --rm $dargs -v "$tgz:/pkg/fleetrc.tgz:ro" -v "$here:/envs:ro" \
    -e SF_TGZ=/pkg/fleetrc.tgz "$@" "$img" sh /envs/scenario.sh
}

for env in $envs; do
  echo "=== $env"
  case "$env" in
    alpine22) scenario sf-u2-alpine22 -- ;;
    bookworm24-nogit) scenario node:24-bookworm-slim -u node -- ;;
    ubuntu22) scenario sf-u2-ubuntu22 -- ;;
    node20) scenario node:20-alpine -u node -- ;;
    node18) docker run --rm -u node -v "$tgz:/pkg/fleetrc.tgz:ro" node:18-alpine sh -c \
      'cd ~ && npx -y --package /pkg/fleetrc.tgz -- fleetrc --version; echo "exit $?"' ;;
    oddpaths) scenario sf-u2-alpine22 -- -e "SF_HOME=/home/node/hö me ü/x y" -e "SF_SRV=/home/node/srv with space/ñ" ;;
    noexec-tmp) scenario sf-u2-alpine22 --tmpfs /tmp:rw,noexec,nosuid,size=64m -- ;;
    readonly-agent) scenario sf-u2-alpine22 -- -e SF_RO=.gemini/skills ;;
    pnpm-dlx) scenario sf-u2-alpine22 -- -e SF_RUNNER=pnpm-dlx ;;
    global) scenario sf-u2-alpine22 -u root -- -e SF_RUNNER=global -e SF_HOME=/root ;;
    offline) sh "$here/offline.sh" "$tgz" ;;
    fleet) sh "$here/fleet.sh" "$tgz" ;;
    systemd) sh "$here/systemd.sh" "$tgz" ;;
    *) echo "unknown env $env" ;;
  esac
done
