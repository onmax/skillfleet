import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { clone, isWindows, machine, names, read, remote, skillMd, skills } from "./fixture.ts";

describe("review regression cases", () => {
  it.each([false, true])("remote fork keeps agents available (copy=%s)", async (copy) => {
    const m = machine();
    const mine = remote(m, "mine", skills("skills/", "mine"));
    const work = clone(m, mine, "code/mine");
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    mine.commit({
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code", "codex"],
        sources: [
          { id: "mine", git: mine.url, path: work, skills: "skills/*", adopt: true },
          { id: "vendor", git: vendor.url },
        ],
      }),
    });
    m.git(work, "pull", "--quiet");
    const init = await m.run(
      "init",
      `${mine.url}//.fleetrc/manifest.json`,
      "--no-hooks",
      ...(copy ? ["--copy"] : []),
    );
    expect(init.code, init.stderr).toBe(0);
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stderr).toBe(0);
    for (const dir of [".claude/skills", ".agents/skills"])
      expect(read(m.at(`${dir}/tool/SKILL.md`))).toBe(skillMd("tool"));
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(skillMd("tool"));
  });

  it.each([false, true])(
    "init preserves colliding upstream and handmade skills (earlier adoption=%s)",
    async (earlier) => {
      const m = machine();
      const mine = remote(m, "mine", skills("skills/", "ztool"));
      const team = remote(m, "team", {
        ".fleetrc/manifest.json": JSON.stringify({
          agents: ["claude-code"],
          sources: [
            { id: "mine", git: mine.url, path: "~/code/mine", skills: "skills/*", adopt: true },
          ],
        }),
      });
      for (const name of earlier ? ["atool", "ztool"] : ["ztool"]) {
        mkdirSync(m.at(`.claude/skills/${name}`), { recursive: true });
        writeFileSync(m.at(`.claude/skills/${name}/SKILL.md`), skillMd(name, "handmade"));
      }
      const init = await m.run("init", team.url, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(read(m.at(".claude/skills/ztool/SKILL.md"))).toBe(skillMd("ztool"));
      const backup = join(m.stateDir, "backup");
      const saved = readdirSync(backup, { recursive: true })
        .map(String)
        .find((p) => p.endsWith(join("ztool", "SKILL.md")));
      expect(saved).toBeDefined();
      expect(read(join(backup, saved!))).toBe(skillMd("ztool", "handmade"));
      if (earlier)
        expect(read(m.at("code/mine/skills/atool/SKILL.md"))).toBe(skillMd("atool", "handmade"));
    },
  );

  it("keeps a hand-made skill when the cloned destination is not a replacement", async () => {
    const m = machine();
    const mine = remote(m, "mine", {
      "skills/tool/README.md": "Not a skill",
      "skills/other/SKILL.md": skillMd("other"),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "mine", git: mine.url, path: "~/code/mine", skills: "skills/*", adopt: true },
      ],
    });
    mkdirSync(m.at(".claude/skills/tool"), { recursive: true });
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), skillMd("tool", "handmade"));
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "handmade"));
    expect(read(m.at(".claude/skills/other/SKILL.md"))).toBe(skillMd("other"));
    expect(init.stdout).toContain("adoption blocked");
    expect(read(m.at("code/mine/skills/tool/README.md"))).toBe("Not a skill");
  });

  it.skipIf(isWindows).each(["local", "clone", "git"])(
    "discovers linked-only %s collections",
    async (kind) => {
      const m = machine();
      const vendor = remote(m, "vendor", { "shared/tool/SKILL.md": skillMd("tool") });
      mkdirSync(join(vendor.work, "skills"));
      symlinkSync("../shared/tool", join(vendor.work, "skills/tool"));
      m.git(vendor.work, "add", "-A");
      m.git(vendor.work, "commit", "--quiet", "-m", "linked collection");
      m.git(vendor.work, "push", "--quiet", "origin", "main");
      const source =
        kind === "local"
          ? { local: vendor.work }
          : { git: vendor.url, ...(kind === "clone" ? { path: "~/code/vendor" } : {}) };
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", ...source, skills: "skills/*" }],
      });
      const init = await m.run("init", manifest, "--no-hooks");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    },
  );

  it.skipIf(isWindows || process.getuid?.() === 0)(
    "isolates an unreadable target record",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code", "codex"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
      const record = m.at(".claude/skills/.fleetrc-manifest.json");
      chmodSync(record, 0);
      try {
        vendor.commit({ "skills/newtool/SKILL.md": skillMd("newtool") });
        const run = await m.run("sync");
        expect(run.code).toBe(1);
        expect(existsSync(m.at(".agents/skills/newtool/SKILL.md"))).toBe(true);
        expect(JSON.parse(read(join(m.stateDir, "last-run.json"))).errors.join("\n")).toContain(
          ".claude",
        );
      } finally {
        chmodSync(record, 0o600);
      }
    },
  );

  it("finishes metadata after the new cache tree was published", async () => {
    const m = machine();
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    expect((await m.run("init", team.url, "--no-hooks")).code).toBe(0);
    const cache = join(m.stateDir, "cache/manifests");
    const marker = readdirSync(cache).find((n) => n.endsWith(".json"))!;
    const key = marker.slice(0, -5);
    const oldMarker = read(join(cache, marker));
    renameSync(join(cache, key), join(cache, `${key}.424242.old`));
    team.commit({
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [],
        fleet: ["new-host"],
      }),
    });
    expect((await m.run("sync")).code).toBe(0);
    const newMarker = read(join(cache, marker));
    writeFileSync(join(cache, `${key}.424242.pending`), newMarker);
    writeFileSync(join(cache, marker), oldMarker);
    const offline = await m.run("sync", "--offline");
    expect(offline.code, offline.stderr).toBe(0);
    expect(read(join(cache, marker))).toBe(newMarker);
    expect(JSON.parse(read(join(cache, key, ".fleetrc", "manifest.json"))).fleet).toEqual([
      "new-host",
    ]);
    expect(existsSync(join(cache, `${key}.424242.pending`))).toBe(false);
  });
});
