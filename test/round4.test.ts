// Round four of trying to break fleetrc, against fix/round3 (bdb972b): the user's journey from the
// README, and what rounds three and four added (lock identity, discovery containment, the team
// transport allowlist, the index download wrapper, refused names). Each test asserts what fleetrc
// should do; a failing test is a break still open. Every run uses the fixture's temporary HOME, and
// every scheduler call goes to the fixture's fake.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { processStartedAt } from "../src/process.ts";
import { LockHeldError, takeLock } from "../src/lock.ts";
import {
  cli,
  clone,
  isWindows,
  machine,
  type Machine,
  names,
  read,
  remote,
  type Report,
  sha256,
  skillMd,
  skills,
  tgz,
  writeFiles,
} from "./fixture.ts";

/** Runs init with --no-hooks and fails the test unless it exits 0. */
async function init(m: Machine, manifest: string, ...args: string[]) {
  const run = await m.run("init", manifest, "--no-hooks", ...args);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return run;
}

/** An HTTP server whose handler the test controls, for index sources that misbehave. */
async function server(
  handle: (req: IncomingMessage, res: ServerResponse, path: string) => void | Promise<void>,
) {
  const s = createServer((req, res) => {
    void handle(req, res, new URL(req.url ?? "/", "http://x").pathname);
  });
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        s.closeAllConnections();
        s.close(() => done());
      }),
  };
}

/** A v0.2.0 index body and archive bodies for `skills` (name -> files). */
function indexV2(list: Record<string, Record<string, string>>, tampered: string[] = []) {
  const archives = new Map<string, Buffer>();
  const entries = Object.entries(list).map(([name, files]) => {
    const archive = tgz(files);
    archives.set(
      `/.well-known/agent-skills/${name}.tar.gz`,
      tampered.includes(name)
        ? tgz({ ...files, "SKILL.md": `${files["SKILL.md"]}evil\n` })
        : archive,
    );
    return {
      name,
      type: "archive",
      description: `The ${name} skill`,
      url: `${name}.tar.gz`,
      digest: `sha256:${sha256(archive)}`,
    };
  });
  const index = JSON.stringify({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: entries,
  });
  return { index, archives };
}

/** Runs the CLI and kills it after `ms`; `code` is null when it had to be killed. */
function runFor(m: Machine, ms: number, ...args: string[]) {
  return new Promise<{ code: number | null; out: string; ms: number }>((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env: m.env,
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, ms: Date.now() - started });
    });
  });
}

