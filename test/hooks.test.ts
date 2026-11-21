// Session hooks, fleetrc's default trigger: `hook run <agent>` starts a sync in the background
// when the last attempt is stale, `hook install` and `hook remove` edit Claude Code's settings.json
// and Codex's hooks.json, and init, status and doctor follow the hooks or the timer.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  editHooksFile,
  hookHandler,
  isOwnHandler,
  withHook,
  withoutHooks,
} from "../src/agenthooks.ts";
import { create, LockHeldError, lockText, takeLock } from "../src/lock.ts";
import {
  cli,
  isWindows,
  machine,
  type Machine,
  read,
  skillMd,
  systemdShim,
  writeFiles,
} from "./fixture.ts";

const SESSION = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" });
const PROMPT = JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit" });

/** A machine pointed at a local folder of skills, with the session hooks installed. */
async function hooked(options: { agents?: boolean; scheduler?: "forbid" | "empty" } = {}) {
  const m = machine(options);
  const mine = join(m.root, "mine");
  writeFiles(mine, { "skills/first/SKILL.md": skillMd("first") });
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [{ id: "mine", local: mine, skills: "skills/*" }],
  });
  const init = await m.run("init", manifest);
  expect(init.code, init.stdout + init.stderr).toBe(0);
  return { m, mine, manifest };
}

const hook = (m: Machine, agent: string, input = SESSION, env: NodeJS.ProcessEnv = {}) =>
  m.runWith({ input, env: { ...m.env, ...env } }, "hook", "run", agent);

const log = (m: Machine) => join(m.stateDir, "logs", "fleetrc-sync.log");
/** The syncs the hooks started, as their lines in the log say. */
const started = (m: Machine) =>
  existsSync(log(m))
    ? read(log(m))
        .split("\n")
        .filter((line) => line.endsWith(" starting a sync"))
    : [];

const lastRun = (m: Machine) =>
  JSON.parse(read(join(m.stateDir, "last-run.json"))) as { finishedAt: string; ok: boolean };

async function waitFor(what: string, check: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

interface Entry {
  command: string;
  args?: string[];
}

const settings = (m: Machine) =>
  JSON.parse(read(m.at(".claude", "settings.json"))) as {
    hooks?: Record<string, { hooks: Entry[] }[]>;
  };

/** An entry as one line: its command, then its args in exec form. */
const line = (entry: Entry) => [entry.command, ...(entry.args ?? [])].join(" ");

describe("hook run", () => {
  it("does nothing, says nothing and creates nothing on a machine that was never set up", async () => {
    const m = machine();
    for (const [agent, input] of [
      ["claude-code", SESSION],
      ["claude-code", PROMPT],
      ["codex", SESSION],
    ] as const) {
      const run = await hook(m, agent, input);
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    const prompt = await m.runWith({ input: PROMPT }, "hook", "prompt");
    expect(prompt).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(m.stateDir)).toBe(false);
  });

  it("writes no compile cache from the installed copy's hook, even on a configured machine", async () => {
    const { m } = await hooked();
    // A fresh attempt, so the hook starts no sync, whose own run may write the cache.
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    rmSync(join(m.stateDir, "app", "compile"), { recursive: true, force: true });
    const syncs = started(m).length;
    const run = spawnSync(
      process.execPath,
      [join(m.stateDir, "app", "cli.mjs"), "hook", "run", "claude-code"],
      { env: m.env, cwd: m.home, input: SESSION, encoding: "utf8" },
    );
    expect({ code: run.status, out: run.stdout + run.stderr }).toEqual({ code: 0, out: "" });
    expect(started(m)).toHaveLength(syncs);
    expect(existsSync(join(m.stateDir, "app", "compile"))).toBe(false);
  });

  it("stays quiet and exits 0 with a broken config.json", async () => {
    const { m } = await hooked();
    rmSync(join(m.stateDir, "hook-attempt"), { force: true });
    writeFileSync(m.at(".config", "fleetrc", "config.json"), "{");
    for (const input of [SESSION, PROMPT, "not json"]) {
      const run = await hook(m, "claude-code", input);
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect(started(m)).toEqual([]);
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
  });

  it("starts one sync when many sessions start at once, and none while the attempt is fresh", async () => {
    const { m, mine } = await hooked();
    const before = lastRun(m).finishedAt;
    writeFiles(mine, { "skills/second/SKILL.md": skillMd("second") });
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => hook(m, i % 2 ? "codex" : "claude-code")),
    );
    for (const run of runs) expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(started(m)).toHaveLength(1);
    // The sync runs on after the hook has exited.
    await waitFor("the hook's sync", () => lastRun(m).finishedAt > before);
    expect(existsSync(m.at(".claude", "skills", "second", "SKILL.md"))).toBe(true);
    // Fresh: the next sessions start nothing.
    await hook(m, "claude-code");
    await hook(m, "codex");
    expect(started(m)).toHaveLength(1);
    // Stale again (the threshold is 0 here): one more.
    await hook(m, "codex", SESSION, { FLEETRC_HOOK_STALE_MS: "0" });
    expect(started(m)).toHaveLength(2);
  });

  it("starts no sync while one holds the lock", async () => {
    const { m } = await hooked();
    // This test's process stands in for a running sync.
    writeFileSync(join(m.stateDir, "sync.lock"), lockText());
    try {
      const run = await hook(m, "claude-code", SESSION, { FLEETRC_HOOK_STALE_MS: "0" });
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(started(m)).toEqual([]);
    } finally {
      rmSync(join(m.stateDir, "sync.lock"), { force: true });
    }
    await hook(m, "claude-code", SESSION, { FLEETRC_HOOK_STALE_MS: "0" });
    expect(started(m)).toHaveLength(1);
  });

  it("waits out a claim another hook holds, and breaks one whose hook is gone", async () => {
    const { m } = await hooked();
    const claim = join(m.stateDir, "hook-attempt.claim");
    // This test's process stands in for a hook that holds the claim.
    writeFileSync(claim, lockText("hook"));
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toEqual([]);
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
    // A hook that was killed holding it: the same claim, naming a process that has exited.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(claim, JSON.stringify({ ...JSON.parse(lockText("hook")), pid: gone }));
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toHaveLength(1);
    expect(existsSync(claim)).toBe(false);
  });

  it("waits out an empty claim for 2 s, as without hard links its holder may still be writing it", async () => {
    // What create() does without hard links: an exclusive open, then the write.
    const dir = join(machine().root, "locks");
    mkdirSync(dir);
    const file = join(dir, "hook-attempt.claim");
    const mine = lockText("hook");
    expect(create(file, mine, false)).toBe(true);
    expect(read(file)).toBe(mine);
    expect(create(file, "another", false)).toBe(false);
    // Between that open and write, a contender finds the file empty.
    writeFileSync(file, "");
    expect(() => takeLock(file, mine, { link: false })).toThrow(LockHeldError);
    const old = new Date(Date.now() - 5000);
    utimesSync(file, old, old);
    takeLock(file, mine, { link: false });
    expect(read(file)).toBe(mine);
    // The hook waits it out the same way.
    const { m } = await hooked();
    const claim = join(m.stateDir, "hook-attempt.claim");
    writeFileSync(claim, "");
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toEqual([]);
    utimesSync(claim, old, old);
    expect((await hook(m, "claude-code")).code).toBe(0);
    expect(started(m)).toHaveLength(1);
  });

  it("starts one sync among hooks that all find the attempt stale, because only one holds the claim", async () => {
    const { m } = await hooked();
    // The claim's holder waits before it stamps, so every hook reads the stamp stale: without the
    // claim, each would start a sync.
    const env = { FLEETRC_HOOK_CLAIM_HOLD_MS: "1500" };
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => hook(m, i % 2 ? "codex" : "claude-code", SESSION, env)),
    );
    for (const run of runs) expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(started(m)).toHaveLength(1);
    expect(existsSync(join(m.stateDir, "hook-attempt.claim"))).toBe(false);
  });

  it("runs the sync in the state folder, with the installing shell's PATH, not the agent's", async () => {
    const { m, mine } = await hooked();
    const seen = join(m.root, "seen.json");
    const script = join(m.root, "record.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));\n`,
    );
    const manifest = JSON.parse(
      read(join(m.root, "manifest", ".fleetrc", "manifest.json")),
    ) as object;
    m.manifest({
      ...manifest,
      hooks: [{ name: "record", run: `"${process.execPath}" "${script}"`, on: ["mine:**"] }],
    });
    writeFiles(mine, { "skills/first/SKILL.md": skillMd("first", "changed") });
    const agentBin = join(m.root, "agent-bin");
    mkdirSync(agentBin);
    const run = await hook(m, "codex", SESSION, {
      PATH: [agentBin, m.env.PATH].join(delimiter),
      FLEETRC_HOOK_STALE_MS: "0",
    });
    expect(run.code).toBe(0);
    await waitFor("the manifest's hook", () => existsSync(seen));
    const { cwd, path } = JSON.parse(read(seen)) as { cwd: string; path: string };
    expect(cwd).toBe(m.stateDir);
    expect(path.split(delimiter)).not.toContain(agentBin);
  });

  it("does nothing on a prompt: an old UserPromptSubmit entry and `hook prompt` start no sync and say nothing", async () => {
    const { m } = await hooked();
    rmSync(join(m.stateDir, "hook-attempt"), { force: true });
    rmSync(join(m.stateDir, "hook-ran-claude-code"), { force: true });
    const syncs = started(m).length;
    for (const agent of ["claude-code", "codex"]) {
      const run = await hook(m, agent, PROMPT);
      expect({ code: run.code, out: run.stdout + run.stderr }).toEqual({ code: 0, out: "" });
    }
    const prompt = await m.runWith({ input: PROMPT }, "hook", "prompt");
    expect({ code: prompt.code, out: prompt.stdout + prompt.stderr }).toEqual({ code: 0, out: "" });
    expect(started(m)).toHaveLength(syncs);
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
    expect(existsSync(join(m.stateDir, "hook-ran-claude-code"))).toBe(false);
  });

  it("ignores an explicit Stop event without recording an attempt or a hook run", async () => {
    const { m } = await hooked();
    writeFileSync(join(m.stateDir, "sync.lock"), lockText());
    const run = await hook(m, "codex", JSON.stringify({ hook_event_name: "Stop" }));
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
    expect(existsSync(join(m.stateDir, "hook-ran-codex"))).toBe(false);
  });

  it("runs the entry it wrote into settings.json as Claude Code does, from a parent that exits at once", async () => {
    const { m, mine } = await hooked();
    const before = lastRun(m).finishedAt;
    writeFiles(mine, { "skills/third/SKILL.md": skillMd("third") });
    const entry = settings(m).hooks!.SessionStart![0]!.hooks[0]!;
    // Shell form through a shell; exec form (Windows) spawns the command itself, with no shell.
    const how = entry.args
      ? `${JSON.stringify(entry.command)}, ${JSON.stringify(entry.args)}, {`
      : `${JSON.stringify(entry.command)}, { shell: true,`;
    // The parent is gone as soon as the hook is: what an agent that quits right after does.
    const parent = `const { spawn } = require("node:child_process");
const child = spawn(${how} stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(${JSON.stringify(SESSION)});
child.on("exit", (code) => process.exit(code ?? 1));`;
    const run = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ["-e", parent], { env: m.env, cwd: m.home });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk));
      child.on("close", (code) => done({ code, out }));
    });
    expect(run).toEqual({ code: 0, out: "" });
    await waitFor("the hook's sync", () => lastRun(m).finishedAt > before);
    expect(lastRun(m).ok).toBe(true);
    expect(existsSync(m.at(".claude", "skills", "third", "SKILL.md"))).toBe(true);
  });
});

