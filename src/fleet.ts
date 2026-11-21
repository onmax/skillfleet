import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { exec } from "./exec.ts";
import { dict, isRecord, readJsonOrNothing, writeJson } from "./fs.ts";
import { paths } from "./paths.ts";
import { notInstalled, program } from "./program.ts";
import { tailscaleStatus } from "./tailscale.ts";
import type { Report } from "./report.ts";
import { LEGACY_FLEET, reportVersion } from "./legacy.ts";

export type FleetAction = "status" | "sync" | "upgrade" | "init";

type FleetInvocation = {
  action: FleetAction;
  version: string;
  dryRun?: boolean;
  setup?: InitSetup;
};

export interface HostResult {
  host: string;
  /** The Tailscale tag the host came from, for a host a `tag:` entry expanded to. */
  via?: string;
  /** The host answered over ssh. */
  reachable: boolean;
  /** False when fleetrc could not try the host: ssh is not installed, or the name is not one ssh takes. */
  checked: boolean;
  /** The host's last run, fresh or from the local cache when unreachable. */
  lastRun?: Pick<Report, "finishedAt" | "ok" | "fleetrc" | "host"> & {
    skills: number;
    held: string[];
    errors: string[];
    sources: Record<string, string | undefined>;
    sourceStatuses?: Record<string, string | undefined>;
  };
  /** `fleet upgrade`: the version the host ran before, when known, and the one it runs now. */
  upgrade?: { from?: string; to: string };
  /** `fleet init`: the host was set up now, or already had this manifest and only synced. */
  setup?: "set up" | "already set up";
  error?: string;
  behind: string[];
}

const STATE = '"${XDG_STATE_HOME:-$HOME/.local/state}/fleetrc"';
/** The state folder of fleetrc's old name, on a host not yet moved (migrate.ts). */
const OLD_STATE = LEGACY_FLEET.state;

/** What a host prints, instead of a report, when it cannot give one. */
const NOTE = "fleetrc-fleet:";
const HOST_NOTES = {
  "never-synced": undefined,
  "not-installed": "fleetrc is not installed there; run `npx fleetrc init <manifest>` on it",
  "node-gone":
    "fleetrc is installed there, but the node its launcher and timer run is gone, as after a Node.js upgrade; run `npx fleetrc@latest self-install` on it",
  "no-node":
    "fleetrc is not installed there, and node is not on the PATH ssh commands get; install Node.js 22.12 or newer, then run `npx fleetrc init <manifest>` on it",
  "no-npx":
    "node is there, but npx is not on the PATH ssh commands get; install Node.js 22.12 or newer with npm, then run `fleetrc fleet init` again",
  "init-no-node":
    "node is not on the PATH ssh commands get; install Node.js 22.12 or newer, then run `fleetrc fleet init` again",
  /** `fleet init` says which manifest, from the host's `has` line. */
  "other-manifest": "it has another manifest; pass --force to set it up with this one",
  "unreadable-config": "could not read the host's fleetrc config; check config.json there",
  "local-manifest": "the requested manifest resolves to a local path on the host",
} as const;

/**
 * Told to stderr first, so a timeout can tell a host that answered and was slow from one that never
 * answered.
 */
const ANSWERED = `echo "${NOTE} answered" >&2`;
/** The version the installed launcher runs, told to stderr before `fleet upgrade` replaces it. */
const WAS = `if [ -x "$l" ]; then echo "${NOTE} was $("$l" --version </dev/null 2>/dev/null)" >&2; fi`;
/** The version the launcher runs once `fleet upgrade` installed it, told before the sync that follows, which may fail. */
const NOW = `echo "${NOTE} now $("$l" --version </dev/null 2>/dev/null)" >&2`;

/**
 * Runs `command`, a simple command, so that it stops when the connection drops. Without a tty sshd
 * sends no SIGHUP, and a sync prints nothing until it ends, so it would run on, holding the sync
 * lock, after fleet's timeout killed ssh. fleet writes a line to stdin and holds it open; sshd closes
 * it when the connection goes, and the watcher then kills the command. A stdin that ends before any
 * line, as with `ssh -n`, leaves the command alone. A background list reads /dev/null unless told
 * otherwise, hence fd 3.
 */
const watched = (command: string) =>
  `{ exec 3<&0; ${command} </dev/null 3<&- & p=$!; { read -r _ && { while read -r _; do :; done; kill $p; }; } <&3 >/dev/null 2>&1 & w=$!; exec 3<&-; wait $p; s=$?; kill $w 2>/dev/null; exit $s; }`;

/** Finds fleetrc on the host: the installed launcher, else a `fleetrc` on PATH. */
const FIND = `f=${STATE}/bin/fleetrc; [ -x "$f" ] || f=${OLD_STATE}/${LEGACY_FLEET.launcher}; [ -x "$f" ] || f=$(command -v fleetrc) || f=`;
/**
 * The node the installed launcher runs, in `n` when it is still there. ssh runs commands in a
 * non-interactive shell, without what ~/.zprofile or ~/.bashrc add to PATH (on macOS PATH is
 * /usr/bin:/bin:/usr/sbin:/sbin), so the launcher's node is the one to trust. The launcher's line is
 * `exec "<node>" "<cli>" "$@"`, with `\`, `"`, `$` and a backtick escaped by a backslash. A node
 * the launcher names that is gone, as after a Node.js upgrade, is in `g`.
 */
const LAUNCHER_NODE = `l=${STATE}/bin/fleetrc; [ -f "$l" ] || [ ! -f ${OLD_STATE}/${LEGACY_FLEET.launcher} ] || l=${OLD_STATE}/${LEGACY_FLEET.launcher}; n=; g=; if [ -f "$l" ]; then n=$(sed -n 's/^exec "\\([^"]*\\)" .*/\\1/p' "$l" | sed 's/\\\\\\(.\\)/\\1/g'); if [ -n "$n" ] && [ ! -x "$n" ]; then g=$n; n=; fi; fi`;
/**
 * npx in `x`: the one next to the launcher's node, with that node first on PATH for npx's own
 * `#!/usr/bin/env node`, else the one on PATH.
 */
const NPX = `x=; if [ -n "$n" ] && [ -x "\${n%/*}/npx" ]; then x="\${n%/*}/npx"; PATH="\${n%/*}:$PATH"; export PATH; elif command -v npx >/dev/null 2>&1; then x=npx; fi`;
/**
 * Read the host's config into `m` with the launcher's Node or the one on PATH. Only a missing
 * config or one without a manifest is treated as unconfigured.
 */
