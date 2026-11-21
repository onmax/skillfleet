import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./errors.ts";
import { git, GitError, gitOut } from "./exec.ts";
import { isRecord, isRunning, readJsonOrNothing, sha256, writeJson } from "./fs.ts";
import { checkoutProblem, GIT_FOLDER, nameKey } from "./names.ts";

/** `owner/repo` and `github:owner/repo` become GitHub HTTPS URLs; anything else is a git URL already. */
export function gitUrl(spec: string): string {
  const github = spec.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (github && !spec.startsWith(".")) return `https://github.com/${github[1]}/${github[2]}.git`;
  const gitlab = spec.match(/^gitlab:(.+?)(?:\.git)?$/);
  if (gitlab) return `https://gitlab.com/${gitlab[1]}.git`;
  return spec;
}

/** A repository URL reduced to host and path, so its https, ssh and `owner/repo` forms compare equal. */
export const repoKey = (spec: string) =>
  gitUrl(spec)
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/(\.git)?\/?$/, "");

/** A ref that names a commit: a full id, or a prefix of one at least 7 hex digits long. */
export const isCommitRef = (ref: string) => /^[0-9a-f]{7,40}$/i.test(ref);

export const NO_GIT_REDIRECTS = ["-c", "http.followRedirects=false"];

/** A path left out of a checkout because another path takes its folder on macOS and Windows. */
export interface Collision {
  /** The path left out, up to the part that collides. */
  path: string;
  /** The path kept in its place. */
  kept: string;
}

/**
 * A path Windows can't write. Windows leaves it out of a checkout; Linux and macOS write it, as git
 * does in a working clone, and warn that the fleet's Windows machines lack it. A name that is git's
 * own folder somewhere (`.GIT`) is left out everywhere.
 */
export interface Refusal {
  /** The path, up to the part Windows refuses. */
  path: string;
  /** Why, as `checkoutProblem` says it. */
  problem: string;
}

export interface CachedClone {
  /** The files of `commit`, without a .git folder. */
  dir: string;
  commit: string;
  collisions: Collision[];
  refused: Refusal[];
  /** Paths of git submodules in the commit: their folders are empty, since nothing fetches them. */
  submodules: string[];
  /** The bare repository the cache keeps, which holds `commit` and the commits fetched before. */
  repo?: string;
  /** The commit written out before this fetch, when this fetch brought another. */
  previous?: string;
}

/**
 * Paths that macOS and Windows would write into one folder (names that differ by case, Unicode
 * normalization or trailing dots), other than the first of each, comparing names byte by byte. Every system leaves
 * the same ones out, so a fleet gets the same skills on Linux too.
 */
export function collisions(paths: readonly string[]): Collision[] {
  const parts = paths.map((path) => path.split("/").map((part) => Buffer.from(part)));
  const byFolder = (a: Buffer[], b: Buffer[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = Buffer.compare(a[i]!, b[i]!);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  };
  const owner = new Map<string, string>();
  const found = new Map<string, string>();
  for (const path of parts.sort(byFolder)) {
    let key = "";
    let actual = "";
    for (const part of path) {
      key += `/${nameKey(part.toString())}`;
      actual += `/${part.toString()}`;
      const kept = owner.get(key);
      if (kept === undefined) owner.set(key, actual);
      else if (kept !== actual) {
        found.set(actual.slice(1), kept.slice(1));
        break;
      }
    }
  }
  return [...found].map(([path, kept]) => ({ path, kept }));
}

/**
 * Paths that Windows can't write, or that would write into another folder there (an 8.3 short
 * name). Only Windows leaves them out (see `Refusal`).
 */
export function refusals(paths: readonly string[]): Refusal[] {
  const found = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const problem = checkoutProblem(parts[i]!);
      if (!problem) continue;
      found.set(parts.slice(0, i + 1).join("/"), problem);
      break;
    }
  }
  return [...found].map(([path, problem]) => ({ path, problem }));
}

const cloneKey = (url: string, ref?: string) => sha256(`${url}#${ref ?? ""}`).slice(0, 16);

