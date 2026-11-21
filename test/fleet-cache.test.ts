import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vite-plus/test";
import { exec } from "../src/exec.ts";
import { fleet, notInFleet, resolveFleet, type FleetAction } from "../src/fleet.ts";

vi.mock("../src/exec.ts", () => ({ exec: vi.fn() }));

it.each([
  {
    name: "offline observations do not set the reference",
    runs: [
      { status: "updated", to: "8de87ca0" },
      { status: "offline", to: "700ccfb0" },
      { status: "held", to: "700ccfb0", reason: "local edits overlap" },
    ],
    behind: [[], ["vendor at 700ccfb"], ["held: vendor"]],
  },
  {
    name: "a skill conflict does not hold the source revision",
    runs: [
      { status: "unchanged", to: "700ccfb0" },
      { status: "updated", to: "8de87ca0", reason: "skill has unresolved merge conflicts" },
    ],
    behind: [["vendor at 700ccfb"], ["held: vendor"]],
  },
])("compares live and cached runs: $name", async ({ runs, behind }) => {
  const root = mkdtempSync(join(tmpdir(), "fleetrc-cache-"));
  vi.stubEnv("XDG_STATE_HOME", root);
  vi.stubEnv("FLEETRC_SSH", "ssh");
  const hosts = runs.map((_, index) => `host-${index}`);
  const now = Date.now();
  vi.mocked(exec).mockImplementation(async (_command, args) => {
    const host = args.at(-2)!;
    const index = hosts.indexOf(host);
    const { status, to, reason } = runs[index]!;
    return {
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      stdout: JSON.stringify({
        host,
        finishedAt: new Date(now - (runs.length - index) * 60_000).toISOString(),
        ok: true,
        sources: [{ id: "vendor", status, to }],
        held: reason ? [{ source: "vendor", reason, files: [] }] : [],
      }),
    };
  });
  try {
    const live = await fleet(hosts, "status", "0.0.0");
    expect(live.map((result) => result.behind)).toEqual(behind);
    const cached = await fleet(
      hosts.map((host) => ({ host, offline: true })),
      "status",
      "0.0.0",
    );
    expect(cached.map((result) => result.behind)).toEqual(behind);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("recognizes a tagged peer alias after a DNS timeout", async () => {
  vi.stubEnv("FLEETRC_TAILSCALE", "tailscale");
  vi.stubEnv("FLEETRC_SSH", "ssh");
  const name = "server.tail.test";
  const address = "100.64.0.5";
  const tag = "tag:servers";
  const server = { DNSName: `${name}.`, TailscaleIPs: [address], Tags: [tag], Online: true };
  vi.mocked(exec).mockImplementation(async (command, args, options) => {
    const result = { stderr: "", code: 0, timedOut: false, truncated: false };
    if (command === "tailscale") return { ...result, stdout: JSON.stringify({ Peer: { server } }) };
    if (command === process.execPath) {
      await delay((options?.timeoutMs ?? 0) + 1);
      return { ...result, stdout: "", timedOut: true };
    }
    const host = args[args.indexOf("--") + 1];
    return {
      ...result,
      stdout: `hostname ${host === name ? name : address}\nuser alice\nport 22\n`,
    };
  });
  try {
    expect(await notInFleet([tag], ["server-alias"], 100)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([false, true])("only refreshes on the same retry route (%s)", async (changed) => {
  const root = mkdtempSync(join(tmpdir(), "fleetrc-cache-"));
  vi.stubEnv("XDG_STATE_HOME", root);
  vi.stubEnv("FLEETRC_TAILSCALE", "tailscale");
  vi.stubEnv("FLEETRC_SSH", "ssh");
  const address = "100.64.0.5";
  const tag = "tag:servers";
  const observed = "owner/manifest//manifest.json";
  const first = "2026-01-01T00:00:00Z";
  const second = "2026-01-01T00:01:00Z";
  const setup = {
    spec: "github:owner/manifest",
    flags: [],
    force: false,
    same: (spec: string) => spec === observed,
  };
  let online = true;
  let retries = 0;
  vi.mocked(exec).mockImplementation(async (command, args) => {
    const remote = args.at(-1) ?? "";
    const init = remote.includes(setup.spec);
    const retry = init && remote.includes(observed);
    const result = { stderr: "", code: 0, timedOut: false, truncated: false };
    if (command === "tailscale") {
      const server = { ID: "server", TailscaleIPs: [address], Tags: [tag], Online: online };
      return { ...result, stdout: JSON.stringify({ Peer: { server } }) };
    }
    if (args.includes("-G"))
      return {
        ...result,
        stdout: `hostname ${address}\nuser alice\nport ${changed && retry ? 2222 : 22}\n`,
      };
    if (init && !retry)
      return {
        ...result,
        stderr: `fleetrc-fleet: has ${observed}\n`,
        stdout: "fleetrc-fleet: other-manifest\n",
      };
    if (retry) retries++;
    return {
      ...result,
      stdout: JSON.stringify(
        init ? { sync: { finishedAt: second, ok: true } } : { finishedAt: first, ok: true },
      ),
    };
  });
  const run = async (action: FleetAction, ...entries: string[]) => {
    const invocation = { action, version: "0.0.0", setup: action === "init" ? setup : undefined };
    const { targets, enrollment } = await resolveFleet(entries, undefined, 30_000, invocation);
    const results = await fleet(targets, action, invocation.version, 30_000, invocation);
    return { results, enrollment, targets };
  };
  try {
    expect((await run("status", tag)).results).toMatchObject([{ lastRun: { finishedAt: first } }]);
    expect((await run("init", address)).results).toMatchObject([
      { lastRun: { finishedAt: second } },
    ]);
    const rejected = {
      error: "could not verify an unchanged SSH route to the Tailscale peer for the retry",
    };
    if (changed) expect((await run("init", tag)).results).toMatchObject([rejected]);
    const named = await run("init", "alias", tag);
    expect(named.targets).toMatchObject([{ host: "alias" }]);
    for (const selector of ["alias", tag]) {
      const enrolled = named.enrollment.get(selector);
      expect(enrolled).toHaveLength(1);
      expect(enrolled?.[0]).toBe(named.targets[0]);
    }
    expect(named.results).toMatchObject([
      changed ? rejected : { host: "alias", setup: "set up", lastRun: { finishedAt: second } },
    ]);
    expect(named.results[0]?.setup).toBe(changed ? undefined : "set up");
    expect(retries).toBe(changed ? 1 : 2);
    online = false;
    expect((await run("status", tag)).results).toMatchObject([
      { error: "offline in Tailscale", lastRun: { finishedAt: changed ? first : second } },
    ]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["status", "sync", "upgrade"] as const)(
  "verifies tag-only SSH routes before dispatching %s or attributing a report",
  async (action) => {
    const root = mkdtempSync(join(tmpdir(), "fleetrc-cache-"));
    vi.stubEnv("XDG_STATE_HOME", root);
    vi.stubEnv("FLEETRC_TAILSCALE", "tailscale");
    vi.stubEnv("FLEETRC_SSH", "ssh");
    const name = "server.tail.test";
    const address = "100.64.0.5";
    const tag = "tag:servers";
    let online = true;
    let redirectedIP = false;
    const dispatched: string[] = [];
    vi.mocked(exec).mockImplementation(async (command, args) => {
      const host = args[args.indexOf("--") + 1] ?? "";
      let stdout: string;
      if (command === "tailscale") {
        stdout = JSON.stringify({
          Peer: {
            server: {
              ID: "server",
              DNSName: `${name}.`,
              TailscaleIPs: [address],
              Tags: [tag],
              Online: online,
            },
          },
        });
      } else if (args.includes("-G")) {
        const destination = host === name || redirectedIP ? "100.64.0.6" : host;
        stdout = `hostname ${destination}\nuser alice\nport 22\n`;
      } else {
        dispatched.push(host);
        stdout = JSON.stringify({ finishedAt: "2026-01-01T00:00:00Z", ok: true, skills: 1, host });
      }
      return { stdout, stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const run = async () => {
      const { targets } = await resolveFleet([tag], async () => [address], 30_000, {
        action,
        version: "0.0.0",
      });
      return fleet(targets, action, "0.0.0");
    };
    try {
      redirectedIP = true;
      expect(await run()).toMatchObject([{ via: tag, reachable: false, checked: false }]);
      expect(dispatched).toEqual([]);
      online = false;
      expect((await run())[0]?.lastRun).toBeUndefined();
      online = true;
      redirectedIP = false;
      expect(await run()).toMatchObject([{ host: address, lastRun: { host: address } }]);
      online = false;
      expect(await run()).toMatchObject([{ host: name, lastRun: { host: address } }]);
      expect(dispatched).toEqual([address]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("preserves distinct spellings of unverified SSH aliases", async () => {
  const { targets } = await resolveFleet(["localhost", "localhost.", "LOCALHOST", "localhost"]);
  expect(targets).toEqual([{ host: "localhost" }, { host: "localhost." }, { host: "LOCALHOST" }]);
});

it.each([true, false])(
  "refreshes offline reports only for the same peer and endpoint (reassigned: %s)",
  async (reassigned) => {
    const root = mkdtempSync(join(tmpdir(), "fleetrc-cache-"));
    vi.stubEnv("XDG_STATE_HOME", root);
    vi.stubEnv("FLEETRC_TAILSCALE", "tailscale");
    vi.stubEnv("FLEETRC_SSH", "ssh");
    const times = ["2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", "2026-01-01T00:02:00Z"];
    const address = "100.64.0.5";
    const name = "old.tail.test";
    const peer = {
      ID: "a",
      DNSName: `${name}.`,
      TailscaleIPs: [address],
      Tags: ["tag:servers"],
      Online: true,
    };
    const offline = { ...peer, DNSName: "new.tail.test.", Online: false };
    let peers = { a: peer, b: undefined as typeof peer | undefined };
    let user = "alice";
    let time = times[0];
    vi.mocked(exec).mockImplementation(async (command, args) => {
      const stdout =
        command === "tailscale"
          ? JSON.stringify({ BackendState: "Running", Peer: peers })
          : args.includes("-G")
            ? `hostname ${args[args.indexOf("--") + 1]}\nuser ${user}\nport 22\n`
            : JSON.stringify({ finishedAt: time, ok: true, skills: 1 });
      return { stdout, stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const status = async (host: string) => {
      const { targets } = await resolveFleet([host], async (hostname) =>
        hostname === name ? [address] : [],
      );
      return fleet(targets, "status", "0.0.0");
    };
    try {
      expect(await status("tag:servers")).toMatchObject([
        { host: name, lastRun: { finishedAt: times[0] } },
      ]);
      if (reassigned)
        peers = {
          a: { ...offline, TailscaleIPs: ["100.64.0.6"] },
          b: { ...peer, ID: "b", Tags: [] },
        };
      time = times[1];
      expect(await status(name)).toMatchObject([{ lastRun: { finishedAt: times[1] } }]);
      if (!reassigned) {
        user = "bob";
        time = times[2];
        expect(await status(name)).toMatchObject([{ lastRun: { finishedAt: times[2] } }]);
        peers = { a: offline, b: undefined };
      }
      expect(await status("tag:servers")).toMatchObject([
        {
          host: "new.tail.test",
          error: "offline in Tailscale",
          lastRun: { finishedAt: times[reassigned ? 0 : 1] },
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const scenarios = [
  "command-specific user",
  "matching explicit IP",
  "different explicit user",
  "alias refresh",
  "alias seed",
  "unchanged alias report",
  "older alias report",
];

it.each(scenarios)(
  "attributes tagged reports to the actual SSH endpoint (%s)",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "fleetrc-cache-"));
    vi.stubEnv("XDG_STATE_HOME", root);
    vi.stubEnv("FLEETRC_TAILSCALE", "tailscale");
    vi.stubEnv("FLEETRC_SSH", "ssh");
    const address = "100.64.0.5";
    const tag = "tag:servers";
    const alias = "server-alias";
    const first = "2026-01-01T00:00:00Z";
    const second = "2026-01-01T00:01:00Z";
    const third = "2026-01-01T00:02:00Z";
    const fourth = "2026-01-01T00:03:00Z";
    const differentCommand = scenario === "command-specific user";
    const differentUser = scenario === "different explicit user";
    let online = true;
    let time = first;
    vi.mocked(exec).mockImplementation(async (command, args) => {
      const [entry, remoteCommand] = args.slice(args.indexOf("--") + 1);
      const user =
        entry === `bob@${address}` || (differentCommand && remoteCommand?.includes("last-run.json"))
          ? "bob"
          : "alice";
      const stdout =
        command === "tailscale"
          ? JSON.stringify({
              BackendState: "Running",
              CurrentTailnet: { MagicDNSEnabled: false },
              Peer: { a: { ID: "a", Tags: [tag], TailscaleIPs: [address], Online: online } },
            })
          : args.includes("-G")
            ? `hostname ${address}\nuser ${user}\nport 22\n`
            : JSON.stringify({ finishedAt: time, ok: true, skills: 1, host: user });
      return { stdout, stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const run = async (action: FleetAction, ...entries: string[]) => {
      const { targets } = await resolveFleet(entries, undefined, 30_000, {
        action,
        version: "0.0.0",
      });
      return fleet(targets, action, "0.0.0");
    };
    let latest = first;
    try {
      if (differentCommand) {
        expect(await run("sync", tag)).toMatchObject([
          { lastRun: { finishedAt: first, host: "alice" } },
        ]);
        time = second;
        expect(await run("status", address)).toMatchObject([
          { lastRun: { finishedAt: second, host: "bob" } },
        ]);
      } else if (scenario === "unchanged alias report" || scenario === "older alias report") {
        time = second;
        expect(await run("status", tag)).toMatchObject([
          { host: address, via: tag, lastRun: { finishedAt: second } },
        ]);
        if (scenario === "older alias report") time = first;
        expect(await run("status", alias, tag)).toMatchObject([
          { host: alias, lastRun: { finishedAt: time } },
        ]);
        if (scenario === "older alias report") {
          online = false;
          expect(await run("status", tag)).toMatchObject([
            { host: address, error: "offline in Tailscale", lastRun: { finishedAt: second } },
          ]);
          online = true;
        }
        time = third;
        expect(await run("sync", alias)).toMatchObject([
          { host: alias, lastRun: { finishedAt: third } },
        ]);
        latest = third;
      } else if (scenario === "alias refresh" || scenario === "alias seed") {
        if (scenario === "alias refresh") {
          expect(await run("status", tag)).toMatchObject([
            { host: address, via: tag, lastRun: { finishedAt: first } },
          ]);
        }
        time = second;
        expect(await run("status", alias, tag)).toMatchObject([
          { host: alias, lastRun: { finishedAt: second } },
        ]);
        time = third;
        expect(await run("status", address)).toMatchObject([
          { host: address, lastRun: { finishedAt: third } },
        ]);
        online = false;
        expect(await run("status", tag)).toMatchObject([
          { host: address, error: "offline in Tailscale", lastRun: { finishedAt: third } },
        ]);
        online = true;
        time = fourth;
        expect(await run("status", alias)).toMatchObject([
          { host: alias, lastRun: { finishedAt: fourth } },
        ]);
        latest = fourth;
      } else {
        const host = differentUser ? `bob@${address}` : address;
        const results = await run("status", host, tag);
        expect(results).toMatchObject([{ host, lastRun: { finishedAt: first } }]);
        expect(results[0]?.via).toBeUndefined();
      }
      online = false;
      const results = await run("status", tag);
      expect(results).toMatchObject([{ host: address, error: "offline in Tailscale" }]);
      expect(results[0]?.lastRun).toEqual(
        differentUser ? undefined : expect.objectContaining({ finishedAt: latest, host: "alice" }),
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
