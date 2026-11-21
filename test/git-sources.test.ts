// Git sources on every file system: names macOS and Windows fold together, refs that name a
// commit, manifest links copied from a browser, hook paths and the last-run report of a partial sync.
// On macOS (APFS folds case and Unicode normalization) these reproduce what happens there for real;
// on Linux and Windows they check that every machine of a fleet ends up with the same skills.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collisions, refusals } from "../src/gitcache.ts";
import {
  clone,
  type Machine,
  machine,
  names,
  read,
  type Remote,
  remote,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

/**
 * Replaces the tree of the remote's main branch with `files`, written with git plumbing, so names
 * that macOS would fold on disk (Foo and foo, NFC and NFD) reach the commit as given, as when they
 * were committed on Linux.
 */
function commitRaw(m: Machine, r: Remote, files: Record<string, string>): string {
  const index = join(m.root, "raw-index");
  rmSync(index, { force: true });
  const run = (args: string[], input?: string) =>
    execFileSync("git", ["-c", "core.precomposeunicode=false", ...args], {
      cwd: r.url,
      env: { ...m.env, GIT_INDEX_FILE: index },
      input,
      encoding: "utf8",
    }).trim();
  const entries = Object.entries(files).map(
    ([path, content]) => `100644 ${run(["hash-object", "-w", "--stdin"], content)}\t${path}`,
  );
  run(["update-index", "--index-info"], `${entries.join("\n")}\n`);
  const tree = run(["write-tree"]);
  const commit = run(["commit-tree", tree, "-p", "refs/heads/main", "-m", "raw"]);
  run(["update-ref", "refs/heads/main", commit]);
  return commit;
}

const nfc = (list: string[]) => list.map((name) => name.normalize("NFC"));

/** A hook script that appends FLEETRC_CHANGED to `log`, one JSON line per run. */
function changedLog(m: Machine) {
  const log = join(m.root, "changed.jsonl");
  const script = join(m.root, "changed.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.env.FLEETRC_CHANGED.split("\\n")) + "\\n");`,
  );
  return {
    run: `"${process.execPath}" "${script}"`,
    runs: (): string[][] =>
      existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

describe("names macOS and Windows fold together", () => {
  it("MAC2. a skill folder named in NFD stays linked across syncs", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "plain"));
    const nfd = "cafe\u0301";
    commitRaw(m, vendor, {
      ...skills("skills/", "plain"),
      [`skills/${nfd}/SKILL.md`]: skillMd(nfd),
      [`skills/${nfd}/notes.md`]: "notes\n",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(nfc(names(m.at(".claude/skills")))).toEqual(["café", "plain"]);

    // On macOS the second sync used to `git clean` the folder away as untracked.
    for (let run = 0; run < 2; run++) {
      const report = await m.json("sync");
      expect(report.ok, JSON.stringify(report.errors)).toBe(true);
      expect(nfc(report.skills.names)).toEqual(["café", "plain"]);
      expect(report.skills.removed).toEqual([]);
      expect(report.skills.added).toEqual([]);
      expect(report.edited).toEqual([]);
    }
    const linked = names(m.at(".claude/skills")).find((name) => name.normalize("NFC") === "café")!;
    expect(read(m.at(".claude/skills", linked, "notes.md"))).toBe("notes\n");
  });

  it("MAC3. of Foo and foo in one repository, Foo is linked on every system and stays linked", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "other"));
    const files = {
      ...skills("skills/", "other"),
      "skills/Foo/SKILL.md": skillMd("Foo"),
      "skills/foo/SKILL.md": skillMd("foo"),
      "skills/foo/extra.md": "only in foo\n",
    };
    commitRaw(m, vendor, files);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(init.stdout).toContain(
      "vendor: left out skills/foo: macOS and Windows keep it in the same folder as skills/Foo",
    );
    expect(names(m.at(".claude/skills"))).toEqual(["Foo", "other"]);
    expect(read(m.at(".claude/skills/Foo/SKILL.md"))).toBe(skillMd("Foo"));
    expect(existsSync(m.at(".claude/skills/Foo/extra.md"))).toBe(false);

    for (let run = 0; run < 3; run++) {
      const report = await m.json("sync");
      expect(report.ok, JSON.stringify(report.errors)).toBe(true);
      expect(report.skills.names).toEqual(["Foo", "other"]);
      expect(report.skills.added).toEqual([]);
      expect(report.skills.removed).toEqual([]);
      expect(report.edited).toEqual([]);
      expect(report.targets.flatMap((target) => target.warnings)).toEqual([]);
      expect(report.warnings).toEqual([
        "vendor: left out skills/foo: macOS and Windows keep it in the same folder as skills/Foo",
      ]);
    }
    const { skills: listed } = JSON.parse((await m.run("list", "--json")).stdout) as {
      skills: { name: string; dir: string }[];
    };
    expect(listed.map((skill) => skill.name)).toEqual(["Foo", "other"]);
    expect(read(join(listed[0]!.dir, "SKILL.md"))).toBe(skillMd("Foo"));

    // An upstream change to Foo is an update, not a local edit.
    commitRaw(m, vendor, { ...files, "skills/Foo/SKILL.md": skillMd("Foo", "v2") });
    const updated = await m.json("sync");
    expect(updated.skills.updated).toEqual(["Foo"]);
    expect(updated.edited).toEqual([]);
    expect(read(m.at(".claude/skills/Foo/SKILL.md"))).toBe(skillMd("Foo", "v2"));
  });

  it("MAC3. collisions keep the first path in byte order, by folder", () => {
    expect(
      collisions([
        "skills/foo/SKILL.md",
        "skills/Foo/SKILL.md",
        "skills/Foo/a.md",
        "skills/foo/b.md",
        "skills/cafe\u0301/SKILL.md",
        "skills/caf\u00e9/SKILL.md",
        "skills/bar./SKILL.md",
        "skills/bar/SKILL.md",
        "README.md",
      ]),
    ).toEqual([
      { path: "skills/bar.", kept: "skills/bar" },
      { path: "skills/caf\u00e9", kept: "skills/cafe\u0301" },
      { path: "skills/foo", kept: "skills/Foo" },
    ]);
  });

  it("W-NAME. refusals name the first part of each path that Windows can't write", () => {
    expect(
      refusals([
        "skills/good/SKILL.md",
        "skills/bad/aux.txt",
        "skills/bad/AUX .md",
        "skills/bad/nul",
        "skills/bad/notes.",
        "skills/bad/notes ",
        "skills/bad/foo:bar",
        "skills/bad/back\\slash",
        "skills/con/SKILL.md",
        "skills/con/notes.md",
        "skills/longna~1/SKILL.md",
        "skills/PROGRA~1.TXT",
        "skills/.GIT/config",
        "skills/console/SKILL.md",
        "skills/auxiliary.md",
        "skills/tilde~1-skill/SKILL.md",
        "skills/longname~1.json5",
      ]).map((refusal) => refusal.path),
    ).toEqual([
      "skills/bad/aux.txt",
      "skills/bad/AUX .md",
      "skills/bad/nul",
      "skills/bad/notes.",
      "skills/bad/notes ",
      "skills/bad/foo:bar",
      "skills/bad/back\\slash",
      "skills/con",
      "skills/longna~1",
      "skills/PROGRA~1.TXT",
      "skills/.GIT",
    ]);
  });

  // windows.test.ts runs this on Windows, where git refuses to write such a commit through an index.
  // Linux and macOS keep such names, as git does in a working clone there (R7-12), and say Windows
  // machines lack them.
  it.skipIf(process.platform === "win32")(
    "W-NAME. names Windows can't write are kept on Linux and macOS, with a warning each sync that Windows lacks them",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "good"));
      commitRaw(m, vendor, {
        ...skills("skills/", "good"),
        "skills/bad/SKILL.md": skillMd("bad"),
        "skills/bad/aux.txt": "device\n",
        "skills/bad/notes.": "dot\n",
        "skills/aux/SKILL.md": skillMd("aux"),
        "skills/longname-skill/SKILL.md": skillMd("longname-skill", "the real one"),
        "skills/longna~1/SKILL.md": skillMd("longna~1", "HIJACKED"),
      });
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      const init = await m.run("init", manifest, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      const lack = (path: string, why: string) =>
        `vendor: Windows machines lack ${path}: its name ${why}; rename it upstream so every machine has it`;
      const warnings = [
        lack("skills/aux", "is a device name on Windows"),
        lack("skills/bad/aux.txt", "is a device name on Windows"),
        lack("skills/bad/notes.", "ends with a dot or a space, which Windows drops"),
        lack(
          "skills/longna~1",
          "looks like an 8.3 short name, which Windows can resolve to another folder",
        ),
      ];
      for (let run = 0; run < 2; run++) {
        const report = await m.json("sync");
        expect(report.ok, JSON.stringify(report.errors)).toBe(true);
        // A skill named aux is still skipped: its name is a folder in every agent folder.
        expect(report.skills.names).toEqual(["bad", "good", "longname-skill", "longna~1"]);
        expect(report.skills.added).toEqual([]);
        expect(
          [...report.warnings].filter((w) => w.includes("Windows machines lack")).sort(),
        ).toEqual(warnings);
      }
      expect(names(m.at(".claude/skills/bad"))).toEqual(["SKILL.md", "aux.txt", "notes."]);
      expect(read(m.at(".claude/skills/longname-skill/SKILL.md"))).toBe(
        skillMd("longname-skill", "the real one"),
      );
    },
  );

  it("R3-3. a working clone with Foo and foo keeps updating, warns once a sync, and links Foo", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "delta"));
    const files = {
      ...skills("skills/", "delta"),
      "skills/Foo/SKILL.md": skillMd("Foo"),
      "skills/foo/SKILL.md": skillMd("foo"),
    };
    commitRaw(m, personal, files);
    // On macOS and Windows git checks both out into one folder and then sees skills/Foo as changed.
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const clash =
      "personal: skills/Foo and skills/foo differ only in case or Unicode form, so macOS and Windows check them out as one folder";
    const clashWarnings = (report: { warnings: string[] }) =>
      report.warnings.filter((warning) => warning.startsWith(clash));

    // An upstream change to another skill arrives; nothing is held for the clash.
    let head = commitRaw(m, personal, {
      ...files,
      "skills/delta/SKILL.md": skillMd("delta", "v2"),
    });
    const first = await m.json("sync");
    expect(first.ok, JSON.stringify(first.errors)).toBe(true);
    expect(first.held).toEqual([]);
    expect(first.sources[0]).toMatchObject({ status: "updated", to: head });
    expect(clashWarnings(first)).toHaveLength(1);
    expect(read(join(work, "skills/delta/SKILL.md"))).toBe(skillMd("delta", "v2"));
    expect(read(m.at(".claude/skills/delta/SKILL.md"))).toBe(skillMd("delta", "v2"));
    // The folder every system shares holds Foo, the name the git cache keeps too.
    expect(read(join(work, "skills/Foo/SKILL.md"))).toBe(skillMd("Foo"));
    expect(read(m.at(".claude/skills/Foo/SKILL.md"))).toBe(skillMd("Foo"));

    // An upstream change to foo, the name left out, does not hold the clone either.
    head = commitRaw(m, personal, {
      ...files,
      "skills/delta/SKILL.md": skillMd("delta", "v3"),
      "skills/foo/SKILL.md": skillMd("foo", "v2"),
    });
    const second = await m.json("sync");
    expect(second.held).toEqual([]);
    expect(second.sources[0]).toMatchObject({ status: "updated", to: head });
    expect(clashWarnings(second)).toHaveLength(1);
    expect(read(join(work, "skills/delta/SKILL.md"))).toBe(skillMd("delta", "v3"));
    expect(read(join(work, "skills/Foo/SKILL.md"))).toBe(skillMd("Foo"));

    // A real local edit to a file that changes upstream still holds it.
    writeFileSync(join(work, "skills/delta/SKILL.md"), skillMd("delta", "mine"));
    commitRaw(m, personal, {
      ...files,
      "skills/delta/SKILL.md": skillMd("delta", "v4"),
      "skills/foo/SKILL.md": skillMd("foo", "v2"),
    });
    const held = await m.json("sync");
    expect(held.held).toEqual([
      {
        source: "personal",
        reason: "local edits touch files that changed upstream",
        files: ["skills/delta/SKILL.md"],
      },
    ]);
  });

  /** alpha's SKILL.md, whose name is all that changes in the rename. */
  const alphaMd = (name: string) =>
    `---\nname: ${name}\ndescription: The alpha skill\n---\none\ntwo\nthree\n`;

  /** A vendored source with alpha and other, linked for Claude Code and Codex. */
  async function caseRename() {
    const m = machine();
    const files = { ...skills("skills/", "other"), "skills/alpha/SKILL.md": alphaMd("alpha") };
    const vendor = remote(m, "vendor", files);
    const manifest = m.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    // Upstream renames skills/alpha to skills/Alpha, and its name with it.
    const rename = () =>
      commitRaw(m, vendor, {
        ...skills("skills/", "other"),
        "skills/Alpha/SKILL.md": alphaMd("Alpha"),
      });
    return { m, rename };
  }
  const allWarnings = (report: { warnings: string[]; targets: { warnings: string[] }[] }) => [
    ...report.warnings,
    ...report.targets.flatMap((target) => target.warnings),
  ];

  it("R3-4. a skill renamed upstream only in case is renamed here, quietly", async () => {
    const { m, rename } = await caseRename();
    rename();
    const report = await m.json("sync");
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.renamed).toEqual([{ from: "alpha", to: "Alpha" }]);
    expect(report.skills.names).toEqual(["Alpha", "other"]);
    expect(report.skills.updated).toEqual(["Alpha"]);
    expect(report.skills.added).toEqual([]);
    expect(report.skills.removed).toEqual([]);
    expect(report.edited).toEqual([]);
    expect(allWarnings(report)).toEqual([]);
    for (const dir of [".claude/skills", ".agents/skills"]) {
      expect(names(m.at(dir))).toEqual(["Alpha", "other"]);
      expect(read(m.at(dir, "Alpha/SKILL.md"))).toBe(alphaMd("Alpha"));
    }
    expect((await m.run("sync")).stdout).not.toContain("renamed");
    const again = await m.json("sync");
    expect(allWarnings(again)).toEqual([]);
    expect(again.skills.updated).toEqual([]);
  });

  it("R3-4. an edited skill renamed upstream only in case keeps its edit under the new name", async () => {
    const { m, rename } = await caseRename();
    appendFileSync(m.at(".claude/skills/alpha/SKILL.md"), "mine\n");
    rename();
    const sync = await m.run("sync");
    expect(sync.stdout).toContain("renamed alpha -> Alpha");
    for (let run = 0; run < 2; run++) {
      const report = await m.json("sync");
      expect(report.ok, JSON.stringify(report.errors)).toBe(true);
      expect(report.skills.names).toEqual(["Alpha", "other"]);
      expect(report.edited).toEqual([{ source: "vendor", skill: "Alpha", files: ["SKILL.md"] }]);
      expect(report.pending).toEqual([
        { source: "vendor", skill: "Alpha", reason: "edited", files: ["SKILL.md"] },
      ]);
      expect(allWarnings(report)).toEqual([]);
      for (const dir of [".claude/skills", ".agents/skills"]) {
        expect(names(m.at(dir))).toEqual(["Alpha", "other"]);
        expect(read(m.at(dir, "Alpha/SKILL.md"))).toBe(`${alphaMd("alpha")}mine\n`);
      }
    }
    // Either spelling finds it.
    for (const typed of ["Alpha", "alpha"]) {
      const diff = await m.run("diff", typed);
      expect(diff.code, diff.stderr).toBe(0);
      expect(diff.stdout).toContain("+name: Alpha");
    }
    const merge = await m.run("merge", "alpha");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: SKILL.md");
    expect(read(m.at(".claude/skills/Alpha/SKILL.md"))).toBe(`${alphaMd("Alpha")}mine\n`);
    const after = await m.json("sync");
    expect(after.pending).toEqual([]);
    expect(allWarnings(after)).toEqual([]);
  });

  /** A vendored source with plain and an NFD café, and a personal source to fork into. */
  async function nfdSkill(body: string[] = ["one", "two", "three"]) {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const vendor = remote(m, "vendor", skills("skills/", "plain"));
    const nfd = "cafe\u0301";
    const cafe = (...lines: string[]) =>
      `---\nname: ${nfd}\ndescription: The café skill\n---\n${lines.join("\n")}\n`;
    const files = { ...skills("skills/", "plain"), [`skills/${nfd}/SKILL.md`]: cafe(...body) };
    commitRaw(m, vendor, files);
    const source = { id: "vendor", git: vendor.url };
    const write = (vendorSource: object, extra: object = {}) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
          { ...source, ...vendorSource },
        ],
        ...extra,
      });
    const manifest = write({});
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    return { m, work, vendor, nfd, cafe, files, write };
  }
  // What a macOS keyboard types.
  const typed = "caf\u00e9";

  it("R3-5. diff, merge and fork find a skill named in NFD when its name is typed in NFC", async () => {
    const { m, work, vendor, nfd, cafe, files } = await nfdSkill();
    const unchanged = await m.run("diff", typed);
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toBe("no differences\n");
    // Case too, on every system, as sync treats names that differ in case as one skill.
    expect((await m.run("diff", "PLAIN")).code).toBe(0);

    const linked = names(m.at(".claude/skills")).find((name) => name.normalize("NFC") === typed)!;
    appendFileSync(m.at(".claude/skills", linked, "SKILL.md"), "mine\n");
    commitRaw(m, vendor, { ...files, [`skills/${nfd}/SKILL.md`]: cafe("ONE", "two", "three") });
    await m.run("sync");
    const merge = await m.run("merge", typed);
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: SKILL.md");
    expect(read(m.at(".claude/skills", linked, "SKILL.md"))).toBe(
      `${cafe("ONE", "two", "three")}mine\n`,
    );

    const fork = await m.run("fork", typed);
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    expect(read(join(work, "skills", nfd, "SKILL.md"))).toBe(
      `${cafe("ONE", "two", "three")}mine\n`,
    );
    const recorded = JSON.parse(read(join(m.root, "manifest", ".fleetrc", "manifest.json"))) as {
      forks: Record<string, unknown>;
      sources: { exclude?: string[] }[];
    };
    expect(Object.keys(recorded.forks)).toEqual([nfd]);
    expect(recorded.sources[1]!.exclude).toEqual([nfd]);
  });

  it("R3-5. remove, include, exclude and hooks find a skill named in NFD by its NFC name", async () => {
    const { m, vendor, nfd, cafe, files, write } = await nfdSkill();
    const removed = await m.run("remove", typed);
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "plain"]);
    const manifest = JSON.parse(read(join(m.root, "manifest", ".fleetrc", "manifest.json"))) as {
      sources: { exclude?: string[] }[];
    };
    expect(manifest.sources[1]!.exclude).toEqual([nfd]);

    write({ exclude: [typed] });
    const excluded = await m.json("sync");
    expect(excluded.skills.names).toEqual(["mine", "plain"]);

    const hook = changedLog(m);
    write(
      { include: [typed] },
      { hooks: [{ name: "cafe", on: [`vendor:skills/${typed}/**`], run: hook.run }] },
    );
    const included = await m.json("sync");
    expect(nfc(included.skills.names)).toEqual([typed, "mine"]);
    expect(included.warnings.filter((warning) => warning.includes("include names"))).toEqual([]);
    expect(included.warnings.filter((warning) => warning.startsWith("hook "))).toEqual([]);
    commitRaw(m, vendor, { ...files, [`skills/${nfd}/SKILL.md`]: cafe("v2") });
    const changed = await m.json("sync");
    expect(changed.hooks.map((run) => run.name)).toEqual(["cafe"]);
  });
});

