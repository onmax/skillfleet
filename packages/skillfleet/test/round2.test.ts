// Round two of trying to break skillfleet, against the integration branch that fixed round one.
// Each test asserts what skillfleet should do; a failing test is a break still open. Every run uses
// the fixture's temporary HOME, and every scheduler call goes to the fixture's fake.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { osScheduleErrors } from "@vite-hub/schedule/os";
import { describe, expect, it } from "vite-plus/test";
import { remoteManifest } from "../src/manifest.ts";
import { pathAdvice } from "../src/selfinstall.ts";
import { TimerError } from "../src/timer.ts";
import {
  cli,
  isWindows,
  machine,
  type Machine,
  names,
  pathWith,
  read,
  remote,
  skillMd,
  skills,
} from "./fixture.ts";

/** A vendored source `vendor` with the skills `tool` and `other`, synced into Claude Code's folder. */
async function vendored(m: Machine, ...extra: string[]) {
  const vendor = remote(m, "vendor", skills("skills/", "tool", ...extra));
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
  });
  const init = await m.run("init", manifest, "--no-timer");
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return { vendor, manifest, live: join(m.stateDir, "store", "vendor", "live") };
}

/**
 * A fake `ssh` that skips its options and runs the remote command with `sh -c` here, for every
 * host. As in test/fleet.test.ts.
 */
