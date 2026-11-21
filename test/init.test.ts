import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_DIRS,
  clone,
  isLink,
  isWindows,
  linkOf,
  machine,
  type Machine,
  names,
  read,
  remote,
  skillMd,
  skills,
} from "./fixture.ts";

const linkKind = isWindows ? "junction" : "dir";

/** Every path under `dir` with what it is, so a dry run can be shown to change nothing. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path);
      if (rel === ".git" || rel.includes(`${join(".git", "")}`)) continue;
      if (isLink(path)) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (statSync(path).isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else out.push(`${rel} ${read(path).length}`);
    }
  };
  walk(dir);
  return out;
}

/**
 * Today's layout on Maxi's machines: ~/.claude/skills and ~/.agents/skills are links to the whole
 * skills folder of the personal clone, and ~/.codex/skills is a real folder with links into that
 * clone, copies an old installer listed in .nuxt-skills-managed, a stray hand-made skill and .system.
 */
function legacyLayout(m: Machine) {
  const personal = remote(m, "skills-private", {
    ...skills("skills/", "check-your-work", "council", "unslop"),
    "skills-lock.json": JSON.stringify({
      version: 1,
      skills: {
        council: {
          source: "t3dotgg/tstack",
          sourceType: "github",
          skillPath: "skills/council/SKILL.md",
          computedHash: "abc",
        },
      },
    }),
  });
  const work = clone(m, personal, "onmax/skills");
  const nuxt = remote(m, "nuxt-skills", skills("skills/", "nuxt", "vue"));
  symlinkSync(join(work, "skills"), m.at(".claude/skills"), linkKind);
  mkdirSync(m.at(".agents"), { recursive: true });
  symlinkSync(join(work, "skills"), m.at(".agents/skills"), linkKind);
  const codex = m.at(".codex/skills");
  mkdirSync(join(codex, ".system/skill-creator"), { recursive: true });
  writeFileSync(join(codex, ".system/skill-creator/SKILL.md"), skillMd("skill-creator"));
  symlinkSync(join(work, "skills/unslop"), join(codex, "unslop"), linkKind);
  for (const name of ["nuxt", "vue"]) {
    mkdirSync(join(codex, name));
    writeFileSync(join(codex, name, "SKILL.md"), skillMd(name, "old copy"));
  }
  writeFileSync(join(codex, ".nuxt-skills-managed"), "nuxt\nvue\n");
  mkdirSync(join(codex, "conversation-video"));
  writeFileSync(join(codex, "conversation-video/SKILL.md"), skillMd("conversation-video"));
  const manifest = m.manifest({
    agents: "all",
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "nuxt", git: nuxt.url },
    ],
  });
  return { work, manifest, codex };
}