export function hasCachedClone(url: string, ref: string | undefined, root: string): boolean {
  return markedCommit(join(root, `${cloneKey(url, ref)}.json`)) !== undefined;
}

/**
 * The files of `url` at `ref` (default branch when absent), kept under `root` between runs. The
 * `skills` package clones into a temporary folder on every call; this cache is what lets a timer
 * run cheap and lets `--offline` work.
 *
 * git keeps a bare repository, and each new commit is written out to a fresh folder from its tree,
 * never updated in place: a checkout that git later compares with the disk misreads names on
 * macOS, where the file system folds case and Unicode normalization, and `git clean` then deletes
 * files it took for untracked.
 */
export async function fetchClone(
  url: string,
  ref: string | undefined,
  root: string,
  {
    offline = false,
    check,
    cacheUrl = url,
  }: {
    offline?: boolean;
    cacheUrl?: string;
    /** Why `url` may not be fetched, asked in the cache's own repository right before each fetch. */
    check?: (url: string, cwd: string) => Promise<string | undefined>;
  } = {},
): Promise<CachedClone> {
  const key = cloneKey(cacheUrl, ref);
  const cache = {
    repo: join(root, `${key}.git`),
    tree: join(root, key),
    marker: join(root, `${key}.json`),
  };
  await recoverTree(cache, root, key);
  let written = readMarker(cache.marker, cache.tree);
  if (written && written.skipsRefused !== SKIPS_REFUSED && written.refused.length > 0)
    // Written when every system left out what Windows can't write: written again, which needs no
    // network, so this system gets those files too.
    try {
      written = { commit: written.commit, ...(await writeTree(cache, written.commit)) };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      written = undefined;
    }
  if (offline) {
    if (!written) throw new UserError(`${url} has never been fetched and --offline is set`);
    return { dir: cache.tree, ...written };
  }
  // A commit never changes: once written out, a ref that names one needs no fetch.
  if (written && ref && isCommitRef(ref) && written.commit.startsWith(ref.toLowerCase()))
    return { dir: cache.tree, ...written };
  for (let attempt = 0; ; attempt++) {
    const fresh = !(existsSync(cache.repo) && (await usable(cache.repo)));
    if (fresh) {
      rmSync(cache.repo, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      // No template: its sample hooks are the deepest files, and nothing here runs hooks.
      await git(["init", "--quiet", "--bare", "--template=", "--", cache.repo]);
    }
    let commit: string;
    try {
      const problem = await check?.(url, cache.repo);
      if (problem) throw new UserError(problem);
      commit = await fetchCommit(url, ref, cache.repo, check ? NO_GIT_REDIRECTS : []);
    } catch (error) {
      // The network or the remote: a cache with a commit stays for --offline and later runs.
      if (fresh) rmSync(cache.repo, { recursive: true, force: true });
      throw error;
    }
    try {
      if (written?.commit === commit) return { dir: cache.tree, ...written, repo: cache.repo };
      return {
        dir: cache.tree,
        commit,
        ...(await writeTree(cache, commit)),
        repo: cache.repo,
        ...(written ? { previous: written.commit } : {}),
      };
    } catch (error) {
      // The fetch worked, so the cache itself is broken: start it over, once.
      if (attempt > 0 || !(error instanceof GitError) || error.result.code === null) throw error;
      for (const path of Object.values(cache)) rmSync(path, { recursive: true, force: true });
      written = undefined;
    }
  }
}

/** Whether this system leaves out the paths Windows can't write (`Refusal`). */
const SKIPS_REFUSED = process.platform === "win32";

type Marker = Omit<CachedClone, "dir"> & { skipsRefused?: boolean };

function readMarker(marker: string, tree: string): Marker | undefined {
  if (!existsSync(tree)) return undefined;
  return markedCommit(marker);
}

function markedCommit(marker: string): Marker | undefined {
  const raw = readJsonOrNothing(marker);
  if (!isRecord(raw) || typeof raw.commit !== "string" || !Array.isArray(raw.collisions))
    return undefined;
  return {
    commit: raw.commit,
    collisions: raw.collisions as Collision[],
    refused: Array.isArray(raw.refused) ? (raw.refused as Refusal[]) : [],
    submodules: Array.isArray(raw.submodules) ? (raw.submodules as string[]) : [],
    // Trees written before the field left them out on every system.
    skipsRefused: typeof raw.skipsRefused === "boolean" ? raw.skipsRefused : true,
  };
}

/**
 * Finishes what a killed `writeTree` left: its folders beside the tree are deleted, or the old
 * tree goes back when it was moved aside and the new one never arrived. A tree that is missing
 * altogether is written again from the repository, which needs no network, so `--offline` works.
 */
async function recoverTree(cache: CacheFiles, root: string, key: string) {
  if (!existsSync(root)) return;
  // The publication journal precedes both renames. With no temp tree left, the
  // new tree arrived: finish its metadata before considering the old tree garbage.
  for (const name of readdirSync(root)) {
    const match = new RegExp(`^${key}\\.(\\d+)\\.pending$`).exec(name);
    if (!match || isRunning(Number(match[1]))) continue;
    const pending = join(root, name);
    const temp = join(root, `${key}.${match[1]}.tmp`);
    if (!existsSync(temp) && existsSync(cache.tree)) {
      const metadata = markedCommit(pending);
      if (metadata) writeJson(cache.marker, metadata);
    }
    rmSync(pending, { force: true });
  }
  const pattern = new RegExp(`^${key}\\.(\\d+)\\.(tmp|old)$`);
  let busy = false;
  for (const name of readdirSync(root)) {
    const match = pattern.exec(name);
    if (!match) continue;
    if (isRunning(Number(match[1]))) {
      // A process between moving the tree aside and renaming its new one in finishes it itself;
      // one still writing its .tmp finds the tree written here and replaces it as usual.
      if (match[2] === "old") busy = true;
    } else if (match[2] === "old" && !existsSync(cache.tree))
      renameSync(join(root, name), cache.tree);
    else rmSync(join(root, name), { recursive: true, force: true });
  }
  if (busy || existsSync(cache.tree) || !existsSync(cache.repo)) return;
  const marked = markedCommit(cache.marker);
  if (!marked || !(await usable(cache.repo))) return;
  try {
    await writeTree(cache, marked.commit);
  } catch (error) {
    // The commit is not in the repository after all: the next fetch writes the tree.
    if (!(error instanceof GitError)) throw error;
  }
}

/** Fetches `ref` and returns its commit. A ref that is no branch or tag is read as a commit. */
async function fetchCommit(
  url: string,
  ref: string | undefined,
  repo: string,
  config: readonly string[],
): Promise<string> {
  const args = [
    ...config,
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "--no-tags",
    "--",
    url,
    ref ?? "HEAD",
  ];
  const fetched = await git(args, { cwd: repo, allowFail: true, timeoutMs: 600_000 });
  if (fetched.code === 0) {
    const commit = await gitOut(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], repo);
    // A ref of its own, so the next fetch sends only what changed.
    await git(["update-ref", "refs/fleetrc/fetched", commit], { cwd: repo });
    return commit;
  }
  // A full commit id is fetched as it is; a remote gives no way to look up a shorter one, so it
  // is found in the history of every branch and tag.
  if (fetched.code === null || !ref || !isCommitRef(ref) || ref.length === 40)
    throw new GitError(args, fetched);
  const shallow = (await gitOut(["rev-parse", "--is-shallow-repository"], repo)) === "true";
  await git(
    [
      ...config,
      "fetch",
      "--quiet",
      "--no-tags",
      ...(shallow ? ["--unshallow"] : []),
      "--",
      url,
      "+refs/heads/*:refs/fleetrc/heads/*",
      "+refs/tags/*:refs/fleetrc/tags/*",
    ],
    { cwd: repo, timeoutMs: 600_000 },
  );
  const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repo,
    allowFail: true,
  });
  if (found.code !== 0)
    throw new Error(
      `${url} has no branch, tag or commit ${ref}${found.stderr ? `: ${found.stderr.trim()}` : ""}`,
    );
  return found.stdout.trim();
}

