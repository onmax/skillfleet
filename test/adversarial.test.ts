// Hostile and unlucky inputs. Each test asserts what fleetrc should do; a failing test is a
// break the fix wave has to close. Every run uses the fixture's temporary HOME.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { jsonTemp } from "../src/fs.ts";
import {
  cli,
  clone,
  isLink,
  isWindows,
  machine,
  type Machine,
  named,
  names,
  read,
  remote,
  sha256,
  skillMd,
  skills,
  version,
  writeFiles,
} from "./fixture.ts";
import {
  recorder,
  serveArchiveIndex,
  servePackument,
  sha512,
  tarball,
  tarHeaderFor,
} from "./hostile.ts";

/** Every path under `dir`, so a test can show nothing landed outside the folders it expects. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      out.push(prefix + name);
      if (lstatSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort();
}

/** A link to a folder that, like fleetrc's own on Windows, needs no symlink privilege there. */
const linkDir = (target: string, path: string) =>
  symlinkSync(target, path, isWindows ? "junction" : "dir");

/**
 * A hook command that appends "ran" and its pid to `log`, then waits `seconds`. It is a Node script,
 * so the same hook runs under sh and under cmd.exe.
 */
function slowHook(m: Machine, log: string, seconds: number): string {
  const script = join(m.root, "slow-hook.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "ran " + process.pid + "\\n");\nsetTimeout(() => {}, ${seconds * 1000});\n`,
  );
  return `"${process.execPath}" "${script}"`;
}

/** The runs a slowHook recorded, and a way to stop the ones a killed sync left behind. */
const hookRuns = (log: string) => read(log).trim().split("\n");
function stopHooks(log: string) {
  if (!existsSync(log)) return;
  for (const line of hookRuns(log))
    try {
      process.kill(Number(line.split(" ")[1]));
    } catch {}
}

describe("hostile skill names", () => {
  it("N1. a vendored skill named ../../../../../../victim cannot delete or replace a folder in HOME", async () => {
    const m = machine();
    // The store keeps a skill at <state>/store/<source>/live/<name>: six levels below HOME.
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "fine"),
      "skills/evil/SKILL.md":
        "---\nname: ../../../../../../victim\ndescription: escapes\n---\nevil\n",
    });
    mkdirSync(m.at("victim"), { recursive: true });
    writeFileSync(m.at("victim", "authorized_keys"), "my key\n");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(tree(m.at("victim"))).toEqual(["authorized_keys"]);
    expect(read(m.at("victim", "authorized_keys"))).toBe("my key\n");
    expect(names(m.at(".claude/skills"))).toEqual(["fine"]);
  });

  it("N2. an in-place skill whose frontmatter name is ../../../escape is not linked outside the agent folder", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    mkdirSync(join(folder, "ok"), { recursive: true });
    writeFileSync(join(folder, "ok/SKILL.md"), skillMd("ok"));
    mkdirSync(join(folder, "evil"), { recursive: true });
    writeFileSync(
      join(folder, "evil/SKILL.md"),
      "---\nname: ../../../escape\ndescription: escapes\n---\nevil\n",
    );
    mkdirSync(join(folder, "loose"), { recursive: true });
    // Not valid YAML, so fleetrc reads the name line by line.
    writeFileSync(
      join(folder, "loose/SKILL.md"),
      "---\nname: ../../../loose-escape\ndescription: a: b\n---\nloose\n",
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: folder }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(existsSync(join(m.root, "escape"))).toBe(false);
    expect(existsSync(join(m.root, "loose-escape"))).toBe(false);
    expect(names(m.at(".claude/skills"))).toEqual(["ok"]);
  });

  it("N3. a skill named .. does not wipe the source's store", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "fine"),
      "skills/dots/SKILL.md": "---\nname: ..\ndescription: dots\n---\ndots\n",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(names(m.at(".claude/skills"))).toEqual(["fine"]);
    expect(read(m.at(".claude/skills/fine/SKILL.md"))).toBe(skillMd("fine"));
    expect(existsSync(join(m.stateDir, "store", "v", "SKILL.md"))).toBe(false);
    expect(existsSync(m.at(".claude", "SKILL.md"))).toBe(false);
  });

  it("N4. one skill with a 300-character name does not stop the other skills from linking", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    const long = "x".repeat(300);
    mkdirSync(join(folder, "ok"), { recursive: true });
    writeFileSync(join(folder, "ok/SKILL.md"), skillMd("ok"));
    mkdirSync(join(folder, "long"), { recursive: true });
    writeFileSync(join(folder, "long/SKILL.md"), skillMd(long));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: folder }],
    });
    const run = await m.run("init", manifest, "--no-hooks");
    expect(run.stderr).not.toMatch(/ENAMETOOLONG.*\n\s+at /);
    expect(names(m.at(".claude/skills"))).toContain("ok");
    expect(isLink(m.at(".claude/skills/ok"))).toBe(true);
  });
});

