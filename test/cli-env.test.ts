// Regression tests for the CLI, init and environment breaks in test/linux-envs.test.ts (L-rows)
// that had no case there, and for the behavior their fixes added.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  cli,
  clone,
  http,
  isWindows,
  machine,
  names,
  pathWith,
  remote,
  skills,
} from "./fixture.ts";

const engines = (
  JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } }
).engines.node;

describe("cli and environments", () => {
  it("L10. init <repository URL> reads .fleetrc/manifest.json from that repository and keeps <repo>//.fleetrc/manifest.json", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "from-repo"));
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    const url = pathToFileURL(manifests.url).href;
    const init = await m.run("init", url, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["from-repo"]);
    const config = JSON.parse(readFileSync(m.at(".config/fleetrc/config.json"), "utf8")) as {
      manifest: string;
    };
    expect(config.manifest).toBe(`${url}//.fleetrc/manifest.json`);
  });

  it("L10. a repository with only a skills.json at its root says where it looked and to name the file", async () => {
    const m = machine();
    const manifests = remote(m, "manifests", { "skills.json": "{}" });
    const init = await m.run("init", pathToFileURL(manifests.url).href, "--no-hooks");
    expect(init.code).toBe(1);
    expect(init.stderr).toMatch(
      /has no \.fleetrc\/manifest\.json; name the manifest file as .*\/\/<file>/,
    );
  });

  it("L10. <repo>//<file> reads any other file in the repository", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "from-file"));
    const manifests = remote(m, "manifests", {
      "team/fleet.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    const init = await m.run("init", `${manifests.url}//team/fleet.json`, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["from-file"]);
  });

  it("L10. a local folder means its .fleetrc/manifest.json, whose relative paths start in .fleetrc/", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    mkdirSync(join(folder, "skills/tool"), { recursive: true });
    writeFileSync(join(folder, "skills/tool/SKILL.md"), "---\nname: tool\ndescription: d\n---\n");
    mkdirSync(join(folder, ".fleetrc"));
    writeFileSync(
      join(folder, ".fleetrc/manifest.json"),
      JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "mine", local: "../skills" }],
      }),
    );
    const init = await m.run("init", folder, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
  });

  it("L10. a local folder with only a skills.json says where it looked", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "skills.json"), JSON.stringify({ sources: [] }));
    const init = await m.run("init", folder, "--no-hooks");
    expect(init.code).toBe(1);
    expect(init.stderr).toContain(`has no .fleetrc/manifest.json; name the manifest file`);
  });

  it("L1. add on a remote manifest refuses and prints the source to add upstream", async () => {
    const m = machine();
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    expect((await m.run("init", manifests.url, "--no-hooks")).code).toBe(0);
    const extra = remote(m, "extra", skills("skills/", "extra-a"));
    const added = await m.run("add", extra.url, "--id", "extra");
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(`{"id":"extra","git":${JSON.stringify(extra.url)}}`);
    expect(added.stderr.trim().split("\n")).toHaveLength(1);
    const fleet = await m.run("fleet", "add", "laptop");
    expect(fleet.code).toBe(1);
    expect(fleet.stderr).toContain('Add ["laptop"] to "fleet"');
  });

  it("L1. add on a remote manifest with a working clone edits the clone and asks for a push", async () => {
    const m = machine();
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": "{}",
      "skills/mine/SKILL.md": "---\nname: mine\ndescription: d\n---\n",
    });
    const work = clone(m, manifests, "code/manifests");
    const content = {
      agents: ["claude-code"],
      sources: [{ id: "mine", git: manifests.url, path: work, skills: "skills/*" }],
    };
    manifests.commit({ ".fleetrc/manifest.json": JSON.stringify(content) });
    m.git(work, "pull", "--quiet");
    expect((await m.run("init", manifests.url, "--no-hooks")).code).toBe(0);
    const extra = remote(m, "extra", skills("skills/", "extra-a"));
    const added = await m.run("add", extra.url, "--id", "extra");
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("commit and push it");
    const edited = JSON.parse(readFileSync(join(work, ".fleetrc/manifest.json"), "utf8")) as {
      sources: { id: string }[];
    };
    expect(edited.sources.map((source) => source.id)).toEqual(["mine", "extra"]);
  });

  it("L13. an older Node gets one line naming the version fleetrc needs", async () => {
    const m = machine();
    expect(engines).toBe(">=22.12.0");
    const { spawnSync } = await import("node:child_process");
    const fake = `data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"22.11.0"}})`;
    const run = spawnSync(process.execPath, ["--import", fake, cli, "--version"], {
      env: m.env,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toMatch(/needs Node\.js 22\.12 or newer, and this is Node\.js 22\.11\.0/);
  });

  it("L15. fleet upgrade refuses a version hosts cannot install from npm", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["localhost"] });
    // A registry without fleetrc, so the check never depends on what npm has.
    const registry = await http();
    const called = join(m.root, "ssh-called");
    const ssh = join(m.root, "ssh.mjs");
    writeFileSync(
      ssh,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(called)}, "");\n`,
    );
    const upgrade = await m.runWith(
      { env: { npm_config_registry: registry.url, FLEETRC_SSH: ssh } },
      "fleet",
      "upgrade",
      "--manifest",
      manifest,
    );
    expect(upgrade.code).toBe(1);
    expect(upgrade.stderr).toMatch(/npx fleetrc@latest fleet upgrade/);
    expect(existsSync(called)).toBe(false);
  });

  // ps lists every user's processes; only this user's agents read this user's skills.
  it.skipIf(isWindows)("L11. status lists only this user's agent sessions", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", skills("skills/", "first"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const uid = process.getuid!();
    const bin = join(m.root, "fakeps");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ps"),
      [
        "#!/bin/sh",
        `echo "  4242 ${uid + 1} Mon Nov 16 10:00:00 2020 /usr/bin/codex"`,
        `echo "  4343 ${uid} Mon Nov 16 10:00:00 2020 /usr/bin/codex resume"`,
        // Claude Code loads new skills mid-session, so it never needs a restart.
        `echo "  4444 ${uid} Mon Nov 16 10:00:00 2020 /usr/bin/claude --resume"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "ps"), 0o755);
    const status = await m.runWith({ env: { PATH: pathWith(bin, m.env) } }, "status", "--json");
    const { staleSessions } = JSON.parse(status.stdout) as { staleSessions: { pid: number }[] };
    expect(staleSessions.map((proc) => proc.pid)).toEqual([4343]);
  });
});
