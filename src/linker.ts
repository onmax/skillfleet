import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  copyResolved,
  type DroppedLink,
  type Hashes,
  dict,
  hashDir,
  isErrno,
  isRecord,
  JsonFileError,
  lstat,
  readJson,
  recoverRenames,
  renameFolder,
  resolvedHashes,
  sameTree,
  writeJson,
} from "./fs.ts";
import { nameKey, segmentProblem } from "./names.ts";
import { tildify } from "./paths.ts";

export const MANIFEST_FILE = ".fleetrc-manifest.json";

/** A record read where `MANIFEST_FILE` is missing: the old name's, in a dry run of the move (migrate.ts). */
let fallbackRecord: string | undefined;
export const readRecordsFrom = (name: string) => {
  fallbackRecord = name;
};

export type LinkKind = "symlink" | "junction" | "copy";

export interface LinkRecord {
  target: string;
  kind: LinkKind;
  source: string;
  /** For copies: the files as written, to tell an edited copy from a stale one. */
  hashes?: Hashes;
  /** For copies: the folder links in the skill were followed into (see `DesiredLink`). */
  root?: string;
}

export interface TargetManifest {
  version: 1;
  links: Record<string, LinkRecord>;
}

export interface DesiredLink {
  name: string;
  target: string;
  source: string;
  /** The folder a copy follows links in the skill into: a working clone. Without it, anywhere. */
  root?: string;
}

export interface TargetReport {
  dir: string;
  created: string[];
  replaced: string[];
  removed: string[];
  /** Hand-made folders and links fleetrc did not create, left as they are. */
  foreign: string[];
  skipped?: string;
  /** A folder fleetrc linked into before and no longer does: only its old links are removed. */
  former?: boolean;
  warnings: string[];
  /** Links that could not be made, changed or removed, and folders that could not be written. */
  errors: string[];
}

/**
 * The links fleetrc made in `dir`. A record that does not parse reads as empty, with a
 * warning: links it can't prove it made are then never pruned, only re-recorded when they point
 * where fleetrc would link anyway.
 */
export function readTargetManifest(dir: string, warnings: string[] = []): TargetManifest {
  let raw: unknown;
  const file =
    fallbackRecord !== undefined &&
    !existsSync(join(dir, MANIFEST_FILE)) &&
    existsSync(join(dir, fallbackRecord))
      ? join(dir, fallbackRecord)
      : join(dir, MANIFEST_FILE);
  try {
    raw = readJson(file);
  } catch (error) {
    if (!(error instanceof JsonFileError)) throw error;
    warnings.push(
      `${tildify(join(dir, MANIFEST_FILE))} is not valid JSON, so fleetrc started a new one; links it no longer knows it made stay where they are`,
    );
    return { version: 1, links: dict() };
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.links))
    return { version: 1, links: dict() };
  const links = dict<LinkRecord>();
  for (const [name, record] of Object.entries(raw.links)) {
    if (!isRecord(record) || typeof record.target !== "string" || typeof record.source !== "string")
      continue;
    // A record is only trusted to name a folder directly inside this one.
    if (segmentProblem(name)) continue;
    const kind = record.kind === "junction" || record.kind === "copy" ? record.kind : "symlink";
    links[name] = {
      target: record.target,
      kind,
      source: record.source,
      ...(typeof record.root === "string" ? { root: record.root } : {}),
      ...(isRecord(record.hashes)
        ? {
            hashes: dict(Object.entries(record.hashes).map(([k, v]) => [k, String(v)])),
          }
        : {}),
    };
  }
  return { version: 1, links };
}

const stripLongPrefix = (path: string) => path.replace(/^\\\\\?\\/, "");

/** Where a link points, as an absolute path. */
export function linkTarget(path: string): string {
  return resolve(dirname(path), stripLongPrefix(readlinkSync(path)));
}

/**
 * The same folder, also when one path reaches it another way: a Windows 8.3 name
 * (C:\Users\RUNNER~1), a subst drive or a link. A path that does not exist compares as written.
 */
export function samePath(a: string, b: string): boolean {
  const same = (x: string, y: string) =>
    process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  if (same(resolve(a), resolve(b))) return true;
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return same(real(a), real(b));
}