describe("hostile manifests", () => {
  it("M1. reads a manifest saved with a UTF-8 byte order mark", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "bom"));
    const file = m.manifest({ agents: ["claude-code"], sources: [{ id: "v", git: vendor.url }] });
    writeFileSync(file, `﻿${read(file)}`);
    const run = await m.run("init", file, "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["bom"]);
  });

  it("M2. a manifest with comments fails with one line naming the file, not a stack trace", async () => {
    const m = machine();
    const file = m.manifest({});
    writeFileSync(file, '{\n  // my skills\n  "agents": "all"\n}\n');
    const run = await m.run("sync", "--manifest", file);
    expect(run.code).toBe(1);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain(file);
  });

  it("M3. a skills glob cannot reach folders outside the source", async () => {
    const m = machine();
    const outside = join(m.root, "outside");
    mkdirSync(join(outside, "private"), { recursive: true });
    writeFileSync(join(outside, "private/SKILL.md"), skillMd("private"));
    writeFileSync(join(outside, "private/secret.txt"), "secret\n");
    const vendor = remote(m, "vendor", skills("skills/", "inside"));
    // The cached clone lives seven folders below the machine root.
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url, skills: "../../../../../../../outside/*" }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(names(m.at(".claude/skills"))).not.toContain("private");
    expect(existsSync(join(m.stateDir, "store", "v", "live", "private", "secret.txt"))).toBe(false);
  });

  it("M4. an extended team manifest cannot make fleetrc clone into a path on this machine", async () => {
    const m = machine();
    const evil = remote(m, "evil", {
      "evil.desktop": "[Desktop Entry]\nExec=sh -c 'echo owned'\n",
    });
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(
      team,
      JSON.stringify({ sources: [{ id: "auto", git: evil.url, path: "~/.config/autostart" }] }),
    );
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    const run = await m.run("init", manifest, "--no-hooks");
    expect(existsSync(m.at(".config/autostart"))).toBe(false);
    expect(run.stdout).toMatch(/auto/);
  });

  it("M5. an extended team manifest's hooks, report, fleet and hub never run", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "team-skill"));
    const hub = await recorder();
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(
      team,
      JSON.stringify({
        sources: [{ id: "team", git: vendor.https }],
        hooks: [{ run: `touch "${join(m.root, "hook-ran")}"` }],
        report: { run: `touch "${join(m.root, "report-ran")}"` },
        fleet: ["-oProxyCommand=touch pwned"],
        hub: hub.url,
      }),
    );
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    const run = await m.run("init", manifest, "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["team-skill"]);
    expect(existsSync(join(m.root, "hook-ran"))).toBe(false);
    expect(existsSync(join(m.root, "report-ran"))).toBe(false);
    expect(hub.hits).toEqual([]);
    expect(run.stdout).toContain("ignored hooks, fleet, hub, report");
  });

  it("M6. extends cycles and a 40-deep chain load once each", async () => {
    const m = machine();
    const dir = join(m.root, "chain");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i++)
      writeFileSync(
        join(dir, `${i}.json`),
        JSON.stringify({
          // The last one points back at the first.
          extends: [i === 39 ? "./0.json" : `./${i + 1}.json`, `./${i}.json`],
          sources: [],
        }),
      );
    const manifest = m.manifest({ agents: ["claude-code"], extends: [join(dir, "0.json")] });
    const run = await m.run("init", manifest, "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
  });

  it("M7. when an extended manifest breaks, the skills it provided keep their local edits", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(team, JSON.stringify({ sources: [{ id: "team", git: vendor.https }] }));
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const edited = `${skillMd("tool")}\nmy notes, written over a week\n`;
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), edited);
    // A teammate pushes a manifest with a trailing comma.
    writeFileSync(team, '{ "sources": [{ "id": "team", "git": "x" },] }');
    const run = await m.json("sync");
    expect(run.warnings.join("\n")).toContain("extends");
    const store = join(m.stateDir, "store", "team", "live", "tool", "SKILL.md");
    expect(existsSync(store) ? read(store) : "deleted").toBe(edited);
  });
});

describe("hostile git sources", () => {
  it("G1. doctor does not run a git URL from a team manifest as an --upload-pack command", async () => {
    const m = machine({ scheduler: "empty" });
    const marker = join(m.root, "pwned-doctor");
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(
      team,
      JSON.stringify({ sources: [{ id: "x", git: `--upload-pack=touch ${marker};false` }] }),
    );
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    await m.run("init", manifest, "--no-hooks");
    await m.run("doctor");
    expect(existsSync(marker)).toBe(false);
  });

  it("G2. sync runs neither an --upload-pack URL nor an ext:: URL", async () => {
    const m = machine();
    const upload = join(m.root, "pwned-upload");
    const ext = join(m.root, "pwned-ext");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "a", git: `--upload-pack=touch ${upload};false` },
        { id: "b", git: `ext::sh -c touch% ${ext}` },
        { id: "c", git: `--upload-pack=touch ${upload};false`, path: join(m.root, "clone") },
      ],
    });
    await m.run("init", manifest, "--no-hooks");
    await m.run("sync");
    await m.run("sync", "--dry-run");
    expect(existsSync(upload)).toBe(false);
    expect(existsSync(ext)).toBe(false);
  });

  it("G3. a working clone whose upstream was force-pushed back says so instead of staying ahead silently", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "alpha"));
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    personal.commit({ "skills/bad/SKILL.md": skillMd("bad", "a compromised commit") });
    expect((await m.json("sync")).skills.added).toEqual(["bad"]);
    // Upstream removes the commit by force-pushing the branch back.
    m.git(personal.work, "reset", "--quiet", "--hard", "HEAD~1");
    m.git(personal.work, "push", "--quiet", "--force", "origin", "main");
    const report = await m.json("sync");
    const said = [...report.warnings, ...report.held.map((held) => held.reason)].join("\n");
    expect(said).toMatch(/force|rewr|no longer|not on/i);
  });

  it("G4. symlinks in a vendored skill never bring in files from outside it", async () => {
    const m = machine();
    const secret = join(m.root, "secret");
    mkdirSync(join(secret, "inner"), { recursive: true });
    writeFileSync(join(secret, "id_rsa"), "PRIVATE KEY\n");
    writeFileSync(join(secret, "inner/SKILL.md"), skillMd("inner"));
    const vendor = remote(m, "vendor", skills("skills/", "leak"));
    symlinkSync(join(secret, "id_rsa"), join(vendor.work, "skills/leak/abs-key"));
    symlinkSync("../../../../secret/id_rsa", join(vendor.work, "skills/leak/rel-key"));
    symlinkSync(join(secret, "inner"), join(vendor.work, "skills/linked-skill"));
    vendor.commit({});
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "v", git: vendor.url },
        { id: "w", git: vendor.url, ref: "main", skills: "skills/*" },
      ],
    });
    await m.run("init", manifest, "--no-hooks");
    const store = join(m.stateDir, "store");
    const found = tree(store).filter((path) => /key|inner|linked-skill/.test(path));
    expect(found).toEqual([]);
    expect(names(m.at(".claude/skills"))).toEqual(["leak"]);
  });

  it("G5. a vendored repository deleted upstream keeps the last good copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "kept"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    rmSync(vendor.url, { recursive: true, force: true });
    const report = await m.json("sync");
    expect(report.warnings.join("\n")).toContain("kept the last good copy");
    expect(read(m.at(".claude/skills/kept/SKILL.md"))).toBe(skillMd("kept"));
  });
});