describe("hook install and remove", () => {
  it("adds the hook to Claude Code and Codex once, keeping their other hooks, fields and layout", async () => {
    const m = machine();
    const own = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    const original = `${JSON.stringify(own, null, 4)}\n`;
    writeFileSync(m.at(".claude", "settings.json"), original);
    const install = await m.run("hook", "install");
    expect(install.code, install.stderr).toBe(0);
    expect(install.stdout).toContain("Claude Code: added fleetrc's hook to");
    expect(install.stdout).toMatch(/Codex: added .*open \/hooks in Codex and approve it/);
    const text = read(m.at(".claude", "settings.json"));
    expect(text).toContain('\n    "model": "opus"');
    const after = settings(m);
    const ours = (event: string) =>
      after
        .hooks![event]!.flatMap((group) => group.hooks.map(line))
        .filter((text) => text.includes(" hook run claude-code"));
    expect(ours("SessionStart")).toHaveLength(1);
    expect(after.hooks!.UserPromptSubmit!.flatMap((group) => group.hooks)).toHaveLength(1);
    // Windows: node, through bin/'s link, and the installed copy, in exec form.
    expect(ours("SessionStart")[0]).toContain(
      process.platform === "win32"
        ? `${join(m.stateDir, "bin", "node-dir")}\\node.exe ${join(m.stateDir, "app", "cli.mjs")}`
        : 'test -x "$HOME/.local/state/fleetrc/bin/fleetrc" && "$HOME/.local/state/fleetrc/bin/fleetrc" hook run claude-code 2>/dev/null; true',
    );
    expect(after.hooks!.UserPromptSubmit![0]!.hooks[0]!.command).toBe("echo mine");
    expect(after.hooks!.Stop).toEqual(own.hooks.Stop);
    // Codex's file holds only "hooks", the one key besides "description" it accepts.
    const codex = JSON.parse(read(m.at(".codex", "hooks.json"))) as Record<string, unknown>;
    expect(Object.keys(codex)).toEqual(["hooks"]);
    expect(JSON.stringify(codex)).toContain("hook run codex");

    const again = await m.run("hook", "install");
    expect(again.stdout).toContain("Claude Code: hook already in");
    expect(read(m.at(".claude", "settings.json"))).toBe(text);

    const remove = await m.run("hook", "remove");
    expect(remove.code, remove.stderr).toBe(0);
    expect(remove.stdout).toContain("Claude Code: removed fleetrc's hook");
    expect(JSON.parse(read(m.at(".claude", "settings.json")))).toEqual(own);
    expect(JSON.parse(read(m.at(".codex", "hooks.json")))).toEqual({});
    expect((await m.run("hook", "remove")).stdout).toContain("Claude Code: no fleetrc hook in");
  });

  it("replaces an older entry of fleetrc's instead of adding a second, and takes out its prompt hooks", async () => {
    const m = machine();
    writeFileSync(
      m.at(".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          // The shell form an earlier build wrote, which fish can't run with a launcher gone.
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    '"$HOME/.local/state/fleetrc/bin/fleetrc" hook run claude-code 2>/dev/null || true',
                },
              ],
            },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "npx fleetrc hook prompt" }] },
            {
              hooks: [
                { type: "command", command: "echo mine" },
                {
                  type: "command",
                  command:
                    'test -x "$HOME/.local/state/fleetrc/bin/fleetrc" && "$HOME/.local/state/fleetrc/bin/fleetrc" hook run claude-code 2>/dev/null; true',
                },
              ],
            },
          ],
        },
      }),
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    const start = settings(m).hooks!.SessionStart!;
    expect(start).toHaveLength(1);
    expect(line(start[0]!.hooks[0]!)).not.toContain("|| true");
    expect(line(start[0]!.hooks[0]!)).toMatch(
      isWindows ? / hook run claude-code$/ : / hook run claude-code 2>\/dev\/null; true$/,
    );
    // The user's own prompt hook stays; fleetrc's two are gone.
    expect(settings(m).hooks!.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "echo mine" }] },
    ]);
  });

  it("disables legacy Codex prompt hooks from another state directory without shifting other hooks", async () => {
    const m = machine();
    const file = m.at(".codex", "hooks.json");
    const launcher = join(m.stateDir, "bin", isWindows ? "fleetrc.cmd" : "fleetrc");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(
      launcher,
      isWindows ? "@echo old launcher\r\n" : "#!/bin/sh\necho old launcher\n",
      { mode: 0o755 },
    );
    const legacy = hookHandler("codex", { launcher, home: m.home });
    const custom = { type: "command", command: "echo mine", timeout: 10 };
    const runPrompt = (command: string) => {
      const result = spawnSync(command, {
        shell: true,
        cwd: m.home,
        env: m.env,
        input: PROMPT,
        encoding: "utf8",
      });
      return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
    };
    expect(runPrompt(legacy.command)).toEqual({ code: 0, stdout: "old launcher", stderr: "" });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [legacy] },
            { hooks: [legacy, custom, legacy] },
            { hooks: [legacy] },
          ],
        },
      }),
    );
    const env = { ...m.env, XDG_STATE_HOME: join(m.root, "new-state") };
    const install = () => m.runWith({ env }, "hook", "install", "codex");
    expect((await install()).code).toBe(0);
    const installed = read(file);
    const { UserPromptSubmit: groups } = JSON.parse(installed).hooks as {
      UserPromptSubmit: { hooks: Entry[] }[];
    };
    expect(groups).toHaveLength(2);
    expect(groups[0]!.hooks).toHaveLength(1);
    expect(groups[1]!.hooks).toHaveLength(2);
    expect(groups[1]!.hooks[1]).toEqual(custom);
    for (const group of groups) {
      expect(runPrompt(group.hooks[0]!.command)).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect((await install()).code).toBe(0);
    expect(read(file)).toBe(installed);
    // Removing keeps the no-ops where the user's hook comes after them, so it keeps its place.
    expect((await m.runWith({ env }, "hook", "remove", "codex")).code).toBe(0);
    expect(JSON.parse(read(file)).hooks).toEqual({ UserPromptSubmit: groups });
    const removed = read(file);
    expect((await m.runWith({ env }, "hook", "remove", "codex")).code).toBe(0);
    expect(read(file)).toBe(removed);
  });

  it("replaces an older Codex SessionStart entry where it stands, so a hook after it keeps its place", async () => {
    const m = machine();
    const file = m.at(".codex", "hooks.json");
    const older = { type: "command", command: "npx -y fleetrc hook prompt" };
    const custom = { type: "command", command: "echo mine" };
    writeFileSync(
      file,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [older] }, { hooks: [custom] }] } }),
    );
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    const groups = (JSON.parse(read(file)).hooks as { SessionStart: { hooks: Entry[] }[] })
      .SessionStart;
    expect(groups).toHaveLength(2);
    expect(line(groups[0]!.hooks[0]!)).toMatch(/hook run codex/);
    expect(groups[1]!.hooks).toEqual([custom]);
    // Run again, it changes nothing.
    const once = read(file);
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    expect(read(file)).toBe(once);
  });

  it.each([null, ".*"])("keeps the Codex hook in its catch-all matcher %s", async (matcher) => {
    const m = machine();
    const file = m.at(".codex", "hooks.json");
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    const current = (JSON.parse(read(file)).hooks as { SessionStart: { hooks: Entry[] }[] })
      .SessionStart[0]!.hooks[0]!;
    const custom = { type: "command", command: "echo mine" };
    const layout = { hooks: { SessionStart: [{ matcher, hooks: [current, custom] }] } };
    writeFileSync(file, JSON.stringify(layout));
    const before = read(file);
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    expect(read(file)).toBe(before);
  });

  it("moves Claude Code's entry out of a group with matcher null, which Claude Code skips", async () => {
    const m = machine();
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    const file = m.at(".claude", "settings.json");
    const current = settings(m).hooks!.SessionStart![0]!.hooks[0]!;
    writeFileSync(
      file,
      JSON.stringify({ hooks: { SessionStart: [{ matcher: null, hooks: [current] }] } }),
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    const groups = (
      JSON.parse(read(file)).hooks as { SessionStart: { matcher?: unknown; hooks: Entry[] }[] }
    ).SessionStart;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBeUndefined();
    expect(groups[0]!.hooks).toEqual([current]);
  });

  it("puts the Codex entry in a group for every session when the older one is under a matcher, and status ignores placeholders", async () => {
    const m = machine();
    const file = m.at(".codex", "hooks.json");
    const older = { type: "command", command: "npx -y fleetrc hook prompt" };
    const custom = { type: "command", command: "echo mine" };
    writeFileSync(
      file,
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "resume", hooks: [older, custom] }] } }),
    );
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    const groups = (
      JSON.parse(read(file)).hooks as {
        SessionStart: { matcher?: string; hooks: Entry[] }[];
      }
    ).SessionStart;
    // The user's hook keeps its place; fleetrc's runs for every session start.
    expect(groups[0]!.matcher).toBe("resume");
    expect(groups[0]!.hooks[1]).toEqual(custom);
    expect(groups.at(-1)!.matcher).toBeUndefined();
    expect(line(groups.at(-1)!.hooks[0]!)).toMatch(/hook run codex/);
    // The current entry under a matcher, as an edit by hand may leave it, moves out too.
    const current = groups.at(-1)!.hooks[0]!;
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: "resume", hooks: [current, custom] }] },
      }),
    );
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    const moved = (
      JSON.parse(read(file)).hooks as { SessionStart: { matcher?: string; hooks: Entry[] }[] }
    ).SessionStart;
    expect(moved[0]!.hooks[1]).toEqual(custom);
    expect(moved.at(-1)!.matcher).toBeUndefined();
    expect(moved.at(-1)!.hooks).toEqual([current]);
    // Once removed, the no-op left in its place starts nothing, so status lists no hook.
    expect((await m.run("hook", "remove", "codex")).code).toBe(0);
    expect(JSON.parse(read(file)).hooks.SessionStart[0].hooks[1]).toEqual(custom);
    const status = await m.json<{ trigger: { hooks: unknown[] } }>("status");
    expect(status.trigger.hooks).toEqual([]);
  });

  it("on Windows writes Claude Code's entry in exec form, and Codex's for cmd, with % kept from cmd", () => {
    const profile = "C:\\Users\\Jo & Ann %PATH% x";
    const state = `${profile}\\AppData\\Local\\fleetrc`;
    const options = {
      platform: "win32" as const,
      launcher: `${state}\\bin\\fleetrc.cmd`,
      node: `${state}\\bin\\node-dir\\node.exe`,
      cli: `${state}\\app\\cli.mjs`,
      profile,
    };
    expect(hookHandler("claude-code", options)).toEqual({
      type: "command",
      command: options.node,
      args: [options.cli, "hook", "run", "claude-code"],
    });
    // cmd /C expands %PATH% even in quotes, but not inside what %USERPROFILE% expands to.
    expect(hookHandler("codex", options).command).toBe(
      '"%USERPROFILE%\\AppData\\Local\\fleetrc\\bin\\fleetrc.cmd" hook run codex',
    );
    const plain = "C:\\Users\\Jo & Ann\\AppData\\Local\\fleetrc\\bin\\fleetrc.cmd";
    expect(hookHandler("codex", { ...options, launcher: plain }).command).toBe(
      `"${plain}" hook run codex`,
    );
    expect(
      hookHandler("claude-code", { platform: "linux", launcher: "/h/a b/fleetrc", home: "/u" }),
    ).toEqual({
      type: "command",
      command:
        'test -x "/h/a b/fleetrc" && "/h/a b/fleetrc" hook run claude-code 2>/dev/null; true',
    });

    // An entry an older install wrote in shell form gives way to exec form, once.
    const old = { type: "command", command: `"${options.launcher}" hook run claude-code` };
    const mine = { type: "command", command: "echo mine" };
    const raw: Record<string, unknown> = {
      hooks: { SessionStart: [{ hooks: [old] }], UserPromptSubmit: [{ hooks: [mine, old] }] },
    };
    const handler = hookHandler("claude-code", options);
    withHook(raw, handler, "claude-code");
    expect(raw).toEqual({
      hooks: {
        SessionStart: [{ hooks: [handler] }],
        UserPromptSubmit: [{ hooks: [mine] }],
      },
    });
    const once = JSON.stringify(raw);
    withHook(raw, handler, "claude-code");
    expect(JSON.stringify(raw)).toBe(once);
    expect(isOwnHandler(handler)).toBe(true);
    // Another program's node script is not fleetrc's.
    expect(
      isOwnHandler({ command: "node", args: ["C:\\tools\\app\\cli.mjs", "hook", "run"] }),
    ).toBe(false);
    withoutHooks(raw);
    expect(raw).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [mine] }] } });
  });

  it("--dry-run writes nothing", async () => {
    const m = machine();
    const dry = await m.run("hook", "install", "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Claude Code: would add fleetrc's hook");
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(false);
    expect(existsSync(m.stateDir)).toBe(false);
  });

  it("follows CLAUDE_CONFIG_DIR, and without an agent skips one whose folder is missing", async () => {
    const m = machine({ agents: false });
    const config = join(m.root, "claude-config");
    mkdirSync(config);
    const env = { ...m.env, CLAUDE_CONFIG_DIR: config };
    const run = await m.runWith({ env }, "hook", "install", "--json");
    expect(run.code, run.stderr).toBe(0);
    const changes = JSON.parse(run.stdout) as {
      agent: string;
      changed: boolean;
      skipped?: string;
    }[];
    expect(changes.find((change) => change.agent === "claude-code")).toMatchObject({
      changed: true,
    });
    expect(changes.find((change) => change.agent === "codex")?.skipped).toContain("does not exist");
    expect(existsSync(join(config, "settings.json"))).toBe(true);
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    expect(existsSync(m.at(".codex"))).toBe(false);
    // Named, an agent gets its folder.
    expect((await m.runWith({ env }, "hook", "install", "codex")).code).toBe(0);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(true);
  });

  it("leaves a settings.json it can't read alone, and fails", async () => {
    const m = machine();
    writeFileSync(m.at(".claude", "settings.json"), "{ not json");
    const run = await m.run("hook", "install", "claude-code");
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("is not valid JSON");
    expect(read(m.at(".claude", "settings.json"))).toBe("{ not json");
    expect((await m.run("hook", "install", "gemini")).code).toBe(2);
  });
});