describe("refs that name a commit", () => {
  it("D8. a vendored source pinned to a short or full commit id stays on it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const pinned = vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "pinned") });
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "later") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "short", git: vendor.url, ref: pinned.slice(0, 7), include: ["tool"] },
        { id: "full", git: vendor.url, ref: pinned, skills: "skills/*" },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "pinned"));

    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "latest") });
    const report = await m.json("sync");
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(report.sources.map((source) => [source.id, source.status, source.to])).toEqual([
      ["short", "unchanged", pinned],
      ["full", "unchanged", pinned],
    ]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "pinned"));
  });

  it("D8. a ref that is no branch, tag or commit says so", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, ref: "abcdef1" }],
    });
    await m.run("init", manifest, "--no-hooks");
    const report = await m.json("sync");
    expect(report.errors.join("\n")).toContain("has no branch, tag or commit abcdef1");
  });

  it("D8. a working clone pinned to a commit is cloned detached there and stays until the pin moves", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const first = personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "first") });
    const second = personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "second") });
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "third") });
    const work = m.at("code/skills");
    const write = (ref: string) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "personal", git: personal.url, path: work, ref }],
      });
    const init = await m.run("init", write(first.slice(0, 7)), "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(first);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine", "first"));

    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "fourth") });
    const stay = await m.json("sync");
    expect(stay.ok, JSON.stringify(stay.errors)).toBe(true);
    expect(stay.warnings).toEqual([]);
    expect(stay.sources[0]).toMatchObject({ status: "unchanged", to: first });
    expect(m.git(work, "rev-parse", "HEAD")).toBe(first);

    write(second);
    const moved = await m.json("sync");
    expect(moved.ok, JSON.stringify(moved.errors)).toBe(true);
    expect(moved.sources[0]).toMatchObject({ status: "updated", from: first, to: second });
    expect(moved.sources[0]!.changed).toEqual(["skills/mine/SKILL.md"]);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine", "second"));
  });

  it("D8. a working clone pinned to a full commit id is cloned at it", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const pinned = personal.head();
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "later") });
    const work = m.at("code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, ref: pinned }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(pinned);
    expect(read(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine"));
  });
});

