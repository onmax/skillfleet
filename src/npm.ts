import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord } from "./fs.ts";
import { extractStripped, gunzipCapped, readTgz } from "./tar.ts";

/** `@scope/name@1.2.3` → name and version or dist-tag (default `latest`). */
export function parseNpmSpec(spec: string): { name: string; want: string } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at < 0
    ? { name: spec, want: "latest" }
    : { name: spec.slice(0, at), want: spec.slice(at + 1) || "latest" };
}

export const registryUrl = (registry: string | undefined) =>
  (
    registry ??
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");

function headers(sendToken: boolean): Record<string, string> {
  const token = process.env.NPM_TOKEN;
  return token && sendToken ? { authorization: `Bearer ${token}` } : {};
}

export const urlOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** npm package names: lowercase URL-safe characters, optionally under one `@scope/`. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/** One path segment that looks like a version: semver and the looser versions old registries hold. */
const VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+_-]{0,126}[0-9A-Za-z])?$/;

/** Largest tarball fleetrc downloads, and the most it unpacks to. */
const TARBALL_LIMIT = 100 * 1024 * 1024;

async function readCapped(
  response: Response,
  label: string,
  onChunk: () => void = () => {},
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > TARBALL_LIMIT)
    throw new Error(`${label}: the tarball is too large (${declared} bytes)`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  onChunk();
  for await (const chunk of response.body ?? []) {
    onChunk();
    size += chunk.byteLength;
    if (size > TARBALL_LIMIT) throw new Error(`${label}: the tarball is larger than 100 MB`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Statuses whose response has no body, which `new Response` refuses one for. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * How long a download waits for the server to answer, or for its next bytes.
 * FLEETRC_FETCH_WAIT_MS shortens it, for tests.
 */
const waitMs = (() => {
  const set = Number(process.env.FLEETRC_FETCH_WAIT_MS);
  return set > 0 && set < 30_000 ? set : 30_000;
})();

/**
 * How long a download may wait: for the server to answer, for its next bytes, in all, and for all
 * the downloads of one source. A server that stops answering would otherwise hold the sync, and
 * its lock, forever.
 */
export const FETCH_LIMITS = {
  answerMs: waitMs,
  idleMs: waitMs,
  totalMs: 5 * 60_000,
  sourceMs: 15 * 60_000,
  /** Downloads of one source at a time: `skills` starts every file of a skill at once. */
  concurrent: 8,
};

/**
 * What a source's downloads may hold: `withCappedFetch` refuses a download it gives a reason for.
 * The budget reports its own refusals; they do not go into `refused`.
 */
export interface FetchBudget {
  /** Why `url` is not downloaded at all. */
  before(url: string): string | undefined;
  /** Why the body of `url` is refused; `unpacked` is a gzip body, unpacked. */
  after(url: string, body: Uint8Array, unpacked: Buffer | undefined): string | undefined;
}

/**
 * Runs `work` with every fetch it makes read whole under the tarball limit, and a gzip body
 * unpacked once under the unpack limit, before `work` sees a byte. Each fetch is stopped when the
 * server takes longer than `FETCH_LIMITS` allows, and so is every fetch once `work` has spent
 * `sourceMs`. The `skills` package downloads and unpacks index archives without a limit or a
 * timeout, and drops the skill when its fetch fails, so why a download was refused goes into
 * `refused`. At most `FETCH_LIMITS.concurrent` downloads run at once, and `budget` may refuse one
 * before it starts or once its body is in.
 */
export async function withCappedFetch<T>(
  work: () => Promise<T>,
  refused: string[],
  budget?: FetchBudget,
): Promise<T> {
  const original = globalThis.fetch;
  const source = AbortSignal.timeout(FETCH_LIMITS.sourceMs);
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running < FETCH_LIMITS.concurrent) running++;
    else await new Promise<void>((done) => waiting.push(done));
  };
  // A finished download hands its slot to the next one waiting.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const early = budget?.before(url);
    if (early) throw new Error(`${url} ${early}`);
    await slot();
    const stop = new AbortController();
    let why = "";
    let over: string | undefined;
    const after = (ms: number, what: string) =>
      setTimeout(() => {
        why = what;
        stop.abort(new Error(what));
      }, ms);
    const signals = [stop.signal, source, ...(init?.signal ? [init.signal] : [])];
    const total = after(
      FETCH_LIMITS.totalMs,
      `took more than ${FETCH_LIMITS.totalMs / 60_000} minutes`,
    );
    let idle = after(FETCH_LIMITS.answerMs, `did not answer in ${FETCH_LIMITS.answerMs / 1000} s`);
    let body: Uint8Array | null = null;
    let response: Response;
    try {
      response = await original(input, { ...init, signal: AbortSignal.any(signals) });
      if (!NO_BODY.has(response.status)) {
        body = await readCapped(response, response.url || url, () => {
          clearTimeout(idle);
          idle = after(FETCH_LIMITS.idleMs, `sent nothing for ${FETCH_LIMITS.idleMs / 1000} s`);
        });
        const unpacked = body[0] === 0x1f && body[1] === 0x8b ? gunzipCapped(body) : undefined;
        over = response.ok ? budget?.after(url, body, unpacked) : undefined;
        if (over) throw new Error(`${url} ${over}`);
      }
    } catch (error) {
      if (over) throw error;
      const message = why
        ? why
        : source.aborted
          ? `the source's downloads took more than ${FETCH_LIMITS.sourceMs / 60_000} minutes`
          : (error as Error).message;
      refused.push(`${url}: ${message}`);
      throw why || source.aborted ? new Error(`${url} ${message}`) : error;
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
      release();
    }
    const capped = new Response(body as Uint8Array<ArrayBuffer> | null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(capped, "url", { value: response.url });
    return capped;
  };
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function verify(bytes: Uint8Array, dist: Record<string, unknown>, label: string) {
  if (typeof dist.integrity === "string") {
    const [algorithm, expected] = dist.integrity.split(/-(.*)/s);
    if (algorithm && expected && ["sha512", "sha384", "sha256", "sha1"].includes(algorithm)) {
      const actual = createHash(algorithm).update(bytes).digest("base64");
      if (actual !== expected)
        throw new Error(`${label}: tarball integrity mismatch (${algorithm})`);
      return;
    }
  }
  if (typeof dist.shasum === "string") {
    if (createHash("sha1").update(bytes).digest("hex") !== dist.shasum)
      throw new Error(`${label}: tarball shasum mismatch`);
    return;
  }
  throw new Error(`${label}: the registry gave no integrity hash`);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/**
 * `fetch`, with each URL it would request checked by `problem` first: the one asked for and every
 * redirect, which it follows itself, as fetch does. A URL with a problem is never requested.
 */
export function guardedFetch(
  problem: (url: string) => string | undefined,
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    let url = input instanceof Request ? input.url : String(input);
    const first = problem(url);
    if (first) throw new Error(first);
    if (init?.redirect === "manual" || init?.redirect === "error") return base(input, init);
    let options: RequestInit =
      input instanceof Request
        ? { method: input.method, headers: input.headers, signal: input.signal, ...init }
        : { ...init };
    for (let hops = 0; ; hops++) {
      const response = await base(url, { ...options, redirect: "manual" });
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) return response;
      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
      const to = new URL(location, url).toString();
      const why = problem(to);
      if (why) throw new Error(`${url} redirects to ${to}; ${why}`);
      // As fetch does: a token stays with its origin, and a 303 is followed with a GET.
      const headers = new Headers(options.headers);
      if (urlOrigin(to) !== urlOrigin(url)) headers.delete("authorization");
      options = { ...options, headers };
      if (response.status === 303) options = { ...options, method: "GET", body: undefined };
      url = to;
    }
  };
}

/**
 * Downloads an npm package into `cacheRoot/<name>@<version>` and returns that folder.
 * `skills` has no npm source type; it discovers skills in the unpacked folder like any local path.
 */
export async function fetchNpm(
  spec: string,
  registry: string | undefined,
  cacheRoot: string,
  {
    sendToken = true,
    fetch = globalThis.fetch,
  }: {
    sendToken?: boolean;
    /** What fetches the packument and the tarball. */
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const { name, want } = parseNpmSpec(spec);
  if (!PACKAGE_NAME.test(name)) throw new Error(`npm "${name}" is not a package name`);
  const base = registryUrl(registry);
  const response = await fetch(`${base}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/json", ...headers(sendToken) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm ${name}: registry answered ${response.status}`);
  const packument: unknown = await response.json();
  if (!isRecord(packument) || !isRecord(packument.versions))
    throw new Error(`npm ${name}: unexpected registry response`);
  const tags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {};
  const tagged = tags[want];
  const version = typeof tagged === "string" ? tagged : want;
  const manifest = packument.versions[version];
  if (!isRecord(manifest) || !isRecord(manifest.dist) || typeof manifest.dist.tarball !== "string")
    throw new Error(`npm ${name}: no version or tag "${want}"`);
  if (!VERSION.test(version)) throw new Error(`npm ${name}: the registry gave an invalid version`);
  const dir = join(cacheRoot, `${name.replace("/", "+")}@${version}`);
  const inside = relative(cacheRoot, dir);
  if (!inside || inside.startsWith("..") || /[/\\]/.test(inside))
    throw new Error(`npm ${name}@${version}: the cache folder would be outside the cache`);
  if (existsSync(dir)) return { dir, version };
  const url = manifest.dist.tarball;
  // The token is for the registry; a packument can point the tarball at any host.
  const tarballOrigin = urlOrigin(url);
  const sameOrigin = tarballOrigin !== undefined && tarballOrigin === urlOrigin(base);
  const tarball = await fetch(url, {
    headers: headers(sendToken && sameOrigin),
    signal: AbortSignal.timeout(60_000),
  });
  if (!tarball.ok)
    throw new Error(`npm ${name}@${version}: tarball download answered ${tarball.status}`);
  const bytes = await readCapped(tarball, `npm ${name}@${version}`);
  verify(bytes, manifest.dist, `npm ${name}@${version}`);
  let files: Map<string, Uint8Array>;
  try {
    files = readTgz(bytes);
  } catch (error) {
    throw new Error(`npm ${name}@${version}: ${(error as Error).message}`);
  }
  const temp = `${dir}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  extractStripped(files, temp);
  renameSync(temp, dir);
  return { dir, version };
}