const CONFIGURED = `case "\${XDG_CONFIG_HOME:-}" in /*) c="$XDG_CONFIG_HOME";; *) c="$HOME/.config";; esac; cf="$c/fleetrc/config.json"; [ -f "$cf" ] || [ ! -f "$c/${LEGACY_FLEET.config}" ] || cf="$c/${LEGACY_FLEET.config}"; k=\${n:-node}; m=$("$k" -e '
  let text;
  try { text = require("node:fs").readFileSync(process.argv[1], "utf8"); }
  catch (error) { if (error.code === "ENOENT") process.exit(0); throw error; }
  const config = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(1);
  const spec = config.manifest;
  if (spec !== undefined) {
    if (typeof spec !== "string" || !spec || /[\\r\\n\\0]/.test(spec)) process.exit(1);
    process.stdout.write(spec);
  }
' "$cf" </dev/null 2>/dev/null)`;

const NOT_SHADOWED = `const {statSync}=require("node:fs");
const {join,resolve}=require("node:path");
const {homedir}=require("node:os");
const spec=process.argv[1];
const local=(value)=>value==="~"?homedir():/^~[/\\\\]/.test(value)?join(homedir(),value.slice(2)):resolve(value);
const stat=(path)=>{try{return statSync(path)}catch(error){if(!["ENOENT","ENOTDIR"].includes(error.code))throw error}};
if(stat(local(spec)))process.exit(1);
const scheme=spec.indexOf("://");
const separator=spec.indexOf("//",scheme<0?0:scheme+3);
if(separator>=0){const repo=local(spec.slice(0,separator));if(stat(repo)?.isDirectory() && stat(join(repo,"HEAD"))?.isFile() && stat(join(repo,"objects")) && stat(join(repo,"refs")))process.exit(1)}`;
/** Prints why there is no fleetrc to run. */
const MISSING = `if command -v node >/dev/null 2>&1; then echo "${NOTE} not-installed"; else echo "${NOTE} no-node"; fi`;

/** What `fleet init` sets a host up with. */
export interface InitSetup {
  /** The manifest spec, as this machine's config.json keeps it. */
  spec: string;
  /** Options for the host's `init`: --copy, --no-copy, --timer, --no-hooks, --force. */
  flags: readonly string[];
  /** Set the host up even when its config.json names another manifest. */
  force: boolean;
  /** Whether a manifest spec a host's config.json names is `spec` in another spelling. */
  same: (configured: string) => boolean;
  /** An equivalent spelling already read from the host; it must still match on retry. */
  expectedConfig?: string;
}

/**
 * The npx arguments that run `fleetrc init` on a host: this version from npm, or the package
 * FLEETRC_PACKAGE names (a tarball, a URL or a pkg.pr.new preview).
 */
export function initArgs(version: string, { spec, flags }: InitSetup): string[] {
  const pkg = process.env.FLEETRC_PACKAGE || `fleetrc@${version}`;
  return ["-y", "--package", pkg, "--", "fleetrc", "init", spec, ...flags];
}

/** The npx arguments that run `fleetrc self-install` on a host, from the package `initArgs` names. */
export function upgradeArgs(version: string): string[] {
  const pkg = process.env.FLEETRC_PACKAGE || `fleetrc@${version}`;
  return ["-y", "--package", pkg, "--", "fleetrc", "self-install"];
}

/** `npx <args>` as a person would type it, quoting only the words a shell would split. */
export const commandLine = (args: readonly string[]) =>
  ["npx", ...args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : quote(arg)))].join(" ");

/**
 * The POSIX sh script each action runs on a host. A dry run asks the host's sync for one too.
 * `init` needs `setup`.
 */
