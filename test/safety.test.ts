// Round four's safety fixes (F16): what the round4 tests do not cover of a lock shared across
// machines, a sync that never ends, a skill whose folder links fan out, a lost install record, and
// a self-install under a running build. Every run uses the fixture's temporary HOME.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { jsonTemp } from "../src/fs.ts";
import { whereabouts } from "../src/process.ts";
import { LockHeldError, takeLock } from "../src/lock.ts";
import { sweepJsonTemps } from "../src/sync.ts";
import {
  cli,
  http,
  isWindows,
  machine,
  type Machine,
  names,
  publishNpm,
  read,
  remote,
  skillMd,
  skills,
  version,
  writeFiles,
} from "./fixture.ts";

async function init(m: Machine, manifest: string, ...args: string[]) {
  const run = await m.run("init", manifest, "--no-hooks", ...args);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return run;
}

describe("R7-3. a sync lock taken on another machine or in another container", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lockFile = () => {
    dir = mkdtempSync(join(tmpdir(), "fleetrc-lock-"));
    return join(dir, "sync.lock");
  };
  const mine = () => JSON.stringify({ pid: process.pid, at: Date.now() });
  // A pid that runs nothing here: what another machine's sync looks like from this one.
  const elsewherePid = 2 ** 22 - 3;

  it("is held while its pid runs nothing here, and the error names the machine", () => {
    const file = lockFile();
    const here = whereabouts();
    writeFileSync(
      file,
      JSON.stringify({
        pid: elsewherePid,
        started: Date.now(),
        at: Date.now(),
        host: "laptop",
        boot: "b",
        uptime: 1,
      }),
    );
    expect(here.host).not.toBe("laptop");
    expect(() => takeLock(file, mine())).toThrow(`(pid ${elsewherePid} on laptop)`);
  });

  it.runIf(process.platform === "linux")(
    "is held when the same host name runs it in another pid namespace (a container)",
    () => {
      const file = lockFile();
      const here = whereabouts();
      writeFileSync(
        file,
        JSON.stringify({
          pid: elsewherePid,
          started: Date.now(),
          at: Date.now(),
          ...here,
          ns: "pid:[1]",
        }),
      );
      expect(() => takeLock(file, mine())).toThrow(LockHeldError);
    },
  );

  it("is broken once it is more than two hours old", () => {
    const file = lockFile();
    writeFileSync(
      file,
      JSON.stringify({
        pid: elsewherePid,
        at: Date.now() - 3 * 3_600_000,
        host: "laptop",
        boot: "b",
        uptime: 1,
      }),
    );
    expect(takeLock(file, mine())).toContain("on laptop took it more than two hours ago");
  });

  it.runIf(process.platform === "linux")(
    "on this machine, a lock from before a restart is broken",
    () => {
      const file = lockFile();
      const here = whereabouts();
      writeFileSync(
        file,
        JSON.stringify({
          pid: process.ppid,
          started: 0,
          at: Date.now(),
          ...here,
          boot: "an-earlier-boot",
        }),
      );
      expect(takeLock(file, mine())).toContain("the machine restarted");
    },
  );
});

