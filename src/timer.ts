import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import {
  installOsSchedule,
  osScheduleErrors,
  osScheduleStatus,
  type OsScheduleStatus,
  uninstallOsSchedule,
} from "@vite-hub/schedule/os";
import { parseCronExpression } from "cron-schedule";
import { exec } from "./exec.ts";
import { isRecord, readJsonOrNothing, writeJson } from "./fs.ts";
import { paths, stateDir, tildify, xdgDir } from "./paths.ts";
import { findOnPath, launcherPath, timerEnv } from "./selfinstall.ts";

export const TIMER_NAME = "fleetrc-sync";

export interface TimerSpec {
  name: string;
  cron: string;
  /** An IANA name, or `"local"`: the machine's zone, following its clock changes. */
  timeZone: string;
  /** Absolute node path, then the installed CLI and its arguments. */
  command: [string, ...string[]];
  env: Record<string, string>;
  logDir: string;
}

export interface InstalledTimer {
  platform: string;
  /** Unit files, plist or task wrapper, and the log file. */
  files: string[];
  /** `false` when the same timer was already installed and nothing changed. */
  changed: boolean;
  /** Linux: whether systemd lingering is on, so the timer runs while the user is logged out. */
  linger?: boolean;
}

export type TimerStatus = OsScheduleStatus;

/** The timer that runs `<node> <cli> sync` on the manifest's `timer` schedule. */
export function syncTimerSpec(
  timer: { cron: string; timeZone?: string },
  node: string,
  cli: string,
): TimerSpec {
  return {
    name: TIMER_NAME,
    cron: timer.cron,
    timeZone: timer.timeZone ?? "local",
    command: [node, cli, "sync"],
    // FLEETRC_TIMER puts the time of each run in the log.
    env: { ...timerEnv(findOnPath("git"), node), FLEETRC_TIMER: "1" },
    logDir: paths.logs(),
  };
}

/** Why `cron` is not a five-field cron the OS timers run, or undefined when it is. */
export function cronProblem(cron: string): string | undefined {
  const example = 'such as "*/30 * * * *" (minute, hour, day of month, month, day of week)';
  if (cron.trim() !== cron) return `"${cron}" has spaces around it`;
  if (cron.split(/\s+/).length !== 5) return `"${cron}" must have five fields, ${example}`;
  try {
    parseCronExpression(cron);
  } catch (error) {
    return `"${cron}" is not a valid cron: ${(error as Error).message.replace(/^Failed to parse [^:]*: /, "")}`;
  }
  return undefined;
}

/**
 * IANA names without a "/", which @vite-hub/schedule takes. Intl also takes offsets such as "+01:00"
 * and lowercase names, which it refuses.
 */
const SLASHLESS_ZONES = new Set(
  "CET CST6CDT Cuba EET EST EST5EDT Egypt Eire Factory GB GB-Eire GMT GMT+0 GMT-0 GMT0 Greenwich HST Hongkong Iceland Iran Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT NZ NZ-CHAT Navajo PRC PST8PDT Poland Portugal ROC ROK Singapore Turkey UCT UTC Universal W-SU WET Zulu".split(
    " ",
  ),
);

/**
 * Why `timeZone` is not a zone the timer takes, or undefined when it is: `"local"`, or an IANA name
 * such as "Europe/Madrid" or "UTC" that this Node.js knows.
 */
export function timeZoneProblem(timeZone: string): string | undefined {
  if (timeZone === "local") return undefined;
  let known = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    known = timeZone.includes("/") || SLASHLESS_ZONES.has(timeZone);
  } catch {}
  return known
    ? undefined
    : `"${timeZone}" is not an IANA time zone; use one such as "Europe/Madrid" or "UTC", or "local" for the machine's zone`;
}

const SCHEDULERS: Record<string, string> = {
  linux: "systemd",
  darwin: "launchd",
  win32: "Task Scheduler",
};

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const unxml = (text: string) =>
  text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) =>
    name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : name === "apos" ? "'" : "&",
  );

