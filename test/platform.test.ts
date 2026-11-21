import { appendFileSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_DIRS,
  clone,
  isLink,
  isWindows,
  linkOf,
  machine,
  names,
  read,
  remote,
  skillMd,
  skills,
} from "./fixture.ts";

describe("links on each OS", () => {
  it.runIf(isWindows)(
    "12a. Windows: skill folders are directory junctions into the source",
    async () => {
      const m = machine();
      const personal = remote(m, "personal", skills("skills/", "win"));
      const work = clone(m, personal, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code", "codex"],
        sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
      });
      const init = await m.run("init", manifest, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      const link = m.at(".claude/skills/win");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(linkOf(link)).toBe(join(work, "skills/win"));
      const manifestFile = JSON.parse(read(m.at(".claude/skills/.fleetrc-manifest.json"))) as {
        links: Record<string, { kind: string }>;
      };
      expect(manifestFile.links.win!.kind).toBe("junction");
      // Editing through the junction edits the working clone.
      writeFileSync(join(link, "SKILL.md"), skillMd("win", "edited"));
      expect(read(join(work, "skills/win/SKILL.md"))).toBe(skillMd("win", "edited"));
      // Removing the skill removes only the junction, never the clone's folder.
      personal.commit({ "skills/win": null });
      m.git(work, "checkout", "--", ".");
      await m.run("sync");
      expect(names(m.at(".claude/skills"))).toEqual([]);
    },
  );

  it.skipIf(isWindows)(
    "12a. Unix: skill folders are symlinks (junctions are Windows-only)",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "unix"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
      const record = JSON.parse(read(m.at(".claude/skills/.fleetrc-manifest.json"))) as {
        links: Record<string, { kind: string }>;
      };
      expect(record.links.unix!.kind).toBe("symlink");
    },
  );

  it("12b. --copy writes real folders, refreshes them on change, and never overwrites an edited copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "copied", "other"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks", "--copy");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    for (const dir of [".claude/skills", ".cursor/skills"]) {
      expect(names(m.at(dir))).toEqual(["copied", "other"]);
      expect(isLink(m.at(dir, "copied"))).toBe(false);
    }
    const record = JSON.parse(read(m.at(".claude/skills/.fleetrc-manifest.json"))) as {
      links: Record<string, { kind: string }>;
    };
    expect(record.links.copied!.kind).toBe("copy");

    vendor.commit({
      "skills/copied/SKILL.md": skillMd("copied", "v2"),
      "skills/other/SKILL.md": skillMd("other", "v2"),
    });
    writeFileSync(m.at(".cursor/skills/other/SKILL.md"), skillMd("other", "edited copy"));
    const report = await m.json("sync", "--copy");
    expect(read(m.at(".claude/skills/copied/SKILL.md"))).toBe(skillMd("copied", "v2"));
    expect(read(m.at(".cursor/skills/copied/SKILL.md"))).toBe(skillMd("copied", "v2"));
    // The edit in one agent's copy is an edit of the skill, so every agent shows it (R3-2).
    for (const dir of [".claude/skills", ".cursor/skills"])
      expect(read(m.at(dir, "other/SKILL.md"))).toBe(skillMd("other", "edited copy"));
    expect(report.edited).toEqual([{ source: "vendor", skill: "other", files: ["SKILL.md"] }]);
    expect(report.pending).toEqual([
      { source: "vendor", skill: "other", reason: "edited", files: ["SKILL.md"] },
    ]);

    // Dropping the skill keeps it, edited, for every agent.
    vendor.commit({ "skills/other": null });
    const dropped = await m.json("sync", "--copy");
    expect(dropped.warnings).toContain(
      "vendor: other is gone upstream but has local edits, so it stays",
    );
    expect(names(m.at(".claude/skills"))).toEqual(["copied", "other"]);
    expect(names(m.at(".cursor/skills"))).toEqual(["copied", "other"]);
  });

  it("R3-2. an edited copy is an edit of its skill: status lists it, diff and merge find it, and agents agree after --no-copy", async () => {
    const m = machine({ scheduler: "empty" });
    const beta = (...body: string[]) =>
      `---\nname: beta\ndescription: The beta skill\n---\n${body.join("\n")}\n`;
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "alpha"),
      "skills/beta/SKILL.md": beta("one", "two", "three", "four"),
    });
    const manifest = m.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks", "--copy");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    appendFileSync(m.at(".claude/skills/beta/SKILL.md"), "mine\n");
    const edited = beta("one", "two", "three", "four", "mine");

    const relinked = await m.json("sync", "--no-copy");
    expect(relinked.ok, JSON.stringify(relinked.errors)).toBe(true);
    expect(relinked.edited).toEqual([{ source: "vendor", skill: "beta", files: ["SKILL.md"] }]);
    for (const dir of AGENT_DIRS) {
      expect(isLink(m.at(dir, "beta")), dir).toBe(true);
      expect(read(m.at(dir, "beta/SKILL.md")), dir).toBe(edited);
    }

    vendor.commit({ "skills/beta/SKILL.md": beta("ONE", "two", "three", "four") });
    const held = await m.json("sync");
    expect(held.edited).toEqual([{ source: "vendor", skill: "beta", files: ["SKILL.md"] }]);
    expect(held.pending).toEqual([
      { source: "vendor", skill: "beta", reason: "edited", files: ["SKILL.md"] },
    ]);
    for (const dir of AGENT_DIRS) expect(read(m.at(dir, "beta/SKILL.md")), dir).toBe(edited);
    const status = await m.run("status");
    expect(status.stdout).toContain(
      "edited beta (vendor): SKILL.md; upstream changed too, see `fleetrc diff beta`",
    );
    const doctor = await m.json<{ name: string; ok: boolean; detail: string }[]>("doctor");
    expect(doctor.find((check) => check.name === "agents agree")).toMatchObject({ ok: true });

    const diff = await m.run("diff", "beta");
    expect(diff.code, diff.stderr).toBe(0);
    expect(diff.stdout).toContain("+ONE");
    expect(diff.stdout).toContain("-mine");
    const merge = await m.run("merge", "beta");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: SKILL.md");
    for (const dir of AGENT_DIRS)
      expect(read(m.at(dir, "beta/SKILL.md")), dir).toBe(
        beta("ONE", "two", "three", "four", "mine"),
      );
  });

  it("R3-2. in --copy mode an edit in one agent's copy reaches every agent's copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "alpha", "beta"));
    const manifest = m.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks", "--copy")).code).toBe(0);
    appendFileSync(m.at(".agents/skills/beta/SKILL.md"), "mine\n");
    const report = await m.json("sync");
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.edited).toEqual([{ source: "vendor", skill: "beta", files: ["SKILL.md"] }]);
    for (const dir of AGENT_DIRS) {
      expect(isLink(m.at(dir, "beta")), dir).toBe(false);
      expect(read(m.at(dir, "beta/SKILL.md")), dir).toBe(`${skillMd("beta")}mine\n`);
    }
    expect(report.targets.flatMap((target) => target.warnings)).toEqual([]);
    // Settled: the next sync changes nothing.
    const again = await m.json("sync");
    expect(again.warnings).toEqual([]);
    expect(again.targets.flatMap((target) => [...target.created, ...target.removed])).toEqual([]);
  });
});