describe("manifest specs", () => {
  /** Sends git's requests for `url` to the local remote `r`, as if it were hosted there. */
  const hostAt = (m: Machine, url: string, r: Remote) =>
    appendFileSync(
      join(m.root, "gitconfig"),
      `[url "${r.url.replace(/\\/g, "/")}"]\n\tinsteadOf = ${url}\n`,
    );

  /** A team repository whose main branch links `tool` and whose dev branch, in team/, links `extra`. */
  function teamRepo(m: Machine) {
    const vendor = remote(m, "vendor", skills("skills/", "tool", "extra"));
    const manifest = (skill: string) =>
      JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, include: [skill] }],
      });
    const team = remote(m, "team", { ".fleetrc/manifest.json": manifest("tool") });
    m.git(team.work, "checkout", "--quiet", "-b", "dev");
    writeFiles(team.work, { "team/fleet.json": manifest("extra") });
    m.git(team.work, "add", "-A");
    m.git(team.work, "commit", "--quiet", "-m", "dev");
    m.git(team.work, "push", "--quiet", "origin", "dev");
    return team;
  }
  const configured = (m: Machine) =>
    (JSON.parse(read(m.at(".config/fleetrc/config.json"))) as { manifest: string }).manifest;

  it("D2. a GitHub page link without .git is a repository holding .fleetrc/manifest.json", async () => {
    const m = machine();
    hostAt(m, "https://github.com/org/team", teamRepo(m));
    const init = await m.run("init", "https://github.com/org/team", "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    expect(configured(m)).toBe("https://github.com/org/team//.fleetrc/manifest.json");
    expect((await m.json("sync")).ok).toBe(true);
  });

  it("D2. a GitHub blob link names the branch and the file", async () => {
    const m = machine();
    hostAt(m, "https://github.com/org/team", teamRepo(m));
    const link = "https://github.com/org/team/blob/dev/team/fleet.json";
    const init = await m.run("init", link, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["extra"]);
    expect(configured(m)).toBe(link);
    expect((await m.json("sync")).skills.names).toEqual(["extra"]);
  });

  it("D2. a bare repository on this machine is a repository, not a folder", async () => {
    const m = machine();
    const team = teamRepo(m);
    const init = await m.run("init", team.url, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    expect(configured(m)).toBe(`${team.url}//.fleetrc/manifest.json`);
    expect((await m.json("sync")).ok).toBe(true);
  });
});

