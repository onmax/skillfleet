# Linux environment scenarios

Run the packed tarball the way a user does after `npx fleetrc init`, in containers and over real
SSH. They print `PASS`/`FAIL` per step and keep going, so one run shows every break. The failing
cases they found are also in `test/linux-envs.test.ts`, which runs without Docker.

```sh
pnpm build && npm pack --pack-destination /tmp/sf     # or download https://pkg.pr.new/onmax/fleetrc@<sha>
sh test/envs/run.sh /tmp/sf/fleetrc-0.0.0.tgz            # every env
sh test/envs/run.sh /tmp/sf/fleetrc-0.0.0.tgz alpine22 fleet
```

| Env                | What it is                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `alpine22`         | `node:22.12-alpine` (musl, busybox, the minimum engine) with git                                                                        |
| `bookworm24-nogit` | `node:24-bookworm-slim`, no git: a local source plus a git source that has to fail                                                      |
| `ubuntu22`         | Ubuntu 24.04 with Node 22 from the nodejs.org tarball                                                                                   |
| `node20`, `node18` | below the engine range: what a user on an old Node sees                                                                                 |
| `oddpaths`         | HOME and the repositories under paths with spaces and Unicode                                                                           |
| `noexec-tmp`       | `/tmp` mounted `noexec`                                                                                                                 |
| `readonly-agent`   | `~/.gemini/skills` is read-only                                                                                                         |
| `pnpm-dlx`         | init through `pnpm dlx` instead of npx                                                                                                  |
| `global`           | `npm install -g` as root                                                                                                                |
| `offline`          | init online (a GitHub source and drop.vitehub.dev), then everything with `--network none`                                               |
| `fleet`            | `fleet status`, `sync`, `upgrade`, `init` and `add` against sshd containers on 127.0.0.1 ports; `fleet init` takes a bare one to synced |
| `systemd`          | systemd as PID 1: doctor's linger check and the timer commands                                                                          |
| `shared-home.sh`   | two containers share one HOME (an NFS home): a sync in one must hold off a sync in the other (R7-3); run it directly with the tarball   |

`scenario.sh` is the per-machine scenario: a local git manifest repository with two sources (a
`path` clone in `~/src/my skills` that adopts a hand-made skill, and a vendored one), init, an
upstream skill added, `add` refused for the remote manifest and the source added upstream instead,
a local edit and an upstream change to the same skill, an edit in the clone, then `status`, `list`,
`doctor`, `timer`, `sync --offline` and a look for an uninstall command. In a container without
systemd it checks that every timer command says so. It runs outside Docker too, against a throwaway
HOME; on a machine with systemd it passes `--timer` only with `SF_TIMER=1`:

```sh
SF_TGZ=/tmp/sf/fleetrc-0.0.0.tgz SF_HOME=/tmp/sf/home sh test/envs/scenario.sh
```

Never point `SF_HOME` at a real HOME: the scenario writes agent folders there.

The scripts make only `sf-u2-*` images, containers, a network and a volume. Remove them with:

```sh
docker ps -aq --filter name=sf-u2- | xargs -r docker rm -f
docker network rm sf-u2-net; docker volume rm sf-u2-offline-home
docker image ls --format '{{.Repository}}' | grep '^sf-u2-' | xargs -r docker rmi
```
