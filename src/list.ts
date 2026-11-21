// `fleetrc list --json`: the skills linked on this machine, for programs built on fleetrc. It
// reads state.json alone, with no manifest and no network, so entry.ts runs it without the rest of
// the CLI. The shape is a contract: a later version only adds fields, and bumps `version` for any
// other change.
import { isRecord, readJsonOrNothing } from "./fs.ts";
import { paths } from "./paths.ts";
import { skillRecord } from "./skill-record.ts";

export interface ListedSkill {
  name: string;
  /** The manifest source it comes from. */
  source: string;
  /** The recorded skill folder. Its SKILL.md may be missing or unreadable. */
  dir: string;
  /** Sync-recorded ISO time; may advance for unchanged skills in a changed local or clone source. */
  changedAt: string;
}

export interface SkillList {
  version: 1;
  /** When a sync last added, removed or changed a skill; null before the first. */
  lastChange: string | null;
  /** Sorted by name. */
  skills: ListedSkill[];
}

/** The skills state.json records. A state.json that is missing or does not read lists none. */
export function skillList(): SkillList {
  const raw = readJsonOrNothing(paths.state());
  const state = isRecord(raw) && raw.version === 1 ? raw : {};
  const skills = isRecord(state.skills) ? state.skills : {};
  return {
    version: 1,
    lastChange: typeof state.lastChange === "string" ? state.lastChange : null,
    skills: Object.keys(skills)
      .sort()
      .flatMap((name) => {
        const record = skillRecord(skills[name]);
        if (!record) return [];
        const { source, dir, changedAt } = record;
        return [{ name, source, dir, changedAt }];
      }),
  };
}

/** Prints the list as one JSON document. */
export function printSkillList() {
  process.stdout.write(`${JSON.stringify(skillList(), null, 2)}\n`);
}
