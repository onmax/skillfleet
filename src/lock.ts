// The sync lock: one sync, or one command that changes state.json, at a time on a state folder.
import { randomBytes } from "node:crypto";
import { linkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UserError } from "./errors.ts";
import { isErrno, isRecord, sha256 } from "./fs.ts";
import { paths, tildify } from "./paths.ts";
import {
  sameBoot as bootsMatch,
  processAge,
  processStartedAt,
  processStartTicks,
  type Whereabouts,
  whereabouts,
} from "./process.ts";

/**
 * No sync takes this long (a whole run is stopped after `SYNC_TIMEOUT_MS`); a lock older than this
 * was left by one that hung or was killed.
 */
export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * How far the start the OS records for a process may come after the start it measured itself
 * (`performance.timeOrigin`): `ps` gives whole seconds, and Linux places a start through the boot
 * time, which moves when the clock is set.
 */
const START_SLACK_MS = 10_000;

export interface LockHolder {
  pid: number;
  /** The command that holds it: `sync`, or one that changes state.json, such as `merge`. */
  command?: string;
  /** When the holder started, by its own clock, to tell it from a later process with its pid. */
  started?: number;
  at: number;
  /** The holder's machine (hostname), boot and pid namespace; see `Whereabouts`. */
  host?: string;
  boot?: string;
  ns?: string;
  /** Milliseconds since boot when the lock was taken, to age it on a clock nobody sets. */
  uptime?: number;
  /** Linux: the holder's start in clock ticks since boot, which setting the clock does not move. */
  ticks?: number;
  /** The file is empty: created, its holder not yet written (`create` without hard links). */
  empty?: boolean;
}

/**
 * How long an empty lock file is taken for one whose holder is still writing it. Without hard
 * links, `create` opens the file exclusively and then writes it, and a contender that reads it in
 * between must not break it.
 */
const EMPTY_GRACE_MS = 2000;

const optional = <T extends "string" | "number">(
  raw: Record<string, unknown>,
  key: string,
  type: T,
) => (typeof raw[key] === type ? (raw[key] as T extends "string" ? string : number) : undefined);

export function readLock(file: string): { text: string; holder: LockHolder } | undefined {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(file, "utf8");
    mtime = statSync(file).mtimeMs;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {}
  if (isRecord(raw) && typeof raw.pid === "number")
    return {
      text,
      holder: {
        pid: raw.pid,
        command: optional(raw, "command", "string"),
        started: optional(raw, "started", "number"),
        at: optional(raw, "at", "number") ?? mtime,
        host: optional(raw, "host", "string"),
        boot: optional(raw, "boot", "string"),
        ns: optional(raw, "ns", "string"),
        uptime: optional(raw, "uptime", "number"),
        ticks: optional(raw, "ticks", "number"),
      },
    };
  return {
    text,
    holder: { pid: typeof raw === "number" ? raw : 0, at: mtime, ...(text ? {} : { empty: true }) },
  };
}

/** What this process writes into the sync lock: who it is, and where. */
export function lockText(command = "sync"): string {
  const here = whereabouts();
  const ticks = processStartTicks();
  return JSON.stringify({
    pid: process.pid,
    command,
    started: Math.floor(performance.timeOrigin),
    at: Date.now(),
    ...here,
    ...(ticks === undefined ? {} : { ticks }),
  });
}

/** Where a lock's holder runs, when that is not here: another machine, or another container. */
function elsewhere(holder: LockHolder, here: Whereabouts): string | undefined {
  if (holder.host !== undefined && holder.host !== here.host) return `on ${holder.host}`;
  if (holder.ns !== undefined && here.ns !== undefined && holder.ns !== here.ns)
    return `in another container on ${holder.host ?? here.host}`;
  return undefined;
}

/**
 * Why a lock no longer guards a running sync, or undefined while it does. The holder is the
 * process with its pid that started no later than it did; one that started after it got the pid
 * when the holder was gone. A pid names a process only on its own machine, boot and pid
 * namespace, so a lock taken elsewhere (two containers or two machines sharing HOME) is held until
 * it is too old.
 */
export function staleBecause(holder: LockHolder): string | undefined {
  if (holder.empty && Math.abs(Date.now() - holder.at) < EMPTY_GRACE_MS) return undefined;
  const here = whereabouts();
  const { pid } = holder;
  const sameBoot = holder.boot !== undefined && bootsMatch(holder.boot, here.boot);
  // On one boot, the time since boot ages a lock whatever the clock does.
  const lockAge =
    sameBoot && holder.uptime !== undefined ? here.uptime - holder.uptime : Date.now() - holder.at;
  const away = elsewhere(holder, here);
  if (away)
    return lockAge > LOCK_MAX_AGE_MS
      ? `its sync ${away} took it more than two hours ago`
      : undefined;
  // A boot id differs only after a restart; a boot time elsewhere moves with the clock too.
  if (
    process.platform === "linux" &&
    holder.boot !== undefined &&
    !holder.boot.startsWith("t:") &&
    !sameBoot
  )
    return `the machine restarted since its sync (pid ${pid}) took it`;
  if (!(pid > 0) || pid === process.pid) return `it names no running sync`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!isErrno(error, "EPERM")) return `its sync (pid ${pid}) is gone`;
  }
  // Every lock since 0.0.1 says when its holder started; an older one can't tell a live sync from
  // another program, and none was ever released.
  if (holder.started === undefined && holder.ticks === undefined)
    return `an older fleetrc wrote it`;
  if (holder.ticks !== undefined && sameBoot) {
    const ticks = processStartTicks(pid);
    if (ticks !== undefined && ticks !== holder.ticks) return `pid ${pid} is now another program`;
  } else {
    // By the clock: a process that started after the holder did and after the lock was taken got
    // the pid later. Both, since a clock set forward moves where the OS places a start.
    const started = processStartedAt(pid);
    if (
      started !== undefined &&
      started > (holder.started ?? 0) + START_SLACK_MS &&
      started > holder.at + START_SLACK_MS
    )
      return `pid ${pid} is now another program`;
  }
  // The holder is this process, so the lock is no older than it: a clock set forward ages the lock
  // by the clock, never the process by its time since boot.
  const age = Math.min(lockAge, processAge(pid) ?? lockAge);
  if (age > LOCK_MAX_AGE_MS) return `it is more than two hours old`;
  return undefined;
}