describe("the user's journey", () => {
  it.skipIf(process.platform !== "linux")(
    "R7-1. the crontab line init prints on Linux without systemd writes to a log folder that exists, so cron runs the sync",
    async () => {
      const m = machine({ scheduler: "absent" });
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      const run = await m.run("init", manifest, "--timer");
      const said = run.stdout + run.stderr;
      const log = said.match(/sync >> '([^']+)' 2>&1/)?.[1];
      expect(log, said).toBeDefined();
      // `>> file` in cron's shell fails before fleetrc starts when the folder is missing.
      expect(existsSync(dirname(log!)), `${dirname(log!)} does not exist`).toBe(true);
      // The line itself makes the folder, for when it goes (a cleaned state folder): run it as cron would.
      const line = said.match(/\*\/30 \* \* \* \* (.*? 2>&1)/)?.[1];
      expect(line, said).toBeDefined();
      rmSync(dirname(log!), { recursive: true, force: true });
      execFileSync("/bin/sh", ["-c", line!], { env: m.env });
      expect(read(log!)).toContain("skills");
    },
  );

  it("R7-9. init's plan counts the skills of a working clone it is about to clone", async () => {
    const m = machine();
    const mine = remote(m, "mine", skills("skills/", "my-notes"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", git: mine.url, path: m.at("code", "skills"), skills: "skills/*" }],
    });
    const out = await m.json<{ plan: { after: string[] }; sync: Report }>(
      "init",
      manifest,
      "--no-hooks",
    );
    expect(out.sync.skills.names).toContain("my-notes");
    // The plan said "0 before, 0 after; none lost" and listed no names, then linked my-notes.
    expect(out.plan.after).toContain("my-notes");
  });

  it("R7-6. a sync says when a forked skill changed upstream", async () => {
    // `status` reads the timer: a scheduler with none.
    const m = machine({ scheduler: "empty" });
    const mine = remote(m, "mine", skills("skills/", "my-notes"));
    const team = remote(m, "team", skills("skills/", "team-style"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        {
          id: "mine",
          git: mine.url,
          path: m.at("code", "skills"),
          skills: "skills/*",
          adopt: true,
        },
        { id: "team", git: team.url, skills: "skills/*" },
      ],
    });
    await init(m, manifest);
    const fork = await m.run("fork", "team-style");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    const work = m.at("code", "skills");
    m.git(work, "add", "-A");
    m.git(work, "commit", "--quiet", "-m", "fork team-style");
    team.commit({ "skills/team-style/SKILL.md": skillMd("team-style", "v2 from the team") });
    const report = await m.json("sync");
    // Only "shadowed: team-style from team (mine wins)", as every sync says; sync, status and
    // doctor never say the fork is behind, so `diff`/`merge` are never suggested.
    const said = [
      ...report.pending.map((entry) => entry.skill),
      ...report.warnings,
      ...report.edited.map((entry) => entry.skill),
    ].join("\n");
    expect(said).toContain("team-style");
    expect(report.pending).toEqual([
      { source: "team", skill: "team-style", reason: "fork", files: ["SKILL.md"] },
    ]);
    // Said once: the next sync, with nothing new upstream, says nothing, and a fork you made on
    // purpose is not reported as shadowed.
    const again = await m.json("sync");
    expect(again.pending).toEqual([]);
    expect(again.shadowed).toEqual([]);
    // status keeps saying it until the fork is merged.
    const status = await m.run("status");
    expect(status.stdout).toContain(
      "team-style: upstream changed since you forked it; `fleetrc diff team-style` / `fleetrc merge team-style`",
    );
    const merged = await m.run("merge", "team-style");
    expect(merged.code, merged.stdout + merged.stderr).toBe(0);
    await m.json("sync");
    expect((await m.run("status")).stdout).not.toContain("upstream changed since you forked it");
  });

  it("R7-7. remove of a skill or a source from an extended team manifest says what to do in your own manifest", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        sources: [{ id: "vendor", git: vendor.https }],
      }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team.https], sources: [] });
    await init(m, manifest);
    expect(names(m.at(".claude", "skills"))).toEqual(["other", "tool"]);

    const skill = await m.run("remove", "tool");
    // It said: "tool comes from vendor in ~/.local/state/fleetrc/cache/manifests/<hash>/.fleetrc/manifest.json;
    // exclude it there", a cache copy the next sync overwrites.
    expect(skill.stdout + skill.stderr).not.toMatch(/cache[\\/]manifests/);

    // Your own manifest leaves the team's skill out, and the next sync unlinks it.
    expect(skill.code, skill.stdout + skill.stderr).toBe(0);
    expect(JSON.parse(read(manifest)).extends).toEqual([
      { manifest: team.https, exclude: ["tool"] },
    ]);
    expect(names(m.at(".claude", "skills"))).toEqual(["other"]);

    const source = await m.run("remove", "vendor");
    // It said: 'no source or linked skill named "vendor"', though vendor is a source of the sync.
    expect(source.stdout + source.stderr).not.toContain('no source or linked skill named "vendor"');
    expect(source.code, source.stdout + source.stderr).toBe(0);
    expect(JSON.parse(read(manifest)).extends).toEqual([
      { manifest: team.https, exclude: ["tool"], excludeSources: ["vendor"] },
    ]);
    expect(names(m.at(".claude", "skills"))).toEqual([]);
  });

  it("R7-8. after a pushed timer.cron change, `timer install` applies the new cron, as the README says", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const me = remote(m, "me", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    await init(m, me.url);
    me.commit({
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        timer: { cron: "0 * * * *" },
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    // It reads the manifest copy the last sync fetched, so it shows (and would install) "*/30 * * * *".
    const dry = await m.run("timer", "install", "--dry-run");
    expect(dry.stdout + dry.stderr).toContain('"0 * * * *"');
    // A timer installed on the old schedule (the record `timer install` keeps): the next sync says
    // once that the manifest changed it, and does not reinstall it itself.
    writeFileSync(
      join(m.stateDir, "timer.json"),
      JSON.stringify({
        spec: { name: "fleetrc-sync", cron: "*/30 * * * *", timeZone: "local" },
        files: [],
      }),
    );
    const note =
      'the manifest\'s timer is now "0 * * * *", but the installed timer runs on "*/30 * * * *"; run `fleetrc timer install` to apply it';
    expect((await m.json("sync")).warnings).toContain(note);
    expect((await m.json("sync")).warnings).not.toContain(note);
  });

  it("R7-10. add changes only the manifest lines it adds", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const extra = remote(m, "extra", skills("skills/", "lint"));
    const file = join(m.root, "manifest", ".fleetrc", "manifest.json");
    mkdirSync(dirname(file), { recursive: true });
    const text = `{\n  "agents": ["claude-code"],\n  "sources": [{ "id": "vendor", "git": ${JSON.stringify(vendor.url)} }]\n}\n`;
    writeFileSync(file, text);
    await init(m, file);
    expect((await m.run("add", extra.url, "--id", "extra")).code).toBe(0);
    // `"agents": ["claude-code"]` became three lines: every array in a hand-written manifest is reflowed.
    expect(read(file)).toContain('"agents": ["claude-code"]');
  });
});