describe("hooks", () => {
  it("D6. a vendored git source reports changed paths from the root of its repository", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const hook = changedLog(m);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      hooks: [
        { name: "repo", run: hook.run, on: ["vendor:skills/**"] },
        { name: "skill-relative", run: hook.run, on: ["vendor:tool/**"] },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(hook.runs()).toEqual([["vendor:skills/tool/SKILL.md"]]);
    expect(init.stdout).toContain(
      'hook skill-relative: "vendor:tool/**" matches no file in vendor, so it never runs; paths start at the root of the source, as in skills/tool/SKILL.md',
    );

    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    expect(report.hooks.map((run) => [run.name, run.matched])).toEqual([
      ["repo", ["vendor:skills/tool/SKILL.md"]],
    ]);
    expect(hook.runs()).toHaveLength(2);
    expect(
      report.warnings.filter((warning) => warning.startsWith("hook skill-relative:")),
    ).toHaveLength(1);
  });

  it("D6. a pattern that names no source is reported", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      hooks: [{ name: "typo", run: "exit 0", on: ["vendr:**"] }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect((await m.json("sync")).warnings).toContain(
      'hook typo: "vendr:**" names no source "vendr"',
    );
  });
});

describe("a sync of one source", () => {
  it("MAC7. update <source> keeps another source's held state in last-run.json and status", async () => {
    const m = machine({ scheduler: "empty" });
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*" },
        { id: "vendor", git: vendor.url, update: "review" },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFiles(work, { "local.md": "local\n" });
    m.git(work, "add", "-A");
    m.git(work, "commit", "--quiet", "-m", "local");
    personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "upstream") });
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const full = await m.json("sync");
    expect(full.held.map((held) => held.source)).toEqual(["personal"]);

    for (const args of [
      ["sync", "vendor"],
      ["update", "vendor"],
    ]) {
      const run = await m.run(...args);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      const last = JSON.parse(read(join(m.stateDir, "last-run.json"))) as typeof full;
      expect(last.held).toEqual(full.held);
      expect(last.sources.find((source) => source.id === "personal")?.status).toBe("held");
      expect((await m.run("status")).stdout).toContain("held personal: 1 local commit not on");
    }
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
  });
});