export function remoteScript(
  action: FleetAction,
  version: string,
  { dryRun = false, setup }: { dryRun?: boolean; setup?: InitSetup } = {},
): string {
  switch (action) {
    case "status":
      return `${ANSWERED}; r=${STATE}/last-run.json; [ -f "$r" ] || [ ! -f ${OLD_STATE}/last-run.json ] || r=${OLD_STATE}/last-run.json; if [ -f "$r" ]; then cat "$r"; else ${FIND}; if [ -n "$f" ]; then echo "${NOTE} never-synced"; else ${MISSING}; fi; fi`;
    case "sync":
      return `${ANSWERED}; ${LAUNCHER_NODE}; ${FIND}; if [ -n "$g" ] && [ "$f" = "$l" ]; then echo "${NOTE} node-gone"; elif [ -n "$f" ]; then ${watched(`"$f" sync --json${dryRun ? " --dry-run" : ""}`)}; else ${MISSING}; fi`;
    case "upgrade":
      // self-install moves a host with the old name's install first, launcher included.
      return `${ANSWERED}; ${LAUNCHER_NODE}; ${WAS}; ${NPX}; if [ -n "$x" ]; then "$x" ${upgradeArgs(version).map(quote).join(" ")} </dev/null && l=${STATE}/bin/fleetrc && ${NOW} && ${watched('"$l" sync --json')}; elif [ -n "$g" ]; then echo "${NOTE} node-gone"; else echo "${NOTE} no-node"; fi`;
    case "init": {
      if (!setup) throw new Error("remoteScript: init needs a setup");
      // A relative FLEETRC_PACKAGE is a path from the login folder, which `cd /` leaves.
      const word = (arg: string, i: number) =>
        i === 2 && (/^\.\.?\//.test(arg) || /^[^/:@]*\.(?:tgz|tar\.gz|tar)$/i.test(arg))
          ? `"$o"/${quote(arg)}`
          : quote(arg);
      const init = ['"$x"', ...initArgs(version, setup).map(word), "--json"].join(" ");
      const expected = quote(setup.expectedConfig ?? setup.spec);
      const unshadowed = (spec: string) =>
        `"$k" -e ${quote(NOT_SHADOWED)} -- ${spec} </dev/null 2>/dev/null`;
      const already =
        setup.flags.length === 0
          ? `if [ "$m" = ${expected} ] && [ -n "$f" ] && [ -z "$g" ] && [ ! -e ${STATE}/init-pending ]; then echo "${NOTE} already" >&2; ${watched('"$f" sync --json')}; fi;`
          : "";
      const mismatch = `${setup.expectedConfig === undefined ? '[ -n "$m" ] && ' : ""}{ [ "$m" != ${expected} ] || ! ${unshadowed('"$m"')}; }`;
      const other = setup.force
        ? ""
        : `if ${mismatch}; then printf '%s has %s\\n' "${NOTE}" "$m" >&2; echo "${NOTE} other-manifest"; exit; fi;`;
      return `${ANSWERED}; case "\${XDG_STATE_HOME:-}" in /*) ;; *) unset XDG_STATE_HOME;; esac; ${LAUNCHER_NODE}; ${FIND}; ${NPX}; if [ -z "$n" ] && ! command -v node >/dev/null 2>&1; then echo "${NOTE} init-no-node"; exit; fi; if ! { ${CONFIGURED}; }; then echo "${NOTE} unreadable-config"; exit; fi; ${other} ${already} if [ -n "$x" ]; then o=$(pwd) && cd / || exit 1; if ! ${unshadowed(quote(setup.spec))}; then echo "${NOTE} local-manifest"; exit; fi; ${watched(init)}; else echo "${NOTE} no-npx"; fi`;
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const USER = "[A-Za-z0-9._-]+";
/** A hostname, an ssh_config alias, an IPv4 address, or an IPv6 address with an optional zone. */
const NAME = "(?:[A-Za-z0-9_][A-Za-z0-9._-]*|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9._-]+)?)";
const BRACKETED = "\\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._-]+)?\\]";
const PLAIN_HOST = new RegExp(`^(?:${USER}@)?${NAME}$`);
const SSH_URL = new RegExp(
  `^ssh://(?:${USER}@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]*|${BRACKETED})(?::[0-9]{1,5})?$`,
);

/**
 * Why `host` cannot be handed to ssh, or undefined when it can: `host`, `user@host`, an IP address,
 * an ssh_config alias, or `ssh://user@host:port`. Nothing that ssh would read as an option or a
 * shell would split.
 */
export function hostProblem(host: string): string | undefined {
  const invalid = `"${host}" is not a host name, user@host, an IP address or ssh://user@host:port`;
  if (host.startsWith("ssh://")) return SSH_URL.test(host) ? undefined : invalid;
  if (host.startsWith("-")) return `"${host}" starts with "-", so ssh would read it as an option`;
  if (/^(?:[^@]+@)?[A-Za-z0-9_][A-Za-z0-9._-]*:[0-9]+$/.test(host))
    return `"${host}" has a port; write it as ssh://${host}`;
  return PLAIN_HOST.test(host) ? undefined : invalid;
}

/**
 * Why hosts cannot install this version with npx, or undefined when they can or the registry
 * cannot be asked. 0.0.0 is the version in the repository, which development and preview builds
 * carry; any other version is looked up on the registry npm uses.
 */
export async function unpublished(
  version: string,
  command: "upgrade" | "init" = "upgrade",
): Promise<string | undefined> {
  const fix =
    command === "upgrade"
      ? "run the upgrade from a release, such as `npx fleetrc@latest fleet upgrade`"
      : "run it from a release, such as `npx fleetrc@latest fleet init`, or name a package hosts can install in FLEETRC_PACKAGE";
  if (version === "0.0.0")
    return `this fleetrc is a development or preview build (0.0.0), which hosts cannot install from npm; ${fix}`;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(
    /\/+$/,
    "",
  );
  try {
    const response = await fetch(`${registry}/fleetrc/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return `fleetrc ${version} is not on ${registry}; ${fix}`;
  } catch {}
  return undefined;
}

const quote = (script: string) => `'${script.replace(/'/g, `'\\''`)}'`;

function summarize(raw: unknown): HostResult["lastRun"] {
  if (!isRecord(raw) || typeof raw.finishedAt !== "string") return undefined;
  // A report has skills.total; the cached summary has the number itself.
  const skills =
    typeof raw.skills === "number"
      ? raw.skills
      : isRecord(raw.skills) && typeof raw.skills.total === "number"
        ? raw.skills.total
        : 0;
  const held = Array.isArray(raw.held)
    ? raw.held.flatMap((entry: unknown) =>
        typeof entry === "string"
          ? [entry]
          : isRecord(entry) && typeof entry.source === "string"
            ? [entry.source]
            : [],
      )
    : [];
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((error): error is string => typeof error === "string")
    : [];
  const sources = dict<string | undefined>();
  const sourceStatuses = dict<string>();
  if (Array.isArray(raw.sources)) {
    for (const source of raw.sources) {
      if (!isRecord(source) || typeof source.id !== "string") continue;
      sources[source.id] = typeof source.to === "string" ? source.to : undefined;
      if (typeof source.status === "string") sourceStatuses[source.id] = source.status;
    }
  } else if (isRecord(raw.sources)) {
    for (const [id, commit] of Object.entries(raw.sources))
      sources[id] = typeof commit === "string" ? commit : undefined;
    if (isRecord(raw.sourceStatuses))
      for (const [id, status] of Object.entries(raw.sourceStatuses))
        if (typeof status === "string") sourceStatuses[id] = status;
  }
  return {
    host: typeof raw.host === "string" ? raw.host : "",
    finishedAt: raw.finishedAt,
    ok: raw.ok === true,
    fleetrc: reportVersion(raw, "fleetrc"),
    skills,
    held,
    errors,
    sources,
    ...(Object.keys(sourceStatuses).length ? { sourceStatuses } : {}),
  };
}

type CachedRun = {
  run: NonNullable<HostResult["lastRun"]>;
  destinations?: string[];
  endpoint?: string;
};

function readCache(): Record<string, CachedRun> {
  const raw = readJsonOrNothing(paths.fleet());
  const cache = dict<CachedRun>();
  if (isRecord(raw))
    for (const [host, entry] of Object.entries(raw)) {
      const run = summarize(entry);
      if (run && isRecord(entry)) {
        const destinations = Array.isArray(entry.destinations)
          ? entry.destinations.filter((value) => typeof value === "string")
          : typeof entry.destination === "string"
            ? [entry.destination]
            : undefined;
        cache[host] = {
          run,
          destinations,
          endpoint: typeof entry.endpoint === "string" ? entry.endpoint : undefined,
        };
      }
    }
  return cache;
}

const sshOptions = (timeoutMs: number) => [
  "-o",
  "BatchMode=yes",
  "-o",
  `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
];

function sshDestination(entry: string): string[] {
  if (!entry.startsWith("ssh://") || !entry.includes("[")) return ["--", entry];
  const { machine, user, port } = sshTarget(entry);
  return [...(user ? ["-l", user] : []), ...(port ? ["-p", port] : []), "--", machine];
}

const sshRemoteCommand = (
  action: FleetAction,
  version: string,
  dryRun: boolean,
  setup?: InitSetup,
) => `sh -c ${quote(remoteScript(action, version, { dryRun, setup }))}`;

async function runOnHost(
  host: string,
  action: FleetAction,
  remoteCommand: string,
  timeoutMs: number,
  requireTimer = false,
) {
  const problem = hostProblem(host);
  if (problem) return { error: problem, reached: false, checked: false };
  const { command, prefix } = program("FLEETRC_SSH", "ssh");
  const args = [
    ...prefix,
    ...sshOptions(timeoutMs),
    // hostProblem already refuses a leading "-"; this keeps ssh from reading any host as an option.
    ...sshDestination(host),
    remoteCommand,
  ];
  // The report is parsed whole, so it is not cut to the default tail. stdin stays open for `watched`.
  const run = await exec(command, args, {
    timeoutMs,
    maxOutput: 64 * 1024 * 1024,
    input: "fleet\n",
    holdStdin: true,
  });
  if (run.spawnError === "ENOENT")
    return {
      error: notInstalled(command, "ssh", "FLEETRC_SSH"),
      reached: false,
      checked: false,
    };
  const answered = new RegExp(`^${NOTE} answered\r?$`, "m").test(run.stderr);
  const told = (what: "was" | "now") =>
    run.stderr.match(new RegExp(`^${NOTE} ${what} (\\d+\\.\\d+\\.\\d+[\\w.+-]*)\r?$`, "m"))?.[1];
  const was = told("was");
  const now = told("now");
  // `fleet init`: the host had this manifest and only synced, or has another one.
  const already = new RegExp(`^${NOTE} already\r?$`, "m").test(run.stderr);
  const has = run.stderr.match(new RegExp(`^${NOTE} has (.*?)\r?$`, "m"))?.[1];
  const stderr = run.stderr.replace(new RegExp(`^${NOTE} .*\r?\n?`, "gm"), "");
  if (run.timedOut) {
    const after = `${Math.round(timeoutMs / 1000)} s`;
    if (!answered) return { error: `no answer within ${after}`, reached: false };
    const tail =
      action === "status"
        ? "but sent no report"
        : action === "init" && !already
          ? "but setup did not finish before SSH disconnected and may still be running"
          : "but its run did not finish, so it was stopped";
    return {
      error: `timed out after ${after} (the host answered, ${tail})`,
      reached: true,
      was,
      now,
    };
  }
  const note = run.stdout.match(new RegExp(`^${NOTE} ([\\w-]+)$`, "m"))?.[1];
  if (note !== undefined && Object.hasOwn(HOST_NOTES, note))
    return { note: note as keyof typeof HOST_NOTES, has };
  // sync --json prints the report last, and exits 1 when a source failed; status prints the file.
  // init --json prints its sync's report under "sync", or {"ok": false, "error"} when it stopped.
  const setUp = action === "init" && !already;
  const report = parseReport(run.stdout, setUp, requireTimer);
  if (report !== undefined && "error" in report) return { error: report.error, reached: true };
  // init exits nonzero when its sync, the hooks or the timer failed: the host is not set up.
  if (report !== undefined && setUp && run.code !== 0)
    return {
      report: report.report,
      error: initFailure(report.report, run.code, stderr),
      reached: true,
    };
  if (report !== undefined && report.timerError !== undefined)
    return { report: report.report, error: report.timerError, reached: true };
  if (report !== undefined) return { report: report.report, was, now, already };
  if (run.code !== 0)
    return {
      error: (stderr || run.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${run.code}`,
      reached: answered,
      was,
      now,
    };
  return {
    error: "the host answered with something that is not a fleetrc report",
    reached: true,
  };
}

/** Why an init that printed its report and exited `code` did not set the host up. */
function initFailure(report: unknown, code: number | null, stderr: string): string {
  const why = summarize(report)?.ok === false ? ["its first sync had errors"] : [];
  if (why.length === 0) {
    const said = stderr.trim().split("\n").slice(-2).join(" ");
    if (said) why.push(said);
  }
  return `fleetrc init exited ${code ?? "on a signal"}${why.length > 0 ? ` (${why.join("; ")})` : ""}, so the host is not set up`;
}

/**
 * The fleetrc report a host printed, or undefined when its output holds none. From `init`, the
 * report of the sync it ran, or the error it stopped with.
 */
function parseReport(
  stdout: string,
  init = false,
  requireTimer = false,
): { report: unknown; timerError?: string } | { error: string } | undefined {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  if (init && isRecord(raw)) {
    if (raw.ok === false && typeof raw.error === "string") return { error: raw.error };
    if (!summarize(raw.sync)) return undefined;
    const timer = isRecord(raw.timer) ? raw.timer : undefined;
    const timerError =
      typeof timer?.error === "string"
        ? `fleetrc init did not install the timer: ${timer.error}`
        : requireTimer && !timer
          ? "fleetrc init did not report installing the requested timer"
          : undefined;
    return { report: raw.sync, timerError };
  }
  return summarize(raw) ? { report: raw } : undefined;
}

/**
 * Runs an action on every host in parallel; unreachable hosts fall back to their cached last run.
 * A dry run of `sync` runs `sync --dry-run` on each host, and its reports are not cached as runs.
 */
export async function fleet(
  hosts: readonly (string | FleetTarget)[],
  action: FleetAction,
  version: string,
  timeoutMs = 30_000,
  { dryRun = false, setup }: { dryRun?: boolean; setup?: InitSetup } = {},
): Promise<HostResult[]> {
  const cache = readCache();
  const remoteCommand = sshRemoteCommand(action, version, dryRun, setup);
  const requireTimer = setup?.flags.includes("--timer");
  const results = await Promise.all(
    hosts.map(async (target): Promise<HostResult> => {
      const {
        host,
        via,
        offline,
        error,
        cacheKey = host,
        endpoint,
        initRetryRoute,
        refreshPeer,
      } = typeof target === "string" ? { host: target } : target;
      const lastRun = cache[cacheKey]?.run;
      const from = via ? { via } : {};
      // A tag Tailscale could not expand.
      if (error !== undefined)
        return { host, ...from, reachable: false, checked: false, error, behind: [] };
      if (offline)
        return {
          host,
          ...from,
          reachable: false,
          checked: true,
          lastRun,
          error: "offline in Tailscale",
          behind: [],
        };
      let verifiedRefresh = refreshPeer;
      let answer = await runOnHost(host, action, remoteCommand, timeoutMs, requireTimer);
      if (
        "note" in answer &&
        answer.note === "other-manifest" &&
        setup &&
        answer.has &&
        setup.same(answer.has)
      ) {
        const retryCommand = sshRemoteCommand("init", version, false, {
          ...setup,
          expectedConfig: answer.has,
        });
        if (initRetryRoute || refreshPeer) {
          const retryTarget = await effectiveDestination(
            host,
            retryCommand,
            timeoutMs,
            Math.min(750, timeoutMs),
          );
          const retryEndpoint = retryTarget && endpointKey(retryTarget);
          const retryRoute = retryTarget && retryRouteKey(retryTarget);
          if (initRetryRoute && (!retryRoute || retryRoute !== initRetryRoute.key))
            return {
              host,
              ...from,
              reachable: true,
              checked: true,
              lastRun,
              error: "could not verify an unchanged SSH route to the Tailscale peer for the retry",
              behind: [],
            };
          if (retryEndpoint !== refreshPeer?.endpoint) verifiedRefresh = undefined;
        }
        answer = await runOnHost(host, "init", retryCommand, timeoutMs, requireTimer);
      }
      const already = "already" in answer && answer.already === true;
      if ("note" in answer && answer.note === "other-manifest" && setup && answer.has) {
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun,
          error: `it has the manifest ${answer.has}; pass --force to set it up with ${setup.spec}`,
          behind: [],
        };
      }
      // The host answered, but has no report to give.
      if ("note" in answer && answer.note) {
        const note = HOST_NOTES[answer.note];
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun,
          ...(note ? { error: note } : {}),
          behind: [],
        };
      }
      const run = "report" in answer ? summarize(answer.report) : undefined;
      if (run && !dryRun) {
        if (cacheKey !== host) {
          const previous = cache[cacheKey];
          const stableEndpoint = stableCacheKey(cacheKey) ? endpoint : undefined;
          const known =
            stableEndpoint && previous?.endpoint === stableEndpoint ? previous.destinations : [];
          const destinations = stableEndpoint ? [...new Set([host, ...(known ?? [])])] : undefined;
          cache[cacheKey] = { run, destinations, endpoint: stableEndpoint };
        } else {
          cache[host] = { run };
          if (verifiedRefresh) {
            const { key, endpoint, taggedHost } = verifiedRefresh;
            const previous = cache[key];
            const known = previous?.destinations?.includes(host) || taggedHost;
            if (known && (!previous || previous.endpoint === endpoint)) {
              const destinations = new Set(previous?.destinations);
              destinations.add(host);
              if (taggedHost) destinations.add(taggedHost);
              const latest =
                !previous || Date.parse(run.finishedAt) > Date.parse(previous.run.finishedAt)
                  ? run
                  : previous.run;
              cache[key] = {
                run: latest,
                destinations: [...destinations],
                endpoint,
              };
            }
          }
        }
      }
      const before = lastRun?.fleetrc;
      // What the host runs once the upgrade went in, told before its sync, which may still fail.
      const to = ("now" in answer ? answer.now : undefined) || run?.fleetrc;
      const upgrade =
        action === "upgrade" && to
          ? {
              upgrade: {
                from: ("was" in answer ? answer.was : undefined) || before || undefined,
                to,
              },
            }
          : {};
      if (run && "error" in answer) {
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun: run,
          error: answer.error,
          behind: [],
        };
      }
      if (run) {
        return {
          host,
          ...from,
          reachable: true,
          checked: true,
          lastRun: run,
          ...upgrade,
          ...(action === "init" && run.ok ? { setup: already ? "already set up" : "set up" } : {}),
          behind: [],
        };
      }
      return {
        host,
        ...from,
        reachable: answer.reached ?? false,
        checked: answer.checked ?? true,
        lastRun,
        ...upgrade,
        error: answer.error ?? "no report",
        behind: [],
      };
    }),
  );
  if (!dryRun)
    writeJson(
      paths.fleet(),
      Object.fromEntries(
        Object.entries(cache).map(([key, { run, ...identity }]) => [key, { ...run, ...identity }]),
      ),
    );
  markBehind(results);
  return results;
}

function heldSource(run: NonNullable<HostResult["lastRun"]>, source: string): boolean {
  const status = run.sourceStatuses?.[source];
  return status === undefined ? run.held.includes(source) : status === "held";
}

/**
 * A host is behind when its last run is over two hours old or a source sits at another commit than
 * on the freshest host that synced that source online. An offline revision can be compared but
 * cannot set the reference. A host holding a source is reported as held instead. Only a host that
 * answered can be said to have never run.
 */
export function markBehind(results: HostResult[], now = Date.now()) {
  const runs = results
    .flatMap((result) => (result.lastRun ? [result.lastRun] : []))
    .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  const reference = new Map<string, string>();
  for (const run of runs)
    for (const [source, commit] of Object.entries(run.sources)) {
      if (!commit || reference.has(source) || heldSource(run, source)) continue;
      const status = run.sourceStatuses?.[source];
      if (
        status === undefined ||
        status === "installed" ||
        status === "updated" ||
        status === "unchanged"
      )
        reference.set(source, commit);
    }
  for (const result of results) {
    const run = result.lastRun;
    if (!run) {
      if (result.reachable && result.error === undefined) result.behind.push("never ran");
      continue;
    }
    if (now - new Date(run.finishedAt).getTime() > 2 * 60 * 60 * 1000)
      result.behind.push(`last run ${age(run.finishedAt, now)} ago`);
    for (const [source, commit] of reference) {
      const here = run.sources[source];
      if (here && here !== commit && !heldSource(run, source))
        result.behind.push(`${source} at ${here.slice(0, 7)}`);
    }
    if (run.held.length) result.behind.push(`held: ${run.held.join(", ")}`);
  }
}

export function age(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function formatFleet(results: readonly HostResult[]): string {
  return results
    .map((result) => {
      // A tag entry Tailscale could not expand.
      if (result.via === result.host) return `${result.host}: not expanded (${result.error})`;
      const run = result.lastRun;
      const last = run
        ? `last run ${age(run.finishedAt)} ago, ${run.skills} skills${run.ok ? "" : ", with errors"}`
        : "no run recorded";
      const state = !result.checked
        ? `not checked (${result.error}); ${last}`
        : !result.reachable
          ? `unreachable (${result.error}); ${last}`
          : result.error
            ? `${result.error}; ${last}`
            : last;
      return `${result.host}${result.via ? ` (${result.via})` : ""}: ${result.upgrade ? `${upgraded(result.upgrade)}; ` : ""}${result.setup ? `${result.setup}; ` : ""}${state}${result.behind.length ? `; behind: ${result.behind.join("; ")}` : ""}`;
    })
    .join("\n");
}

function upgraded({ from, to }: NonNullable<HostResult["upgrade"]>): string {
  if (!from) return `now on ${to}`;
  return from === to ? `already on ${to}` : `${from} → ${to}`;
}

/** A `tag:<name>` fleet entry: Tailscale's rule for a tag name, a letter and then letters, digits or dashes. */
const TAG = /^tag:[A-Za-z][A-Za-z0-9-]*$/;

export const isTag = (entry: string) => entry.startsWith("tag:");

/** Why `entry`, which starts with `tag:`, is not a Tailscale tag, or undefined when it is one. */
export function tagProblem(entry: string): string | undefined {
  if (TAG.test(entry)) return undefined;
  return `"${entry}" is not a Tailscale tag: write tag: and then a letter followed by letters, digits or dashes, such as "tag:servers"`;
}

/** Why a fleet entry, a host or a `tag:`, cannot be used, or undefined when it can. */
export const fleetEntryProblem = (entry: string) =>
  isTag(entry) ? tagProblem(entry) : hostProblem(entry);

/** A host to run on: named in the fleet, or a machine a `tag:` entry expanded to. */
export interface FleetTarget {
  host: string;
  cacheKey?: string;
  endpoint?: string;
  initRetryRoute?: { key?: string };
  refreshPeer?: { key: string; endpoint: string; taggedHost?: string };
  /** The tag the host came from. */
  via?: string;
  /** Tailscale says the machine is offline, so ssh is not tried. */
  offline?: boolean;
  /** Set on a `tag:` entry that could not be expanded: why. */
  error?: string;
}

export interface TailscalePeer {
  id?: string;
  /** The first label of its MagicDNS name, which ssh and `fleet add` take on the tailnet. */
  host: string;
  /** Its MagicDNS name without the trailing dot, or "" when it has none. */
  dns: string;
  ips: string[];
  tags: string[];
  online: boolean;
}

/** What `tailscale status --json` says: the peers, and whether MagicDNS names reach them. */
export interface Tailnet {
  peers: TailscalePeer[];
  /** False when the tailnet has MagicDNS off, so only a peer's Tailscale IP reaches it. */
  magicDNS: boolean;
}

/** The machines on the tailnet other than this one, or why Tailscale could not list them. */
export async function tailnet(timeoutMs = 10_000): Promise<Tailnet | { error: string }> {
  const found = await tailscaleStatus([], timeoutMs);
  if ("error" in found) return found;
  const parsed = found.status;
  const self = isRecord(parsed.Self) ? parsed.Self : {};
  const peers = Object.values(isRecord(parsed.Peer) ? parsed.Peer : {}).flatMap((peer) => {
    if (!isRecord(peer)) return [];
    // Tailscale lists this machine under Self, not Peer; a Peer entry that is Self is skipped all the same.
    if (peer.PublicKey !== undefined && peer.PublicKey === self.PublicKey) return [];
    const dns = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
    // HostName is the machine's own name, which can have spaces ("Maxi's MacBook Pro").
    const host = dns.split(".")[0] || (typeof peer.HostName === "string" ? peer.HostName : "");
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item !== "")
        : [];
    return [
      {
        id: typeof peer.ID === "string" && peer.ID ? peer.ID : undefined,
        host,
        dns,
        ips: strings(peer.TailscaleIPs),
        tags: strings(peer.Tags),
        online: peer.Online === true,
      },
    ];
  });
  // Older Tailscale versions leave CurrentTailnet out; MagicDNS is on unless it says otherwise.
  const current = isRecord(parsed.CurrentTailnet) ? parsed.CurrentTailnet : {};
  return { peers, magicDNS: current.MagicDNSEnabled !== false };
}

/**
 * Whether a name or address `tailscale status` gave is one to hand ssh: a DNS name or an IP
 * address, nothing ssh reads as an option or a user (`-oProxyCommand=x`, `user@x`).
 */
const tailnetHost = (host: string) =>
  !hostProblem(host) &&
  (isIP(host) !== 0 ||
    /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*$/.test(
      host,
    ));

function peerDestinations(peer: TailscalePeer, magicDNS: boolean) {
  return {
    dns: magicDNS && tailnetHost(peer.dns) ? peer.dns : undefined,
    ips: peer.ips.filter((ip) => !hostProblem(ip) && isIP(ip) !== 0),
  };
}

/** Named host suggestions and all peers with a possible tag destination, from one status query. */
export async function fleetSuggestions() {
  const answer = await tailnet();
  if ("error" in answer) return { named: [], taggable: [] };
  return {
    named: answer.peers.filter((peer) => peer.host && tailnetHost(peer.host)),
    taggable: answer.peers.filter((peer) => {
      const { dns, ips } = peerDestinations(peer, answer.magicDNS);
      return dns || ips.length > 0;
    }),
  };
}

/**
 * A host name or address, normalised for comparing: lower case, no trailing dot, an IPv6 address
 * in its shortest form (`fd7a:0::9` is `fd7a::9`). A short name and a MagicDNS name are one
 * machine only when Tailscale says so: two tailnets can each have a `vps`.
 */
function hostKey(host: string): string {
  const name = host.replace(/\.$/, "").toLowerCase();
  if (name.includes(":")) {
    const [address = "", zone] = name.split("%", 2);
    let canonical = address;
    try {
      canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {}
    return zone === undefined ? canonical : `${canonical}%${zone}`;
  }
  return name;
}

function sshHostKey(host: string): string {
  const zone = host.indexOf("%");
  if (zone >= 0 && isIP(host) === 6) return hostKey(host.slice(0, zone)) + host.slice(zone);
  return isIP(host) ? hostKey(host) : host;
}

const LOOKUP_ADDRESSES = `
  const { lookup } = require('node:dns');
  const { readFileSync } = require('node:fs');
  const names = JSON.parse(readFileSync(0, 'utf8'));
  for (const name of names) lookup(name, { all: true }, (error, answers) => {
    if (!error) console.log(JSON.stringify([name, answers.map(({ address }) => address)]));
  });
`;

/** Use the OS resolver (including split DNS), in a process we can stop on timeout. */
async function localAddresses(names: string[], timeoutMs: number) {
  const found = new Map<string, string[]>();
  if (!names.length || timeoutMs <= 0) return found;
  const run = await exec(process.execPath, ["-e", LOOKUP_ADDRESSES], {
    input: JSON.stringify(names),
    timeoutMs,
  });
  for (const line of run.stdout.split("\n")) {
    if (!line) continue;
    try {
      const [name, ips] = JSON.parse(line) as [string, string[]];
      found.set(name, ips);
    } catch {}
  }
  return found;
}

async function verifyAddresses(
  names: string[],
  budget: number,
  addresses?: (name: string) => Promise<string[]>,
) {
  if (!addresses) return localAddresses(names, budget);
  const found = new Map<string, string[]>();
  if (budget <= 0 || !names.length) return found;
  const timer = new AbortController();
  try {
    await Promise.race([
      delay(budget, undefined, { signal: timer.signal }),
      Promise.all(
        names.map(async (name) => {
          try {
            const ips = await addresses(name);
            if (!timer.signal.aborted) found.set(name, ips);
          } catch {}
        }),
      ),
    ]);
  } finally {
    timer.abort();
  }
  return found;
}

async function effectiveDestination(
  entry: string,
  remoteCommand: string,
  timeoutMs: number,
  budget: number,
) {
  if (hostProblem(entry) || budget <= 0) return undefined;
  const { command, prefix } = program("FLEETRC_SSH", "ssh");
  const run = await exec(
    command,
    [...prefix, "-G", ...sshOptions(timeoutMs), ...sshDestination(entry), remoteCommand],
    {
      timeoutMs: budget,
    },
  );
  if (run.code !== 0 || run.timedOut || run.truncated) return undefined;
  if (/^proxy(?:command|jump) (?!none\r?$)/im.test(run.stdout)) return undefined;
  const name = /^hostname (\S+)\r?$/m.exec(run.stdout)?.[1];
  if (!name || !tailnetHost(name.replace(/\.$/, ""))) return undefined;
  return {
    name,
    user: /^user (\S+)\r?$/m.exec(run.stdout)?.[1],
    port: /^port (\d+)\r?$/m.exec(run.stdout)?.[1],
    family: /^addressfamily (inet6?)\r?$/m.exec(run.stdout)?.[1],
  };
}

type EffectiveDestination = NonNullable<Awaited<ReturnType<typeof effectiveDestination>>>;

function endpointKey({ name, user, port }: EffectiveDestination) {
  return user && port ? JSON.stringify([sshHostKey(name), user, port]) : undefined;
}

function retryRouteKey(target: EffectiveDestination) {
  const endpoint = endpointKey(target);
  return endpoint && JSON.stringify([endpoint, target.family]);
}

const stablePeerKey = (peer: TailscalePeer) => (peer.id ? `tag-peer:id:${peer.id}` : undefined);
const stableCacheKey = (key: string) => key.startsWith("tag-peer:id:");

/**
 * The machine, user and port a fleet entry names: `host`, `user@host`, a bare IP address (IPv6
 * has no port there, so its last group stays), or `ssh://[user@]host[:port]` with the host in
 * brackets for IPv6. A port is kept as written, since `~/.ssh/config` may give the bare name
 * another one.
 */
function sshTarget(entry: string): { machine: string; user: string; port: string } {
  const url = entry.startsWith("ssh://");
  let rest = url ? entry.slice("ssh://".length) : entry;
  const at = rest.lastIndexOf("@");
  const user = at >= 0 ? rest.slice(0, at) : "";
  rest = rest.slice(at + 1);
  let port = "";
  if (url) {
    const parts = rest.match(/^(?:\[([^\]]*)\]|([^:]*))(?::([0-9]+))?$/);
    if (parts) {
      rest = parts[1] ?? parts[2] ?? rest;
      port = parts[3] ?? "";
    }
  }
  return { machine: rest, user, port };
}

/**
 * The hosts to run on: the explicit ones as they are, and each `tag:` entry as every tailnet
 * machine with that tag, preferring MagicDNS and falling back to a Tailscale IP. Online tag
 * destinations must resolve to the peer after OpenSSH configuration is applied. Tailscale is
 * asked once for tags or to verify a cached tagged destination. Explicit SSH names retain their
 * spelling unless verified to reach the same peer with the same user and port. Numeric IPv6
 * spellings are normalized separately. An explicit host wins over a tag's match for its machine,
 * whatever its user or port, and the first tag wins over later ones. An empty tag or a peer with
 * no usable name or address gets a warning; failures to expand or verify get an `error`.
 */
export async function resolveFleet(
  entries: readonly string[],
  addresses?: (name: string) => Promise<string[]>,
  timeoutMs = 30_000,
  { action, version, dryRun = false, setup }: FleetInvocation = {
    action: "status",
    version: "0.0.0",
  },
  coveredByTags?: Set<string>,
): Promise<{
  targets: FleetTarget[];
  warnings: string[];
  enrollment: Map<string, FleetTarget[] | null>;
}> {
  const warnings: string[] = [];
  const tagNames = new Set(entries.filter(isTag).map((entry) => entry.toLowerCase()));
  const explicit = [...new Set(entries.filter((entry) => !isTag(entry)))];
  const variants = new Map<string, Set<string>>();
  for (const entry of explicit) {
    const { machine } = sshTarget(entry);
    const folded = hostKey(machine);
    const names = variants.get(folded) ?? new Set<string>();
    names.add(sshHostKey(machine));
    variants.set(folded, names);
  }
  const cachedDestinations = new Set(
    explicit.length
      ? Object.entries(readCache()).flatMap(([key, record]) =>
          stableCacheKey(key) && record.endpoint ? (record.destinations ?? []) : [],
        )
      : [],
  );
  const probes = explicit.filter((entry) => cachedDestinations.has(entry));
  const answer: Tailnet | { error: string } = tagNames.size
    ? await tailnet()
    : probes.length
      ? await tailnet(Math.min(1500, timeoutMs))
      : { peers: [], magicDNS: true };
  const peerOf = new Map<
    string,
    { peer: TailscalePeer; index: number; target: EffectiveDestination }
  >();
  const destination = new Map<TailscalePeer, FleetTarget>();
  const refresh = new Map<string, NonNullable<FleetTarget["refreshPeer"]>>();
  const aliases = new Map<string, string>();
  if ("peers" in answer) {
    const peers = answer.peers.map((peer, index) => ({
      peer,
      index,
      ...peerDestinations(peer, answer.magicDNS),
    }));
    const tagged = peers.filter(({ peer }) =>
      peer.tags.some((tag) => tagNames.has(tag.toLowerCase())),
    );
    const budget = Math.min(1500, timeoutMs);
    const probeTimeout = budget / 2;
    const deadline = performance.now() + budget;
    const remoteCommand = sshRemoteCommand(action, version, dryRun, setup);
    const entriesToProbe = new Set([
      ...(tagged.length ? explicit : probes),
      ...explicit.filter(
        (entry) => (variants.get(hostKey(sshTarget(entry).machine))?.size ?? 0) > 1,
      ),
      ...tagged.flatMap(({ peer, dns, ips }) =>
        peer.online ? [...(dns ? [dns] : []), ...ips] : [],
      ),
    ]);
    const pending = entriesToProbe.values();
    const effective = new Map<string, EffectiveDestination>();
    await Promise.all(
      Array.from({ length: Math.min(12, entriesToProbe.size) }, async () => {
        for (const entry of pending) {
          const target = await effectiveDestination(entry, remoteCommand, timeoutMs, probeTimeout);
          if (target) effective.set(entry, target);
        }
      }),
    );
    const names = new Set<string>();
    for (const { name } of effective.values()) if (!isIP(name)) names.add(name);
    const found = await verifyAddresses(
      [...names],
      Math.max(probeTimeout, deadline - performance.now()),
      addresses,
    );
    const matches = ({ name, family }: EffectiveDestination, { ips }: (typeof peers)[number]) => {
      const resolved = (isIP(name) ? [name] : (found.get(name) ?? [])).filter(
        (ip) => !family || isIP(ip) === (family === "inet" ? 4 : 6),
      );
      const keys = ips.map(hostKey);
      return resolved.length > 0 && resolved.every((ip) => keys.includes(hostKey(ip)));
    };
    for (const entry of explicit) {
      const target = effective.get(entry);
      if (!target) continue;
      const endpoint = endpointKey(target);
      if (endpoint) aliases.set(entry, endpoint);
      const candidates = peers.filter((candidate) => matches(target, candidate));
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (!candidate) continue;
      if (tagged.length) peerOf.set(entry, { ...candidate, target });
      const key = stablePeerKey(candidate.peer);
      if (cachedDestinations.has(entry) && candidate.ips.length && key && endpoint)
        refresh.set(entry, { key, endpoint });
    }
    for (const candidate of tagged) {
      const { peer, dns, ips } = candidate;
      const preferred = dns ?? ips[0];
      if (!preferred) continue;
      const cacheKey = stablePeerKey(peer) ?? `tag-peer:address:${hostKey(ips[0] ?? preferred)}`;
      if (!peer.online) {
        destination.set(peer, { host: preferred, cacheKey, offline: true });
        continue;
      }
      const candidates = dns ? [dns, ...ips] : ips;
      destination.set(peer, {
        host: preferred,
        cacheKey,
        error: "could not verify an SSH route to the Tailscale peer",
      });
      for (const host of candidates) {
        const target = effective.get(host);
        if (!target || !matches(target, candidate)) continue;
        const endpoint = stableCacheKey(cacheKey) ? endpointKey(target) : undefined;
        const initRetryRoute = action === "init" ? { key: retryRouteKey(target) } : undefined;
        destination.set(peer, {
          host,
          cacheKey,
          endpoint,
          ...(initRetryRoute && { initRetryRoute }),
        });
        break;
      }
    }
    if (!dryRun || coveredByTags) {
      for (const entry of explicit) {
        const candidate = peerOf.get(entry);
        const selected = candidate && destination.get(candidate.peer);
        const target = effective.get(entry);
        if (!selected?.cacheKey || selected.error || selected.offline || !target) continue;
        const taggedTarget = effective.get(selected.host);
        const { user, port } = sshTarget(entry);
        if (
          !user &&
          !port &&
          taggedTarget &&
          endpointKey(taggedTarget) &&
          target.user === taggedTarget.user &&
          target.port === taggedTarget.port
        )
          coveredByTags?.add(entry);
        const canRefresh = !dryRun && stableCacheKey(selected.cacheKey);
        if (canRefresh && selected.endpoint && aliases.get(entry) === selected.endpoint)
          refresh.set(entry, {
            key: selected.cacheKey,
            endpoint: selected.endpoint,
            taggedHost: selected.host,
          });
      }
    }
  }
  const explicitPeers = new Map<TailscalePeer, string>();
  for (const [entry, { peer }] of peerOf) {
    if (!explicitPeers.has(peer)) explicitPeers.set(peer, entry);
  }
  const seen = new Map<string, FleetTarget>();
  const namedTargets = new Map<string, FleetTarget>();
  for (const entry of explicit) {
    const target = sshTarget(entry);
    const peer = peerOf.get(entry);
    const endpoint = aliases.get(entry);
    const machine = peer
      ? `peer:${peer.index}`
      : endpoint
        ? `endpoint:${endpoint}`
        : `host:${sshHostKey(target.machine)}`;
    const key = [machine, target.user, target.port, peer?.target.user, peer?.target.port].join(
      "\0",
    );
    let dispatch = seen.get(key);
    if (!dispatch) {
      const refreshPeer = refresh.get(entry);
      const initRetryRoute =
        action === "init" &&
        peer &&
        explicitPeers.get(peer.peer) === entry &&
        destination.has(peer.peer)
          ? { key: retryRouteKey(peer.target) }
          : undefined;
      dispatch = {
        host: entry,
        ...(refreshPeer && { refreshPeer }),
        ...(initRetryRoute && { initRetryRoute }),
      };
      seen.set(key, dispatch);
    }
    namedTargets.set(entry, dispatch);
  }
  const taggedTargets = new Map<TailscalePeer, FleetTarget>();
  const enrollment = new Map<string, FleetTarget[] | null>();
  const targets = new Set<FleetTarget>();
  for (const entry of entries) {
    const named = namedTargets.get(entry);
    if (named) {
      targets.add(named);
      enrollment.set(entry, [named]);
      continue;
    }
    if ("error" in answer) {
      targets.add({ host: entry, via: entry, error: answer.error });
      continue;
    }
    const tag = entry.toLowerCase();
    const matches = answer.peers.filter((peer) => peer.tags.some((t) => t.toLowerCase() === tag));
    if (matches.length === 0)
      warnings.push(`${entry} matches no machine on your tailnet besides this one`);
    const requiredTargets: FleetTarget[] = [];
    for (const peer of matches) {
      const selected = destination.get(peer);
      if (!selected) {
        warnings.push(
          `${entry}: skipped a machine Tailscale calls ${JSON.stringify(peer.dns || peer.host)}, which has no name or address ssh takes`,
        );
        continue;
      }
      const explicitPeer = explicitPeers.get(peer);
      let dispatch = explicitPeer ? namedTargets.get(explicitPeer) : taggedTargets.get(peer);
      if (!dispatch) {
        dispatch = { ...selected, via: entry };
        taggedTargets.set(peer, dispatch);
        targets.add(dispatch);
      }
      requiredTargets.push(dispatch);
    }
    if (matches.length > 0)
      enrollment.set(entry, requiredTargets.length === matches.length ? requiredTargets : null);
  }
  return { targets: [...targets], warnings, enrollment };
}

/**
 * The entries of `wanted` that `entries`, a manifest's fleet, does not cover yet: a host not named
 * there and, unless it names a user or a port, not on the tailnet under one of its tags; and a tag
 * not there. Tailscale is asked only when it could matter; when it can't say, a tag covers nothing.
 */
export async function notInFleet(
  entries: readonly string[],
  wanted: readonly string[],
  timeoutMs = 30_000,
  invocation: FleetInvocation = { action: "status", version: "0.0.0" },
): Promise<string[]> {
  const key = (entry: string) => {
    const { machine, user, port } = sshTarget(entry);
    return [sshHostKey(machine), user, port].join("\0");
  };
  const bare = (entry: string) => {
    const { user, port } = sshTarget(entry);
    return !user && !port;
  };
  const names = entries.filter((entry) => !isTag(entry));
  const named = new Set(names.map(key));
  const selectors = entries.filter(isTag);
  const tags = new Set(selectors.map((tag) => tag.toLowerCase()));
  const candidates = wanted.filter((entry) => !isTag(entry) && !named.has(key(entry)));
  const tagged = new Set<string>();
  if (selectors.length && candidates.some(bare))
    await resolveFleet(
      [...selectors, ...candidates.filter(bare)],
      undefined,
      timeoutMs,
      { ...invocation, dryRun: true },
      tagged,
    );
  const endpoints = new Map<string, Promise<string | undefined>>();
  const endpoint = (entry: string) => {
    let pending = endpoints.get(entry);
    if (!pending) {
      const remoteCommand = sshRemoteCommand(
        invocation.action,
        invocation.version,
        invocation.dryRun ?? false,
        invocation.setup,
      );
      pending = effectiveDestination(
        entry,
        remoteCommand,
        timeoutMs,
        Math.min(750, timeoutMs),
      ).then((target) => (target ? endpointKey(target) : undefined));
      endpoints.set(entry, pending);
    }
    return pending;
  };
  const compare = async (entry: string, others: string[]) => {
    if (!others.length) return false;
    const actual = await endpoint(entry);
    return actual !== undefined && (await Promise.all(others.map(endpoint))).includes(actual);
  };
  const missing: string[] = [];
  for (const entry of wanted) {
    if (isTag(entry)) {
      const tag = entry.toLowerCase();
      if (!tags.has(tag)) missing.push(entry);
      tags.add(tag);
      continue;
    }
    if (named.has(key(entry)) || tagged.has(entry)) continue;
    const { machine, user, port } = sshTarget(entry);
    const variants = names.filter((name) => {
      const other = sshTarget(name);
      return (
        user === other.user && port === other.port && hostKey(machine) === hostKey(other.machine)
      );
    });
    if (await compare(entry, variants)) continue;
    missing.push(entry);
    names.push(entry);
    named.add(key(entry));
  }
  return missing;
}