describe("the lock's process-start identity", () => {
  it.skipIf(process.platform !== "linux")(
    "R7-2. a clock set forward during a sync (NTP at boot) does not let a second sync break the running one's lock",
    async () => {
      // A running sync: a live process. It recorded its start by its clock before NTP stepped the
      // clock an hour forward; Linux now places its start through a boot time an hour later.
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
      try {
        await new Promise((done) => setTimeout(done, 200));
        const started = processStartedAt(holder.pid!);
        expect(started).toBeDefined();
        const dir = join(machine({ agents: false }).root, "state");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "sync.lock");
        writeFileSync(
          file,
          JSON.stringify({ pid: holder.pid, started: started! - 3_600_000, at: Date.now() }),
        );
        const mine = JSON.stringify({ pid: process.pid, started: Date.now(), at: Date.now() });
        expect(() => takeLock(file, mine)).toThrow(LockHeldError);
      } finally {
        holder.kill();
      }
    },
  );

  it.skipIf(isWindows)(
    "R7-2b. a lock taken before the clock jumped more than two hours forward still guards its running sync",
    async () => {
      // A Raspberry Pi without a clock boots at its last saved time; the timer catches up at once, and
      // NTP sets the clock days ahead mid-sync. `at` is then "more than two hours old".
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
      try {
        await new Promise((done) => setTimeout(done, 200));
        const started = processStartedAt(holder.pid!) ?? Date.now();
        const dir = join(machine({ agents: false }).root, "state");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "sync.lock");
        writeFileSync(
          file,
          JSON.stringify({ pid: holder.pid, started, at: Date.now() - 3 * 86_400_000 }),
        );
        const mine = JSON.stringify({ pid: process.pid, started: Date.now(), at: Date.now() });
        expect(() => takeLock(file, mine)).toThrow(LockHeldError);
      } finally {
        holder.kill();
      }
    },
  );
});