interface CacheFiles {
  repo: string;
  tree: string;
  marker: string;
}

/**
 * Writes the files of `commit` to a new folder that then replaces `cache.tree`, leaving out the
 * paths that would share a folder on macOS and Windows, and on Windows those it can't write.
 * Returns those, and the submodules.
 */
async function writeTree(
  cache: CacheFiles,
  commit: string,
): Promise<Pick<CachedClone, "collisions" | "refused" | "submodules">> {
  const entries = (await gitOut(["ls-tree", "-r", "-z", "--full-tree", commit], cache.repo))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { line, mode: line.slice(0, line.indexOf(" ")), path: line.slice(tab + 1) };
    });
  const refused = refusals(entries.map((entry) => entry.path));
  const within = (paths: readonly { path: string }[]) => (file: string) =>
    paths.some(({ path }) => file === path || file.startsWith(`${path}/`));
  const skipped = refused.filter(({ problem }) => SKIPS_REFUSED || problem === GIT_FOLDER);
  const writable = entries.filter((entry) => !within(skipped)(entry.path));
  const left = collisions(writable.map((entry) => entry.path));
  const kept = writable.filter((entry) => !within(left)(entry.path));
  const submodules = entries.filter((entry) => entry.mode === "160000").map((entry) => entry.path);
  const temp = `${cache.tree}.${process.pid}.tmp`;
  const old = `${cache.tree}.${process.pid}.old`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    // Names go to and from git byte for byte, compared with their case.
    const at = [
      "-c",
      "core.precomposeunicode=false",
      "-c",
      "core.ignorecase=false",
      `--work-tree=${temp}`,
    ];
    // The index gets only the paths written out: git refuses a whole tree on Windows when one of
    // its paths is one Windows can't write.
    await git([...at, "read-tree", "--empty"], { cwd: cache.repo });
    await git([...at, "update-index", "-z", "--index-info"], {
      cwd: cache.repo,
      input: kept.map((entry) => `${entry.line}\0`).join(""),
    });
    await git([...at, "checkout-index", "--all", "--force"], { cwd: cache.repo });
    const metadata = { commit, collisions: left, refused, submodules, skipsRefused: SKIPS_REFUSED };
    writeJson(`${cache.tree}.${process.pid}.pending`, metadata);
    // Moved aside, not deleted, so a kill here leaves a whole tree for `recoverTree`.
    const replaced = existsSync(cache.tree);
    if (replaced) renameSync(cache.tree, old);
    renameSync(temp, cache.tree);
    writeJson(cache.marker, metadata);
    rmSync(`${cache.tree}.${process.pid}.pending`, { force: true });
    if (replaced) rmSync(old, { recursive: true, force: true });
  } finally {
    // Keep an unpublished temp beside its journal so recovery can distinguish rollback.
    if (!existsSync(`${cache.tree}.${process.pid}.pending`))
      rmSync(temp, { recursive: true, force: true });
  }
  return { collisions: left, refused, submodules };
}

/**
 * The cache is a repository of its own (git does not climb from a broken one to a parent
 * repository, such as a HOME kept in git). Throws when git can't run.
 */
async function usable(repo: string): Promise<boolean> {
  const run = await git(["rev-parse", "--absolute-git-dir"], { cwd: repo, allowFail: true });
  if (run.code === null && !run.timedOut) throw new GitError(["rev-parse"], run);
  const gitDir = run.code === 0 ? run.stdout.trim() : undefined;
  if (gitDir === undefined) return false;
  // The native realpath expands Windows 8.3 names (RUNNER~1), which git prints in full.
  const real = (path: string) => {
    const resolved = realpathSync.native(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return real(gitDir) === real(repo);
}

/** Splits `<repo>//<path>` (as in `github:org/repo//team.json`) into the repository and the file. */
export function splitRepoPath(spec: string): { repo: string; path: string } | undefined {
  const scheme = spec.indexOf("://");
  const from = scheme >= 0 ? scheme + 3 : 0;
  const at = spec.indexOf("//", from);
  if (at < 0) return undefined;
  return { repo: spec.slice(0, at), path: spec.slice(at + 2) };
}