/**
 * What to tell the user about `resource`, the unit, plist or task that holds the timer's name and
 * that this install did not write. When it is another fleetrc install's (another HOME or
 * XDG_STATE_HOME under the same user), it names that install's state folder and how to remove it.
 */
export function foreignTimer(name: string, resource: string): string {
  const scheduler = SCHEDULERS[process.platform] ?? "the scheduler";
  let text = "";
  try {
    if (isAbsolute(resource)) text = readFileSync(resource, "utf8");
  } catch {}
  // The timer runs <node> <state>/app/cli.mjs sync; systemd doubles "%", a plist escapes XML.
  const plain = unxml(text).replace(/%%/g, "%");
  // An argument in a plist <string> or a quoted ExecStart one may have spaces; a bare one has none.
  const state =
    plain.match(/(?:<string>|")([^<"]+?)[\\/]app[\\/]cli\.mjs(?:<\/string>|")/)?.[1] ??
    plain.match(/([^\s"'<>]+)[\\/]app[\\/]cli\.mjs/)?.[1];
  if (!state)
    return `${scheduler} already has a timer named ${name} that fleetrc did not install: ${tildify(resource)}. Remove it yourself, then run \`fleetrc timer install\` again.`;
  const home =
    plain.match(/<key>HOME<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ??
    plain.match(/^Environment="?HOME=([^"\n]*)"?$/m)?.[1];
  const launcher = join(state, "bin", process.platform === "win32" ? "fleetrc.cmd" : "fleetrc");
  const remove =
    process.platform === "win32"
      ? `run \`${launcher} timer remove\` with the LOCALAPPDATA that install uses`
      : `run \`${home ? `HOME=${shQuote(home)} ` : ""}XDG_STATE_HOME=${shQuote(dirname(state))} ${existsSync(launcher) ? shQuote(launcher) : "npx fleetrc@latest"} timer remove\``;
  return `the ${name} timer belongs to another fleetrc install, whose state folder is ${tildify(state)} (${tildify(resource)}). One user account has one fleetrc timer. To move it to this one, remove it there: ${remove}; then run \`fleetrc timer install\` here again.`;
}

/**
 * The plist launchd loaded the timer from, when it is not this HOME's: macOS keeps one job per label
 * and user, while the plist lives in each HOME. Other systems use one unit or task per user.
 */
export async function foreignTimerResource(name = TIMER_NAME): Promise<string | undefined> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return undefined;
  const own = join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  for (const domain of [`gui/${process.getuid()}`, `user/${process.getuid()}`]) {
    const run = await exec("launchctl", ["print", `${domain}/${name}`], { timeoutMs: 10_000 });
    if (run.code !== 0) continue;
    const path = run.stdout.match(/^\tpath = (.+)$/m)?.[1]?.trim();
    if (!path) return `${domain}/${name}`;
    return real(path) === real(own) ? undefined : path;
  }
  return undefined;
}

/**
 * Whether this Linux machine lacks a systemd user manager: no `systemctl` on PATH, or systemd is
 * not the init system (/run/systemd/system is missing), as in most containers, WSL1 and distributions
 * that boot with OpenRC, runit or s6.
 */
export function systemdMissing(
  path = process.env.PATH ?? "",
  booted = "/run/systemd/system",
): boolean {
  if (process.platform !== "linux") return false;
  const onPath = path
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .some((dir) => {
      try {
        return statSync(join(dir, "systemctl")).isFile();
      } catch {
        return false;
      }
    });
  return !onPath || !existsSync(booted);
}

/** What to say on a Linux machine with no systemd user manager, with a crontab line that does the timer's job. */
export function noSystemdMessage(cron = "*/30 * * * *"): string {
  const logs = join(stateDir(), "logs");
  const log = join(logs, `${TIMER_NAME}.log`);
  // cron's shell opens the log before fleetrc starts, so the line makes its folder first.
  return `this machine has no systemd user manager (a container, WSL1, or a system that boots without systemd), so fleetrc can't install a timer here. Run \`fleetrc sync\` from cron instead (\`crontab -e\`, then a line such as: ${cron} mkdir -p ${shQuote(logs)} && ${shQuote(launcherPath())} sync >> ${shQuote(log)} 2>&1), or let the session hooks start syncs (\`fleetrc hook install\`)`;
}

/** A `systemctl` failure that means systemd itself is missing, not that one call went wrong. */
const meansNoSystemd = (command: string, exitCode: number, output: string) =>
  process.platform === "linux" &&
  /^systemctl\b/.test(command) &&
  (exitCode === 127 ||
    /ENOENT|command not found|not booted with systemd|System has not been booted/i.test(output) ||
    (/connect to bus/i.test(output) && !existsSync("/run/systemd/system")));

interface ScheduleError {
  code: string;
  message: string;
  data?: unknown;
}

/** A scheduler failure, said in fleetrc's terms: the manifest's `timer` fields and its commands. */
function explain(error: ScheduleError): string {
  const scheduler = SCHEDULERS[process.platform] ?? "the scheduler";
  const bug = `fleetrc asked ${scheduler} for a timer it refused, which is a bug in fleetrc; please report it at https://github.com/onmax/fleetrc/issues`;
  if (osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED.is(error)) {
    const { command, exitCode, output } = error.data;
    if (meansNoSystemd(command, exitCode, output)) return noSystemdMessage();
    const why = `\`${command}\` failed with exit code ${exitCode}: ${output || "no output"}`;
    if (process.platform === "linux" && /connect to bus|XDG_RUNTIME_DIR/i.test(output))
      return `${why}\n  fix: this login has no systemd user manager; run \`loginctl enable-linger ${userInfo().username}\`, or run \`fleetrc timer install\` from a login session`;
    if (process.platform === "darwin" && /domain/i.test(output))
      return `${why}\n  fix: over SSH, launchd has no session for you until you log in at the Mac's screen; log in there once, then run \`fleetrc timer install\` again`;
    return why;
  }
  if (osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED.is(error)) {
    const { cron, reason } = error.data;
    return `${scheduler} cannot run timer.cron "${cron}" exactly: ${reason}\n  fix: change timer.cron in the manifest to fewer values, such as one weekday list without a month list, or a step that divides the hour or the day evenly`;
  }
  if (osScheduleErrors.SCHEDULE_OS_TIME_ZONE_UNSUPPORTED.is(error)) {
    const { timeZone, machineTimeZone: zone } = error.data;
    return `${scheduler} runs timers in the machine's time zone, ${zone}, where timer.cron gives other times than in timer.timeZone "${timeZone}"\n  fix: remove timer.timeZone from the manifest to run the cron in the machine's zone, or use a cron that gives the same times in both, such as an hourly one`;
  }
  if (osScheduleErrors.SCHEDULE_OS_NAME_TAKEN.is(error))
    return foreignTimer(error.data.name, error.data.resource);
  if (osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED.is(error))
    return `fleetrc's timer runs on Linux with systemd, macOS and Windows, not on ${error.data.platform}; run \`fleetrc sync\` from cron or another scheduler instead`;
  if (osScheduleErrors.SCHEDULE_OS_INVALID_OPTIONS.is(error))
    return `${bug}: ${error.data.problem}`;
  if (osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED.is(error))
    return `${bug}: ${error.data.reason}`;
  return `${bug}: ${error.code}: ${error.message}`;
}

export class TimerError extends Error {
  /** The machine has no systemd user manager, so it can't have a timer at all. */
  readonly noSystemd: boolean;
  constructor(error: ScheduleError) {
    super(explain(error));
    this.noSystemd =
      osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED.is(error) &&
      meansNoSystemd(error.data.command, error.data.exitCode, error.data.output);
  }
}

/** The machine's time zone now. A timer without `timer.timeZone` runs in it as it changes (`"local"`). */
export const machineTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What each OS installs, for `timer install --dry-run`. */
export const timerKind = (platform: string = process.platform) =>
  platform === "linux"
    ? "a systemd user timer"
    : platform === "darwin"
      ? "a launchd agent"
      : platform === "win32"
        ? "a Task Scheduler task"
        : `nothing: ${platform} has no supported scheduler`;

/**
 * Installs or updates the timer: a systemd user timer, a launchd agent, or a Task Scheduler task.
 * Installing the same spec again changes nothing.
 */
export async function installTimer(spec: TimerSpec): Promise<InstalledTimer> {
  const [error, unit] = await installOsSchedule(
    spec.name,
    { cron: spec.cron, timeZone: spec.timeZone },
    { command: spec.command, scope: "user", catchUp: true, env: spec.env, logDir: spec.logDir },
  );
  if (error) throw new TimerError(error);
  return {
    platform: unit.platform,
    files: unit.files,
    changed: unit.changed,
    ...(unit.linger === undefined ? {} : { linger: unit.linger }),
  };
}

/** The spec fleetrc last installed and the files that hold it, so a dry run can tell when nothing would change. */
interface TimerRecord {
  spec: TimerSpec;
  files: string[];
}

const recordFile = () => join(stateDir(), "timer.json");

export function recordTimer(spec: TimerSpec, files: readonly string[]) {
  writeJson(recordFile(), { spec, files });
}

export function forgetTimer() {
  rmSync(recordFile(), { force: true });
}

/**
 * Whether `spec` is the timer fleetrc installed last, with its files still in place. Undefined
 * when there is no record of an install (an older fleetrc, or none).
 */
export function sameAsInstalled(spec: TimerSpec): boolean | undefined {
  const raw = readJsonOrNothing(recordFile());
  if (!isRecord(raw) || !isRecord(raw.spec) || !Array.isArray(raw.files)) return undefined;
  const record = raw as unknown as TimerRecord;
  // The log appears with the first run; the unit files, plist or task wrapper must still be there.
  const held = record.files.filter((file) => typeof file === "string" && !file.endsWith(".log"));
  if (!held.every((file) => existsSync(file))) return false;
  return JSON.stringify(record.spec) === JSON.stringify(spec);
}

/** The schedule of the timer fleetrc installed last, from its record. */
export function installedSchedule(): { cron: string; timeZone: string } | undefined {
  const raw = readJsonOrNothing(recordFile());
  if (!isRecord(raw) || !isRecord(raw.spec)) return undefined;
  const { cron, timeZone } = raw.spec;
  return typeof cron === "string" && typeof timeZone === "string" ? { cron, timeZone } : undefined;
}

/**
 * What to say when the manifest's `timer` differs from the schedule the installed timer runs on, or
 * undefined when they agree or no timer was installed.
 */
export function scheduleDrift(timer: { cron: string; timeZone?: string }): string | undefined {
  const installed = installedSchedule();
  const want = { cron: timer.cron, timeZone: timer.timeZone ?? "local" };
  if (!installed || (installed.cron === want.cron && installed.timeZone === want.timeZone))
    return undefined;
  const zone = (spec: { timeZone: string }) =>
    spec.timeZone === "local" ? "" : ` (${spec.timeZone})`;
  return `the manifest's timer is now "${want.cron}"${zone(want)}, but the installed timer runs on "${installed.cron}"${zone(installed)}; run \`fleetrc timer install\` to apply it`;
}

/** The files the OS scheduler reads the timer's command from, where fleetrc's timer would be. */
function timerCommandFiles(): string[] {
  const raw = readJsonOrNothing(recordFile());
  const recorded =
    isRecord(raw) && Array.isArray(raw.files)
      ? raw.files.filter((file): file is string => typeof file === "string")
      : [];
  const own =
    process.platform === "darwin"
      ? [join(homedir(), "Library", "LaunchAgents", `${TIMER_NAME}.plist`)]
      : process.platform === "win32"
        ? [
            join(
              process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
              "ViteHub",
              "schedules",
              `${TIMER_NAME}.ps1`,
            ),
          ]
        : [
            ...new Set([
              join(xdgDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "systemd", "user"),
              join(homedir(), ".config", "systemd", "user"),
            ]),
          ].map((dir) => join(dir, `${TIMER_NAME}.service`));
  return [...new Set([...recorded.filter((file) => /\.(service|plist|ps1)$/.test(file)), ...own])];
}

const PS_QUOTE = "'\u2018\u2019\u201A\u201B";
const PS_STRING = new RegExp(`'((?:[^${PS_QUOTE}]|[${PS_QUOTE}]{2})*)'`, "y");

/**
 * The command a systemd unit, launchd plist or Task Scheduler wrapper of @vite-hub/schedule runs,
 * as the arguments it was given: each scheduler's quoting and escaping undone.
 */
export function commandArgs(text: string): string[] | undefined {
  const exec = text.match(/^ExecStart=(.*)$/m)?.[1];
  if (exec !== undefined) {
    // An argument is bare, or in double quotes with backslash escapes; then systemd's own `$$`
    // and `%%` go back to `$` and `%`.
    const args = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(([, quoted, bare]) =>
      (quoted === undefined ? bare! : quoted.replace(/\\(.)/g, "$1")).replace(
        /\$\$|%%/g,
        (pair) => pair[0]!,
      ),
    );
    return args.length > 0 ? args : undefined;
  }
  const plist = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)(?:<\/array>|$)/)?.[1];
  if (plist !== undefined)
    return [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(([, value]) => unxml(value!));
  const line = text.match(/^& (.*)$/m)?.[1];
  if (line === undefined) return undefined;
  const args: string[] = [];
  PS_STRING.lastIndex = 0;
  for (let match; (match = PS_STRING.exec(line));) {
    args.push(match[1]!.replace(new RegExp(`([${PS_QUOTE}])\\1`, "g"), "$1"));
    if (line[PS_STRING.lastIndex] !== " ") break;
    PS_STRING.lastIndex++;
  }
  return args.length > 0 ? args : undefined;
}

/** The program a systemd unit, launchd plist or Task Scheduler wrapper of @vite-hub/schedule runs. */
export const commandNode = (text: string): string | undefined => commandArgs(text)?.[0];

/** The node fleetrc's installed timer runs, and the file that names it. */
export function timerNode(): { file: string; node: string } | undefined {
  const app = join(stateDir(), "app");
  // Windows paths compare without case.
  const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  for (const file of timerCommandFiles()) {
    let args: string[] | undefined;
    try {
      args = commandArgs(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    // Only a timer that runs this state folder's copy is this install's.
    const [node, ...rest] = args ?? [];
    if (node && rest.some((arg) => fold(arg).startsWith(fold(app + sep)))) return { file, node };
  }
  return undefined;
}

export async function timerStatus(name = TIMER_NAME): Promise<TimerStatus> {
  const [error, status] = await osScheduleStatus(name, { scope: "user" });
  if (error) throw new TimerError(error);
  return status;
}

/** Stops and removes the timer and its files. Returns the files it deleted. */
export async function removeTimer(
  name = TIMER_NAME,
): Promise<{ existed: boolean; removed: string[] }> {
  const [error, removal] = await uninstallOsSchedule(name, { scope: "user" });
  if (error) throw new TimerError(error);
  return { existed: removal.existed, removed: removal.removed };
}

/**
 * What to say about a timer this install does not have: another install's timer that holds the
 * name, which runs instead, is named.
 */
export async function missingTimer(status: TimerStatus): Promise<string> {
  const foreign = await foreignTimerResource();
  return foreign ? foreignTimer(TIMER_NAME, foreign) : formatTimerStatus(status);
}

/** One line about the timer for `status` and `timer status`. */
export function formatTimerStatus(status: TimerStatus): string {
  if (!status.installed) return "not installed; run `fleetrc timer install`";
  const parts = [`installed (${timerKind(status.platform)})`];
  if (status.running) parts.push("running now");
  if (status.lastRunAt) parts.push(`last run ${status.lastRunAt.toISOString()}`);
  if (status.lastExitCode !== undefined) parts.push(`last exit code ${status.lastExitCode}`);
  if (status.nextRunAt) parts.push(`next run ${status.nextRunAt.toISOString()}`);
  if (status.linger === false) parts.push("linger off: it stops when you log out");
  if (status.logFile) parts.push(`log ${status.logFile}`);
  return parts.join(", ");
}