describe("vendored copies", () => {
  it("R7-4. an edit made while a sync is fetching is not overwritten by that sync", async () => {
    const m = machine();
    let serving = indexV2({ tool: { "SKILL.md": skillMd("tool") } });
    let onArchive: (() => void) | undefined;
    const site = await server(async (_req, res, path) => {
      if (path === "/.well-known/agent-skills/index.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(serving.index);
        return;
      }
      const archive = serving.archives.get(path);
      if (!archive) {
        res.writeHead(404).end();
        return;
      }
      onArchive?.();
      res.writeHead(200, { "content-type": "application/gzip" }).end(archive);
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      await init(m, manifest);
      const skill = m.at(".claude", "skills", "tool", "SKILL.md");
      expect(read(skill)).toBe(skillMd("tool"));
      serving = indexV2({ tool: { "SKILL.md": skillMd("tool", "v2") } });
      // The user's agent saves an edit while the sync downloads the update.
      onArchive = () => appendFileSync(skill, "my edit\n");
      await m.run("sync");
      expect(read(skill)).toContain("my edit");
    } finally {
      await site.close();
    }
  });

  it("R7-13. one archive whose digest does not match holds back only that skill, not every skill of the index", async () => {
    const m = machine();
    let serving = indexV2({
      good: { "SKILL.md": skillMd("good") },
      flaky: { "SKILL.md": skillMd("flaky") },
    });
    const site = await server((_req, res, path) => {
      if (path === "/.well-known/agent-skills/index.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(serving.index);
        return;
      }
      const archive = serving.archives.get(path);
      if (archive) res.writeHead(200, { "content-type": "application/gzip" }).end(archive);
      else res.writeHead(404).end();
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      await init(m, manifest);
      // A deploy in flight: the CDN serves the new index and one archive from the old deploy (seen
      // live on drop.vitehub.dev on 2026-11-17: "Digest mismatch for skill 'vitehub-drop'").
      serving = indexV2(
        {
          good: { "SKILL.md": skillMd("good", "v2") },
          flaky: { "SKILL.md": skillMd("flaky", "v2") },
        },
        ["flaky"],
      );
      await m.run("sync");
      expect(read(m.at(".claude", "skills", "good", "SKILL.md"))).toBe(skillMd("good", "v2"));
    } finally {
      await site.close();
    }
  });

  it("R7-5. a v0.1 index server that stops answering does not hang the sync (the systemd unit has no timeout)", async () => {
    const m = machine();
    let stall = false;
    const site = await server((_req, res, path) => {
      if (path === "/.well-known/skills/index.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            skills: [{ name: "slow", description: "The slow skill", files: ["SKILL.md"] }],
          }),
        );
        return;
      }
      if (path === "/.well-known/skills/slow/SKILL.md") {
        if (stall) return; // headers never come
        res.writeHead(200, { "content-type": "text/plain" }).end(skillMd("slow"));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      await init(m, manifest);
      stall = true;
      const run = await runFor(m, 100_000, "sync");
      // Killed after 100 s: the sync waits forever, holding the lock, and every later timer run is
      // skipped as "another sync is running" (systemd starts no new run of a oneshot still active).
      expect(run.code, `killed after ${run.ms} ms:\n${run.out}`).not.toBeNull();
    } finally {
      await site.close();
    }
  }, 130_000);

  it.skipIf(isWindows)(
    "R7-19. a skill whose folder links fan out to one another (41 links) is not copied thousands of times",
    async () => {
      const m = machine();
      // d0 holds four links to d1, d1 four to d2, … d5 holds one file: 4^5 = 1024 paths reach it.
      const files: Record<string, string> = { "skills/bomb/SKILL.md": skillMd("bomb") };
      files["skills/bomb/d5/leaf.txt"] = "leaf\n";
      const vendor = remote(m, "vendor", { ...files, ...skills("skills/", "tool") });
      for (let i = 0; i < 5; i++) {
        mkdirSync(join(vendor.work, "skills", "bomb", `d${i}`), { recursive: true });
        for (const k of [1, 2, 3, 4])
          symlinkSync(`../d${i + 1}`, join(vendor.work, "skills", "bomb", `d${i}`, `l${k}`));
      }
      m.git(vendor.work, "add", "-A");
      m.git(vendor.work, "commit", "--quiet", "-m", "links");
      m.git(vendor.work, "push", "--quiet", "origin", "main");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      await init(m, manifest);
      const count = (dir: string): number =>
        existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true }).reduce(
              (sum, entry) =>
                sum + (entry.isDirectory() ? count(join(dir, entry.name)) : entry.isFile() ? 1 : 0),
              0,
            )
          : 0;
      // Depth 8 made 1.1 GB and 115k files in five minutes, and kept going; depth 6, 10,924 files.
      expect(count(join(m.stateDir, "store", "vendor"))).toBeLessThan(100);
    },
    120_000,
  );
});