/** Files under `dirs` whose content includes `needle`. */
function containing(needle: string, ...dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && readFileSync(path, "utf8").includes(needle)) hits.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return hits;
}

const pkgFiles = (name: string, files: Record<string, string>) =>
  Object.entries({ "package.json": JSON.stringify({ name, version: "1.0.0" }), ...files }).map(
    ([file, body]) => ({ name: `package/${file}`, body }),
  );

describe("hostile npm registries and tarballs", () => {
  it("A1. a registry cannot pick a version that unpacks outside the npm cache", async () => {
    const m = machine();
    const registry = await recorder();
    const archive = tarball(pkgFiles("pkg", { "skills/x/SKILL.md": skillMd("x") }));
    registry.routes.set("/pkg.tgz", { body: archive, type: "application/octet-stream" });
    // The cache is six folders below the machine root.
    const version = `0/${"../".repeat(7)}planted`;
    servePackument(
      registry,
      "pkg",
      { [version]: { tarball: `${registry.url}/pkg.tgz`, integrity: sha512(archive) } },
      version,
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "n", npm: "pkg", registry: registry.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(existsSync(join(m.root, "planted"))).toBe(false);
    expect(readdirSync(m.root).filter((name) => name.startsWith("planted"))).toEqual([]);
  });

  it("A2. NPM_TOKEN goes to the registry only, never to a tarball host the packument names", async () => {
    const m = machine();
    const registry = await recorder();
    const elsewhere = await recorder();
    const archive = tarball(pkgFiles("pkg", { "skills/x/SKILL.md": skillMd("x") }));
    elsewhere.routes.set("/pkg.tgz", { body: archive, type: "application/octet-stream" });
    servePackument(
      registry,
      "pkg",
      { "1.0.0": { tarball: `${elsewhere.url}/pkg.tgz`, integrity: sha512(archive) } },
      "1.0.0",
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "n", npm: "pkg", registry: registry.url }],
    });
    const run = await m.runWith(
      { env: { NPM_TOKEN: "npm_secret" } },
      "init",
      manifest,
      "--no-hooks",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["x"]);
    // init plans with a dry run in a scratch cache, then syncs, so the tarball is fetched twice.
    expect(elsewhere.hits.length).toBeGreaterThan(0);
    expect(elsewhere.hits.filter((hit) => hit.headers.authorization)).toEqual([]);
  });

  it("A3. NPM_TOKEN is not sent to a registry an extended team manifest names", async () => {
    const m = machine();
    const registry = await recorder();
    // A name for the server, which a team manifest may name; CX18 refuses a loopback address.
    const url = named(registry.url, "registry");
    const archive = tarball(pkgFiles("pkg", { "skills/x/SKILL.md": skillMd("x") }));
    registry.routes.set("/pkg.tgz", { body: archive, type: "application/octet-stream" });
    servePackument(
      registry,
      "pkg",
      { "1.0.0": { tarball: `${url}/pkg.tgz`, integrity: sha512(archive) } },
      "1.0.0",
    );
    const team = join(m.root, "team", ".fleetrc", "manifest.json");
    mkdirSync(join(m.root, "team", ".fleetrc"), { recursive: true });
    writeFileSync(team, JSON.stringify({ sources: [{ id: "n", npm: "pkg", registry: url }] }));
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team], sources: [] });
    await m.runWith({ env: { NPM_TOKEN: "npm_secret" } }, "init", manifest, "--no-hooks");
    expect(registry.hits.length).toBeGreaterThan(0);
    expect(registry.hits.filter((hit) => hit.headers.authorization)).toEqual([]);
  });

  it("A4. tarball links, devices and absolute paths are refused or skipped", async () => {
    const m = machine();
    const secret = join(m.root, "secret");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "id_rsa"), "PRIVATE KEY\n");
    const registry = await recorder();
    const variants: Record<
      string,
      { name: string; body?: string; type?: string; linkname?: string }[]
    > = {
      symlink: [{ name: "package/skills/x/key", type: "2", linkname: join(secret, "id_rsa") }],
      hardlink: [{ name: "package/skills/x/key", type: "1", linkname: join(secret, "id_rsa") }],
      absolute: [{ name: join(secret, "planted"), body: "planted\n" }],
      device: [{ name: "package/skills/x/null", type: "3" }],
    };
    const sources = [];
    for (const [kind, extra] of Object.entries(variants)) {
      const archive = tarball([...pkgFiles(kind, { "skills/x/SKILL.md": skillMd("x") }), ...extra]);
      registry.routes.set(`/${kind}.tgz`, { body: archive, type: "application/octet-stream" });
      servePackument(
        registry,
        kind,
        { "1.0.0": { tarball: `${registry.url}/${kind}.tgz`, integrity: sha512(archive) } },
        "1.0.0",
      );
      sources.push({ id: kind, npm: kind, registry: registry.url });
    }
    const manifest = m.manifest({ agents: ["claude-code"], sources });
    await m.run("init", manifest, "--no-hooks");
    const report = await m.json("sync");
    expect(existsSync(join(secret, "planted"))).toBe(false);
    expect(containing("PRIVATE KEY", m.home)).toEqual([]);
    // A device entry is skipped; the rest of that package installs.
    expect(report.errors.filter((error) => error.startsWith("device"))).toEqual([]);
  });

  it("A5. a tarball that inflates past 100 MB is refused before it fills memory and disk", async () => {
    const m = machine();
    const registry = await recorder();
    // 160 MB of zeros as ten concatenated gzip members: about 160 KB on the wire.
    const chunk = 16 * 1024 * 1024;
    const size = 10 * chunk;
    const file = (name: string, body: string) =>
      Buffer.concat([
        tarHeaderFor(name, body.length),
        Buffer.from(body),
        Buffer.alloc(512 - body.length),
      ]);
    const head = Buffer.concat([
      file("package/package.json", '{"name":"bomb","version":"1"}'),
      file("package/skills/b/SKILL.md", skillMd("b")),
      tarHeaderFor("package/zeros.bin", size),
    ]);
    const zeros = gzipSync(Buffer.alloc(chunk));
    const archive = Buffer.concat([
      gzipSync(head),
      ...Array.from({ length: 10 }, () => zeros),
      gzipSync(Buffer.alloc(1024)),
    ]);
    registry.routes.set("/bomb.tgz", { body: archive, type: "application/octet-stream" });
    servePackument(
      registry,
      "bomb",
      { "1": { tarball: `${registry.url}/bomb.tgz`, integrity: sha512(archive) } },
      "1",
    );
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "bomb", npm: "bomb", registry: registry.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    const report = await m.json("sync");
    expect(report.errors.join("\n")).toMatch(/bomb.*(large|size|limit)/i);
  });

  it("A6. a packument without any integrity field is refused", async () => {
    const m = machine();
    const registry = await recorder();
    const archive = tarball(pkgFiles("pkg", { "skills/x/SKILL.md": skillMd("x") }));
    registry.routes.set("/pkg.tgz", { body: archive, type: "application/octet-stream" });
    servePackument(registry, "pkg", { "1.0.0": { tarball: `${registry.url}/pkg.tgz` } }, "1.0.0");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "n", npm: "pkg", registry: registry.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    const report = await m.json("sync");
    expect(report.errors.join("\n")).toContain("no integrity hash");
    expect(names(m.at(".claude/skills"))).toEqual([]);
  });
});

