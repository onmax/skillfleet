import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import * as execution from "../src/exec.ts";
import {
  fleet,
  formatFleet,
  type HostResult,
  type InitSetup,
  markBehind,
  remoteScript,
  resolveFleet,
} from "../src/fleet.ts";
import { hostManifestSpec, loadManifest, sameManifest } from "../src/manifest.ts";
import { launchers } from "../src/selfinstall.ts";
import { cli, isWindows, machine, type Machine, pathWith, remote, skills } from "./fixture.ts";

/**
 * A fake `ssh`: skips options and the `--` after them, takes the host, and runs the remote command with `sh -c` on this
 * machine for `localhost`. Any other host hangs, like a machine that dropped off the network.
 */
function sshShim(m: Machine): NodeJS.ProcessEnv {
  const dir = join(m.root, "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const probe = args[0] === "-G" && args.shift();
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (probe) {
  console.log("hostname " + host + "\\nuser alice\\nport 22");
  process.exit(0);
}
if (host !== "localhost") setTimeout(() => {}, 1e9);
else {
  const run = spawnSync("sh", ["-c", command], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}`,
  );
  if (isWindows) return { FLEETRC_SSH: script };
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(ssh, 0o755);
  return { PATH: pathWith(dir, m.env) };
}

let lastIp = 0;
/** A tailnet peer as `tailscale status --json` lists it. */
function peer(dns: string, tags: string[], { online = true, ips = [`100.64.1.${++lastIp}`] } = {}) {
  return {
    PublicKey: `nodekey:${dns}`,
    HostName: dns.split(".")[0],
    DNSName: dns ? `${dns}.` : "",
    TailscaleIPs: ips,
    ...(tags.length ? { Tags: tags } : {}),
    Online: online,
  };
}

function status(peers: ReturnType<typeof peer>[], self = peer("me.tail.ts.net", ["tag:servers"])) {
  return {
    BackendState: "Running",
    Self: self,
    Peer: Object.fromEntries(peers.map((p) => [p.PublicKey, p])),
  };
}

function peerAddresses(peers: ReturnType<typeof peer>[]) {
  return async (name: string) => {
    const match = peers.find(
      ({ DNSName, HostName }) => DNSName === `${name}.` || HostName === name,
    );
    return match?.TailscaleIPs ?? [];
  };
}

/**
 * A fake `tailscale` for FLEETRC_TAILSCALE: prints `output` (JSON for an object) and exits with
 * `code`, and touches `<dir>/tailscale-ran` so a test can tell it was asked.
 */
function fakeTailscale(dir: string, output: object | string, code = 0): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tailscale.mjs");
  const text = typeof output === "string" ? output : JSON.stringify(output);
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "tailscale-ran"))}, "");
process.stdout.write(${JSON.stringify(text)});
process.exit(${code});`,
  );
  return script;
}

/** Runs `body` with `FLEETRC_TAILSCALE` set to `program`. */
async function withTailscale<T>(program: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.FLEETRC_TAILSCALE;
  process.env.FLEETRC_TAILSCALE = program;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.FLEETRC_TAILSCALE;
    else process.env.FLEETRC_TAILSCALE = saved;
  }
}

type Hosts = { host: string; via?: string; reachable: boolean; checked: boolean; error?: string }[];

describe("fleet", () => {
  it("14. reports localhost through ssh, and an unreachable host times out with its last-run age", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "fleet-skill"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      fleet: ["localhost", "gone.example"],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // What `timer install` does: the copy of fleetrc that hosts run.
    expect((await m.run("self-install")).code).toBe(0);
    const env = sshShim(m);

    const first = await m.runWith({ env }, "fleet", "status", "localhost", "--json");
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const hosts = JSON.parse(first.stdout) as {
      host: string;
      reachable: boolean;
      lastRun?: { skills: number; finishedAt: string };
      error?: string;
      behind: string[];
    }[];
    expect(hosts[0]).toMatchObject({ host: "localhost", reachable: true, lastRun: { skills: 1 } });
    const gone = await m.runWith(
      { env },
      "fleet",
      "status",
      "gone.example",
      "--timeout",
      "2",
      "--json",
    );
    expect(gone.code).toBe(1);
    expect(JSON.parse(gone.stdout)).toMatchObject([
      {
        host: "gone.example",
        reachable: false,
        error: "no answer within 2 s",
        behind: [],
      },
    ]);

    // Once a host has answered, its last run is cached and shown with its age while it is unreachable.
    const cache = JSON.parse(JSON.stringify(hosts[0]!.lastRun)) as { finishedAt: string };
    cache.finishedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(m.stateDir, "fleet.json"), JSON.stringify({ "gone.example": cache }));
    const text = await m.runWith({ env }, "fleet", "status", "gone.example", "--timeout", "2");
    expect(text.stdout).toContain(
      "gone.example: unreachable (no answer within 2 s); last run 5h ago, 1 skills; behind: last run 5h ago",
    );

    // fleet sync runs the sync on the host and reads back its report.
    vendor.commit({ "skills/second/SKILL.md": "---\nname: second\ndescription: Second\n---\n" });
    const synced = await m.runWith({ env }, "fleet", "sync", "localhost", "--json");
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(
      (JSON.parse(synced.stdout) as { lastRun: { skills: number } }[])[0]!.lastRun.skills,
    ).toBe(2);
  });

  it("fleet add records only the hosts named", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const added = await m.run("fleet", "add", "slimbook", "maxi@100.105.98.81");
    expect(added.code).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual([
      "slimbook",
      "maxi@100.105.98.81",
    ]);
  });

  it("fleet add takes the host forms ssh reads, including ssh:// with a port", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const hosts = ["box.tail1234.ts.net", "my_alias", "ssh://me@box:2222", "fe80::1%eth0"];
    const added = await m.run("fleet", "add", ...hosts);
    expect(added.code, added.stderr).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual(
      hosts,
    );
  });

  it.skipIf(isWindows)(
    "R3-6. fleet upgrade on a host whose launcher's node is gone says so, not that fleetrc is missing",
    () => {
      const m = machine();
      const state = join(m.root, "state");
      const launcher = join(state, "fleetrc", "bin", "fleetrc");
      mkdirSync(join(launcher, ".."), { recursive: true });
      // Node.js was upgraded: the launcher still names the old node, and ssh's PATH has no node or npx.
      writeFileSync(
        launcher,
        launchers(
          join(m.root, "node-v22.1.0", "bin", "node"),
          join(state, "fleetrc", "app", "cli.mjs"),
        ).sh,
      );
      chmodSync(launcher, 0o755);
      const bin = join(m.root, "ssh-bin");
      mkdirSync(bin);
      const sed = spawnSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).stdout.trim();
      symlinkSync(sed, join(bin, "sed"));
      const run = spawnSync("/bin/sh", ["-c", remoteScript("upgrade", "1.2.3")], {
        env: { HOME: m.home, XDG_STATE_HOME: state, PATH: bin },
        encoding: "utf8",
      });
      expect(run.stdout.trim(), run.stderr).toBe("fleetrc-fleet: node-gone");
    },
  );

  it.skipIf(isWindows)(
    "R2-2. fleet sync reads a host whose sync failed for one source as synced with errors, and exits 1",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "vendor", git: vendor.url },
          { id: "gone", local: join(m.root, "gone") },
        ],
        fleet: ["localhost"],
      });
      await m.run("init", manifest, "--no-hooks");
      expect((await m.run("self-install")).code).toBe(0);
      const env = sshShim(m);
      const sync = await m.runWith({ env }, "fleet", "sync");
      expect(sync.stdout).toMatch(/^localhost: last run \d+s ago, 1 skills, with errors$/m);
      expect(sync.code).toBe(1);
      // status shows the last run as it was; it did not fail now.
      const status = await m.runWith({ env }, "fleet", "status");
      expect(status.stdout).toMatch(/^localhost: last run .*, with errors$/m);
      expect(status.code).toBe(0);
    },
  );

  it("R7-16. fleet without ssh says ssh is not installed, and calls no host unreachable or never run", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["laptop", "homelab"],
    });
    const empty = join(m.root, "no-ssh");
    mkdirSync(empty);
    const status = await m.runWith(
      { env: { PATH: empty, Path: isWindows ? empty : undefined } },
      "fleet",
      "status",
      "--manifest",
      manifest,
    );
    expect(status.code).toBe(1);
    expect(status.stdout.replace(/\r/g, "")).toBe(
      "laptop: not checked (ssh is not installed, or not on PATH); no run recorded\n" +
        "homelab: not checked (ssh is not installed, or not on PATH); no run recorded\n",
    );
  });

  it.skipIf(isWindows)(
    "R7-16. a host that answers but is slow times out as slow, not unreachable, and its sync is stopped",
    async () => {
      const m = machine();
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [],
        fleet: ["localhost", "gone.example"],
      });
      // The host's sync starts and never ends.
      const pidFile = join(m.root, "sync.pid");
      const launcher = join(m.stateDir, "bin", "fleetrc");
      mkdirSync(join(launcher, ".."), { recursive: true });
      writeFileSync(launcher, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
      chmodSync(launcher, 0o755);
      const env = sshShim(m);
      let pid: number | undefined;
      try {
        // Long enough for the host to answer on a loaded machine; the sync never finishes.
        const sync = await m.runWith(
          { env },
          "fleet",
          "sync",
          "--manifest",
          manifest,
          "--timeout",
          "10",
        );
        expect(sync.code).toBe(1);
        expect(sync.stdout).toContain(
          "localhost: timed out after 10 s (the host answered, but its run did not finish, so it was stopped); no run recorded\n",
        );
        expect(sync.stdout).toContain(
          "gone.example: unreachable (no answer within 10 s); no run recorded\n",
        );
        pid = Number(readFileSync(pidFile, "utf8"));
        // The fake ssh is gone and its stdin closed, as when ssh's connection drops: the sync is stopped.
        const deadline = Date.now() + 30_000;
        while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        expect(alive(pid)).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );

  it.skipIf(isWindows)("R7-18. fleet upgrade prints each host's version change", async () => {
    const m = machine();
    sshShim(m);
    const state = join(m.root, "state");
    const dir = join(state, "fleetrc");
    // The installed fleetrc: its version is in a file that the fake npx's self-install rewrites.
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "version"), "0.0.1\n");
    writeFileSync(
      join(dir, "bin", "fleetrc"),
      `#!/bin/sh
v=$(cat "${dir}/version")
case "$1" in
  --version) echo "$v" ;;
  sync) printf '{"finishedAt":"%s","ok":true,"fleetrc":"%s","skills":{"total":1}}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$v" ;;
esac
`,
    );
    chmodSync(join(dir, "bin", "fleetrc"), 0o755);
    const npx = join(m.root, "npx-bin");
    mkdirSync(npx);
    writeFileSync(join(npx, "npx"), `#!/bin/sh\necho 0.0.2 > "${dir}/version"\n`);
    chmodSync(join(npx, "npx"), 0o755);
    const saved = {
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      FLEETRC_SSH: process.env.FLEETRC_SSH,
      PATH: process.env.PATH,
    };
    process.env.XDG_STATE_HOME = state;
    process.env.FLEETRC_SSH = join(m.root, "bin", "ssh.mjs");
    process.env.PATH = pathWith(npx, process.env);
    try {
      const results = await fleet(["localhost"], "upgrade", "0.0.2", 60_000);
      expect(formatFleet(results)).toMatch(
        /^localhost: 0\.0\.1 → 0\.0\.2; last run \d+s ago, 1 skills$/,
      );
      expect(results[0]!.upgrade).toEqual({ from: "0.0.1", to: "0.0.2" });
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
});

