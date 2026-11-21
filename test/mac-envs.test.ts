// Breaks found by running fleetrc on a real Mac under a throwaway HOME, and by a docs audit of
// the timer (MAC- and D-rows of the break plan). Most of them hit any OS; each case says what a user
// should get.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { remoteScript } from "../src/fleet.ts";
import { parseManifest } from "../src/manifest.ts";
import { launchers, pathAdvice, stableNode } from "../src/selfinstall.ts";
import { foreignTimer } from "../src/timer.ts";
import { cli, isWindows, machine, pathWith, version } from "./fixture.ts";

const executable = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
};

/** A Node.js "install" at `dir`/bin/node: a script that runs this node, so it can be deleted. */
const fakeNode = (dir: string) => {
  const node = join(dir, "bin", "node");
  executable(node, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  return node;
};

/** PATH for a run; Windows spells it Path, and the fixture sets both. */
const pathEnv = (path: string) => (isWindows ? { PATH: path, Path: path } : { PATH: path });

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "fleetrc-mac-")));

type Check = { name: string; ok: boolean; detail: string };

describe("mac environments", () => {
  // MAC1: the launcher and the timer stored process.execPath, the versioned binary a Node.js
  // upgrade deletes (a Homebrew Cellar folder, a node-v24.x tarball): every timer run then fails.
  it.skipIf(isWindows)(
    "MAC1. the launcher runs a node link that survives an upgrade that deletes the old version",
    () => {
      const root = scratch();
      try {
        const v1 = join(root, "opt", "node-v24.1.0");
        const execPath = fakeNode(v1);
        const link = join(root, "bin", "node");
        mkdirSync(join(root, "bin"));
        symlinkSync(execPath, link);
        const home = join(root, "home");
        // The versioned folder first on PATH, as a tarball install puts it: the link still wins.
        const env = { PATH: [join(v1, "bin"), join(root, "bin"), "/usr/bin", "/bin"].join(":") };
        expect(stableNode({ execPath, env, home })).toBe(link);
        // Without a link anywhere, the only choice is the versioned path.
        expect(stableNode({ execPath, env: { PATH: join(v1, "bin") }, home })).toBe(execPath);

        const launcher = join(root, "fleetrc");
        executable(launcher, launchers(link, cli).sh);
        // The upgrade: a new version, the link moved to it, the old folder deleted.
        const v2 = fakeNode(join(root, "opt", "node-v24.2.0"));
        rmSync(link);
        symlinkSync(v2, link);
        rmSync(v1, { recursive: true });
        const run = spawnSync(launcher, ["--version"], { encoding: "utf8" });
        expect(run.stdout.trim(), run.stderr).toBe(version);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isWindows)(
    "MAC1. self-install writes the node link on PATH, and doctor gives the repair line once it is gone",
    async () => {
      const m = machine({ scheduler: "empty" });
      const bin = join(m.root, "nodebin");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const env = { PATH: pathWith(bin, m.env) };
      const install = await m.runWith({ env }, "self-install");
      expect(install.code, install.stderr).toBe(0);
      const launcher = join(m.stateDir, "bin", "fleetrc");
      expect(readFileSync(launcher, "utf8")).toContain(`exec "${join(bin, "node")}" `);
      const healthy = JSON.parse((await m.runWith({ env }, "doctor", "--json")).stdout) as Check[];
      expect(healthy.find((check) => check.name === "node")).toMatchObject({ ok: true });

      rmSync(join(bin, "node"));
      const doctor = await m.runWith({ env }, "doctor", "--json");
      const node = (JSON.parse(doctor.stdout) as Check[]).find((check) => check.name === "node");
      expect(node?.ok).toBe(false);
      expect(node?.detail).toContain("npx fleetrc@latest self-install");
      expect(node?.detail).not.toContain("run `fleetrc timer install`");
    },
  );

  // MAC4: the PATH advice named ~/.profile, which zsh (the macOS default) never reads.
  it("MAC4. the PATH advice names the file the user's shell reads", () => {
    const bin = "/h/.local/state/fleetrc/bin";
    expect(pathAdvice(bin, "/bin/zsh", "darwin")).toContain(
      `in ~/.zprofile: export PATH='${bin}':"$PATH"`,
    );
    expect(pathAdvice(bin, "/usr/bin/zsh", "linux")).toContain("in ~/.zshrc:");
    expect(pathAdvice(bin, "/bin/bash", "darwin")).toContain("in ~/.bash_profile:");
    expect(pathAdvice(bin, "/bin/bash", "linux")).toContain("in ~/.bashrc:");
    expect(pathAdvice(bin, "/opt/homebrew/bin/fish", "darwin")).toMatch(
      /: fish_add_path '\/h\/.local\/state\/fleetrc\/bin'$/,
    );
    expect(pathAdvice(bin, "", "linux")).toContain("in ~/.profile:");
    // R2-17: csh, tcsh and nushell neither read ~/.profile nor take `export`.
    expect(pathAdvice(bin, "/bin/tcsh", "linux")).toMatch(
      /in ~\/\.tcshrc: set path = \( '\/h\/.local\/state\/fleetrc\/bin' \$path \)$/,
    );
    expect(pathAdvice(bin, "/bin/csh", "darwin")).toContain("in ~/.cshrc: set path = (");
    expect(pathAdvice(bin, "/usr/bin/nu", "linux")).toContain(
      `config.nu (\`$nu.config-path\`): $env.PATH = ($env.PATH | split row (char esep) | prepend '${bin}')`,
    );
  });

  it.skipIf(isWindows)(
    "MAC4. init with zsh and no ~/.local/bin on PATH says ~/.zshrc or ~/.zprofile",
    async () => {
      const m = machine();
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      const init = await m.runWith({ env: { SHELL: "/bin/zsh" } }, "init", manifest, "--no-hooks");
      expect(init.code, init.stderr).toBe(0);
      expect(init.stdout).toContain(
        process.platform === "darwin" ? "in ~/.zprofile:" : "in ~/.zshrc:",
      );
      expect(init.stdout).not.toContain("~/.profile");
    },
  );

  // MAC5: `fleet upgrade` looked for npx on the PATH ssh gives (/usr/bin:/bin:/usr/sbin:/sbin on
  // macOS), so a Mac with Node.js set up in ~/.zprofile was "no node".
  it.skipIf(isWindows)(
    "MAC5. fleet upgrade runs the npx next to the node the host's launcher records",
    () => {
      const root = scratch();
      try {
        const state = join(root, "state");
        const nodeBin = join(root, "node dir", "bin");
        const log = join(root, "npx.log");
        // npx is `#!/usr/bin/env node`: it needs its node first on PATH.
        executable(
          join(nodeBin, "npx"),
          `#!/bin/sh\ncommand -v node > "${log}"\necho "$@" >> "${log}"\n`,
        );
        executable(join(nodeBin, "node"), `#!/bin/sh\necho '{"finishedAt":"x","ok":true}'\n`);
        executable(
          join(state, "fleetrc", "bin", "fleetrc"),
          launchers(join(nodeBin, "node"), join(state, "fleetrc", "app", "cli.mjs")).sh,
        );
        const run = spawnSync("/bin/sh", ["-c", remoteScript("upgrade", "1.2.3")], {
          env: { HOME: root, XDG_STATE_HOME: state, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          encoding: "utf8",
        });
        expect(run.stdout, run.stderr).toContain('"finishedAt"');
        expect(readFileSync(log, "utf8")).toBe(
          `${join(nodeBin, "node")}\n-y --package fleetrc@1.2.3 -- fleetrc self-install\n`,
        );

        // The launcher's node is gone: fleet sync says so instead of "exec: not found".
        rmSync(join(nodeBin, "node"));
        const sync = spawnSync("/bin/sh", ["-c", remoteScript("sync", "1.2.3")], {
          env: { HOME: root, XDG_STATE_HOME: state, PATH: "/usr/bin:/bin" },
          encoding: "utf8",
        });
        expect(sync.stdout.trim()).toBe("fleetrc-fleet: node-gone");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // MAC6: the timer's PATH copied the installing shell's, so from npx it had npx's cache, npm's
  // node-gyp-bin and a node_modules/.bin per parent folder (from /tmp, a world-writable one) ahead
  // of /bin; and npx and the launcher wrote different timers.
  it("MAC6. the timer's PATH drops npx's folders and world-writable ones, the same from npx as from a shell", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const userPath = m.env.PATH!;
    const npxDirs = [
      join(m.root, ".npm", "_npx", "0123abcd", "node_modules", ".bin"),
      join(m.root, "project", "node_modules", ".bin"),
      join(m.root, "npm", "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin"),
      join(m.root, "pnpm", "dlx", "abc", "node_modules", ".bin"),
      "relative/bin",
    ];
    const open = join(m.root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const bad = isWindows ? npxDirs : [...npxDirs, open];
    type Spec = { env: { PATH: string } };
    const plain = await m.json<Spec>("timer", "install", "--dry-run");
    const fromNpx = JSON.parse(
      (
        await m.runWith(
          { env: pathEnv([...bad, userPath].join(delimiter)) },
          "timer",
          "install",
          "--dry-run",
          "--json",
        )
      ).stdout,
    ) as Spec;
    expect(fromNpx.env.PATH).toBe(plain.env.PATH);
    const dirs = fromNpx.env.PATH.split(delimiter);
    for (const dir of bad) expect(dirs).not.toContain(dir);
  });

  // MAC9: a second HOME under the same macOS user got SCHEDULE_OS_NAME_TAKEN and the library's
  // "fix: Pick another name", which a fleetrc user cannot do.
  it("MAC9. a timer another fleetrc install owns names that install and how to remove it", () => {
    const root = scratch();
    try {
      const other = join(root, "other home");
      const state = join(other, ".local", "state", "fleetrc");
      const plist = join(other, "Library", "LaunchAgents", "fleetrc-sync.plist");
      mkdirSync(join(plist, ".."), { recursive: true });
      writeFileSync(
        plist,
        [
          "<plist><dict>",
          "\t<key>ProgramArguments</key>",
          "\t<array>",
          "\t\t<string>/opt/homebrew/bin/node</string>",
          `\t\t<string>${state}/app/cli.mjs</string>`,
          "\t\t<string>sync</string>",
          "\t</array>",
          "\t<key>EnvironmentVariables</key>",
          `\t<dict>\n\t\t<key>HOME</key>\n\t\t<string>${other}</string>\n\t</dict>`,
          "</dict></plist>",
        ].join("\n"),
      );
      const text = foreignTimer("fleetrc-sync", plist);
      expect(text).toContain(`another fleetrc install, whose state folder is ${state}`);
      if (!isWindows)
        expect(text).toContain(
          `HOME='${other}' XDG_STATE_HOME='${join(other, ".local", "state")}' npx fleetrc@latest timer remove`,
        );
      expect(text).not.toMatch(/Pick another name|error\.data|ViteHub/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "MAC9. timer install over another install's unit says whose it is, not the library's fix",
    async () => {
      const m = machine({ scheduler: "empty" });
      const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
      expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
      const other = join(m.root, "other", ".local", "state", "fleetrc");
      const unit = m.at(".config", "systemd", "user", "fleetrc-sync.service");
      mkdirSync(join(unit, ".."), { recursive: true });
      writeFileSync(
        unit,
        `[Service]\nExecStart="/usr/bin/node" "${other}/app/cli.mjs" "sync"\nEnvironment="HOME=${join(m.root, "other")}"\n`,
      );
      const install = await m.run("timer", "install");
      expect(install.code).toBe(1);
      expect(install.stdout).toContain(`whose state folder is ${other}`);
      expect(install.stdout).toContain("timer remove");
      expect(install.stdout).not.toMatch(/Pick another name|error\.data/);
    },
  );

  // D9: a bad timer.cron or timer.timeZone passed validation and --dry-run; the real install failed
  // with library text about `scope: "system"` and `{ command }`.
  it("D9. the manifest refuses a cron the timer cannot run and an unknown time zone", async () => {
    expect(() => parseManifest("m.json", { timer: { cron: "99 * * * *" } })).toThrow(
      /timer\.cron "99 \* \* \* \*" is not a valid cron: 99 is outside of constraint range of 0 - 59/,
    );
    expect(() => parseManifest("m.json", { timer: { cron: "* * * *" } })).toThrow(
      /timer\.cron .* must have five fields/,
    );
    expect(() =>
      parseManifest("m.json", { timer: { cron: "0 * * * *", timeZone: "Mars/Base" } }),
    ).toThrow(/timer\.timeZone "Mars\/Base" is not an IANA time zone/);
    // Intl takes these; the scheduler does not.
    for (const timeZone of ["+01:00", "utc"])
      expect(() => parseManifest("m.json", { timer: { timeZone } }), timeZone).toThrow();
    for (const timeZone of [
      "local",
      "UTC",
      "GMT",
      "Europe/Madrid",
      "America/Argentina/Buenos_Aires",
    ])
      expect(() => parseManifest("m.json", { timer: { timeZone } }), timeZone).not.toThrow();

    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    m.manifest({ agents: ["claude-code"], sources: [], timer: { cron: "99 * * * *" } });
    const dry = await m.run("timer", "install", "--dry-run");
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("timer.cron");
  });

  it("D9. a scheduler failure reads in fleetrc's terms, without the library's options", async () => {
    const m = machine({ scheduler: "refuse" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const install = await m.run("timer", "install");
    expect(install.code).toBe(1);
    expect(install.stdout).toContain("the timer was not installed");
    expect(install.stdout).not.toMatch(/scope: "|\{ command \}|error\.data|SCHEDULE_OS_/);
  });

  // D10: `fleet add` with no host suggested tailnet names with spaces, which it then refused.
  it.skipIf(isWindows)("D10. fleet add suggests MagicDNS short names it accepts", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [], fleet: ["slimbook"] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const bin = join(m.root, "tsbin");
    const status = {
      Peer: {
        a: {
          HostName: "Maxi's MacBook Pro",
          DNSName: "maxis-macbook-pro.tail1234.ts.net.",
          Online: true,
        },
        b: { HostName: "slimbook", DNSName: "slimbook.tail1234.ts.net.", Online: true },
        c: { HostName: "Living Room TV", DNSName: "", Online: false },
      },
    };
    executable(join(bin, "tailscale"), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`);
    const env = { PATH: pathWith(bin, m.env) };
    const suggest = await m.runWith({ env }, "fleet", "add");
    expect(suggest.code, suggest.stderr).toBe(0);
    const hosts = suggest.stdout
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(/\s+/)[0]!);
    expect(hosts).toEqual(["maxis-macbook-pro"]);
    const add = await m.runWith({ env }, "fleet", "add", ...hosts);
    expect(add.code, add.stderr).toBe(0);
  });
});