describe("hostile skill indexes", () => {
  const good = () => ({
    name: "good",
    archive: tarball([{ name: "SKILL.md", body: skillMd("good") }]),
  });

  /** Each archive installs alone in its own index, so one rejection never hides another. */
  async function installEach(
    m: Machine,
    archives: { name: string; archive: Uint8Array; entry?: Record<string, unknown> }[],
  ) {
    const sources = [];
    for (const archive of archives) {
      const site = await recorder();
      serveArchiveIndex(site, [good(), archive]);
      sources.push({ id: archive.name, index: site.url, exclude: ["good"] });
    }
    // One index with only the control skill, to show indexes install at all.
    const control = await recorder();
    serveArchiveIndex(control, [good()]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "control", index: control.url }, ...sources],
    });
    await m.run("init", manifest, "--no-hooks");
    return m.json("sync");
  }

  it("I1. index archives with links, absolute paths and devices bring nothing from outside", async () => {
    const m = machine();
    const secret = join(m.root, "secret");
    mkdirSync(secret, { recursive: true });
    writeFileSync(join(secret, "id_rsa"), "PRIVATE KEY\n");
    const base = (name: string) => ({ name: "SKILL.md", body: skillMd(name) });
    const link = (type: string) => ({ name: "key", type, linkname: join(secret, "id_rsa") });
    const report = await installEach(m, [
      { name: "sym", archive: tarball([base("sym"), link("2")]) },
      { name: "hard", archive: tarball([base("hard"), link("1")]) },
      {
        name: "dotdot",
        archive: tarball([base("dotdot"), { name: "../../../../planted", body: "x" }]),
      },
      {
        name: "abs",
        archive: tarball([base("abs"), { name: join(secret, "planted"), body: "x" }]),
      },
      { name: "dev", archive: tarball([base("dev"), { name: "null", type: "3" }]) },
    ]);
    expect(names(m.at(".claude/skills"))).toContain("good");
    expect(existsSync(join(secret, "planted"))).toBe(false);
    expect(existsSync(join(m.root, "planted"))).toBe(false);
    expect(containing("PRIVATE KEY", m.home)).toEqual([]);
    expect(report.sources.map((source) => source.id)).toContain("dev");
  });

  it("I2. an archive entry without a digest, or with a digest in an algorithm fleetrc cannot check, is not installed", async () => {
    const m = machine();
    await installEach(m, [
      {
        name: "nodigest",
        archive: tarball([{ name: "SKILL.md", body: skillMd("nodigest") }]),
        entry: { digest: undefined },
      },
      {
        name: "md5",
        archive: tarball([{ name: "SKILL.md", body: skillMd("md5") }]),
        entry: { digest: "md5:00000000000000000000000000000000" },
      },
    ]);
    expect(names(m.at(".claude/skills"))).toEqual(["good"]);
  });

  it("I3. one index entry with an uppercase digest does not take down the rest of the index", async () => {
    const m = machine();
    const site = await recorder();
    const archive = tarball([{ name: "SKILL.md", body: skillMd("upper") }]);
    serveArchiveIndex(site, [
      good(),
      { name: "upper", archive, entry: { digest: `sha256:${sha256(archive).toUpperCase()}` } },
    ]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "s", index: site.url }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(names(m.at(".claude/skills"))).toContain("good");
  });

  it("I4. an index cannot point an archive at a local file, and a tampered archive on another host is refused", async () => {
    const m = machine();
    const other = await recorder();
    const local = tarball([{ name: "SKILL.md", body: skillMd("local", "PRIVATE KEY") }]);
    writeFileSync(join(m.root, "local.tar.gz"), local);
    const cdn = tarball([{ name: "SKILL.md", body: skillMd("cdn") }]);
    other.routes.set("/cdn.tar.gz", {
      body: tarball([{ name: "SKILL.md", body: skillMd("cdn", "swapped") }]),
      type: "application/gzip",
    });
    await installEach(m, [
      {
        name: "local",
        archive: local,
        entry: { url: pathToFileURL(join(m.root, "local.tar.gz")).href },
      },
      { name: "cdn", archive: cdn, entry: { url: `${other.url}/cdn.tar.gz` } },
    ]);
    expect(names(m.at(".claude/skills"))).toEqual(["good"]);
  });
});

