// The published tarball, installed the way `npx fleetrc` gets it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { isWindows, machine, remote, skills, version } from "./fixture.ts";

describe("packed tarball", () => {
  it("installs, prints its version, and plans an init", async () => {
    const m = machine();
    const npm = (cwd: string, ...args: string[]) =>
      execFileSync(isWindows ? "npm.cmd" : "npm", args, {
        cwd,
        env: { ...m.env, npm_config_cache: join(m.root, "npm-cache") },
        encoding: "utf8",
        shell: isWindows,
      });
    const out = join(m.root, "pack");
    mkdirSync(out);
    npm(resolve("."), "pack", "--ignore-scripts", "--pack-destination", out);
    const tarball = readdirSync(out).find((file) => file.endsWith(".tgz"))!;
    expect(tarball).toBe(`fleetrc-${version}.tgz`);
    const project = join(m.root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
    npm(project, "install", "--no-audit", "--no-fund", "--offline", join(out, tarball));
    // Bundled: the package installs no dependencies.
    expect(
      readdirSync(join(project, "node_modules")).filter((name) => !name.startsWith(".")),
    ).toEqual(["fleetrc"]);

    const npx = (...args: string[]) => npm(project, "exec", "--offline", "--", "fleetrc", ...args);
    expect(npx("--version").trim()).toBe(version);
    const vendor = remote(m, "vendor", skills("skills/", "packed"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    const plan = npx("init", "--dry-run", manifest);
    expect(plan).toContain("link 1 skills into 1 agent folders");
    expect(plan).toContain("names after: packed");
  });
});