describe("init, status and doctor with the hooks or the timer", () => {
  it("does not count a removed Codex session hook kept as an approval placeholder", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["codex"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("hook", "install", "codex")).code).toBe(0);
    const file = m.at(".codex", "hooks.json");
    const raw = JSON.parse(read(file)) as { hooks: { SessionStart: { hooks: Entry[] }[] } };
    const custom = { type: "command", command: "echo custom" };
    raw.hooks.SessionStart[0]!.hooks.push(custom);
    writeFileSync(file, JSON.stringify(raw));

    expect((await m.run("hook", "remove", "codex")).code).toBe(0);
    const removed = JSON.parse(read(file)) as typeof raw;
    const handlers = removed.hooks.SessionStart[0]!.hooks;
    expect(handlers[0]?.command).toContain("fleetrc: disabled legacy hook");
    expect(handlers[1]).toEqual(custom);
    const json = await m.json<{ trigger: { hooks: string[]; timer: boolean } }>("status");
    expect(json.trigger).toEqual({ hooks: [], timer: false });
    expect((await m.run("doctor")).stdout).toMatch(/^warn sync trigger: nothing starts a sync/m);
  });

  it("reports a fresh Codex-only hook as configured, not active without approval", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["codex"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("hook", "install", "codex")).code).toBe(0);

    expect((await m.run("status")).stdout).toMatch(
      /^syncs start from: the session hooks of Codex \(configured; requires approval in \/hooks\)$/m,
    );
    const doctor = (await m.run("doctor")).stdout;
    expect(doctor).toMatch(
      /^warn sync trigger: .*Codex \(configured; requires approval in \/hooks\)$/m,
    );
    expect(doctor).toMatch(/^warn session hooks: Codex's has not run yet/m);
  });

  it("init installs the hooks and no timer; status and doctor report the hooks", async () => {
    const { m } = await hooked({ scheduler: "empty" });
    // init does not reach the scheduler; doctor asks it once whether a timer exists.
    expect(m.schedulerCalls()).toEqual([]);
    expect(settings(m).hooks!.SessionStart).toHaveLength(1);
    expect(existsSync(m.at(".codex", "hooks.json"))).toBe(true);
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: the session hooks of Claude Code and Codex \(configured; requires approval in \/hooks\)$/m,
    );
    expect(status.stdout).not.toMatch(/^timer:/m);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(
      /^ok {3}sync trigger: the session hooks of Claude Code and Codex \(configured; requires approval in \/hooks\)$/m,
    );
    const json = await m.json<{ trigger: { hooks: string[]; timer: boolean } }>("status");
    expect(json.trigger).toEqual({ hooks: ["claude-code", "codex"], timer: false });
    // init again: unchanged.
    const text = read(m.at(".claude", "settings.json"));
    const again = await m.run("init");
    expect(again.stdout).toContain("Claude Code: hook already in");
    expect(read(m.at(".claude", "settings.json"))).toBe(text);
  });

  it("init --no-hooks installs neither, and status and doctor warn that nothing starts a sync", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: nothing starts a sync on this machine; run `fleetrc hook install`/m,
    );
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(
      /^warn sync trigger: nothing starts a sync.*`fleetrc timer install`/m,
    );
    expect(doctor.code).toBe(0);
  });

  it("with the timer, status and doctor report it; init keeps it, and --timer asks for it", async () => {
    const m = machine({ scheduler: "refuse" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest)).code).toBe(0);
    expect(m.schedulerCalls()).toEqual([]);
    const timer = await m.run("init", manifest, "--timer", "--no-hooks");
    expect(timer.stdout).toContain("the timer was not installed");
    // A machine where `timer install` ran once.
    writeFileSync(
      m.at(".config", "fleetrc", "config.json"),
      JSON.stringify({ manifest, timer: true }),
    );
    const status = await m.run("status");
    expect(status.stdout).toMatch(
      /^syncs start from: the session hooks of Claude Code and Codex \(configured; requires approval in \/hooks\), and the timer$/m,
    );
    expect(status.stdout).toMatch(/^timer: /m);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).toMatch(/^ok {3}sync trigger: .*, and the timer$/m);
    expect(doctor.stdout).toMatch(/^FAIL timer: /m);
    // init installs the timer again, without --timer.
    const calls = m.schedulerCalls().length;
    const again = await m.run("init");
    expect(again.stdout).toContain("the timer was not installed");
    expect(m.schedulerCalls().length).toBeGreaterThan(calls);
    // Only the timer.
    expect((await m.run("hook", "remove")).code).toBe(0);
    expect((await m.run("status")).stdout).toMatch(/^syncs start from: the timer$/m);
  });

  it("init on a machine without Claude Code or Codex says no hook starts a sync", async () => {
    const m = machine({ agents: false });
    mkdirSync(m.at(".gemini"), { recursive: true });
    const manifest = m.manifest({ agents: ["gemini-cli"], sources: [] });
    const init = await m.run("init", manifest);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("no Claude Code or Codex here, so no session hook starts a sync");
    expect(readFileSync(join(m.stateDir, "hook-env.json"), "utf8")).toContain('"PATH"');
  });
});