describe("fleet tags", () => {
  it("expands a tag to its tailnet machines by MagicDNS name, or IP without one, and skips this machine", async () => {
    const peers = [
      peer("web.tail.ts.net", ["tag:servers"]),
      peer("", ["tag:servers"], { ips: ["100.64.0.9", "fd7a::9"] }),
      peer("db.tail.ts.net", ["tag:Servers", "tag:db"], { online: false }),
      peer("laptop.tail.ts.net", []),
    ];
    const exec = vi.spyOn(execution, "exec").mockImplementation(async (_command, args) => {
      const result = { code: 0, stderr: "", timedOut: false, truncated: false };
      if (args.includes("--json")) return { ...result, stdout: JSON.stringify(status(peers)) };
      const host = args[args.indexOf("--") + 1];
      return { ...result, stdout: `hostname ${host}\nuser alice\nport 22\n` };
    });
    const { targets, warnings } = await resolveFleet(["tag:servers"], peerAddresses(peers)).finally(
      () => exec.mockRestore(),
    );
    expect(warnings).toEqual([]);
    // Self (me.tail.ts.net) has the tag too, and is left out.
    expect(targets).toMatchObject([
      { host: "web.tail.ts.net", via: "tag:servers" },
      { host: "100.64.0.9", via: "tag:servers" },
      { host: "db.tail.ts.net", via: "tag:servers", offline: true },
    ]);
  });

  it("runs a machine named twice once: an explicit host wins, then the first tag", async () => {
    const peers = [
      peer("web.tail.ts.net", ["tag:servers", "tag:web"]),
      peer("db.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.2"] }),
      peer("ci.tail.ts.net", ["tag:servers"]),
      peer("vps.tail.ts.net", ["tag:web"]),
    ];
    const exec = vi.spyOn(execution, "exec").mockImplementation(async (_command, args) => {
      const result = { code: 0, stderr: "", timedOut: false, truncated: false };
      if (args.includes("--json")) return { ...result, stdout: JSON.stringify(status(peers)) };
      expect(args).toContain("-G");
      const host = args[args.indexOf("--") + 1]!;
      const [, user, name, port] = /^(?:ssh:\/\/)?(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(host)!;
      return {
        ...result,
        stdout: `hostname ${name!.toLowerCase()}\nuser ${user ?? "alice"}\nport ${port ?? "22"}\n`,
      };
    });
    try {
      const { targets } = await resolveFleet(
        ["tag:servers", "WEB", "me@100.64.0.2", "tag:web", "ssh://me@CI.tail.ts.net:22", "web"],
        peerAddresses(peers),
      );
      expect(targets).toEqual([
        { host: "WEB" },
        { host: "me@100.64.0.2" },
        expect.objectContaining({ host: "vps.tail.ts.net", via: "tag:web" }),
        { host: "ssh://me@CI.tail.ts.net:22" },
      ]);
    } finally {
      exec.mockRestore();
    }
  });

  it("compares entries by the machine they reach: IPv6 in any spelling, written ports, names Tailscale gives one peer", async () => {
    const m = machine();
    const peers = [
      peer("", ["tag:servers"], { ips: ["100.64.0.9", "fd7a:0:0::9"] }),
      peer("", ["tag:servers"], { ips: ["fd7a::10"] }),
      peer("web.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.7"] }),
      peer("db.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.8"] }),
    ];
    const program = fakeTailscale(m.root, status(peers));
    const { targets } = await withTailscale(program, () =>
      resolveFleet(
        [
          // A bare IPv6 address has no port: fd7a::9 is not fd7a: on port 9.
          "fd7a::9",
          "ssh://me@[FD7A:0::10]:2222",
          "tag:servers",
          "100.64.0.7",
          "web.tail.ts.net",
          "me@db",
          "ssh://me@db.tail.ts.net:22",
          "ssh://me@db:2222",
          "root@db",
        ],
        peerAddresses(peers),
      ),
    );
    expect(targets).toEqual([
      { host: "fd7a::9" },
      { host: "ssh://me@[FD7A:0::10]:2222" },
      { host: "100.64.0.7" },
      { host: "me@db" },
      // A written port stays: ~/.ssh/config may give the bare name another one.
      { host: "ssh://me@db.tail.ts.net:22" },
      { host: "ssh://me@db:2222" },
      { host: "root@db" },
    ]);
    // Without a tag, Tailscale isn't asked, so a short name and a MagicDNS name stay apart: two
    // tailnets can each have a vps2.
    const config = vi.spyOn(execution, "exec").mockImplementation(async (_command, args) => {
      const host = args[args.indexOf("--") + 1];
      return {
        stdout: `hostname ${host === "VPS2" ? "192.0.2.2" : "192.0.2.1"}\nuser alice\nport 22\n`,
        stderr: "",
        code: 0,
        timedOut: false,
        truncated: false,
      };
    });
    try {
      const plain = await resolveFleet(["vps2", "vps2.tail.ts.net", "vps2.other.ts.net", "VPS2"]);
      expect(plain.targets).toEqual([
        { host: "vps2" },
        { host: "vps2.tail.ts.net" },
        { host: "vps2.other.ts.net" },
        { host: "VPS2" },
      ]);
    } finally {
      config.mockRestore();
    }
  });

  it("runs on a machine's Tailscale IP when the tailnet has MagicDNS off", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, {
      ...status([peer("web.tail.ts.net", ["tag:servers"], { ips: ["100.64.0.5", "fd7a::5"] })]),
      CurrentTailnet: {
        Name: "example.com",
        MagicDNSSuffix: "tail.ts.net",
        MagicDNSEnabled: false,
      },
    });
    const { targets } = await withTailscale(program, () =>
      resolveFleet(["web", "web.tail.ts.net", "tag:servers"]),
    );
    expect(targets).toEqual([
      { host: "web" },
      { host: "web.tail.ts.net" },
      expect.objectContaining({ host: "100.64.0.5", via: "tag:servers" }),
    ]);
    const explicitIP = await withTailscale(program, () =>
      resolveFleet(["tag:servers", "me@fd7a:0::5"]),
    );
    expect(explicitIP.targets).toEqual([{ host: "me@fd7a:0::5" }]);
  });

  it("uses the peer IP when MagicDNS names cannot resolve locally", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, {
      ...status([peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5"] })]),
      CurrentTailnet: { MagicDNSEnabled: true },
    });
    const { targets } = await withTailscale(program, () => resolveFleet(["web", "tag:servers"]));
    expect(targets).toMatchObject([{ host: "web" }, { host: "100.64.0.5", via: "tag:servers" }]);
  });

  it("dispatches to all tagged peers through bounded, address-family-aware probes", async () => {
    const peers = Array.from({ length: 20 }, (_, index) =>
      peer(`peer${index}.invalid`, ["tag:servers"], {
        ips: [`100.64.0.${index + 1}`, `fd7a::${index + 1}`],
      }),
    );
    const mixedDns = "peer1.invalid";
    const hosts = peers.map((entry, index) => (index === 1 ? mixedDns : entry.TailscaleIPs[1]));
    const dispatched: string[] = [];
    let active = 0;
    const exec = vi.spyOn(execution, "exec").mockImplementation(async (_command, args) => {
      const result = { code: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
      if (args.includes("--json")) return { ...result, stdout: JSON.stringify(status(peers)) };
      const host = args[args.indexOf("--") + 1]!;
      if (!args.includes("-G")) {
        dispatched.push(host);
        return {
          ...result,
          code: hosts.includes(host) ? 0 : 255,
          stdout: hosts.includes(host) ? "fleetrc-fleet: never-synced" : "",
        };
      }
      const saturated = ++active > 12;
      await Promise.resolve();
      active--;
      if (saturated) return { ...result, code: null, spawnError: "EMFILE" };
      const record = peers.find(({ DNSName }) => DNSName === `${host}.`);
      const name = host === mixedDns ? host : (record?.TailscaleIPs[0] ?? host);
      return { ...result, stdout: `hostname ${name}\nuser alice\nport 22\naddressfamily inet6\n` };
    });
    try {
      const addresses = async () => ["192.0.2.10", "fd7a::2"];
      const { targets } = await resolveFleet(["tag:servers"], addresses);
      const results = await fleet(targets, "status", "0.0.0", 30_000, { dryRun: true });
      expect(dispatched).toEqual(hosts);
      expect(results.every(({ reachable }) => reachable)).toBe(true);
    } finally {
      exec.mockRestore();
    }
  });

  it("deduplicates an explicit SSH alias by its effective destination, not its name", async () => {
    const aliases = new Map([
      ["alias.invalid", ["alice", 2222]],
      ["same.invalid", ["alice", 2222]],
      ["other-user.invalid", ["bob", 2222]],
      ["other-port.invalid", ["alice", 2223]],
    ]);
    const peers = [peer("localhost", ["tag:servers"], { ips: ["127.0.0.1", "::1"] })];
    const exec = vi.spyOn(execution, "exec").mockImplementation(async (_command, args) => {
      const result = { code: 0, stderr: "", timedOut: false, truncated: false };
      if (args.includes("--json")) return { ...result, stdout: JSON.stringify(status(peers)) };
      const host = args[args.indexOf("--") + 1]!;
      const config = aliases.get(host);
      const name = config ? "localhost" : host === "localhost" ? "127.0.0.2" : host;
      return {
        ...result,
        stdout: `hostname ${name}\n${config ? `user ${config[0]}\nport ${config[1]}\n` : ""}`,
      };
    });
    try {
      const addresses = peerAddresses(peers);
      const { targets } = await resolveFleet([...aliases.keys(), "tag:servers"], addresses);
      expect(targets.map(({ host }) => host)).toEqual([
        "alias.invalid",
        "other-user.invalid",
        "other-port.invalid",
      ]);
      const other = await resolveFleet(["localhost", "tag:servers"], addresses);
      expect(other.targets).toMatchObject([
        { host: "localhost" },
        { host: "127.0.0.1", via: "tag:servers" },
      ]);
    } finally {
      exec.mockRestore();
    }
  });

  it("keeps the newest report from the tagged destination when an IP fallback peer goes offline", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const ssh = join(m.root, "ssh-report.mjs");
    const log = join(m.root, "ssh-ran");
    writeFileSync(
      ssh,
      `import { appendFileSync } from "node:fs";
const destination = process.argv[process.argv.indexOf("--") + 1];
if (process.argv.includes("-G")) {
  console.log("hostname " + destination + "\\nuser alice\\nport 22");
  process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, destination + "\\n");
console.log(JSON.stringify({ finishedAt: process.env.REPORT_TIME, ok: true, skills: 1 }));`,
    );
    const online = {
      ...peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5"] }),
      ID: "server",
    };
    const tailscale = fakeTailscale(m.root, status([online]));
    const env = { FLEETRC_SSH: ssh, FLEETRC_TAILSCALE: tailscale };
    const run = (host: string, time?: string) =>
      m.runWith({ env: { ...env, REPORT_TIME: time } }, "fleet", "status", host, "--json");
    const before = await run("tag:servers", "2026-01-01T00:00:00Z");
    expect(before.code, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject([{ host: "100.64.0.5", reachable: true }]);
    expect((await run("100.64.0.5", "2026-01-01T00:01:00Z")).code).toBe(0);
    expect((await run("bob@100.64.0.5", "2026-01-01T00:02:00Z")).code).toBe(0);
    expect((await run("ssh://100.64.0.5:2222", "2026-01-01T00:03:00Z")).code).toBe(0);
    fakeTailscale(m.root, status([{ ...online, Online: false }]));
    const after = await run("tag:servers");
    expect(after.code, after.stderr).toBe(1);
    expect(JSON.parse(after.stdout)).toMatchObject([
      {
        host: "web.invalid",
        error: "offline in Tailscale",
        lastRun: { finishedAt: "2026-01-01T00:01:00Z", skills: 1 },
      },
    ]);
    expect(readFileSync(log, "utf8")).toBe(
      "100.64.0.5\n100.64.0.5\nbob@100.64.0.5\nssh://100.64.0.5:2222\n",
    );
  });

  it("falls back to IP without waiting for a slow DNS lookup", async () => {
    const program = fakeTailscale(
      machine().root,
      status([peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5"] })]),
    );
    const addresses = () =>
      new Promise<string[]>((resolve) => setTimeout(resolve, 1000, ["100.64.0.5"]));
    const { targets } = await withTailscale(program, () =>
      resolveFleet(["tag:servers"], addresses, 500),
    );
    expect(targets).toMatchObject([{ host: "100.64.0.5", via: "tag:servers" }]);
  });

  it("never hands ssh a name from tailscale status that ssh would read as an option, a user or shell", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("-oProxyCommand=x", ["tag:servers"], { ips: [] }),
        peer("a;b.tail.ts.net", ["tag:servers"], { ips: [] }),
        peer("user@x", ["tag:servers"], { ips: [] }),
        peer("$(id).tail.ts.net", ["tag:servers"], { ips: [] }),
        { ...peer("", ["tag:servers"], { ips: ["-oProxyCommand=y"] }), HostName: "$(id)" },
        { ...peer("", ["tag:servers"], { ips: ["a;b"] }), HostName: "-oProxyCommand=z" },
        peer("localhost", ["tag:servers"], { ips: ["127.0.0.1", "::1"] }),
      ]),
    );
    const log = join(m.root, "ssh-argv.jsonl");
    const ssh = join(m.root, "record-ssh.mjs");
    writeFileSync(
      ssh,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("-G")) {
  const host = args[args.indexOf("--") + 1];
  console.log("hostname " + host + "\\nuser alice\\nport 22");
  process.exit(0);
}
process.exit(255);`,
    );
    const env = { FLEETRC_SSH: ssh, FLEETRC_TAILSCALE: program };
    const run = await m.runWith({ env }, "fleet", "status", "tag:servers", "--json");
    expect(run.code).toBe(1);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      calls.filter((argv) => !argv.includes("-G")).map((argv) => argv[argv.indexOf("--") + 1]),
    ).toEqual(["localhost"]);
    for (const argv of calls)
      for (const hostile of ["ProxyCommand", "a;b", "user@x", "$(id)"])
        expect(argv.slice(0, -1).join(" ")).not.toContain(hostile);
    expect((JSON.parse(run.stdout) as Hosts).map((host) => host.host)).toEqual(["localhost"]);
    expect(run.stderr).toMatch(/skipped a machine Tailscale calls "-oProxyCommand=x"/);
  });

  it("warns about a tag that matches no machine, and asks Tailscale nothing without a tag", async () => {
    const m = machine();
    const program = fakeTailscale(m.root, status([peer("web.tail.ts.net", ["tag:web"])]));
    const tagged = await withTailscale(program, () => resolveFleet(["tag:servers", "laptop"]));
    expect(tagged).toEqual({
      targets: [{ host: "laptop" }],
      warnings: ["tag:servers matches no machine on your tailnet besides this one"],
      enrollment: new Map([["laptop", [{ host: "laptop" }]]]),
    });
    rmSync(join(m.root, "tailscale-ran"));
    await withTailscale(program, () => resolveFleet(["laptop"]));
    expect(existsSync(join(m.root, "tailscale-ran"))).toBe(false);
  });

  it("says why a tag can't be expanded when tailscale is missing, logged out, failing or printing junk", async () => {
    const m = machine();
    const cases: [string, string][] = [
      [
        join(m.root, "nowhere", "tailscale"),
        "which FLEETRC_TAILSCALE names, is not installed or not on PATH",
      ],
      [
        fakeTailscale(join(m.root, "out"), { BackendState: "NeedsLogin" }),
        "Tailscale is not logged in; run `tailscale up`",
      ],
      [
        fakeTailscale(join(m.root, "junk"), "<html>"),
        "`tailscale status --json` printed something that is not JSON",
      ],
      [fakeTailscale(join(m.root, "down"), "", 1), "`tailscale status` failed: exit 1"],
    ];
    for (const [program, error] of cases) {
      const { targets } = await withTailscale(program, () =>
        resolveFleet(["laptop", "tag:servers"]),
      );
      expect(targets[0]).toEqual({ host: "laptop" });
      expect(targets[1]).toMatchObject({ host: "tag:servers", via: "tag:servers" });
      expect(targets[1]!.error).toContain(error);
    }
  });

  it("a fleet with tailscale missing still runs its explicit hosts, and the tag line says why, exit 1", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      fleet: ["tag:servers", "localhost"],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("self-install")).code).toBe(0);
    const env = { ...sshShim(m), FLEETRC_TAILSCALE: join(m.root, "nowhere", "tailscale") };
    const text = await m.runWith({ env }, "fleet", "status", "--timeout", "20");
    expect(text.code).toBe(1);
    expect(text.stderr).not.toMatch(/\n\s+at /);
    const lines = text.stdout.replace(/\r/g, "").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^tag:servers: not expanded \(.*tailscale, which FLEETRC_TAILSCALE names, is not installed or not on PATH\)$/,
    );
    expect(lines[1]).toMatch(/^localhost: last run \d+s ago, 0 skills$/);
  });

  it("fleet sync|status take a tag on the command line, mark offline machines, and --json says which tag a host came from", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["laptop"] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("self-install")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("localhost", ["tag:servers"], { ips: ["127.0.0.1", "::1"] }),
        peer("gone.tail.ts.net", ["tag:servers"], { online: false }),
      ]),
    );
    const env = { ...sshShim(m), FLEETRC_TAILSCALE: program };
    const started = Date.now();
    const run = await m.runWith({ env }, "fleet", "status", "tag:servers", "--json");
    // The offline machine is not waited on for ssh's 30 s.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(run.code, run.stderr).toBe(1);
    const hosts = JSON.parse(run.stdout) as Hosts;
    expect(hosts).toEqual([
      expect.objectContaining({ host: "localhost", via: "tag:servers", reachable: true }),
      expect.objectContaining({
        host: "gone.tail.ts.net",
        via: "tag:servers",
        reachable: false,
        error: "offline in Tailscale",
      }),
    ]);
    const text = await m.runWith({ env }, "fleet", "status", "tag:servers");
    expect(text.stdout).toMatch(/^localhost \(tag:servers\): last run /m);
    expect(text.stdout).toContain(
      "gone.tail.ts.net (tag:servers): unreachable (offline in Tailscale); no run recorded\n",
    );

    const dry = await m.runWith({ env }, "fleet", "sync", "tag:servers", "--dry-run");
    expect(dry.stdout).toMatch(
      /^tag:servers expands to localhost, gone\.tail\.ts\.net \(offline\)$/m,
    );

    const none = await m.runWith({ env }, "fleet", "status", "tag:nothing");
    expect(none.code).toBe(0);
    expect(none.stderr).toContain(
      "fleetrc: warning: tag:nothing matches no machine on your tailnet besides this one",
    );

    const bad = await m.runWith({ env }, "fleet", "sync", "tag:bad_tag");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('"tag:bad_tag" is not a Tailscale tag');
  });

  it("fleet add records a tag, and without hosts suggests the tags it saw", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const program = fakeTailscale(
      m.root,
      status([
        peer("web.tail.ts.net", ["tag:servers"]),
        peer("db.tail.ts.net", ["tag:servers", "tag:db"]),
        peer("laptop.tail.ts.net", []),
        peer("", ["tag:servers", "tag:ip-only"], { ips: ["100.64.0.9"] }),
      ]),
    );
    const env = { FLEETRC_TAILSCALE: program };
    const listed = await m.runWith({ env }, "fleet", "add");
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(
      "  tag:db  (1 machine)\n  tag:ip-only  (1 machine)\n  tag:servers  (3 machines)",
    );
    expect(listed.stdout).toContain("  laptop  laptop.tail.ts.net");

    expect((await m.runWith({ env }, "fleet", "add", "tag:servers")).code).toBe(0);
    expect((JSON.parse(readFileSync(manifest, "utf8")) as { fleet: string[] }).fleet).toEqual([
      "tag:servers",
    ]);
    const after = JSON.parse((await m.runWith({ env }, "fleet", "add", "--json")).stdout) as {
      tags: { tag: string }[];
    };
    expect(after.tags.map(({ tag }) => tag)).toEqual(["tag:db", "tag:ip-only"]);

    const bad = await m.runWith({ env }, "fleet", "add", "tag:9lives");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('"tag:9lives" is not a Tailscale tag');
  });

  it("an extended team manifest's tag is ignored, and Tailscale is never asked", async () => {
    const m = machine();
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(team, ".."), { recursive: true });
    writeFileSync(
      team,
      JSON.stringify({
        sources: [{ id: "team", git: "https://example.org/team.git" }],
        fleet: ["tag:servers", "tag:bad_tag"],
      }),
    );
    // A host fleet refuses at once, so the run needs no ssh.
    const manifest = m.manifest({
      agents: ["claude-code"],
      extends: [team],
      sources: [],
      fleet: ["-x"],
    });
    const loaded = await loadManifest(manifest, { offline: true });
    expect(loaded.sources.map(({ id }) => id)).toEqual(["team"]);
    expect(loaded.warnings).toEqual([expect.stringContaining("ignored fleet; only the root")]);
    const program = fakeTailscale(m.root, status([peer("web.tail.ts.net", ["tag:servers"])]));
    const run = await m.runWith(
      { env: { FLEETRC_TAILSCALE: program } },
      "fleet",
      "status",
      "--json",
      "--manifest",
      manifest,
    );
    expect((JSON.parse(run.stdout) as Hosts).map(({ host }) => host)).toEqual(["-x"]);
    expect(existsSync(join(m.root, "tailscale-ran"))).toBe(false);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake `ssh` for `fleet init`: `localhost` is this machine, each name in `homes` is another
 * machine whose HOME is that folder (its XDG folders and agent folders inside it), and any other
 * host hangs. A fake `npx` on PATH appends its arguments to `<root>/npx.jsonl` and runs the built
 * CLI with the words after `-- fleetrc`, as npx runs the package it installed.
 */
function initShims(
  m: Machine,
  homes: Record<string, string>,
  aliases: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const dir = join(m.root, "bin");
  mkdirSync(dir, { recursive: true });
  const machines = Object.fromEntries(
    Object.entries(homes).map(([host, home]) => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const env = {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      };
      return [host, env];
    }),
  );
  writeFileSync(
    join(dir, "ssh.mjs"),
    `import { spawnSync } from "node:child_process";
const machines = ${JSON.stringify(machines)};
const aliases = ${JSON.stringify(aliases)};
const args = process.argv.slice(2);
if (args[0] === "-G") {
  const host = args[args.indexOf("--") + 1];
  console.log("hostname " + (aliases[host] ?? host) + "\\nuser alice\\nport 22");
  process.exit(0);
}
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (host !== "localhost" && !machines[host]) setTimeout(() => {}, 1e9);
else {
  const env = { ...process.env, ...machines[host] };
  const run = spawnSync("sh", ["-c", command], { cwd: env.HOME, stdio: "inherit", env });
  process.exit(run.status ?? 1);
}`,
  );
  writeFileSync(
    join(dir, "ssh"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "ssh.mjs")}" "$@"\n`,
  );
  writeFileSync(
    join(dir, "npx.mjs"),
    `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(m.root, "npx.jsonl"))}, JSON.stringify(args) + "\\n");
if (process.env.FAKE_NPX_RECORD_ONLY) process.exit(0);
const words = args.slice(args.indexOf("--") + 2);
const run = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...words], { stdio: "inherit" });
process.exit(process.env.FAKE_NPX_EXIT ? Number(process.env.FAKE_NPX_EXIT) : (run.status ?? 1));`,
  );
  writeFileSync(
    join(dir, "npx"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "npx.mjs")}" "$@"\n`,
  );
  chmodSync(join(dir, "ssh"), 0o755);
  chmodSync(join(dir, "npx"), 0o755);
  return { PATH: pathWith(dir, m.env), FLEETRC_PACKAGE: "/pkg/fleetrc.tgz" };
}

