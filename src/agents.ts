import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentInfo, detectAgents, getSupportedAgents } from "skills";
import { agentKindPaths, type FileKind } from "./kinds.ts";
import type { Manifest } from "./manifest.ts";

export interface AgentTarget {
  /** Global skills folder. */
  dir: string;
  /** Agents that read it. */
  agents: string[];
  /** Other agent folders that are links to this one, so they show the same skills. */
  aliases?: string[];
}

/** The folder every universal agent reads, and Codex's own. */
export const sharedSkillsDir = () => resolve(join(homedir(), ".agents", "skills"));

/** A universal agent that also reads ~/.agents/skills, so linking its own folder too shows each skill twice. */
const readsSharedDir = (agent: AgentInfo) =>
  agent.universal && !__SKILLS_OWN_GLOBAL_FOLDER__.includes(agent.id);

/**
 * The global skills folders of the manifest's agents, one entry per folder. `all` means every
 * agent `skills` detects on this machine. Codex reads `~/.agents/skills` (its folder in `skills`)
 * and the deprecated `~/.codex/skills`; fleetrc only writes the first.
 *
 * When ~/.agents/skills is a target, a universal agent (Gemini CLI, OpenCode, Copilot, Cursor, …)
 * reads its skills there and its own folder is left out, as `npx skills add -g` does: Gemini CLI
 * warns about a conflict for each skill it finds in both.
 */
export async function agentTargets(agents: Manifest["agents"]): Promise<AgentTarget[]> {
  const supported = getSupportedAgents();
  let chosen: readonly AgentInfo[];
  if (agents === "all") {
    chosen = (await detectAgents({ cwd: homedir(), config: { telemetry: false } })).agents;
  } else {
    // parseManifest has checked every id against this list.
    chosen = supported.filter((agent) => agents.includes(agent.id));
  }
  const shared = sharedSkillsDir();
  const sharing = chosen.some(
    (agent) => agent.globalSkillsDir && resolve(agent.globalSkillsDir) === shared,
  );
  const byDir = new Map<string, AgentTarget>();
  const folders = agentFolders();
  for (const agent of chosen) {
    if (!agent.globalSkillsDir) continue;
    const named = sharing && readsSharedDir(agent) ? shared : resolve(agent.globalSkillsDir);
    // A folder that links to another agent folder is that folder: link into it once.
    const dir = folders.get(named) ?? named;
    const target = byDir.get(dir) ?? { dir, agents: [] };
    target.agents.push(agent.id);
    if (dir !== named && !target.aliases?.includes(named))
      target.aliases = [...(target.aliases ?? []), named];
    byDir.set(dir, target);
  }
  return [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

const realKey = (path: string): string | undefined => {
  try {
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return undefined;
  }
};

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Agent folders (every supported agent's, and Codex's old one) that are links to another agent
 * folder, mapped to that folder as fleetrc names it. `~/.codex/skills -> ~/.agents/skills` or
 * `~/.claude/skills -> ~/.agents/skills` make two agents read one folder; a link to a folder no
 * agent owns (a dotfiles repository) is not in the map.
 */
export function agentFolders(): Map<string, string> {
  const all = new Set([sharedSkillsDir(), resolve(codexLegacyDir())]);
  for (const agent of getSupportedAgents())
    if (agent.globalSkillsDir) all.add(resolve(agent.globalSkillsDir));
  const realFolders = new Map<string, string>();
  for (const dir of all) {
    if (isLink(dir)) continue;
    const key = realKey(dir);
    if (key && !realFolders.has(key)) realFolders.set(key, dir);
  }
  const aliases = new Map<string, string>();
  for (const dir of all) {
    if (!isLink(dir)) continue;
    const key = realKey(dir);
    const folder = key ? realFolders.get(key) : undefined;
    if (folder) aliases.set(dir, folder);
  }
  return aliases;
}

/** The agent folder `dir` links to, when it is a link to another agent folder. */
export const aliasOf = (dir: string): string | undefined => agentFolders().get(resolve(dir));

/**
 * Global skills folders of supported agents that are not targets now. fleetrc may have linked
 * skills there before (an agent that left the manifest, or a universal agent's own folder before
 * ~/.agents/skills replaced it), so sync removes the links it recorded there.
 */
export function formerTargets(targets: readonly AgentTarget[]): string[] {
  const current = new Set(targets.map((target) => target.dir));
  const dirs = new Set<string>();
  for (const agent of getSupportedAgents())
    if (agent.globalSkillsDir) dirs.add(resolve(agent.globalSkillsDir));
  return [...dirs].filter((dir) => !current.has(dir)).sort();
}

/** Codex's deprecated folder, which fleetrc empties during `init` instead of writing to. */
export const codexLegacyDir = () =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills");

export interface AgentRow {
  id: string;
  name: string;
  /** Global skills folder, or undefined when the agent has none. */
  dir?: string;
  /** Its folder is in this home, so `"agents": "all"` includes it. */
  detected: boolean;
  /** The folder fleetrc links its skills into under the manifest's `agents`, when it does. */
  linkedInto?: string;
  /** Where fleetrc links each kind of file it gives this agent: instructions, subagents, commands. */
  kinds?: Partial<Record<FileKind, string>>;
}

/** Every agent id `skills` knows, for `fleetrc agents`. `agents` is the manifest's choice, when there is one. */
export async function agentRows(agents?: Manifest["agents"]): Promise<AgentRow[]> {
  const detected = new Set(
    (await detectAgents({ cwd: homedir(), config: { telemetry: false } })).agents.map(
      (agent) => agent.id,
    ),
  );
  const targets = agents ? await agentTargets(agents) : [];
  return getSupportedAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.globalSkillsDir ? { dir: resolve(agent.globalSkillsDir) } : {}),
    detected: detected.has(agent.id),
    ...(() => {
      const target = targets.find((candidate) => candidate.agents.includes(agent.id));
      return target ? { linkedInto: target.dir } : {};
    })(),
    ...(() => {
      const kinds = agentKindPaths(agent.id);
      return Object.keys(kinds).length > 0 ? { kinds } : {};
    })(),
  }));
}
