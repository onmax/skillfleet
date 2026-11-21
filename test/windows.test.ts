// Breaks found by attacking fleetrc on Windows (the W-rows of the break plan): HOMEs with cmd and
// PowerShell metacharacters, long paths, 8.3 names, file names Windows refuses, junctions, read-only
// and locked files, CRLF checkouts, and the .cmd launcher run from cmd, PowerShell and Git Bash.
// Each case says what a user should get. They need Windows, so they skip everywhere else.
// The windows-break CI job also runs the ones that change the machine (subst) and the real Task
// Scheduler under a tricky USERPROFILE (.github/scripts/timer-e2e.mjs --home-name).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  cli,
  clone,
  isLink,
  isWindows,
  linkOf,
  machine,
  type Machine,
  names,
  read,
  remote,
  type Report,
  skillMd,
  skills,
  version,
} from "./fixture.ts";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

type SyncReport = Omit<Report, "targets"> & {
  targets: (Report["targets"][number] & { replaced?: string[] })[];
};

const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
const gitBash = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
].find((file) => existsSync(file));
const pwsh = (() => {
  try {
    return execFileSync("where.exe", ["pwsh"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
})();

/** Starts a program; `done` settles when it exits. */
function start(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; verbatim?: boolean } = {},
): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(file, args, {
    env: options.env,
    cwd: options.cwd,
    windowsHide: true,
    windowsVerbatimArguments: options.verbatim,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin!.end();
  const done = new Promise<Run>((resolve) => {
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

/** A command line as cmd.exe runs it, as typed at its prompt. */
const cmdStart = (line: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  start(comspec, ["/d", "/s", "/c", `"${line}"`], { ...options, verbatim: true });
const cmd = (line: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  cmdStart(line, options).done;

/** A PowerShell script, passed encoded so nothing in it is quoted twice. */
const psStart = (
  script: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; exe?: string } = {},
) =>
  start(
    options.exe ?? "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    options,
  );
const ps = (
  script: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; exe?: string } = {},
) => psStart(script, options).done;
const psQuote = (text: string) => `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

const bash = (script: string, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  start(gitBash!, ["-c", script], options).done;
const shQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const posix = (path: string) => path.replace(/\\/g, "/");

const both = (run: Run) => `${run.stdout}${run.stderr}`;

/** `env` with `dir` first on PATH; Windows spells it Path, and the fixture sets both. */
function withPath(env: NodeJS.ProcessEnv, ...dirs: string[]): NodeJS.ProcessEnv {
  const path = [...dirs, env.PATH ?? env.Path ?? ""].join(";");
  return { ...env, PATH: path, ...(env.Path === undefined ? {} : { Path: path }) };
}

/** Every variable that places HOME and the folders under it, at `home`. */
function homeEnv(m: Machine, home: string): NodeJS.ProcessEnv {
  return {
    ...m.env,
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
  };
}

async function json(m: Machine, env: NodeJS.ProcessEnv, ...args: string[]): Promise<SyncReport> {
  const run = await m.runWith({ env }, ...args, "--json");
  try {
    // `init --json` prints its plan and the sync report under `sync`.
    const parsed = JSON.parse(run.stdout) as SyncReport & { sync?: SyncReport };
    return parsed.sync ?? parsed;
  } catch {
    throw new Error(`fleetrc ${args.join(" ")} printed no JSON (exit ${run.code}):\n${both(run)}`);
  }
}

/** One vendored source with the skill `tool`, linked for Claude Code and Codex by `init`. */
async function setUp(m: Machine, env: NodeJS.ProcessEnv = m.env, ...flags: string[]) {
  const vendor = remote(m, "vendor", skills("skills/", "tool"));
  const manifest = m.manifest({
    agents: ["claude-code", "codex"],
    sources: [{ id: "vendor", git: vendor.url }],
  });
  const init = await m.runWith({ env }, "init", manifest, "--no-hooks", ...flags);
  expect(init.code, both(init)).toBe(0);
  return { vendor, manifest };
}

const bin = (m: Machine) => join(m.stateDir, "bin");

/**
 * A bare repository whose one commit holds `files`, written with git's plumbing: no work tree, so
 * it can hold paths that Windows can't create (aux.txt, `foo:bar`, a trailing dot) or that are
 * longer than MAX_PATH, as a repository made on Linux or macOS does.
 */
function plumbedRemote(m: Machine, name: string, files: Record<string, string>): string {
  const url = join(m.root, "remotes", `${name}.git`);
  mkdirSync(url, { recursive: true });
  m.git(url, "init", "--quiet", "--bare");
  const git = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: url, env: m.env, input, encoding: "utf8" }).trim();
  type Tree = Map<string, Tree | string>;
  const root: Tree = new Map();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part) as Tree;
    }
    node.set(parts.at(-1)!, git(["hash-object", "-w", "--stdin"], content));
  }
  const write = (tree: Tree): string =>
    git(
      ["mktree", "-z"],
      [...tree]
        .map(([entry, value]) =>
          typeof value === "string"
            ? `100644 blob ${value}\t${entry}\0`
            : `040000 tree ${write(value)}\t${entry}\0`,
        )
        .join(""),
    );
  const commit = git(["commit-tree", write(root), "-m", "init"], "");
  m.git(url, "update-ref", "refs/heads/main", commit);
  m.git(url, "symbolic-ref", "HEAD", "refs/heads/main");
  return url;
}

/** The 8.3 short form of `path`, as cmd's `%~s` gives it. */
async function shortPath(path: string): Promise<string> {
  return (await cmd(`for %I in ("${path}") do @echo %~sI`)).stdout.trim();
}

async function until(what: string, check: () => boolean, ms = 60_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** A hook that records its pid and then runs for `seconds`, so the sync holds its lock that long. */
function slowHook(m: Machine, log: string, seconds: number): string {
  const script = join(m.root, "slow-hook.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "ran " + process.pid + "\\n");\nsetTimeout(() => {}, ${seconds * 1000});\n`,
  );
  return `"${process.execPath}" "${script}"`;
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } catch {}
}

/** Store folders a sync leaves while it replaces a skill: `.x.<pid>.new`/`.old`, `.stage-<pid>`. */
function leftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (/^\..*\.\d+\.(new|old|tmp)$|^\.stage-\d+$|\.\d+\.(tmp|old)$/.test(entry.name))
        found.push(join(current, entry.name));
      else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 3)
        walk(join(current, entry.name), depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

describe.skipIf(!isWindows)(
  "Windows (win32 only: junctions, cmd.exe, PowerShell, 8.3 names)",
  () => {
    // ---------------------------------------------------------------------------------------------
    // HOME and USERPROFILE with characters cmd, PowerShell and Git Bash give a meaning. A Windows
    // user name can hold all of these but [ ] ; = , + * ? < > " / \ : |.
    describe("a HOME with shell characters", () => {
      const HOMES = [
        "Jo & Ann",
        "caret ^ bang ! (paren)",
        "pct % and %PATH%",
        "O'Brien $(whoami) `tick`",
        "Zoë Ünïcödé",
        "emoji 😀 home",
      ];
      it.each(HOMES)(
        "W-HOME. HOME %j: init links junctions, and the launcher runs from cmd, PowerShell and Git Bash",
        async (home) => {
          // `status` asks Task Scheduler about the timer.
          const m = machine({ home, scheduler: "empty" });
          await setUp(m);
          for (const dir of [".claude/skills/tool", ".agents/skills/tool"]) {
            expect(isLink(m.at(dir)), dir).toBe(true);
            expect(read(m.at(dir, "SKILL.md"))).toBe(skillMd("tool"));
          }
          const env = withPath(m.env, bin(m));
          const failures: string[] = [];
          const check = (how: string, run: Run) => {
            if (run.stdout.trim() !== version)
              failures.push(`${how}: exit ${run.code}\n${both(run)}`);
          };
          check("cmd: fleetrc --version", await cmd("fleetrc --version", { env, cwd: m.root }));
          // PowerShell runs fleetrc.ps1. Through the .cmd, cmd expands a %VAR% in its own path,
          // as it would for any batch file in that folder.
          check(
            "PowerShell: & <launcher> --version",
            await ps(`& ${psQuote(join(bin(m), "fleetrc.ps1"))} --version; exit $LASTEXITCODE`, {
              env,
              cwd: m.root,
            }),
          );
          check(
            "PowerShell: fleetrc --version",
            await ps("fleetrc --version; exit $LASTEXITCODE", { env, cwd: m.root }),
          );
          // Git Bash runs the sh launcher. Its own way of running a .cmd (`cmd /c` without /s)
          // breaks on a path with & ^ ( ) for any batch file, so that is not tried here.
          if (gitBash)
            check(
              "Git Bash: fleetrc --version",
              await bash("fleetrc --version", { env, cwd: m.root }),
            );
          const sync = await cmd("fleetrc sync", { env, cwd: m.root });
          if (sync.code !== 0) failures.push(`cmd: fleetrc sync: exit ${sync.code}\n${both(sync)}`);
          const status = await cmd("fleetrc status", { env, cwd: m.root });
          if (status.code !== 0)
            failures.push(`cmd: fleetrc status: exit ${status.code}\n${both(status)}`);
          expect(failures).toEqual([]);
        },
      );
    });

    // ---------------------------------------------------------------------------------------------
    // The .cmd launcher: `@"<node>" "%~dp0..\app\cli.mjs" %*`.
    describe("the .cmd launcher", () => {
      // cmd.exe has a long-standing bug: a batch file started by a quoted name that it finds on
      // PATH gets the current folder for %~dp0, not its own. Scripts quote command names.
      it('W-LAUNCH-1. `"fleetrc" --version` from another folder runs fleetrc', async () => {
        const m = machine();
        await setUp(m);
        const run = await cmd(`"fleetrc" --version`, {
          env: withPath(m.env, bin(m)),
          cwd: m.root,
        });
        expect(run.stdout.trim(), both(run)).toBe(version);
      });

      // The launcher holds node's path, which a user's scoop, fnm or Volta install keeps under the
      // user's profile (C:\Users\José\scoop\apps\nodejs\current). cmd reads a batch file in the
      // console's OEM code page, not UTF-8.
      it("W-LAUNCH-2. a node.exe under a non-ASCII folder runs from the launcher", async () => {
        const m = machine();
        const nodeDir = join(m.root, "José");
        symlinkSync(dirname(process.execPath), nodeDir, "junction");
        const node = join(nodeDir, "node.exe");
        const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
        // Only this node on PATH, as on a machine where scoop put it there.
        const env: NodeJS.ProcessEnv = { ...m.env, PATH: [nodeDir, system].join(";") };
        delete env.Path;
        const install = await start(node, [cli, "self-install"], { env, cwd: m.home }).done;
        expect(install.code, both(install)).toBe(0);
        // The launchers run that node; the .cmd reaches it through a junction, with an ASCII path.
        expect(read(join(bin(m), "fleetrc"))).toContain("José");
        const run = await cmd("fleetrc --version", {
          env: { ...env, PATH: [bin(m), system].join(";") },
          cwd: m.root,
        });
        expect(run.stdout.trim(), both(run)).toBe(version);
      });

      // An argument must reach fleetrc as the user typed it, in each shell's own quoting.
      const ARGS = ["a&b", "a|b", "a^b", "%PATH%", "a b(c)"];
      const unknown = (arg: string) => `unknown command "${arg}"`;
      const argsCheck = async (
        shell: string,
        runOne: (m: Machine, env: NodeJS.ProcessEnv, arg: string) => Promise<Run>,
        args: string[] = ARGS,
      ) => {
        const m = machine();
        await setUp(m);
        const env = withPath(m.env, bin(m));
        const failures: string[] = [];
        for (const arg of args) {
          const run = await runOne(m, env, arg);
          if (!both(run).includes(unknown(arg)))
            failures.push(
              `${shell} ${JSON.stringify(arg)}: exit ${run.code}: ${both(run).trim().slice(0, 300)}`,
            );
        }
        expect(failures).toEqual([]);
      };

      it("W-LAUNCH-3. cmd: quoted arguments with & | ^ reach fleetrc unchanged", async () => {
        // %PATH% is left out: cmd expands it before any program runs.
        await argsCheck(
          "cmd",
          (m, env, arg) => cmd(`fleetrc "${arg}"`, { env, cwd: m.root }),
          ARGS.filter((arg) => !arg.includes("%")),
        );
      });

      it("W-LAUNCH-4. Windows PowerShell: arguments with & | ^ % reach fleetrc unchanged", async () => {
        await argsCheck("powershell", (m, env, arg) =>
          ps(`fleetrc ${psQuote(arg)}; exit $LASTEXITCODE`, { env, cwd: m.root }),
        );
      });

      it.runIf(pwsh !== undefined)(
        "W-LAUNCH-5. PowerShell 7: arguments with & | ^ % reach fleetrc unchanged",
        async () => {
          await argsCheck("pwsh", (m, env, arg) =>
            ps(`fleetrc ${psQuote(arg)}; exit $LASTEXITCODE`, { env, cwd: m.root, exe: pwsh }),
          );
        },
      );

      it.runIf(gitBash !== undefined)(
        "W-LAUNCH-6. Git Bash: arguments with & | ^ % reach fleetrc unchanged, through the sh launcher",
        async () => {
          await argsCheck("bash fleetrc", (m, env, arg) =>
            bash(`fleetrc ${shQuote(arg)}`, { env, cwd: m.root }),
          );
        },
      );
    });

    // ---------------------------------------------------------------------------------------------
    describe("long paths", () => {
      // Git for Windows checks out no path past MAX_PATH (260) unless core.longpaths is on, and it is
      // off by default. A repository whose paths fit a clone in C:\src fails in fleetrc's cache,
      // which sits ~120 characters deeper.
      it("W-LONG-1. a skill with a file 230 characters deep in its repository is linked whole", async () => {
        const m = machine();
        const deep = `skills/tool/references/${Array(20).fill("abcdefghi").join("/")}/notes.md`;
        expect(deep.length).toBeLessThan(240);
        const url = plumbedRemote(m, "vendor", {
          "skills/tool/SKILL.md": skillMd("tool"),
          "skills/other/SKILL.md": skillMd("other"),
          [deep]: "deep notes\n",
        });
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "vendor", git: url }],
        });
        const report = await json(m, m.env, "init", manifest, "--no-hooks");
        expect(report.errors ?? [], JSON.stringify(report)).toEqual([]);
        expect(names(m.at(".claude/skills")), JSON.stringify(report, null, 2)).toEqual([
          "other",
          "tool",
        ]);
        expect(read(m.at(".claude/skills", deep.slice("skills/".length)))).toBe("deep notes\n");
      });

      it("W-LONG-2. a HOME 175 characters long syncs, and its launcher runs", async () => {
        const base = realpathSync(tmpdir());
        const home = `long-home-${"x".repeat(Math.max(10, 175 - base.length - 33))}`;
        const m = machine({ home });
        expect(m.home.length).toBeGreaterThan(160);
        await setUp(m);
        expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
        const run = await cmd("fleetrc --version", {
          env: withPath(m.env, bin(m)),
          cwd: m.root,
        });
        expect(run.stdout.trim(), both(run)).toBe(version);
      });
    });

    // ---------------------------------------------------------------------------------------------
    // Files Windows refuses to create, inside a skill of a repository made on Linux or macOS. One such
    // file must cost at most its own skill, never the whole source, and say so.
    describe("file names Windows refuses", () => {
      const BAD = ["aux.txt", "con.md", "nul", "notes.", "notes ", "foo:bar"];
      it.each(BAD)(
        "W-NAME. a file named %j in one skill leaves the source's other skills linked",
        async (bad) => {
          const m = machine();
          const url = plumbedRemote(m, "vendor", {
            "skills/good/SKILL.md": skillMd("good"),
            "skills/bad/SKILL.md": skillMd("bad"),
            [`skills/bad/${bad}`]: "data\n",
          });
          const manifest = m.manifest({
            agents: ["claude-code"],
            sources: [{ id: "vendor", git: url }],
          });
          const report = await json(m, m.env, "init", manifest, "--no-hooks");
          const vendor = report.sources?.find((source) => source.id === "vendor");
          expect(vendor?.status, JSON.stringify(report, null, 2)).not.toBe("error");
          expect(names(m.at(".claude/skills")), JSON.stringify(report, null, 2)).toContain("good");
          expect(read(m.at(".claude/skills/good/SKILL.md"))).toBe(skillMd("good"));
          // The user hears which file was left out.
          expect(JSON.stringify(report.warnings)).toContain(bad.trim().replace(/\.$/, ""));
        },
      );

      // NTFS gives `longname-skill` the short name LONGNA~1, so writing `longna~1/SKILL.md` opens
      // that folder: the second skill overwrites the first one's files.
      it("W-NAME-8.3. a folder named like another folder's 8.3 short name does not overwrite it", async ({
        skip,
      }) => {
        const m = machine();
        const probe = join(m.root, "longname-probe");
        mkdirSync(probe);
        if (!existsSync(join(m.root, "LONGNA~1"))) skip("this volume makes no 8.3 names");
        rmSync(probe, { recursive: true });
        const url = plumbedRemote(m, "vendor", {
          "skills/longname-skill/SKILL.md": skillMd("longname-skill", "the real one"),
          "skills/longna~1/SKILL.md": skillMd("longna~1", "HIJACKED"),
        });
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "vendor", git: url }],
        });
        const report = await json(m, m.env, "init", manifest, "--no-hooks");
        const file = m.at(".claude/skills/longname-skill/SKILL.md");
        expect(existsSync(file) ? read(file) : "(missing)", JSON.stringify(report, null, 2)).toBe(
          skillMd("longname-skill", "the real one"),
        );
      });
    });

    // ---------------------------------------------------------------------------------------------
    describe("the same HOME by another path", () => {
      // Windows hands out 8.3 paths (TEMP is C:\Users\RUNNER~1\... on GitHub's runners): the same
      // HOME may reach fleetrc spelled short in one shell and long in another.
      it("W-83. a sync with HOME's 8.3 path after one with its long path changes nothing", async ({
        skip,
      }) => {
        const m = machine();
        const long = realpathSync.native(m.home);
        const short = await shortPath(long);
        if (!short || short.toLowerCase() === long.toLowerCase())
          skip("this volume makes no 8.3 names");
        await setUp(m, homeEnv(m, long));
        for (const [label, home] of [
          ["short", short],
          ["long", long],
        ] as const) {
          const report = await json(m, homeEnv(m, home), "sync");
          const changed = report.targets.map((target) => ({
            dir: target.dir,
            created: target.created,
            replaced: target.replaced ?? [],
            removed: target.removed,
            warnings: target.warnings,
          }));
          expect(
            { label, errors: report.errors, warnings: report.warnings, changed },
            JSON.stringify(report, null, 2),
          ).toEqual({
            label,
            errors: [],
            warnings: [],
            changed: changed.map((target) => ({
              ...target,
              created: [],
              replaced: [],
              removed: [],
              warnings: [],
            })),
          });
          expect(read(join(home, ".claude", "skills", "tool", "SKILL.md"))).toBe(skillMd("tool"));
        }
      });

      const other = process.env.RUNNER_TEMP;
      const drive = (path: string) => path.slice(0, 2).toUpperCase();
      // On GitHub's runners TEMP is on C: and RUNNER_TEMP on D:.
      it.runIf(other !== undefined && drive(other) !== drive(tmpdir()))(
        "W-DRIVE. HOME on another drive than TEMP and the state folder: init, dry run, update and diff work",
        async () => {
          const m = machine({ base: other });
          const state = realpathSync(mkdtempSync(join(tmpdir(), "fleetrc-state-")));
          try {
            const env = { ...m.env, XDG_STATE_HOME: state };
            const { vendor } = await setUp(m, env);
            expect(linkOf(m.at(".claude/skills/tool")).toLowerCase()).toContain(
              state.toLowerCase(),
            );
            vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
            const dry = await json(m, env, "sync", "--dry-run");
            expect(dry.errors, JSON.stringify(dry)).toEqual([]);
            const report = await json(m, env, "sync");
            expect(report.errors, JSON.stringify(report)).toEqual([]);
            expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
            writeFileSync(m.at(".claude/skills/tool/SKILL.md"), skillMd("tool", "mine"));
            const diff = await m.runWith({ env }, "diff", "tool");
            expect(both(diff)).toContain("+mine");
            expect(both(diff)).not.toMatch(/\n\s+at /);
          } finally {
            rmSync(state, { recursive: true, force: true });
          }
        },
      );

      // subst changes the session's drives, so only the windows-break CI job runs this.
      it.runIf(process.env.FLEETRC_BREAK_SUBST === "1")(
        "W-SUBST. a HOME reached through a subst drive, then through its real path, keeps its links",
        async () => {
          const m = machine();
          const letter = ["S:", "T:", "U:", "V:", "W:"].find((d) => !existsSync(`${d}\\`));
          expect(letter).toBeDefined();
          execFileSync("subst", [letter!, m.root]);
          try {
            const substHome = `${letter}\\${"home"}`;
            await setUp(m, homeEnv(m, substHome));
            expect(read(join(substHome, ".claude", "skills", "tool", "SKILL.md"))).toBe(
              skillMd("tool"),
            );
            for (const home of [m.home, substHome]) {
              const report = await json(m, homeEnv(m, home), "sync");
              expect(report.errors, JSON.stringify(report)).toEqual([]);
              for (const target of report.targets) expect(target.removed, target.dir).toEqual([]);
              expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
            }
            const launcher = await cmd("fleetrc --version", {
              env: withPath(
                homeEnv(m, substHome),
                join(substHome, ".local", "state", "fleetrc", "bin"),
              ),
              cwd: m.root,
            });
            expect(launcher.stdout.trim(), both(launcher)).toBe(version);
          } finally {
            execFileSync("subst", [letter!, "/d"]);
          }
        },
      );
    });

    // ---------------------------------------------------------------------------------------------
    describe("junctions and links", () => {
      it("W-LINK-1. an agent folder that is a junction to another agent's folder is left alone and not pruned through", async () => {
        const m = machine();
        mkdirSync(m.at(".agents/skills"), { recursive: true });
        mkdirSync(m.at(".claude"), { recursive: true });
        symlinkSync(m.at(".agents/skills"), m.at(".claude/skills"), "junction");
        const { manifest } = await setUp(m);
        expect(isLink(m.at(".claude/skills"))).toBe(true);
        expect(isLink(m.at(".agents/skills/tool"))).toBe(true);
        expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
        writeFileSync(manifest, JSON.stringify({ agents: ["claude-code", "codex"], sources: [] }));
        const report = await json(m, m.env, "sync");
        expect(report.errors, JSON.stringify(report)).toEqual([]);
        expect(isLink(m.at(".claude/skills"))).toBe(true);
        expect(existsSync(m.at(".agents/skills/tool"))).toBe(false);
      });

      it("W-LINK-2. hand-made junctions and symlinks survive sync and prune; the folders they point to too", async () => {
        const m = machine();
        const mine = join(m.root, "mine");
        mkdirSync(mine);
        writeFileSync(join(mine, "SKILL.md"), skillMd("mine"));
        mkdirSync(m.at(".claude/skills"), { recursive: true });
        symlinkSync(mine, m.at(".claude/skills/mine-j"), "junction");
        symlinkSync(mine, m.at(".claude/skills/mine-s"), "dir");
        const { manifest, vendor } = await setUp(m);
        // A hand-made junction where the next sync would link the new skill `other`.
        vendor.commit({ "skills/other/SKILL.md": skillMd("other") });
        symlinkSync(mine, m.at(".claude/skills/other"), "junction");
        const added = await json(m, m.env, "sync");
        expect(added.errors, JSON.stringify(added)).toEqual([]);
        expect(linkOf(m.at(".claude/skills/other"))).toBe(realpathSync(mine));
        writeFileSync(manifest, JSON.stringify({ agents: ["claude-code", "codex"], sources: [] }));
        const report = await json(m, m.env, "sync");
        expect(report.errors, JSON.stringify(report)).toEqual([]);
        for (const name of ["mine-j", "mine-s", "other"])
          expect(isLink(m.at(".claude/skills", name)), name).toBe(true);
        expect(existsSync(m.at(".claude/skills/tool"))).toBe(false);
        expect(read(join(mine, "SKILL.md"))).toBe(skillMd("mine"));
        expect(existsSync(m.at(".agents/skills/tool"))).toBe(false);
      });

      // Windows copies the read-only attribute with a file, and a read-only file can't be deleted.
      it("W-RO. --copy refreshes and removes copies of a skill that has a read-only file", async () => {
        const m = machine();
        const local = join(m.root, "local");
        mkdirSync(join(local, "tool"), { recursive: true });
        writeFileSync(join(local, "tool", "SKILL.md"), skillMd("tool"));
        writeFileSync(join(local, "tool", "frozen.txt"), "frozen\n");
        chmodSync(join(local, "tool", "frozen.txt"), 0o444);
        const manifest = m.manifest({ agents: ["claude-code"], sources: [{ id: "local", local }] });
        const init = await m.run("init", manifest, "--no-hooks", "--copy");
        expect(init.code, both(init)).toBe(0);
        expect(isLink(m.at(".claude/skills/tool"))).toBe(false);
        expect(read(m.at(".claude/skills/tool/frozen.txt"))).toBe("frozen\n");
        writeFileSync(join(local, "tool", "SKILL.md"), skillMd("tool", "v2"));
        const update = await json(m, m.env, "sync", "--copy");
        expect(update.errors, JSON.stringify(update)).toEqual([]);
        expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
        chmodSync(join(local, "tool", "frozen.txt"), 0o644);
        rmSync(join(local, "tool"), { recursive: true });
        const removal = await json(m, m.env, "sync", "--copy");
        expect(removal.errors, JSON.stringify(removal)).toEqual([]);
        expect(existsSync(m.at(".claude/skills/tool"))).toBe(false);
      });

      // An agent, an editor or an antivirus scanner has SKILL.md open without FILE_SHARE_DELETE.
      it("W-LOCKED. a skill file held open during a sync: the other source updates, and the next sync finishes the job", async () => {
        const m = machine();
        const vendor = remote(m, "vendor", skills("skills/", "tool"));
        const other = remote(m, "other", skills("skills/", "extra"));
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [
            { id: "vendor", git: vendor.url },
            { id: "other", git: other.url },
          ],
        });
        const init = await m.run("init", manifest, "--no-hooks");
        expect(init.code, both(init)).toBe(0);
        vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
        other.commit({ "skills/extra/SKILL.md": skillMd("extra", "v2") });
        const held = m.at(".claude/skills/tool/SKILL.md");
        const holder = psStart(
          `$f = [System.IO.File]::Open(${psQuote(held)}, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 120; $f.Close()`,
        );
        let ready = "";
        holder.child.stdout!.on("data", (chunk: string) => (ready += chunk));
        try {
          await until("the handle", () => ready.includes("ready"), 30_000);
          const locked = await m.run("sync", "--json");
          expect(locked.stderr).not.toMatch(/\n\s+at /);
          expect(read(m.at(".claude/skills/extra/SKILL.md"))).toBe(skillMd("extra", "v2"));
        } finally {
          killTree(holder.child.pid);
          await holder.done;
        }
        const report = await json(m, m.env, "sync");
        expect(report.errors, JSON.stringify(report, null, 2)).toEqual([]);
        expect(report.edited, JSON.stringify(report, null, 2)).toEqual([]);
        expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
        expect(leftovers(m.stateDir)).toEqual([]);
      });
    });

    // ---------------------------------------------------------------------------------------------
    // Git for Windows installs with core.autocrlf=true: files check out with CRLF.
    describe("CRLF", () => {
      it("W-CRLF-1. with core.autocrlf=true, upstream changes apply with no false local edit, linked and copied", async () => {
        for (const copy of [false, true]) {
          const m = machine();
          appendFileSync(join(m.root, "gitconfig"), "[core]\n\tautocrlf = true\n");
          const vendor = remote(m, "vendor", skills("skills/", "tool"));
          const personal = remote(m, "personal", skills("skills/", "mine"));
          const dir = clone(m, personal, "src/personal");
          expect(read(join(dir, "skills", "mine", "SKILL.md"))).toContain("\r\n");
          const manifest = m.manifest({
            agents: ["claude-code"],
            sources: [
              { id: "vendor", git: vendor.url },
              { id: "personal", git: personal.url, path: dir },
            ],
          });
          const flags = copy ? ["--copy"] : [];
          const init = await m.run("init", manifest, "--no-hooks", ...flags);
          expect(init.code, both(init)).toBe(0);
          vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
          personal.commit({ "skills/mine/SKILL.md": skillMd("mine", "v2") });
          const report = await json(m, m.env, "sync", ...flags);
          const label = copy ? "--copy" : "linked";
          expect(
            {
              label,
              errors: report.errors,
              edited: report.edited,
              held: report.held,
              pending: report.pending,
              warnings: report.warnings,
            },
            JSON.stringify(report, null, 2),
          ).toEqual({ label, errors: [], edited: [], held: [], pending: [], warnings: [] });
          const lf = (path: string) => read(path).replace(/\r\n/g, "\n");
          expect(lf(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
          expect(lf(m.at(".claude/skills/mine/SKILL.md"))).toBe(skillMd("mine", "v2"));
        }
      });

      // Windows PowerShell 5.1 (`Out-File -Encoding utf8`, `Set-Content -Encoding UTF8`) and older
      // Notepad write UTF-8 with a byte order mark.
      it("W-CRLF-2. a SKILL.md with a byte order mark and CRLF is linked under its name", async () => {
        const m = machine();
        const local = join(m.root, "local");
        mkdirSync(join(local, "tool"), { recursive: true });
        writeFileSync(
          join(local, "tool", "SKILL.md"),
          "\uFEFF---\r\nname: tool\r\ndescription: The tool skill\r\n---\r\ntool body\r\n",
        );
        const manifest = m.manifest({ agents: ["claude-code"], sources: [{ id: "local", local }] });
        const report = await json(m, m.env, "init", manifest, "--no-hooks");
        expect(report.skills?.names ?? [], JSON.stringify(report, null, 2)).toContain("tool");
        expect(existsSync(m.at(".claude/skills/tool/SKILL.md"))).toBe(true);
      });
    });

    // ---------------------------------------------------------------------------------------------
    // The lock names the holder's pid and script; a second sync asks Windows for the pid's command
    // line and checks that it still runs that script.
    describe("the sync lock", () => {
      async function holdingSync(how: string) {
        const m = machine();
        const vendor = remote(m, "vendor", skills("skills/", "tool"));
        const log = join(m.root, "hook.log");
        const manifest = m.manifest({
          agents: ["claude-code"],
          sources: [{ id: "vendor", git: vendor.url }],
          hooks: [{ name: "slow", run: slowHook(m, log, 25), on: ["vendor:**"] }],
        });
        mkdirSync(m.at(".config/fleetrc"), { recursive: true });
        writeFileSync(m.at(".config/fleetrc/config.json"), JSON.stringify({ manifest }));
        const self = await m.run("self-install");
        expect(self.code, both(self)).toBe(0);
        const env = withPath(m.env, bin(m));
        let started: ReturnType<typeof start>;
        if (how === "cmd") started = cmdStart("fleetrc sync", { env, cwd: m.root });
        else if (how === "PowerShell")
          started = psStart(`& ${psQuote(join(bin(m), "fleetrc.cmd"))} sync`, {
            env,
            cwd: m.root,
          });
        else if (how === "Git Bash")
          started = start(gitBash!, [posix(join(bin(m), "fleetrc")), "sync"], {
            env,
            cwd: m.root,
          });
        else {
          // `npm install -g fleetrc`: npm's cmd-shim runs "%dp0%\node_modules\...", and %dp0%
          // ends with a backslash, so node's command line has `npm\\node_modules`.
          const prefix = join(m.root, "npm");
          cpSync(dirname(cli), join(prefix, "node_modules", "fleetrc", "dist"), {
            recursive: true,
          });
          writeFileSync(
            join(prefix, "fleetrc.cmd"),
            [
              "@ECHO off",
              "GOTO start",
              ":find_dp0",
              "SET dp0=%~dp0",
              "EXIT /b",
              ":start",
              "SETLOCAL",
              "CALL :find_dp0",
              "",
              'IF EXIST "%dp0%\\node.exe" (',
              '  SET "_prog=%dp0%\\node.exe"',
              ") ELSE (",
              '  SET "_prog=node"',
              "  SET PATHEXT=%PATHEXT:;.JS;=;%",
              ")",
              "",
              'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fleetrc\\dist\\cli.mjs" %*',
              "",
            ].join("\r\n"),
          );
          started = cmdStart("fleetrc sync", { env: withPath(m.env, prefix), cwd: m.root });
        }
        await until("the first sync's hook", () => existsSync(log), 90_000);
        return { m, started, log, manifest };
      }

      const WAYS = ["cmd", "PowerShell", "npm's global shim", ...(gitBash ? ["Git Bash"] : [])];
      it.each(WAYS)(
        "W-LOCK-1. a sync started from %s holds the lock against a second sync",
        async (how) => {
          const { m, started } = await holdingSync(how);
          try {
            const second = await m.run("sync");
            expect(second.code, both(second)).not.toBe(0);
            expect(second.stderr).toContain("another fleetrc sync is running");
          } finally {
            killTree(started.child.pid);
            await started.done;
          }
        },
      );

      it("W-LOCK-2. after taskkill /F of a running sync, the next sync runs and leaves nothing behind", async () => {
        const { m, started, manifest } = await holdingSync("cmd");
        killTree(started.child.pid);
        await started.done;
        // The same manifest without the slow hook.
        const { hooks: _hooks, ...rest } = JSON.parse(read(manifest)) as Record<string, unknown>;
        writeFileSync(manifest, JSON.stringify(rest));
        const report = await json(m, m.env, "sync");
        expect(report.errors, JSON.stringify(report)).toEqual([]);
        expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool"));
        expect(leftovers(m.stateDir)).toEqual([]);
        expect(readdirSync(m.stateDir).filter((name) => name.startsWith("sync.lock"))).toEqual([]);
      });
    });

    // ---------------------------------------------------------------------------------------------
    // The session hooks run the .cmd launcher, which starts the sync detached and returns: the
    // sync must outlive the hook, cmd and the parent that ran them.
    describe("the session hook", () => {
      const lastRun = (m: Machine) =>
        JSON.parse(read(join(m.stateDir, "last-run.json"))) as { finishedAt: string; ok: boolean };

      async function synced(m: Machine, before: string) {
        const deadline = Date.now() + 90_000;
        while (lastRun(m).finishedAt <= before) {
          if (Date.now() > deadline) throw new Error("the hook's sync never finished");
          await new Promise((done) => setTimeout(done, 250));
        }
        expect(lastRun(m).ok).toBe(true);
      }

      type Entry = { command: string; args?: string[] };
      const entry = (file: string) =>
        (JSON.parse(read(file)) as { hooks: Record<string, { hooks: Entry[] }[]> }).hooks
          .SessionStart![0]!.hooks[0]!;

      /**
       * Codex's `cmd.exe /C "<command>"` of its entry, then Claude Code's exec form of its own: the
       * node the entry names, with its args and no shell. Each sync must outlive what started it.
       */
      async function bothAgents(m: Machine, vendor: ReturnType<typeof remote>) {
        const codex = entry(m.at(".codex", "hooks.json"));
        expect(codex.args).toBeUndefined();
        expect(codex.command).toMatch(/fleetrc\.cmd" hook run codex$/);
        vendor.commit({ "skills/second/SKILL.md": skillMd("second") });
        let before = lastRun(m).finishedAt;
        const run = await start(comspec, ["/C", `"${codex.command}"`], {
          env: m.env,
          cwd: m.home,
          verbatim: true,
        }).done;
        expect(run.code, both(run)).toBe(0);
        expect(both(run)).toBe("");
        await synced(m, before);
        expect(existsSync(m.at(".claude/skills/second/SKILL.md"))).toBe(true);

        rmSync(join(m.stateDir, "hook-attempt"), { force: true });
        vendor.commit({ "skills/third/SKILL.md": skillMd("third") });
        before = lastRun(m).finishedAt;
        const claude = entry(m.at(".claude", "settings.json"));
        // node.exe through the link in bin/, which self-install points at each new node.
        expect(claude.command).toBe(join(bin(m), "node-dir", "node.exe"));
        expect(claude.args).toEqual([
          join(m.stateDir, "app", "cli.mjs"),
          "hook",
          "run",
          "claude-code",
        ]);
        const exec = await start(claude.command, claude.args!, { env: m.env, cwd: m.home }).done;
        expect(exec.code, both(exec)).toBe(0);
        expect(both(exec)).toBe("");
        await synced(m, before);
        expect(existsSync(m.at(".claude/skills/third/SKILL.md"))).toBe(true);
      }

      it("W-HOOK-1. Codex's `cmd /C` and Claude Code's exec form of the written entries start a sync that outlives them", async () => {
        const m = machine();
        const { vendor, manifest } = await setUp(m);
        expect((await m.run("init", manifest)).code).toBe(0);
        await bothAgents(m, vendor);
        // self-install moves the link, not the entry: install again is unchanged.
        expect((await m.run("self-install")).code).toBe(0);
        expect((await m.run("hook", "install")).stdout).toContain("Claude Code: hook already in");
      });

      it("W-HOOK-2. under a USERPROFILE with spaces, & and %PATH%, both entries still run", async () => {
        const m = machine({ home: "Jo & Ann pct %PATH% x" });
        const { vendor, manifest } = await setUp(m);
        expect((await m.run("init", manifest)).code).toBe(0);
        // cmd would expand %PATH% in the path, even quoted; through %USERPROFILE% it does not.
        expect(entry(m.at(".codex", "hooks.json")).command).toMatch(/^"%USERPROFILE%\\/);
        await bothAgents(m, vendor);
      });
    });
  },
);