describe("names that differ only on some file systems", () => {
  it("P1. two sources whose ids differ only by case, or by a trailing dot, are refused", async () => {
    const m = machine();
    // macOS and Windows put store/Team and store/team in one folder, and Windows drops the trailing dot.
    for (const pair of [
      ["Team", "team"],
      ["team.", "team"],
    ]) {
      for (const id of pair) mkdirSync(join(m.root, `dir-${id}`), { recursive: true });
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: pair.map((id) => ({ id, local: join(m.root, `dir-${id}`) })),
      });
      const run = await m.run("sync", "--manifest", manifest);
      expect(run.code, pair.join(" vs ")).toBe(1);
      expect(run.stderr, pair.join(" vs ")).toMatch(/twice|same|differ/);
    }
  });

  it("P2. source ids that are reserved device names on Windows are refused", async () => {
    const m = machine();
    mkdirSync(join(m.root, "x"), { recursive: true });
    for (const id of ["con", "aux", "NUL", "com1"]) {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id, local: join(m.root, "x") }],
      });
      const run = await m.run("sync", "--manifest", manifest);
      expect(run.code, id).toBe(1);
      expect(run.stderr, id).toContain(`"${id}"`);
    }
  });

  it("P3. skill names that differ only by case or Unicode normalization link once, with a shadow note", async () => {
    const m = machine();
    const one = join(m.root, "one");
    const two = join(m.root, "two");
    for (const [dir, name] of [
      [one, "Tool"],
      [two, "tool"],
      [one, "café"],
      [two, "café"],
    ] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "SKILL.md"), skillMd(name));
    }
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "one", local: one },
        { id: "two", local: two },
      ],
    });
    await m.run("init", manifest, "--no-hooks");
    const report = await m.json("sync");
    // macOS and Windows would show one folder for each pair, so every machine should agree on one.
    expect(names(m.at(".claude/skills"))).toHaveLength(2);
    expect(report.shadowed.map((entry) => entry.loser)).toEqual(["two", "two"]);
  });

  it("P4. skill names Windows cannot create are skipped with a warning on every system", async () => {
    const m = machine();
    const folder = join(m.root, "mine");
    for (const [i, name] of ["ok", "aux", "trailing.", "con.md"].entries()) {
      mkdirSync(join(folder, `d${i}`), { recursive: true });
      writeFileSync(
        join(folder, `d${i}`, "SKILL.md"),
        `---\nname: "${name}"\ndescription: d\n---\n`,
      );
    }
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: folder }],
    });
    await m.run("init", manifest, "--no-hooks");
    expect(names(m.at(".claude/skills"))).toEqual(["ok"]);
  });
});

describe("fleet over ssh", () => {
  /** An ssh that records its argv, one JSON line per call, and answers like a host it can't reach. */
  function recordingSsh(m: Machine) {
    const log = join(m.root, "ssh-argv.jsonl");
    const ssh = join(m.root, "ssh.mjs");
    writeFileSync(
      ssh,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(255);\n`,
    );
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [];
    return { env: { FLEETRC_SSH: ssh }, calls };
  }

  it("F1. a fleet host that looks like an ssh option reaches ssh only after --, or is refused", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const ssh = recordingSsh(m);
    const host = `-oProxyCommand=touch ${join(m.root, "pwned")}`;
    // parseArgs takes it as an option on the command line, so it can only come from the manifest.
    const added = await m.run("fleet", "add", "--", host);
    expect(added.code !== 0 || read(manifest).includes("ProxyCommand")).toBe(true);
    // A hand-edited manifest can still name it.
    writeFileSync(
      manifest,
      JSON.stringify({ agents: ["claude-code"], sources: [], fleet: [host] }),
    );
    await m.runWith({ env: ssh.env }, "fleet", "status", "--timeout", "3");
    // Refused before ssh runs, or passed after --.
    for (const argv of ssh.calls().filter((args) => args.includes(host)))
      expect(argv.slice(0, argv.indexOf(host))).toContain("--");
    expect(existsSync(join(m.root, "pwned"))).toBe(false);
  });

  it("F2. fleet add refuses hosts with spaces or shell characters", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    for (const host of ["two words", "host;id", "host$(id)"]) {
      const run = await m.run("fleet", "add", host);
      expect(run.code, host).not.toBe(0);
    }
    expect(read(manifest)).not.toContain("fleet");
  });
});

describe("hooks and commands", () => {
  it("H1. a command that times out returns on time even when it left a child holding its output", async () => {
    const { exec } = await import("../src/exec.ts");
    const started = Date.now();
    // A shell command whose child starts a grandchild that inherits its output, then both wait 6s.
    const child = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }); setTimeout(() => {}, 6000)`;
    const run = await exec(`"${process.execPath}" -e "${child}"`, [], {
      shell: true,
      timeoutMs: 500,
    });
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("H2. a hook that prints without end is not buffered whole in memory", async () => {
    const { exec } = await import("../src/exec.ts");
    // 64 MB is enough to show exec keeps everything; the real risk is a hook printing gigabytes.
    const print = `const block = Buffer.alloc(1 << 20, 120); for (let i = 0; i < 64; i++) process.stdout.write(block)`;
    const run = await exec(`"${process.execPath}" -e "${print}"`, [], {
      shell: true,
      timeoutMs: 60_000,
    });
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });
});

/** A vendored git source with one skill, synced into Claude Code's folder, then edited there. */
async function editedVendored() {
  const m = machine();
  const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "vendor", git: vendor.url }],
  });
  expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
  const edited = `${skillMd("tool")}\nnotes I wrote by hand\n`;
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), edited);
  return { m, vendor, manifest, edited };
}