describe("init", () => {
  it("9. migrates the legacy layout: a dry run changes nothing, the real run keeps every name and empties ~/.codex/skills", async () => {
    const m = machine();
    const { work, manifest, codex } = legacyLayout(m);
    const cache = m.at(".cache");
    expect(existsSync(cache)).toBe(false);
    const before = snapshot(m.root);
    const namesBefore = [
      ...new Set([
        ...names(m.at(".claude/skills")),
        ...names(m.at(".agents/skills")),
        ...names(codex),
      ]),
    ].sort();
    expect(namesBefore).toEqual([
      "check-your-work",
      "conversation-video",
      "council",
      "nuxt",
      "unslop",
      "vue",
    ]);

    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `replace the link ${join("~", ".claude", "skills")} -> ${join("~", "onmax", "skills", "skills")} with one link per skill`,
    );
    expect(dry.stdout).toContain(
      `adopt ${join("~", ".codex", "skills", "conversation-video")} into ${join("~", "onmax", "skills", "skills", "conversation-video")}`,
    );
    expect(dry.stdout).toContain(
      `move ${join("~", ".codex", "skills", ".nuxt-skills-managed")} to the backup folder`,
    );
    expect(dry.stdout).toContain(`remove the link ${join("~", ".codex", "skills", "unslop")}`);
    expect(dry.stdout).toContain("record fork council: t3dotgg/tstack skills/council at unknown");
    expect(dry.stdout).toContain("skill names: 6 before, 6 after; none lost");
    expect(existsSync(cache)).toBe(false);
    expect(snapshot(m.root)).toEqual(before);

    const real = await m.run("init", manifest, "--no-hooks");
    expect(real.code, real.stdout + real.stderr).toBe(0);
    for (const dir of AGENT_DIRS) {
      expect(isLink(m.at(dir)), dir).toBe(false);
      expect(names(m.at(dir)), dir).toEqual(namesBefore);
    }
    expect(readdirSync(codex)).toEqual([".system"]);
    expect(linkOf(m.at(".claude/skills/conversation-video"))).toBe(
      join(work, "skills/conversation-video"),
    );
    expect(read(join(work, "skills/conversation-video/SKILL.md"))).toBe(
      skillMd("conversation-video"),
    );
    expect(linkOf(m.at(".agents/skills/unslop"))).toBe(join(work, "skills/unslop"));
    expect(read(m.at(".agents/skills/nuxt/SKILL.md"))).toBe(skillMd("nuxt"));
    expect(JSON.parse(read(manifest)).forks).toEqual({
      council: { from: "t3dotgg/tstack", path: "skills/council", base: "unknown" },
    });
    // The old copies are in the backup folder, not deleted.
    const backups = readdirSync(join(m.stateDir, "backup"));
    expect(backups).toHaveLength(1);
    expect(readdirSync(join(m.stateDir, "backup", backups[0]!, ".codex", "skills")).sort()).toEqual(
      [".nuxt-skills-managed", "nuxt", "vue"],
    );
    expect(
      read(join(m.stateDir, "backup", backups[0]!, ".codex", "skills", "nuxt", "SKILL.md")),
    ).toBe(skillMd("nuxt", "old copy"));
    // Running init again is a no-op.
    const again = await m.run("init", manifest, "--no-hooks");
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain("replace the link");
    expect(names(m.at(".claude/skills"))).toEqual(namesBefore);
  });

  it("9b. refuses a plan that would lose skill names unless forced", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "kept"));
    mkdirSync(m.at(".codex/skills/orphan"), { recursive: true });
    writeFileSync(m.at(".codex/skills/orphan/SKILL.md"), skillMd("orphan"));
    mkdirSync(m.at(".claude/skills/hand"), { recursive: true });
    writeFileSync(m.at(".claude/skills/hand/notes.txt"), "no SKILL.md here\n");
    // No adopt source: the orphan has nowhere to go, so it stays where it is and is not lost.
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("none lost");
    expect(dry.stdout).toContain(`${join("~", ".codex", "skills", "orphan")} stays`);
  });

  it("imports skills-lock.json version 2 entries that are not on disk as sources", async () => {
    const m = machine();
    const upstream = remote(m, "upstream", skills("skills/", "ag-dev", "ag-update", "ag-other"));
    const personal = remote(m, "personal", {
      ...skills("skills/", "mine"),
      "skills-lock.json": JSON.stringify({
        version: 2,
        skills: {
          "ag-dev": {
            source: upstream.url,
            sourceType: "git",
            ref: "main",
            skillPath: "skills/ag-dev/SKILL.md",
            computedHash: "x",
          },
          "ag-update": {
            source: upstream.url,
            sourceType: "git",
            skillPath: "skills/ag-update/SKILL.md",
            computedHash: "y",
          },
        },
      }),
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true }],
    });
    const dry = await m.json<{ imports: { sources: object[] }; after: string[] }>(
      "init",
      manifest,
      "--dry-run",
    );
    expect(dry.imports.sources).toEqual([
      { id: "upstream", git: upstream.url, include: ["ag-dev", "ag-update"] },
    ]);
    expect(dry.after).toEqual(["ag-dev", "ag-update", "mine"]);
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["ag-dev", "ag-update", "mine"]);
    expect(JSON.parse(read(manifest)).sources[1]).toEqual({
      id: "upstream",
      git: upstream.url,
      include: ["ag-dev", "ag-update"],
    });
  });

  describe("R2-1. agent folders linked to one another are one folder", () => {
    // [the link, the folder it points to]. Codex reads ~/.agents/skills and ~/.codex/skills.
    const layouts: [string, string][] = [
      [".codex/skills", ".agents/skills"],
      [".agents/skills", ".codex/skills"],
      [".claude/skills", ".agents/skills"],
      [".agents/skills", ".claude/skills"],
    ];
    for (const [link, folder] of layouts)
      it.skipIf(isWindows)(`${link} -> ${folder}`, async () => {
        const m = machine({ scheduler: "empty" });
        const vendor = remote(m, "vendor", skills("skills/", "tool"));
        mkdirSync(m.at(folder, "handmade"), { recursive: true });
        writeFileSync(m.at(folder, "handmade/SKILL.md"), skillMd("handmade"));
        rmSync(m.at(link), { recursive: true, force: true });
        mkdirSync(dirname(m.at(link)), { recursive: true });
        symlinkSync(m.at(folder), m.at(link));
        const manifest = m.manifest({
          agents: "all",
          sources: [{ id: "vendor", git: vendor.url }],
        });
        const dry = await m.json<{ lost: string[]; migrations: object[] }>(
          "init",
          manifest,
          "--dry-run",
        );
        expect(dry.lost).toEqual([]);
        expect(dry.migrations).toEqual([]);
        const init = await m.run("init", manifest, "--no-hooks");
        expect(init.stdout).not.toContain("LOST");
        expect(init.code, init.stdout + init.stderr).toBe(0);
        // The link stays, and both agents see the hand-made skill and the synced one, once.
        expect(isLink(m.at(link))).toBe(true);
        expect(names(m.at(folder))).toEqual(["handmade", "tool"]);
        expect(names(m.at(link))).toEqual(["handmade", "tool"]);
        expect(isLink(m.at(folder, "tool"))).toBe(true);
        const doctor = await m.run("doctor");
        expect(doctor.stdout).toMatch(/^ok {3}duplicate skills:/m);
        expect(doctor.stdout).toMatch(/^ok {3}agents agree:/m);
        const sync = await m.json("sync");
        expect(sync.errors).toEqual([]);
        expect(sync.targets.filter((target) => target.skipped)).toEqual([]);
      });
  });

  it("R3-8. a remote manifest is reported as the user named it, not as a cache or a deleted scratch copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    const spec = `${team.url}//.fleetrc/manifest.json`;
    const dry = await m.json<{ manifestFile: string; sync: { manifest: string } }>(
      "init",
      team.url,
      "--dry-run",
    );
    expect(dry.sync.manifest).toBe(spec);
    expect(dry.manifestFile).toBe(spec);
    const text = await m.run("init", team.url, "--dry-run");
    expect(text.stdout).toMatch(
      new RegExp(`^fleetrc init: manifest ${spec.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`, "m"),
    );
    expect((await m.run("init", team.url, "--no-hooks")).code).toBe(0);
    expect((await m.json("sync", "--dry-run")).manifest).toBe(spec);
    expect((await m.json("sync")).manifest).toBe(spec);
  });

  describe("R3-1. init adopts hand-made skills into a clone it has not made yet", () => {
    /** The README's new-machine flow: a personal manifest repository whose clone adopts skills. */
    function newMachine(m: Machine, { reachable = true } = {}) {
      const mine = remote(m, "mine", skills("skills/", "kept"));
      const team = remote(m, "team", {
        ".fleetrc/manifest.json": JSON.stringify({
          agents: ["claude-code"],
          sources: [
            { id: "mine", git: mine.url, path: "~/code/mine", skills: "skills/*", adopt: true },
          ],
        }),
      });
      mkdirSync(m.at(".claude/skills/handmade"), { recursive: true });
      writeFileSync(m.at(".claude/skills/handmade/SKILL.md"), skillMd("handmade"));
      if (!reachable) rmSync(mine.url, { recursive: true, force: true });
      return team;
    }

    it("clones first, then adopts, and the dry run says so in that order", async () => {
      const m = machine();
      const team = newMachine(m);
      const dry = await m.run("init", team.url, "--dry-run", "--no-hooks");
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      const clone = dry.stdout.indexOf("clone ");
      const adopt = dry.stdout.indexOf(
        `adopt ${join("~", ".claude", "skills", "handmade")} into ${join("~", "code", "mine", "skills", "handmade")}`,
      );
      expect(clone).toBeGreaterThan(-1);
      expect(adopt).toBeGreaterThan(clone);
      const init = await m.run("init", team.url, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(read(m.at("code/mine/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(isLink(m.at(".claude/skills/handmade"))).toBe(true);
      expect(names(m.at(".claude/skills"))).toEqual(["handmade", "kept"]);
      expect((await m.json("sync")).errors).toEqual([]);
    });

    it("leaves the hand-made skill where it is when the clone fails", async () => {
      const m = machine();
      const team = newMachine(m, { reachable: false });
      const init = await m.run("init", team.url, "--no-hooks");
      const said = init.stdout + init.stderr;
      expect(said).toContain(`could not clone mine into ${join("~", "code", "mine")} (`);
      expect(said).toContain("so nothing is adopted");
      expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(isLink(m.at(".claude/skills/handmade"))).toBe(false);
      expect(existsSync(m.at("code/mine"))).toBe(false);
    });

    it("adopts nothing into a folder at the clone's path that is not a clone", async () => {
      const m = machine();
      const team = newMachine(m);
      mkdirSync(m.at("code/mine/notes"), { recursive: true });
      const dry = await m.json<{
        migrations: { kind: string }[];
        lost: string[];
        warnings: string[];
      }>("init", team.url, "--dry-run", "--no-hooks");
      expect(dry.migrations.map((migration) => migration.kind)).toEqual([]);
      expect(dry.lost).toEqual([]);
      expect(dry.warnings.join("\n")).toContain(
        `${join("~", "code", "mine")} exists and is not a git repository`,
      );
      await m.run("init", team.url, "--no-hooks");
      expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
      expect(existsSync(m.at("code/mine/skills"))).toBe(false);
    });
  });
});
