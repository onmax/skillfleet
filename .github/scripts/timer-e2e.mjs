// Installs fleetrc from its packed tarball, points it at a local git source with `init --timer`, and
// waits for the real OS scheduler (systemd, launchd or Task Scheduler) to run the sync twice: once
// on its own, and again after a new skill lands upstream. Then it checks `status`, installs again
// to prove that changes nothing, removes the timer, and checks the OS has nothing left.
//
//   pnpm --filter fleetrc build
//   pnpm pack --out fleetrc.tgz
//   node .github/scripts/timer-e2e.mjs fleetrc.tgz
//   node .github/scripts/timer-e2e.mjs fleetrc.tgz --home-name "O'Brien & Zoë"
//
// --home-name names the throwaway HOME folder, so the timer's files, its command line and its
// environment carry that name (the windows-break job passes cmd and PowerShell metacharacters).
//
// Everything fleetrc writes lives under a throwaway HOME, but the timer itself goes into the
// OS scheduler of the user that runs this. It always removes it again, and it refuses to run
// outside CI unless you pass --yes. On Linux it needs a systemd user manager: run it in a login
// session, or with linger on and XDG_RUNTIME_DIR set, as CI does.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { yes: { type: "boolean" }, "home-name": { type: "string", default: "home" } },
});
const tarball = positionals[0] && resolve(positionals[0]);
assert.ok(tarball && existsSync(tarball), "pass the path of the packed fleetrc tarball");
if (process.env.CI !== "true" && !values.yes) {
  console.error(
    "timer-e2e installs a real timer in your OS scheduler (and removes it). Pass --yes to run it outside CI.",
  );
  process.exit(2);
}

const NAME = "fleetrc-sync";
const FIRST_RUN_MS = 180_000;
const SECOND_RUN_MS = 240_000;
const POLL_MS = 5_000;
const platform = process.platform;
const realHome = homedir();

const root = mkdtempSync(join(tmpdir(), "fleetrc-timer-e2e-"));
const home = join(root, values["home-name"]);
const prefix = join(root, "prefix");
const bare = join(root, "remotes", "vendor.git");
const work = join(root, "upstream", "vendor");
const manifestFile = join(root, "manifest", ".fleetrc", "manifest.json");
const stateDir = join(home, ".local", "state", "fleetrc");
const claudeSkills = join(home, ".claude", "skills");

/** The environment of every fleetrc and git run: a throwaway HOME and the folders under it. */
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

