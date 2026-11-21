import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output went past `maxOutput`, so only its end was kept. */
  truncated: boolean;
  /** Why the command could not start, such as `ENOENT` when it is not installed. */
  spawnError?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Writes `input` and keeps stdin open until the command exits, so it can tell when we are gone. */
  holdStdin?: boolean;
  timeoutMs?: number;
  shell?: boolean;
  /** Characters of stdout and of stderr to keep, from the end. Defaults to 1 MiB each. */
  maxOutput?: number;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/** Keeps the last `max` characters of a stream without holding all of it. */
class Tail {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(chunk: string) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.max * 2) this.trim();
  }
  private trim() {
    const text = this.chunks.join("");
    if (text.length > this.max) {
      this.truncated = true;
      this.chunks = [text.slice(-this.max)];
      this.size = this.max;
    }
  }
  toString() {
    this.trim();
    return this.chunks.join("");
  }
}

// Shell commands (hooks, report.run) run in their own process group on POSIX, so a timeout can kill
// everything they started. Those groups no longer get the terminal's Ctrl-C, so it is passed on.
// Other commands stay in ours: a new session would cut git's ssh off from the terminal it prompts on.
const groups = new Set<number>();
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
function forward(signal: NodeJS.Signals) {
  for (const pid of groups) killGroup(pid, signal);
  for (const name of FORWARDED) process.removeListener(name, forward);
  process.kill(process.pid, signal);
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** Every command running now, so a sync stopped for taking too long stops them too. */
const running = new Set<ChildProcess>();

/** Kills every command `exec` started that is still running, and what they started. */
export function stopAll() {
  for (const child of running) killTree(child);
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (groups.has(child.pid)) killGroup(child.pid, "SIGKILL");
  else if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => {});
    child.kill("SIGKILL");
  } else child.kill("SIGKILL");
}

/**
 * Runs a command to completion and collects the end of its output. Never throws for a non-zero
 * exit. On timeout the command and every process it started are killed, and the result comes
 * back once the command exits, even if something it started still holds its output open.
 */
export function exec(command: string, args: readonly string[], options: ExecOptions = {}) {
  return new Promise<ExecResult>((resolve) => {
    const group = process.platform !== "win32" && options.shell === true;
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      detached: group,
    };
    const child = spawn(command, args, spawnOptions);
    running.add(child);
    const max = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
    const stdout = new Tail(max);
    const stderr = new Tail(max);
    let timedOut = false;
    let done = false;
    if (group && child.pid !== undefined) {
      if (groups.size === 0) for (const name of FORWARDED) process.on(name, forward);
      groups.add(child.pid);
    }
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      running.delete(child);
      clearTimeout(timer);
      if (child.pid !== undefined && groups.delete(child.pid) && groups.size === 0)
        for (const name of FORWARDED) process.removeListener(name, forward);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const err = stderr.toString();
      resolve({
        code,
        stdout: stdout.toString(),
        stderr: error && !err ? error.message : err,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        spawnError: (error as NodeJS.ErrnoException | undefined)?.code,
      });
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    // After a timeout, output pipes held by orphaned grandchildren must not keep us waiting.
    child.on("exit", (code) => {
      if (timedOut) finish(code);
    });
    child.stdin?.on("error", () => {});
    if (options.holdStdin) child.stdin?.write(options.input ?? "");
    else child.stdin?.end(options.input ?? "");
  });
}

const GIT_SLOW = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" };

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: ExecResult;
  constructor(args: readonly string[], result: ExecResult) {
    super(
      result.spawnError === "ENOENT"
        ? "git is not installed, or not on PATH; install git to fetch this source"
        : result.timedOut
          ? `git ${args.join(" ")} did not finish in time, so it was stopped${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`
          : `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
    this.args = args;
    this.result = result;
  }
}

/** Runs git without prompts; throws GitError on a non-zero exit unless `allowFail`. */
export async function git(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; allowFail?: boolean; input?: string } = {},
): Promise<ExecResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "GIT_CONFIG") delete env[key];
  // Git for Windows writes no path past 260 characters without core.longpaths, and fleetrc's
  // cache sits deep under HOME. Other systems ignore it.
  // A remote that stops sending: under 1 KB/s for a minute ends the transfer, over http(s). Other
  // transports, such as ssh, end at the timeout.
  const result = await exec("git", ["-c", "core.longpaths=true", ...GIT_SLOW, ...args], {
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeoutMs ?? 120_000,
    env,
    // File lists are parsed whole; a cut one would be wrong, not just short.
    maxOutput: Number.POSITIVE_INFINITY,
  });
  if (result.code !== 0 && !options.allowFail) throw new GitError(args, result);
  return result;
}

export const gitOut = async (args: readonly string[], cwd?: string) =>
  (await git(args, { cwd })).stdout.trim();
