// FlareDispatch Dispatcher — `/v1/compile-cache/<owner>/<name>/<path>`: the
// shared compile cache sccache reaches through its WebDAV backend.
//
// sccache's WebDAV backend (OpenDAL `services-webdav`, sccache 0.18) issues
// four methods, and this route serves exactly those:
//
//   GET       read an entry; 404 is a miss
//   PUT       write an entry (`Content-Length` set)
//   PROPFIND  `Depth: 0` stat; before every PUT, of the entry's parent
//             collection, to decide whether to MKCOL it
//   MKCOL     create a parent collection
//
// plus HEAD. Collections are virtual: every path ending in `/` exists, so a
// PUT costs one PROPFIND and never a MKCOL. Entries live in `RUNS_STORAGE`
// under `compile-cache/<owner>/<name>/<path>`; the path below the repository
// is the client's `SCCACHE_WEBDAV_KEY_PREFIX` remainder and key.
//
// Every request carries `Authorization: Bearer <token>` (compile-cache-token.ts)
// minted for the repository the path names. Missing → 401; a token for another
// repository, a forged or an expired one → 403; no `HMAC_SECRET` → 503.
//
// Bounds, read from the Worker vars (wrangler.jsonc) with these defaults:
//   COMPILE_CACHE_MAX_OBJECT_BYTES  one entry; a larger PUT is 413
//   COMPILE_CACHE_MAX_REPO_BYTES    one repository's prefix; a PUT while the
//                                   last measured size plus the entry exceeds
//                                   it is 507
//   COMPILE_CACHE_TTL_DAYS          entry age at which the sweep deletes it
// The sweep (`sweepCompileCache`, on COMPILE_CACHE_SWEEP_CRON) measures each
// prefix, deletes entries past the TTL, then deletes the oldest-written
// entries until the prefix is at most 90% of its ceiling, and records the
// measured size the PUT admission reads. A prefix can therefore exceed its
// ceiling by the writes of one sweep interval.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Shared compile cache.

import { resolveCompileCacheSecret, verifyCompileCacheToken } from "../compile-cache-token";
import type { Env } from "../env";

/** Path prefix of the route. */
export const COMPILE_CACHE_ROUTE = "/v1/compile-cache";
/** R2 prefix of the entries. */
export const COMPILE_CACHE_PREFIX = "compile-cache/";
/** R2 prefix of the per-repository measured sizes the sweep records. */
export const COMPILE_CACHE_USAGE_PREFIX = "compile-cache-usage/";
/** The sweep's cron (wrangler.jsonc `triggers.crons`). */
export const COMPILE_CACHE_SWEEP_CRON = "41 * * * *";

export const DEFAULT_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_REPO_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_TTL_DAYS = 14;
/** The sweep evicts down to this fraction of the ceiling, so the next writes have room. */
const EVICT_TO_RATIO = 0.9;
/** Listing pages one sweep reads (1000 entries each). */
const MAX_SWEEP_PAGES = 500;
const MAX_KEY_BYTES = 1024;

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._+-]{1,255}$/;

export type CompileCacheLimits = {
  readonly maxObjectBytes: number;
  readonly maxRepoBytes: number;
  readonly ttlDays: number;
};

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== "" && Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** The configured bounds; an absent or malformed var takes its default. */
export const resolveCompileCacheLimits = (
  env: Pick<Env, "COMPILE_CACHE_MAX_OBJECT_BYTES" | "COMPILE_CACHE_MAX_REPO_BYTES" | "COMPILE_CACHE_TTL_DAYS">,
): CompileCacheLimits => ({
  maxObjectBytes: positive(env.COMPILE_CACHE_MAX_OBJECT_BYTES, DEFAULT_MAX_OBJECT_BYTES),
  maxRepoBytes: positive(env.COMPILE_CACHE_MAX_REPO_BYTES, DEFAULT_MAX_REPO_BYTES),
  ttlDays: positive(env.COMPILE_CACHE_TTL_DAYS, DEFAULT_TTL_DAYS),
});

/** A request path resolved to its repository and R2 key. */
export type CompileCachePath = {
  /** `owner/name`, lowercase. */
  readonly repo: string;
  /** The R2 key; ends in `/` for a collection. */
  readonly key: string;
  readonly collection: boolean;
};

/**
 * Resolve `pathname` (`/v1/compile-cache/<owner>/<name>[/<segment>…][/]`).
 * `undefined` for anything else: a missing repository, an empty, `.` or `..`
 * segment, a character outside the key charset, or a key over 1024 bytes.
 */
