// The move from fleetrc's old name (legacy.ts), done once per machine by the first command of the
// new release that changes things (`init`, `sync`, `update`, `self-install`, a session hook). It
// keeps everything a sync relies on: state.json and the store (the merge bases of vendored skills),
// the links in agents' folders and their records, the session hooks in their slots, and the timer.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { getSupportedAgents } from "skills";
import { codexLegacyDir, sharedSkillsDir } from "./agents.ts";
import { AGENT_NAMES, installedHooks, installHooks } from "./agenthooks.ts";
import { UserError } from "./errors.ts";
import { isRecord, lstat, readJsonOrNothing, writeJson } from "./fs.ts";
import {
  LEGACY_LAUNCHERS,
  LEGACY_NAME,
  LEGACY_RECORD,
  LEGACY_TIMER,
  legacyConfigDir,
  legacyStateDir,
  MIGRATION_MARKER,
} from "./legacy.ts";
import { lockText, readLock, takeLock } from "./lock.ts";
import { linkTarget, makeLink, MANIFEST_FILE, readRecordsFrom, removeLink } from "./linker.ts";
import { updateConfig } from "./manifest.ts";
import { claudeHome, configDir, paths, readPlacesFrom, stateDir, tildify } from "./paths.ts";
import { commandOnPath, selfInstall } from "./selfinstall.ts";
import {
  installedSchedule,
  installTimer,
  recordTimer,
  removeTimer,
  syncTimerSpec,
  TIMER_NAME,
} from "./timer.ts";

export interface Migration {
  /** What was moved, or with `dryRun` what would be: one line each. */
  lines: string[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the folder `from` with `to` in every string of `value` that names it or a path in it. */
function rebase(value: unknown, moves: readonly [string, string][]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [from, to] of moves)
      text = text.replace(
        new RegExp(
          `${escape(from)}(?=$|[\\\\/:;"'\\s])`,
          process.platform === "win32" ? "gi" : "g",
        ),
        () => to,
      );
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => rebase(item, moves));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v, moves)]));
  return value;
}

/** Rewrites a JSON file with `moves` applied; true when it changed. */
function rebaseFile(file: string, moves: readonly [string, string][], dryRun: boolean): boolean {
  const raw = readJsonOrNothing(file);
  if (raw === undefined) return false;
  const moved = rebase(raw, moves);
  if (JSON.stringify(moved) === JSON.stringify(raw)) return false;
  if (!dryRun) writeJson(file, moved);
  return true;
}

/** Whether the files or links `a` and `b` hold the same: the same bytes, or the same target. */
function same(a: string, b: string): boolean {
  const x = lstatSync(a);
  const y = lstatSync(b);
  if (x.isSymbolicLink() || y.isSymbolicLink())
    return x.isSymbolicLink() && y.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  return x.isFile() && y.isFile() && x.size === y.size && readFileSync(a).equals(readFileSync(b));
}

/**
 * Moves the folder `from` to `to`: a rename when `to` is missing, else each entry `to` lacks, into
 * folders both hold. An entry `to` already holds the same goes from `from`; one that differs stays
 * in both, and `from` stays to hold it. Returns those, relative to `from`.
 */
function moveDir(from: string, to: string, skip: readonly string[] = []): string[] {
  if (!existsSync(from)) return [];
  if (!existsSync(to)) {
    mkdirSync(resolve(to, ".."), { recursive: true });
    renameSync(from, to);
    return [];
  }
  const kept: string[] = [];
  const merge = (a: string, b: string) => {
    for (const name of readdirSync(a)) {
      if (skip.includes(name) && a === from) continue;
      const source = join(a, name);
      const target = join(b, name);
      const there = lstat(target);
      if (!there) renameSync(source, target);
      else if (there.isDirectory() && lstatSync(source).isDirectory()) {
        merge(source, target);
        if (readdirSync(source).length === 0) rmdirSync(source);
      } else if (same(source, target)) rmSync(source);
      else kept.push(relative(from, source));
    }
  };
  merge(from, to);
  if (readdirSync(from).length === 0) rmdirSync(from);
  return kept;
}

/** The variables that place agents' folders, less those that place fleetrc's own (paths.ts). */
const AGENT_ENV = __SKILLS_AGENT_ENV__.filter((key) => key !== "APPDATA" && key !== "LOCALAPPDATA");

/**
 * Takes, for the move, the variables that placed the agents' folders when the old install was
 * made, which `hook install` saved in `file`, where this process lacks them: `fleet upgrade` moves
 * a host from a bare ssh shell. Returns the folders they name, and a function that puts the
 * environment back.
 */