describe("crashes, corrupt state and recovery", () => {
  it("C1. a lock left by a dead sync whose pid now belongs to another program does not block sync forever", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // The kernel reused the pid for something else: here, the test runner itself.
    writeFileSync(join(m.stateDir, "sync.lock"), String(process.pid));
    const run = await m.run("sync");
    expect(run.code, run.stderr).toBe(0);
  });

  it("C2. a git cache left half-made by a killed clone is cloned again", async () => {
    const { m, vendor } = await editedVendored();
    const cache = join(m.stateDir, "cache", "git");
    const [dir] = readdirSync(cache);
    // What `git clone` leaves when it is SIGKILLed before it fetched anything.
    rmSync(join(cache, dir!), { recursive: true, force: true });
    mkdirSync(join(cache, dir!, ".git"), { recursive: true });
    vendor.commit({ "skills/other/SKILL.md": skillMd("other", "v2") });
    const report = await m.json("sync");
    expect(report.errors).toEqual([]);
    expect(read(m.at(".claude/skills/other/SKILL.md"))).toBe(skillMd("other", "v2"));
  });

  it("C3. a truncated state.json does not stop sync, and local edits survive it", async () => {
    const { m, edited } = await editedVendored();
    writeFileSync(join(m.stateDir, "state.json"), '{"version":1,"sour');
    const run = await m.run("sync");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(edited);
  });

  it("C4. a deleted state.json does not overwrite a vendored skill's local edits", async () => {
    const { m, edited } = await editedVendored();
    rmSync(join(m.stateDir, "state.json"));
    await m.run("sync");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(edited);
  });

  it("C5. a corrupt link record in an agent folder does not stop the other folders from syncing", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(m.at(".claude/skills/.fleetrc-manifest.json"), "{");
    vendor.commit({ "skills/second/SKILL.md": skillMd("second") });
    const run = await m.run("sync");
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(names(m.at(".cursor/skills"))).toEqual(["second", "tool"]);
  });

  it("C6. a read-only agent folder is reported, and the other agent folders still sync", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    vendor.commit({ "skills/second/SKILL.md": skillMd("second") });
    const folder = m.at(".claude/skills");
    // Windows ignores a folder's read-only mode; an ACL that denies writing makes it read-only.
    const icacls = (...args: string[]) =>
      execFileSync("icacls", [folder, ...args], { stdio: "pipe" });
    if (isWindows) icacls("/deny", "*S-1-1-0:(W,D,DC)");
    else chmodSync(folder, 0o555);
    try {
      const run = await m.run("sync", "--json");
      expect(run.stderr).not.toMatch(/\n\s+at /);
      const report = JSON.parse(run.stdout) as { errors: string[]; warnings: string[] };
      expect([...report.errors, ...report.warnings].join("\n")).toMatch(/\.claude[\\/]skills/);
      expect(names(m.at(".cursor/skills"))).toEqual(["second", "tool"]);
    } finally {
      if (isWindows) icacls("/remove:d", "*S-1-1-0");
      else chmodSync(folder, 0o755);
    }
  });

  it("C7. an agent folder that is a file, and a dangling link where a skill goes, are left alone with a warning", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // After init: the user swaps Cursor's folder for a file, and points tool at a folder that is gone.
    rmSync(m.at(".cursor/skills"), { recursive: true, force: true });
    writeFileSync(m.at(".cursor/skills"), "not a folder\n");
    rmSync(m.at(".claude/skills/tool"));
    linkDir(join(m.root, "gone"), m.at(".claude/skills/tool"));
    writeFileSync(m.at(".claude/skills/.fleetrc-manifest.json"), '{"version":1,"links":{}}');
    const report = await m.json("sync");
    expect(read(m.at(".cursor/skills"))).toBe("not a folder\n");
    expect(report.targets.map((target) => target.skipped).filter(Boolean)).toHaveLength(1);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
    expect(report.targets.flatMap((target) => target.foreign)).toEqual(["tool"]);
  });

  it("C8. status, fleet status and the prompt hook survive their own state files being corrupt", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["nowhere"] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    for (const file of ["last-run.json", "fleet.json", "sessions.json"])
      writeFileSync(join(m.stateDir, file), "{");
    const status = await m.run("status");
    const hook = await m.runWith({ input: '{"session_id":"s"}' }, "hook", "prompt");
    const fleet = await m.runWith(
      { env: { FLEETRC_SSH: "false" } },
      "fleet",
      "status",
      "--timeout",
      "2",
    );
    for (const [what, run] of Object.entries({ status, hook, fleet }))
      expect(run.stderr, what).not.toMatch(/\n\s+at /);
    expect(hook.code).toBe(0);
  });
});

describe("two syncs and a killed sync", () => {
  it("C9. a second sync waits out a running one, and a sync killed mid-hook is finished by the next run", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const log = join(m.root, "hook.log");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      hooks: [{ name: "slow", run: slowHook(m, log, 20), on: ["vendor:**"] }],
    });
    mkdirSync(join(m.home, ".config", "fleetrc"), { recursive: true });
    writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest }));
    const first = spawn(process.execPath, [cli, "sync"], {
      cwd: m.home,
      env: m.env,
      stdio: "ignore",
    });
    const exited = new Promise((done) => first.on("exit", done));
    for (let i = 0; i < 300 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(log)).toBe(true);
    try {
      const second = await m.run("sync");
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("another fleetrc sync is running");
      first.kill("SIGKILL");
      await exited;

      const rerun = await m.run("sync");
      expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
      expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
      // The killed run never recorded its changes, so the hook runs again for them.
      expect(hookRuns(log)).toHaveLength(2);
    } finally {
      // The killed sync's hook outlives it; on Windows it would keep the test folder in use.
      stopHooks(log);
    }
  }, 60_000);
});

