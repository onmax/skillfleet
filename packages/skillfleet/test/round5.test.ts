// Round five of trying to break skillfleet, against fix/round3 (ab042b4): what rounds four and five
// changed most (the sync time limit, the fleet watcher and upgrade, the timer-schedule warning,
// jsonedit, extends filters, host rules, containment). Each test asserts what skillfleet should do; a
// failing test is a break still open. Every run uses the fixture's temporary HOME, and every
// scheduler call goes to the fixture's fake.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { fleet, formatFleet } from "../src/fleet.ts";
import { editJsonText } from "../src/jsonedit.ts";
import { editManifest, isRemoteGit, loadManifest, teamGitProblem } from "../src/manifest.ts";
import {
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

/** Runs init with --no-timer and fails the test unless it exits 0. */
async function init(m: Machine, manifest: string, ...args: string[]) {
  const run = await m.run("init", manifest, "--no-timer", ...args);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return run;
}

describe("a sync stopped before it saved state.json", () => {
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
      try {
        await init(m, manifest);
        rmSync(pass);
        let version = 1;
        // The limit counts from the start of the sync; on a loaded machine the fetch may use it up
        // before the hook starts, so it is tried again with a longer one.
        for (const limit of [4_000, 15_000, 45_000]) {
          vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", `v${++version}`) });
          const run = await m.runWith(
            { env: { ...m.env, SKILLFLEET_SYNC_TIMEOUT_MS: String(limit) } },
            "sync",
          );
          expect(run.code).not.toBe(0);
          if (existsSync(started)) break;
        }
        expect(existsSync(started), "no sync reached its hooks").toBe(true);
        // The stopped sync replaced the copy: agents already read the update.
        expect(read(copy)).toContain(`v${version}`);
        writeFileSync(pass, "");
        // Upstream moves on before the next sync.
        vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "latest") });
        const report = await m.json("sync");
        // It held the update as a local edit: the copy matched no record, and it was no update
        // either, so `skillfleet merge tool` stood between the user and every later update.
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
  it.skipIf(isWindows)(
    "R8-4. a merge's conflicts stay recorded when a sync that started before it saves state.json after it",
    async () => {
      const m = machine();
      const vendor = remote(m, "vendor", skills("skills/", "tool", "other"));
      const pass = join(m.root, "hook.pass");
      const started = join(m.root, "hook.started");
      const release = join(m.root, "hook.release");
      const script = join(m.root, "slow.mjs");
      // A slow step of the timer's sync (a fetch, a hook): it waits for `release` unless `pass` exists.
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
        hooks: [{ name: "slow", run: `"${process.execPath}" "${script}"`, on: ["vendor:**"] }],
      });
      await init(m, manifest);
      // A local edit and an upstream change to the same line: the update waits for `merge`.
      writeFileSync(m.at(".claude", "skills", "tool", "SKILL.md"), skillMd("tool", "mine"));
      vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "theirs") });
      const held = await m.json("sync");
      expect(held.pending.map((entry) => entry.skill)).toEqual(["tool"]);
      try {
        // The timer's sync starts and is still running when the user merges.
        rmSync(pass);
        vendor.commit({ "skills/other/SKILL.md": skillMd("other", "v2") });
        const timer = m.run("sync");
        const deadline = Date.now() + 60_000;
        while (!existsSync(started) && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 100));
        expect(existsSync(started), "the sync never reached its hook").toBe(true);
        const merge = await m.run("merge", "tool");
        expect(merge.stdout).toContain("conflicts: SKILL.md");
        writeFileSync(release, "");
        await timer;
        writeFileSync(pass, "");
        // The sync wrote back the state.json it read before the merge: the conflict record is
        // gone, so the copy agents read, conflict markers and all, is no longer reported as held,
        // and the update it merged is pending again.
        const after = await m.json("sync");
        expect(read(m.at(".claude", "skills", "tool", "SKILL.md"))).toContain("<<<<<<<");
        expect(after.held.map((entry) => entry.reason).join("\n")).toContain(
          "tool has unresolved merge conflicts",
        );
        expect(after.pending).toEqual([]);
      } finally {
        writeFileSync(release, "");
      }
    },
    180_000,
  );
});

