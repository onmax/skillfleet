// fleetrc was called skillfleet. Every name of that release lives here, and nowhere else: what
// migrate.ts moves to the new names once per machine, and what is still read, with a warning, for
// one release (a tailnet capability, a manifest folder, the manifest hooks' variables).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgDir } from "./paths.ts";

/** The old name: of the package, the command, the launcher and the state and config folders. */
export const LEGACY_NAME = "skillfleet";

/** The old timer's name, in systemd, launchd and Task Scheduler. */
export const LEGACY_TIMER = `${LEGACY_NAME}-sync`;

/** The old record of the links made in an agent's skills folder (linker.ts `MANIFEST_FILE`). */
export const LEGACY_RECORD = `.${LEGACY_NAME}-manifest.json`;

/** The old folder a repository kept its manifest in. */
export const LEGACY_MANIFEST_DIR = `.${LEGACY_NAME}`;

/** The old tailnet policy capability (tailscale.ts `TAILSCALE_CAPABILITY`). */
export const LEGACY_CAPABILITY = `github.com/onmax/${LEGACY_NAME}`;

/** The old state folder, placed as paths.ts `stateDir` placed it. */
export function legacyStateDir(): string {
  const xdg = xdgDir("XDG_STATE_HOME");
  if (xdg) return join(xdg, LEGACY_NAME);
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, LEGACY_NAME);
  return join(homedir(), ".local", "state", LEGACY_NAME);
}

/** The old config folder, placed as paths.ts `configDir` placed it. */
export function legacyConfigDir(): string {
  const xdg = xdgDir("XDG_CONFIG_HOME");
  if (xdg) return join(xdg, LEGACY_NAME);
  if (process.platform === "win32" && process.env.APPDATA)
    return join(process.env.APPDATA, LEGACY_NAME);
  return join(homedir(), ".config", LEGACY_NAME);
}

/** The old launcher's file names in `bin/`: sh, and on Windows cmd and PowerShell. */
export const LEGACY_LAUNCHERS = [LEGACY_NAME, `${LEGACY_NAME}.cmd`, `${LEGACY_NAME}.ps1`];

/**
 * The file in the new state folder that says a move is under way: written before anything moves,
 * removed once everything has, so a move that stops partway is finished by the next run.
 */
export const MIGRATION_MARKER = "migrating";

/**
 * Whether this machine still has the old install's state to move: a move that stopped partway, the
 * old state folder and no new one to move it into, or a new one that never synced (a command made
 * it before any migration).
 */
export function migrationNeeded(newState: string): boolean {
  if (existsSync(join(newState, MIGRATION_MARKER))) return true;
  const old = legacyStateDir();
  if (!existsSync(old)) return false;
  if (!existsSync(newState)) return true;
  return existsSync(join(old, "state.json")) && !existsSync(join(newState, "state.json"));
}

/** The name, in a regular expression, alongside the old one, for patterns that match either. */
export const eitherName = (name: string) => `(?:${name}|${LEGACY_NAME})`;

/** The placeholders the old release left where it removed a Codex hook (agenthooks.ts). */
export const LEGACY_DISABLED = [
  `exit 0 # ${LEGACY_NAME}: disabled legacy hook`,
  `exit /b 0 & rem ${LEGACY_NAME}: disabled legacy hook`,
];

/** The version a host's report names, from either release (report.ts `fleetrc`). */
export function reportVersion(raw: Record<string, unknown>, field: string): string {
  const value = raw[field] ?? raw[LEGACY_NAME];
  return typeof value === "string" ? value : "";
}

/** For fleet's host scripts: the old state and config folders in sh, as fleet.ts writes the new. */
export const LEGACY_FLEET = {
  state: `"\${XDG_STATE_HOME:-$HOME/.local/state}/${LEGACY_NAME}"`,
  launcher: `bin/${LEGACY_NAME}`,
  config: `${LEGACY_NAME}/config.json`,
};

/** The variables a manifest hook got from the old release, set alongside the new ones. */
export function legacyHookEnv(name: string, changed: string): Record<string, string> {
  const prefix = LEGACY_NAME.toUpperCase();
  return { [`${prefix}_HOOK`]: name, [`${prefix}_CHANGED`]: changed };
}

/** Why a manifest hook's command reads the old variables, or undefined when it does not. */
export function legacyHookNote(hook: string, run: string): string | undefined {
  const prefix = LEGACY_NAME.toUpperCase();
  if (!run.includes(`${prefix}_`)) return undefined;
  return `hook ${hook} reads ${prefix}_HOOK or ${prefix}_CHANGED, which this release still sets; rename them to FLEETRC_HOOK and FLEETRC_CHANGED before the next one drops them`;
}

const said = new Set<string>();

/** Says, once per process, that an old name was read: one line on stderr. */
export function legacyWarning(message: string) {
  if (said.has(message)) return;
  said.add(message);
  process.stderr.write(`fleetrc: warning: ${message}\n`);
}