function sshShim(m: Machine): NodeJS.ProcessEnv {
  const dir = join(m.root, "bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const run = spawnSync("sh", ["-c", args[1]], { stdio: "inherit" });
process.exit(run.status ?? 1);`,
  );
  if (isWindows) return { SKILLFLEET_SSH: script };
  const ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(ssh, 0o755);
  return { PATH: pathWith(dir, m.env) };
}

describe("an agent folder that links to another agent's folder", () => {
  it.skipIf(isWindows)(
    "R2-1. init keeps ~/.codex/skills -> ~/.agents/skills without claiming a hand-made skill there is lost",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      mkdirSync(m.at(".agents/skills/handmade"), { recursive: true });
      writeFileSync(m.at(".agents/skills/handmade/SKILL.md"), skillMd("handmade"));
      rmSync(m.at(".codex/skills"), { recursive: true, force: true });
      // Codex reads both folders, so one link makes them the same folder.
      symlinkSync(m.at(".agents/skills"), m.at(".codex/skills"));
      const manifest = m.manifest({ agents: "all", sources: [{ id: "vendor", git: vendor.url }] });
      const init = await m.run("init", manifest, "--no-timer");
      // handmade stays in ~/.agents/skills, which Codex reads; nothing is lost.
      expect(init.stdout).not.toContain("LOST");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(names(m.at(".agents/skills"))).toEqual(["handmade", "tool"]);
    },
  );
});

describe("fleet", () => {
  it.skipIf(isWindows)(
    "R2-2. fleet sync shows a host whose sync had a source error as reachable, with its report",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const gone = remote(m, "gone", skills("skills/", "g"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "vendor", git: vendor.url },
          { id: "gone", git: gone.url },
        ],
        fleet: ["localhost"],
      });
      expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
      expect((await m.run("self-install")).code).toBe(0);
      // One source on the host stops answering: its sync exits 1 with a full report.
      rmSync(gone.url, { recursive: true, force: true });
      const run = await m.runWith({ env: sshShim(m) }, "fleet", "sync", "--json");
      const [host] = JSON.parse(run.stdout) as {
        reachable: boolean;
        error?: string;
        lastRun?: { ok: boolean; skills: number; errors: string[] };
      }[];
      expect(host!.reachable).toBe(true);
      expect(host!.lastRun?.ok).toBe(false);
      expect(host!.lastRun?.skills).toBe(2);
      expect(host!.lastRun?.errors.join("\n")).toMatch(/^gone: /);
    },
  );
});

describe("a sync killed or left without its records", () => {
  it("R2-3. a sync killed while it copies an update leaves no half-copied skill that later counts as a local edit", async () => {
    const m = machine();
    const { vendor, live } = await vendored(m);
    const files: Record<string, string> = { "skills/tool/SKILL.md": skillMd("tool", "v2") };
    for (let k = 0; k < 8000; k++) files[`skills/tool/refs/f${k}.md`] = `f${k}`;
    vendor.commit(files);
    const refs = join(live, "tool", "refs");
    const child = spawn(process.execPath, [cli, "sync"], {
      cwd: m.home,
      env: m.env,
      stdio: "ignore",
    });
    const exited = new Promise((done) => child.on("exit", done));
    let copied = -1;
    for (let i = 0; i < 30_000; i++) {
      copied = existsSync(refs) ? readdirSync(refs).length : -1;
      // Power lost, or the timer's unit stopped at logout, halfway through the copy.
      if (copied > 0 && copied < 8000) {
        child.kill("SIGKILL");
        break;
      }
      await new Promise((done) => setTimeout(done, 2));
    }
    await exited;
    expect(copied).toBeGreaterThan(0);
    expect(copied).toBeLessThan(8000);

    const report = await m.json("sync");
    expect(report.edited).toEqual([]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
    expect(readdirSync(m.at(".claude/skills/tool/refs"))).toHaveLength(8000);
  }, 120_000);

  it("R2-4. after state.json is lost, a vendored skill nobody edited still takes upstream's update", async () => {
    const m = machine();
    const { vendor } = await vendored(m);
    writeFileSync(join(m.stateDir, "state.json"), "{");
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    // store/base still holds what was installed, so the copy is provably unedited.
    expect(report.edited).toEqual([]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
  });

  it("R2-5. after state.json is lost, an edited skill that upstream deleted stays linked", async () => {
    const m = machine();
    const { vendor, live } = await vendored(m, "other");
    writeFileSync(join(live, "tool", "SKILL.md"), skillMd("tool", "my edit"));
    writeFileSync(join(m.stateDir, "state.json"), "{");
    vendor.commit({ "skills/tool": null });
    const report = await m.json("sync");
    // With state.json intact, E3 keeps it linked with a warning; losing the file must not unlink it.
    expect(names(m.at(".claude/skills"))).toEqual(["other", "tool"]);
    expect(report.warnings.join("\n")).toMatch(/tool/);
  });

  it("R2-6. a state.json written by another version is backed up before it is replaced", async () => {
    const m = machine();
    await vendored(m);
    const state = JSON.parse(read(join(m.stateDir, "state.json"))) as Record<string, unknown>;
    writeFileSync(join(m.stateDir, "state.json"), JSON.stringify({ ...state, version: 2 }));
    const report = await m.json("sync");
    expect(report.warnings.join("\n")).toContain("state.json");
    expect(existsSync(join(m.stateDir, "backup"))).toBe(true);
  });

  it("R2-7. the git cache survives a kill between removing the old tree and renaming the new one", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = remote(m, "team", {
      "skills.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    expect((await m.run("init", team.url, "--no-timer")).code).toBe(0);
    const cache = join(m.stateDir, "cache", "manifests");
    const key = readdirSync(cache)
      .find((name) => name.endsWith(".json"))!
      .replace(/\.json$/, "");
    // What writeTree leaves when killed after rmSync(tree) and before renameSync(temp, tree).
    renameSync(join(cache, key), join(cache, `${key}.4242.tmp`));
    const offline = await m.run("sync", "--offline");
    expect(offline.code, offline.stderr).toBe(0);
    const online = await m.run("sync");
    expect(online.code, online.stderr).toBe(0);
    expect(readdirSync(cache).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("moving a source", () => {
  it("R2-8. a source moved from vendored to a working clone does not silently drop its edited skill", async () => {
    const m = machine();
    const { vendor, live } = await vendored(m, "other");
    writeFileSync(join(live, "tool", "SKILL.md"), skillMd("tool", "my edit"));
    m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, skills: "skills/*", path: "~/src/vendor" }],
    });
    const report = await m.json("sync");
    // The clone now provides tool; the edited copy must be backed up and said so, not orphaned.
    expect(report.warnings.join("\n")).toMatch(/tool.*(edit|backup)|(edit|backup).*tool/);
    expect(existsSync(join(live, "tool"))).toBe(false);
  });
});

describe("sync <source>", () => {
  it("R2-9. sync of one source keeps another source's fetch error in the last run", async () => {
    const m = machine();
    const a = remote(m, "a", skills("skills/", "a1"));
    const b = remote(m, "b", skills("skills/", "b1"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "a", git: a.url },
        { id: "b", git: b.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    rmSync(b.url, { recursive: true, force: true });
    expect((await m.json("sync")).errors.join("\n")).toMatch(/^b: /);
    // `sync a` does not fetch b, so it cannot know b recovered; status must still show b failing.
    const only = await m.json("sync", "a");
    expect(only.errors.join("\n")).toMatch(/^b: /);
    expect(only.ok).toBe(false);
  });
});

describe("the timer", () => {
  it("R2-10. a timer run that finds a manual sync running exits 0, so the unit is not marked failed", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const log = join(m.root, "hook.log");
    const script = join(m.root, "slow-hook.mjs");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "ran\\n");\nsetTimeout(() => {}, 8000);\n`,
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      hooks: [{ name: "slow", run: `"${process.execPath}" "${script}"`, on: ["vendor:**"] }],
    });
    mkdirSync(m.at(".config/skillfleet"), { recursive: true });
    writeFileSync(m.at(".config/skillfleet/config.json"), JSON.stringify({ manifest }));
    const manual = spawn(process.execPath, [cli, "sync"], {
      cwd: m.home,
      env: m.env,
      stdio: "ignore",
    });
    const exited = new Promise((done) => manual.on("exit", done));
    for (let i = 0; i < 300 && !existsSync(log); i++)
      await new Promise((done) => setTimeout(done, 100));
    expect(existsSync(log)).toBe(true);
    try {
      const timer = await m.runWith({ env: { SKILLFLEET_TIMER: "1" } }, "sync");
      // systemd and launchd record a non-zero exit, and doctor then reports the timer as failing.
      expect(timer.code, timer.stdout + timer.stderr).toBe(0);
    } finally {
      await exited;
    }
  }, 60_000);

  it.skipIf(process.platform !== "linux")(
    "R2-11. a Linux machine without systemd (a container, WSL) is told so, with what to do, not spawn ENOENT",
    () => {
      const error = new TimerError(
        osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED({
          command: "systemctl --user show skillfleet-sync.service skillfleet-sync.timer",
          exitCode: 127,
          output: "spawn systemctl ENOENT",
        }),
      );
      expect(error.message).not.toContain("ENOENT");
      expect(error.message).toMatch(/systemd/);
      expect(error.message).toContain("--no-timer");
    },
  );
});

