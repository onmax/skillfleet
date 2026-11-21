#!/bin/sh
# systemd as PID 1 (Ubuntu 24.04, Node 22): init, doctor's linger check with linger off, on, and
# with no login session, and what `timer install|status` do while @vite-hub/schedule/os is missing.
#
#   sh test/envs/systemd.sh <tarball>
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tgz="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
docker image inspect sf-u2-ubuntu22 >/dev/null 2>&1 || docker build -q -t sf-u2-ubuntu22 -f "$here/docker/ubuntu22.Dockerfile" "$here/docker" >/dev/null
docker build -q -t sf-u2-systemd -f "$here/docker/systemd.Dockerfile" "$here/docker" >/dev/null
docker rm -f sf-u2-systemd >/dev/null 2>&1
docker run -d -t --name sf-u2-systemd --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -e container=docker -v "$tgz:/pkg/fleetrc.tgz:ro" sf-u2-systemd >/dev/null
sleep 8
docker exec sf-u2-systemd systemctl is-system-running
SF=/home/ubuntu/.local/state/fleetrc/bin/fleetrc
docker exec sf-u2-systemd su - ubuntu -c '
mkdir -p ~/.claude ~/l/s1 && printf -- "---\nname: s1\ndescription: d\n---\n" > ~/l/s1/SKILL.md
echo "{\"sources\":[{\"local\":\"$HOME/l\"}]}" > ~/m.json
npx -y --package /pkg/fleetrc.tgz -- fleetrc init ~/m.json 2>&1 | tail -n 3
echo "--- doctor, linger off, logged in"; '"$SF"' doctor
echo "--- timer install"; '"$SF"' timer install; echo "exit $?"
echo "--- timer status"; '"$SF"' timer status; echo "exit $?"'
echo "--- doctor, linger on"
docker exec sf-u2-systemd sh -c "loginctl enable-linger ubuntu && sleep 2 && su - ubuntu -c '$SF doctor' | grep linger"
echo "--- doctor, linger off, no session (like cron or docker exec): expect FAIL, not 'skipped'"
docker exec sf-u2-systemd sh -c 'loginctl disable-linger ubuntu; loginctl terminate-user ubuntu; i=0; while loginctl show-user ubuntu >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done'
docker exec -u ubuntu -e HOME=/home/ubuntu sf-u2-systemd sh -c "loginctl show-user ubuntu --property=Linger; $SF doctor | grep linger"
docker rm -f sf-u2-systemd >/dev/null
