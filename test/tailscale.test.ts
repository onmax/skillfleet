import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { machine, type Machine, names, remote, sha256, skills } from "./fixture.ts";

/**
 * A fake `tailscale` for FLEETRC_TAILSCALE that prints `<dir>/status.json`, so a test can change
 * the policy between runs, and touches `<dir>/tailscale-ran`.
 */
function fakeTailscale(m: Machine) {
  const dir = join(m.root, "tailscale");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tailscale.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "tailscale-ran"))}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(join(dir, "status.json"))}, "utf8"));`,
  );
  const status = join(dir, "status.json");
  return {
    env: { FLEETRC_TAILSCALE: script },
    ran: join(dir, "tailscale-ran"),
    /** The policy hands this machine `values` under fleetrc's capability, or nothing. */
    policy(values?: unknown[]) {
      const capMap = values ? { "github.com/onmax/fleetrc": values } : {};
      writeFileSync(
        status,
        JSON.stringify({ BackendState: "Running", Self: { PublicKey: "self", CapMap: capMap } }),
      );
    },
  };
}

const config = (m: Machine) =>
  JSON.parse(readFileSync(m.at(".config/fleetrc/config.json"), "utf8")) as Record<string, unknown>;

function team(m: Machine, name: string, skill: string) {
  const vendor = remote(m, `${name}-skills`, skills("skills/", skill));
  return remote(m, name, {
    ".fleetrc/manifest.json": JSON.stringify({
      agents: ["claude-code"],
      sources: [{ id: name, git: vendor.https }],
    }),
  });
}

describe("the manifest from the tailnet policy", () => {
  it("a new machine runs bare init and syncs the manifest the policy names", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "from-tailnet").https }]);
    const run = await m.runWith({ env: tailscale.env }, "init", "--no-hooks");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(tailscale.ran, "utf8")).toBe("status --json --peers=false\n");
    expect(config(m)).toMatchObject({
      manifest: "https://git.fleetrc.test/home.git//.fleetrc/manifest.json",
      tailscale: true,
    });
    expect(names(m.at(".claude/skills"))).toEqual(["from-tailnet"]);
    const status = await m.runWith({ env: tailscale.env }, "status");
    expect(status.stdout).toContain("(from the tailnet policy)");
  });

  it("each sync follows the policy to a new manifest, and keeps the last one when Tailscale can't say", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);

    const replacement = team(m, "moved", "second");
    tailscale.policy([{ manifest: replacement.https }]);
    const moved = await m.runWith({ env: tailscale.env }, "sync");
    expect(moved.code, moved.stdout + moved.stderr).toBe(0);
    expect(moved.stdout + moved.stderr).toContain("the tailnet policy now names the manifest");
    expect(config(m).manifest).toBe("https://git.fleetrc.test/moved.git//.fleetrc/manifest.json");
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);

    const offline = await m.runWith(
      { env: tailscale.env },
      "sync",
      "--offline",
      "--manifest",
      replacement.https,
    );
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);

    tailscale.policy();
    const kept = await m.runWith({ env: tailscale.env }, "sync");
    expect(kept.code, kept.stdout + kept.stderr).toBe(0);
    expect(kept.stdout + kept.stderr).toContain("kept the manifest");
    expect(config(m).manifest).toBe("https://git.fleetrc.test/moved.git//.fleetrc/manifest.json");
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);
  });

  it("preserves the validated checkout when a policy alias is rejected", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);

    const replacement = team(m, "replacement", "second");
    const url = "https://github.com/example/replacement.git";
    m.git(m.root, "config", "--global", `url.${replacement.served}.insteadOf`, url);
    tailscale.policy([{ manifest: "github:example/replacement" }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);
    const before = config(m);
    expect(before.manifest).toBe("github:example/replacement//.fleetrc/manifest.json");

    replacement.commit({ ".fleetrc/manifest.json": null, "README.md": "Manifest removed\n" });
    const alias = `${url}//.fleetrc/manifest.json`;
    tailscale.policy([{ manifest: alias }]);
    const rejected = await m.runWith({ env: tailscale.env }, "sync");
    expect(rejected.code, rejected.stdout + rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain("has no .fleetrc/manifest.json");
    expect(config(m)).toEqual(before);

    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);

    replacement.commit({
      ".fleetrc/manifest.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    const accepted = await m.runWith({ env: tailscale.env }, "sync");
    expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
    expect(config(m).manifest).toBe(alias);
    const override = await m.runWith(
      { env: tailscale.env },
      "sync",
      "--offline",
      "--manifest",
      "github:example/replacement",
    );
    expect(override.code, override.stdout + override.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual([]);
  });

  it("preserves both active forge alias checkouts when a policy switch is rejected", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const vendor = remote(m, "vendor", skills("skills/", "from-team"));
    const upstream = remote(m, "upstream", {
      "first.json": JSON.stringify({ sources: [] }),
      "second.json": JSON.stringify({ sources: [{ id: "vendor", git: vendor.https }] }),
    });
    const page = "https://github.com/example/upstream";
    const clone = `${page}.git`;
    const homeUrl = "https://github.com/example/home.git";
    const home = remote(m, "home", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        extends: [`${page}//first.json`, `${clone}//second.json`],
        sources: [],
      }),
    });
    m.git(m.root, "config", "--global", `url.${upstream.served}.insteadOf`, page);
    m.git(m.root, "config", "--global", "--add", `url.${upstream.served}.insteadOf`, clone);
    m.git(m.root, "config", "--global", `url.${home.served}.insteadOf`, homeUrl);
    tailscale.policy([{ manifest: "github:example/home" }]);
    const init = await m.runWith({ env: tailscale.env }, "init", "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const before = config(m);

    const hash = (value: string) => sha256(Buffer.from(value));
    const cache = join(m.stateDir, "cache");
    const root = join(
      cache,
      "tailnet-manifests",
      hash(JSON.stringify([homeUrl, ".fleetrc/manifest.json", undefined])).slice(0, 32),
    );
    const pageKey = hash(`${page}#`);
    const cloneKey = hash(`${clone}#`);
    for (const [slot, key] of [
      ["a", pageKey],
      ["b", cloneKey],
    ] as const) {
      mkdirSync(join(root, slot), { recursive: true });
      for (const suffix of ["", ".git", ".json"]) {
        cpSync(
          join(cache, "manifests", `${pageKey.slice(0, 16)}${suffix}`),
          join(root, slot, `${key.slice(0, 16)}${suffix}`),
          { recursive: true },
        );
      }
    }
    writeFileSync(
      join(root, "validated.json"),
      JSON.stringify({ slots: { "*": "shared", [pageKey]: "a", [cloneKey]: "b" } }),
    );
    const beforeSwitch = await m.runWith({ env: tailscale.env }, "sync", "vendor", "--offline");
    expect(beforeSwitch.code, beforeSwitch.stdout + beforeSwitch.stderr).toBe(0);

    upstream.commit({ "second.json": JSON.stringify({ sources: [] }) });
    tailscale.policy([{ manifest: `${homeUrl}//.fleetrc/manifest.json` }]);
    const rejected = await m.runWith({ env: tailscale.env }, "sync", "vendor");
    expect(rejected.code, rejected.stdout + rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain('no source "vendor"');
    expect(config(m)).toEqual(before);

    const offline = await m.runWith({ env: tailscale.env }, "sync", "vendor", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["from-team"]);
  });

  it("preserves managed copy edits across policy aliases at the same commit", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const repository = remote(m, "bundled", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "bundled", local: "../skills" }],
      }),
      ...skills("skills/", "bundled"),
    });
    const url = "https://github.com/example/bundled.git";
    const page = url.slice(0, -4);
    m.git(m.root, "config", "--global", "--add", `url.${repository.served}.insteadOf`, page);
    m.git(m.root, "config", "--global", "--add", `url.${repository.served}.insteadOf`, url);
    tailscale.policy([{ manifest: page }]);
    const init = await m.runWith({ env: tailscale.env }, "init", "--no-hooks", "--copy");
    expect(init.code, init.stdout + init.stderr).toBe(0);

    const copy = m.at(".claude/skills/bundled/SKILL.md");
    const edited = readFileSync(copy, "utf8") + "\nMy local edit.\n";
    writeFileSync(copy, edited);
    const cached = await m.runWith({ env: tailscale.env }, "sync", "--offline", "--manifest", url);
    expect(cached.code, cached.stdout + cached.stderr).toBe(0);
    const alias = `${url}//.fleetrc/manifest.json`;
    tailscale.policy([{ manifest: alias }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);
    expect(config(m).manifest).toBe(alias);
    expect(readFileSync(copy, "utf8")).toBe(edited);

    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(readFileSync(copy, "utf8")).toBe(edited);
  });

  it("keeps root copy edits when a policy alias refreshes a remote team manifest", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const upstream = remote(m, "upstream", { "team.json": JSON.stringify({ sources: [] }) });
    const vendor = remote(m, "vendor", skills("skills/", "from-team"));
    const repository = remote(m, "bundled", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        extends: [`${upstream.https}//team.json`],
        sources: [{ id: "bundled", local: "../skills" }],
      }),
      ...skills("skills/", "bundled"),
    });
    const url = "https://github.com/example/bundled.git";
    m.git(m.root, "config", "--global", `url.${repository.served}.insteadOf`, url);
    tailscale.policy([{ manifest: "github:example/bundled" }]);
    const init = await m.runWith({ env: tailscale.env }, "init", "--no-hooks", "--copy");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const copy = m.at(".claude/skills/bundled/SKILL.md");
    const edited = readFileSync(copy, "utf8") + "\nMy local edit.\n";
    writeFileSync(copy, edited);

    upstream.commit({
      "team.json": JSON.stringify({ sources: [{ id: "vendor", git: vendor.https }] }),
    });
    const alias = `${url}//.fleetrc/manifest.json`;
    tailscale.policy([{ manifest: alias }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["bundled", "from-team"]);
    expect(readFileSync(copy, "utf8")).toBe(edited);

    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["bundled", "from-team"]);
    expect(readFileSync(copy, "utf8")).toBe(edited);
  });

  it("keeps the saved policy alias usable offline after a same-repo override", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const repository = remote(m, "saved", {
      ".fleetrc/manifest.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    const url = "https://github.com/example/saved.git";
    m.git(m.root, "config", "--global", `url.${repository.served}.insteadOf`, url);
    tailscale.policy([{ manifest: "github:example/saved" }]);
    const init = await m.runWith({ env: tailscale.env }, "init", "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    const alias = `${url}//.fleetrc/manifest.json`;
    tailscale.policy([{ manifest: alias }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);

    repository.commit({
      ".fleetrc/manifest.json": null,
      "alternate.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    const override = `${url}//alternate.json`;
    const online = await m.runWith({ env: tailscale.env }, "sync", "--manifest", override);
    expect(online.code, online.stdout + online.stderr).toBe(0);
    expect(config(m).manifest).toBe(alias);
    for (const manifest of [
      [],
      ["--manifest", url],
      ["--manifest", alias],
      ["--manifest", override],
    ]) {
      const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline", ...manifest);
      expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    }
  });

  it("shares the isolated override checkout with read-only commands", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const repository = team(m, "saved", "from-tailnet");
    tailscale.policy([{ manifest: repository.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    repository.commit({
      ".fleetrc/manifest.json": null,
      "alternate.json": JSON.stringify({ agents: ["codex"], sources: [] }),
    });
    const override = `${repository.https}//alternate.json`;
    const synced = await m.runWith({ env: tailscale.env }, "sync", "--manifest", override);
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    const listed = await m.runWith({ env: tailscale.env }, "agents", "--manifest", override);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
  });

  it("keeps the saved manifest offline after timer install fetches an override", async () => {
    const m = machine({ scheduler: "refuse" });
    const tailscale = fakeTailscale(m);
    const repository = team(m, "saved", "from-tailnet");
    tailscale.policy([{ manifest: repository.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    repository.commit({
      ".fleetrc/manifest.json": null,
      "alternate.json": JSON.stringify({ agents: ["codex"], sources: [] }),
    });
    const override = `${repository.https}//alternate.json`;
    const timer = await m.runWith(
      { env: tailscale.env },
      "timer",
      "install",
      "--manifest",
      override,
    );
    expect(timer.code, timer.stdout + timer.stderr).toBe(1);
    expect(m.schedulerCalls().length).toBeGreaterThan(0);
    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["from-tailnet"]);

    const adopted = await m.runWith(
      { env: tailscale.env },
      "init",
      "--offline",
      "--force",
      "--no-hooks",
      override,
    );
    expect(adopted.code, adopted.stdout + adopted.stderr).toBe(0);
    expect(config(m).manifest).toBe(override);
    expect(config(m).tailscale).toBeUndefined();
    const afterward = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(afterward.code, afterward.stdout + afterward.stderr).toBe(0);
  });

  it("a dry-run sync names the new manifest without saving it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    tailscale.policy([{ manifest: team(m, "moved", "second").https }]);
    const dry = await m.runWith({ env: tailscale.env }, "sync", "--dry-run");
    expect(dry.code, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout + dry.stderr).toContain("moved.git");
    expect(config(m).manifest).toBe("https://git.fleetrc.test/home.git//.fleetrc/manifest.json");
  });

  it("does not save a policy repository whose manifest cannot be loaded", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m);

    const missing = remote(m, "missing-manifest", { "README.md": "empty" });
    tailscale.policy([{ manifest: missing.https }]);
    const failed = await m.runWith({ env: tailscale.env }, "sync");
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(config(m)).toEqual(before);
    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    tailscale.policy();
    const kept = await m.runWith({ env: tailscale.env }, "sync");
    expect(kept.code, kept.stdout + kept.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
  });

  it("preserves the offline checkout after a rejected file switch in the same repository", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m);

    home.commit({
      ".fleetrc/manifest.json": null,
      "new.json": JSON.stringify({ agents: ["claude-code"], sources: [] }),
    });
    tailscale.policy([{ manifest: `${home.https}//missing.json` }]);
    const failed = await m.runWith({ env: tailscale.env }, "sync");
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(failed.stderr).toContain("has no missing.json");
    expect(config(m)).toEqual(before);
    const offline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(offline.code, offline.stdout + offline.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);

    const replacement = `${home.https}//new.json`;
    tailscale.policy([{ manifest: replacement }]);
    const switched = await m.runWith({ env: tailscale.env }, "sync");
    expect(switched.code, switched.stdout + switched.stderr).toBe(0);
    expect(config(m).manifest).toBe(replacement);
    const switchedOffline = await m.runWith({ env: tailscale.env }, "sync", "--offline");
    expect(switchedOffline.code, switchedOffline.stdout + switchedOffline.stderr).toBe(0);
  });

  it("accepts --manifest tailscale: for init", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    const run = await m.runWith(
      { env: tailscale.env },
      "init",
      "--manifest",
      "tailscale:",
      "--no-hooks",
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m).tailscale).toBe(true);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
  });

  it("a machine set up with a manifest of its own never asks Tailscale", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "other", "unwanted").https }]);
    const own = team(m, "own", "mine");
    expect((await m.runWith({ env: tailscale.env }, "init", own.https, "--no-hooks")).code).toBe(0);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    expect((await m.runWith({ env: tailscale.env }, "sync")).code).toBe(0);
    expect(existsSync(tailscale.ran)).toBe(false);
    expect(config(m).tailscale).toBeUndefined();
    expect(names(m.at(".claude/skills"))).toEqual(["mine"]);
  });

  it("init with a manifest on a machine that followed the tailnet stops following it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: team(m, "home", "first").https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const own = team(m, "own", "mine");
    // Switching manifests drops the old one's skills, which init asks --force for.
    const run = await m.runWith({ env: tailscale.env }, "init", own.https, "--no-hooks", "--force");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m).tailscale).toBeUndefined();
    rmSync(tailscale.ran);
    expect((await m.runWith({ env: tailscale.env }, "sync")).code).toBe(0);
    expect(existsSync(tailscale.ran)).toBe(false);
  });

  it("owner/repo in the policy is GitHub's even beside a folder of that name", async () => {
    const m = machine();
    mkdirSync(m.at("me/skills/.fleetrc"), { recursive: true });
    writeFileSync(m.at("me/skills/.fleetrc/manifest.json"), JSON.stringify({ sources: [] }));
    const tailscale = fakeTailscale(m);
    tailscale.policy([{ manifest: "me/skills" }]);
    const run = await m.runWith(
      { env: tailscale.env },
      "init",
      "--dry-run",
      "--offline",
      "--no-hooks",
    );
    expect(run.stdout + run.stderr).not.toContain("not in a repository");
    expect(run.stdout + run.stderr).toContain("github.com/me/skills");
  });

  it("init that names the manifest the tailnet gave, with an option, keeps following it", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    const home = team(m, "home", "first");
    tailscale.policy([{ manifest: home.https }]);
    expect((await m.runWith({ env: tailscale.env }, "init", "--no-hooks")).code).toBe(0);
    const before = config(m).manifest;
    tailscale.policy([{ manifest: team(m, "moved", "second").https }]);
    rmSync(tailscale.ran);
    const run = await m.runWith({ env: tailscale.env }, "init", home.https, "--no-hooks", "--copy");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(config(m)).toMatchObject({ manifest: before, tailscale: true, copy: true });
    expect(existsSync(tailscale.ran)).toBe(false);
    expect(names(m.at(".claude/skills"))).toEqual(["first"]);
    const synced = await m.runWith({ env: tailscale.env }, "sync");
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["second"]);
  });

  it("bare init without Tailscale or without a policy entry says what init needs", async () => {
    const m = machine();
    const missing = await m.runWith(
      { env: { FLEETRC_TAILSCALE: join(m.root, "no-tailscale") } },
      "init",
      "--no-hooks",
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("init needs a manifest");
    expect(missing.stderr).toContain("not installed");

    const tailscale = fakeTailscale(m);
    tailscale.policy();
    const none = await m.runWith({ env: tailscale.env }, "init", "tailscale:", "--no-hooks");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('"nodeAttrs"');
    expect(existsSync(m.at(".config/fleetrc/config.json"))).toBe(false);
  });

  it("a policy that names a folder on this machine, or an option, is refused", async () => {
    const m = machine();
    const tailscale = fakeTailscale(m);
    for (const manifest of [m.root, "./skills", "config/team.json", "-oProxyCommand=x", "-o/x"]) {
      tailscale.policy([{ manifest }]);
      const run = await m.runWith(
        { env: tailscale.env },
        "init",
        "tailscale:",
        "--offline",
        "--no-hooks",
      );
      expect(run.code, manifest).toBe(1);
      expect(run.stderr).toContain("not in a repository");
    }
    expect(existsSync(m.at(".config/fleetrc/config.json"))).toBe(false);
  });
});