describe("the timer-schedule warning", () => {
  it("R8-2. after the timer's own run took the once-only note, doctor still says the installed timer runs another schedule", async () => {
    const m = machine({ scheduler: "empty" });
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const me = remote(m, "me", {
      "skills.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    await init(m, me.url);
    // The timer `timer install` put in place, on the default schedule.
    writeFileSync(
      join(m.stateDir, "timer.json"),
      JSON.stringify({
        spec: { name: "skillfleet-sync", cron: "*/30 * * * *", timeZone: "local" },
        files: [],
      }),
    );
    // A schedule change pushed from another machine. The first sync to see it is the timer's, and
    // its note goes to the timer's log, which nobody reads.
    me.commit({
      "skills.json": JSON.stringify({
        agents: ["claude-code"],
        timer: { cron: "0 * * * *" },
        sources: [{ id: "vendor", git: vendor.url }],
      }),
    });
    // The timer runs every half hour; by the time the user looks, its next run has replaced the
    // last-run report that held the note.
    for (let run = 0; run < 2; run++) {
      const timerRun = await m.runWith({ env: { ...m.env, SKILLFLEET_TIMER: "1" } }, "sync");
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
      const dir = join(m.root, "state", "skillfleet");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "version"), "0.0.1\n");
      // The installed skillfleet: `sync` finds the timer's sync running, as `sync --json` says it.
      writeFileSync(
        join(dir, "bin", "skillfleet"),
        `#!/bin/sh
v=$(cat "${dir}/version")
case "$1" in
  --version) echo "$v" ;;
  sync) echo '{"ok":false,"error":"another skillfleet sync is running (pid 4242)"}'; echo "skillfleet: another skillfleet sync is running (pid 4242)" >&2; exit 1 ;;
esac
`,
      );
      chmodSync(join(dir, "bin", "skillfleet"), 0o755);
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
        SKILLFLEET_SSH: process.env.SKILLFLEET_SSH,
        PATH: process.env.PATH,
      };
      process.env.XDG_STATE_HOME = join(m.root, "state");
      process.env.SKILLFLEET_SSH = ssh;
      process.env.PATH = pathWith(npx, process.env);
      try {
        const results = await fleet(["localhost"], "upgrade", "0.0.2", 60_000);
        // The host now runs 0.0.2, and its launcher says so.
        expect(
          spawnSync(join(dir, "bin", "skillfleet"), ["--version"], { encoding: "utf8" }).stdout,
        ).toBe("0.0.2\n");
        // It printed only "localhost: another skillfleet sync is running (pid 4242); no run
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
  const root = mkdtempSync(join(tmpdir(), "skillfleet-r5-manifest-"));
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
    ])
      it(`R8-5. refuses ${url}, which reaches this machine`, async () => {
        expect.soft(isRemoteGit(url)).toBe(false);
        expect.soft(await teamGitProblem(url)).toMatch(/this machine|remote repositories/);
      });
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
  });

  describe("editing a manifest in place", () => {
    it("R8-8. does not crash on a manifest that repeats a key, as a hand-merged one can", () => {
      // JSON.parse keeps the last "sources"; the editor walks the first one's items by the last one's
      // indexes and reads past its end.
      const text = `{\n  "sources": [{ "id": "a", "git": "https://example.com/a.git" }],\n  "sources": [\n    { "id": "a", "git": "https://example.com/a.git" },\n    { "id": "b", "git": "https://example.com/b.git" }\n  ]\n}\n`;
      const file = write("r5-dup/skills.json", text);
      editManifest(file, (raw) => {
        const sources = raw.sources as Record<string, unknown>[];
        sources[1]!.exclude = ["x"];
      });
      const after = JSON.parse(readFileSync(file, "utf8")) as { sources: { exclude?: string[] }[] };
      expect(after.sources[1]!.exclude).toEqual(["x"]);
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
      const run = await m.run("init", manifest, "--no-timer");
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
      const run = await m.run("init", manifest, "--no-timer");
      expect(names(m.at(".claude", "skills")), run.stdout + run.stderr).toContain("zipped");
      expect(read(m.at(".claude", "skills", "zipped", "SKILL.md"))).toBe(body);
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
  });
});
