// Breaks found by running real agents (Claude Code, Codex, Gemini CLI, OpenCode, Copilot CLI, Grok,
// Goose, Amp) against the folders fleetrc links. Each case states what a user should get; they
// fail until the matching fix lands.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  type Machine,
  isLink,
  isWindows,
  linkOf,
  machine,
  read,
  remote,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

const names = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : [];

const isFile = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * Skills whose SKILL.md is a link, as people keep one text for two skills: `rel` links to a file in
 * its own folder, `shared` to one elsewhere in the repository, `abs` by absolute path.
 */
function linkedSkillMds(m: Machine, dir: string) {
  writeFiles(dir, {
    "skills/rel/body.md": skillMd("rel"),
    "docs/shared.md": skillMd("shared"),
    "skills/plain/SKILL.md": skillMd("plain"),
  });
  mkdirSync(join(dir, "skills/shared"), { recursive: true });
  mkdirSync(join(dir, "skills/abs"), { recursive: true });
  writeFiles(m.root, { "elsewhere/abs.md": skillMd("abs") });
  symlinkSync("body.md", join(dir, "skills/rel/SKILL.md"), "file");
  symlinkSync(join("..", "..", "docs", "shared.md"), join(dir, "skills/shared/SKILL.md"), "file");
  symlinkSync(join(m.root, "elsewhere/abs.md"), join(dir, "skills/abs/SKILL.md"), "file");
}

