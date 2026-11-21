import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { globBase, matchesGlob } from "../src/glob.ts";
import { parseManifest } from "../src/manifest.ts";
import { select } from "../src/sources.ts";
import { readTgz, tarFileSizes } from "../src/tar.ts";
import {
  http,
  type Http,
  isLink,
  linkOf,
  machine,
  names,
  publishNpm,
  read,
  serveIndexV1,
  serveIndexV2,
  skillMd,
  tarHeader,
  tgz,
  sha256,
} from "./fixture.ts";

describe("skills and hook globs", () => {
  it("reads only *, ** and ?; brackets, braces, parentheses and ! are the characters themselves", () => {
    const cases: [string, string, boolean][] = [
      ["skills/*", "skills/a", true],
      ["skills/*", "skills/a/b", false],
      ["skills/**", "skills", true],
      ["skills/**", "skills/a/b", true],
      ["a/**/b", "a/b", true],
      ["a/**/b", "a/x/y/b", true],
      ["**", ".hidden/x", true],
      ["skills/?", "skills/a", true],
      ["skills/?", "skills/ab", false],
      ["??", "😀", true],
      ["?", "😀", false],
      ["😀", "😀", true],
      ["**", "a\nb", false],
      ["a/**/b", "a/\r/b", false],
      ["a/**", "a/\u2028", false],
      ["**b", "a\u2029b", false],
      ["*", "a\nb", true],
      ["!x/*", "!x/a", true],
      ["!x/*", "y/a", false],
      ["{a,b}", "{a,b}", true],
      ["{a,b}", "a", false],
      ["[ab]", "[ab]", true],
      ["[ab]", "a", false],
      ["+(a)", "+(a)", true],
      ["+(a)", "a", false],
      ["(a|b)*", "(a|b)x", true],
      ["(a|b)*", "a", false],
      ["(a|b)*", "b", false],
      ["a.b", "axb", false],
    ];
    for (const [glob, path, expected] of cases)
      expect.soft(matchesGlob(path, glob), `${glob} on ${path}`).toBe(expected);
    expect(globBase("{a,b}/[x]/*")).toBe("{a,b}/[x]");
  });

  it("rejects an oversized skills pattern when reading the manifest", () => {
    expect(() =>
      parseManifest("m.json", { sources: [{ id: "local", local: ".", skills: "?".repeat(8193) }] }),
    ).toThrow(/sources.*skills.*8192/);
  });

  it("bounds the total matching work across candidates in a source filter", () => {
    const manifest = parseManifest("m.json", {
      sources: [{ id: "many", local: ".", skills: "*?".repeat(128) + "b" }],
    });
    const found = Array.from({ length: 256 }, (_, index) => ({
      name: `skill-${index}`,
      dir: ".",
      path: "a".repeat(512) + index,
    }));
    expect(() => select(manifest.sources[0]!, found, [])).toThrow(/many.*skills glob.*work limit/);
  });

  it("answers fast for a pathological glob on a long path that almost matches", () => {
    const cases: [string, string][] = [
      [`${"*a".repeat(30)}*b`, "a".repeat(2000)],
      [`${"**/".repeat(30)}x`, `${"a/".repeat(1000)}y`],
      [`${"**a".repeat(30)}**b`, "a".repeat(2000)],
      [`${"*?".repeat(30)}/z`, "a".repeat(2000)],
      ["(a+)+$".repeat(10), "a".repeat(2000)],
      // A long chain of stars: closures per state would take memory in its length squared.
      ["*".repeat(5_000) + "b", "a".repeat(200)],
    ];
    for (const [glob, path] of cases) {
      const started = performance.now();
      expect(matchesGlob(path, glob)).toBe(false);
      // A backtracking matcher takes seconds on these; CI machines vary, so the bound is loose.
      expect(performance.now() - started, glob).toBeLessThan(500);
    }
  });
});

