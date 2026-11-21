import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exec } from "./exec.ts";
import { isRecord, readJsonOrNothing, sha256, writeJson } from "./fs.ts";
import { create } from "./lock.ts";
import { nameKey } from "./names.ts";
import { claudeHome, paths } from "./paths.ts";
import type { State } from "./state.ts";

/**
 * A running agent that reads its skill list when its session starts, so it needs a restart to see
 * a skill that arrived later. Codex does. Claude Code loads skills added mid-session on the next
 * turn, so its sessions are not listed.
 */
export interface AgentProcess {
  pid: number;
  agent: "codex";
  startedAt: Date;
  command: string;
}

/** Which agent a command line runs, judged by the program and, for node/bun, its script. */
export function agentOf(args: string[]): AgentProcess["agent"] | undefined {
  const name = (token: string | undefined) =>
    basename(token ?? "")
      .replace(/\.(exe|cmd|js|mjs|cjs)$/i, "")
      .toLowerCase();
  const [program, script] = args;
  const candidates = ["node", "bun"].includes(name(program)) ? [script] : [program];
  for (const token of candidates) {
    if (!token) continue;
    if (name(token) === "codex" || token.includes("@openai/codex")) return "codex";
  }
  return undefined;
}

/** This user's running Codex processes, with their start times. */
export async function agentProcesses(): Promise<AgentProcess[]> {
  if (process.platform === "win32") {
    const script =
      // Asking WMI for these executables only keeps the query to a few seconds. Other users'
      // processes run in other logon sessions.
      "$session = (Get-Process -Id $PID).SessionId; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe' OR Name='codex.exe'\" | Where-Object { $_.CommandLine -and $_.SessionId -eq $session } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; start = $_.CreationDate.ToUniversalTime().ToString('o'); cmd = $_.CommandLine } }) | ConvertTo-Json -Compress";
    const out = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeoutMs: 60_000, maxOutput: 64 * 1024 * 1024 },
    );
    if (out.code !== 0 || !out.stdout.trim()) return [];
    const parsed: unknown = JSON.parse(out.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row.cmd !== "string" || typeof row.start !== "string") return [];
      const args = row.cmd.match(/"[^"]*"|\S+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
      const agent = agentOf(args);
      return agent
        ? [{ pid: Number(row.pid), agent, startedAt: new Date(row.start), command: row.cmd }]
        : [];
    });
  }
  const uid = process.getuid?.();
  const out = await exec("ps", ["-A", "-ww", "-o", "pid=,uid=,lstart=,args="], {
    env: { ...process.env, LC_ALL: "C" },
    timeoutMs: 20_000,
    maxOutput: 64 * 1024 * 1024,
  });
  if (out.code !== 0) return [];
  return out.stdout.split("\n").flatMap((line) => {
    // "  123  1000 Mon Nov 16 10:00:00 2026 /usr/bin/codex resume"
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+([\d:]+)\s+(\d{4})\s+(.*)$/);
    if (!match) return [];
    const [, pid, owner, month, day, time, year, command] = match;
    // Another user's session does not read this user's skills.
    if (uid !== undefined && Number(owner) !== uid) return [];
    const args = command!.split(/\s+/);
    const agent = agentOf(args);
    if (!agent || Number(pid) === process.pid) return [];
    return [
      {
        pid: Number(pid),
        agent,
        startedAt: new Date(`${month} ${day} ${year} ${time}`),
        command: command!,
      },
    ];
  });
}

/** Sessions started before the last skill change, which need a restart to load it. */
export async function staleSessions(state: State): Promise<AgentProcess[]> {
  if (!state.lastChange) return [];
  // ps reports start times to the second.
  const changed = new Date(state.lastChange).getTime() - 1000;
  return (await agentProcesses()).filter((proc) => proc.startedAt.getTime() < changed);
}