const step = (message) => console.log(`[timer-e2e] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    env: options.env ?? env,
    cwd: options.cwd ?? home,
    windowsHide: true,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let cli;
function fleetrc(...args) {
  const result = run(process.execPath, [cli, ...args]);
  step(`fleetrc ${args.join(" ")} -> exit ${result.code}`);
  return result;
}

function fleetrcJson(...args) {
  const result = fleetrc(...args, "--json");
  try {
    return { ...result, json: JSON.parse(result.stdout) };
  } catch {
    assert.fail(
      `fleetrc ${args.join(" ")} --json printed no JSON (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

const skillMd = (name) => `---\nname: ${name}\ndescription: The ${name} skill\n---\n${name} body\n`;

/** The OS's own answer to "is there a timer called fleetrc-sync?", without fleetrc. */
function osKnows() {
  if (platform === "linux") {
    const timer = run("systemctl", ["--user", "cat", `${NAME}.timer`]);
    const service = run("systemctl", ["--user", "cat", `${NAME}.service`]);
    return {
      known: timer.code === 0 || service.code === 0,
      output: `${timer.stdout}${timer.stderr}\n${service.stdout}${service.stderr}`,
    };
  }
  if (platform === "darwin") {
    const uid = process.getuid();
    const results = [`gui/${uid}`, `user/${uid}`].map((domain) =>
      run("launchctl", ["print", `${domain}/${NAME}`]),
    );
    return {
      known: results.some((result) => result.code === 0),
      output: results.map((result) => `${result.stdout}${result.stderr}`).join("\n"),
    };
  }
  const result = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-ScheduledTask -TaskName '${NAME}' -TaskPath '\\' -ErrorAction Stop | Format-List TaskName,State,Description`,
  ]);
  return { known: result.code === 0, output: `${result.stdout}${result.stderr}` };
}

/** Files a timer of this name would leave in the real home, outside the throwaway one. */
function leftoversInRealHome() {
  const candidates =
    platform === "linux"
      ? [".config/systemd/user/fleetrc-sync.service", ".config/systemd/user/fleetrc-sync.timer"]
      : platform === "darwin"
        ? ["Library/LaunchAgents/fleetrc-sync.plist"]
        : ["AppData/Local/ViteHub/schedules/fleetrc-sync.ps1"];
  return candidates.map((file) => join(realHome, file)).filter((file) => existsSync(file));
}

const hashFile = (file) =>
  existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";

function lastRun() {
  const file = join(stateDir, "last-run.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

async function waitFor(what, timeoutMs, check) {
  step(`wait up to ${timeoutMs / 1000} s for ${what}`);
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      assert.fail(`the OS scheduler did not ${what} within ${timeoutMs / 1000} s`);
    await sleep(POLL_MS);
  }
  step(`${what}: after ${Math.round((Date.now() - started) / 1000)} s`);
}

function diagnose() {
  console.log("[timer-e2e] --- diagnostics ---");
  for (const args of [["timer", "status", "--json"], ["status"]]) {
    const result = run(process.execPath, [cli, ...args]);
    console.log(`$ fleetrc ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  }
  console.log("[timer-e2e] OS view:", osKnows().output);
  if (platform === "linux") {
    console.log(
      run("systemctl", ["--user", "status", "--no-pager", `${NAME}.timer`, `${NAME}.service`])
        .stdout,
    );
    console.log(
      run("journalctl", ["--user", "-u", `${NAME}.service`, "--no-pager", "-n", "50"]).stdout,
    );
  }
  const log = join(stateDir, "logs", `${NAME}.log`);
  console.log(`[timer-e2e] ${log}:\n${existsSync(log) ? readFileSync(log, "utf8") : "(missing)"}`);
  console.log("[timer-e2e] last run:", JSON.stringify(lastRun(), null, 2));
}

let installed = false;
try {
  step(`platform ${platform}, node ${process.version}, root ${root}`);
  assert.ok(!osKnows().known, `a ${NAME} timer exists before the test; remove it first`);

  step("install the tarball into a temporary prefix, offline: the package has no dependencies");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), "{}\n");
  const npmCli = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((file) => existsSync(file));
  assert.ok(npmCli, `npm is not next to ${process.execPath}`);
  const npm = run(
    process.execPath,
    [npmCli, "install", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    { env: process.env, cwd: prefix },
  );
  assert.equal(npm.code, 0, `npm install failed:\n${npm.stdout}\n${npm.stderr}`);
  cli = join(prefix, "node_modules", "fleetrc", "dist", "cli.mjs");
  assert.ok(existsSync(cli), `${cli} is missing after npm install`);

  step("make a throwaway HOME, a local git source with one skill, and a manifest");
  for (const dir of [".claude", ".agents"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(
    join(home, ".gitconfig"),
    [
      "[user]\n\tname = fleetrc e2e\n\temail = e2e@example.com",
      "[init]\n\tdefaultBranch = main",
      "[commit]\n\tgpgsign = false",
      "[core]\n\tautocrlf = false",
      '[protocol "file"]\n\tallow = always',
    ].join("\n") + "\n",
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
  // A timer that fires every minute. timer.cron is the documented manifest field.
  writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: bare }],
        timer: { cron: "* * * * *" },
      },
      null,
      2,
    )}\n`,
  );

  step("fleetrc init --timer: sync once and install the timer");
  const init = fleetrc("init", manifestFile, "--timer");
  installed = true;
  console.log(init.stdout, init.stderr);
  assert.equal(init.code, 0, "init failed");
  assert.match(init.stdout, /^installed a /m, "init did not install the timer");
  assert.ok(
    existsSync(join(claudeSkills, "first", "SKILL.md")),
    "init did not link the first skill",
  );
  const initRun = lastRun();
  assert.ok(initRun, "init wrote no last-run.json");

  const listed = osKnows();
  assert.ok(listed.known, `the OS does not list ${NAME} after init:\n${listed.output}`);

  step("install again: an identical install changes nothing");
  const before = fleetrcJson("timer", "status").json;
  assert.equal(before.installed, true, "timer status says the timer is not installed");
  const again = fleetrcJson("timer", "install");
  assert.equal(again.code, 0, `the second install failed:\n${again.stdout}\n${again.stderr}`);
  assert.equal(again.json.changed, false, "a second identical install must report changed: false");
  const owned = again.json.files.filter((file) => !file.endsWith(".log"));
  assert.ok(owned.length > 0, "the install reports no files");
  const hashes = owned.map(hashFile);
  const third = fleetrcJson("timer", "install");
  assert.equal(third.json.changed, false, "a third identical install must report changed: false");
  assert.deepEqual(owned.map(hashFile), hashes, "an identical install rewrote the timer's files");
  const text = fleetrc("timer", "install");
  assert.match(text.stdout, /already installed, unchanged/);

  step("a dry run and doctor see the timer as installed, running the launcher's node");
  const dry = fleetrc("timer", "install", "--dry-run");
  assert.match(dry.stdout, /already installed, unchanged/, dry.stdout);
  const doctor = fleetrc("doctor");
  console.log(doctor.stdout);
  assert.match(doctor.stdout, /^ok {3}node: /m, "doctor does not find the node the timer runs");
  assert.doesNotMatch(doctor.stdout, /^FAIL (node|timer):/m);

  await waitFor("run the sync on its own", FIRST_RUN_MS, () => {
    const report = lastRun();
    return report && report.finishedAt > initRun.finishedAt;
  });
  const firstScheduled = lastRun();
  assert.equal(
    firstScheduled.ok,
    true,
    `the scheduled sync failed: ${JSON.stringify(firstScheduled)}`,
  );

  step("commit a second skill upstream");
  mkdirSync(join(work, "skills", "second"), { recursive: true });
  writeFileSync(join(work, "skills", "second", "SKILL.md"), skillMd("second"));
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "second");
  git(work, "push", "--quiet", "origin", "main");

  await waitFor("link the second skill", SECOND_RUN_MS, () =>
    existsSync(join(claudeSkills, "second", "SKILL.md")),
  );

  step("status reports the timer and its last run");
  const status = fleetrcJson("status");
  assert.equal(status.code, 0);
  assert.equal(status.json.timer.installed, true, "status says the timer is not installed");
  assert.equal(status.json.timer.platform, platform);
  assert.ok(status.json.lastRun, "status has no last run");
  assert.ok(
    status.json.lastRun.skills.names.includes("second"),
    "the last run did not link second",
  );
  // launchd does not expose the start of the last run; systemd and Task Scheduler do.
  if (platform !== "darwin") assert.ok(status.json.timer.lastRunAt, "status has no lastRunAt");
  if (status.json.timer.lastExitCode !== undefined)
    assert.equal(status.json.timer.lastExitCode, 0, "the last scheduled run did not exit 0");
  const statusText = fleetrc("status");
  console.log(statusText.stdout);
  assert.match(statusText.stdout, /^last run: /m);
  assert.match(statusText.stdout, /^timer: installed/m);
  if (platform !== "darwin") assert.match(statusText.stdout, /^timer: installed.*last run /m);

  step("timer remove");
  const removal = fleetrcJson("timer", "remove");
  assert.equal(removal.code, 0, removal.stderr);
  assert.equal(removal.json.existed, true);
  installed = false;
  for (const file of again.json.files) assert.ok(!existsSync(file), `timer remove left ${file}`);
  const gone = osKnows();
  assert.ok(!gone.known, `the OS still lists ${NAME} after timer remove:\n${gone.output}`);
  assert.deepEqual(leftoversInRealHome(), [], "timer files are left in the real home");
  const after = fleetrc("timer", "status");
  assert.equal(after.code, 1, "timer status exits 1 once the timer is gone");
  assert.match(after.stdout, /not installed/);
  const removeAgain = fleetrc("timer", "remove");
  assert.equal(removeAgain.code, 0);
  assert.match(removeAgain.stdout, /no timer installed/);

  step("passed");
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  if (cli) diagnose();
} finally {
  if (installed && cli) {
    step("clean up: remove the timer");
    const cleanup = run(process.execPath, [cli, "timer", "remove"]);
    const left = osKnows();
    if (cleanup.code !== 0 || left.known) {
      process.exitCode = 1;
      console.error(
        `[timer-e2e] cleanup failed (exit ${cleanup.code}):\n${cleanup.stdout}\n${cleanup.stderr}\nOS view:\n${left.output}`,
      );
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
