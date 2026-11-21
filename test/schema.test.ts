// schema.json documents the manifest for editors; the parser is what enforces it. They must agree.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { agentsWith, FILE_KINDS } from "../src/kinds.ts";
import { loadManifest, parseManifest } from "../src/manifest.ts";

it("limits root hook globs without dropping sources from extensions that ignore those hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleetrc-hook-globs-"));
  try {
    const root = join(dir, "root.json");
    const team = join(dir, "team.json");
    writeFileSync(root, JSON.stringify({ extends: ["./team.json"] }));
    writeFileSync(
      team,
      JSON.stringify({
        extends: ["./nested.json"],
        sources: [{ id: "team", npm: "team-skills" }],
        hooks: [{ run: "true", on: [`*:${"?".repeat(8193)}`] }],
      }),
    );
    writeFileSync(
      join(dir, "nested.json"),
      JSON.stringify({ sources: [{ id: "nested", npm: "nested-skills" }] }),
    );

    const loaded = await loadManifest(root, { offline: true });
    expect(loaded.sources.map((source) => source.id)).toEqual(["team", "nested"]);
    expect(loaded.root.hooks).toEqual([]);
    expect(loaded.failed).toEqual([]);
    expect(loaded.warnings).toEqual([expect.stringContaining("ignored hooks")]);
    await expect(loadManifest(team, { offline: true })).rejects.toThrow(
      /hooks\[0\]\.on\[0\].*8192/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Schema {
  properties: Record<string, unknown> & {
    fleet: { items: { if: { pattern: string }; then: { pattern: string } } };
  };
  $defs: {
    common: {
      properties: { id: { pattern: string; maxLength: number; not: { pattern: string } } };
    };
    source: {
      oneOf: {
        required: string[];
        properties: Record<string, unknown>;
        dependentRequired?: Record<string, string[]>;
      }[];
    };
  };
}
const schema = JSON.parse(readFileSync("schema.json", "utf8")) as Schema;

const samples: Record<string, unknown> = {
  $schema: "https://unpkg.com/fleetrc/schema.json",
  extends: ["./team.json"],
  agents: "all",
  sources: [],
  forks: { x: { from: "a/b", path: "skills/x", base: "abc" } },
  hooks: [{ name: "h", run: "true", on: ["personal:**"] }],
  fleet: ["host", "tag:servers"],
  hub: "https://hub.example",
  report: { run: "true" },
  timer: { cron: "0 * * * *", timeZone: "UTC" },
};

const sourceSamples: Record<string, unknown> = {
  id: "x",
  skills: "skills/*",
  include: ["a"],
  exclude: ["b"],
  update: "review",
  git: "a/b",
  ref: "main",
  path: "/tmp/x",
  adopt: true,
  followLinks: true,
  index: "https://example.com",
  npm: "pkg",
  registry: "https://registry.example",
  local: "/tmp/y",
  instructions: "AGENTS.md",
  subagents: { "claude-code": "agents/*.md", opencode: "opencode/agents/*.md" },
  commands: "commands/**/*.md",
};

describe("schema.json", () => {
  it("lists exactly the root fields the parser accepts", () => {
    for (const key of Object.keys(schema.properties))
      expect(() => parseManifest("m.json", { [key]: samples[key] }), key).not.toThrow();
    expect(() => parseManifest("m.json", { unknown: 1 })).toThrow(
      "unknown is not a manifest field",
    );
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(samples).sort());
  });

  it("lists exactly the source fields the parser accepts for each kind", () => {
    for (const variant of schema.$defs.source.oneOf) {
      const kind = variant.required[0]!;
      const source = Object.fromEntries(
        Object.keys(variant.properties).map((key) => [key, sourceSamples[key]]),
      );
      expect(() => parseManifest("m.json", { sources: [source] }), kind).not.toThrow();
      for (const key of Object.keys(sourceSamples)) {
        if (key in variant.properties) continue;
        expect(
          () => parseManifest("m.json", { sources: [{ ...source, [key]: sourceSamples[key] }] }),
          `${kind}.${key}`,
        ).toThrow();
      }
    }
  });

  it("takes a source id exactly when the parser does", () => {
    const rule = schema.$defs.common.properties.id;
    const schemaTakes = (id: string) =>
      new RegExp(rule.pattern).test(id) &&
      id.length <= rule.maxLength &&
      !new RegExp(rule.not.pattern).test(id);
    const parserTakes = (id: string) => {
      try {
        parseManifest("m.json", { sources: [{ id, local: "/tmp/x" }] });
        return true;
      } catch {
        return false;
      }
    };
    for (const id of [
      "x",
      "My_source.2",
      "con",
      "CON",
      "aux.md",
      "nul.",
      "lpt1",
      "com9.x",
      "console",
      "-x",
      ".x",
      "a b",
      "a".repeat(255),
      "a".repeat(256),
    ])
      expect(schemaTakes(id), id).toBe(parserTakes(id));
  });

  it("takes a fleet tag exactly when the parser does", () => {
    const { items } = schema.properties.fleet;
    const schemaTakes = (entry: string) =>
      !new RegExp(items.if.pattern).test(entry) || new RegExp(items.then.pattern).test(entry);
    const parserTakes = (entry: string) => {
      try {
        parseManifest("m.json", { fleet: [entry] });
        return true;
      } catch {
        return false;
      }
    };
    for (const entry of [
      "tag:servers",
      "tag:web-1",
      "tag:Servers",
      "tag:",
      "tag:1web",
      "tag:web_1",
      "tag:web.prod",
      "tag:-web",
      "tag:a b",
      "laptop",
      "me@vps",
      "tagged-box",
    ])
      expect(schemaTakes(entry), entry).toBe(parserTakes(entry));
    expect(() => parseManifest("m.json", { fleet: ["laptop", "tag:web_1"] })).toThrow(
      'm.json: fleet[1] "tag:web_1" is not a Tailscale tag: write tag: and then a letter followed by letters, digits or dashes, such as "tag:servers"',
    );
  });

  it("names, for each kind of file, exactly the agents the parser takes", () => {
    const common = schema.$defs.common.properties as unknown as Record<
      string,
      { oneOf: { propertyNames?: { enum: string[] } }[] }
    >;
    for (const kind of FILE_KINDS)
      expect(common[kind]!.oneOf[1]!.propertyNames!.enum, kind).toEqual(agentsWith(kind));
  });

  it("asks for path wherever the parser does: adopt and followLinks on a git source", () => {
    const git = schema.$defs.source.oneOf.find((variant) => variant.required[0] === "git")!;
    expect(git.dependentRequired).toEqual({ adopt: ["path"], followLinks: ["path"] });
    for (const key of ["adopt", "followLinks"]) {
      expect(() => parseManifest("m.json", { sources: [{ git: "a/b", [key]: true }] })).toThrow(
        `${key} only applies to git sources with a path`,
      );
      expect(() =>
        parseManifest("m.json", { sources: [{ git: "a/b", path: "/tmp/x", [key]: true }] }),
      ).not.toThrow();
    }
  });
});
