// Round three of trying to break fleetrc, against the integration branch that fixed round two.
// Each test asserts what fleetrc should do; a failing test is a break still open. Every run uses
// the fixture's temporary HOME, and every scheduler call goes to the fixture's fake.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { applyPlan, type InitPlan } from "../src/init.ts";
import { timerNode } from "../src/timer.ts";
import {
  clone,
  isWindows,
  machine,
  type Machine,
  names,
  read,
  remote,
  skillMd,
  skills,
} from "./fixture.ts";

/** A vendored source `vendor` with the skills `tool` and `extra`, synced into Claude Code's folder. */
async function vendored(m: Machine, ...extra: string[]) {
  const vendor = remote(m, "vendor", skills("skills/", "tool", ...extra));
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
  });
  const init = await m.run("init", manifest, "--no-hooks");
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return { vendor, manifest, store: join(m.stateDir, "store", "vendor") };
}

/** Commits a symlink `path -> target` to a remote's working copy and pushes it. */
function commitLink(m: Machine, work: string, path: string, target: string) {
  mkdirSync(join(work, path, ".."), { recursive: true });
  symlinkSync(target, join(work, path));
  m.git(work, "add", "-A");
  m.git(work, "commit", "--quiet", "-m", `link ${path}`);
  m.git(work, "push", "--quiet", "origin", "main");
}

describe("linked skill folders", () => {
  it.skipIf(isWindows)(
    "R5-1. copy mode copies a working clone's linked skill folder as files, not as a link with the clone's relative target",
    async () => {
      const m = machine();
      const r = remote(m, "personal", {
        ...skills("shared/", "tool"),
        ...skills("skills/", "plain"),
      });
      commitLink(m, r.work, "skills/tool", "../shared/tool");
      const work = clone(m, r, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "personal", git: r.url, path: work, skills: "skills/*" }],
      });
      const init = await m.run("init", manifest, "--no-hooks", "--copy");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      const copy = m.at(".claude/skills/tool");
      // A copy is a folder; a link `../shared/tool` in ~/.claude/skills points at nothing.
      expect(lstatSync(copy).isDirectory()).toBe(true);
      expect(read(join(copy, "SKILL.md"))).toBe(skillMd("tool"));
    },
  );

  it.skipIf(isWindows)(
    "R5-2. copy mode copies what a link inside a working clone's skill points to in the clone, so the copy reads it",
    async () => {
      const m = machine();
      const r = remote(m, "personal", {
        ...skills("skills/", "tool"),
        "shared/refs/guide.md": "the guide\n",
      });
      // skills/tool/refs -> ../../shared/refs: inside the repository, beside the skill.
      commitLink(m, r.work, "skills/tool/refs", "../../shared/refs");
      const work = clone(m, r, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "personal", git: r.url, path: work, skills: "skills/*" }],
      });
      const init = await m.run("init", manifest, "--no-hooks", "--copy");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      // Linked, Claude Code reads the guide through the clone; copied, the link must still lead to it.
      expect(read(join(work, "skills/tool/refs/guide.md"))).toBe("the guide\n");
      expect(read(m.at(".claude/skills/tool/refs/guide.md"))).toBe("the guide\n");
      // What the copy holds is what the next copy would hold, so it is not copied again.
      const again = await m.json("sync", "--copy");
      expect(again.targets.flatMap((target) => target.created)).toEqual([]);
      expect(again.targets.flatMap((target) => target.warnings)).toEqual([]);
    },
  );

  it.skipIf(isWindows)(
    "R5-2. copy mode leaves out, with a warning, a link in a working clone's skill that leads out of the clone",
    async () => {
      const m = machine();
      const r = remote(m, "personal", skills("skills/", "tool"));
      mkdirSync(m.at("private"), { recursive: true });
      writeFileSync(m.at("private/notes.md"), "not for the copy\n");
      commitLink(m, r.work, "skills/tool/notes", m.at("private"));
      const work = clone(m, r, "code/skills");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "personal", git: r.url, path: work, skills: "skills/*" }],
      });
      expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
      const copied = await m.json("sync", "--copy");
      expect(copied.errors).toEqual([]);
      expect(copied.targets.flatMap((target) => target.warnings).join("\n")).toMatch(
        /notes links to a place outside the source, so the copy in ~\/\.claude\/skills\/tool leaves it out/,
      );
      expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
      expect(existsSync(m.at(".claude/skills/tool/notes"))).toBe(false);
    },
  );

  for (const kind of ["vendored", "working clone"] as const)
    it.skipIf(isWindows)(
      `R5-3. a ${kind} whose skills glob finds only linked skill folders links them`,
      async () => {
        const m = machine();
        const r = remote(m, "personal", skills("shared/", "tool"));
        commitLink(m, r.work, "skills/tool", "../shared/tool");
        const source =
          kind === "vendored"
            ? { id: "personal", git: r.url, skills: "skills/*" }
            : { id: "personal", git: r.url, path: clone(m, r, "code/skills"), skills: "skills/*" };
        m.manifest({ agents: ["claude-code"], sources: [source] });
        await m.run("init", join(m.root, "manifest", ".fleetrc", "manifest.json"), "--no-hooks");
        const report = await m.json("sync");
        expect(report.errors).toEqual([]);
        expect(report.skills.names).toEqual(["tool"]);
      },
    );
});

