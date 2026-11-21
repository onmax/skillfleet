// Breaks found by running the packed tarball in Linux containers and over real SSH (test/envs/).
// Each case states what a user should get; they fail until the matching fix lands.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isWindows, machine, type Machine, remote, skills } from "./fixture.ts";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** A fake `ssh` that records its arguments, then runs the command with `sh -c` for `localhost`. */
function recordingSsh(m: Machine): { env: NodeJS.ProcessEnv; calls: () => string[][] } {
  const dir = join(m.root, "bin");
  mkdirSync(dir, { recursive: true });
  const log = join(m.root, "ssh-calls.jsonl");
  const script = join(dir, "ssh.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const rest = args.slice();
while (rest[0] === "-o" || rest[0] === "-p") rest.splice(0, 2);
if (rest[0] === "--") rest.shift();
const [host, command] = rest;
if (host !== "localhost" && host !== "ssh://localhost") {
  process.stderr.write("ssh: Could not resolve hostname " + host + ": Name or service not known\\n");
  process.exit(255);
}
const run = spawnSync("sh", ["-c", command], { stdio: "inherit" });
process.exit(run.status ?? 1);`,
  );
  return {
    env: { FLEETRC_SSH: script },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

describe("linux environments", () => {
  // L1: `npx fleetrc init owner/repo` keeps the manifest in a cached clone; `add` edits that clone
  // and the next fetch resets it, so the source is gone while `add` printed "added".
  it("L1. add on a manifest in a git repository keeps the source past the next sync", async () => {
    const m = machine();
    const team = remote(m, "team", skills("skills/", "team-a"));
    const extra = remote(m, "extra", skills("skills/", "extra-a"));
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "team", git: team.url }],
      }),
    });
    expect(
      (await m.run("init", `${manifests.url}//.fleetrc/manifest.json`, "--no-hooks")).code,
    ).toBe(0);
    const added = await m.run("add", extra.url);
    await m.run("sync");
    // Either add refuses (the manifest lives in a repository it cannot push to), or the source stays.
    if (added.code === 0) expect(existsSync(m.at(".claude/skills/extra-a/SKILL.md"))).toBe(true);
    else expect(added.stderr).toMatch(/repositor/);
  });

  // L2: one agent folder the user can't write crashes the whole sync with a stack trace, so no
  // agent gets its skills, no last-run.json is written and init never installs the launcher.
  it.skipIf(isWindows || isRoot)(
    "L2. a read-only agent folder fails that folder only, with a message",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "ro-skill"));
      const manifest = m.manifest({
        agents: ["claude-code", "gemini-cli"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      mkdirSync(m.at(".gemini/skills"), { recursive: true });
      chmodSync(m.at(".gemini/skills"), 0o555);
      const init = await m.run("init", manifest, "--no-hooks");
      chmodSync(m.at(".gemini/skills"), 0o755);
      expect(init.stderr).not.toMatch(/\n\s+at /);
      expect(existsSync(m.at(".claude/skills/ro-skill/SKILL.md"))).toBe(true);
      expect(existsSync(join(m.stateDir, "last-run.json"))).toBe(true);
      expect(`${init.stdout}${init.stderr}`).toContain(".gemini/skills");
      expect(init.code).toBe(1);
    },
  );

  // L3: offline with a source that was never fetched links nothing and exits 0 without a word.
  it("L3. init --offline names the sources that were never fetched", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "never-fetched"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--offline", "--no-hooks");
    expect(`${init.stdout}${init.stderr}`).toMatch(/vendor.*(never|not).*fetched/);
    expect(init.code).toBe(1);
  });

  // L4: a host that answers over SSH but has never synced is reported "unreachable".
  it("L4. fleet status tells a reachable host that never ran from an unreachable one", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["localhost"] });
    const { env } = recordingSsh(m);
    // Another HOME on the "host", so its state folder is empty.
    const host = join(m.root, "host-home");
    mkdirSync(host);
    const status = await m.runWith(
      { env: { ...env, XDG_STATE_HOME: join(host, "state") } },
      "fleet",
      "status",
      "--manifest",
      manifest,
      "--json",
    );
    const [result] = JSON.parse(status.stdout) as { reachable: boolean; error?: string }[];
    expect(result).toMatchObject({ reachable: true });
  });

  // L5: README gives no port syntax; `user@host:port` is accepted by `fleet add` and then fails in
  // ssh with "Could not resolve hostname host:port".
  it("L5. a fleet host with a port reaches ssh as a port", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const added = await m.run("fleet", "add", "me@localhost:2222");
    if (added.code !== 0) {
      expect(added.stderr).toMatch(/ssh:\/\/|port/i);
      return;
    }
    const ssh = recordingSsh(m);
    await m.runWith({ env: ssh.env }, "fleet", "status", "--timeout", "5");
    const args = ssh.calls()[0] ?? [];
    const ported =
      args.some((arg) => /^ssh:\/\/[^/]*:2222$/.test(arg)) ||
      args.join(" ").includes("-p 2222") ||
      args.join(" ").includes("Port=2222");
    expect(ported, args.join(" ")).toBe(true);
  });

  // L6: README says doctor checks the timer; it has no timer check and exits 0 with no timer.
  it("L6. doctor checks the timer", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // A machine that expects a timer, as one where `timer install` ran once: doctor fails without
    // it. Without the timer it skips the check (test/cli-contract.test.ts).
    writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest, timer: true }));
    const checks = await m.json<{ name: string; ok: boolean }[]>("doctor");
    const timer = checks.find((check) => /timer/i.test(check.name));
    expect(timer, JSON.stringify(checks)).toMatchObject({ ok: false });
  });

  // L7: with systemd, linger off and no login session (cron, `sudo -u`, `docker exec`), loginctl
  // exits 1 with "not logged in or lingering", and doctor reports "ok ... loginctl is not available".
  it.runIf(process.platform === "linux")(
    "L7. doctor reads 'not logged in or lingering' as linger off",
    async () => {
      const m = machine({ scheduler: "empty" });
      const bin = join(m.root, "fakebin");
      mkdirSync(bin);
      const loginctl = join(bin, "loginctl");
      writeFileSync(
        loginctl,
        '#!/bin/sh\necho "Failed to get user: User ID 1000 is not logged in or lingering" >&2\nexit 1\n',
      );
      chmodSync(loginctl, 0o755);
      // A machine that has the timer: linger matters only to it.
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      mkdirSync(m.at(".config/fleetrc"), { recursive: true });
      writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest, timer: true }));
      const checks = await m.runWith({ env: { PATH: `${bin}:${m.env.PATH}` } }, "doctor", "--json");
      const linger = (JSON.parse(checks.stdout) as { name: string; ok: boolean }[]).find(
        (check) => check.name === "systemd linger",
      );
      expect(linger).toMatchObject({ ok: false });
    },
  );

  // L8: the launcher puts paths inside double quotes, so `$`, backticks and `"` in HOME are
  // expanded by sh: the launcher runs `y` and then can't find cli.mjs.
  it.skipIf(isWindows)("L8. the launcher runs from a HOME with shell characters", async () => {
    const m = machine({ agents: false });
    const home = join(m.root, 'it\'s "q" $x `y`');
    mkdirSync(home);
    const env = {
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CONFIG_HOME: join(home, ".config"),
    };
    expect((await m.runWith({ env }, "self-install")).code).toBe(0);
    const launcher = join(home, ".local", "state", "fleetrc", "bin", "fleetrc");
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(launcher, ["--version"], { env: { ...m.env, ...env } })
      .toString()
      .trim();
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });

  // L10: the README's first command, `npx fleetrc init onmax/skills`, looks for a file named
  // `onmax/skills` in the current folder: "<cwd>/onmax/skills: no such manifest".
  it("L10. init <owner>/<repo> reads the manifest from that GitHub repository", async () => {
    const m = machine();
    const init = await m.run("init", "some-owner/some-skills", "--offline", "--no-hooks");
    const out = `${init.stdout}${init.stderr}`;
    expect(out).not.toContain(m.at("some-owner/some-skills"));
    expect(out).toContain("github.com/some-owner/some-skills");
  });

  // L12: after `npx fleetrc init`, the README's next command is `fleetrc status`, but
  // nothing puts `fleetrc` on PATH; the copy sits in ~/.local/state/fleetrc/bin.
  // Without the timer: the command has to work without it too, and a test that installs the timer
  // installs it in the real user's systemd, whatever HOME the test sets.
  it.skipIf(isWindows)("L12. init leaves a `fleetrc` command the user can run", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const init = await m.run("init", manifest, "--no-hooks");
    const onPath = existsSync(m.at(".local/bin/fleetrc"));
    expect(onPath || /PATH/.test(init.stdout), init.stdout).toBe(true);
  });

  // L14: a reachable host with node but without fleetrc falls back to `npx -y fleetrc`; the
  // error is the last three lines of npm's log (a 404 today, "no manifest yet" once published).
  it.skipIf(isWindows)("L14. fleet sync says a host has no fleetrc installed", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["localhost"] });
    const { env } = recordingSsh(m);
    // The "host": an empty state folder and a PATH with no npx, so the npx fallback fails.
    const host = join(m.root, "host-state");
    const sync = await m.runWith(
      { env: { ...env, XDG_STATE_HOME: host, PATH: "/usr/bin:/bin" } },
      "fleet",
      "sync",
      "--manifest",
      manifest,
      "--json",
    );
    const [result] = JSON.parse(sync.stdout) as { reachable: boolean; error?: string }[];
    expect(result!.error).toMatch(/fleetrc is not installed|not installed on/);
  });

  // L9: without git, a git source fails with "spawn git ENOENT" (printed twice, once with a
  // temporary path) instead of saying git is missing.
  it.skipIf(isWindows)(
    "L9. a git source on a machine without git says git is missing",
    async () => {
      const m = machine();
      const bin = join(m.root, "nogit");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: "https://example.invalid/vendor.git" }],
      });
      const init = await m.runWith({ env: { PATH: bin } }, "init", manifest, "--no-hooks");
      const out = `${init.stdout}${init.stderr}`;
      expect(out).not.toContain("ENOENT");
      expect(out).toMatch(/git.*(not installed|not found|install git|on PATH)/i);
    },
  );
});
