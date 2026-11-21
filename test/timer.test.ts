import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { timeZoneDrift } from "../src/doctor.ts";
import { stableNode } from "../src/selfinstall.ts";
import { commandArgs, commandNode, systemdMissing } from "../src/timer.ts";
import { isWindows, machine, read, remote, skills, systemdShim, version } from "./fixture.ts";

const kind =
  process.platform === "linux"
    ? "a systemd user timer"
    : process.platform === "darwin"
      ? "a launchd agent"
      : "a Task Scheduler task";

// These tests never install a real timer: CI proves that in .github/scripts/timer-e2e.mjs, which
// installs one, waits for the OS to run it, and removes it.
describe("timer", () => {
  it("15. timer install --dry-run prints the command, an absolute node and the installed copy, and installs nothing", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "timed"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
      timer: { cron: "*/15 * * * *", timeZone: "Europe/Madrid" },
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // init installs the copy even without the timer, so `fleetrc` runs from a new shell.
    rmSync(join(m.stateDir, "app"), { recursive: true });
    const dry = await m.run("timer", "install", "--dry-run");
    const app = join(m.stateDir, "app", "cli.mjs");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toBe(
      `timer fleetrc-sync: \`${stableNode({ env: m.env, home: m.home })} ${app} sync\` on "*/15 * * * *" (Europe/Madrid)\n` +
        `would install ${kind}\n`,
    );
    expect(existsSync(app)).toBe(false);
  });

  it("15a. without timer.timeZone the timer runs in the machine's time zone, as launchd and Task Scheduler do", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const dry = await m.run("timer", "install", "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `on "*/30 * * * *" (the machine's time zone, now ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    );
    // "local", not today's zone name, so the timer follows the machine when its zone changes.
    const spec = await m.json<{ timeZone: string }>("timer", "install", "--dry-run");
    expect(spec.timeZone).toBe("local");
  });

  it("15c. init --dry-run neither installs a timer nor copies fleetrc", async () => {
    const m = machine();
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [],
      timer: { cron: "* * * * *" },
    });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(existsSync(join(m.stateDir, "app"))).toBe(false);
    expect(existsSync(join(m.stateDir, "bin"))).toBe(false);
  });

  it("15b. the installed copy runs on its own from the state folder, with an absolute node path", async () => {
    const m = machine({ scheduler: "empty" });
    const install = await m.run("self-install");
    expect(install.code, install.stderr).toBe(0);
    const launcher = join(m.stateDir, "bin", "fleetrc");
    const text = read(launcher);
    expect(text).toBe(
      `#!/bin/sh\nexec "${stableNode({ env: m.env, home: m.home }).replace(/\\/g, "/")}" "${join(m.stateDir, "app", "cli.mjs").replace(/\\/g, "/")}" "$@"\n`,
    );
    if (isWindows)
      expect(read(`${launcher}.cmd`)).toContain(stableNode({ env: m.env, home: m.home }));
    // The copy has no node_modules beside it, so a run proves the bundle is self-contained.
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, [join(m.stateDir, "app", "cli.mjs"), "--version"], {
      env: m.env,
      encoding: "utf8",
    });
    expect(run.stdout.trim()).toBe(version);
    const doctor = await m.run("doctor", "--json");
    const checks = JSON.parse(doctor.stdout) as { name: string; ok: boolean; detail: string }[];
    expect(checks.find((check) => check.name === "node")).toMatchObject({ ok: true });
  });

  it("15d. installing the same build again leaves the copy alone, since the timer may be running it", async () => {
    const m = machine();
    expect((await m.run("self-install")).code).toBe(0);
    const app = join(m.stateDir, "app", "cli.mjs");
    const before = statSync(app).mtimeMs;
    await new Promise((done) => setTimeout(done, 50));
    expect((await m.run("self-install")).code).toBe(0);
    expect(statSync(app).mtimeMs).toBe(before);
  });

  it.skipIf(process.platform !== "linux")(
    "R2-11. on Linux without systemd, init links the skills and says to use cron, and status, doctor and timer say the same",
    async () => {
      const m = machine({ scheduler: "absent" });
      const vendor = remote(m, "vendor", skills("skills/", "tool"));
      const manifest = m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url }],
      });
      const init = await m.run("init", manifest, "--timer");
      const said = init.stdout + init.stderr;
      // Linking worked; a timer is impossible here, which init says, with what to do instead.
      expect(init.code, said).toBe(0);
      expect(said).toContain("this machine has no systemd user manager");
      expect(said).toMatch(
        /crontab -e.*\*\/30 \* \* \* \* mkdir -p '[^']*' && '.*\/bin\/fleetrc' sync >> /,
      );
      expect(said).toContain("fleetrc hook install");
      expect(said).not.toContain("ENOENT");
      // No timer went in, so status and doctor report the hooks, and the timer commands say why.
      const status = await m.run("status");
      expect(status.stdout).toMatch(/^syncs start from: the session hooks of Claude Code/m);
      const doctor = await m.run("doctor");
      expect(doctor.stdout).not.toMatch(/^\w+ +timer:/m);
      expect(doctor.stdout).not.toContain("ENOENT");
      for (const args of [
        ["timer", "status"],
        ["timer", "install"],
      ]) {
        const run = await m.run(...args);
        expect(run.code, args.join(" ")).toBe(1);
        expect(run.stdout + run.stderr).toContain("no systemd user manager");
        expect(run.stdout + run.stderr).not.toContain("ENOENT");
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "R2-11. a dry run tells a machine without systemctl, or not booted with systemd, from one with it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "fleetrc-systemd-"));
      try {
        const bin = join(root, "bin");
        const booted = join(root, "run-systemd-system");
        mkdirSync(bin);
        expect(systemdMissing(bin, booted)).toBe(true);
        writeFileSync(join(bin, "systemctl"), "");
        expect(systemdMissing(bin, booted)).toBe(true);
        mkdirSync(booted);
        expect(systemdMissing(bin, booted)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("R3-7. reads the node each scheduler's file runs", () => {
    expect(commandNode("# x\n[Service]\nExecStart=/opt/node/bin/node /s/app/cli.mjs sync\n")).toBe(
      "/opt/node/bin/node",
    );
    expect(
      commandNode('[Service]\nExecStart="/opt/my node/100%%/$$x/node" "/s/app/cli.mjs" sync\n'),
    ).toBe("/opt/my node/100%/$x/node");
    expect(
      commandNode(
        "<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/Users/a b/.volta/bin/node&amp;</string>\n",
      ),
    ).toBe("/Users/a b/.volta/bin/node&");
    expect(
      commandNode(
        "$log = 'C:\\x.log'\n& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\s\\app\\cli.mjs' 'sync' 2>&1\n",
      ),
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(commandNode("& 'C:\\it''s\\node.exe' 'x'\n")).toBe("C:\\it's\\node.exe");
  });

  it("R5-10. reads every argument of the timer's command, with each scheduler's escapes undone", () => {
    expect(
      commandArgs(
        '[Service]\nExecStart=/opt/node "/h/50%%off/$$HOME/\\"q\\"/app/cli.mjs" sync\nEnvironment="A=b"\n',
      ),
    ).toEqual(["/opt/node", '/h/50%off/$HOME/"q"/app/cli.mjs', "sync"]);
    expect(
      commandArgs(
        "<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/n</string>\n\t\t<string>/Users/O&apos;Brien &amp; co/app/cli.mjs</string>\n\t\t<string>sync</string>\n\t</array>\n",
      ),
    ).toEqual(["/n", "/Users/O'Brien & co/app/cli.mjs", "sync"]);
    expect(
      commandArgs(
        "$log = 'C:\\O''Brien\\x.log'\n& 'C:\\node.exe' 'C:\\Users\\O''Brien\\app\\cli.mjs' 'sync' 2>&1 | ForEach-Object { \"$_\" }\n",
      ),
    ).toEqual(["C:\\node.exe", "C:\\Users\\O'Brien\\app\\cli.mjs", "sync"]);
  });

  it("R3-8. doctor warns when an explicit timer.timeZone is not the machine's, where the scheduler uses the machine's", () => {
    expect(timeZoneDrift("Europe/Madrid", "darwin", "America/New_York")).toMatch(
      /Europe\/Madrid.*America\/New_York.*launchd/,
    );
    expect(timeZoneDrift("Europe/Madrid", "win32", "UTC")).toContain("Task Scheduler");
    expect(timeZoneDrift("Europe/Madrid", "darwin", "Europe/Madrid")).toBeUndefined();
    expect(timeZoneDrift("local", "darwin", "UTC")).toBeUndefined();
    expect(timeZoneDrift(undefined, "darwin", "UTC")).toBeUndefined();
    // systemd takes the zone itself.
    expect(timeZoneDrift("Europe/Madrid", "linux", "UTC")).toBeUndefined();
  });

  it("R3-8. init --dry-run names the launcher, the hooks and, with --timer, the timer it would install", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    const dry = await m.run("init", manifest, "--dry-run");
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/would install .*fleetrc.*, the copy new shells, the hooks/);
    expect(dry.stdout).toContain("Claude Code: would add fleetrc's hook");
    expect(dry.stdout).not.toContain(`would install ${kind}`);
    const timer = await m.run("init", manifest, "--dry-run", "--timer");
    expect(timer.stdout).toContain(`would install ${kind}`);
    const declined = await m.run("init", manifest, "--dry-run", "--no-hooks");
    expect(declined.stdout).toContain("no session hooks (--no-hooks)");
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "R3-7, R3-8. self-install under another node moves the timer to it, doctor finds a timer whose node is gone, and a dry run sees an unchanged timer",
    async () => {
      const m = machine();
      const shim = systemdShim(m);
      // Two Node.js installs, as links to this node, so each can be removed.
      const node = (name: string) => {
        const dir = join(m.root, name, "bin");
        mkdirSync(dir, { recursive: true });
        symlinkSync(realpathSync(process.execPath), join(dir, "node"));
        return { dir, node: join(dir, "node") };
      };
      const a = node("node-a");
      const b = node("node-b");
      const using = (n: { dir: string }) => ({ PATH: [n.dir, shim].join(delimiter) });
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      const service = m.at(".config/systemd/user/fleetrc-sync.service");

      const init = await m.runWith({ env: using(a) }, "init", manifest, "--timer");
      expect(init.code, init.stdout + init.stderr).toBe(0);
      expect(read(service)).toContain(`ExecStart=${a.node} `);
      const same = await m.runWith({ env: using(a) }, "timer", "install", "--dry-run");
      expect(same.stdout).toContain(`${kind}: already installed, unchanged`);
      const other = await m.runWith({ env: using(b) }, "timer", "install", "--dry-run");
      expect(other.stdout).toContain(`would update the installed timer (${kind})`);

      const install = await m.runWith({ env: using(b) }, "self-install");
      expect(install.code, install.stderr).toBe(0);
      expect(install.stdout).toContain(
        `the timer ran ${a.node}; installing it again with ${b.node}`,
      );
      expect(read(service)).toContain(`ExecStart=${b.node} `);
      rmSync(a.dir, { recursive: true });
      const fine = await m.runWith({ env: using(b) }, "doctor");
      expect(fine.stdout).toMatch(/^ok {3}node: /m);
      expect(fine.stdout).toMatch(/^ok {3}timer: installed/m);

      // What an older self-install left: the launcher on node-b, the timer on node-a, now gone.
      const old = read(service);
      writeFileSync(service, old.replace(`ExecStart=${b.node} `, `ExecStart=${a.node} `));
      const split = await m.runWith({ env: using(b) }, "doctor");
      expect(split.stdout).toMatch(
        new RegExp(
          `^FAIL node: the timer \\(.*fleetrc-sync.service\\) runs ${a.node}, which is gone.*npx fleetrc@latest self-install`,
          "m",
        ),
      );
      expect(split.stdout).toMatch(/^FAIL timer: the timer .* which is gone/m);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "R3-8. on a machine with the timer, doctor and status name another HOME's timer that holds the label",
    async () => {
      const m = machine();
      const bin = join(m.root, "own-bin");
      mkdirSync(bin);
      const other = "/Users/someone/Library/LaunchAgents/fleetrc-sync.plist";
      writeFileSync(
        join(bin, "launchctl"),
        `#!/bin/sh\ncase "$1" in\n  print) printf '%s = {\\n\\tpath = ${other}\\n\\tstate = not running\\n}\\n' "$2"; exit 0 ;;\n  getenv) exit 0 ;;\nesac\nexit 1\n`,
      );
      chmodSync(join(bin, "launchctl"), 0o755);
      const env = { PATH: [bin, m.env.PATH].join(delimiter) };
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      expect((await m.runWith({ env }, "init", manifest, "--no-hooks")).code).toBe(0);
      // Without the timer, neither asks launchd.
      expect((await m.runWith({ env }, "doctor")).stdout).not.toMatch(/^\w+ +timer:/m);
      // A machine where `timer install` ran once.
      writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest, timer: true }));
      const doctor = await m.runWith({ env }, "doctor");
      expect(doctor.stdout).toMatch(/^FAIL timer: .*someone/m);
      const status = await m.runWith({ env }, "status");
      expect(status.stdout).toMatch(/^timer: .*someone/m);
    },
  );
});