interface SessionRecord {
  startedAt: string;
  announced: string[];
  presentAtStart?: string[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The session id an agent's hook input names, or "unknown". */
function sessionOf(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (isRecord(parsed) && typeof parsed.session_id === "string") return parsed.session_id;
  } catch {}
  return "unknown";
}

/**
 * A session's own record, `sessions/<id>.json`: one file each, so sessions that start together
 * never write over each other's record. An id that is not a plain name is hashed.
 */
function recordFile(id: string): string {
  const name = /^[\w-]{1,100}$/.test(id) ? id : sha256(id).slice(0, 32);
  return join(paths.sessions(), `${name}.json`);
}

function readRecord(file: string): SessionRecord | undefined {
  const raw = readJsonOrNothing(file);
  if (!isRecord(raw) || typeof raw.startedAt !== "string" || !Array.isArray(raw.announced))
    return undefined;
  return {
    startedAt: raw.startedAt,
    announced: raw.announced.filter((name): name is string => typeof name === "string"),
    ...(Array.isArray(raw.presentAtStart)
      ? {
          presentAtStart: raw.presentAtStart.filter(
            (name): name is string => typeof name === "string",
          ),
        }
      : {}),
  };
}

/** Creates a session's record, unless one is there: exclusively, so a record is never replaced. */
function startRecord(file: string, now: Date, presentAtStart?: string[]) {
  mkdirSync(dirname(file), { recursive: true });
  const record = { startedAt: now.toISOString(), announced: [], presentAtStart };
  create(file, `${JSON.stringify(record)}\n`);
}

function claudeSkillsAtStart(): string[] {
  const dir = join(claudeHome(), "skills");
  try {
    return readdirSync(dir)
      .filter((name) => existsSync(join(dir, name, "SKILL.md")))
      .map(nameKey);
  } catch {
    return [];
  }
}

/** Deletes records untouched for a week, and sessions.json, where older versions kept them all. */
function pruneRecords(now: Date) {
  rmSync(join(dirname(paths.sessions()), "sessions.json"), { force: true });
  for (const name of readdirSync(paths.sessions())) {
    const file = join(paths.sessions(), name);
    try {
      if (now.getTime() - statSync(file).mtimeMs > WEEK_MS) rmSync(file, { force: true });
    } catch {}
  }
}

/**
 * Claude Code's SessionStart hook: records when the session started, so a skill linked before its
 * first prompt (by the sync this hook starts) is named on that prompt. A session resumed or
 * compacted keeps its record.
 */
export function sessionStarted(input: string, now = new Date()) {
  const file = recordFile(sessionOf(input));
  mkdirSync(dirname(file), { recursive: true });
  // Pruned first: a session resumed after a week would otherwise keep its old record only until
  // the prune deleted it, and start its first prompt without one.
  try {
    pruneRecords(now);
  } catch {
    // Cleanup only: a record that can't be pruned must not stop this one being made.
  }
  if (!existsSync(file)) startRecord(file, now, claudeSkillsAtStart());
}

/**
 * Claude Code's UserPromptSubmit hook (hook.ts): the skills that arrived after the session started,
 * once each. Claude Code adds the output to the prompt's context and has already loaded those
 * skills, so the text says to use them, not to read their files. The session's record is written
 * only when a skill is named.
 */
export function promptHook(
  input: string,
  state: { skills: Record<string, { addedAt: string }> },
  now = new Date(),
): string {
  const file = recordFile(sessionOf(input));
  let session = readRecord(file);
  if (!session) {
    startRecord(file, now);
    session = readRecord(file) ?? { startedAt: now.toISOString(), announced: [] };
  }
  const { startedAt, announced, presentAtStart } = session;
  const present = new Set(presentAtStart);
  const fresh = Object.entries(state.skills)
    .filter(
      ([name, record]) =>
        record.addedAt > startedAt && !present.has(nameKey(name)) && !announced.includes(name),
    )
    .map(([name]) => name);
  if (fresh.length > 0) writeJson(file, { ...session, announced: [...announced, ...fresh] });
  if (fresh.length === 0) return "";
  const one = fresh.length === 1;
  return `fleetrc: ${one ? "a new skill arrived" : `${fresh.length} new skills arrived`} after this session started and ${one ? "is" : "are"} available now: ${fresh.join(", ")}. Use ${one ? "it" : "them"} like any other skill, with the Skill tool.`;
}