/** The argument lists the fake npx was run with. */
const npxCalls = (m: Machine): string[][] =>
  existsSync(join(m.root, "npx.jsonl"))
    ? readFileSync(join(m.root, "npx.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];

function keepFakeNpxOnRetry(m: Machine, state: string) {
  const nodeOnly = join(m.root, "node-only");
  mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, "node"));
  const launcher = join(state, "bin", "fleetrc");
  writeFileSync(
    launcher,
    readFileSync(launcher, "utf8").replace(/^exec "[^"]*"/m, `exec "${join(nodeOnly, "node")}"`),
  );
}

/**
 * A machine set up with a manifest kept in a repository, as `fleet init` needs: one vendored
 * skill, and the manifest's repository as a source with a working clone in ~/code/manifests.
 */
async function controller(fleet: string[] = [], options?: Parameters<typeof machine>[0]) {
  const m = machine(options);
  const vendor = remote(m, "vendor", skills("skills/", "fleet-skill"));
  const manifests = remote(m, "manifests", { ".fleetrc/manifest.json": "{}" });
  manifests.commit({
    ".fleetrc/manifest.json": JSON.stringify(
      {
        agents: ["claude-code"],
        sources: [
          { id: "manifests", git: manifests.https, path: "~/code/manifests", skills: "none/*" },
          { id: "vendor", git: vendor.https },
        ],
        fleet,
      },
      null,
      2,
    ),
  });
  const init = await m.run("init", manifests.https, "--no-hooks");
  expect(init.code, init.stdout + init.stderr).toBe(0);
  const spec = `${manifests.https}//.fleetrc/manifest.json`;
  const edited = m.at("code", "manifests", ".fleetrc", "manifest.json");
  const fleetIn = () => (JSON.parse(readFileSync(edited, "utf8")) as { fleet: string[] }).fleet;
  return { m, spec, fleetIn };
}