describe("the crash-safe store", () => {
  it.skipIf(isWindows)(
    "R5-4. a staging folder a killed sync left is swept even when its pid now belongs to another process",
    async () => {
      const m = machine();
      const { vendor, store } = await vendored(m);
      // After a reboot the killed sync's pid is some daemon's; pid 1 always runs.
      const stale = join(store, ".stage-1");
      mkdirSync(join(stale, "tool"), { recursive: true });
      writeFileSync(join(stale, "tool", "SKILL.md"), "half a copy");
      vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
      expect((await m.run("sync")).code).toBe(0);
      // The sync holds the lock, so no other sync can be using it.
      expect(existsSync(stale)).toBe(false);
    },
  );

  it.skipIf(isWindows)(
    "R5-5. a skill copy a killed sync moved aside goes back, even when its pid now belongs to another process",
    async () => {
      const m = machine();
      const { store } = await vendored(m);
      const live = join(store, "live");
      // Killed between moving the old copy aside and renaming the new one in.
      renameSync(join(live, "tool"), join(live, ".tool.1.old"));
      const report = await m.json("sync");
      expect(report.errors).toEqual([]);
      expect(readdirSync(live)).toEqual(["tool"]);
    },
  );

  it("R5-6. an edited copy a sync killed mid-rename left under its temporary name is not lost", async () => {
    const m = machine();
    const { vendor, store } = await vendored(m);
    const live = join(store, "live");
    writeFileSync(join(live, "tool", "SKILL.md"), skillMd("tool", "my edit"));
    vendor.commit({ "skills/tool": null, ...skills("skills/", "Tool") });
    // Killed after renameFolder moved live/tool to its third name and before it renamed it to Tool.
    renameSync(join(live, "tool"), join(live, "tool.2147483.rename"));
    const report = await m.json("sync");
    const linked = report.skills.names.find((name) => name.toLowerCase() === "tool");
    expect(linked).toBeDefined();
    expect(read(m.at(".claude/skills", linked!, "SKILL.md"))).toBe(skillMd("tool", "my edit"));
    expect(readdirSync(live).filter((name) => name.includes(".rename"))).toEqual([]);
  });

  it("R5-6. an agent folder's link a sync killed mid-rename left under its temporary name goes back", async () => {
    const m = machine();
    const { vendor } = await vendored(m);
    vendor.commit({ "skills/tool": null, ...skills("skills/", "Tool") });
    const agent = m.at(".claude/skills");
    // Killed after the link step moved tool to its third name, before it named it Tool.
    renameSync(join(agent, "tool"), join(agent, "tool.2147483.rename"));
    const report = await m.json("sync");
    expect(report.errors).toEqual([]);
    expect(names(agent)).toEqual(["Tool"]);
  });
});