describe("discovery containment and refused names", () => {
  it.skipIf(isWindows)(
    "R7-11. a dotfiles working clone whose skills folder links into another repository of the user's is read",
    async () => {
      const m = machine();
      // ~/onmax/skills holds the skills; the dotfiles repository links some of them in by path,
      // as Maxi's setup links skills from ~/onmax/skills into agent folders.
      writeFiles(m.at("onmax", "skills"), skills("skills/", "drop", "review"));
      const dotfiles = remote(m, "dotfiles", { "README.md": "dotfiles\n" });
      const dir = clone(m, dotfiles, "dotfiles");
      mkdirSync(join(dir, "skills"), { recursive: true });
      symlinkSync(m.at("onmax", "skills", "skills", "drop"), join(dir, "skills", "drop"));
      symlinkSync(m.at("onmax", "skills", "skills", "review"), join(dir, "skills", "review"));
      m.git(dir, "add", "-A");
      m.git(dir, "commit", "--quiet", "-m", "link skills");
      const source = { id: "dotfiles", git: dotfiles.url, path: dir, skills: "skills/*" };
      const manifest = m.manifest({ agents: ["claude-code"], sources: [source] });
      const out = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
      // It linked nothing and said only "dotfiles: No valid skills found. Skills require a SKILL.md
      // with name and description.": not the rule (links out of a working clone) that dropped them.
      // A cloned repository's links come from upstream, so they stay unfollowed until you opt in.
      const said = out.sync.warnings.join("\n");
      expect(said).not.toContain("No valid skills found");
      expect(said).toContain(
        'dotfiles: skills/drop links outside ~/dotfiles; add "followLinks": true to this source to use it',
      );
      expect(out.sync.skills.names).toEqual([]);
      m.manifest({ agents: ["claude-code"], sources: [{ ...source, followLinks: true }] });
      const report = await m.json("sync");
      expect(report.warnings.join("\n")).not.toContain("links outside");
      expect(report.skills.names).toEqual(["drop", "review"]);
      expect(read(m.at(".claude", "skills", "drop", "SKILL.md"))).toBe(skillMd("drop"));
      // The copy mode follows them too.
      const copied = await m.json("sync", "--copy");
      expect(copied.ok, JSON.stringify(copied.errors)).toBe(true);
      expect(read(m.at(".claude", "skills", "review", "SKILL.md"))).toBe(skillMd("review"));
    },
  );

  it("R7-11. a team manifest cannot make a source follow links out of a clone", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        sources: [{ id: "vendor", git: vendor.https, followLinks: true }],
      }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team.https], sources: [] });
    const out = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(out.sync.warnings).toContain(
      `extends ${team.https}: ignored "followLinks" of source "vendor"; only the root manifest can follow links out of a source`,
    );
    expect(out.sync.skills.names).toEqual(["tool"]);
  });

  it.skipIf(isWindows)(
    "R7-12. on Linux and macOS a git source keeps notes~1.md and 'faq: part 1.md', as a working clone of the same repository does",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", {
        "skills/tool/SKILL.md": skillMd("tool", "see notes~1.md and faq: part 1.md"),
        "skills/tool/notes~1.md": "draft one\n",
        "skills/tool/faq: part 1.md": "faq\n",
      });
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      await init(m, manifest);
      const skill = m.at(".claude", "skills", "tool");
      expect(read(join(skill, "SKILL.md"))).toContain("notes~1.md");
      // Left out "on every system" with a warning: the SKILL.md names files its folder lacks here.
      expect(existsSync(join(skill, "notes~1.md"))).toBe(true);
      expect(existsSync(join(skill, "faq: part 1.md"))).toBe(true);
    },
  );
});