/** Another sync, or a command that changes state.json, holds the lock and is still running. */
export class LockHeldError extends UserError {
  readonly pid: number;
  constructor(pid: number, where?: string, command = "sync", hint = "") {
    super(
      `${command === "sync" ? "another fleetrc sync" : `fleetrc ${command}`} is running (pid ${pid}${where ? ` ${where}` : ""})${hint}`,
    );
    this.pid = pid;
  }
}

const heldError = (holder: LockHolder) =>
  new LockHeldError(holder.pid, elsewhere(holder, whereabouts()), holder.command);

/** How `takeLock` judges a lock and, in tests, lets other contenders in between its steps. */
export interface LockOptions {
  /** Why a holder no longer guards a running sync, or undefined while it does. */
  staleBecause?: (holder: LockHolder) => string | undefined;
  /** Called after each step that reads or changes the lock's files. */
  step?: () => void;
  /** False creates the file as on a file system without hard links; for tests. */
  link?: boolean;
}

/**
 * Creates the lock `file` holding `mine`, breaking a stale lock first. Returns a note when it broke
 * one. Throws LockHeldError while a running sync holds it, or is breaking it.
 */
export function takeLock(
  file: string,
  mine: string,
  options: LockOptions = {},
): string | undefined {
  const judge = options.staleBecause ?? staleBecause;
  const step = options.step ?? (() => {});
  let note: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, mine, options.link)) {
      sweepBreakMarkers(file, judge);
      return note;
    }
    step();
    const lock = readLock(file);
    if (!lock) continue;
    const reason = judge(lock.holder);
    if (!reason) throw heldError(lock.holder);
    step();
    if (breakLock(file, lock.text, mine, judge, step))
      note = `removed a stale sync lock: ${reason}`;
  }
  throw new Error(`could not take the sync lock ${tildify(file)}`);
}

/** The marker that one breaker of the lock `file` holding `text` creates; named for that text. */
const breakMarker = (file: string, text: string) => `${file}.${sha256(text).slice(0, 16)}.break`;

/**
 * Deletes the lock `file` if it still holds `text`, the lock judged stale. Breakers of one lock go
 * one at a time: each first creates its marker, exclusively. A lock leaves its path only through its
 * breaker, or its own sync's release, so while the marker is held, the lock read again is still the
 * one judged stale, and a sync that took the path since is never removed. A marker left by a breaker
 * that died is broken the same way. Returns whether it deleted the lock.
 */
function breakLock(
  file: string,
  text: string,
  mine: string,
  judge: (holder: LockHolder) => string | undefined,
  step: () => void,
  depth = 0,
): boolean {
  const marker = breakMarker(file, text);
  if (!create(marker, mine)) {
    step();
    const breaker = readLock(marker);
    if (!breaker) return false;
    if (depth >= 3 || !judge(breaker.holder)) throw heldError(breaker.holder);
    breakLock(marker, breaker.text, mine, judge, step, depth + 1);
    return false;
  }
  try {
    step();
    if (readLock(file)?.text !== text) return false;
    rmSync(file, { force: true });
    step();
    return true;
  } finally {
    rmSync(marker, { force: true });
  }
}

/** Deletes break markers whose breaker is gone; the caller holds the lock, so none is in use for it. */
function sweepBreakMarkers(file: string, judge: (holder: LockHolder) => string | undefined) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".break")) continue;
    const marker = readLock(join(dir, name));
    if (marker && judge(marker.holder)) rmSync(join(dir, name), { force: true });
  }
}

/** Creates `file` with `text` only if it does not exist, never leaving it half written. */
export function create(file: string, text: string, link = true): boolean {
  // Unique across machines and containers that share this folder, where pids repeat.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text);
  try {
    if (!link) throw Object.assign(new Error("no hard links"), { code: "EPERM" });
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    // File systems without hard links: an exclusive create is atomic too.
    try {
      writeFileSync(file, text, { flag: "wx" });
      return true;
    } catch (inner) {
      if (isErrno(inner, "EEXIST")) return false;
      throw inner;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Whether a live sync, or a command that changes state.json, holds the sync lock now. */
export function syncRunning(): boolean {
  const lock = readLock(paths.lock());
  return lock !== undefined && staleBecause(lock.holder) === undefined;
}