describe("agent folders that link to one another", () => {
  /** Replaces the agent folder `dir` in HOME with a link to `to`. */
  const relink = (m: Machine, dir: string, to: string) => {
    rmSync(m.at(dir), { recursive: true, force: true });
    mkdirSync(join(m.at(dir), ".."), { recursive: true });
    symlinkSync(to, m.at(dir));
  };

  for (const shape of ["a broken link", "a link loop", "a link to a dotfiles folder"] as const)
    it.skipIf(isWindows)(
      `R5-7. doctor does not say agent folders agree when one became ${shape} that sync skips`,
      async () => {
        const m = machine({ scheduler: "empty" });
        const vendor = remote(m, "vendor", skills("skills/", "tool"));
        const manifest = m.manifest({
          agents: ["claude-code", "codex"],
          sources: [{ id: "vendor", git: vendor.url }],
        });
        expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
        if (shape === "a broken link") relink(m, ".claude/skills", m.at("missing/skills"));
        else if (shape === "a link loop") {
          relink(m, ".claude/skills", m.at(".agents/skills"));
          relink(m, ".agents/skills", m.at(".claude/skills"));
        } else {
          mkdirSync(m.at("dotfiles/skills"), { recursive: true });
          relink(m, ".claude/skills", m.at("dotfiles/skills"));
        }
        const sync = await m.run("sync");
        // sync links nothing into that folder and says to run init.
        expect(sync.stdout).toMatch(/skipped ~\/\.claude\/skills is a link/);
        const doctor = await m.run("doctor");
        // Claude Code shows no skill, so the agents do not agree.
        expect(doctor.stdout).not.toMatch(/^ok\s+agents agree/m);
      },
    );
});

describe("links pasted from a browser", () => {
  /** What `add --dry-run` would write for `link`. */
  async function adder() {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    return async (link: string) =>
      (await m.json<{ added: object }>("add", link, "--dry-run")).added;
  }

  it("R5-8. add drops the query, anchor and trailing slash of a GitHub or GitLab repository link", async () => {
    const added = await adder();
    // GitHub's repository page is .../r?tab=readme-ov-file; a README heading link ends in #usage.
    for (const link of [
      "https://github.com/o/r?tab=readme-ov-file",
      "https://github.com/o/r#usage",
      "https://github.com/o/r/",
    ])
      expect(await added(link), link).toEqual({ id: "r", git: "https://github.com/o/r" });
    expect(await added("https://gitlab.com/g/r?ref_type=heads")).toEqual({
      id: "r",
      git: "https://gitlab.com/g/r",
    });
    expect(await added("https://git.example.com/team/r.git/")).toEqual({
      id: "r",
      git: "https://git.example.com/team/r.git",
    });
  });

  it("R5-9. add decodes a folder link's percent-encoded path, as the browser's address bar shows it", async () => {
    const added = await adder();
    expect(await added("https://github.com/o/r/tree/main/my%20skills")).toEqual({
      id: "r",
      git: "https://github.com/o/r",
      ref: "main",
      skills: "my skills/**",
    });
    expect(await added("https://github.com/o/r/blob/main/skills/caf%C3%A9/SKILL.md")).toEqual({
      id: "r",
      git: "https://github.com/o/r",
      ref: "main",
      skills: "skills/café",
    });
  });
});

