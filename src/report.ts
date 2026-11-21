import type { TargetReport } from "./linker.ts";
import { tildify } from "./paths.ts";
import type { SourceResult } from "./sources.ts";

export interface HookRun {
  name: string;
  matched: string[];
  code: number | null;
  output: string;
}

export interface Report {
  version: 1;
  host: string;
  fleetrc: string;
  manifest: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  offline: boolean;
  ok: boolean;
  sources: Omit<SourceResult, "skills">[];
  skills: {
    total: number;
    names: string[];
    added: string[];
    removed: string[];
    updated: string[];
  };
  shadowed: { skill: string; winner: string; loser: string }[];
  /** Skills whose name changed upstream only in case or Unicode form: the same skill, renamed. */
  renamed: { from: string; to: string }[];
  edited: { source: string; skill: string; files: string[] }[];
  held: { source: string; reason: string; files: string[] }[];
  /**
   * Updates not applied: held for review, held because the copy is edited, or made to a skill
   * you forked (said by the sync that first sees them; `status` keeps saying it).
   */
  pending: {
    source: string;
    skill: string;
    reason: "review" | "edited" | "fork";
    files: string[];
  }[];
  targets: TargetReport[];
  hooks: HookRun[];
  warnings: string[];
  errors: string[];
}

const list = (names: readonly string[]) => names.join(", ");

/** The human summary `sync` prints. */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  const verb = report.dryRun ? "would link" : "linked";
  const folders = report.targets.filter((target) => !target.skipped && !target.former).length;
  lines.push(
    `fleetrc: ${verb} ${report.skills.total} skills into ${folders} folder${folders === 1 ? "" : "s"}${report.offline ? " (offline)" : ""}`,
  );
  if (report.skills.added.length) lines.push(`  + added: ${list(report.skills.added)}`);
  if (report.skills.updated.length) lines.push(`  ~ updated: ${list(report.skills.updated)}`);
  if (report.skills.removed.length) lines.push(`  - removed: ${list(report.skills.removed)}`);
  for (const renamed of report.renamed) lines.push(`  renamed ${renamed.from} -> ${renamed.to}`);
  for (const source of report.sources) {
    if (source.status === "updated" && source.from && source.to && source.from !== source.to)
      lines.push(`  ${source.id}: ${source.from.slice(0, 7)} -> ${source.to.slice(0, 7)}`);
  }
  for (const held of report.held)
    lines.push(
      `  held ${held.source}: ${held.reason}${held.files.length ? `: ${list(held.files)}` : ""}`,
    );
  const review = new Map<string, string[]>();
  for (const pending of report.pending) {
    if (pending.reason !== "review") continue;
    review.set(pending.source, [...(review.get(pending.source) ?? []), pending.skill]);
  }
  for (const [source, skills] of review)
    lines.push(
      `  review ${source}: updates for ${list(skills)}; see \`fleetrc diff <skill>\`, apply with \`fleetrc update ${source}\``,
    );
  for (const pending of report.pending)
    if (pending.reason === "fork")
      lines.push(
        `  fork ${pending.skill}: ${pending.source} changed it since you forked it (${list(pending.files)}); see \`fleetrc diff ${pending.skill}\`, merge with \`fleetrc merge ${pending.skill}\``,
      );
  for (const edited of report.edited) {
    const behind = report.pending.some(
      (pending) => pending.skill === edited.skill && pending.reason === "edited",
    );
    lines.push(
      `  edited ${edited.skill} (${edited.source}): ${list(edited.files)}${behind ? "; upstream changed too, see `fleetrc diff " + edited.skill + "` or `fleetrc merge " + edited.skill + "`" : ""}`,
    );
  }
  for (const shadow of report.shadowed)
    lines.push(`  shadowed: ${shadow.skill} from ${shadow.loser} (${shadow.winner} wins)`);
  for (const target of report.targets) {
    if (target.skipped) lines.push(`  skipped ${target.skipped}`);
    const changes = [
      target.created.length && `${target.created.length} new`,
      target.replaced.length && `${target.replaced.length} relinked`,
      target.removed.length && `${target.removed.length} removed`,
    ].filter(Boolean);
    if (changes.length) lines.push(`  ${tildify(target.dir)}: ${changes.join(", ")}`);
  }
  for (const hook of report.hooks) {
    lines.push(`  hook ${hook.name}: ${hook.code === 0 ? "ran" : `failed (exit ${hook.code})`}`);
    for (const line of hook.output.trim().split("\n").filter(Boolean).slice(-5))
      lines.push(`    ${line}`);
  }
  for (const warning of new Set([
    ...report.warnings,
    ...report.targets.flatMap((target) => target.warnings),
  ]))
    lines.push(`  warning: ${warning}`);
  for (const error of report.errors) lines.push(`  error: ${error}`);
  return lines.join("\n");
}