export const parseCompileCachePath = (pathname: string): CompileCachePath | undefined => {
  if (!pathname.startsWith(`${COMPILE_CACHE_ROUTE}/`)) return undefined;
  const rest = pathname.slice(COMPILE_CACHE_ROUTE.length + 1);
  const collection = rest.endsWith("/");
  const raw = (collection ? rest.slice(0, -1) : rest).split("/");
  let segments: string[];
  try {
    segments = raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (segments.length < 2) return undefined;
  const [owner, name, ...below] = segments as [string, string, ...string[]];
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return undefined;
  if (below.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) return undefined;
  // `<owner>/<name>` alone is the repository's root collection, never an entry.
  if (below.length === 0 && !collection) return undefined;
  const repo = `${owner}/${name}`.toLowerCase();
  const key = `${COMPILE_CACHE_PREFIX}${repo}/${below.join("/")}${below.length > 0 && collection ? "/" : ""}`;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return undefined;
  return { repo, key, collection: collection || below.length === 0 };
};

/** The R2 key of a repository's measured size. */
export const usageKey = (repo: string): string => `${COMPILE_CACHE_USAGE_PREFIX}${repo.toLowerCase()}`;

/** The R2 surface the route and the sweep use. */
export type CompileCacheBucket = Pick<R2Bucket, "get" | "head" | "put" | "delete" | "list">;

const text = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const ALLOW = "GET, HEAD, PUT, PROPFIND, MKCOL, OPTIONS";

const multistatus = (href: string, props: string): Response =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } },
  );

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The last-modified of a virtual collection: a fixed instant, since it never changes. */
const COLLECTION_MODIFIED = new Date(0).toUTCString();

/** Ports the handler reads: the clock (epoch ms). */
export type CompileCachePorts = { readonly now: () => number };

