// Round five of trying to break fleetrc, against fix/round3 (ab042b4): what rounds four and five
// changed most (the sync time limit, the fleet watcher and upgrade, the timer-schedule warning,
// jsonedit, extends filters, host rules, containment). Each test asserts what fleetrc should do; a
// failing test is a break still open. Every run uses the fixture's temporary HOME, and every
// scheduler call goes to the fixture's fake.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fleet, formatFleet } from "../src/fleet.ts";
import { editJsonText } from "../src/jsonedit.ts";
import { editManifest, isRemoteGit, loadManifest, teamGitProblem } from "../src/manifest.ts";
import {
  clone,
  isWindows,
  machine,
  type Machine,
  names,
  pathWith,
  read,
  remote,
  type Report,
  sha256,
  skillMd,
  skills,
  writeFiles,
} from "./fixture.ts";

/** Runs init with --no-hooks and fails the test unless it exits 0. */
async function init(m: Machine, manifest: string, ...args: string[]) {
  const run = await m.run("init", manifest, "--no-hooks", ...args);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return run;
}

describe("a sync stopped before it saved state.json", () => {
  async function reviewableFork() {
    const m = machine();
    const vendor = remote(m, "vendor", skills("old/", "tool"));
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/personal");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "vendor", git: vendor.url, update: "review" },
        { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      ],
    });
    await init(m, manifest);
    return { m, vendor, work, manifest };
  }

  it("requires merging a held upstream move before forking", async () => {
    const { m, vendor, work, manifest } = await reviewableFork();
    const revision = vendor.commit({
      "old/tool/SKILL.md": null,
      "new/Tool/SKILL.md": skillMd("Tool", "moved"),
    });
    expect((await m.json("sync")).pending).toMatchObject([{ skill: "Tool", reason: "review" }]);
    const rejected = await m.run("fork", "Tool");
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("moved upstream to new/Tool");
    expect(existsSync(join(work, "skills", "Tool"))).toBe(false);
    expect((await m.run("merge", "Tool")).code).toBe(0);
    expect((await m.run("fork", "Tool")).code).toBe(0);
    expect(JSON.parse(read(manifest)).forks.Tool).toEqual({
      from: vendor.url,
      path: "new/Tool",
      base: revision,
    });
    expect(read(join(work, "skills", "Tool", "SKILL.md"))).toBe(skillMd("Tool", "moved"));
  });

  it("does not promote a stale pending revision after offline recovery", async () => {
    const { m, vendor, work, manifest } = await reviewableFork();
    const earlier = vendor.commit({ "old/tool/SKILL.md": skillMd("tool", "earlier") });
    expect((await m.json("sync")).pending).toHaveLength(1);
    const latest = skillMd("tool", "latest");
    const revision = vendor.commit({ "old/tool/SKILL.md": latest });
    const stateFile = join(m.stateDir, "state.json");
    const upstream = join(m.stateDir, "store", "vendor", "upstream", "tool");
    const stop = join(m.root, "stop.mjs");
    writeFileSync(
      stop,
      `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { normalize } from "node:path";
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (normalize(to) === normalize(${JSON.stringify(upstream)}) && from.endsWith(".new"))
          process.exit(86);
      };
      syncBuiltinESMExports();
    `,
    );
    const stopped = await m.runWith(
      { env: { NODE_OPTIONS: `${m.env.NODE_OPTIONS} --import=${pathToFileURL(stop).href}` } },
      "sync",
    );
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(86);
    expect(read(join(upstream, "SKILL.md"))).toBe(latest);
    expect(JSON.parse(read(stateFile)).sources.vendor.pending.tool.commit).toBe(earlier);
    expect((await m.json("sync", "--offline")).pending).toHaveLength(1);
    expect((await m.run("merge", "tool")).code).toBe(0);
    expect(JSON.parse(read(stateFile)).sources.vendor.skills.tool.commit).toBeNull();
    const rejected = await m.run("fork", "tool");
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("cannot verify the git base");
    expect((await m.json("sync")).pending).toEqual([]);
    expect((await m.run("fork", "tool")).code).toBe(0);
    expect(JSON.parse(read(manifest)).forks.tool.base).toBe(revision);
    expect(read(join(work, "skills", "tool", "SKILL.md"))).toBe(latest);
  });

  it.each(["uninterrupted", "interrupted", "upstream advanced", "offline fork"])(
    "reports the published path (%s)",
    async (scenario) => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("old/", "tool"));
      const initial = vendor.head();
      const personal = remote(m, "personal", skills("skills/", "mine"));
      const work = clone(m, personal, "code/personal");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "vendor", git: vendor.url },
          { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
        ],
        hooks: ["old", "new", "latest"].map((path) => ({
          name: path,
          run: "echo changed",
          on: [`vendor:${path}/tool/SKILL.md`],
        })),
      });
      await init(m, manifest);
      const statePath = join(m.stateDir, "state.json");
      const state = () =>
        JSON.parse(read(statePath)) as {
          lastChange: string;
          skills: { tool: { changedAt: string } };
          sources: { vendor: { commit: string } };
        };
      const before = state();
      const live = join(m.stateDir, "store", "vendor", "live", "tool");
      const stop = join(m.root, "stop.mjs");
      writeFileSync(
        stop,
        `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { normalize } from "node:path";
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (process.env.STOP_AT === "checkpoint" && normalize(to) === normalize(${JSON.stringify(statePath)}))
          process.exit(87);
        rename(from, to);
        if (process.env.STOP_AT === "live" && normalize(to) === normalize(${JSON.stringify(live)}) && from.endsWith(".new"))
          process.exit(86);
      };
      syncBuiltinESMExports();
    `,
      );
      const interrupt = async (at: string, code: number) => {
        const stopped = await m.runWith(
          {
            env: {
              NODE_OPTIONS: `${m.env.NODE_OPTIONS} --import=${pathToFileURL(stop).href}`,
              STOP_AT: at,
            },
          },
          "sync",
        );
        expect(stopped.code, stopped.stdout + stopped.stderr).toBe(code);
        expect(read(join(live, "SKILL.md"))).toContain("published");
        expect(state()).toEqual(before);
      };
      const published = "published\nfirst\nsecond\nthird\nlast";
      vendor.commit({
        "old/tool/SKILL.md": null,
        "new/tool/SKILL.md": skillMd("tool", published),
      });
      const revision = vendor.head();
      if (scenario !== "uninterrupted") {
        await interrupt("live", 86);
        await interrupt("checkpoint", 87);
      }
      const advanced = scenario === "upstream advanced";
      if (advanced)
        vendor.commit({
          "new/tool/SKILL.md": null,
          "latest/tool/SKILL.md": skillMd("tool", "latest"),
        });
      const offline = scenario === "offline fork";
      const report = await m.json("sync", ...(offline ? ["--offline"] : []));
      expect(report.pending).toEqual([]);
      expect(report.edited).toEqual([]);
      expect(read(join(live, "SKILL.md"))).toContain(advanced ? "latest" : "published");
      expect(report.skills.updated).toEqual(["tool"]);
      expect(report.hooks.map(({ name, matched, code }) => ({ name, matched, code }))).toEqual(
        (advanced ? ["new", "latest"] : ["new"]).map((name) => ({
          name,
          matched: [`vendor:${name}/tool/SKILL.md`],
          code: 0,
        })),
      );
      const after = state();
      expect(after.lastChange > before.lastChange).toBe(true);
      expect(after.skills.tool.changedAt > before.skills.tool.changedAt).toBe(true);
      if (offline) {
        expect(after.sources.vendor.commit).toBe(initial);
        const fork = await m.run("fork", "tool");
        expect(fork.code, fork.stdout + fork.stderr).toBe(0);
        const savedFork = JSON.parse(read(manifest)).forks.tool;
        const file = join(work, "skills", "tool", "SKILL.md");
        writeFileSync(file, skillMd("tool", published.replace("first", "local edit")));
        vendor.commit({
          "new/tool/SKILL.md": skillMd("tool", published.replace("last", "upstream edit")),
        });
        const merge = await m.run("merge", "tool");
        expect(merge.code, merge.stdout + merge.stderr).toBe(0);
        expect(read(file)).toBe(
          skillMd(
            "tool",
            published.replace("first", "local edit").replace("last", "upstream edit"),
          ),
        );
        expect(savedFork).toEqual({ from: vendor.url, path: "new/tool", base: revision });
        return;
      }
      expect((await m.json("sync")).hooks).toEqual([]);
    },
  );

  it.skipIf(isWindows)(
    "R8-1. an update a stopped sync put in place is not taken for a local edit once upstream moves again",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const pass = join(m.root, "hook.pass");
      const started = join(m.root, "hook.started");
      const release = join(m.root, "hook.release");
      const script = join(m.root, "hang.mjs");
      // Passes while `pass` exists; otherwise says it started and waits for `release`, so it ends
      // only when the sync's time limit stops it: after the store took the update, before
      // state.json records it.
      writeFileSync(
        script,
        [
          `import { existsSync, writeFileSync } from "node:fs";`,
          `if (existsSync(${JSON.stringify(pass)})) process.exit(0);`,
          `writeFileSync(${JSON.stringify(started)}, "");`,
          `setInterval(() => existsSync(${JSON.stringify(release)}) && process.exit(0), 100);`,
        ].join("\n"),
      );
      writeFileSync(pass, "");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
        hooks: [{ name: "hang", run: `"${process.execPath}" "${script}"`, on: ["vendor:**"] }],
      });
      const copy = m.at(".claude", "skills", "tool", "SKILL.md");
      const state = () =>
        JSON.parse(read(join(m.stateDir, "state.json"))) as {
          lastChange: string;
          skills: { tool: { changedAt: string } };
        };
      try {
        await init(m, manifest);
        const initial = state().lastChange;
        rmSync(pass);
        let version = 1;
        // The limit counts from the start of the sync; on a loaded machine the fetch may use it up
        // before the hook starts, so it is tried again with a longer one.
        for (const limit of [4_000, 15_000, 45_000]) {
          vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", `v${++version}`) });
          const run = await m.runWith(
            { env: { ...m.env, FLEETRC_SYNC_TIMEOUT_MS: String(limit) } },
            "sync",
          );
          expect(run.code).not.toBe(0);
          if (existsSync(started)) break;
        }
        expect(existsSync(started), "no sync reached its hooks").toBe(true);
        // The stopped sync replaced the copy: agents already read the update.
        expect(read(copy)).toContain(`v${version}`);
        const checkpoint = state();
        expect(checkpoint.skills.tool.changedAt > initial).toBe(true);
        expect(checkpoint.lastChange).toBe(checkpoint.skills.tool.changedAt);
        writeFileSync(pass, "");
        expect((await m.json("sync")).hooks).toHaveLength(1);
        expect(state().lastChange).toBe(checkpoint.lastChange);
        // Upstream moves on before the next sync.
        vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "latest") });
        const report = await m.json("sync");
        // It held the update as a local edit: the copy matched no record, and it was no update
        // either, so `fleetrc merge tool` stood between the user and every later update.
        expect(report.edited).toEqual([]);
        expect(report.pending).toEqual([]);
        expect(read(copy)).toContain("latest");
      } finally {
        writeFileSync(release, "");
      }
    },
    180_000,
  );
});

