// Installs fleetrc from its packed tarball, points it at a local git source with `init`, and
// runs the session hooks init wrote into Claude Code's and Codex's files the way the agents do:
// through a shell, or for Claude Code's exec form on Windows as node and args with no shell, from
// a parent process that exits as soon as the hook does. The sync each hook
// starts must outlive both and link the skill that landed upstream. Then a fresh attempt starts no
// second sync, init wrote no prompt hook, and `hook remove` takes fleetrc's entries out.
//
//   pnpm --filter fleetrc build
//   pnpm pack --out fleetrc.tgz
//   node .github/scripts/hook-e2e.mjs fleetrc.tgz
//
// Everything lives under a throwaway HOME, and nothing touches the OS scheduler, so it runs
// outside CI too.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tarball = process.argv[2] && resolve(process.argv[2]);
assert.ok(tarball && existsSync(tarball), "pass the path of the packed fleetrc tarball");

const SYNC_MS = 120_000;
const root = mkdtempSync(join(tmpdir(), "fleetrc-hook-e2e-"));
const home = join(root, "home");
const prefix = join(root, "prefix");
const bare = join(root, "remotes", "vendor.git");
const work = join(root, "upstream", "vendor");
const manifestFile = join(root, "manifest", ".fleetrc", "manifest.json");
const stateDir = join(home, ".local", "state", "fleetrc");
const claudeSkills = join(home, ".claude", "skills");

const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("GIT_") || key === "CLAUDE_CONFIG_DIR" || key === "CODEX_HOME")
    delete env[key];
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
});