describe("temporary files of state.json on a HOME other machines share", () => {
  it("go when this host wrote them and their process is gone, or when they are over an hour old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetrc-temps-"));
    try {
      const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise((done) => gone.on("exit", done));
      const state = join(dir, "state.json");
      const file = (name: string, hoursOld = 0) => {
        const path = join(dir, name);
        writeFileSync(path, "{");
        const at = new Date(Date.now() - hoursOld * 3_600_000);
        utimesSync(path, at, at);
        return path;
      };
      const base = (path: string) => path.slice(dir.length + 1);
      const mineDead = file(base(jsonTemp(state, gone.pid!)));
      const mineRunning = file(base(jsonTemp(state, process.ppid)));
      // Another machine's write in progress: its pid means nothing here.
      const otherHost = file(`state.json.laptop.${gone.pid}.0123456789ab.tmp`);
      const otherHostOld = file(`last-run.json.laptop.${gone.pid}.0123456789ab.tmp`, 2);
      // Written by an older fleetrc, which named no host.
      const unknown = file(`state.json.${gone.pid}.0123456789ab.tmp`);
      const unknownOld = file(`state.json.${gone.pid}.tmp`, 2);
      const unrelated = file("notes.json.tmp", 2);
      sweepJsonTemps(dir);
      expect(existsSync(mineDead)).toBe(false);
      expect(existsSync(mineRunning)).toBe(true);
      expect(existsSync(otherHost)).toBe(true);
      expect(existsSync(otherHostOld)).toBe(false);
      expect(existsSync(unknown)).toBe(true);
      expect(existsSync(unknownOld)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R7-5. a sync that never ends", () => {
  it.skipIf(isWindows)(
    "is stopped after its time limit: the lock is released, its hook is killed and the error says so",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const pass = join(m.root, "hook.pass");
      const pidFile = join(m.root, "hook.pid");
      const release = join(m.root, "hook.release");
      const script = join(m.root, "hang.mjs");
      // Passes while `pass` exists; otherwise says it started and waits for `release`, which only
      // the test's cleanup writes, so it ends only when the sync's time limit stops it.
      writeFileSync(
        script,
        [
          `import { existsSync, writeFileSync } from "node:fs";`,
          `if (existsSync(${JSON.stringify(pass)})) process.exit(0);`,
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          `setInterval(() => existsSync(${JSON.stringify(release)}) && process.exit(0), 100);`,
        ].join("\n"),
      );
      writeFileSync(pass, "");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
        hooks: [{ name: "hang", run: `"${process.execPath}" "${script}"`, on: ["vendor:**"] }],
      });
      try {
        await init(m, manifest);
        rmSync(pass);
        // The limit counts from the start of the sync, so on a loaded machine the fetch can use it
        // up before the hook starts. That run says so and proves nothing: it is tried again with a
        // longer limit, and only a run whose hook started is checked.
        for (const [i, limit] of [4_000, 15_000, 45_000].entries()) {
          vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", `v${i + 2}`) });
          const run = await m.runWith(
            { env: { ...m.env, FLEETRC_SYNC_TIMEOUT_MS: String(limit) } },
            "sync",
          );
          expect(run.code).not.toBe(0);
          expect(readdirSync(m.stateDir).filter((name) => name.startsWith("sync.lock"))).toEqual(
            [],
          );
          if (!existsSync(pidFile)) {
            expect(run.stderr).toContain(`the sync was stopped after ${limit / 1000} s while`);
            continue;
          }
          expect(run.stderr).toContain(
            `the sync was stopped after ${limit / 1000} s while running hooks`,
          );
          const hook = Number(read(pidFile));
          await new Promise((done) => setTimeout(done, 300));
          expect(() => process.kill(hook, 0)).toThrow();
          return;
        }
        throw new Error("no sync reached its hooks within 45 s");
      } finally {
        writeFileSync(release, "");
      }
    },
    120_000,
  );
});

describe("R7-19. folder links inside a skill", () => {
  /** A skill folder whose links fan out: d0 holds four links to d1, d1 four to d2, … to d5. */
  function fanOut(dir: string) {
    writeFiles(dir, { "SKILL.md": skillMd("bomb"), "d5/leaf.txt": "leaf\n" });
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(dir, `d${i}`), { recursive: true });
      for (const k of [1, 2, 3, 4]) symlinkSync(`../d${i + 1}`, join(dir, `d${i}`, `l${k}`));
    }
  }
  const count = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, entry) =>
        sum + (entry.isDirectory() ? count(join(dir, entry.name)) : entry.isFile() ? 1 : 0),
      0,
    );

  it.skipIf(isWindows)("--copy copies each folder of a local skill once", async () => {
    const m = machine();
    const folder = join(m.root, "local-skills");
    fanOut(join(folder, "bomb"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "loc", local: folder }],
    });
    const out = await m.json<{ sync: { warnings: string[] } }>(
      "init",
      manifest,
      "--no-hooks",
      "--copy",
    );
    const copy = m.at(".claude", "skills", "bomb");
    expect(read(join(copy, "d5", "leaf.txt"))).toBe("leaf\n");
    expect(count(copy)).toBe(2);
    // Named in the agent folder's report, once per link left out.
    expect(JSON.stringify(out).split("to a folder the copy holds already")).toHaveLength(21);
  });

  it.skipIf(isWindows)(
    "a vendored skill keeps its files, once, and says which links it left out",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      fanOut(join(vendor.work, "skills", "bomb"));
      m.git(vendor.work, "add", "-A");
      m.git(vendor.work, "commit", "--quiet", "-m", "links");
      m.git(vendor.work, "push", "--quiet", "origin", "main");
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      const out = await m.json<{ sync: { warnings: string[] } }>("init", manifest, "--no-hooks");
      expect(names(m.at(".claude", "skills"))).toEqual(["bomb", "tool"]);
      expect(read(m.at(".claude", "skills", "bomb", "d5", "leaf.txt"))).toBe("leaf\n");
      expect(count(join(m.stateDir, "store", "vendor", "live", "bomb"))).toBe(2);
      expect(out.sync.warnings.join("\n")).toContain(
        "bomb: left out 20 links to a folder the skill holds already",
      );
    },
  );

  it.skipIf(isWindows)(
    "a vendored skill nested deeper than fleetrc copies is skipped by name",
    async () => {
      const m = machine();
      const deep = Array.from({ length: 40 }, (_, i) => `n${i}`).join("/");
      const vendor = remote(m, "vendor", {
        ...skills("skills/", "tool"),
        "skills/deep/SKILL.md": skillMd("deep"),
        [`skills/deep/${deep}/file.txt`]: "x\n",
      });
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, skills: "skills/*" }],
      });
      const out = await m.json<{ sync: { warnings: string[] } }>("init", manifest, "--no-hooks");
      expect(names(m.at(".claude", "skills"))).toEqual(["tool"]);
      expect(out.sync.warnings.join("\n")).toContain(
        'vendor: skipped the skill "deep": it nests folders more than 32 deep',
      );
    },
  );
});

