import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  clone,
  http,
  isLink,
  linkOf,
  machine,
  names,
  read,
  remote,
  serveIndexV2,
  skillMd,
  skills,
} from "./fixture.ts";

const lines = (...body: string[]) =>
  `---\nname: tool\ndescription: The tool skill\n---\n${body.join("\n")}\n`;

async function editedVendoredSkill(options: Parameters<typeof machine>[0] = {}) {
  const m = machine(options);
  const personal = remote(m, "personal", skills("skills/", "mine"));
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", {
    "skills/tool/SKILL.md": lines("one", "two", "three", "four", "five"),
    "skills/tool/ref.md": "ref v1\n",
  });
  const manifest = m.manifest({
    agents: ["claude-code", "codex"],
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: vendor.url },
    ],
  });
  expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
  // Edited through the agent folder: the link leads into fleetrc's copy.
  const local = lines("one", "TWO (mine)", "three", "four", "five");
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), local);
  return { m, work, vendor, manifest, local };
}

describe("edited vendored skills", () => {
  it("4a. are never overwritten, and diff shows local against upstream", async () => {
    const { m, vendor, local } = await editedVendoredSkill();
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
      "skills/tool/ref.md": "ref v2\n",
    });
    const report = await m.json("sync");
    expect(report.edited).toEqual([{ source: "vendor", skill: "tool", files: ["SKILL.md"] }]);
    expect(report.pending).toEqual([
      { source: "vendor", skill: "tool", reason: "edited", files: ["SKILL.md", "ref.md"] },
    ]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(local);
    expect(read(m.at(".agents/skills/tool/ref.md"))).toBe("ref v1\n");
    const again = await m.json("sync");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(local);
    expect(again.pending.map((entry) => entry.skill)).toEqual(["tool"]);

    const diff = await m.run("diff", "tool");
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("-TWO (mine)");
    expect(diff.stdout).toContain("+FIVE (theirs)");
    expect(diff.stdout).toContain("+ref v2");
  });

  it("4b. merge brings in an upstream change to other lines cleanly", async () => {
    const { m, vendor } = await editedVendoredSkill();
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
      "skills/tool/ref.md": "ref v2\n",
    });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: SKILL.md, ref.md");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "four", "FIVE (theirs)"),
    );
    expect(read(m.at(".claude/skills/tool/ref.md"))).toBe("ref v2\n");
    // The merged copy still counts as edited (against the new base), and nothing is pending.
    const report = await m.json("sync");
    expect(report.pending).toEqual([]);
    expect(report.edited).toEqual([{ source: "vendor", skill: "tool", files: ["SKILL.md"] }]);
    // A later upstream change to another line is held again, and merges again.
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "FOUR (theirs again)", "FIVE (theirs)"),
    });
    await m.run("sync");
    expect((await m.run("merge", "tool")).code).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "FOUR (theirs again)", "FIVE (theirs)"),
    );
  });

  it("4c. merge leaves conflict markers when both sides changed the same line", async () => {
    // status and doctor read the timer: a scheduler with none.
    const { m, vendor } = await editedVendoredSkill({ scheduler: "empty" });
    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "TWO (theirs)", "three", "four", "five"),
    });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code).toBe(1);
    expect(merge.stdout).toContain("conflicts: SKILL.md");
    const text = read(m.at(".claude/skills/tool/SKILL.md"));
    expect(text).toContain("<<<<<<< local\nTWO (mine)\n=======\nTWO (theirs)\n>>>>>>> upstream");
    // Nothing is pending after a merge, and sync does not touch the file with markers.
    const report = await m.json("sync");
    expect(report.pending).toEqual([]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(text);
    // R7-17. The markers stay in the copy agents use, as git leaves them in a working tree, so
    // sync, status and doctor say the skill is held until they are resolved and merge runs again.
    expect(report.held).toEqual([
      {
        source: "vendor",
        reason: "tool has unresolved merge conflicts; resolve them, then run `fleetrc merge tool`",
        files: ["SKILL.md"],
      },
    ]);
    expect((await m.run("status")).stdout).toContain(
      "tool: unresolved merge conflicts in SKILL.md",
    );
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(/^FAIL merge conflicts: tool: unresolved merge conflicts/m);
    const early = await m.run("merge", "tool");
    expect(early.code).toBe(1);
    expect(early.stderr).toContain("tool still has merge conflicts in SKILL.md");
    // Resolved by hand: merge records it, and says so instead of "no upstream change to merge".
    writeFileSync(
      m.at(".claude/skills/tool/SKILL.md"),
      lines("one", "TWO (both)", "three", "four", "five"),
    );
    const done = await m.run("merge", "tool");
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain("merged; nothing left to do");
    expect((await m.json("sync")).held).toEqual([]);
    expect((await m.run("status")).stdout).not.toContain("unresolved merge conflicts");
    expect((await m.run("merge", "tool")).stderr).toContain("has no upstream change to merge");
  });

  it("4d. fork moves the skill into the personal repository, records its base, and diff/merge follow upstream", async () => {
    const { m, work, vendor, manifest, local } = await editedVendoredSkill();
    const base = vendor.head();
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(local);
    expect(linkOf(m.at(".claude/skills/tool"))).toBe(join(work, "skills/tool"));
    expect(isLink(m.at(".agents/skills/tool"))).toBe(true);
    const saved = JSON.parse(read(manifest)) as {
      forks: Record<string, { from: string; path: string; base: string }>;
      sources: { exclude?: string[] }[];
    };
    expect(saved.forks.tool).toEqual({ from: vendor.url, path: "skills/tool", base });
    expect(saved.sources[1]!.exclude).toEqual(["tool"]);
    expect(existsSync(join(m.stateDir, "store", "vendor", "live", "tool"))).toBe(false);

    vendor.commit({
      "skills/tool/SKILL.md": lines("one", "two", "three", "four", "FIVE (theirs)"),
    });
    const diff = await m.run("diff", "tool");
    expect(diff.stdout).toContain("+TWO (mine)");
    expect(diff.stdout).toContain("-FIVE (theirs)");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(
      lines("one", "TWO (mine)", "three", "four", "FIVE (theirs)"),
    );
    expect((JSON.parse(read(manifest)) as typeof saved).forks.tool!.base).toBe(vendor.head());
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "tool"]);
  });

  it("4e. an unedited vendored skill updates in place", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "plain"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    vendor.commit({ "skills/plain/SKILL.md": skillMd("plain", "v2") });
    const report = await m.json("sync");
    expect(report.skills.updated).toEqual(["plain"]);
    expect(read(m.at(".claude/skills/plain/SKILL.md"))).toBe(skillMd("plain", "v2"));
  });
});

describe("forks of sources without git history", () => {
  it("fork refuses a skill of an index or npm source, which diff and merge could never compare with", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const site = await http();
    serveIndexV2(site, [{ name: "drop", files: { "SKILL.md": skillMd("drop") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "site", index: site.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const fork = await m.run("fork", "drop");
    expect(fork.code).toBe(1);
    expect(fork.stderr).toContain(
      "fork follows a skill's upstream through its git history, and site is an index site",
    );
    // Nothing moved, and the manifest records no fork.
    expect(existsSync(join(work, "skills", "drop"))).toBe(false);
    expect(JSON.parse(read(manifest)).forks).toBeUndefined();
    // A fork an older fleetrc recorded is refused by diff and merge with the same reason.
    const raw = JSON.parse(read(manifest));
    raw.forks = { drop: { from: site.url, path: "drop", base: "x" } };
    writeFileSync(manifest, JSON.stringify(raw));
    for (const command of ["diff", "merge"]) {
      const run = await m.run(command, "drop");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `drop was forked from ${site.url}, which is not a git repository`,
      );
    }
  });
});