const step = (message) => console.log(`[hook-e2e] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const skillMd = (name) => `---\nname: ${name}\ndescription: The ${name} skill\n---\n${name} body\n`;
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let cli;
function fleetrc(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env,
    cwd: home,
    windowsHide: true,
  });
  step(`fleetrc ${args.join(" ")} -> exit ${result.status}`);
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const lastRun = () => JSON.parse(readFileSync(join(stateDir, "last-run.json"), "utf8"));
const logFile = join(stateDir, "logs", "fleetrc-sync.log");
const startedSyncs = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.endsWith(": starting a sync"))
    : [];

/** The entry fleetrc wrote for `event` into an agent's hooks file. */
function hookEntry(file, event) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const entries = (raw.hooks?.[event] ?? []).flatMap((group) => group.hooks ?? []);
  const line = (entry) => [entry.command, ...(entry.args ?? [])].join(" ");
  const own = entries.filter((entry) => / hook run /.test(line(entry)));
  assert.equal(own.length, 1, `${file} has ${own.length} fleetrc ${event} hooks`);
  return own[0];
}

/**
 * Runs `entry` as an agent runs a hook, with the event on stdin, from a parent process that exits
 * the moment the hook does: shell form through a shell, exec form (Claude Code on Windows) as its
 * command and args with no shell. Resolves when the parent is gone.
 */
async function runAsAgent(entry, event) {
  const how = entry.args
    ? `${JSON.stringify(entry.command)}, ${JSON.stringify(entry.args)}, {`
    : `${JSON.stringify(entry.command)}, { shell: true,`;
  const parent = `const { spawn } = require("node:child_process");
const child = spawn(${how} windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (chunk) => (out += chunk));
child.stderr.on("data", (chunk) => (out += chunk));
child.stdin.end(${JSON.stringify(JSON.stringify({ session_id: "e2e", hook_event_name: event }))});
child.on("exit", (code) => { process.stdout.write(out); process.exit(code ?? 1); });`;
  const started = Date.now();
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, ["-e", parent], { env, cwd: home, windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
  step(`hook (${event}) exited ${result.code} after ${Date.now() - started} ms`);
  assert.equal(result.code, 0, `the hook failed: ${result.out}`);
  return result.out;
}

async function waitFor(what, check) {
  step(`wait up to ${SYNC_MS / 1000} s for ${what}`);
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > SYNC_MS) assert.fail(`no ${what} within ${SYNC_MS / 1000} s`);
    await sleep(500);
  }
  step(`${what}: after ${Date.now() - started} ms`);
}

try {
  step(`platform ${process.platform}, node ${process.version}, root ${root}`);
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), "{}\n");
  const npmCli = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((file) => existsSync(file));
  assert.ok(npmCli, `npm is not next to ${process.execPath}`);
  const npm = spawnSync(
    process.execPath,
    [npmCli, "install", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    { encoding: "utf8", cwd: prefix },
  );
  assert.equal(npm.status, 0, `npm install failed:\n${npm.stdout}\n${npm.stderr}`);
  cli = join(prefix, "node_modules", "fleetrc", "dist", "cli.mjs");

  step("a throwaway HOME with Claude Code and Codex, a local git source and a manifest");
  for (const dir of [".claude", ".codex", ".agents"])
    mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = e2e\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n",
  );
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare");
  mkdirSync(join(work, "skills", "first"), { recursive: true });
  git(work, "init", "--quiet");
  writeFileSync(join(work, "skills", "first", "SKILL.md"), skillMd("first"));
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "--quiet", "-u", "origin", "main");
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(
    manifestFile,
    `${JSON.stringify({ agents: ["claude-code", "codex"], sources: [{ id: "vendor", git: bare }] }, null, 2)}\n`,
  );

  const init = fleetrc("init", manifestFile);
  console.log(init.stdout, init.stderr);
  assert.equal(init.code, 0, "init failed");
  assert.match(init.stdout, /^Claude Code: added fleetrc's hook/m);
  assert.match(init.stdout, /^Codex: added fleetrc's hook/m);
  assert.doesNotMatch(init.stdout, /^installed a /m, "init installed a timer");
  const status = JSON.parse(fleetrc("status", "--json").stdout);
  assert.deepEqual(status.trigger, { hooks: ["claude-code", "codex"], timer: false });

  for (const [agent, file] of [
    ["Claude Code", join(home, ".claude", "settings.json")],
    ["Codex", join(home, ".codex", "hooks.json")],
  ]) {
    const name = `skill-${agent === "Codex" ? "codex" : "claude"}`;
    // Claude Code on Windows gets exec form: node.exe through bin/'s link, and the installed copy.
    if (agent === "Claude Code" && process.platform === "win32") {
      const entry = hookEntry(file, "SessionStart");
      assert.equal(entry.command, join(stateDir, "bin", "node-dir", "node.exe"));
      assert.deepEqual(entry.args, [
        join(stateDir, "app", "cli.mjs"),
        "hook",
        "run",
        "claude-code",
      ]);
    }
    step(`${agent}: commit ${name} upstream, then start a session`);
    mkdirSync(join(work, "skills", name), { recursive: true });
    writeFileSync(join(work, "skills", name, "SKILL.md"), skillMd(name));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", name);
    git(work, "push", "--quiet", "origin", "main");
    // The last attempt is fresh after the first agent's; this one counts as a new one.
    rmSync(join(stateDir, "hook-attempt"), { force: true });
    const before = lastRun().finishedAt;
    const syncs = startedSyncs().length;
    assert.equal(await runAsAgent(hookEntry(file, "SessionStart"), "SessionStart"), "");
    assert.equal(startedSyncs().length, syncs + 1, "the hook started no sync");
    await waitFor(`${agent}'s sync`, () => lastRun().finishedAt > before);
    assert.equal(lastRun().ok, true, JSON.stringify(lastRun(), null, 2));
    assert.ok(existsSync(join(claudeSkills, name, "SKILL.md")), `${name} is not linked`);

    step(`${agent}: a second session right after starts no second sync`);
    assert.equal(await runAsAgent(hookEntry(file, "SessionStart"), "SessionStart"), "");
    assert.equal(startedSyncs().length, syncs + 1, "a fresh attempt started another sync");
    // Syncs start only with a session: nothing runs on each prompt.
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.hooks.UserPromptSubmit, undefined, `${file} has a prompt hook`);
  }

  const removal = fleetrc("hook", "remove");
  assert.equal(removal.code, 0, removal.stderr);
  for (const file of [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")])
    assert.doesNotMatch(readFileSync(file, "utf8"), / hook run /, `${file} still runs the hook`);
  step("passed");
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  if (existsSync(logFile)) console.log(`[hook-e2e] ${logFile}:\n${readFileSync(logFile, "utf8")}`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