/** Serve one compile-cache request. */
export const handleCompileCache = async (
  request: Request,
  env: Pick<
    Env,
    "HMAC_SECRET" | "COMPILE_CACHE_MAX_OBJECT_BYTES" | "COMPILE_CACHE_MAX_REPO_BYTES" | "COMPILE_CACHE_TTL_DAYS"
  > & { readonly RUNS_STORAGE: CompileCacheBucket },
  ports: CompileCachePorts = { now: Date.now },
): Promise<Response> => {
  const url = new URL(request.url);
  const path = parseCompileCachePath(url.pathname);
  if (path === undefined) return text(404, "not found");

  const secret = resolveCompileCacheSecret(env);
  if (secret === undefined) return text(503, "compile cache unavailable: no signing secret");
  const auth = request.headers.get("authorization");
  const bearer = auth === null ? null : /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (bearer === null) return text(401, "missing bearer token", { "www-authenticate": 'Bearer realm="compile-cache"' });
  const verdict = await verifyCompileCacheToken(secret, path.repo, bearer[1]!, Math.floor(ports.now() / 1000));
  if (!verdict.ok) return text(403, `token ${verdict.reason}`);

  const bucket = env.RUNS_STORAGE;
  const limits = resolveCompileCacheLimits(env);
  switch (request.method) {
    case "OPTIONS":
      return new Response(null, { status: 200, headers: { allow: ALLOW, dav: "1" } });
    case "GET":
    case "HEAD": {
      if (path.collection) return text(404, "not found");
      const entryHeaders = (object: R2Object) => ({
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        etag: object.httpEtag,
        "last-modified": object.uploaded.toUTCString(),
      });
      if (request.method === "HEAD") {
        const object = await bucket.head(path.key);
        if (object === null) return text(404, "not found");
        return new Response(null, { status: 200, headers: entryHeaders(object) });
      }
      const object = await bucket.get(path.key);
      if (object === null) return text(404, "not found");
      return new Response(object.body, { status: 200, headers: entryHeaders(object) });
    }
    case "PUT": {
      if (path.collection) return text(405, "a collection takes no body", { allow: ALLOW });
      const declared = request.headers.get("content-length");
      if (declared === null || !/^[0-9]{1,16}$/.test(declared)) return text(411, "content-length required");
      const length = Number(declared);
      if (length > limits.maxObjectBytes)
        return text(413, `entry of ${length} bytes exceeds the ${limits.maxObjectBytes}-byte bound`);
      const usage = await bucket.head(usageKey(path.repo));
      const measured = Number(usage?.customMetadata?.bytes ?? "0");
      if (Number.isFinite(measured) && measured + length > limits.maxRepoBytes)
        return text(507, `repository cache at ${measured} bytes of its ${limits.maxRepoBytes}-byte bound`);
      const stored = await bucket.put(path.key, length === 0 || request.body === null ? "" : request.body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return new Response(null, { status: 201, headers: stored === null ? {} : { etag: stored.httpEtag } });
    }
    case "MKCOL":
      return new Response(null, { status: 201 });
    case "PROPFIND": {
      const depth = request.headers.get("depth");
      if (depth !== null && depth.trim() !== "0") return text(403, "only Depth: 0 is served");
      const href = xmlEscape(url.pathname);
      if (path.collection)
        return multistatus(
          href,
          `<D:getlastmodified>${COLLECTION_MODIFIED}</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype>`,
        );
      const object = await bucket.head(path.key);
      if (object === null) return text(404, "not found");
      return multistatus(
        href,
        `<D:getlastmodified>${object.uploaded.toUTCString()}</D:getlastmodified><D:getcontentlength>${object.size}</D:getcontentlength><D:getetag>${xmlEscape(object.httpEtag)}</D:getetag><D:resourcetype/>`,
      );
    }
    default:
      return text(405, "method not allowed", { allow: ALLOW });
  }
};

/** One repository's sweep outcome. */
export type CompileCacheSweepRepo = {
  readonly repo: string;
  readonly bytes: number;
  readonly objects: number;
  readonly expired: number;
  readonly evicted: number;
};

export type CompileCacheSweepResult = {
  readonly repos: readonly CompileCacheSweepRepo[];
  /** The listing stopped at the page bound; sizes are lower bounds. */
  readonly truncated: boolean;
};

const repoOf = (key: string): string | undefined => {
  const parts = key.slice(COMPILE_CACHE_PREFIX.length).split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : undefined;
};

const deleteKeys = async (bucket: CompileCacheBucket, keys: readonly string[]): Promise<void> => {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
};

/**
 * Measure every repository prefix, delete entries older than the TTL, evict
 * the oldest-written entries of a prefix over its ceiling down to 90% of it,
 * and record each prefix's remaining size for the PUT admission. A usage
 * record whose prefix holds no entries is deleted.
 */
export const sweepCompileCache = async (
  bucket: CompileCacheBucket,
  limits: CompileCacheLimits,
  nowMs: number,
): Promise<CompileCacheSweepResult> => {
  const byRepo = new Map<string, { key: string; size: number; uploaded: number }[]>();
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_SWEEP_PAGES) {
      truncated = true;
      break;
    }
    const listed = await bucket.list({ prefix: COMPILE_CACHE_PREFIX, limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const object of listed.objects) {
      const repo = repoOf(object.key);
      if (repo === undefined) continue;
      const entries = byRepo.get(repo) ?? [];
      entries.push({ key: object.key, size: object.size, uploaded: object.uploaded.getTime() });
      byRepo.set(repo, entries);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  const cutoff = nowMs - limits.ttlDays * 24 * 3600 * 1000;
  const target = Math.floor(limits.maxRepoBytes * EVICT_TO_RATIO);
  const repos: CompileCacheSweepRepo[] = [];
  for (const [repo, entries] of byRepo) {
    const expired = entries.filter((entry) => entry.uploaded < cutoff);
    const kept = entries.filter((entry) => entry.uploaded >= cutoff).sort((a, b) => a.uploaded - b.uploaded);
    let bytes = kept.reduce((sum, entry) => sum + entry.size, 0);
    const evicted: string[] = [];
    if (bytes > limits.maxRepoBytes) {
      for (const entry of kept) {
        if (bytes <= target) break;
        evicted.push(entry.key);
        bytes -= entry.size;
      }
    }
    await deleteKeys(bucket, [...expired.map((entry) => entry.key), ...evicted]);
    const objects = kept.length - evicted.length;
    await bucket.put(usageKey(repo), "", {
      customMetadata: { bytes: String(bytes), objects: String(objects), measuredAt: new Date(nowMs).toISOString() },
    });
    repos.push({ repo, bytes, objects, expired: expired.length, evicted: evicted.length });
  }

  if (!truncated) {
    const stale: string[] = [];
    let usageCursor: string | undefined;
    do {
      const listed = await bucket.list({
        prefix: COMPILE_CACHE_USAGE_PREFIX,
        limit: 1000,
        ...(usageCursor !== undefined ? { cursor: usageCursor } : {}),
      });
      for (const object of listed.objects)
        if (!byRepo.has(object.key.slice(COMPILE_CACHE_USAGE_PREFIX.length))) stale.push(object.key);
      usageCursor = listed.truncated ? listed.cursor : undefined;
    } while (usageCursor !== undefined);
    await deleteKeys(bucket, stale);
  }
  return { repos, truncated };
};