/** Removes a link without touching what it points to. */
export function removeLink(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "EPERM", "EISDIR")) throw error;
    rmdirSync(path);
  }
}

/**
 * Links `path` to the `link.target` folder: a symlink, a junction on Windows, or a copy that holds
 * no links (see `copyResolved`), since Codex and Cursor skip a skill whose SKILL.md is a link.
 */
export function makeLink(
  link: Pick<DesiredLink, "target" | "root">,
  path: string,
  copy: boolean,
): { kind: LinkKind; dropped: DroppedLink[] } {
  mkdirSync(dirname(path), { recursive: true });
  if (!copy) {
    try {
      symlinkSync(link.target, path, process.platform === "win32" ? "junction" : "dir");
      return { kind: process.platform === "win32" ? "junction" : "symlink", dropped: [] };
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }
  return { kind: "copy", dropped: copyResolved(link.target, path, link.root) };
}

const DROPPED = {
  outside: "to a place outside the source",
  nothing: "to nothing",
  loop: "to a folder that holds it",
  again: "to a folder the copy holds already",
} as const;

/**
 * Makes each folder hold exactly one link per desired skill. Only links recorded in the folder's
 * manifest are replaced or pruned; hand-made folders and foreign links stay, with a warning.
 */
export function linkTargetDir(
  dir: string,
  desired: readonly DesiredLink[],
  { copy = false, dryRun = false }: { copy?: boolean; dryRun?: boolean } = {},
): TargetReport {
  const report: TargetReport = {
    dir,
    created: [],
    replaced: [],
    removed: [],
    foreign: [],
    warnings: [],
    errors: [],
  };
  const stat = lstat(dir);
  if (stat?.isSymbolicLink()) {
    report.skipped = `${tildify(dir)} is a link to ${tildify(linkTarget(dir))}; run \`fleetrc init\` to give it one link per skill`;
    return report;
  }
  if (stat && !stat.isDirectory()) {
    report.skipped = `${tildify(dir)} is not a folder`;
    return report;
  }
  try {
    if (!stat && !dryRun) mkdirSync(dir, { recursive: true });
    if (stat) accessSync(dir, constants.W_OK);
  } catch (error) {
    report.errors.push(`${tildify(dir)}: ${errorText(error)}; its skills were not linked`);
    return report;
  }
  const manifest = readTargetManifest(dir, report.warnings);
  try {
    if (stat && !dryRun) recoverRenames(dir, new Set(Object.keys(manifest.links)));
  } catch (error) {
    report.warnings.push(`${tildify(dir)}: ${errorText(error)}`);
  }
  const failed = (name: string, error: unknown) =>
    report.errors.push(`${tildify(join(dir, name))}: ${errorText(error)}`);
  const wanted = new Map<string, DesiredLink>();
  for (const link of desired) {
    const problem = segmentProblem(link.name);
    if (problem) report.warnings.push(`skipped the skill "${link.name}": its name ${problem}`);
    else wanted.set(link.name, link);
  }
  const write = (name: string, link: DesiredLink, replacing: boolean) => {
    const path = join(dir, name);
    if (!dryRun) {
      if (replacing) {
        const existing = lstat(path);
        if (existing?.isSymbolicLink()) removeLink(path);
        else rmSync(path, { recursive: true, force: true });
      }
      const { kind, dropped } = makeLink(link, path, copy);
      for (const left of dropped)
        report.warnings.push(
          `${tildify(join(link.target, left.path))} links ${DROPPED[left.reason]}, so the copy in ${tildify(path)} leaves it out`,
        );
      manifest.links[name] = {
        target: link.target,
        kind,
        source: link.source,
        ...(kind === "copy"
          ? { hashes: hashDir(path), ...(link.root ? { root: link.root } : {}) }
          : {}),
      };
    }
    (replacing ? report.replaced : report.created).push(name);
  };

  // A skill renamed only in case or Unicode form (alpha to Alpha) keeps its entry here, renamed.
  for (const link of wanted.values()) {
    if (manifest.links[link.name]) continue;
    const old = Object.keys(manifest.links).find(
      (name) => !wanted.has(name) && nameKey(name) === nameKey(link.name),
    );
    if (old === undefined) continue;
    try {
      if (!dryRun && lstat(join(dir, old)) && !renameFolder(join(dir, old), join(dir, link.name)))
        continue;
      manifest.links[link.name] = manifest.links[old]!;
      delete manifest.links[old];
    } catch (error) {
      failed(old, error);
    }
  }
  for (const link of wanted.values()) {
    try {
      linkOne(link);
    } catch (error) {
      failed(link.name, error);
    }
  }
  function linkOne(link: DesiredLink) {
    const path = join(dir, link.name);
    const current = lstat(path);
    const record = manifest.links[link.name];
    if (!current) {
      write(link.name, link, false);
      return;
    }
    if (current.isSymbolicLink()) {
      const pointsTo = linkTarget(path);
      if (samePath(pointsTo, link.target) && !copy) {
        if (!record && !dryRun)
          manifest.links[link.name] = {
            target: link.target,
            kind: process.platform === "win32" ? "junction" : "symlink",
            source: link.source,
          };
        if (record) record.source = link.source;
        return;
      }
      if (record && record.kind !== "copy") write(link.name, link, true);
      else {
        report.foreign.push(link.name);
        report.warnings.push(
          `${tildify(listedPath(dir, link.name))} links to ${tildify(pointsTo)}, not ${tildify(link.target)}; fleetrc did not make it, so it stays${sameFolderNote(dir, link.name)}`,
        );
      }
      return;
    }
    if (current.isDirectory() && record?.kind === "copy") {
      const now = hashDir(path);
      if (record.hashes && !sameTree(now, record.hashes)) {
        report.warnings.push(
          `${tildify(path)} is a copy with local edits, and ${link.name} changed too since it was copied, so it is not refreshed and other agents show ${link.name} without these edits; copy them into ${tildify(link.target)} and delete this copy to make the agents agree`,
        );
        return;
      }
      const fresh = resolvedHashes(link.target, link.root);
      if (
        !copy ||
        !sameTree(now, fresh) ||
        !samePath(record.target, link.target) ||
        record.root !== link.root
      )
        write(link.name, link, true);
      return;
    }
    report.foreign.push(link.name);
    report.warnings.push(
      `${tildify(listedPath(dir, link.name))} is a ${current.isDirectory() ? "folder" : "file"} fleetrc did not make, so it stays${sameFolderNote(dir, link.name)}`,
    );
  }

  for (const [name, record] of Object.entries(manifest.links)) {
    if (wanted.has(name)) continue;
    const path = join(dir, name);
    try {
      const current = lstat(path);
      if (current?.isSymbolicLink() && samePath(linkTarget(path), record.target)) {
        if (!dryRun) removeLink(path);
        report.removed.push(name);
      } else if (
        current?.isDirectory() &&
        record.kind === "copy" &&
        record.hashes &&
        sameTree(hashDir(path), record.hashes)
      ) {
        if (!dryRun) rmSync(path, { recursive: true, force: true });
        report.removed.push(name);
      } else if (current) {
        report.warnings.push(
          `${tildify(path)} changed since fleetrc made it, so it is not removed`,
        );
      }
      if (!dryRun) delete manifest.links[name];
    } catch (error) {
      // Still recorded, so the next run tries again.
      failed(name, error);
    }
  }
  try {
    if (!dryRun && existsSync(dir)) writeJson(join(dir, MANIFEST_FILE), manifest);
  } catch (error) {
    failed(MANIFEST_FILE, error);
  }
  return report;
}

/**
 * `dir/name` as the folder lists it. On a disk that ignores case or Unicode normalization (macOS,
 * Windows), the skill `Mine` finds the folder `mine`, and a message should name the folder.
 */
export function listedPath(dir: string, name: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return join(dir, name);
  }
  if (entries.includes(name)) return join(dir, name);
  return join(dir, entries.find((entry) => nameKey(entry) === nameKey(name)) ?? name);
}

/** Why a skill meets a folder with another name, when it does. */
function sameFolderNote(dir: string, name: string): string {
  const listed = basename(listedPath(dir, name));
  return listed === name
    ? ""
    : `; this disk keeps "${listed}" and the skill "${name}" in one folder, so ${name} is not linked there`;
}

/** `EACCES: permission denied`, without the paths Node appends: the message names them already. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return error instanceof Error && "code" in error ? text.split(", ")[0]! : text;
}
