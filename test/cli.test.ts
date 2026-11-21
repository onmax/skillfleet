import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { cli, machine, remote, skills, version } from "./fixture.ts";

describe("fleetrc", () => {
  it("is built", () => {
    expect(existsSync(cli), `${cli} is missing, run pnpm build`).toBe(true);
  });

  it("--version prints the version", async () => {
    const { code, stdout } = await machine().run("--version");
    expect(code).toBe(0);
    expect(stdout).toBe(`${version}\n`);
  });

  it("--help lists every command", async () => {
    const { stdout } = await machine().run("--help");
    for (const command of [
      "sync",
      "init",
      "status",
      "list",
      "doctor",
      "add",
      "remove",
      "adopt",
      "fork",
      "diff",
      "merge",
      "update",
      "timer",
      "fleet",
      "hook install|remove [agent]",
    ])
      expect(stdout).toContain(`  ${command}`);
  });

  it("bare fleetrc syncs, and says how to start when there is no manifest", async () => {
    const { code, stderr } = await machine().run();
    expect(code).toBe(1);
    expect(stderr).toBe("fleetrc: no manifest yet: run `fleetrc init <manifest>` first\n");
  });

  it("rejects an unknown command and an invalid manifest", async () => {
    const m = machine();
    expect((await m.run("frobnicate")).code).toBe(2);
    const manifest = m.manifest({ sources: [{ id: "x", git: "a/b", index: "https://x" }] });
    const init = await m.run("init", manifest);
    expect(init.code).toBe(1);
    expect(init.stderr).toContain("sources[0] needs exactly one of git, index, npm or local");
  });

  it("add and list: adds a source to the manifest and links its skills", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const vendor = remote(m, "extra", skills("skills/", "added"));
    const add = await m.run("add", vendor.url, "--id", "extra");
    expect(add.code, add.stdout + add.stderr).toBe(0);
    const list = await m.run("list");
    expect(list.stdout).toMatch(/^added {2}extra {2}/m);
  });

  it("status lists Codex sessions started before the last skill change, and not Claude Code's", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", skills("skills/", "first"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // Processes that look like Codex and Claude Code: node running a script named codex or claude.
    const fake = (name: string) => {
      const file = join(m.root, `${name}.mjs`);
      writeFileSync(file, "setInterval(() => {}, 1000);\n");
      return spawn(process.execPath, [file], { stdio: "ignore" });
    };
    const session = fake("codex");
    const claude = fake("claude");
    try {
      await new Promise((done) => setTimeout(done, 2500));
      vendor.commit({ "skills/second/SKILL.md": "---\nname: second\ndescription: Second\n---\n" });
      await m.run("sync");
      const status = await m.run("status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(
        new RegExp(`^restart: codex \\(pid ${session.pid}\\) started `, "m"),
      );
      expect(status.stdout).not.toContain(`pid ${claude.pid}`);
      expect(status.stdout).toContain("+ added: second");
    } finally {
      session.kill();
      claude.kill();
    }
  });
});