describe("merge while a sync runs", () => {
  /** A hook script that passes while `pass` exists, else says it started and waits for `release`. */
  function slowHook(m: Machine) {
    const pass = join(m.root, "hook.pass");
    const started = join(m.root, "hook.started");
    const release = join(m.root, "hook.release");
    const script = join(m.root, "slow.mjs");
    writeFileSync(
      script,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `if (existsSync(${JSON.stringify(pass)})) process.exit(0);`,
        `writeFileSync(${JSON.stringify(started)}, "");`,
        `setInterval(() => existsSync(${JSON.stringify(release)}) && process.exit(0), 100);`,
      ].join("\n"),
    );
    writeFileSync(pass, "");
    return { pass, started, release, run: `"${process.execPath}" "${script}"` };
  }

  async function waitFor(file: string) {
    const deadline = Date.now() + 60_000;
    while (!existsSync(file) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 100));
    expect(existsSync(file), `${file} never appeared`).toBe(true);
  }

  it.skipIf(isWindows)(
    "R8-4. merge waits for a running sync and then says to try again, and the conflicts it records once the sync is done stay recorded",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
      const hook = slowHook(m);
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
        hooks: [{ name: "slow", run: hook.run, on: ["vendor:**"] }],
      });
      await init(m, manifest);
      const copy = m.at(".claude", "skills", "tool", "SKILL.md");
      // A local edit and an upstream change to the same line: the update waits for `merge`.
      writeFileSync(copy, skillMd("tool", "mine"));
      vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "theirs") });
      const held = await m.json("sync");
      expect(held.pending.map((entry) => entry.skill)).toEqual(["tool"]);
      try {
        // The timer's sync starts and is still running when the user merges.
        rmSync(hook.pass);
        vendor.commit({ "skills/other/SKILL.md": skillMd("other", "v2") });
        const timer = m.run("sync");
        await waitFor(hook.started);
        // It used to merge and record the conflicts, and the sync then wrote back the state.json
        // it read before, losing them. Now it waits, and gives up without touching the copy.
        const merge = await m.runWith(
          { env: { ...m.env, FLEETRC_LOCK_WAIT_MS: "500" } },
          "merge",
          "tool",
        );
        expect(merge.code).not.toBe(0);
        expect(merge.stderr).toMatch(
          /another fleetrc sync is running \(pid \d+\); try again when it finishes/,
        );
        expect(read(copy)).not.toContain("<<<<<<<");
        writeFileSync(hook.release, "");
        expect((await timer).code).toBe(0);
        writeFileSync(hook.pass, "");
        const again = await m.run("merge", "tool");
        expect(again.stdout).toContain("conflicts: SKILL.md");
        const after = await m.json("sync");
        expect(read(copy)).toContain("<<<<<<<");
        expect(after.held.map((entry) => entry.reason).join("\n")).toContain(
          "tool has unresolved merge conflicts",
        );
        expect(after.pending).toEqual([]);
      } finally {
        writeFileSync(hook.release, "");
      }
    },
    180_000,
  );

  it.skipIf(isWindows)(
    "R8-4. a sync that another writer's change to state.json lands under keeps that change when it saves",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      // A hook that writes state.json while the sync runs, as a writer that took no lock would: it
      // records a conflict in tool, with the file it is waiting on.
      const script = join(m.root, "writer.mjs");
      const state = join(m.stateDir, "state.json");
      const enabled = join(m.root, "writer.enabled");
      writeFileSync(
        script,
        [
          `import { existsSync, readFileSync, writeFileSync } from "node:fs";`,
          `import { join } from "node:path";`,
          `if (!existsSync(${JSON.stringify(enabled)})) process.exit(0);`,
          `const state = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));`,
          `const dir = state.skills.tool.dir;`,
          `writeFileSync(join(dir, "notes.md.upstream"), "theirs\\n");`,
          `state.conflicts = { tool: { dir, files: ["notes.md"], markers: { "notes.md": "notes.md.upstream" } } };`,
          `writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));`,
        ].join("\n"),
      );
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
        hooks: [{ name: "writer", run: `"${process.execPath}" "${script}"`, on: ["vendor:**"] }],
      });
      await init(m, manifest);
      writeFileSync(enabled, "");
      vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
      const report = await m.json("sync");
      expect(report.hooks.map((hook) => hook.code)).toEqual([0]);
      const saved = JSON.parse(read(state)) as { conflicts?: Record<string, unknown> };
      expect(Object.keys(saved.conflicts ?? {})).toEqual(["tool"]);
      const next = await m.json("sync");
      expect(next.held.flatMap((entry) => entry.files)).toContain("notes.md");
    },
    120_000,
  );
});