describe("the hooks on shared and upgraded machines", () => {
  it("self-install over a bare shell keeps the saved hook environment, putting the new node's folder before the old", async () => {
    if (isWindows) return;
    const m = machine();
    const node = (name: string) => {
      const dir = join(m.root, name, "bin");
      mkdirSync(dir, { recursive: true });
      symlinkSync(process.execPath, join(dir, "node"));
      return dir;
    };
    const [a, b] = [node("node-a"), node("node-b")];
    // The old node's folder holds git too, as /usr/bin or /opt/homebrew/bin do.
    writeFileSync(join(a, "git"), "#!/bin/sh\necho old-folder-git\n");
    chmodSync(join(a, "git"), 0o755);
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const init = await m.runWith(
      { env: { PATH: [a, m.env.PATH].join(delimiter) } },
      "init",
      manifest,
    );
    expect(init.code, init.stderr).toBe(0);
    const saved = JSON.parse(read(join(m.stateDir, "hook-env.json"))) as Record<string, string>;
    expect(saved.PATH!.split(delimiter)[0]).toBe(a);
    // What `fleet upgrade` gets over ssh: HOME and a PATH, nothing else.
    const bare = { HOME: m.home, PATH: [b, "/usr/bin", "/bin"].join(delimiter) };
    const run = spawnSync(process.execPath, [cli, "self-install"], {
      env: bare,
      cwd: m.home,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const after = JSON.parse(read(join(m.stateDir, "hook-env.json"))) as Record<string, string>;
    expect(after).toEqual({ ...saved, PATH: [b, saved.PATH].join(delimiter) });
    // The tools in the old folder are still found.
    const git = spawnSync("git", [], { env: { PATH: after.PATH }, encoding: "utf8", shell: true });
    expect(git.stdout.trim()).toBe("old-folder-git");
  });

  describe("writing a hooks file", () => {
    const file = () => {
      const dir = join(machine().root, "claude");
      mkdirSync(dir);
      return join(dir, "settings.json");
    };
    const addHook = (raw: Record<string, unknown>) =>
      withHook(
        raw,
        { type: "command", command: '"/s/fleetrc" hook run claude-code' },
        "claude-code",
      );
    const stop = { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] };

    it("keeps a handler added while it edits, by trying again on what is there now", () => {
      const settings = file();
      writeFileSync(settings, "{}\n");
      let first = true;
      const result = editHooksFile(settings, addHook, {
        step: () => {
          if (first) writeFileSync(settings, `${JSON.stringify({ hooks: stop })}\n`);
          first = false;
        },
      });
      expect(result).toEqual({ changed: true });
      const raw = JSON.parse(read(settings)) as { hooks: Record<string, unknown> };
      expect(raw.hooks.Stop).toEqual(stop.Stop);
      expect(Object.keys(raw.hooks)).toEqual(["Stop", "SessionStart"]);
    });

    it("writes nothing and says so when the file keeps changing", () => {
      const settings = file();
      writeFileSync(settings, "{}\n");
      let n = 0;
      const result = editHooksFile(settings, addHook, {
        step: () => writeFileSync(settings, `{ "n": ${++n} }\n`),
      });
      expect(result.changed).toBe(false);
      expect(result.error).toContain("changed while fleetrc was editing it");
      expect(read(settings)).toBe('{ "n": 2 }\n');
      expect(readdirSync(dirname(settings))).toEqual(["settings.json"]);
    });

    it.skipIf(isWindows).each([false, true])("keeps settings private (exists=%s)", (existing) => {
      const settings = file();
      if (existing) {
        writeFileSync(settings, "{}\n");
        chmodSync(settings, 0o600);
      }
      const modes: number[] = [];
      const step = () => {
        for (const name of readdirSync(dirname(settings)))
          if (name.endsWith(".tmp"))
            modes.push(statSync(join(dirname(settings), name)).mode & 0o777);
      };
      expect(editHooksFile(settings, addHook, { create: true, step }).changed).toBe(true);
      expect(modes).toEqual([0o600]);
      expect(statSync(settings).mode & 0o777).toBe(0o600);
    });

    it.skipIf(isWindows)(
      "edits a linked file through the link, and leaves a dangling link alone",
      () => {
        const settings = file();
        const target = join(dirname(settings), "real.json");
        writeFileSync(target, "{}\n");
        symlinkSync(target, settings);
        expect(editHooksFile(settings, addHook).changed).toBe(true);
        expect(lstatSync(settings).isSymbolicLink()).toBe(true);
        expect(read(target)).toContain("hook run claude-code");
        rmSync(target);
        const dangling = editHooksFile(settings, addHook, { create: true });
        expect(dangling.changed).toBe(false);
        expect(dangling.error).toContain("which does not exist; fleetrc left it alone");
        expect(lstatSync(settings).isSymbolicLink()).toBe(true);
        expect(existsSync(target)).toBe(false);
      },
    );
  });

  it("owns only the commands it writes, and a user's command that mentions them is left", async () => {
    const own = [
      'test -x "$HOME/.local/state/fleetrc/bin/fleetrc" && "$HOME/.local/state/fleetrc/bin/fleetrc" hook run claude-code 2>/dev/null; true',
      'test -x "/opt/my state/fleetrc/bin/fleetrc" && "/opt/my state/fleetrc/bin/fleetrc" hook run codex 2>/dev/null; true',
      // What earlier versions wrote, recognised so that it is replaced.
      '"$HOME/.local/state/fleetrc/bin/fleetrc" hook run claude-code 2>/dev/null || true',
      "/home/u/.local/state/fleetrc/bin/fleetrc hook run codex",
      '"%USERPROFILE%\\AppData\\Local\\fleetrc\\bin\\fleetrc.cmd" hook run codex',
      '"C:\\Users\\Jo & Ann\\AppData\\Local\\fleetrc\\bin\\fleetrc.cmd" hook run codex',
      "fleetrc hook prompt",
      "npx fleetrc hook prompt",
      "/home/u/.local/state/fleetrc/bin/fleetrc hook prompt",
    ];
    const theirs = [
      "printf 'run: fleetrc hook run codex\\n'",
      "foo && fleetrc hook run codex",
      '"$HOME/.local/state/fleetrc/bin/fleetrc" hook run codex; rm -rf ~/x',
      "echo /x/fleetrc hook run claude-code",
      "fleetrc hook run claude-code | tee log",
      "my-fleetrc-wrapper hook run codex",
      'test -x "/a/fleetrc" && "/b/fleetrc" hook run codex 2>/dev/null; true',
      'test -x "/a/fleetrc" && "/a/fleetrc" hook run codex 2>/dev/null; rm -rf ~; true',
    ];
    for (const command of own)
      expect(isOwnHandler({ type: "command", command }), command).toBe(true);
    for (const command of theirs)
      expect(isOwnHandler({ type: "command", command }), command).toBe(false);
    const exec = [
      "C:\\Users\\u\\AppData\\Local\\fleetrc\\app\\cli.mjs",
      "hook",
      "run",
      "claude-code",
    ];
    expect(isOwnHandler({ command: "C:\\node.exe", args: exec })).toBe(true);
    expect(isOwnHandler({ command: "node", args: [...exec, "--x"] })).toBe(false);
    expect(
      isOwnHandler({
        command: "C:\\Users\\u\\AppData\\Local\\fleetrc\\bin\\node-dir\\node.exe",
        args: exec,
      }),
    ).toBe(true);
    // bin/node-dir keeps node's own name, which may be a renamed binary.
    expect(
      isOwnHandler({
        command: "C:\\Users\\u\\AppData\\Local\\fleetrc\\bin\\node-dir\\node-v24.exe",
        args: exec,
      }),
    ).toBe(true);
    expect(isOwnHandler({ command: "node", args: exec })).toBe(true);
    // A user's program that happens to take fleetrc's args is theirs.
    expect(isOwnHandler({ command: "C:\\tools\\audit-hook.exe", args: exec })).toBe(false);
    expect(isOwnHandler({ command: "/usr/bin/nodemon", args: exec })).toBe(false);

    const m = machine();
    const users = [
      ...theirs.map((command) => ({ hooks: [{ type: "command", command }] })),
      { hooks: [{ type: "command", command: "C:\\tools\\audit-hook.exe", args: exec }] },
    ];
    writeFileSync(
      m.at(".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: users } }),
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    expect((await m.run("hook", "remove", "claude-code")).code).toBe(0);
    expect(settings(m).hooks!.SessionStart).toEqual(users);
  });

  it("finds its config through the state folder it runs from, when the agent lacks the installer's XDG folders", async () => {
    const m = machine();
    const env = {
      ...m.env,
      XDG_CONFIG_HOME: join(m.root, "cfg"),
      XDG_STATE_HOME: join(m.root, "st"),
    };
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.runWith({ env }, "init", manifest)).code).toBe(0);
    const state = join(m.root, "st", "fleetrc");
    // The agent's environment: no XDG_CONFIG_HOME or XDG_STATE_HOME.
    const agent = { ...m.env };
    delete agent.XDG_CONFIG_HOME;
    delete agent.XDG_STATE_HOME;
    const run = spawnSync(
      process.execPath,
      [join(state, "app", "cli.mjs"), "hook", "run", "codex"],
      {
        env: agent,
        cwd: m.home,
        input: SESSION,
        encoding: "utf8",
      },
    );
    expect({ code: run.status, out: run.stdout + run.stderr }).toEqual({ code: 0, out: "" });
    expect(read(join(state, "logs", "fleetrc-sync.log"))).toContain("starting a sync");
    expect(existsSync(m.at(".local", "state", "fleetrc"))).toBe(false);
  });

  it("syncs and lists installed state while honoring explicit and existing Windows state", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    writeFiles(mine, { "skills/first/SKILL.md": skillMd("first") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: mine, skills: "skills/*" }],
    });
    const env = { ...m.env, XDG_STATE_HOME: join(m.root, "st") };
    const init = await m.runWith({ env }, "init", manifest, "--no-hooks");
    expect(init.code, init.stderr).toBe(0);
    const state = join(env.XDG_STATE_HOME, "fleetrc");
    expect(existsSync(join(state, "hook-env.json"))).toBe(false);
    const caller: NodeJS.ProcessEnv = { ...env };
    delete caller.XDG_STATE_HOME;
    caller.LOCALAPPDATA = join(m.root, "local-app-data");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [join(state, "app", "cli.mjs"), ...args], {
        env: caller,
        cwd: m.home,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const names = (output: string) =>
      (JSON.parse(output) as { skills: { name: string }[] }).skills.map(({ name }) => name);
    expect(names(run("list", "--json"))).toEqual(["first"]);
    expect(names(run("--json", "list"))).toEqual(["first"]);
    expect(run("list")).toContain("first");

    const local = join(caller.LOCALAPPDATA, "fleetrc");
    if (isWindows) {
      const install = await m.runWith(
        { env: { ...caller, XDG_STATE_HOME: undefined } },
        "self-install",
      );
      expect(install.code, install.stderr).toBe(0);
      expect(existsSync(join(local, "bin", "fleetrc.cmd"))).toBe(true);
      expect(existsSync(join(local, "state.json"))).toBe(false);
      expect(names(run("list", "--json"))).toEqual(["first"]);
    }

    writeFiles(mine, { "skills/second/SKILL.md": skillMd("second") });
    run("sync");
    expect(names(run("list", "--json"))).toEqual(["first", "second"]);
    expect(existsSync(join(local, "state.json"))).toBe(false);

    writeFiles(mine, { "skills/third/SKILL.md": skillMd("third") });
    caller.XDG_STATE_HOME = caller.LOCALAPPDATA;
    expect(names(run("list", "--json"))).toEqual([]);
    run("sync");
    expect(names(run("list", "--json"))).toEqual(["first", "second", "third"]);
    expect(names(run("--json", "list"))).toEqual(["first", "second", "third"]);
    expect(run("list")).toContain("third");
    delete caller.XDG_STATE_HOME;
    if (isWindows) {
      expect(names(run("list", "--json"))).toEqual(["first", "second", "third"]);
      caller.XDG_STATE_HOME = join(m.root, "uninitialized");
      expect(names(run("list", "--json"))).toEqual([]);
      delete caller.XDG_STATE_HOME;

      const customState = read(join(state, "state.json"));
      const customReport = read(join(state, "last-run.json"));
      const localState = join(local, "state.json");
      writeFileSync(localState, "not JSON");
      chmodSync(localState, 0o444);
      const recovered = run("sync", "--json");
      expect(recovered).toContain("was corrupt");
      expect(names(run("list", "--json"))).toEqual(["first", "second", "third"]);
      expect(read(join(local, "last-run.json"))).toContain("was corrupt");
      const backups = readdirSync(join(local, "backup"))
        .filter((name) => name.startsWith("state-"))
        .map((name) => read(join(local, "backup", name)));
      expect(backups).toEqual(["not JSON"]);
      expect(read(join(state, "state.json"))).toBe(customState);
      expect(read(join(state, "last-run.json"))).toBe(customReport);
    }
    delete caller.LOCALAPPDATA;
    expect(names(run("list", "--json"))).toEqual(["first", "second"]);
    // The installed copy keeps node's compile cache beside itself, and nowhere else.
    expect(existsSync(join(state, "app", "compile"))).toBe(true);
    expect(existsSync(m.at(".cache"))).toBe(false);
  });

  describe("the shell-form command", () => {
    const available = (shell: string) =>
      !isWindows && spawnSync(shell, ["-c", "true"]).status === 0;

    it.skipIf(isWindows)("names the launcher from $HOME and tests it before running it", () => {
      const { command } = hookHandler("codex", {
        launcher: "/home/u/.local/state/fleetrc/bin/fleetrc",
        home: "/home/u",
      });
      expect(command).toBe(
        'test -x "$HOME/.local/state/fleetrc/bin/fleetrc" && "$HOME/.local/state/fleetrc/bin/fleetrc" hook run codex 2>/dev/null; true',
      );
    });

    // Codex runs it with `$SHELL -lc`, which may be any of these; Claude Code with sh.
    for (const shell of ["sh", "bash", "dash", "zsh", "fish"])
      it.skipIf(!available(shell))(
        `in ${shell}, exits 0 silently when the launcher or its node is gone, and passes the hook's output on`,
        () => {
          const m = machine();
          const launcher = m.at(".local", "state", "fleetrc", "bin", "fleetrc");
          const { command } = hookHandler("codex", { launcher, home: m.home });
          const run = () =>
            spawnSync(shell, ["-c", command], {
              env: { PATH: "/usr/bin:/bin", HOME: m.home },
              encoding: "utf8",
            });
          const quiet = { status: 0, stdout: "", stderr: "" };
          expect(run(), "no launcher").toMatchObject(quiet);
          mkdirSync(dirname(launcher), { recursive: true });
          // A launcher whose node is gone, as after a Node.js upgrade.
          writeFileSync(launcher, '#!/bin/sh\nexec "/gone/node" "$@"\n');
          chmodSync(launcher, 0o755);
          expect(run(), "no node").toMatchObject(quiet);
          writeFileSync(launcher, '#!/bin/sh\necho "$@"\n');
          expect(run(), "a working launcher").toMatchObject({
            status: 0,
            stdout: "hook run codex\n",
          });
        },
      );
  });

  it("doctor warns about each agent whose hook has not run in a day, naming Codex's /hooks", async () => {
    const { m } = await hooked({ scheduler: "empty" });
    const never = await m.run("doctor");
    expect(never.stdout).toMatch(
      /^warn session hooks: Claude Code's has not run yet, .*; Codex's has not run yet, .*open \/hooks in Codex/m,
    );
    // Only Claude Code's hook runs: Codex's is the one doctor warns about.
    await hook(m, "claude-code");
    const mixed = (await m.run("doctor")).stdout;
    expect(mixed).toMatch(
      /^warn session hooks: Claude Code's ran within the last day; Codex's has not run yet, .*open \/hooks in Codex/m,
    );
    await hook(m, "codex");
    expect((await m.run("doctor")).stdout).toMatch(
      /^ok {3}session hooks: Claude Code's ran within the last day; Codex's ran within the last day$/m,
    );
    const day = new Date(Date.now() - 25 * 60 * 60_000);
    writeFileSync(join(m.stateDir, "hook-ran-codex"), String(day.getTime()));
    expect((await m.run("doctor")).stdout).toMatch(
      /^warn session hooks: Claude Code's ran within the last day; Codex's has not run in the last day/m,
    );
  });

  it("the old hook prompt entry is no sync trigger, and hook install takes it out", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const old = { hooks: [{ type: "command", command: "npx fleetrc hook prompt" }] };
    writeFileSync(
      m.at(".claude", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [old] } }),
    );
    const status = await m.run("status");
    expect(status.stdout).toMatch(/^syncs start from: nothing starts a sync on this machine/m);
    expect((await m.json<{ trigger: object }>("status")).trigger).toEqual({
      hooks: [],
      timer: false,
    });
    expect((await m.run("doctor")).stdout).toMatch(
      /^warn sync trigger: nothing starts a sync.*holds the old `fleetrc hook prompt` entry, which starts no sync/m,
    );
    expect((await m.run("hook", "install", "claude-code")).code).toBe(0);
    expect(settings(m).hooks!.UserPromptSubmit).toBeUndefined();
    expect((await m.run("doctor")).stdout).toMatch(
      /^ok {3}sync trigger: the session hooks of Claude Code$/m,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "doctor records a timer installed before config.json did, only when it runs this install and the user did not say no",
    async () => {
      const m = machine();
      const PATH = systemdShim(m);
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      expect((await m.runWith({ env: { PATH } }, "init", manifest, "--timer")).code).toBe(0);
      const config = m.at(".config", "fleetrc", "config.json");
      writeFileSync(config, JSON.stringify({ manifest }));
      const doctor = await m.runWith({ env: { PATH } }, "doctor");
      expect(doctor.stdout).toMatch(/^ok {3}sync trigger: .*, and the timer$/m);
      expect(JSON.parse(read(config))).toEqual({ manifest, timer: true });
      // status alone does not ask.
      writeFileSync(config, JSON.stringify({ manifest }));
      expect((await m.runWith({ env: { PATH } }, "status")).stdout).toMatch(
        /^syncs start from: the session hooks of Claude Code and Codex \(configured; requires approval in \/hooks\)$/m,
      );
      expect(JSON.parse(read(config))).toEqual({ manifest });
      // `timer: false` is the user's choice.
      writeFileSync(config, JSON.stringify({ manifest, timer: false }));
      expect((await m.runWith({ env: { PATH } }, "doctor")).stdout).not.toMatch(/and the timer$/m);
      expect(JSON.parse(read(config))).toEqual({ manifest, timer: false });
      // A timer that runs another install's copy is that install's.
      const service = m.at(".config", "systemd", "user", "fleetrc-sync.service");
      writeFileSync(
        service,
        read(service).replaceAll(m.stateDir, join(m.root, "other", "fleetrc")),
      );
      writeFileSync(config, JSON.stringify({ manifest }));
      await m.runWith({ env: { PATH } }, "doctor");
      expect(JSON.parse(read(config))).toEqual({ manifest });
    },
  );

  it("names a skill linked between SessionStart and the first prompt, and rewrites the session's record only on a change", async () => {
    const { m, mine } = await hooked();
    // A sync this session's hook did not start: the attempt is fresh.
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    expect((await hook(m, "claude-code", SESSION)).stdout).toBe("");
    await new Promise((done) => setTimeout(done, 20));
    writeFiles(mine, { "skills/early/SKILL.md": skillMd("early") });
    expect((await m.run("sync")).code).toBe(0);
    const said = await hook(m, "claude-code", PROMPT);
    expect(said.stdout).toContain("available now: early");
    const sessions = join(m.stateDir, "sessions", "s1.json");
    const { mtimeMs } = statSync(sessions);
    await new Promise((done) => setTimeout(done, 50));
    expect((await hook(m, "claude-code", PROMPT)).stdout).toBe("");
    expect((await hook(m, "claude-code", SESSION)).stdout).toBe("");
    expect(statSync(sessions).mtimeMs).toBe(mtimeMs);
  });

  it("announces a linked skill after switching its source to an equivalent path", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    const alias = join(m.root, "alias");
    writeFiles(mine, { "skills/first/SKILL.md": skillMd("first") });
    const linkType = isWindows ? "junction" : "dir";
    symlinkSync(mine, alias, linkType);
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: alias }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    expect((await hook(m, "claude-code", SESSION)).code).toBe(0);
    writeFiles(mine, { "skills/second/SKILL.md": skillMd("second") });
    expect((await m.run("sync")).code).toBe(0);
    writeFileSync(
      manifest,
      JSON.stringify({ agents: ["claude-code"], sources: [{ id: "mine", local: mine }] }),
    );
    expect((await m.run("sync")).code).toBe(0);

    const published = m.at(".claude", "skills", "second");
    expect(existsSync(join(published, "SKILL.md"))).toBe(true);
    const saved = `${published}.saved`;
    renameSync(published, saved);
    symlinkSync(join(mine, "skills", "first"), published, linkType);
    expect((await hook(m, "claude-code", PROMPT)).stdout).toBe("");
    unlinkSync(published);
    renameSync(saved, published);
    expect((await hook(m, "claude-code", PROMPT)).stdout).toContain("available now: second");
  });

  it("does not announce discovered skills that sync did not link for Claude Code", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    writeFiles(mine, { "skills/first/SKILL.md": skillMd("first") });
    const manifest = m.manifest({ agents: [], sources: [{ id: "mine", local: mine }] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    expect((await hook(m, "claude-code", SESSION)).code).toBe(0);
    writeFiles(mine, { "skills/second/SKILL.md": skillMd("second") });
    const report = await m.json("sync");
    expect(report.skills.names).toContain("second");
    expect(report.targets).toEqual([]);
    expect(await m.runWith({ input: PROMPT }, "hook", "prompt")).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  it.each(["before", "after"])("recovers a sync interrupted %s linking", async (boundary) => {
    const { m, mine } = await hooked();
    const stateFile = join(m.stateDir, "state.json");
    const state = () => JSON.parse(read(stateFile));
    const installed = m.at(".claude", "skills", "early", "SKILL.md");
    const targetManifest = m.at(".claude", "skills", ".fleetrc-manifest.json");
    const stop = join(m.root, "stop.mjs");
    writeFileSync(
      stop,
      `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (${boundary === "before"} && to === ${JSON.stringify(stateFile)}) {
          const state = JSON.parse(fs.readFileSync(to, "utf8"));
          if (state.skillChanges?.mine?.all) process.exit(86);
        }
        if (${boundary === "after"} && to === ${JSON.stringify(targetManifest)}) process.exit(86);
      };
      syncBuiltinESMExports();
    `,
    );
    writeFiles(mine, { "skills/early/SKILL.md": skillMd("early") });
    const stopped = await m.runWith(
      { env: { NODE_OPTIONS: `${m.env.NODE_OPTIONS} --import=${pathToFileURL(stop).href}` } },
      "sync",
    );
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(86);
    const checkpoint = state().skillChanges.mine.all;
    expect(state().skills.early).toBeUndefined();
    expect(existsSync(installed)).toBe(boundary === "after");

    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    expect((await hook(m, "claude-code", SESSION)).stdout).toBe("");
    expect((await m.run("sync")).code).toBe(0);
    expect(existsSync(installed)).toBe(true);
    expect(state().skills.early.changedAt).toBe(checkpoint);
    const prompt = (await hook(m, "claude-code", PROMPT)).stdout;
    if (boundary === "before") expect(prompt).toContain("available now: early");
    else expect(prompt).toBe("");
    expect((await hook(m, "claude-code", PROMPT)).stdout).toBe("");
  });

  it("gives a session resumed after a week a fresh record on its start", async () => {
    const { m } = await hooked();
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    const file = join(m.stateDir, "sessions", "s1.json");
    mkdirSync(dirname(file), { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    writeFileSync(file, JSON.stringify({ startedAt: old.toISOString(), announced: [] }));
    utimesSync(file, old, old);
    expect((await hook(m, "claude-code", SESSION)).stdout).toBe("");
    const record = JSON.parse(read(file));
    expect(Date.now() - Date.parse(record.startedAt)).toBeLessThan(60_000);
  });

  it("records a session start even when an old sessions.json can't be removed", async () => {
    const { m } = await hooked();
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    // A folder where the old file was: removing it fails.
    mkdirSync(join(m.stateDir, "sessions.json", "x"), { recursive: true });
    expect((await hook(m, "claude-code", SESSION)).stdout).toBe("");
    expect(existsSync(join(m.stateDir, "sessions", "s1.json"))).toBe(true);
  });

  it("keeps the record of each of 12 sessions that start together", async () => {
    const { m } = await hooked();
    writeFileSync(join(m.stateDir, "hook-attempt"), String(Date.now()));
    // What older versions kept all sessions in: left alone by the prompt hook, removed on a start.
    writeFileSync(join(m.stateDir, "sessions.json"), "{");
    const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
    await Promise.all(
      ids.map((id) =>
        hook(m, "claude-code", JSON.stringify({ session_id: id, hook_event_name: "SessionStart" })),
      ),
    );
    const dir = join(m.stateDir, "sessions");
    expect(readdirSync(dir).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
    for (const id of ids)
      expect(JSON.parse(read(join(dir, `${id}.json`)))).toMatchObject({ announced: [] });
    expect(existsSync(join(m.stateDir, "sessions.json"))).toBe(false);
  });

  it("starts the sync even when the session can't be recorded", async () => {
    const { m } = await hooked();
    // A file where the sessions folder goes: the record can't be made.
    writeFileSync(join(m.stateDir, "sessions"), "");
    const run = await hook(m, "claude-code", SESSION);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(started(m)).toHaveLength(1);
  });

  it("hook prompt, the entry older versions documented, names new skills but starts no sync", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const run = await m.runWith({ input: PROMPT }, "hook", "prompt");
    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(started(m)).toEqual([]);
    expect(existsSync(join(m.stateDir, "hook-attempt"))).toBe(false);
  });
});
