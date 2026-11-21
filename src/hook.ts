// What an agent's session hook runs: `fleetrc hook run <agent>`, when a session starts. It starts
// a sync in the background when the last attempt is stale. The agent waits for it before the
// session opens, so it loads only small modules (entry.ts imports it without cli.ts, and the
// modules that start a sync load only when one starts), makes no network call, prints nothing,
// and always exits 0.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord, lstat, readJsonOrNothing } from "./fs.ts";
import { migrationNeeded } from "./legacy.ts";
import { adoptInstalledPlaces, claudeHome, paths, stateDir } from "./paths.ts";

export const HOOK_AGENTS = ["claude-code", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** How long after one attempt the hook leaves syncing alone; FLEETRC_HOOK_STALE_MS sets it, for tests. */
function staleAfterMs(): number {
  const set = Number(process.env.FLEETRC_HOOK_STALE_MS);
  return process.env.FLEETRC_HOOK_STALE_MS && set >= 0 ? set : 15 * 60_000;
}

/** The timer's log, which syncs started by a hook append to as well. */
const syncLog = () => join(paths.logs(), "fleetrc-sync.log");

/**
 * Whether the last attempt is recent. The stamp holds the time of the attempt, not of a finished
 * sync: a sync that fails (offline, a manifest that does not fetch) is tried again only once it is
 * stale too. A stamp from the future (the clock was set back) counts as stale.
 */
function attemptedRecently(): boolean {
  let at: number;
  try {
    at = Number(readFileSync(paths.hookAttempt(), "utf8"));
  } catch {
    return false;
  }
  return Number.isFinite(at) && Math.abs(Date.now() - at) < staleAfterMs();
}

/**
 * Takes the claim file, so of many hooks that find the stamp stale at once (twenty sessions
 * started together), one goes on. The claim is held the way the sync lock is (lock.ts): it names
 * its holder, a claim whose holder is gone is broken by one breaker at a time, and it is let go
 * only while it is still this hook's. Returns the release, or undefined when another hook holds it.
 */
function claim(file: string, lock: typeof import("./lock.ts")): (() => void) | undefined {
  const { lockText, readLock, takeLock } = lock;
  const mine = lockText("hook");
  try {
    takeLock(file, mine);
  } catch {
    return undefined;
  }
  return () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
}

/**
 * The environment of the sync: what `hook install` saved, the way the timer keeps the environment
 * of the shell that installed it, so the agent's PATH and settings do not reach the manifest's
 * hooks. The ssh agent is the one running now.
 */
function syncEnv({
  findOnPath,
  timerEnv,
}: typeof import("./selfinstall.ts")): Record<string, string> {
  const saved = readJsonOrNothing(paths.hookEnv());
  const env: Record<string, string> = {};
  if (isRecord(saved))
    for (const [key, value] of Object.entries(saved))
      if (typeof value === "string") env[key] = value;
  if (!env.PATH) Object.assign(env, timerEnv(findOnPath("git"), process.execPath));
  delete env.SSH_AUTH_SOCK;
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  // A sync that meets another one exits 0 quietly, and its log lines carry the time.
  env.FLEETRC_TIMER = "1";
  return env;
}

/**
 * Starts `fleetrc sync` on its own: it outlives the hook and the agent's wait for it, and writes
 * to the timer's log. It runs the installed copy with this node, as the launcher does; the hook was
 * started through the launcher, so this node is the launcher's.
 */
function startSync(why: string, self: typeof import("./selfinstall.ts")) {
  const installed = join(paths.app(), "cli.mjs");
  const cli = existsSync(installed) ? installed : process.argv[1];
  if (!cli) return;
  mkdirSync(paths.logs(), { recursive: true });
  const log = openSync(syncLog(), "a");
  try {
    writeFileSync(log, `${new Date().toISOString()} ${why}: starting a sync\n`);
    // Loaded here, as the hook seldom starts a sync.
    const { spawn } = process.getBuiltinModule("node:child_process");
    const child = spawn(process.execPath, [cli, "sync"], {
      cwd: stateDir(),
      env: syncEnv(self),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Notes that this agent's hook ran, at most once an hour, for `doctor`. */
function markRan(agent: HookAgent) {
  const file = paths.hookRan(agent);
  try {
    if (Date.now() - statSync(file).mtimeMs < 60 * 60_000) return;
  } catch {}
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, String(Date.now()));
}

/**
 * Starts a sync when none was attempted lately and none is running. The modules that take the claim
 * and start the sync load only past the first look at the stamp, which nearly every hook stops at.
 */
async function syncIfStale(why: string) {
  if (attemptedRecently()) return;
  const [lock, self] = await Promise.all([import("./lock.ts"), import("./selfinstall.ts")]);
  mkdirSync(stateDir(), { recursive: true });
  const release = claim(`${paths.hookAttempt()}.claim`, lock);
  if (!release) return;
  try {
    // For tests: hold the claim a while, so hooks that started together meet it.
    const hold = Number(process.env.FLEETRC_HOOK_CLAIM_HOLD_MS);
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    // Another hook may have attempted between the first look and the claim.
    if (attemptedRecently()) return;
    const stamp = `${paths.hookAttempt()}.${process.pid}.tmp`;
    writeFileSync(stamp, String(Date.now()));
    renameSync(stamp, paths.hookAttempt());
    // A running sync brings the skills up to date itself.
    if (!lock.syncRunning()) startSync(why, self);
  } finally {
    release();
  }
}

/** Whether this machine has a config.json that names a manifest: `fleetrc init` ran. */
function configured(): boolean {
  if (!existsSync(paths.config())) return false;
  const config = readJsonOrNothing(paths.config());
  return isRecord(config) && typeof config.manifest === "string";
}

/**
 * `fleetrc hook run <agent>` reads `hook_event_name` from stdin. For Claude Code's legacy prompt
 * hooks it only names new skills. Only SessionStart or a call without
 * an event can start a sync. On a machine without fleetrc's config it does nothing.
 */
export async function runHook(agent: HookAgent, promptOnly = false) {
  try {
    adoptInstalledPlaces();
    if (migrationNeeded(stateDir())) {
      // The old name's install, moved once and quietly; the sync after it starts now.
      try {
        const { migrate } = await import("./migrate.ts");
        await migrate();
        rmSync(paths.hookAttempt(), { force: true });
      } catch {}
    }
    if (!configured()) return;
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {}
    const name = promptOnly
      ? "UserPromptSubmit"
      : isRecord(parsed)
        ? parsed.hook_event_name
        : undefined;
    if (agent === "claude-code" && name === "UserPromptSubmit") {
      const { promptHook } = await import("./sessions.ts");
      const { readTargetManifest, samePath } = await import("./linker.ts");
      const dir = join(claudeHome(), "skills");
      const { links } = readTargetManifest(dir);
      const state = readJsonOrNothing(paths.state());
      const skills = Object.create(null) as Record<string, { addedAt: string }>;
      if (isRecord(state) && isRecord(state.skills))
        for (const [skill, record] of Object.entries(state.skills)) {
          const link = links[skill];
          if (
            !link ||
            !isRecord(record) ||
            typeof record.addedAt !== "string" ||
            typeof record.dir !== "string" ||
            record.source !== link.source
          )
            continue;
          const published = join(dir, skill);
          if (!existsSync(join(published, "SKILL.md"))) continue;
          const entry = lstat(published);
          const matches =
            link.kind === "copy"
              ? entry?.isDirectory() && samePath(link.target, record.dir)
              : entry?.isSymbolicLink() && samePath(published, record.dir);
          if (matches) skills[skill] = { addedAt: record.addedAt };
        }
      const text = promptHook(input, { skills });
      if (text) {
        process.stdout.on("error", () => {});
        process.stdout.write(text);
      }
      return;
    }
    if (name !== undefined && name !== "SessionStart") return;
    if (agent === "claude-code" && name === "SessionStart")
      try {
        const { sessionStarted } = await import("./sessions.ts");
        sessionStarted(input);
      } catch {}
    try {
      markRan(agent);
    } catch {}
    try {
      await syncIfStale(`${agent} ${name ?? "a session hook"}`);
    } catch {}
  } catch {
    // The agent shows a hook's failure to the user, and the hook is the agent's, not fleetrc's.
  } finally {
    process.exitCode = 0;
  }
}