describe("the timer-schedule warning", () => {
  it("R8-2. after the timer's own run took the once-only note, doctor still says the installed timer runs another schedule", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const me = remote(m, "me", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    await init(m, me.url);
    // The timer `timer install` put in place, on the default schedule.
    writeFileSync(
      join(m.stateDir, "timer.json"),
      JSON.stringify({
        spec: { name: "fleetrc-sync", cron: "*/30 * * * *", timeZone: "local" },
        files: [],
      }),
    );
    // A schedule change pushed from another machine. The first sync to see it is the timer's, and
    // its note goes to the timer's log, which nobody reads.
    me.commit({
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        timer: { cron: "0 * * * *" },
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    // The timer runs every half hour; by the time the user looks, its next run has replaced the
    // last-run report that held the note.
    for (let run = 0; run < 2; run++) {
      const timerRun = await m.runWith({ env: { ...m.env, FLEETRC_TIMER: "1" } }, "sync");
      expect(timerRun.code, timerRun.stdout + timerRun.stderr).toBe(0);
    }
    // The user asks what is wrong: doctor reads the same record the note came from, and says
    // nothing of the new schedule; status neither. Only `timer.timeZone` drift is checked.
    const doctor = await m.run("doctor", "--json");
    const status = await m.run("status");
    expect(doctor.stdout + status.stdout).toContain('"0 * * * *"');
  });
});

describe("fleet upgrade", () => {
  it.skipIf(isWindows)(
    "R8-3. a host whose upgrade went in but whose sync after it failed (the timer held the lock) still shows its version change",
    async () => {
      const m = machine({ agents: false });
      const dir = join(m.root, "state", "fleetrc");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "version"), "0.0.1\n");
      // The installed fleetrc: `sync` finds the timer's sync running, as `sync --json` says it.
      writeFileSync(
        join(dir, "bin", "fleetrc"),
        `#!/bin/sh
v=$(cat "${dir}/version")
case "$1" in
  --version) echo "$v" ;;
  sync) echo '{"ok":false,"error":"another fleetrc sync is running (pid 4242)"}'; echo "fleetrc: another fleetrc sync is running (pid 4242)" >&2; exit 1 ;;
esac
`,
      );
      chmodSync(join(dir, "bin", "fleetrc"), 0o755);
      const npx = join(m.root, "npx-bin");
      mkdirSync(npx);
      writeFileSync(join(npx, "npx"), `#!/bin/sh\necho 0.0.2 > "${dir}/version"\n`);
      chmodSync(join(npx, "npx"), 0o755);
      const ssh = join(m.root, "ssh.mjs");
      writeFileSync(
        ssh,
        `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
while (args[0] === "-o") args.splice(0, 2);
if (args[0] === "--") args.shift();
const run = spawnSync("sh", ["-c", args[1]], { stdio: "inherit" });
process.exit(run.status ?? 1);`,
      );
      const saved = {
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        FLEETRC_SSH: process.env.FLEETRC_SSH,
        PATH: process.env.PATH,
      };
      process.env.XDG_STATE_HOME = join(m.root, "state");
      process.env.FLEETRC_SSH = ssh;
      process.env.PATH = pathWith(npx, process.env);
      try {
        const results = await fleet(["localhost"], "upgrade", "0.0.2", 60_000);
        // The host now runs 0.0.2, and its launcher says so.
        expect(
          spawnSync(join(dir, "bin", "fleetrc"), ["--version"], { encoding: "utf8" }).stdout,
        ).toBe("0.0.2\n");
        // It printed only "localhost: another fleetrc sync is running (pid 4242); no run
        // recorded": the upgrade, which went in, is not said.
        expect(formatFleet(results)).toContain("0.0.1 → 0.0.2");
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    },
  );
});

describe("the manifest: extends objects, team git hosts, the in-place editor", () => {
  // HOME, the XDG folders and git's global config point into a temporary folder for this block.
  const root = mkdtempSync(join(tmpdir(), "fleetrc-r5-manifest-"));
  const saved = { ...process.env };
  beforeAll(() => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "gitconfig"), "");
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      npm_config_userconfig: join(root, "npmrc"),
    });
  });
  afterAll(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  function write(file: string, value: unknown) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  describe("team git URLs that git reads with another host", () => {
    // `gitHost` takes everything before the last `@` up to the first `/` as user info, but curl ends
    // the host at `?` or `#`: git asks 127.0.0.1 for `/?@github.com/x/info/refs`, and the rule calls
    // it github.com. (Checked by hand: `git ls-remote http://127.0.0.1:<port>?@github.com/x` reaches a
    // server on 127.0.0.1.)
    for (const url of [
      "http://127.0.0.1:9418?@github.com/x.git",
      "http://127.0.0.1#@github.com/x.git",
      "https://127.0.0.1/?@github.com/x.git",
      "http://127.0.0.1;@github.com/x.git",
      "http://127.0.0.1\\@github.com/x.git",
      "http://user\\@127.0.0.1\\@github.com/x.git",
      "git://localhost?x@github.com/x.git",
    ])
      it(`R8-5. refuses ${url}, which reaches this machine`, async () => {
        expect.soft(isRemoteGit(url)).toBe(false);
        expect.soft(await teamGitProblem(url)).toMatch(/this machine|remote repositories/);
      });
  });

  it("R8-5. still takes user info and a query on a host elsewhere", async () => {
    for (const url of [
      "https://user:token@github.com/x.git",
      "https://github.com/x.git?ref=main",
      "ssh://git@github.com/x.git",
    ])
      expect.soft(isRemoteGit(url), url).toBe(true);
  });

  describe("a manifest in a folder's .fleetrc/", () => {
    it("resolves relative paths against .fleetrc/; a team named by its file keeps its extends in the file's folder", async () => {
      write("r5-folder/.fleetrc/manifest.json", {
        extends: ["./team.json"],
        sources: [{ id: "mine", local: ".." }],
      });
      write("r5-folder/.fleetrc/team.json", {
        extends: ["./shared.json", "../outside.json"],
        sources: [{ id: "team", index: "https://team.example.com" }],
      });
      write("r5-folder/.fleetrc/shared.json", {
        sources: [{ id: "shared", index: "https://s.example.com" }],
      });
      write("r5-folder/outside.json", {
        sources: [{ id: "outside", index: "https://o.example.com" }],
      });
      const loaded = await loadManifest(join(root, "r5-folder"), { offline: true });
      expect(loaded.root.file).toBe(join(root, "r5-folder", ".fleetrc", "manifest.json"));
      expect(loaded.sources.map((source) => source.id)).toEqual(["mine", "team", "shared"]);
      const mine = loaded.sources[0]!;
      expect(mine.kind === "local" && mine.local).toBe(join(root, "r5-folder"));
      expect(loaded.failed).toEqual(["../outside.json"]);
      expect(loaded.warnings.join("\n")).toMatch(/outside it/);
    });

    it("a team named by its file path in a .fleetrc/ folder can't extend the folder around it", async () => {
      // ~/.fleetrc/team.json named as a file: its boundary is ~/.fleetrc, not the home folder.
      const home = process.env.HOME!;
      write("home/private.json", { sources: [{ id: "private", index: "https://p.example.com" }] });
      write("home/.fleetrc/team.json", {
        extends: ["../private.json"],
        sources: [{ id: "team", index: "https://team.example.com" }],
      });
      const file = write("r5-byfile/me.json", {
        extends: ["~/.fleetrc/team.json", join(home, ".fleetrc", "manifest.json")],
      });
      write("home/.fleetrc/manifest.json", { extends: ["../private.json"], sources: [] });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id)).toEqual(["team"]);
      expect(loaded.failed).toEqual(["../private.json", "../private.json"]);
      expect(loaded.warnings.join("\n")).toMatch(/outside it/);
    });

    it.each(["file", "folder"])(
      "keeps each team's boundary when the %s is named first",
      async (first) => {
        const team = write("r5-boundary/team/.fleetrc/manifest.json", {
          extends: ["../shared.json"],
          sources: [
            { id: "team", npm: "team" },
            { id: "legacy", npm: "legacy" },
          ],
        });
        write("r5-boundary/team/shared.json", {
          sources: [{ id: "shared", npm: "shared" }],
        });
        const fileEntry = {
          manifest: `${dirname(team)}/./manifest.json`,
          exclude: ["file-only"],
          excludeSources: ["legacy"],
        };
        const folderEntry = { manifest: "./team", exclude: ["folder-only"] };
        const file = write("r5-boundary/me.json", {
          extends: first === "file" ? [fileEntry, folderEntry] : [folderEntry, fileEntry],
        });

        const loaded = await loadManifest(file, { offline: true });
        expect(loaded.sources.map((source) => source.id)).toEqual(["team", "shared"]);
        expect(loaded.sources[0]!.exclude?.toSorted()).toEqual(["file-only", "folder-only"]);
        expect(loaded.sources[1]!.exclude).toEqual(["folder-only"]);
        expect(loaded.failed).toEqual([]);
        expect(loaded.warnings).toEqual([expect.stringContaining("outside it")]);
      },
    );

    it.each([true, false])(
      "retires a removed source only if the shared manifest is readable (%s)",
      async (readable) => {
        const m = machine();
        const local = join(m.root, "local");
        writeFiles(local, skills("", "old-skill"));
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "old", local }],
        });
        await init(m, manifest);
        const link = m.at(".claude", "skills", "old-skill");
        expect(existsSync(link)).toBe(true);

        const team = join(m.root, "team");
        writeFiles(team, {
          ".fleetrc/manifest.json": JSON.stringify({ extends: ["../shared.json"] }),
          "shared.json": readable ? "{}" : "{",
        });
        m.manifest({
          agents: ["claude-code"],
          extends: [team, `${team}/./.fleetrc/manifest.json`],
        });

        const report = await m.json<Report>("sync");
        expect(report.warnings).toContainEqual(expect.stringContaining("outside it"));
        expect(report.warnings.some((warning) => warning.includes("did not load"))).toBe(!readable);
        expect(existsSync(link)).toBe(!readable);
      },
    );

    it("does not read a skills.json at the folder's root", async () => {
      write("r5-old/skills.json", { sources: [] });
      await expect(loadManifest(join(root, "r5-old"), { offline: true })).rejects.toThrow(
        /r5-old has no \.fleetrc\/manifest\.json; name the manifest file as .*<file>/,
      );
    });
  });

  it("uses the transport's config for the team Git redirect check", async () => {
    const url = "https://example.com/team.git";
    const redirects = `[http "${url}"]\n\tfollowRedirects = true\n`;
    const alternate = write("alternate.gitconfig", redirects);
    const previous = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = alternate;
    try {
      expect(await teamGitProblem(url, root)).toBeUndefined();
      write("gitconfig", redirects);
      write("alternate.gitconfig", "");
      expect(await teamGitProblem(url, root)).toMatch(/with Git redirects disabled/);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG;
      else process.env.GIT_CONFIG = previous;
      write("gitconfig", "");
    }
  });

  describe("extends objects", () => {
    it("R8-6. keeps a team manifest's own exclusions of what it extends", async () => {
      // The team leaves "legacy" and the skill "old" out of the base it extends; a member who extends
      // the team gets neither.
      write("r5-extends/team/base.json", {
        sources: [
          { id: "legacy", index: "https://legacy.example.com" },
          { id: "keep", index: "https://keep.example.com" },
        ],
      });
      write("r5-extends/team/team.json", {
        extends: [{ manifest: "./base.json", excludeSources: ["legacy"], exclude: ["old"] }],
      });
      const file = write("r5-extends/me.json", { extends: ["./team/team.json"] });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id)).toEqual(["keep"]);
      expect(loaded.sources[0]!.exclude).toEqual(["old"]);
    });

    it("R8-6. keeps exclusions of every level, with the member's own on top", async () => {
      write("r5-levels/base.json", {
        sources: [
          { id: "a", index: "https://a.example.com" },
          { id: "b", index: "https://b.example.com" },
          { id: "c", index: "https://c.example.com" },
        ],
      });
      write("r5-levels/team.json", {
        extends: [{ manifest: "./base.json", excludeSources: ["a"], exclude: ["x"] }],
      });
      const file = write("r5-levels/me.json", {
        extends: [{ manifest: "./team.json", excludeSources: ["b"], exclude: ["y"] }],
      });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id)).toEqual(["c"]);
      expect(loaded.sources[0]!.exclude).toEqual(["y", "x"]);
      expect(loaded.sources[0]!.via).toBe(0);
    });

    it("R8-7. applies an entry's exclusions to a manifest another entry already brought in", async () => {
      // The sub-team extends the base too. Its entry comes first, so the base is loaded through it,
      // unfiltered, and the user's own entry for the base, which leaves "legacy" out, is skipped as
      // already seen.
      write("r5-seen/base.json", {
        sources: [
          { id: "legacy", index: "https://legacy.example.com" },
          { id: "keep", index: "https://keep.example.com" },
        ],
      });
      write("r5-seen/sub.json", { extends: ["./base.json"] });
      const file = write("r5-seen/me.json", {
        extends: ["./sub.json", { manifest: "./base.json", excludeSources: ["legacy"] }],
      });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id)).toEqual(["keep"]);
    });

    it("R8-7. a skill excluded on one path to a manifest is excluded, whichever path came first", async () => {
      write("r5-union/base.json", { sources: [{ id: "keep", index: "https://keep.example.com" }] });
      write("r5-union/sub.json", { extends: [{ manifest: "./base.json", exclude: ["one"] }] });
      const file = write("r5-union/me.json", {
        extends: ["./sub.json", { manifest: "./base.json", exclude: ["two"] }],
      });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id)).toEqual(["keep"]);
      expect(loaded.sources[0]!.exclude?.sort()).toEqual(["one", "two"]);
    });

    it("R8-7. a manifest that extends itself through another ends the loop", async () => {
      write("r5-loop/a.json", {
        extends: ["./b.json"],
        sources: [{ id: "a", index: "https://a.example.com" }],
      });
      write("r5-loop/b.json", {
        extends: [{ manifest: "./a.json", excludeSources: ["a"] }],
        sources: [{ id: "b", index: "https://b.example.com" }],
      });
      const file = write("r5-loop/me.json", { extends: ["./a.json"] });
      const loaded = await loadManifest(file, { offline: true });
      expect(loaded.sources.map((source) => source.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("editing a manifest in place", () => {
    it("R8-8. does not crash on a manifest that repeats a key, as a hand-merged one can", () => {
      // JSON.parse keeps the last "sources"; the editor walks the first one's items by the last one's
      // indexes and reads past its end.
      const text = `{\n  "sources": [{ "id": "a", "git": "https://example.com/a.git" }],\n  "sources": [\n    { "id": "a", "git": "https://example.com/a.git" },\n    { "id": "b", "git": "https://example.com/b.git" }\n  ]\n}\n`;
      const file = write("r5-dup/.fleetrc/manifest.json", text);
      editManifest(file, (raw) => {
        const sources = raw.sources as Record<string, unknown>[];
        sources[1]!.exclude = ["x"];
      });
      const after = JSON.parse(readFileSync(file, "utf8")) as { sources: { exclude?: string[] }[] };
      expect(after.sources[1]!.exclude).toEqual(["x"]);
    });

    it("R8-8. says which key a manifest repeats when it writes the file out whole", () => {
      const text = `{\n  "agents": ["codex"],\n  "agents": ["claude-code"]\n}\n`;
      const notes: string[] = [];
      const before = JSON.parse(text) as Record<string, unknown>;
      expect(editJsonText(text, before, { ...before, fleet: ["box"] }, notes)).toBeUndefined();
      expect(notes.join("\n")).toContain('"agents"');
    });

    it("R8-9. keeps the layout when every member of an object is replaced", () => {
      // Dropping every member and adding one makes two edits of the same span: the second lands on
      // text the first already shortened, the result fails its own check, and the whole file is
      // rewritten with two-space indents and LF.
      const text = `{\r\n\t"agents": ["codex"],\r\n\t"forks": {\r\n\t\t"a": { "from": "x/y", "path": "a", "base": "1" }\r\n\t}\r\n}\r\n`;
      const before = JSON.parse(text) as Record<string, unknown>;
      const after = { ...before, forks: { b: { from: "x/y", path: "b", base: "2" } } };
      const out = editJsonText(text, before, after);
      expect(out).toBeDefined();
      expect(out).toContain('\r\n\t"agents": ["codex"],\r\n');
      expect(out).toContain(
        '\t"forks": {\r\n\t\t"b": { "from": "x/y", "path": "b", "base": "2" }\r\n\t}',
      );
      expect(JSON.parse(out!)).toEqual(after);
    });

    it("R8-9. keeps the layout when every member of a one-line object is replaced", () => {
      const text = `{\n\t"forks": { "a": 1, "b": 2 },\n\t"agents": ["codex"]\n}\n`;
      const before = JSON.parse(text) as Record<string, unknown>;
      const after = { ...before, forks: { c: 3 } };
      expect(editJsonText(text, before, after)).toBe(
        `{\n\t"forks": { "c": 3 },\n\t"agents": ["codex"]\n}\n`,
      );
    });
  });
});

/** An HTTP server whose handler the test controls. */
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

/** A zip archive of `files`, stored (no compression), as the v0.2 discovery spec allows. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A SKILL.md of a few KB, as most real ones are: well past one 512-byte tar block. */
const longSkillMd = (name: string) =>
  skillMd(name, `When you work on ${name}, read this first.\n\n${"Keep it short. ".repeat(200)}`);

describe("index sources", () => {
  it("R8-10. an index entry of type skill-md (one SKILL.md, no archive) longer than 512 bytes installs", async () => {
    const m = machine();
    const body = longSkillMd("notes");
    const site = await server((_req, res, path) => {
      if (path === "/.well-known/agent-skills/index.json")
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [
              {
                name: "notes",
                type: "skill-md",
                description: "The notes skill",
                url: "notes/SKILL.md",
                digest: `sha256:${sha256(Buffer.from(body))}`,
              },
            ],
          }),
        );
      else if (path === "/.well-known/agent-skills/notes/SKILL.md")
        res.writeHead(200, { "content-type": "text/markdown" }).end(body);
      else res.writeHead(404).end();
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      const run = await m.run("init", manifest, "--no-hooks");
      expect(names(m.at(".claude", "skills")), run.stdout + run.stderr).toContain("notes");
      expect(read(m.at(".claude", "skills", "notes", "SKILL.md"))).toBe(body);
    } finally {
      await site.close();
    }
  });

  it("R8-11. an index entry whose archive is a zip, which the discovery spec and `skills` accept, installs", async () => {
    const m = machine();
    const body = longSkillMd("zipped");
    const archive = zip({ "SKILL.md": body, "notes.md": "more\n" });
    const site = await server((_req, res, path) => {
      if (path === "/.well-known/agent-skills/index.json")
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [
              {
                name: "zipped",
                type: "archive",
                description: "The zipped skill",
                url: "zipped.zip",
                digest: `sha256:${sha256(archive)}`,
              },
            ],
          }),
        );
      else if (path === "/.well-known/agent-skills/zipped.zip")
        res.writeHead(200, { "content-type": "application/zip" }).end(archive);
      else res.writeHead(404).end();
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      const run = await m.run("init", manifest, "--no-hooks");
      expect(names(m.at(".claude", "skills")), run.stdout + run.stderr).toContain("zipped");
      expect(read(m.at(".claude", "skills", "zipped", "SKILL.md"))).toBe(body);
    } finally {
      await site.close();
    }
  });
});