describe("sources a repository holds in unusual ways", () => {
  it.skipIf(isWindows)(
    "R2-12. a skill folder that is a symlink or a git submodule is linked or named in a warning, not dropped silently",
    async () => {
      const m = machine();
      const sub = remote(m, "sub", { "SKILL.md": skillMd("subskill") });
      const vendor = remote(m, "vendor", {
        ...skills("skills/", "tool"),
        "shared/linked/SKILL.md": skillMd("linked"),
      });
      m.git(
        vendor.work,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        sub.url,
        "skills/subskill",
      );
      symlinkSync("../shared/linked", join(vendor.work, "skills", "linked"));
      m.git(vendor.work, "add", "-A");
      m.git(vendor.work, "commit", "--quiet", "-m", "a submodule and a linked skill");
      m.git(vendor.work, "push", "--quiet", "origin", "main");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
      const report = await m.json("sync");
      const said = `${names(m.at(".claude/skills")).join(" ")}\n${report.warnings.join("\n")}`;
      expect(said).toContain("linked");
      expect(said).toContain("subskill");
    },
  );
});

describe("what users paste", () => {
  it("R2-13. add of a GitHub folder link does not write the page URL as a git URL", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-timer")).code).toBe(0);
    const add = await m.json<{ added: { git?: string } }>(
      "add",
      "https://github.com/vercel-labs/agent-skills/tree/main/skills",
      "--dry-run",
    );
    // git cannot clone .../tree/main/skills: the next sync would fail with "cannot read the repository".
    expect(add.added.git).not.toContain("/tree/");
  });

  it("R2-14. a GitHub file link copied with a line anchor or ?plain=1 still names the manifest", () => {
    const expected = { repo: "https://github.com/org/team", path: "skills.json", ref: "main" };
    expect(
      remoteManifest("https://github.com/org/team/blob/main/skills.json#L3", "/nonexistent"),
    ).toEqual(expected);
    expect(
      remoteManifest("https://github.com/org/team/blob/main/skills.json?plain=1", "/nonexistent"),
    ).toEqual(expected);
  });

  it("R2-15. a usage error under --json still prints one JSON document", async () => {
    const m = machine();
    for (const args of [["sync", "a", "b"], ["frob"]]) {
      const run = await m.run(...args, "--json");
      expect(run.code).toBe(2);
      expect(() => JSON.parse(run.stdout), `${args.join(" ")}: ${run.stdout}`).not.toThrow();
    }
  });

  it("R2-16. agents --manifest with a path that does not exist says so", async () => {
    const m = machine();
    const run = await m.run("agents", "--manifest", m.at("nope/skills.json"));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("nope/skills.json");
  });

  it("R2-17. PATH advice for csh and nushell users is in their shell's syntax and file", () => {
    for (const shell of ["/bin/tcsh", "/usr/bin/nu"]) {
      const advice = pathAdvice("/home/u/.local/state/skillfleet/bin", shell, "linux");
      expect(advice, shell).not.toContain("~/.profile");
      expect(advice, shell).not.toContain("export PATH=");
    }
  });
});