describe("tar archives", () => {
  const end = Buffer.alloc(1024);
  const file = (name: string, body: string | Buffer) => {
    const bytes = Buffer.from(body);
    return [tarHeader(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
  };

  it("counts entries node-tar ignores toward the entry limit", () => {
    // An unknown type, which node-tar ignores instead of handing to onReadEntry.
    const tar = Buffer.concat([
      ...Array.from({ length: 50_001 }, (_, i) => tarHeader(`p/x${i}`, 0, "Z")),
      end,
    ]);
    expect(tar.length).toBeLessThan(100 * 1024 * 1024);
    expect(() => tarFileSizes(tar)).toThrow(/more than 50000 entries/);
    expect(() => readTgz(gzipSync(tar))).toThrow(/more than 50000 entries/);
  });

  it("refuses more than 50,000 files", () => {
    const tar = Buffer.concat([
      ...Array.from({ length: 50_001 }, (_, i) => tarHeader(`p/f${i}`, 0)),
      end,
    ]);
    expect(() => readTgz(gzipSync(tar))).toThrow(/more than 50000 entries/);
  });

  it.each(["L", "x"])("counts %s metadata even with an empty body", (type) => {
    const payload = Buffer.from(type === "L" ? "p/long\0" : "15 path=p/long\n");
    const meta = Buffer.concat([
      tarHeader("meta", payload.length, type),
      payload,
      Buffer.alloc(512 - payload.length),
    ]);
    const empty = tarHeader("meta", 0, type);
    const headers = Array.from({ length: 49_999 }, (_, index) => (index % 2 ? empty : meta));
    const last = tarHeader("p/a.md", 0);
    expect(tarFileSizes(Buffer.concat([...headers, last, end]))).toEqual([
      { name: "p/long", size: 0 },
    ]);
    const tar = Buffer.concat([...headers, empty, last, end]);
    expect(() => tarFileSizes(tar)).toThrow(/more than 50000 entries/);
    expect(() => readTgz(gzipSync(tar))).toThrow(/more than 50000 entries/);
  });

  it("refuses a tar gzipped twice and a header with a bad checksum", () => {
    const tar = Buffer.concat([...file("p/a.md", "a"), end]);
    expect(() => readTgz(gzipSync(gzipSync(tar)))).toThrow(/gzipped twice/);
    const bad = Buffer.from(tar);
    bad[0] = "q".charCodeAt(0);
    expect(() => readTgz(gzipSync(bad))).toThrow(/checksum/);
    expect(() => tarFileSizes(bad)).toThrow(/checksum/);
  });

  it("refuses a link or a path out of the package before reading its body", () => {
    const link = Buffer.concat([tarHeader("p/l", 0, "2", "/etc/passwd"), end]);
    expect(() => readTgz(gzipSync(link))).toThrow(/archive entry p\/l is a link/);
    const out = Buffer.concat([...file("../x.md", "x"), end]);
    expect(() => readTgz(gzipSync(out))).toThrow(/would be written outside the package/);
  });

  it("reads files of every size, and only names and sizes for the index check", () => {
    const big = Buffer.alloc(200_000, "b");
    const tar = Buffer.concat([
      ...file("p/empty.md", ""),
      ...file("p/SKILL.md", "hello"),
      ...file("p/big.bin", big),
      tarHeader("p/dir/", 0, "5"),
      end,
    ]);
    const files = readTgz(gzipSync(tar));
    expect([...files.keys()]).toEqual(["p/empty.md", "p/SKILL.md", "p/big.bin"]);
    expect(Buffer.from(files.get("p/empty.md")!).toString()).toBe("");
    expect(Buffer.from(files.get("p/SKILL.md")!).toString()).toBe("hello");
    expect(Buffer.from(files.get("p/big.bin")!).equals(big)).toBe(true);
    expect(tarFileSizes(tar)).toEqual([
      { name: "p/empty.md", size: 0 },
      { name: "p/SKILL.md", size: 5 },
      { name: "p/big.bin", size: 200_000 },
    ]);
  });
});

describe("well-known index", () => {
  it("6a. installs skills whose archive matches the digest, from v0.2.0 and v0.1 indexes", async () => {
    const m = machine();
    const v2 = await http();
    serveIndexV2(v2, [
      {
        name: "archived",
        files: { "SKILL.md": skillMd("archived"), "scripts/run.sh": "echo hi\n" },
      },
      { name: "second", files: { "SKILL.md": skillMd("second") } },
    ]);
    const v1 = await http();
    serveIndexV1(v1, [
      { name: "legacy", files: { "SKILL.md": skillMd("legacy"), "extra.md": "extra\n" } },
    ]);
    const manifest = m.manifest({
      agents: ["claude-code", "cursor"],
      sources: [
        { id: "drop", index: v2.url, exclude: ["second"] },
        { id: "old", index: v1.url },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["archived", "legacy"]);
    expect(read(m.at(".cursor/skills/archived/scripts/run.sh"))).toBe("echo hi\n");
    expect(read(m.at(".claude/skills/legacy/extra.md"))).toBe("extra\n");
  });

  it("6b. rejects a tampered archive and keeps the last good copy", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "signed", files: { "SKILL.md": skillMd("signed") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(read(m.at(".claude/skills/signed/SKILL.md"))).toBe(skillMd("signed"));

    serveIndexV2(site, [
      { name: "signed", files: { "SKILL.md": skillMd("signed", "v2") }, tamper: true },
    ]);
    const result = await m.run("sync", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { errors: string[]; warnings: string[] };
    expect(report.errors.join("\n")).toMatch(/digest/i);
    expect(report.warnings.join("\n")).toContain("kept the last good copy");
    expect(read(m.at(".claude/skills/signed/SKILL.md"))).toBe(skillMd("signed"));
  });

  it("6c. rejects an archive entry that escapes the skill folder", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "good", files: { "SKILL.md": skillMd("good") } }]);
    // An archive whose digest matches but that writes ../escaped.md.
    const evil = tgz({ "SKILL.md": skillMd("evil"), "../escaped.md": "outside\n" });
    site.routes.set("/.well-known/agent-skills/evil.tar.gz", {
      body: evil,
      type: "application/gzip",
    });
    const index = JSON.parse(
      String(site.routes.get("/.well-known/agent-skills/index.json")!.body),
    ) as { skills: object[] };
    index.skills.push({
      name: "evil",
      type: "archive",
      description: "The evil skill",
      url: "evil.tar.gz",
      digest: `sha256:${sha256(evil)}`,
    });
    site.routes.set("/.well-known/agent-skills/index.json", {
      body: JSON.stringify(index),
      type: "application/json",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["good"]);
    expect(init.stdout).toContain('site: rejected "evil"');
    expect(names(join(m.stateDir, "store", "site"))).not.toContain("escaped.md");
    expect(names(m.at(".claude"))).not.toContain("escaped.md");
  });

  it("6d. keeps the last good copy with a warning when the index is unreachable or --offline is set", async () => {
    const m = machine();
    const site = await http();
    serveIndexV2(site, [{ name: "cached", files: { "SKILL.md": skillMd("cached") } }]);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "site", index: site.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    await site.close();

    const down = await m.run("sync");
    expect(down.code).toBe(1);
    expect(down.stdout).toContain("warning: site: kept the last good copy");
    expect(read(m.at(".claude/skills/cached/SKILL.md"))).toBe(skillMd("cached"));
    expect(isLink(m.at(".claude/skills/cached"))).toBe(true);

    const offline = await m.json("sync", "--offline");
    expect(offline.ok).toBe(true);
    expect(offline.sources[0]!.status).toBe("offline");
    expect(names(m.at(".claude/skills"))).toEqual(["cached"]);
  });
});

/** An index server like `http()` that never answers a request for a path in `stall`. */
async function stallingHttp(): Promise<Omit<Http, "named" | "redirects"> & { stall: Set<string> }> {
  const routes: Http["routes"] = new Map();
  const stall = new Set<string>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (stall.has(path)) return;
    const route = routes.get(path);
    if (route) res.writeHead(200, { "content-type": route.type }).end(route.body);
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    routes,
    stall,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

describe("an index server that stalls on one skill", () => {
  // `skills` loads every skill of an index at once, so when one file besides a SKILL.md does not
  // download, no skill of the index comes through, and all keep their copies.
  const cases = [
    { label: "v0.2 archive", v1: false, stalls: "/.well-known/agent-skills/flaky.tar.gz" },
    { label: "v0.1 SKILL.md", v1: true, stalls: "/.well-known/skills/flaky/SKILL.md" },
    { label: "v0.1 extra file", v1: true, stalls: "/.well-known/skills/flaky/extra.md", all: true },
  ];
  for (const { label, v1, stalls, all } of cases)
    it(`6e. keeps the last good copy of that skill and reports it (${label})`, async () => {
      const m = machine();
      const site = await stallingHttp();
      const serve = (tag?: string) => {
        const list = ["good", "flaky"].map((name) => ({
          name,
          files: { "SKILL.md": skillMd(name, tag), "extra.md": `extra ${tag ?? "v1"}\n` },
        }));
        if (v1) serveIndexV1(site, list);
        else serveIndexV2(site, list);
      };
      serve();
      try {
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "site", index: site.url }],
        });
        const init = await m.run("init", manifest, "--no-hooks");
        expect(init.code, init.stdout + init.stderr).toBe(0);
        const flaky = m.at(".claude", "skills", "flaky", "SKILL.md");
        expect(read(flaky)).toBe(skillMd("flaky"));

        serve("v2");
        site.stall.add(stalls);
        const run = await m.runWith({ env: { FLEETRC_FETCH_WAIT_MS: "1000" } }, "sync", "--json");
        const report = JSON.parse(run.stdout) as {
          errors: string[];
          skills: { removed: string[] };
        };
        expect(run.code).toBe(1);
        expect(report.errors.join("\n")).toContain(
          all ? 'for skill "flaky"' : '"flaky" did not download',
        );
        expect(report.skills.removed).toEqual([]);
        expect(read(m.at(".claude", "skills", "good", "SKILL.md"))).toBe(
          all ? skillMd("good") : skillMd("good", "v2"),
        );
        expect(read(flaky)).toBe(skillMd("flaky"));
        expect(existsSync(join(m.stateDir, "store", "site", "live", "flaky", "SKILL.md"))).toBe(
          true,
        );

        // Still recorded: the next sync with the server well updates it like any other.
        site.stall.clear();
        const healed = await m.run("sync");
        expect(healed.code, healed.stdout + healed.stderr).toBe(0);
        expect(read(flaky)).toBe(skillMd("flaky", "v2"));
      } finally {
        await site.close();
      }
    }, 60_000);
});

