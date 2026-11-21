// The move from skillfleet, fleetrc's old name (src/migrate.ts), and the old names still read for
// one release (src/legacy.ts). Each test makes a real install with `init` in a temporary HOME and
// turns it into the one the old release left, then runs the new release over it.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { remoteScript } from "../src/fleet.ts";
import {
  cli,
  clone,
  isLink,
  isWindows,
  machine,
  type Machine,
  read,
  remote,
  type Report,
  skillMd,
  skills,
  systemdShim,
  writeFiles,
} from "./fixture.ts";

const oldState = (m: Machine) => m.at(".local", "state", "skillfleet");
const oldConfig = (m: Machine) => m.at(".config", "skillfleet");
const newConfig = (m: Machine) => m.at(".config", "fleetrc");
const units = (m: Machine) => m.at(".config", "systemd", "user");
const HOOK_FILES = [".claude/settings.json", ".codex/hooks.json"];
const RECORD_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"];

/**
 * Turns `m`'s fleetrc install into the one skillfleet left: the state and config folders, the
 * launcher, the agents' link records and their links, the session hooks and the timer under the
 * old name, every path in them pointing at the old folders.
 */
function toLegacy(m: Machine, { records = RECORD_DIRS, hooks = HOOK_FILES } = {}) {
  const text = (s: string) =>
    s
      .replaceAll("/state/fleetrc/bin/fleetrc", "/state/skillfleet/bin/skillfleet")
      .replaceAll(m.stateDir, oldState(m))
      .replaceAll(newConfig(m), oldConfig(m))
      .replaceAll("fleetrc-sync", "skillfleet-sync");
  const rewrite = (file: string, to = file) => {
    const content = text(read(file));
    if (to !== file) rmSync(file);
    writeFileSync(to, content);
  };
  renameSync(m.stateDir, oldState(m));
  if (existsSync(newConfig(m))) renameSync(newConfig(m), oldConfig(m));
  for (const name of readdirSync(oldState(m)))
    if (name.endsWith(".json")) rewrite(join(oldState(m), name));
  if (existsSync(join(oldConfig(m), "config.json"))) rewrite(join(oldConfig(m), "config.json"));
  const bin = join(oldState(m), "bin");
  rewrite(join(bin, "fleetrc"), join(bin, "skillfleet"));
  chmodSync(join(bin, "skillfleet"), 0o755);
  for (const dir of records) {
    const record = m.at(dir, ".fleetrc-manifest.json");
    if (!existsSync(record)) continue;
    rewrite(record, m.at(dir, ".skillfleet-manifest.json"));
    for (const name of readdirSync(m.at(dir))) {
      const path = m.at(dir, name);
      if (!isLink(path)) continue;
      const target = readlinkSync(path);
      if (!target.startsWith(m.stateDir)) continue;
      unlinkSync(path);
      symlinkSync(text(target), path);
    }
  }
  for (const file of hooks) if (existsSync(m.at(file))) rewrite(m.at(file));
  if (existsSync(units(m)))
    for (const name of readdirSync(units(m)))
      if (name.startsWith("fleetrc-sync"))
        rewrite(join(units(m), name), join(units(m), name.replace("fleetrc", "skillfleet")));
  const log = join(oldState(m), "logs", "fleetrc-sync.log");
  if (existsSync(log)) renameSync(log, join(oldState(m), "logs", "skillfleet-sync.log"));
}

/** Every file under `dir`, with its content or link target, for comparing a folder before and after. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isSymbolicLink()) files[path] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else files[path] = read(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** A machine with skillfleet's install: a vendored source `vendor` with `tool`, linked for Claude Code. */
async function legacyMachine(options: { hooks?: boolean } = {}) {
  const m = machine();
  const vendor = remote(m, "vendor", skills("skills/", "tool"));
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "vendor", git: vendor.url }],
  });
  const init = await m.run("init", manifest, ...(options.hooks ? [] : ["--no-hooks"]));
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return { m, vendor, manifest };
}