describe("who holds the sync lock", () => {
  /** A sync that holds the lock for a while, started as `node <script> sync`. */
  async function holdingSync(m: Machine, script: string) {
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const log = join(m.root, "hook.log");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      hooks: [{ name: "slow", run: slowHook(m, log, 20), on: ["vendor:**"] }],
    });
    mkdirSync(join(m.home, ".config", "fleetrc"), { recursive: true });
    writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest }));
    const first = spawn(process.execPath, [script, "sync"], {
      cwd: m.home,
      env: m.env,
      stdio: "ignore",
    });
    const exited = new Promise((done) => first.on("exit", done));
    for (let i = 0; i < 300 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(log)).toBe(true);
    return {
      stop: async () => {
        first.kill("SIGKILL");
        await exited;
        stopHooks(log);
      },
    };
  }

  it("W-1. a sync started by another spelling of fleetrc's path holds the lock against a second sync", async () => {
    const m = machine();
    // A launcher's `bin/../app/cli.mjs`, or a path relative to the current folder: node's argv[1]
    // is the resolved path, and the command line the OS keeps is not.
    const spelled =
      relative(m.home, join(dirname(cli), "..", basename(dirname(cli)))) +
      sep +
      "." +
      sep +
      "cli.mjs";
    const holder = await holdingSync(m, spelled);
    try {
      const second = await m.run("sync");
      expect(second.code, second.stdout + second.stderr).toBe(1);
      expect(second.stderr).toContain("another fleetrc sync is running");
    } finally {
      await holder.stop();
    }
  }, 60_000);

  it("W-1. a lock whose pid now runs a process that started after the lock's holder is stale", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const now = Date.now();
      writeFileSync(
        join(m.stateDir, "sync.lock"),
        JSON.stringify({ pid: other.pid, started: now - 60_000, at: now - 30_000 }),
      );
      const report = await m.json("sync");
      expect(report.warnings.join("\n")).toContain(`pid ${other.pid} is now another program`);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("W-1. a lock whose pid runs a process that started no later than the lock's holder is held", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // This test's own process, as if it were the sync that wrote the lock.
    const started = Math.floor(performance.timeOrigin);
    writeFileSync(
      join(m.stateDir, "sync.lock"),
      JSON.stringify({ pid: process.pid, started, at: Date.now() }),
    );
    const run = await m.run("sync");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`another fleetrc sync is running (pid ${process.pid})`);
  });
});

describe("what a killed sync left beside state.json", () => {
  it("W-LOCK-2. the next sync deletes a dead sync's state.json temp and keeps a running command's", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((done) => gone.on("exit", done));
    const dead = jsonTemp(join(m.stateDir, "state.json"), gone.pid!);
    // Another command writing state.json right now, such as merge.
    const live = jsonTemp(join(m.stateDir, "state.json"), process.pid);
    writeFileSync(dead, "{");
    writeFileSync(live, "{");
    expect((await m.run("sync")).code).toBe(0);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe("syncs started at the same moment", () => {
  it("S1. of several syncs started together, exactly one takes the lock", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const log = join(m.root, "hook.log");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      // Holds the lock long enough that every other sync starts while it runs.
      hooks: [{ name: "slow", run: slowHook(m, log, 8), on: ["vendor:**"] }],
    });
    mkdirSync(join(m.home, ".config", "fleetrc"), { recursive: true });
    writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest }));
    const runs = await Promise.all(Array.from({ length: 6 }, () => m.run("sync")));
    expect(runs.filter((run) => run.code === 0)).toHaveLength(1);
    for (const run of runs.filter((run) => run.code !== 0))
      expect(run.stderr).toContain("another fleetrc sync is running");
    expect(hookRuns(log)).toHaveLength(1);
  }, 60_000);
});

describe("prune never deletes what it did not make", () => {
  it("R1. removing a source from the manifest keeps its skills' local edits", async () => {
    const { m, manifest, edited } = await editedVendored();
    writeFileSync(manifest, JSON.stringify({ agents: ["claude-code"], sources: [] }));
    const report = await m.json("sync");
    expect(containing("notes I wrote by hand", m.home)).not.toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/tool/);
    expect(edited).toContain("notes I wrote by hand");
  });

  it("R2. a team manifest that cannot be fetched does not remove its skills or their edits", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({ sources: [{ id: "team", git: vendor.https }] }),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      extends: [`${team.url}//.fleetrc/manifest.json`],
      sources: [],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    const edited = `${skillMd("tool")}\nmine\n`;
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), edited);
    // The network drops: the team repository cannot be fetched.
    rmSync(team.url, { recursive: true, force: true });
    await m.run("sync");
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(edited);
  });

  it("R3. with the state folder and link records wiped, prune leaves hand-made folders and foreign links alone", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    mkdirSync(m.at(".claude/skills/handmade"), { recursive: true });
    writeFileSync(m.at(".claude/skills/handmade/SKILL.md"), "hand made\n");
    mkdirSync(join(m.root, "elsewhere"), { recursive: true });
    linkDir(join(m.root, "elsewhere"), m.at(".claude/skills/linked"));
    rmSync(m.stateDir, { recursive: true, force: true });
    rmSync(m.at(".claude/skills/.fleetrc-manifest.json"));
    writeFileSync(manifest, JSON.stringify({ agents: ["claude-code"], sources: [] }));
    await m.run("sync", "--manifest", manifest);
    expect(read(m.at(".claude/skills/handmade/SKILL.md"))).toBe("hand made\n");
    expect(isLink(m.at(".claude/skills/linked"))).toBe(true);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
  });
});

describe("edits, merge and fork with awkward files", () => {
  it("E1. merge keeps a binary file's local bytes when both sides changed it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      "skills/tool/SKILL.md": skillMd("tool"),
      "skills/tool/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const mine = Buffer.from([0, 9, 9, 9, 0, 255, 1]);
    writeFileSync(m.at(".claude/skills/tool/logo.bin"), mine);
    writeFiles(vendor.work, { "skills/tool/logo.bin": Buffer.from([0, 7, 7, 0]) });
    vendor.commit({});
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code).toBe(1);
    expect(merge.stdout).toContain("conflicts: logo.bin");
    expect(readFileSync(m.at(".claude/skills/tool/logo.bin")).equals(mine)).toBe(true);
  });

  it("E2. merge of a file saved with CRLF keeps every local line", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      "skills/tool/SKILL.md": skillMd("tool", "one\ntwo\nthree\nfour\nfive"),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const mine = skillMd("tool", "one\nTWO MINE\nthree\nfour\nfive").replace(/\n/g, "\r\n");
    writeFileSync(m.at(".claude/skills/tool/SKILL.md"), mine);
    vendor.commit({
      "skills/tool/SKILL.md": skillMd("tool", "one\ntwo\nthree\nfour\nFIVE THEIRS"),
    });
    await m.run("sync");
    await m.run("merge", "tool");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toContain("TWO MINE");
  });

  it("E3. a skill renamed upstream while edited locally keeps the edited copy linked", async () => {
    const { m, vendor, edited } = await editedVendored();
    vendor.commit({
      "skills/tool/SKILL.md": null,
      "skills/tool-v2/SKILL.md": skillMd("tool-v2"),
    });
    const report = await m.json("sync");
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(edited);
    expect(names(m.at(".claude/skills"))).toEqual(["other", "tool", "tool-v2"]);
    expect(report.warnings.join("\n")).toContain("tool is gone upstream but has local edits");
  });

  it("E4. fork into a dirty personal clone leaves the uncommitted work alone", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        { id: "vendor", git: vendor.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(join(work, "skills/mine/SKILL.md"), `${skillMd("mine")}\nwip\n`);
    writeFileSync(join(work, "scratch.txt"), "untracked\n");
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stderr).toBe(0);
    expect(read(join(work, "skills/mine/SKILL.md"))).toBe(`${skillMd("mine")}\nwip\n`);
    expect(read(join(work, "scratch.txt"))).toBe("untracked\n");
    expect(read(join(work, "skills/tool/SKILL.md"))).toBe(skillMd("tool"));
  });
});