describe("R7-21. a copy whose install record and base are both gone", () => {
  /** Loses what records the install: state.json, and the base the store keeps. */
  function forget(m: Machine, source: string) {
    rmSync(join(m.stateDir, "state.json"));
    rmSync(join(m.stateDir, "store", source, "base"), { recursive: true });
  }

  it("from git, unedited, takes upstream's update", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "skills/tool/refs/a.md": "a\n",
      "skills/tool/metadata.json": "{}",
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    await init(m, manifest);
    forget(m, "vendor");
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    expect(report.edited).toEqual([]);
    expect(read(m.at(".claude", "skills", "tool", "SKILL.md"))).toBe(skillMd("tool", "v2"));
    // The next sync finds it unedited too.
    expect((await m.json("sync")).edited).toEqual([]);
  });

  it("from git, edited, is kept as a local edit", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    await init(m, manifest);
    writeFileSync(m.at(".claude", "skills", "tool", "SKILL.md"), skillMd("tool", "mine"));
    forget(m, "vendor");
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    const report = await m.json("sync");
    expect(report.edited.map((entry) => entry.skill)).toEqual(["tool"]);
    expect(read(m.at(".claude", "skills", "tool", "SKILL.md"))).toBe(skillMd("tool", "mine"));
  });

  it("from npm, unedited, takes the new version", async () => {
    const m = machine();
    const registry = await http();
    const versions = {
      "1.0.0": { "skills/tool/SKILL.md": skillMd("tool", "v1") },
      "1.1.0": { "skills/tool/SKILL.md": skillMd("tool", "v1.1") },
    };
    publishNpm(registry, "@acme/skills", versions, "1.0.0");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "acme", npm: "@acme/skills", registry: registry.url }],
    });
    await init(m, manifest);
    forget(m, "acme");
    publishNpm(registry, "@acme/skills", versions, "1.1.0");
    const report = await m.json("sync");
    expect(report.edited).toEqual([]);
    expect(read(m.at(".claude", "skills", "tool", "SKILL.md"))).toBe(skillMd("tool", "v1.1"));
  });
});

describe("R7-22. self-install under a running build", () => {
  /** Runs node with these arguments; resolves with the exit code and output. */
  const node = (m: Machine, ...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, args, { env: m.env, cwd: m.home });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => done({ code, out }));
    });

  /** Another build of this bundle: its chunk under another name, as the next release has. */
  function otherBuild(m: Machine): string {
    const dist = dirname(cli);
    const dir = join(m.root, "build-b");
    mkdirSync(dir);
    const chunks = readdirSync(dist).filter((name) => name !== "cli.mjs");
    // The entry and the chunks import chunks by name.
    for (const name of readdirSync(dist)) {
      let text = read(join(dist, name));
      for (const chunk of chunks) text = text.replaceAll(chunk, chunk.replace(/\.mjs$/, "-b.mjs"));
      writeFileSync(join(dir, name === "cli.mjs" ? name : name.replace(/\.mjs$/, "-b.mjs")), text);
    }
    return join(dir, "cli.mjs");
  }

  it("runs started from the installed copy keep working while builds replace each other", async () => {
    const m = machine();
    const other = otherBuild(m);
    expect((await node(m, cli, "self-install")).code).toBe(0);
    const entry = join(m.stateDir, "app", "cli.mjs");
    let stop = false;
    const failures: string[] = [];
    let runs = 0;
    const runner = async () => {
      while (!stop) {
        const run = await node(m, entry, "--version");
        runs++;
        if (run.code !== 0 || run.out.trim() !== version) failures.push(run.out);
      }
    };
    const runners = [runner(), runner(), runner()];
    try {
      for (let i = 0; i < 6; i++) {
        const install = await node(m, i % 2 === 0 ? other : cli, "self-install");
        expect(install.code, install.out).toBe(0);
      }
    } finally {
      stop = true;
      await Promise.all(runners);
    }
    expect(runs).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    // Both builds stay: one is current, the other was replaced moments ago.
    const builds = readdirSync(join(m.stateDir, "app")).filter((name) =>
      /^[0-9a-f]{12}$/.test(name),
    );
    expect(builds).toHaveLength(2);
    expect(existsSync(entry)).toBe(true);
  }, 120_000);
});