describe("npm and local sources", () => {
  it("7a. installs skills from an npm package and follows its dist-tag", async () => {
    const m = machine();
    const registry = await http();
    publishNpm(
      registry,
      "@acme/skills",
      {
        "1.0.0": { "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1") },
        "1.1.0": {
          "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1.1"),
          "skills/npm-extra/SKILL.md": skillMd("npm-extra"),
        },
      },
      "1.0.0",
    );
    const manifest = m.manifest({
      agents: ["claude-code", "opencode"],
      sources: [{ id: "acme", npm: "@acme/skills", registry: registry.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".config/opencode/skills"))).toEqual(["npm-skill"]);
    expect(read(m.at(".claude/skills/npm-skill/SKILL.md"))).toBe(skillMd("npm-skill", "v1"));

    publishNpm(
      registry,
      "@acme/skills",
      {
        "1.0.0": { "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1") },
        "1.1.0": {
          "skills/npm-skill/SKILL.md": skillMd("npm-skill", "v1.1"),
          "skills/npm-extra/SKILL.md": skillMd("npm-extra"),
        },
      },
      "1.1.0",
    );
    const report = await m.json("sync");
    expect(report.ok).toBe(true);
    expect(report.sources[0]).toMatchObject({ status: "updated", from: "1.0.0", to: "1.1.0" });
    expect(names(m.at(".claude/skills"))).toEqual(["npm-extra", "npm-skill"]);
    expect(read(m.at(".claude/skills/npm-skill/SKILL.md"))).toBe(skillMd("npm-skill", "v1.1"));
  });

  it("7b. rejects an npm tarball whose integrity does not match", async () => {
    const m = machine();
    const registry = await http();
    publishNpm(registry, "bad-pkg", { "1.0.0": { "skills/x/SKILL.md": skillMd("x") } }, "1.0.0");
    registry.routes.set("/bad-pkg-1.0.0.tgz", {
      body: tgz({ "package/skills/x/SKILL.md": skillMd("x", "swapped") }),
      type: "application/octet-stream",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ npm: "bad-pkg", registry: registry.url }],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.stdout).toContain("integrity mismatch");
    expect(names(m.at(".claude/skills"))).toEqual([]);
  });

  it("7c. links a local folder in place, and picks up new skills in it", async () => {
    const m = machine();
    const folder = join(m.root, "my-skills");
    mkdirSync(join(folder, "local-one"), { recursive: true });
    writeFileSync(join(folder, "local-one/SKILL.md"), skillMd("local-one"));
    const manifest = m.manifest({
      agents: ["claude-code", "github-copilot"],
      sources: [{ id: "here", local: folder }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(linkOf(m.at(".copilot/skills/local-one"))).toBe(join(folder, "local-one"));
    mkdirSync(join(folder, "local-two"));
    writeFileSync(join(folder, "local-two/SKILL.md"), skillMd("local-two"));
    const report = await m.json("sync");
    expect(report.skills.added).toEqual(["local-two"]);
    expect(names(m.at(".claude/skills"))).toEqual(["local-one", "local-two"]);
  });
});
