import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_DIRS,
  clone,
  http,
  isLink,
  isWindows,
  linkOf,
  machine,
  names,
  read,
  remote,
  serveIndexV2,
  skillMd,
  skills,
  UNIVERSAL_DIRS,
} from "./fixture.ts";

/** A personal working clone, a vendored git repository and a well-known index. */
async function threeSources() {
  const m = machine();
  const personal = remote(m, "personal", {
    ...skills("skills/", "alpha", "beta"),
    "README.md": "personal\n",
  });
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", skills("skills/", "gamma", "delta"));
  const site = await http();
  serveIndexV2(site, [
    { name: "epsilon", files: { "SKILL.md": skillMd("epsilon"), "notes.md": "notes\n" } },
  ]);
  const manifest = m.manifest({
    agents: "all",
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: vendor.url },
      { id: "site", index: site.url },
    ],
  });
  return { m, personal, work, vendor, site, manifest };
}

describe("sync", () => {
  it("1. links skills from three sources into every agent folder, with the same names everywhere", async () => {
    const { m, work, manifest } = await threeSources();
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stderr + init.stdout).toBe(0);
    const expected = ["alpha", "beta", "delta", "epsilon", "gamma"];
    for (const dir of AGENT_DIRS) {
      expect(names(m.at(dir)), dir).toEqual(expected);
      for (const name of expected) expect(isLink(m.at(dir, name)), `${dir}/${name}`).toBe(true);
    }
    // Personal skills link into the working clone, so an edit through an agent folder edits the clone.
    expect(linkOf(m.at(".claude/skills/alpha"))).toBe(join(work, "skills", "alpha"));
    expect(read(m.at(".agents/skills/epsilon/notes.md"))).toBe("notes\n");
    for (const dir of UNIVERSAL_DIRS) expect(names(m.at(dir)), dir).toEqual([]);
    expect(read(m.at(".agents/skills/gamma/SKILL.md"))).toBe(skillMd("gamma"));
    // Codex reads ~/.agents/skills; fleetrc never writes its deprecated folder.
    expect(existsSync(m.at(".codex/skills"))).toBe(false);

    const again = await m.json("sync");
    expect(again.ok).toBe(true);
    expect(again.skills.total).toBe(5);
    expect(again.skills.added).toEqual([]);
    expect(again.sources.map((source) => source.status)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });

  it("1b. links a skill in a working clone whose frontmatter is not valid YAML, with a warning", async () => {
    const m = machine();
    // Claude Code loads this SKILL.md; YAML parsers reject the unquoted ": " in the description.
    const loose =
      "---\nname: dev\ndescription: Use on Slimbook: starting it, or sharing it.\n---\nbody\n";
    const personal = remote(m, "personal", {
      ...skills("skills/", "strict"),
      "skills/dev/SKILL.md": loose,
    });
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.stdout).toContain("none lost");
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["dev", "strict"]);
    expect(linkOf(m.at(".claude/skills/dev"))).toBe(join(work, "skills/dev"));
    const report = await m.json("sync");
    expect(report.warnings).toContain(
      "personal: skills/dev/SKILL.md frontmatter is not valid YAML; linked anyway, but tools that parse it strictly skip dev",
    );
  });

  it("2. fast-forwards a dirty working clone when upstream touches other files, keeping local edits byte for byte", async () => {
    const { m, personal, work, manifest } = await threeSources();
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const edited = `${skillMd("alpha")}\nlocal edit\r\nwith CRLF\n`;
    writeFileSync(join(work, "skills/alpha/SKILL.md"), edited);
    writeFileSync(join(work, "skills/alpha/draft.md"), "untracked draft\n");
    const head = personal.commit({
      "skills/beta/SKILL.md": skillMd("beta", "upstream change"),
      "skills/zeta/SKILL.md": skillMd("zeta"),
    });

    const report = await m.json("sync");
    expect(report.ok).toBe(true);
    const source = report.sources.find((entry) => entry.id === "personal")!;
    expect(source.status).toBe("updated");
    expect(source.to).toBe(head);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(head);
    expect(read(join(work, "skills/alpha/SKILL.md"))).toBe(edited);
    expect(read(join(work, "skills/alpha/draft.md"))).toBe("untracked draft\n");
    expect(read(m.at(".claude/skills/beta/SKILL.md"))).toBe(skillMd("beta", "upstream change"));
    expect(report.skills.added).toEqual(["zeta"]);
    for (const dir of AGENT_DIRS) expect(names(m.at(dir))).toContain("zeta");
  });

  it("3. holds a working clone when upstream changes a file with local edits, and touches nothing", async () => {
    const { m, personal, work, manifest } = await threeSources();
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const before = m.git(work, "rev-parse", "HEAD");
    const edited = `${skillMd("alpha")}\nmine\n`;
    writeFileSync(join(work, "skills/alpha/SKILL.md"), edited);
    personal.commit({ "skills/alpha/SKILL.md": skillMd("alpha", "theirs") });

    const result = await m.run("sync");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "held personal: local edits touch files that changed upstream: skills/alpha/SKILL.md",
    );
    const report = await m.json("sync");
    expect(report.held).toEqual([
      {
        source: "personal",
        reason: "local edits touch files that changed upstream",
        files: ["skills/alpha/SKILL.md"],
      },
    ]);
    expect(m.git(work, "rev-parse", "HEAD")).toBe(before);
    expect(read(join(work, "skills/alpha/SKILL.md"))).toBe(edited);
    expect(m.git(work, "status", "--porcelain")).toBe("M skills/alpha/SKILL.md");
  });

  it("5. applies precedence, include and exclude, and prints one shadowed line per clash", async () => {
    const m = machine();
    const mine = remote(m, "mine", skills("skills/", "shared", "own"));
    const work = clone(m, mine, "code/skills");
    const team = remote(m, "team", skills("skills/", "shared", "picked", "skipped", "dropped"));
    const other = remote(m, "other", skills("", "shared", "solo", "unwanted"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "mine", git: mine.url, path: work, skills: "skills/*" },
        {
          id: "team",
          git: team.url,
          include: ["shared", "picked", "dropped"],
          exclude: ["dropped"],
        },
        { id: "other", git: other.url, exclude: ["unwanted"] },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["own", "picked", "shared", "solo"]);
    expect(linkOf(m.at(".claude/skills/shared"))).toBe(join(work, "skills/shared"));
    const output = (await m.run("sync")).stdout;
    expect(output.match(/shadowed:.*/g)).toEqual([
      "shadowed: shared from team (mine wins)",
      "shadowed: shared from other (mine wins)",
    ]);
    const report = await m.json("sync");
    expect(report.shadowed).toEqual([
      { skill: "shared", winner: "mine", loser: "team" },
      { skill: "shared", winner: "mine", loser: "other" },
    ]);
  });

  it("8. prunes only the links fleetrc made; hand-made folders and foreign links stay", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "keep", "drop"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // A folder made by hand, and links fleetrc did not make, one of them under a name the manifest provides.
    mkdirSync(m.at(".claude/skills/handmade"));
    writeFileSync(m.at(".claude/skills/handmade/SKILL.md"), skillMd("handmade"));
    const elsewhere = join(m.root, "elsewhere");
    mkdirSync(join(elsewhere, "foreign"), { recursive: true });
    writeFileSync(join(elsewhere, "foreign/SKILL.md"), skillMd("foreign"));
    symlinkSync(
      join(elsewhere, "foreign"),
      m.at(".claude/skills/foreign"),
      isWindows ? "junction" : "dir",
    );
    const before = linkOf(m.at(".cursor/skills/keep"));

    const removed = await m.run("remove", "drop");
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    for (const dir of [".claude/skills", ".cursor/skills"])
      expect(names(m.at(dir)).includes("drop"), dir).toBe(false);
    expect(names(m.at(".claude/skills"))).toEqual(["foreign", "handmade", "keep"]);
    expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
    expect(linkOf(m.at(".claude/skills/foreign"))).toBe(join(elsewhere, "foreign"));
    expect(linkOf(m.at(".cursor/skills/keep"))).toBe(before);
    expect(JSON.parse(read(manifest)).sources[0].exclude).toEqual(["drop"]);

    // A hand-made folder under a name a source provides is left alone, with a warning.
    vendor.commit({ "skills/handmade/SKILL.md": skillMd("handmade", "upstream") });
    const report = await m.json("sync");
    expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe(skillMd("handmade"));
    expect(
      report.targets.find((target) => target.dir.endsWith(join(".claude", "skills")))!.foreign,
    ).toEqual(["handmade"]);
    expect(isLink(m.at(".cursor/skills/handmade"))).toBe(true);
  });

  it("10. an extended team manifest adds sources but cannot add hooks, a fleet or a hub", async () => {
    const m = machine();
    const team = remote(m, "team", skills("skills/", "team-skill"));
    const marker = join(m.root, "hook-ran");
    const teamManifest = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(
      teamManifest,
      JSON.stringify({
        sources: [{ id: "team", git: team.https }],
        hooks: [
          {
            name: "evil",
            run: `node -e "require('fs').writeFileSync(process.argv[1], 'x')" "${marker}"`,
            on: ["*:**"],
          },
        ],
        fleet: ["attacker.example"],
        hub: "http://127.0.0.1:9/hub",
      }),
    );
    const manifest = m.manifest({
      extends: [teamManifest, join(m.root, "missing.json")],
      agents: ["claude-code"],
      sources: [],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["team-skill"]);
    const report = await m.json("sync");
    expect(report.hooks).toEqual([]);
    expect(report.warnings.some((warning) => warning.includes("ignored hooks, fleet, hub"))).toBe(
      true,
    );
    // A team manifest that cannot be read is a warning, not a failed sync.
    expect(
      report.warnings.some((warning) => warning.includes("missing.json: no such manifest")),
    ).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const fleet = await m.run("fleet", "status");
    expect(fleet.code).toBe(2);
    expect(fleet.stderr).toContain("the manifest has no fleet");
  });

  it("11. a review-mode source fetches and shows a diff, and applies only on update", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "watched"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(read(m.at(".claude/skills/watched/SKILL.md"))).toBe(skillMd("watched"));
    vendor.commit({
      "skills/watched/SKILL.md": skillMd("watched", "new upstream text"),
      "skills/fresh/SKILL.md": skillMd("fresh"),
    });

    const report = await m.json("sync");
    expect(report.sources[0]!.status).toBe("review");
    expect(report.pending.map((entry) => [entry.skill, entry.reason])).toEqual([
      ["fresh", "review"],
      ["watched", "review"],
    ]);
    expect(read(m.at(".claude/skills/watched/SKILL.md"))).toBe(skillMd("watched"));
    expect(names(m.at(".claude/skills"))).toEqual(["watched"]);
    expect((await m.run("sync")).stdout).toContain("review vendor: updates for fresh, watched");
    const diff = await m.run("diff", "watched");
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("-watched body");
    expect(diff.stdout).toContain("+new upstream text");
    expect((await m.run("diff", "fresh")).stdout).toContain("+name: fresh");

    const update = await m.json("update", "vendor");
    expect(update.ok).toBe(true);
    expect(update.pending).toEqual([]);
    expect(read(m.at(".claude/skills/watched/SKILL.md"))).toBe(
      skillMd("watched", "new upstream text"),
    );
    expect(names(m.at(".claude/skills"))).toEqual(["fresh", "watched"]);
  });

  it("13. runs a hook only when files matching its globs changed, and keeps its output in the report", async () => {
    const m = machine();
    const personal = remote(m, "personal", {
      ...skills("skills/", "alpha"),
      "pstack/install.mjs": "// v1\n",
    });
    const work = clone(m, personal, "code/skills");
    const log = join(m.root, "hook-log.jsonl");
    const script = join(m.root, "hook.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ changed: process.env.FLEETRC_CHANGED, skills: report.skills.total }) + "\\n");
console.log("pstack rebuilt");`,
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
      hooks: [
        { name: "pstack", run: `"${process.execPath}" "${script}"`, on: ["personal:pstack/**"] },
      ],
    });
    const runs = () =>
      existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { changed: string })
        : [];

    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.changed).toBe("personal:pstack/install.mjs");

    expect((await m.json("sync")).hooks).toEqual([]);
    personal.commit({ "skills/alpha/SKILL.md": skillMd("alpha", "unrelated change") });
    expect((await m.json("sync")).hooks).toEqual([]);
    expect(runs()).toHaveLength(1);

    personal.commit({ "pstack/install.mjs": "// v2\n" });
    const report = await m.json("sync");
    expect(report.hooks).toEqual([
      {
        name: "pstack",
        matched: ["personal:pstack/install.mjs"],
        code: 0,
        output: "pstack rebuilt\n",
      },
    ]);
    expect(runs()).toHaveLength(2);
    expect(JSON.parse(read(join(m.stateDir, "last-run.json"))).hooks[0].output).toBe(
      "pstack rebuilt\n",
    );
  });

  it.each(["length", "work"])(
    "handles a hook glob beyond its %s limit without replaying hooks",
    async (limit) => {
      const m = machine();
      expect((await m.run("init", m.manifest({ sources: [] }), "--no-hooks")).code).toBe(0);
      const stateFile = join(m.stateDir, "state.json");
      const reportFile = join(m.stateDir, "last-run.json");
      const state = {
        ...JSON.parse(read(stateFile)),
        hooksDue: [
          "old:ready",
          ...Array.from({ length: 256 }, (_, index) => `old:${"a".repeat(512)}${index}`),
        ],
      };
      writeFileSync(stateFile, JSON.stringify(state));
      const before = [read(stateFile), read(reportFile)];
      const log = join(m.root, "hook.log");
      const script = join(m.root, "hook.mjs");
      writeFileSync(
        script,
        `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, process.env.FLEETRC_HOOK + "\\n");`,
      );
      const run = `"${process.execPath}" "${script}"`;
      m.manifest({
        sources: [],
        hooks: [
          { name: "first", run, on: ["old:ready"] },
          {
            name: "second",
            run,
            on: [`old:${limit === "length" ? "?".repeat(8193) : "*?".repeat(128) + "b"}`],
          },
        ],
      });

      const failed = await m.run("sync", "--json");
      expect(failed.code).not.toBe(0);
      if (limit === "length") {
        expect(failed.stderr + failed.stdout).toMatch(/hooks\[1\]\.on.*8192/);
        expect([read(stateFile), read(reportFile)]).toEqual(before);
        expect(existsSync(log)).toBe(false);
        return;
      }

      const report = JSON.parse(failed.stdout);
      expect(report).toMatchObject({
        ok: false,
        errors: [expect.stringMatching(/hook second: glob exceeded the matching work limit/)],
        hooks: [{ name: "first", code: 0 }],
      });
      expect(JSON.parse(read(reportFile))).toEqual(report);
      expect(JSON.parse(read(stateFile))).not.toHaveProperty("hooksDue");
      expect((await m.json("sync")).hooks).toEqual([]);
      expect(read(log)).toBe("first\n");
    },
  );

  it("names identical across agents after a sync with no agent folders but a listed agent", async () => {
    const m = machine({ agents: false });
    const vendor = remote(m, "vendor", skills("skills/", "one"));
    const manifest = m.manifest({
      agents: ["claude-code", "codex"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["one"]);
    expect(names(m.at(".agents/skills"))).toEqual(["one"]);
    expect(readdirSync(m.at(".claude/skills"))).toContain(".fleetrc-manifest.json");
  });

  it("a sync that finds nothing new upstream copies no file", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const log = join(m.root, "copies.log");
    // The number of files the sync copied, which it writes to FLEETRC_DEBUG_COPIES at exit.
    const copies = async () => {
      rmSync(log, { force: true });
      const run = await m.runWith({ env: { FLEETRC_DEBUG_COPIES: log } }, "sync");
      expect(run.code, run.stdout + run.stderr).toBe(0);
      return Number(read(log).trim());
    };
    expect(await copies()).toBe(0);
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    expect(await copies()).toBeGreaterThan(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
    expect(await copies()).toBe(0);
  });

  it.skipIf(isWindows)(
    "a working clone links a skill folder that is a link inside it, and names a submodule it does not have",
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
      // A link that leaves the repository is never followed.
      mkdirSync(join(m.root, "secret", "outside"), { recursive: true });
      writeFileSync(join(m.root, "secret", "outside", "SKILL.md"), skillMd("outside"));
      symlinkSync(join(m.root, "secret", "outside"), join(vendor.work, "skills", "outside"));
      m.git(vendor.work, "add", "-A");
      m.git(vendor.work, "commit", "--quiet", "-m", "a submodule and linked skills");
      m.git(vendor.work, "push", "--quiet", "origin", "main");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*", path: "~/src/vendor" }],
      });
      expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
      const report = await m.json<{ warnings: string[] }>("sync");
      expect(names(m.at(".claude/skills"))).toEqual(["linked", "tool"]);
      const warnings = report.warnings.join("\n");
      expect(warnings).toMatch(/skills\/subskill is a git submodule that is not checked out/);
      expect(warnings).toMatch(
        /skills\/outside links outside ~\/src\/vendor; add "followLinks": true to this source to use it/,
      );
    },
  );
});