describe("the timer's own record of its node", () => {
  it.runIf(process.platform === "linux")(
    "R5-10. doctor and self-install read the timer's node from a unit whose state path systemd had to escape",
    () => {
      // A home folder with % in its name, which systemd writes as %% in ExecStart.
      const root = mkdtempSync(join(tmpdir(), "fleetrc-r5-50%off-"));
      const saved = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
      process.env.XDG_STATE_HOME = join(root, "state");
      process.env.XDG_CONFIG_HOME = join(root, "config");
      try {
        const cli = join(
          root,
          "state",
          "fleetrc",
          "app",
          "node_modules",
          "fleetrc",
          "dist",
          "cli.mjs",
        );
        mkdirSync(join(root, "config", "systemd", "user"), { recursive: true });
        // As @vite-hub/schedule writes it: % doubled, and the argument quoted.
        writeFileSync(
          join(root, "config", "systemd", "user", "fleetrc-sync.service"),
          `[Service]\nType=oneshot\nExecStart=/opt/node/bin/node "${cli.replaceAll("%", "%%")}" sync\n`,
        );
        expect(timerNode()?.node).toBe("/opt/node/bin/node");
      } finally {
        process.env.XDG_STATE_HOME = saved.state;
        process.env.XDG_CONFIG_HOME = saved.config;
        if (saved.state === undefined) delete process.env.XDG_STATE_HOME;
        if (saved.config === undefined) delete process.env.XDG_CONFIG_HOME;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("a state.json of another shape", () => {
  for (const [shape, record] of [
    ["without pending", { kind: "git", skills: { tool: { hashes: {} } } }],
    [
      "with hashes that are no object",
      { kind: "git", skills: { tool: { hashes: "x" } }, pending: {} },
    ],
    ["with a pending update of another shape", { kind: "git", skills: {}, pending: { tool: 1 } }],
  ] as const)
    it(`R5-11. a source record ${shape} never unlinks the skill`, async () => {
      const m = machine();
      const { vendor } = await vendored(m);
      // Top-level shape as this version writes it; the source record is one an older build wrote.
      writeFileSync(
        join(m.stateDir, "state.json"),
        JSON.stringify({ version: 1, sources: { vendor: record }, skills: {} }),
      );
      vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
      const report = await m.json("sync");
      expect(report.errors).toEqual([]);
      expect(report.skills.removed).toEqual([]);
      // A record of no files would make every file an edit; one that can't be read is rebuilt.
      if (shape !== "without pending") expect(report.edited).toEqual([]);
      expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    });
});

describe("init clones an adopt source before adopting", () => {
  it("R5-12. a hand-made skill named like one the clone already has is neither lost nor half-adopted", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "tool"));
    mkdirSync(m.at(".claude/skills/tool"), { recursive: true });
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), skillMd("tool", "hand-made"));
    mkdirSync(m.at(".claude/skills/mine"), { recursive: true });
    writeFileSync(m.at(".claude/skills/mine/SKILL.md"), skillMd("mine"));
    const work = m.at("code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    const all = init.stdout + init.stderr;
    expect(init.code, all).toBe(0);
    // The clone's own tool is as upstream has it.
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(skillMd("tool"));
    expect(read(join(work, "skills/mine/SKILL.md"))).toBe(skillMd("mine"));
    // The hand-made tool is kept somewhere the output names.
    const backup = join(m.stateDir, "backup");
    const kept = existsSync(m.at(".claude/skills/tool/SKILL.md"))
      ? read(m.at(".claude/skills/tool/SKILL.md"))
      : "";
    const backedUp = existsSync(backup)
      ? JSON.stringify(readdirSync(backup, { recursive: true }))
      : "";
    expect(kept === skillMd("tool", "hand-made") || backedUp.includes("tool"), all).toBe(true);
  });

  it("R5-12. init moves nothing when one of its moves would fail", () => {
    const root = mkdtempSync(join(tmpdir(), "fleetrc-r5-12-"));
    try {
      const at = (...parts: string[]) => join(root, ...parts);
      for (const name of ["a", "b"]) mkdirSync(at("agent", name), { recursive: true });
      // b's name was taken after init planned to adopt it.
      mkdirSync(at("clone", "b"), { recursive: true });
      writeFileSync(at("clone", "b", "SKILL.md"), skillMd("b"));
      const plan = {
        migrations: [
          { kind: "adopt", path: at("agent", "a"), to: at("clone", "a") },
          { kind: "adopt", path: at("agent", "b"), to: at("clone", "b") },
        ],
      } as unknown as InitPlan;
      expect(() => applyPlan(plan)).toThrow(/init changed nothing: .*clone[\\/]b exists/);
      expect(readdirSync(at("agent")).sort()).toEqual(["a", "b"]);
      expect(readdirSync(at("clone"))).toEqual(["b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("names typed in another case or Unicode form", () => {
  it("R5-13. diff refuses a typed name that matches skills of two sources only by case, instead of picking one", async () => {
    const m = machine();
    const a = remote(m, "a", skills("skills/", "foo"));
    const b = remote(m, "b", skills("skills/", "bar"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "a", git: a.url, skills: "skills/*" },
        { id: "b", git: b.url, skills: "skills/*", update: "review" },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // b brings a new Foo, held for review; a's foo is linked.
    b.commit({ "skills/Foo/SKILL.md": skillMd("Foo", "from b") });
    const report = await m.json("sync");
    expect(report.pending.map((entry) => `${entry.source}/${entry.skill}`)).toEqual(["b/Foo"]);
    // Typed exactly, each finds its own.
    expect((await m.run("diff", "Foo")).stdout).toContain("from b");
    // FOO could be either: say so rather than show a's foo as if it were the one meant.
    const typed = await m.run("diff", "FOO");
    expect(typed.code).not.toBe(0);
    expect(typed.stderr).toMatch(/foo/);
    expect(typed.stderr).toMatch(/Foo/);
  });
});