describe("the team manifest's transport allowlist", () => {
  it("R7-15. a team manifest may name a self-hosted http:// or git:// repository", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const other = remote(m, "other", skills("skills/", "lint"));
    // The team's Gitea over plain http and a git daemon, which the test's git server stands in for.
    appendFileSync(
      join(m.root, "gitconfig"),
      `[url "${vendor.served}"]\n\tinsteadOf = http://gitea.fleetrc.test/team/vendor.git\n` +
        `[url "${other.served}"]\n\tinsteadOf = git://git.fleetrc.test/other.git\n`,
    );
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        sources: [
          { id: "vendor", git: "http://gitea.fleetrc.test/team/vendor.git" },
          { id: "other", git: "git://git.fleetrc.test/other.git" },
        ],
      }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team.https], sources: [] });
    const out = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    // 'ignored source "vendor"; a team manifest names only remote repositories (https, ssh or owner/repo)'
    expect(JSON.stringify(out)).not.toContain("ignored source");
    expect(out.sync.skills.names).toEqual(["lint", "tool"]);
  });
});

describe("hooks", () => {
  it("R7-20. a hook on a local source runs when a file in it changes, not only on the first sync", async () => {
    const m = machine();
    const folder = join(m.root, "local-skills");
    writeFiles(folder, skills("", "tool"));
    const marker = join(m.root, "hook-runs");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "loc", local: folder }],
      hooks: [{ name: "build", on: ["loc:**"], run: `echo ran >> "${marker}"` }],
    });
    await init(m, manifest);
    // cmd's echo writes "ran \r\n".
    expect(read(marker).trim()).toBe("ran");
    writeFiles(folder, { "tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    // `changed` of a local source is filled only when it has never been fetched.
    expect(report.hooks.map((run) => run.name)).toEqual(["build"]);
  });
});

describe("attacks that held", () => {
  it.skipIf(isWindows)(
    "copy mode leaves out links to a FIFO, /dev/zero, a socket and a folder that holds the skill, without hanging",
    async () => {
      const m = machine();
      const folder = join(m.root, "local-skills");
      writeFiles(folder, skills("", "tool"));
      const tool = join(folder, "tool");
      spawnSyncMkfifo(join(m.root, "fifo"));
      symlinkSync(join(m.root, "fifo"), join(tool, "fifo"));
      symlinkSync("/dev/zero", join(tool, "zero"));
      symlinkSync("..", join(tool, "up"));
      const socketPath = join(m.root, "s.sock");
      const sock = (await import("node:net")).createServer().listen(socketPath);
      try {
        symlinkSync(socketPath, join(tool, "sock"));
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "loc", local: folder }],
        });
        const run = await runFor(m, 30_000, "init", manifest, "--no-hooks", "--copy");
        expect(run.code, run.out).toBe(0);
        expect(names(m.at(".claude", "skills", "tool"))).toEqual(["SKILL.md"]);
      } finally {
        sock.close();
      }
    },
  );

  it("two index sources, one slow and one failing, then a git source: each gets its own result and fetch is restored", async () => {
    const m = machine();
    const good = indexV2({ slowskill: { "SKILL.md": skillMd("slowskill") } });
    const slow = await server(async (_req, res, path) => {
      await new Promise((done) => setTimeout(done, 1500));
      const body = path.endsWith("index.json") ? good.index : good.archives.get(path);
      if (body) res.writeHead(200).end(body);
      else res.writeHead(404).end();
    });
    const failing = await server((req) => {
      req.socket.destroy();
    });
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "slow", index: slow.url },
          { id: "broken", index: failing.url },
          { id: "vendor", git: vendor.url, skills: "skills/*" },
        ],
      });
      const out = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
      const status = Object.fromEntries(out.sync.sources.map((s) => [s.id, s.status]));
      expect(status.slow).toBe("installed");
      expect(status.broken).toBe("error");
      expect(status.vendor).toBe("installed");
      expect(names(m.at(".claude", "skills"))).toEqual(["slowskill", "tool"]);
    } finally {
      await slow.close();
      await failing.close();
    }
  });
});

function spawnSyncMkfifo(path: string) {
  // Node.js has no mkfifo; mkfifo(1) is on every Linux and macOS.
  execFileSync("mkfifo", [path]);
}