function adoptAgentEnv(file: string): { homes: string[]; restore: () => void } {
  const saved = readJsonOrNothing(file);
  const homes: string[] = [];
  const set: string[] = [];
  if (isRecord(saved))
    for (const key of AGENT_ENV) {
      const value = saved[key];
      if (typeof value !== "string" || !value.trim()) continue;
      homes.push(value.trim());
      if (process.env[key] === undefined) {
        process.env[key] = value;
        set.push(key);
      }
    }
  return {
    homes,
    restore: () => {
      for (const key of set) delete process.env[key];
    },
  };
}

/**
 * The agents' skills folders that hold the old record of links (agents.ts names them), and the
 * `skills` folder in each of `homes`, the agents' folders the install saved.
 */
function recordDirs(homes: readonly string[]): string[] {
  const dirs = new Set([
    sharedSkillsDir(),
    resolve(codexLegacyDir()),
    join(claudeHome(), "skills"),
    ...homes.map((home) => resolve(home, "skills")),
  ]);
  for (const agent of getSupportedAgents())
    if (agent.globalSkillsDir) dirs.add(resolve(agent.globalSkillsDir));
  return [...dirs].filter((dir) => existsSync(join(dir, LEGACY_RECORD)));
}

/**
 * Renames an agent folder's record of the links the old release made, its paths into the old state
 * folder moved to the new one, and points each of those links at the new folder.
 */
function moveRecord(dir: string, moves: readonly [string, string][], oldState: string): number {
  const legacy = join(dir, LEGACY_RECORD);
  const raw = rebase(readJsonOrNothing(legacy), moves);
  const current = readJsonOrNothing(join(dir, MANIFEST_FILE));
  const links = {
    ...(isRecord(raw) && isRecord(raw.links) ? raw.links : {}),
    ...(isRecord(current) && isRecord(current.links) ? current.links : {}),
  };
  let relinked = 0;
  for (const [name, record] of Object.entries(links)) {
    if (!isRecord(record) || typeof record.target !== "string" || record.kind === "copy") continue;
    const path = join(dir, name);
    if (!lstat(path)?.isSymbolicLink()) continue;
    let target: string;
    try {
      target = linkTarget(path);
    } catch {
      continue;
    }
    const from = process.platform === "win32" ? target.toLowerCase() : target;
    const old = process.platform === "win32" ? oldState.toLowerCase() : oldState;
    if (from !== old && !from.startsWith(old + sep)) continue;
    removeLink(path);
    makeLink({ target: record.target }, path, false);
    relinked++;
  }
  writeJson(join(dir, MANIFEST_FILE), { version: 1, links });
  rmSync(legacy, { force: true });
  return relinked;
}

/**
 * Moves the old release's install on this machine to fleetrc's names. Under the sync locks of both
 * installs: marks the move as under way, removes the old timer, moves the state and config
 * folders, rewrites the paths into them (in the state and the agents' link records, whose links
 * follow), installs the new launcher in place of the old one, replaces the session hooks where they
 * stand, installs the timer again under its new name, and clears the mark. A move that stops
 * partway leaves the mark, and the next run does the rest. A sync after it finds everything where
 * it left it. With `dryRun` it writes nothing, says what it would do, and has the rest of the run
 * read the old install.
 */