describe("unusual environments", () => {
  /** Env that moves HOME and everything under it to `home`. */
  const homeEnv = (home: string): NodeJS.ProcessEnv => ({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  });

  it("V1. relative XDG_STATE_HOME and XDG_CONFIG_HOME are ignored, as the XDG spec says", async () => {
    const m = machine();
    // A local source: with a git source the relative store path reaches `skills` as "rel-state/fleetrc",
    // which it takes for a GitHub repository and fetches from github.com.
    const folder = join(m.root, "mine");
    mkdirSync(join(folder, "tool"), { recursive: true });
    writeFileSync(join(folder, "tool/SKILL.md"), skillMd("tool"));
    const manifest = m.manifest({ agents: ["claude-code"], sources: [{ id: "v", local: folder }] });
    const env = { XDG_STATE_HOME: "rel-state", XDG_CONFIG_HOME: "rel-config" };
    const run = await m.runWith({ env }, "init", manifest, "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(m.at("rel-state"))).toBe(false);
    expect(existsSync(m.at("rel-config"))).toBe(false);
    // Without XDG_CONFIG_HOME, Windows keeps the config in %APPDATA%.
    const config = isWindows
      ? "AppData/Roaming/fleetrc/config.json"
      : ".config/fleetrc/config.json";
    expect(existsSync(m.at(config))).toBe(true);
  });

  it("V2. a HOME with spaces, accents, $ and a quote works, including the installed launcher", async () => {
    const m = machine();
    const home = join(m.root, "José O'Brien $HOME `x`");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const env = homeEnv(home);
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    const init = await m.runWith({ env }, "init", manifest, "--no-hooks");
    expect(init.code, init.stderr).toBe(0);
    expect(names(join(home, ".claude/skills"))).toEqual(["tool"]);
    expect((await m.runWith({ env }, "self-install")).code).toBe(0);
    const launcher = join(home, ".local/state/fleetrc/bin/fleetrc");
    // Windows runs the .cmd launcher; the sh one is for Git Bash. A .cmd only runs through cmd.
    const out = isWindows
      ? execFileSync(`"${launcher}.cmd"`, ["--version"], {
          env: { ...m.env, ...env },
          encoding: "utf8",
          shell: true,
        })
      : execFileSync(launcher, ["--version"], { env: { ...m.env, ...env }, encoding: "utf8" });
    expect(out.trim()).toBe(version);
  });

  it("V3. with git missing from PATH, sync reports it and keeps every link", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "personal", git: personal.url, path: work, skills: "skills/*" },
        { id: "vendor", git: vendor.url },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const bin = join(m.root, "nogit");
    mkdirSync(bin, { recursive: true });
    // POSIX keeps sh and env, which commands may need; Windows needs nothing on PATH.
    if (!isWindows) for (const tool of ["sh", "env"]) symlinkSync(`/bin/${tool}`, join(bin, tool));
    const run = await m.runWith(
      { env: { PATH: bin, ...(isWindows ? { Path: bin } : {}) } },
      "sync",
      "--json",
    );
    expect(run.stderr).not.toMatch(/\n\s+at /);
    const report = JSON.parse(run.stdout) as { errors: string[] };
    expect(report.errors.join("\n")).toMatch(/git/);
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "tool"]);
  });

  it("V4. with LANG=C, held files with non-ASCII names are listed by their real names", async () => {
    const m = machine();
    const personal = remote(m, "personal", skills("skills/", "café"));
    const work = clone(m, personal, "code/skills");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "personal", git: personal.url, path: work, skills: "skills/*" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(join(work, "skills/café/SKILL.md"), `${skillMd("café")}\nmine\n`);
    personal.commit({ "skills/café/SKILL.md": skillMd("café", "theirs") });
    const run = await m.runWith({ env: { LANG: "C", LC_ALL: "C" } }, "sync", "--json");
    const report = JSON.parse(run.stdout) as { held: { files: string[] }[] };
    expect(report.held[0]?.files).toEqual(["skills/café/SKILL.md"]);
  });

  it("V5. a manifest in a repository that is gone still syncs with --offline from the cache", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const repo = remote(m, "manifest-repo", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "v", git: vendor.url }],
      }),
    });
    expect((await m.run("init", `${repo.url}//.fleetrc/manifest.json`, "--no-hooks")).code).toBe(0);
    rmSync(repo.url, { recursive: true, force: true });
    const report = await m.json("sync", "--offline");
    expect(report.ok).toBe(true);
    expect(names(m.at(".claude/skills"))).toEqual(["tool"]);
  });

  it("V6. a local source pointing at HOME does not relink agent folders into themselves", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    mkdirSync(m.at("notes/mine"), { recursive: true });
    writeFileSync(m.at("notes/mine/SKILL.md"), skillMd("mine"));
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [
        { id: "home", local: "~" },
        { id: "vendor", git: vendor.url },
      ],
    });
    await m.run("init", manifest, "--no-hooks", "--copy");
    await m.run("sync", "--copy");
    await m.run("sync", "--copy");
    for (const dir of [".claude/skills", ".cursor/skills"])
      for (const name of names(m.at(dir)))
        expect(read(m.at(dir, name, "SKILL.md")), `${dir}/${name}`).toContain(name);
  });
});
