import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord, readJsonOrNothing } from "./fs.ts";

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

/** `~` and `~/x` become paths in the home directory; relative paths resolve against `base`. */
export function expandPath(path: string, base = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

/** The path with the home directory written as `~`, for messages. */
export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") || path.startsWith(home + "\\")
    ? `~${path.slice(home.length)}`
    : path;
}

/** An XDG base directory variable, or undefined when it is unset or relative, as the XDG spec says. */
export function xdgDir(name: "XDG_CONFIG_HOME" | "XDG_STATE_HOME"): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

/** Folders read in place of this install's for the rest of the run; see `readPlacesFrom`. */
let places: { state: string; config: string } | undefined;

/**
 * Reads the state and config folders of `from` for the rest of this run: a dry run of the move
 * from the old name (migrate.ts), which writes nothing, still shows what a sync there would do.
 */
export function readPlacesFrom(from: { state: string; config: string }) {
  places = from;
}

/** Where `config.json` lives: XDG config, else %APPDATA% on Windows, else ~/.config. */
export function configDir(): string {
  if (places) return places.config;
  const env = process.env;
  const xdg = xdgDir("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, "fleetrc");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "fleetrc");
  return join(homedir(), ".config", "fleetrc");
}

function installedStateDir(): string | undefined {
  const script = process.argv[1];
  if (script && basename(script) === "cli.mjs" && basename(dirname(script)) === "app")
    return dirname(dirname(script));
}

let windowsInstalledState: string | undefined;

/**
 * Per-machine state: explicit XDG state, existing Windows state or the installed copy, then the
 * platform default. The Windows installed choice stays fixed for the invocation.
 */
export function stateDir(): string {
  if (places) return places.state;
  const xdg = xdgDir("XDG_STATE_HOME");
  if (xdg) return join(xdg, "fleetrc");
  const installed = installedStateDir();
  const appData = process.platform === "win32" && process.env.LOCALAPPDATA;
  if (appData) {
    const local = join(appData, "fleetrc");
    if (!installed || installed === local) return local;
    return (windowsInstalledState ??= existsSync(join(local, "state.json")) ? local : installed);
  }
  return installed ?? join(homedir(), ".local", "state", "fleetrc");
}

export const paths = {
  config: () => join(configDir(), "config.json"),
  state: () => join(stateDir(), "state.json"),
  lastRun: () => join(stateDir(), "last-run.json"),
  initPending: () => join(stateDir(), "init-pending"),
  fleet: () => join(stateDir(), "fleet.json"),
  /** Claude Code sessions, one record each (sessions.ts). */
  sessions: () => join(stateDir(), "sessions"),
  lock: () => join(stateDir(), "sync.lock"),
  store: (source: string) => join(stateDir(), "store", source),
  cache: () => join(stateDir(), "cache"),
  backup: () => join(stateDir(), "backup"),
  app: () => join(stateDir(), "app"),
  bin: () => join(stateDir(), "bin"),
  logs: () => join(stateDir(), "logs"),
  /** When a session hook last started a sync, or found one running; see hook.ts. */
  hookAttempt: () => join(stateDir(), "hook-attempt"),
  /** When an agent's `hook run` last ran, within the hour; for `doctor`. */
  hookRan: (agent: string) => join(stateDir(), `hook-ran-${agent}`),
  /** The environment a sync started by a session hook runs with, saved by `hook install`. */
  hookEnv: () => join(stateDir(), "hook-env.json"),
};

/** The variables that place fleetrc's config and state folders (paths.ts). */
const PLACES = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA"] as const;

/**
 * Where fleetrc was installed, for an agent whose environment lacks the installing shell's
 * XDG_CONFIG_HOME or XDG_STATE_HOME. Hooks and the launcher run the installed copy, `<state>/app/cli.mjs`, so
 * its own path names the state folder; the hook-env.json `hook install` saved there has the
 * variables that place the config and state folders, which this process takes before it looks.
 * Run from anywhere else (npx, a checkout), it keeps its own environment.
 */
export function adoptInstalledPlaces() {
  const installed = installedStateDir();
  if (!installed) return;
  const saved = readJsonOrNothing(join(installed, "hook-env.json"));
  if (!isRecord(saved)) return;
  for (const key of PLACES)
    if (typeof saved[key] === "string") process.env[key] = saved[key];
    else delete process.env[key];
}