export async function migrate(options: { dryRun?: boolean } = {}): Promise<Migration> {
  const oldState = legacyStateDir();
  const oldConfig = legacyConfigDir();
  const newState = stateDir();
  const newConfig = configDir();
  const moves: [string, string][] = [
    [oldState, newState],
    [oldConfig, newConfig],
  ];
  const marker = join(newState, MIGRATION_MARKER);
  const resumed = readJsonOrNothing(marker);
  const oldConfigRaw = readJsonOrNothing(join(oldConfig, "config.json"));
  const hadState = existsSync(oldState);
  const hadConfig = existsSync(oldConfig);
  const hadTimer =
    (isRecord(resumed) && resumed.timer === true) ||
    existsSync(join(oldState, "timer.json")) ||
    (isRecord(oldConfigRaw) && oldConfigRaw.timer === true);
  const lines = [`${LEGACY_NAME} is now fleetrc; moving this machine's install:`];
  const say = (line: string) => lines.push(`  ${line}`);
  const agentEnv = adoptAgentEnv(join(hadState ? oldState : newState, "hook-env.json"));

  if (options.dryRun) {
    try {
      if (hadTimer) say(`would remove the ${LEGACY_TIMER} timer`);
      if (hadState) say(`would move ${tildify(oldState)} to ${tildify(newState)}`);
      else say("would finish the move an earlier run started");
      if (hadConfig) say(`would move ${tildify(oldConfig)} to ${tildify(newConfig)}`);
      for (const dir of recordDirs(agentEnv.homes))
        say(
          `would rename ${tildify(join(dir, LEGACY_RECORD))} to ${MANIFEST_FILE} and relink its links`,
        );
      say(`would install the fleetrc launcher in place of the ${LEGACY_NAME} one`);
      for (const { agent, file } of installedHooks())
        say(
          `would replace the ${AGENT_NAMES[agent]} session hook in ${tildify(file)} where it stands`,
        );
      if (hadTimer) say(`would install the ${TIMER_NAME} timer`);
    } finally {
      agentEnv.restore();
    }
    if (hadState) {
      // The rest of the dry run reads the old install, as a sync there would.
      readPlacesFrom({ state: oldState, config: oldConfig });
      readRecordsFrom(LEGACY_RECORD);
    }
    return { lines };
  }

  const mine = lockText("migrate");
  const locks: string[] = [];
  const take = (file: string) => {
    takeLock(file, mine);
    locks.push(file);
  };
  try {
    if (hadState) take(join(oldState, "sync.lock"));
    mkdirSync(newState, { recursive: true });
    take(paths.lock());
    // Written first and removed last: until then, `migrationNeeded` sends the next run here.
    writeJson(marker, { timer: hadTimer });

    if (hadTimer) {
      // The old timer's removal deletes the log its unit names; the log stays, under its new name.
      const logs = join(oldState, "logs");
      const log = join(logs, `${LEGACY_TIMER}.log`);
      if (existsSync(log) && !existsSync(join(logs, `${TIMER_NAME}.log`)))
        renameSync(log, join(logs, `${TIMER_NAME}.log`));
      try {
        await removeTimer(LEGACY_TIMER);
        say(`removed the ${LEGACY_TIMER} timer`);
      } catch (error) {
        say(`could not remove the ${LEGACY_TIMER} timer: ${(error as Error).message}`);
      }
    }

    const moved: [string, string, string[]][] = [];
    for (const [from, to, skip] of [
      [oldState, newState, ["sync.lock"]],
      [oldConfig, newConfig, []],
    ] as const) {
      if (!existsSync(from)) continue;
      try {
        moved.push([from, to, moveDir(from, to, skip)]);
      } catch (error) {
        throw new UserError(
          `could not move ${tildify(from)} to ${tildify(to)}: ${(error as Error).message}; move it by hand and run fleetrc again`,
        );
      }
      say(`moved ${tildify(from)} to ${tildify(to)}`);
    }
    for (const [from, to, files] of moved)
      if (files.length > 0)
        say(
          `kept ${tildify(from)}: ${files.length === 1 ? "this file differs" : "these files differ"} from ${tildify(to)}'s, which ${files.length === 1 ? "was" : "were"} kept too: ${files.join(", ")}; compare them, then delete ${tildify(from)}`,
        );
    for (const [dir, names] of [
      [newState, readdirSync(newState)],
      [newConfig, existsSync(newConfig) ? readdirSync(newConfig) : []],
    ] as const)
      for (const name of names)
        if (name.endsWith(".json")) rebaseFile(join(dir, name), moves, false);

    for (const dir of recordDirs(agentEnv.homes)) {
      const relinked = moveRecord(dir, moves, oldState);
      say(
        `renamed ${tildify(join(dir, LEGACY_RECORD))} to ${MANIFEST_FILE}${relinked ? `, ${relinked} link${relinked === 1 ? "" : "s"} moved` : ""}`,
      );
    }

    const installed = selfInstall();
    for (const name of LEGACY_LAUNCHERS) rmSync(join(paths.bin(), name), { force: true });
    const oldLink = join(homedir(), ".local", "bin", LEGACY_NAME);
    try {
      if (lstat(oldLink)?.isSymbolicLink() && readlinkSync(oldLink).startsWith(oldState))
        rmSync(oldLink);
    } catch {}
    say(`installed ${tildify(installed.launcher)}; ${commandOnPath(installed.launcher)}`);

    for (const { agent } of installedHooks()) {
      const [change] = installHooks([agent], { node: installed.node });
      if (change?.error)
        say(`could not replace the ${AGENT_NAMES[agent]} session hook: ${change.error}`);
      else
        say(
          `replaced the ${AGENT_NAMES[agent]} session hook in ${tildify(change!.file)} where it stood${agent === "codex" ? "; approve it once in Codex's /hooks" : ""}`,
        );
    }

    if (hadTimer) {
      const schedule = installedSchedule() ?? { cron: "*/30 * * * *", timeZone: "local" };
      const spec = syncTimerSpec(schedule, installed.node, installed.cli);
      try {
        const timer = await installTimer(spec);
        recordTimer(spec, timer.files);
        updateConfig({ timer: true });
        say(`installed the ${TIMER_NAME} timer`);
      } catch (error) {
        say(
          `could not install the ${TIMER_NAME} timer: ${(error as Error).message}; run \`fleetrc timer install\``,
        );
      }
    }
    rmSync(marker);
    return { lines };
  } finally {
    agentEnv.restore();
    for (const lock of locks) if (readLock(lock)?.text === mine) rmSync(lock, { force: true });
    try {
      // An old folder left empty by a lock that stayed behind.
      rmdirSync(oldState);
    } catch {}
  }
}