describe("agents", () => {
  // Gemini CLI 0.68 reads both ~/.gemini/skills and ~/.agents/skills. When a name is in both, it
  // shows "Skill conflict detected: ... is overriding the same skill" once per skill on every start.
  // `npx skills add -g` installs Gemini's skills only into ~/.agents/skills for this reason.
  it("A1. Gemini CLI sees each skill once when Codex is also linked", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const manifest = m.manifest({
      agents: ["codex", "gemini-cli"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stderr).toBe(0);
    const canonical = names(m.at(".agents/skills"));
    expect(canonical).toEqual(["alpha", "beta"]);
    const both = names(m.at(".gemini/skills")).filter((name) => canonical.includes(name));
    expect(both).toEqual([]);
  });

  // Before 0.0.1, fleetrc linked every skill into Gemini's own folder as well.
  it("A1b. sync removes the links it made in Gemini's own folder once ~/.agents/skills holds them", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const sources = [{ id: "vendor", git: vendor.url }];
    const manifest = m.manifest({ agents: ["gemini-cli"], sources });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".gemini/skills"))).toEqual(["alpha", "beta"]);
    writeFiles(m.at(".gemini/skills"), { "mine/SKILL.md": skillMd("mine") });

    m.manifest({ agents: ["codex", "gemini-cli"], sources });
    const report = await m.json("sync");
    expect(report.ok, report.errors.join("\n")).toBe(true);
    expect(names(m.at(".agents/skills"))).toEqual(["alpha", "beta"]);
    // Gemini's own skill stays; the links and fleetrc's record of them go.
    expect(readdirSync(m.at(".gemini/skills"))).toEqual(["mine"]);
    expect(report.targets.find((t) => t.dir === m.at(".gemini/skills"))?.removed).toEqual([
      "alpha",
      "beta",
    ]);
    expect((await m.run("sync")).stdout).toMatch(/^fleetrc: linked 2 skills into 1 folder$/m);
  });

  // A folder that is another path to ~/.agents/skills is not a former target to empty.
  it("A1c. sync leaves ~/.agents/skills alone when an agent's own folder leads to it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha"));
    rmSync(m.at(".config/opencode"), { recursive: true });
    mkdirSync(m.at(".agents/skills"), { recursive: true });
    symlinkSync(m.at(".agents"), m.at(".config/opencode"), isWindows ? "junction" : "dir");
    const manifest = m.manifest({
      agents: ["codex", "opencode"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".agents/skills/alpha"))).toBe(true);
    expect(linkOf(m.at(".agents/skills/alpha"))).toBe(
      join(m.stateDir, "store", "vendor", "live", "alpha"),
    );
  });

  // Codex and Cursor list no skill whose SKILL.md is a link, and say nothing about it.
  it("A3. a fetched skill whose SKILL.md is a link is stored with the file itself", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "README.md": "vendor\n" });
    linkedSkillMds(m, vendor.work);
    m.git(vendor.work, "add", "-A");
    m.git(vendor.work, "commit", "--quiet", "-m", "links");
    m.git(vendor.work, "push", "--quiet", "origin", "main");
    const manifest = m.manifest({
      agents: ["codex"],
      sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stderr).toBe(0);
    // A link that leaves the source would copy a file of this machine into the store.
    expect(init.stdout).toContain(
      'vendor: skipped the skill "abs": its SKILL.md links to a file outside the source',
    );
    expect(names(m.at(".agents/skills"))).toEqual(["plain", "rel", "shared"]);
    for (const name of ["plain", "rel", "shared"]) {
      const file = m.at(".agents/skills", name, "SKILL.md");
      expect(isFile(file), name).toBe(true);
      expect(read(file)).toBe(skillMd(name));
    }
    const again = await m.json("sync");
    expect(again.skills.updated).toEqual([]);
    expect(again.edited).toEqual([]);
  });

  it("A3b. sync warns that Codex and Cursor won't load a skill linked in place whose SKILL.md is a link", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    linkedSkillMds(m, folder);
    const manifest = m.manifest({
      agents: ["claude-code", "codex", "cursor"],
      sources: [{ id: "mine", local: folder, skills: "skills/*" }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stderr).toBe(0);
    expect(names(m.at(".agents/skills"))).toEqual(["abs", "plain", "rel", "shared"]);
    const report = await m.json("sync");
    const warned = report.warnings.filter((warning) => warning.includes("SKILL.md is a symlink"));
    expect(warned.map((warning) => warning.split(":")[1]!.trim())).toEqual([
      "Codex and Cursor won't load abs",
      "Codex and Cursor won't load rel",
      "Codex and Cursor won't load shared",
    ]);
    // Claude Code follows the link, so a manifest for it alone has nothing to warn about.
    m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: folder, skills: "skills/*" }],
    });
    const claude = await m.json("sync");
    expect(claude.warnings.filter((warning) => warning.includes("SKILL.md"))).toEqual([]);
  });

  it("A3c. sync --copy copies a linked SKILL.md as a file, and the next --copy changes nothing", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    linkedSkillMds(m, folder);
    const manifest = m.manifest({
      agents: ["codex"],
      sources: [{ id: "mine", local: folder, skills: "skills/*" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const copied = await m.json("sync", "--copy");
    expect(copied.warnings.filter((warning) => warning.includes("SKILL.md"))).toEqual([]);
    for (const name of ["abs", "plain", "rel", "shared"]) {
      const file = m.at(".agents/skills", name, "SKILL.md");
      expect(isFile(file), name).toBe(true);
      expect(read(file)).toBe(skillMd(name));
    }
    const again = await m.json<{ targets: { replaced: string[]; warnings: string[] }[] }>(
      "sync",
      "--copy",
    );
    expect(again.targets.flatMap((target) => target.replaced)).toEqual([]);
    expect(again.targets.flatMap((target) => target.warnings)).toEqual([]);
  });

  // `skills` reads these to find an agent's folder. The timer runs without the shell's profile, so
  // without them it links ~/.grok/skills while Grok reads $GROK_HOME/skills.
  it.each([
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "VIBE_HOME",
    "HERMES_HOME",
    "AUTOHAND_HOME",
    "SARVAM_HOME",
    "REASONIX_HOME",
  ])("A2. the timer keeps %s, which places an agent's skills folder", async (key) => {
    const { timerEnv } = await import("../src/selfinstall.ts");
    const saved = process.env[key];
    process.env[key] = "/somewhere/else";
    try {
      expect(timerEnv(undefined, process.execPath)[key]).toBe("/somewhere/else");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