it("rejects setup options before running any other fleet action", async () => {
  const m = machine();
  const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: [] });
  for (const [action, flag] of [
    ["add", "--copy"],
    ["add", "--no-copy"],
    ["add", "--timer"],
    ["add", "--no-hooks"],
    ["add", "--force"],
    ["sync", "--timer"],
    ["status", "--no-hooks"],
    ["upgrade", "--force"],
  ] as const) {
    const run = await m.run("fleet", action, "vps2", flag, "--manifest", manifest);
    expect.soft(run.code, `${action} ${flag}`).toBe(2);
    expect.soft(run.stderr, `${action} ${flag}`).toContain(`only fleet init takes ${flag}`);
  }
  expect(JSON.parse(readFileSync(manifest, "utf8")) as unknown).toMatchObject({ fleet: [] });
});

describe.skipIf(isWindows)("fleet init", () => {
  it("sets up a new host with this machine's manifest over ssh, and adds it to the fleet", async () => {
    const { m, spec, fleetIn } = await controller();
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env }, "fleet", "init", "vps2", "--no-hooks", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(npxCalls(m)).toEqual([
      [
        "-y",
        "--package",
        "/pkg/fleetrc.tgz",
        "--",
        "fleetrc",
        "init",
        spec,
        "--no-hooks",
        "--json",
      ],
    ]);
    const [host] = JSON.parse(run.stdout) as {
      host: string;
      setup?: string;
      lastRun?: { skills: number; ok: boolean };
    }[];
    expect(host).toMatchObject({
      host: "vps2",
      setup: "set up",
      lastRun: { skills: 1, ok: true },
    });
    // The host has the same manifest, its own launcher, and the skill linked.
    const config = JSON.parse(
      readFileSync(join(m.root, "vps2", ".config", "fleetrc", "config.json"), "utf8"),
    ) as { manifest: string };
    expect(config.manifest).toBe(spec);
    expect(existsSync(join(m.root, "vps2", ".local", "state", "fleetrc", "bin", "fleetrc"))).toBe(
      true,
    );
    expect(existsSync(join(m.root, "vps2", ".claude", "skills", "fleet-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(run.stderr).toContain(
      "added vps2 to the fleet in ~/code/manifests/.fleetrc/manifest.json; commit and push it",
    );
    expect(fleetIn()).toEqual(["vps2"]);

    // Again: the host has the manifest, so it only syncs, and the fleet already has it.
    const again = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^vps2: already set up; last run \d+s ago, 1 skills$/m);
    expect(again.stdout).toContain("the fleet already has them");
    expect(npxCalls(m)).toHaveLength(1);
    expect(fleetIn()).toEqual(["vps2"]);
  });

  it("refuses a host that has another manifest unless --force, and says which it has", async () => {
    const { m, spec } = await controller();
    const other = join(m.root, "other");
    mkdirSync(join(other, ".config", "fleetrc"), { recursive: true });
    writeFileSync(
      join(other, ".config", "fleetrc", "config.json"),
      `\uFEFF${JSON.stringify({ manifest: "github:someone/else//.fleetrc/manifest.json" })}`,
    );
    const env = initShims(m, { other });
    const run = await m.runWith({ env }, "fleet", "init", "other");
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      `other: it has the manifest github:someone/else//.fleetrc/manifest.json; pass --force to set it up with ${spec}`,
    );
    expect(npxCalls(m)).toEqual([]);
    expect(run.stdout).not.toContain("added");

    const forced = await m.runWith({ env }, "fleet", "init", "other", "--force", "--no-hooks");
    expect(forced.code, forced.stdout + forced.stderr).toBe(0);
    expect(npxCalls(m)[0]).toEqual(expect.arrayContaining(["--no-hooks", "--force", spec]));
    expect(forced.stdout).toMatch(/^other: set up; last run /m);
  });

  it("only syncs an installed host with the same manifest in another spelling", async () => {
    const { m, spec } = await controller();
    const env = initShims(m, { same: join(m.root, "same") });
    const run = await m.runWith({ env }, "fleet", "init", "same", "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const file = join(m.root, "same", ".config", "fleetrc", "config.json");
    const alias = spec.replace("//.fleetrc/manifest.json", "");
    writeFileSync(file, JSON.stringify({ manifest: alias }));
    const again = await m.runWith({ env }, "fleet", "init", "same");
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^same: already set up; last run /m);
    expect(npxCalls(m)).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")) as unknown).toMatchObject({ manifest: alias });
  });

  it("refuses an alias shadowed by a local file in the host's login directory", async () => {
    const m = machine();
    const home = join(m.root, "box");
    const env = initShims(m, { box: home });
    const alias = "me/skills//.fleetrc/manifest.json";
    const spec = `github:${alias}`;
    const config = join(home, ".config", "fleetrc");
    const bin = join(home, ".local", "state", "fleetrc", "bin");
    mkdirSync(config, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const contents = JSON.stringify({ manifest: alias });
    writeFileSync(join(config, "config.json"), contents);
    mkdirSync(join(home, "me", "skills", ".fleetrc"), { recursive: true });
    writeFileSync(join(home, alias), "{}");
    const launcher = join(bin, "fleetrc");
    writeFileSync(launcher, `#!/bin/sh\ntouch "${m.root}/synced"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const [result] = await fleet(["box"], "init", "1.2.3", 30_000, {
        setup: { spec, flags: [], force: false, same: (value) => sameManifest(value, spec) },
      });
      expect(result).toMatchObject({ reachable: true, error: expect.stringContaining(alias) });
      expect(result?.setup).toBeUndefined();
      expect(existsSync(join(m.root, "synced"))).toBe(false);
      expect(readFileSync(join(config, "config.json"), "utf8")).toBe(contents);
      expect(npxCalls(m)).toEqual([]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("completes setup after a real hook installation failure", async () => {
    const { m, fleetIn } = await controller();
    const home = join(m.root, "vps2");
    const env = initShims(m, { vps2: home });
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(settings, "{ invalid JSON");
    const failed = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(fleetIn()).toEqual([]);
    const launcher = join(home, ".local", "state", "fleetrc", "bin", "fleetrc");
    const nodeOnly = join(m.root, "node-only");
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    writeFileSync(
      launcher,
      readFileSync(launcher, "utf8").replace(/^exec "[^"]*"/m, `exec "${join(nodeOnly, "node")}"`),
    );
    writeFileSync(settings, "{}");
    const retry = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);
    expect(retry.stdout).toMatch(/^vps2: set up; /m);
    expect(npxCalls(m)).toHaveLength(2);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toHaveProperty("hooks.SessionStart");
    expect(fleetIn()).toEqual(["vps2"]);
  });

  it("returns one JSON document if enrollment fails after setup", async () => {
    const { m } = await controller();
    writeFileSync(m.at("code", "manifests", ".fleetrc", "manifest.json"), "{ invalid JSON");
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env }, "fleet", "init", "vps2", "--json", "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      hosts: [{ host: "vps2", setup: "set up" }],
      error: expect.stringContaining("not valid JSON"),
    });
  });

  it("rejects contradictory copy flags without calling SSH", async () => {
    const { m } = await controller();
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env }, "fleet", "init", "vps2", "--copy", "--no-copy");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--copy and --no-copy contradict each other");
    expect(npxCalls(m)).toEqual([]);
    expect(existsSync(join(m.root, "vps2", ".config"))).toBe(false);
  });

  it("does not claim cancellation if an npx child survives the SSH timeout", async () => {
    const { m, fleetIn } = await controller();
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const release = join(m.root, "release-child");
    const finished = join(m.root, "child-finished");
    writeFileSync(
      join(m.root, "bin", "npx"),
      `#!/bin/sh
(remaining=100
while [ "$remaining" -gt 0 ]; do
  if [ -f "${release}" ]; then touch "${finished}"; exit; fi
  remaining=$((remaining - 1))
  sleep 0.2
done) </dev/null >/dev/null 2>&1 &
wait
`,
    );
    try {
      const run = await m.runWith({ env }, "fleet", "init", "vps2", "--timeout", "4");
      expect(run.code, run.stdout + run.stderr).toBe(1);
      expect(run.stdout).toContain(
        "setup did not finish before SSH disconnected and may still be running",
      );
      expect(fleetIn()).toEqual([]);
    } finally {
      writeFileSync(release, "");
    }
    await vi.waitFor(() => expect(existsSync(finished)).toBe(true), { timeout: 5000 });
  });

  it("enrolls overlapping tags even when a named peer takes precedence", async () => {
    const { m, fleetIn } = await controller();
    const host = "100.64.1.77";
    const program = fakeTailscale(
      m.root,
      status([peer("vps2.tail.ts.net", ["tag:servers", "tag:workers"], { ips: [host] })]),
    );
    const env = {
      ...initShims(m, { [host]: join(m.root, "vps2") }),
      FLEETRC_TAILSCALE: program,
    };
    const run = await m.runWith(
      { env },
      "fleet",
      "init",
      "tag:servers",
      host,
      "tag:workers",
      "--no-hooks",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(npxCalls(m)).toHaveLength(1);
    expect(fleetIn()).toEqual(["tag:servers", host, "tag:workers"]);
  });

  it("repairs a missing launcher for the same manifest in another spelling", async () => {
    const { m, spec } = await controller();
    const env = initShims(m, { same: join(m.root, "same") });
    const run = await m.runWith({ env }, "fleet", "init", "same", "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    // The host's config omits the default file, which is still this manifest, and its
    // launcher is gone, so it is set up again (with the fake npx: the launcher's node has a real one).
    const file = join(m.root, "same", ".config", "fleetrc", "config.json");
    const alias = spec.replace("//.fleetrc/manifest.json", "");
    writeFileSync(file, JSON.stringify({ manifest: alias }));
    rmSync(join(m.root, "same", ".local", "state", "fleetrc", "bin"), { recursive: true });
    const again = await m.runWith({ env }, "fleet", "init", "same", "--no-hooks");
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^same: set up; last run /m);
    expect(npxCalls(m)).toHaveLength(2);
    expect((JSON.parse(readFileSync(file, "utf8")) as { manifest: string }).manifest).toBe(spec);
  });

  it("an init that exits nonzero there, as when its hooks fail, is not a set-up host and is not added", async () => {
    const { m, fleetIn } = await controller();
    const env = { ...initShims(m, { vps2: join(m.root, "vps2") }), FAKE_NPX_EXIT: "1" };
    const run = await m.runWith({ env }, "fleet", "init", "vps2", "--no-hooks", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(npxCalls(m)).toHaveLength(1);
    const [host] = JSON.parse(run.stdout) as { host: string; setup?: string; error?: string }[];
    expect(host!.setup).toBeUndefined();
    expect(host!.error).toMatch(/^fleetrc init exited 1.*, so the host is not set up$/);
    expect(run.stderr).not.toContain("added vps2");
    expect(fleetIn()).toEqual([]);
  });

  it("runs init again on a host set up already when an option asks for something init does", async () => {
    const { m } = await controller();
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    expect((await m.runWith({ env }, "fleet", "init", "vps2", "--no-hooks")).code).toBe(0);
    // The launcher runs the real node, whose folder has a real npx; give it a node in a folder
    // without one, so init there runs the fake npx on PATH.
    const nodeOnly = join(m.root, "node-only");
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    const launcher = join(m.root, "vps2", ".local", "state", "fleetrc", "bin", "fleetrc");
    writeFileSync(
      launcher,
      readFileSync(launcher, "utf8").replace(/^exec "[^"]*"/m, `exec "${join(nodeOnly, "node")}"`),
    );
    const plain = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(plain.stdout).toMatch(/^vps2: already set up; /m);
    expect(npxCalls(m)).toHaveLength(1);
    const copy = await m.runWith({ env }, "fleet", "init", "vps2", "--copy", "--no-hooks");
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(copy.stdout).toMatch(/^vps2: set up; /m);
    expect(npxCalls(m)).toHaveLength(2);
    expect(npxCalls(m)[1]).toEqual(expect.arrayContaining(["--copy", "--no-hooks"]));
    const config = JSON.parse(
      readFileSync(join(m.root, "vps2", ".config", "fleetrc", "config.json"), "utf8"),
    ) as { copy?: boolean };
    expect(config.copy).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "rejects fleet setup and a flagless retry without its requested timer",
    async () => {
      const { m, fleetIn } = await controller([], { scheduler: "absent" });
      const env = initShims(m, { vps2: join(m.root, "vps2") });
      const run = await m.runWith(
        { env },
        "fleet",
        "init",
        "vps2",
        "--timer",
        "--no-hooks",
        "--json",
      );
      expect.soft(run.code, run.stdout + run.stderr).toBe(1);
      const [host] = JSON.parse(run.stdout) as { setup?: string; error?: string }[];
      expect.soft(host).toMatchObject({
        reachable: true,
        lastRun: { ok: true },
        error: expect.stringContaining("this machine has no systemd user manager"),
      });
      expect.soft(host).not.toHaveProperty("setup");
      keepFakeNpxOnRetry(m, join(m.root, "vps2", ".local", "state", "fleetrc"));
      const retry = await m.runWith({ env }, "fleet", "init", "vps2", "--json");
      expect.soft(retry.code, retry.stdout + retry.stderr).toBe(1);
      expect.soft(JSON.parse(retry.stdout)).toEqual([
        expect.objectContaining({
          error: expect.stringContaining("this machine has no systemd user manager"),
        }),
      ]);
      expect.soft(npxCalls(m)).toHaveLength(2);
      expect(fleetIn()).toEqual([]);
    },
  );

  it("retries a refused timer installation before enrolling the host", async () => {
    const { m, fleetIn } = await controller([], { scheduler: "refuse" });
    const host = join(m.root, "vps2");
    const env = initShims(m, { vps2: host });
    const first = await m.runWith({ env }, "fleet", "init", "vps2", "--timer");
    expect(first.code, first.stdout + first.stderr).toBe(1);
    expect(fleetIn()).toEqual([]);
    const calls = m.schedulerCalls().length;
    expect(calls).toBeGreaterThan(0);

    const state = join(host, ".local", "state", "fleetrc");
    keepFakeNpxOnRetry(m, state);
    const retry = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(retry.code, retry.stdout + retry.stderr).toBe(1);
    expect(npxCalls(m)).toHaveLength(2);
    expect(m.schedulerCalls().length).toBeGreaterThan(calls);
    expect(existsSync(join(state, "init-pending"))).toBe(true);
    expect(fleetIn()).toEqual([]);
  });

  it("does not retry a pending timer after explicit removal", async () => {
    const m = machine({ scheduler: "refuse" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const pending = join(m.stateDir, "init-pending");
    expect((await m.run("init", manifest, "--timer", "--no-hooks")).code).toBe(1);
    expect(readFileSync(pending, "utf8")).toBe("timer\n");

    const remove = await m.runWith({ env: { FLEETRC_TEST_SCHEDULER: "empty" } }, "timer", "remove");
    expect(remove.code, remove.stdout + remove.stderr).toBe(0);
    expect(readFileSync(pending, "utf8")).toBe("");
    const calls = m.schedulerCalls().length;
    const retry = await m.run("init", manifest, "--no-hooks");
    expect.soft(retry.code, retry.stdout + retry.stderr).toBe(0);
    expect.soft(m.schedulerCalls()).toHaveLength(calls);
    expect(existsSync(pending)).toBe(false);
  });

  it("compares equivalent named and tagged hosts without ignoring users or ports", async () => {
    const { m } = await controller(["VPS2", "tag:servers"]);
    const env = {
      ...initShims(m, {}, { VPS2: "vps2" }),
      FLEETRC_TAILSCALE: fakeTailscale(
        m.root,
        status([peer("web.invalid", ["tag:servers"], { ips: ["fd7a::5"] })]),
      ),
    };
    const run = await m.runWith(
      { env },
      "fleet",
      "init",
      "vps2",
      "fd7a:0::5",
      "root@vps2",
      "ssh://[fd7a::5]:2222",
      "--dry-run",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("would add root@vps2, ssh://[fd7a::5]:2222 to the fleet");
  });

  it("enrolls a distinct SSH alias even when a named or tagged host differs only by a dot", async () => {
    const { m, fleetIn } = await controller(["build", "tag:servers"]);
    const env = {
      ...initShims(
        m,
        { "build.": join(m.root, "named"), "web.": join(m.root, "tagged") },
        { build: "build-one.invalid", "build.": "build-two.invalid", "web.": "web-two.invalid" },
      ),
      FLEETRC_TAILSCALE: fakeTailscale(m.root, status([peer("web", ["tag:servers"])])),
    };
    const plan = await m.runWith(
      { env },
      "fleet",
      "init",
      "build",
      "build.",
      "--dry-run",
      "--json",
    );
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject([{ host: "build" }, { host: "build." }]);
    const run = await m.runWith({ env }, "fleet", "init", "build.", "web.", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([
      { host: "build.", setup: "set up" },
      { host: "web.", setup: "set up" },
    ]);
    expect(fleetIn()).toEqual(["build", "tag:servers", "build.", "web."]);
  });

  it("enrolls successful named hosts but not tags with offline or unaddressable peers", async () => {
    const { m, fleetIn } = await controller();
    const active = peer("web.invalid", ["tag:servers", "tag:broken", "tag:ready"], {
      ips: ["100.64.0.5"],
    });
    const offline = peer("offline.invalid", ["tag:servers"], { online: false });
    const broken = peer("???", ["tag:broken"], { ips: [] });
    const env = {
      ...initShims(m, { "web.invalid": join(m.root, "web") }, { "web.invalid": "100.64.0.5" }),
      FLEETRC_TAILSCALE: fakeTailscale(m.root, status([active, offline, broken])),
    };
    const preview = await m.runWith(
      { env },
      "fleet",
      "init",
      "tag:servers",
      "tag:broken",
      "tag:ready",
      "web.invalid",
      "--dry-run",
    );
    expect.soft(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect.soft(preview.stdout).toContain("would add tag:ready, web.invalid to the fleet");
    expect.soft(fleetIn()).toEqual([]);
    const run = await m.runWith(
      { env },
      "fleet",
      "init",
      "tag:servers",
      "tag:broken",
      "tag:ready",
      "web.invalid",
      "--no-hooks",
      "--json",
    );
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "web.invalid", setup: "set up" }),
        expect.objectContaining({ host: "offline.invalid", error: "offline in Tailscale" }),
      ]),
    );
    expect(run.stderr).toContain("tag:broken: skipped a machine");
    expect(fleetIn()).toEqual(["tag:ready", "web.invalid"]);
  });

  it("does not use a successful alias as setup for an unrelated peer with the same name", async () => {
    const { m, fleetIn } = await controller();
    const host = "web.invalid";
    const env = {
      ...initShims(m, { [host]: join(m.root, "alias") }, { [host]: "100.64.0.6" }),
      FLEETRC_TAILSCALE: fakeTailscale(
        m.root,
        status([peer(host, ["tag:servers"], { ips: ["100.64.0.5"], online: false })]),
      ),
    };
    const run = await m.runWith(
      { env },
      "fleet",
      "init",
      "tag:servers",
      host,
      "--no-hooks",
      "--json",
    );
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject([
      { host, via: "tag:servers", error: "offline in Tailscale" },
      { host, setup: "set up" },
    ]);
    expect(fleetIn()).toEqual([host]);
  });

  it("retains tagged peer reports across init errors and offline status", async () => {
    const { m, fleetIn } = await controller();
    const ssh = join(m.root, "ssh.mjs");
    const online = peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5"] });
    const tailscale = fakeTailscale(m.root, status([online]));
    writeFileSync(
      ssh,
      `
const success = { finishedAt: "2026-01-01T00:00:00Z", ok: true };
if (process.argv.includes("-G")) {
  const host = process.argv[process.argv.indexOf("--") + 1];
  console.log("hostname " + host + "\\nuser alice\\nport 22");
  process.exit(0);
}
if (process.env.FAKE_ANSWER === "mismatch") {
  console.error("fleetrc-fleet: has github:another/manifest");
  console.log("fleetrc-fleet: other-manifest");
} else if (process.env.FAKE_ANSWER === "failed") {
  console.log(JSON.stringify({ sync: { ...success, finishedAt: "2026-01-01T00:01:00Z", ok: false } }));
  process.exitCode = 1;
} else console.log(JSON.stringify(success));
`,
    );
    const run = (action: string, answer?: string) =>
      m.runWith(
        {
          env: {
            FLEETRC_SSH: ssh,
            FLEETRC_TAILSCALE: tailscale,
            FLEETRC_PACKAGE: "/pkg/fleetrc.tgz",
            FAKE_ANSWER: answer,
          },
        },
        "fleet",
        action,
        "tag:servers",
        "--json",
      );
    expect((await run("status")).code).toBe(0);
    const mismatch = await run("init", "mismatch");
    expect(mismatch.code).toBe(1);
    expect
      .soft(JSON.parse(mismatch.stdout))
      .toMatchObject([
        { error: expect.stringContaining("another/manifest"), lastRun: { ok: true } },
      ]);
    const failed = await run("init", "failed");
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject([
      { error: expect.stringContaining("first sync had errors"), lastRun: { ok: false } },
    ]);
    expect(fleetIn()).toEqual([]);
    fakeTailscale(m.root, status([{ ...online, Online: false }]));
    const offline = await run("status");
    expect(offline.code).toBe(1);
    expect(JSON.parse(offline.stdout)).toMatchObject([
      { error: "offline in Tailscale", lastRun: { finishedAt: "2026-01-01T00:01:00Z", ok: false } },
    ]);
  });

  it("this machine is already set up; a host a tag of the fleet matches is not added again", async () => {
    const { m, fleetIn } = await controller(["tag:servers"]);
    const ip = "100.64.0.5";
    const program = fakeTailscale(
      m.root,
      status([peer("web.invalid", ["tag:servers"], { ips: [ip] })]),
    );
    const env = { ...initShims(m, {}, { localhost: ip }), FLEETRC_TAILSCALE: program };
    const run = await m.runWith({ env }, "fleet", "init", "localhost", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      expect.objectContaining({ host: "localhost", setup: "already set up", reachable: true }),
    ]);
    expect(npxCalls(m)).toEqual([]);
    expect(run.stderr).toContain("the fleet already has them");
    expect(fleetIn()).toEqual(["tag:servers"]);
  });

  it("does not enroll IPv6 when the tag selects the same peer's IPv4 address", async () => {
    const { m, fleetIn } = await controller(["tag:servers"]);
    const ipv6 = "fd7a::5";
    const tailscale = fakeTailscale(m.root, {
      ...status([peer("web.invalid", ["tag:servers"], { ips: ["100.64.0.5", ipv6] })]),
      CurrentTailnet: { MagicDNSEnabled: false },
    });
    const env = {
      ...initShims(m, { [ipv6]: join(m.root, "web") }),
      FLEETRC_TAILSCALE: tailscale,
    };
    const run = await m.runWith({ env }, "fleet", "init", ipv6, "--no-hooks", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject([{ host: ipv6, setup: "set up" }]);
    expect(run.stderr).toContain("the fleet already has them");
    expect(fleetIn()).toEqual(["tag:servers"]);
  });

  it("--dry-run prints the command for each host and the fleet change, and runs nothing", async () => {
    const { m, spec, fleetIn } = await controller(["laptop"]);
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env }, "fleet", "init", "vps2", "laptop", "--timer", "--dry-run");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `vps2: would run npx -y --package /pkg/fleetrc.tgz -- fleetrc init ${spec} --timer --json\n`,
    );
    expect(run.stdout).toContain(
      "would add vps2 to the fleet in ~/code/manifests/.fleetrc/manifest.json",
    );
    const json = await m.runWith({ env }, "fleet", "init", "vps2", "--dry-run", "--json");
    expect(JSON.parse(json.stdout)).toEqual([
      { host: "vps2", command: expect.stringContaining(`fleetrc init ${spec} --json`) },
    ]);
    expect(npxCalls(m)).toEqual([]);
    expect(existsSync(join(m.root, "vps2", ".config"))).toBe(false);
    expect(fleetIn()).toEqual(["laptop"]);
  });

  it("refuses a manifest on this machine, which hosts can't read", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const env = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env }, "fleet", "init", "vps2");
    expect(run.code).toBe(1);
    expect(run.stderr.trim()).toBe(
      `fleetrc: the manifest is ${manifest}, on this machine, which other machines can't read; push it to a repository and run \`fleetrc init <repository>\` with that`,
    );
    expect(npxCalls(m)).toEqual([]);
  });

  it("refuses a development build without FLEETRC_PACKAGE, as fleet upgrade does", async () => {
    const { m } = await controller();
    const { PATH } = initShims(m, { vps2: join(m.root, "vps2") });
    const run = await m.runWith({ env: { PATH } }, "fleet", "init", "vps2");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("this fleetrc is a development or preview build (0.0.0)");
    expect(run.stderr).toContain("FLEETRC_PACKAGE");
    expect(npxCalls(m)).toEqual([]);
  });

  it("passes a hostile manifest spec to the host's init as one word", async () => {
    const m = machine();
    initShims(m, { box: join(m.root, "box") });
    const spec = `https://h.example/a'$(touch ${m.root}/P)\`touch ${m.root}/Q\`"; touch ${m.root}/R; '.git//m.json`;
    const setup: InitSetup = { spec, flags: ["--timer"], force: false, same: () => false };
    const saved = {
      FLEETRC_SSH: process.env.FLEETRC_SSH,
      PATH: process.env.PATH,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      FAKE_NPX_RECORD_ONLY: process.env.FAKE_NPX_RECORD_ONLY,
    };
    process.env.XDG_STATE_HOME = join(m.root, "state");
    process.env.FAKE_NPX_RECORD_ONLY = "1";
    process.env.FLEETRC_SSH = join(m.root, "bin", "ssh.mjs");
    process.env.PATH = pathWith(join(m.root, "bin"), process.env);
    try {
      await fleet(["box"], "init", "1.2.3", 30_000, { setup });
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    expect(npxCalls(m)).toEqual([
      ["-y", "--package", "fleetrc@1.2.3", "--", "fleetrc", "init", spec, "--timer", "--json"],
    ]);
    for (const file of ["P", "Q", "R"]) expect(existsSync(join(m.root, file))).toBe(false);
  });

  it("sends the host a spec that no folder there can stand for, and runs its init from /", () => {
    expect(hostManifestSpec("me/skills//.fleetrc/manifest.json")).toBe(
      "github:me/skills//.fleetrc/manifest.json",
    );
    expect(hostManifestSpec("me/skills//teams/web.json")).toBe("github:me/skills//teams/web.json");
    expect(hostManifestSpec("me/skills")).toBe("github:me/skills//.fleetrc/manifest.json");
    for (const kept of [
      // A link that pins a branch is the one form that keeps it.
      "https://github.com/me/skills/blob/dev/teams/web.json",
      "https://github.com/me/skills/tree/v1.2/teams/web",
      "gitlab:group/skills//team.json",
      "https://git.example.com/me/skills.git//team.json",
      "github:me/skills//team.json",
    ])
      expect(hostManifestSpec(kept)).toBe(kept);

    // On the host, a folder me/skills in the login folder would be read as the manifest.
    const m = machine();
    mkdirSync(join(m.home, "me", "skills"), { recursive: true });
    writeFileSync(join(m.home, "me", "skills", "team.json"), "{}");
    const bin = join(m.root, "npx-bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > "${m.root}/npx-ran"\n`,
    );
    chmodSync(join(bin, "npx"), 0o755);
    const spec = hostManifestSpec("me/skills//team.json");
    spawnSync(
      "/bin/sh",
      [
        "-c",
        remoteScript("init", "1.2.3", {
          setup: { spec, flags: [], force: false, same: () => false },
        }),
      ],
      { cwd: m.home, env: { HOME: m.home, PATH: `${bin}:/usr/bin:/bin` }, input: "" },
    );
    const [cwd, ...args] = readFileSync(join(m.root, "npx-ran"), "utf8").trim().split("\n");
    expect(cwd).toBe("/");
    expect(args).toEqual(expect.arrayContaining(["init", "github:me/skills//team.json"]));
  });

  it.each([
    ["preview.tgz", true],
    ["release.tar.gz", true],
    ["release.tar", true],
    ["./dist/preview.tgz", true],
    ["owner/repo.tgz", false],
    ["@scope/name.tgz", false],
  ])(
    "passes FLEETRC_PACKAGE %s without changing its meaning from the login folder",
    (pkg, relative) => {
      const m = machine();
      const bin = join(m.root, "npx-bin");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${m.root}/npx-ran"\n`);
      chmodSync(join(bin, "npx"), 0o755);
      const before = process.env.FLEETRC_PACKAGE;
      process.env.FLEETRC_PACKAGE = pkg;
      try {
        const script = remoteScript("init", "1.2.3", {
          setup: { spec: "github:me/skills", flags: [], force: false, same: () => false },
        });
        spawnSync("/bin/sh", ["-c", script], {
          cwd: m.home,
          env: { HOME: m.home, PATH: `${bin}:/usr/bin:/bin` },
          input: "",
        });
      } finally {
        if (before === undefined) delete process.env.FLEETRC_PACKAGE;
        else process.env.FLEETRC_PACKAGE = before;
      }
      const args = readFileSync(join(m.root, "npx-ran"), "utf8").trim().split("\n");
      expect(args[2]).toBe(relative ? `${realpathSync(m.home)}/${pkg}` : pkg);
    },
  );

  it("takes two manifest specs as the same only when their repository surely is", () => {
    const file = "//.fleetrc/manifest.json";
    for (const [a, b] of [
      ["me/skills", `github:me/skills${file}`],
      [`me/skills${file}`, `https://github.com/me/skills.git${file}`],
      [`https://GitHub.com/me/skills${file}`, `git@github.com:me/skills.git${file}`],
      ["gitlab:group/skills", `https://gitlab.com/group/skills.git${file}`],
      [
        `https://git.example.com/me/skills.git${file}`,
        `https://GIT.example.com/me/skills.git${file}`,
      ],
      [`git@GIT.example.com:me/skills.git${file}`, `git@git.example.com:me/skills.git${file}`],
    ])
      expect.soft(sameManifest(a!, b!), `${a} = ${b}`).toBe(true);
    for (const [a, b] of [
      // Repository paths are case-sensitive on many servers.
      [`https://git.example.com/Docs.git${file}`, `https://git.example.com/docs.git${file}`],
      [`https://git.example.com/me/x.git${file}`, `https://git.example.com/me/x${file}`],
      [`https://git.example.com/me/x.git${file}`, `http://git.example.com/me/x.git${file}`],
      [`https://git.example.com/me/x.git${file}`, `https://www.git.example.com/me/x.git${file}`],
      [`me/Skills${file}`, `me/skills${file}`],
      // On a host that isn't GitHub or GitLab, host:path is relative to the user's home there.
      [`git@git.example.com:me/x.git${file}`, `ssh://git@git.example.com/me/x.git${file}`],
      [`https://git.example.com:8443/me/x.git${file}`, `https://git.example.com/me/x.git${file}`],
      [
        "https://github.com/me/skills/blob/main/a.json",
        "https://github.com/me/skills/blob/dev/a.json",
      ],
      [`me/skills//a.json`, `me/skills//A.json`],
      // Two accounts on one server each have their own home folder.
      [`alice@git.example.com:skills.git${file}`, `bob@git.example.com:skills.git${file}`],
      [
        `ssh://alice@git.example.com/skills.git${file}`,
        `ssh://bob@git.example.com/skills.git${file}`,
      ],
    ])
      expect.soft(sameManifest(a!, b!), `${a} ≠ ${b}`).toBe(false);
  });

  it("a host without node or npx gets one line on what to install", () => {
    const m = machine();
    const bin = join(m.root, "ssh-bin");
    mkdirSync(bin);
    const run = (path: string) =>
      spawnSync(
        "/bin/sh",
        [
          "-c",
          remoteScript("init", "1.2.3", {
            setup: {
              spec: "me/skills//.fleetrc/manifest.json",
              flags: [],
              force: false,
              same: () => false,
            },
          }),
        ],
        { env: { HOME: m.home, PATH: path }, encoding: "utf8" },
      ).stdout.trim();
    expect(run(bin)).toBe("fleetrc-fleet: init-no-node");
    symlinkSync(process.execPath, join(bin, "node"));
    expect(run(bin)).toBe("fleetrc-fleet: no-npx");
  });
});

describe("markBehind", () => {
  const now = Date.parse("2026-11-21T14:00:00Z");
  const host = (
    name: string,
    finishedAt: string,
    mine: string,
    held: string[] = [],
  ): HostResult => ({
    host: name,
    reachable: true,
    checked: true,
    behind: [],
    lastRun: {
      finishedAt,
      ok: true,
      fleetrc: "0.0.1",
      host: name,
      skills: 1,
      held,
      errors: [],
      sources: { mine },
    },
  });

  it("measures hosts against the newest host that took the source, not one holding it", () => {
    const current = host("air", "2026-11-21T13:58:00Z", "8de87ca0");
    const holding = host("mbp", "2026-11-21T13:59:00Z", "700ccfb0", ["mine"]);
    const old = host("vps", "2026-11-21T13:50:00Z", "69147e30");
    markBehind([current, holding, old], now);
    expect(current.behind).toEqual([]);
    expect(holding.behind).toEqual(["held: mine"]);
    expect(old.behind).toEqual(["mine at 69147e3"]);
  });
});