describe.skipIf(isWindows)("the move from skillfleet", () => {
  it("keeps the merge bases, so an unedited vendored skill takes the update and nothing reads as edited", async () => {
    const { m, vendor } = await legacyMachine();
    toLegacy(m);
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const run = await m.run("sync", "--json");
    expect(run.code, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.edited).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toContain("v2");
    expect(run.stderr).toContain("skillfleet is now fleetrc");
  });

  it("renames the agents' link records and points their links at the new state folder", async () => {
    const { m } = await legacyMachine();
    toLegacy(m);
    expect(readlinkSync(m.at(".claude/skills/tool")).startsWith(oldState(m))).toBe(true);
    const run = await m.run("self-install");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(m.at(".claude/skills/.skillfleet-manifest.json"))).toBe(false);
    const record = JSON.parse(read(m.at(".claude/skills/.fleetrc-manifest.json"))) as {
      links: Record<string, { target: string }>;
    };
    expect(record.links.tool!.target.startsWith(m.stateDir + "/")).toBe(true);
    expect(readlinkSync(m.at(".claude/skills/tool"))).toBe(record.links.tool!.target);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toContain("tool body");
    expect(existsSync(oldState(m))).toBe(false);
    expect(existsSync(oldConfig(m))).toBe(false);
    expect(existsSync(join(m.stateDir, "bin", "fleetrc"))).toBe(true);
    expect(existsSync(join(m.stateDir, "bin", "skillfleet"))).toBe(false);
    expect(read(join(m.stateDir, "state.json"))).not.toContain(oldState(m));
    // The sync after it finds every link where it belongs.
    const sync = await m.json("sync");
    expect(sync.targets.flatMap((target) => [...target.created, ...target.removed])).toEqual([]);
  });

  it("replaces the session hooks of Claude Code and Codex where they stand, the user's hooks untouched", async () => {
    const m = machine();
    const user = (command: string) => ({ hooks: [{ type: "command", command }] });
    for (const file of HOOK_FILES)
      writeFiles(m.home, {
        [file]: `${JSON.stringify({ hooks: { SessionStart: [user("echo before")] } }, null, 2)}\n`,
      });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest)).code).toBe(0);
    // A hook of the user's after fleetrc's, which moving fleetrc's would shift.
    for (const file of HOOK_FILES) {
      const raw = JSON.parse(read(m.at(file))) as { hooks: { SessionStart: unknown[] } };
      expect(raw.hooks.SessionStart).toHaveLength(2);
      raw.hooks.SessionStart.push(user("echo after"));
      writeFileSync(m.at(file), `${JSON.stringify(raw, null, 2)}\n`);
    }
    const fresh = HOOK_FILES.map((file) => read(m.at(file)));
    toLegacy(m);
    for (const file of HOOK_FILES) expect(read(m.at(file))).toContain("skillfleet/bin/skillfleet");

    const run = await m.run("self-install");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("approve it once in Codex's /hooks");
    // Byte for byte what a fresh install wrote: fleetrc's entry in slot 1, the user's in 0 and 2.
    expect(HOOK_FILES.map((file) => read(m.at(file)))).toEqual(fresh);
  });

  it.skipIf(process.platform !== "linux")(
    "swaps the old timer for the new one, its schedule and log kept",
    async () => {
      const m = machine();
      const PATH = systemdShim(m);
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [],
        timer: { cron: "*/10 * * * *" },
      });
      const init = await m.runWith({ env: { PATH } }, "init", manifest, "--timer", "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      mkdirSync(join(m.stateDir, "logs"), { recursive: true });
      writeFileSync(join(m.stateDir, "logs", "fleetrc-sync.log"), "an old run\n");
      toLegacy(m);
      expect(existsSync(join(units(m), "skillfleet-sync.timer"))).toBe(true);

      const run = await m.runWith({ env: { PATH } }, "self-install");
      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(existsSync(join(units(m), "skillfleet-sync.timer"))).toBe(false);
      expect(existsSync(join(units(m), "skillfleet-sync.service"))).toBe(false);
      const service = read(join(units(m), "fleetrc-sync.service"));
      expect(service).toContain(`${m.stateDir}/app/cli.mjs sync`);
      expect(service).not.toContain("skillfleet");
      expect(read(join(units(m), "fleetrc-sync.timer"))).toContain(
        "OnCalendar=*-*-* *:00,10,20,30,40,50:00",
      );
      expect(read(join(m.stateDir, "logs", "fleetrc-sync.log"))).toBe("an old run\n");
      expect(JSON.parse(read(join(newConfig(m), "config.json")))).toMatchObject({ timer: true });
    },
  );

  it("a dry run writes nothing, says what the move would do, and shows the old install's sync", async () => {
    const { m } = await legacyMachine({ hooks: true });
    toLegacy(m);
    const before = { ...snapshot(m.home) };
    const run = await m.run("sync", "--dry-run");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain(`would move ${"~/.local/state/skillfleet"}`);
    expect(run.stdout).toContain("would replace the Claude Code session hook");
    expect(run.stdout).toContain("would rename");
    const after = snapshot(m.home);
    // A dry run's fetch may fill the git cache; nothing else changes.
    const outsideCache = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).filter(([path]) => !path.includes("/cache/")));
    expect(outsideCache(after)).toEqual(outsideCache(before));
    expect(existsSync(m.stateDir)).toBe(false);
  });

  it("a second run moves nothing", async () => {
    const { m } = await legacyMachine({ hooks: true });
    toLegacy(m);
    const first = await m.run("sync");
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("skillfleet is now fleetrc");
    const hooks = HOOK_FILES.map((file) => read(m.at(file)));
    const state = read(join(m.stateDir, "state.json"));
    const second = await m.run("sync");
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout + second.stderr).not.toContain("skillfleet");
    expect(HOOK_FILES.map((file) => read(m.at(file)))).toEqual(hooks);
    expect(JSON.parse(read(join(m.stateDir, "state.json"))).sources.vendor.skills).toEqual(
      JSON.parse(state).sources.vendor.skills,
    );
  });

  it("the old tailnet capability still names the manifest, with one warning", async () => {
    const m = machine();
    const vendor = remote(m, "home-skills", skills("skills/", "from-tailnet"));
    const team = remote(m, "home", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "home", git: vendor.https }],
      }),
    });
    const dir = join(m.root, "tailscale");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        BackendState: "Running",
        Self: { CapMap: { "github.com/onmax/skillfleet": [{ manifest: team.https }] } },
      }),
    );
    writeFileSync(
      join(dir, "tailscale.mjs"),
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(dir, "status.json"))}, "utf8"));`.replace(
        'require("node:fs")',
        '(await import("node:fs"))',
      ),
    );
    const run = await m.runWith(
      { env: { FLEETRC_TAILSCALE: join(dir, "tailscale.mjs") } },
      "init",
      "--no-hooks",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(readdirSync(m.at(".claude/skills")).filter((name) => !name.startsWith("."))).toEqual([
      "from-tailnet",
    ]);
    const warnings = run.stderr.split("\n").filter((line) => line.includes("warning:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rename that capability to "github.com/onmax/fleetrc"');
  });

  it("reads a folder's old .skillfleet/manifest.json, and gives manifest hooks the old variables too, each with a warning", async () => {
    const m = machine();
    const folder = join(m.root, "dotfiles");
    const out = join(m.root, "hook.out");
    const script = join(m.root, "hook.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, [process.env.FLEETRC_HOOK, process.env.SKILLFLEET_HOOK, process.env.SKILLFLEET_CHANGED].join("|"));`,
    );
    writeFiles(folder, {
      ...skills("skills/", "mine"),
      ".skillfleet/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "own", local: join(folder, "skills") }],
        hooks: [
          {
            name: "note",
            on: ["own:**"],
            run: `"${process.execPath}" "${script}" # SKILLFLEET_HOOK`,
          },
        ],
      }),
    });
    const run = await m.run("init", folder, "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toMatch(
      /warning: .*\.skillfleet\/manifest\.json is the manifest's old place/,
    );
    expect(run.stderr).toMatch(/warning: hook note reads SKILLFLEET_HOOK/);
    expect(read(out)).toBe("note|note|own:mine/SKILL.md");
  });

  it("fleet upgrade moves a host that has the old install, through self-install", async () => {
    const m = machine();
    // The host's node, in a folder of its own, where the fake npx goes: fleet's script runs the npx
    // beside the launcher's node, and the fake runs this build's fleetrc with the words after `--`.
    const nodeDir = join(m.root, "node", "bin");
    mkdirSync(nodeDir, { recursive: true });
    symlinkSync(realpathSync(process.execPath), join(nodeDir, "node"));
    writeFileSync(
      join(nodeDir, "npx"),
      `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec "${join(nodeDir, "node")}" "${cli}" "$@"\n`,
    );
    chmodSync(join(nodeDir, "npx"), 0o755);
    const env = { ...m.env, PATH: [nodeDir, m.env.PATH].join(":") };
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const init = await m.runWith({ env }, "init", manifest);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    toLegacy(m);

    const run = spawnSync("/bin/sh", ["-c", remoteScript("upgrade", "9.9.9")], {
      env: { ...env, FLEETRC_PACKAGE: "fleetrc@preview" },
      input: "",
      encoding: "utf8",
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toContain("fleetrc-fleet: was 0.0.0");
    expect(run.stderr).toContain("fleetrc-fleet: now 0.0.0");
    // self-install says what it moved first; fleet reads the report from its first brace.
    expect(run.stdout).toContain("skillfleet is now fleetrc");
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
      ok: boolean;
      fleetrc: string;
    };
    expect(report).toMatchObject({ ok: true, fleetrc: "0.0.0" });
    expect(existsSync(oldState(m))).toBe(false);
    expect(existsSync(join(m.stateDir, "bin", "fleetrc"))).toBe(true);
    expect(read(m.at(".claude/settings.json"))).not.toContain("skillfleet");
  });

  it("keeps an edited legacy file that differs from the one the new folder already holds, and says where", async () => {
    const { m } = await legacyMachine();
    toLegacy(m);
    const link = readlinkSync(m.at(".claude/skills/tool"));
    const skill = join(relative(oldState(m), link), "SKILL.md");
    // The user's edit, made through the agent's folder, in the old store.
    writeFileSync(join(oldState(m), skill), skillMd("tool", "my edit"));
    // A fleetrc run that stopped partway left its own copy, and no state.json.
    writeFiles(m.stateDir, { [skill]: skillMd("tool", "another copy") });

    const run = await m.run("self-install");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(read(join(oldState(m), skill))).toContain("my edit");
    expect(read(join(m.stateDir, skill))).toContain("another copy");
    expect(run.stdout).toContain("kept ~/.local/state/skillfleet");
    expect(run.stdout).toContain(skill);
    // What moved is gone from the old folder; the next run moves nothing.
    expect(existsSync(join(oldState(m), "state.json"))).toBe(false);
    const again = await m.run("self-install");
    expect(again.stdout + again.stderr).not.toContain("skillfleet");
  });

  it.skipIf(process.getuid?.() === 0)(
    "a move that fails partway is finished by the next run",
    async () => {
      const { m } = await legacyMachine();
      toLegacy(m);
      // Relinking fails: the agent's folder can't be written.
      chmodSync(m.at(".claude/skills"), 0o555);
      let first;
      try {
        first = await m.run("self-install");
      } finally {
        chmodSync(m.at(".claude/skills"), 0o755);
      }
      expect(first.code, first.stdout + first.stderr).not.toBe(0);
      expect(existsSync(oldState(m))).toBe(false);

      const second = await m.run("self-install");
      expect(second.code, second.stdout + second.stderr).toBe(0);
      expect(second.stdout).toContain("skillfleet is now fleetrc");
      expect(readlinkSync(m.at(".claude/skills/tool")).startsWith(m.stateDir + "/")).toBe(true);
      expect(read(m.at(".claude/skills/tool/SKILL.md"))).toContain("tool body");
      expect(existsSync(m.at(".claude/skills/.skillfleet-manifest.json"))).toBe(false);
      expect(existsSync(join(m.stateDir, "bin", "fleetrc"))).toBe(true);
      const third = await m.run("self-install");
      expect(third.stdout + third.stderr).not.toContain("skillfleet");
    },
  );

  it("finds the agents' folders the install saved, from a shell that doesn't name them", async () => {
    const m = machine();
    const alt = m.at("alt-claude");
    mkdirSync(alt);
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.runWith({ env: { CLAUDE_CONFIG_DIR: alt } }, "init", manifest);
    expect(init.code, init.stdout + init.stderr).toBe(0);
    toLegacy(m, { records: ["alt-claude/skills"], hooks: ["alt-claude/settings.json"] });
    expect(read(join(alt, "settings.json"))).toContain("skillfleet/bin/skillfleet");

    // A bare ssh shell, as `fleet upgrade` runs self-install in.
    const run = await m.runWith({ env: { CLAUDE_CONFIG_DIR: undefined } }, "self-install");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(read(join(alt, "settings.json"))).not.toContain("skillfleet");
    expect(readlinkSync(join(alt, "skills", "tool")).startsWith(m.stateDir + "/")).toBe(true);
    expect(existsSync(join(alt, "skills", ".skillfleet-manifest.json"))).toBe(false);
  });

  it("fleet upgrade from a controller with the old install moves it, then the host", async () => {
    // The host: its own HOME, reached through a fake ssh that runs the command in its environment.
    const host = machine();
    const nodeDir = join(host.root, "node", "bin");
    mkdirSync(nodeDir, { recursive: true });
    symlinkSync(realpathSync(process.execPath), join(nodeDir, "node"));
    writeFileSync(
      join(nodeDir, "npx"),
      `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec "${join(nodeDir, "node")}" "${cli}" "$@"\n`,
    );
    chmodSync(join(nodeDir, "npx"), 0o755);
    const hostEnv = {
      ...host.env,
      PATH: [nodeDir, host.env.PATH].join(":"),
      FLEETRC_PACKAGE: "fleetrc@preview",
    };
    const hostInit = await host.runWith(
      { env: hostEnv },
      "init",
      host.manifest({ agents: ["claude-code"], sources: [] }),
    );
    expect(hostInit.code, hostInit.stdout + hostInit.stderr).toBe(0);
    toLegacy(host);

    const m = machine();
    const init = await m.run(
      "init",
      m.manifest({ agents: ["claude-code"], sources: [], fleet: ["localhost"] }),
      "--no-hooks",
    );
    expect(init.code, init.stdout + init.stderr).toBe(0);
    toLegacy(m);
    const bin = join(m.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "host-env.json"), JSON.stringify(hostEnv));
    writeFileSync(
      join(bin, "ssh.mjs"),
      `import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const probe = args[0] === "-G" && args.shift();
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const [host, command] = args;
if (probe) {
  console.log("hostname " + host + "\\nuser alice\\nport 22");
  process.exit(0);
}
const env = JSON.parse(readFileSync(${JSON.stringify(join(bin, "host-env.json"))}, "utf8"));
process.exit(spawnSync("sh", ["-c", command], { stdio: "inherit", env }).status ?? 1);`,
    );
    writeFileSync(
      join(bin, "ssh"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "ssh.mjs")}" "$@"\n`,
    );
    chmodSync(join(bin, "ssh"), 0o755);

    const run = await m.runWith(
      { env: { PATH: [bin, m.env.PATH].join(":"), FLEETRC_PACKAGE: "fleetrc@preview" } },
      "fleet",
      "upgrade",
      "--json",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toContain("skillfleet is now fleetrc");
    expect(JSON.parse(run.stdout)).toMatchObject([{ host: "localhost", reachable: true }]);
    for (const machine of [m, host]) {
      expect(existsSync(oldState(machine))).toBe(false);
      expect(existsSync(join(machine.stateDir, "bin", "fleetrc"))).toBe(true);
    }
    expect(read(host.at(".claude/settings.json"))).not.toContain("skillfleet");
  });

  it("fleet add edits the old .skillfleet/manifest.json in the manifest's working clone", async () => {
    const m = machine();
    const manifests = remote(m, "manifests", { ".skillfleet/manifest.json": "{}" });
    const work = clone(m, manifests, "code/manifests");
    manifests.commit({
      ".skillfleet/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "manifests", git: manifests.url, path: work, skills: "none/*" }],
      }),
    });
    m.git(work, "pull", "--quiet");
    const init = await m.run("init", manifests.url, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);

    const added = await m.run("fleet", "add", "laptop");
    expect(added.code, added.stdout + added.stderr).toBe(0);
    expect(added.stdout).toContain(join("code", "manifests", ".skillfleet", "manifest.json"));
    expect(
      (JSON.parse(read(join(work, ".skillfleet", "manifest.json"))) as { fleet: string[] }).fleet,
    ).toEqual(["laptop"]);
    expect(existsSync(join(work, ".fleetrc"))).toBe(false);
  });
});