describe("index archives past the copy limits", () => {
  it("R8-11. refuses a zip whose central directory says it unpacks past a skill's limit", async () => {
    const m = machine();
    const archive = zip({ "SKILL.md": longSkillMd("huge") });
    // The central directory's unpacked size of SKILL.md: 300 MB, past the 200 MB a skill may hold.
    const central = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(300 * 1024 * 1024, central + 24);
    const site = await server((_req, res, path) => {
      if (path === "/.well-known/agent-skills/index.json")
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            skills: [
              {
                name: "huge",
                type: "archive",
                description: "The huge skill",
                url: "huge.zip",
                digest: `sha256:${sha256(archive)}`,
              },
            ],
          }),
        );
      else if (path === "/.well-known/agent-skills/huge.zip")
        res.writeHead(200, { "content-type": "application/zip" }).end(archive);
      else res.writeHead(404).end();
    });
    try {
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "site", index: site.url }],
      });
      const run = await m.run("init", manifest, "--no-hooks");
      expect(names(m.at(".claude", "skills"))).not.toContain("huge");
      expect(run.stdout + run.stderr).toContain("more than 200 MB");
    } finally {
      await site.close();
    }
  });
});

describe("merge conflicts", () => {
  it("R8-12. a binary file merge reports as a conflict stays an unresolved conflict for doctor and sync until merge runs again", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", {
      "skills/tool/SKILL.md": skillMd("tool"),
      "skills/tool/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "v", git: vendor.url }],
    });
    await init(m, manifest);
    const mine = Buffer.from([0, 9, 9, 9, 0, 255, 1]);
    writeFileSync(m.at(".claude/skills/tool/logo.bin"), mine);
    writeFiles(vendor.work, { "skills/tool/logo.bin": Buffer.from([0, 7, 7, 0]) });
    vendor.commit({});
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(1);
    expect(merge.stdout).toContain("conflicts: logo.bin");
    expect(readFileSync(m.at(".claude/skills/tool/logo.bin")).equals(mine)).toBe(true);
    // Nothing was resolved: the local bytes are as they were, and upstream's are nowhere in the copy.
    const checks = await m.json<{ name: string; ok: boolean; detail: string }[]>("doctor");
    const conflicts = checks.find((check) => check.name === "merge conflicts");
    expect(conflicts?.ok, conflicts?.detail).toBe(false);
    const report = await m.json<Report>("sync");
    expect(report.held.map((held) => held.files).flat()).toContain("logo.bin");
    // Upstream's bytes are beside it; once the user deletes them, merge records the conflict resolved.
    const sidecar = m.at(".claude/skills/tool/logo.bin.upstream");
    expect(readFileSync(sidecar).equals(Buffer.from([0, 7, 7, 0]))).toBe(true);
    rmSync(sidecar);
    const again = await m.run("merge", "tool");
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const fixed = await m.json<{ name: string; ok: boolean }[]>("doctor");
    expect(fixed.find((check) => check.name === "merge conflicts")?.ok).toBe(true);
  });

  it("R8-12. a file deleted upstream that was edited here stays an unresolved conflict until its note is deleted", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", {
      "skills/tool/SKILL.md": skillMd("tool"),
      "skills/tool/notes.md": "notes\n",
    });
    await init(m, m.manifest({ agents: ["claude-code"], sources: [{ id: "v", git: vendor.url }] }));
    writeFileSync(m.at(".claude/skills/tool/notes.md"), "my notes\n");
    vendor.commit({ "skills/tool/notes.md": null });
    await m.run("sync");
    const merge = await m.run("merge", "tool");
    expect(merge.code, merge.stdout + merge.stderr).toBe(1);
    expect(merge.stdout).toContain("conflicts: notes.md");
    expect(read(m.at(".claude/skills/tool/notes.md"))).toBe("my notes\n");
    const note = m.at(".claude/skills/tool/notes.md.upstream-deleted");
    expect(read(note)).toContain("upstream deleted notes.md");
    const report = await m.json<Report>("sync");
    expect(report.held.map((held) => held.files).flat()).toContain("notes.md");
    rmSync(note);
    const after = await m.json<Report>("sync");
    expect(after.held).toEqual([]);
  });

  it.skipIf(isWindows)(
    "R8-12. a link that changed upstream stays an unresolved conflict, with a note of upstream's target beside it",
    async () => {
      const m = machine({ scheduler: "empty" });
      const vendor = remote(m, "vendor", {
        "skills/tool/SKILL.md": skillMd("tool"),
        "skills/tool/doc.md": "doc\n",
      });
      await init(
        m,
        m.manifest({ agents: ["claude-code"], sources: [{ id: "v", git: vendor.url }] }),
      );
      // The user made doc.md a link; upstream changed the file.
      const doc = m.at(".claude/skills/tool/doc.md");
      rmSync(doc);
      symlinkSync("SKILL.md", doc);
      vendor.commit({ "skills/tool/doc.md": "doc v2\n" });
      await m.run("sync");
      const merge = await m.run("merge", "tool");
      expect(merge.code, merge.stdout + merge.stderr).toBe(1);
      expect(merge.stdout).toContain("conflicts: doc.md");
      expect(lstatSync(doc).isSymbolicLink()).toBe(true);
      expect(read(`${doc}.upstream`)).toBe("doc v2\n");
      const checks = await m.json<{ name: string; ok: boolean }[]>("doctor");
      expect(checks.find((check) => check.name === "merge conflicts")?.ok).toBe(false);
    },
  );
});

describe("remove", () => {
  it("finds a source by its id in any case, as every other command does", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    await init(m, manifest);
    const run = await m.run("remove", "VENDOR");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect((JSON.parse(read(manifest)) as { sources: unknown[] }).sources).toEqual([]);
    expect(names(m.at(".claude", "skills"))).not.toContain("tool");
  });
});
