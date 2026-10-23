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
// PUT costs one PROPFIND and never a MKCOL.
//
// Every request carries `Authorization: Bearer <token>` (compile-cache-token.ts)
// minted for the repository the path names. Missing → 401; a token for another
// repository, a forged or an expired one → 403; no `HMAC_SECRET` → 503.
//
// Entries live in `RUNS_STORAGE` under `compile-cache/<owner>/<name>/@<lane>/<path>`,
// where `<path>` is the client's `SCCACHE_WEBDAV_KEY_PREFIX` remainder and
// key, and `<lane>` comes from the token, never the request:
//
//   base       writes `@base`, reads `@base`
//   pr-<n>     writes `@pr-<n>`, reads `@pr-<n>` and then `@base`
//   read-only  writes nothing (PUT → 403), reads `@base`
//
// so an entry a pull request writes reaches only that pull request.
//
// Bounds, read from the Worker vars (wrangler.jsonc) with these defaults:
//   COMPILE_CACHE_MAX_OBJECT_BYTES     one entry; a larger PUT is 413
//   COMPILE_CACHE_MAX_REPO_BYTES       one repository, all lanes; a PUT the
//                                      ledger cannot fit is 507
//   COMPILE_CACHE_MAX_EXECUTION_BYTES  one execution's writes; past it, 507
//   COMPILE_CACHE_TTL_DAYS             entry age at which the sweep deletes it
// Every PUT reserves its length in the repository's ledger
// (compile-cache-ledger.ts) before it writes, and a PUT after the execution
// ended is 403; a deploy without the `COMPILE_CACHE_LEDGER` binding refuses
// every PUT with 503 and still serves reads.
//
// A GET that serves an entry older than half the TTL rewrites it in place
// after the response, so an entry's age is its time since last use and the
// sweep's oldest-first eviction removes the least recently used.
//
// The sweep (`sweepCompileCache`, on COMPILE_CACHE_SWEEP_CRON) lists up to
// `maxPages` pages per tick and resumes from the stored cursor on the next
// tick. It deletes every expired entry it lists. For a repository listed
// whole within one tick it also deletes the oldest entries until the
// repository is at most 90% of its ceiling and replaces the ledger's count
// with the measured size; for one listed in part, it subtracts the bytes it
// deleted.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Shared compile cache.

import type { CompileCacheLane } from "@fractalboxdev/flare-dispatch-core/primitives";
import type { CompileCacheLedgerApi } from "../compile-cache-ledger";
import { resolveCompileCacheSecret, verifyCompileCacheToken } from "../compile-cache-token";
import type { Env } from "../env";

/** Path prefix of the route. */
export const COMPILE_CACHE_ROUTE = "/v1/compile-cache";
/** R2 prefix of the entries. */
export const COMPILE_CACHE_PREFIX = "compile-cache/";
/** R2 key of the sweep's resume point: the listing cursor and the repository it stopped in. */
export const SWEEP_STATE_KEY = "compile-cache-sweep/state";
/** The sweep's cron (wrangler.jsonc `triggers.crons`). */
export const COMPILE_CACHE_SWEEP_CRON = "41 * * * *";

export const DEFAULT_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_REPO_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_EXECUTION_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_TTL_DAYS = 14;
/** The sweep evicts down to this fraction of the ceiling, so the next writes have room. */
const EVICT_TO_RATIO = 0.9;
/** Listing pages one sweep tick reads (1000 entries each). */
const MAX_SWEEP_PAGES = 500;
/** A GET rewrites an entry older than this fraction of the TTL. */
const REFRESH_AGE_RATIO = 0.5;
const MAX_KEY_BYTES = 1024;

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._+-]{1,255}$/;

export type CompileCacheLimits = {
  readonly maxObjectBytes: number;
  readonly maxRepoBytes: number;
  readonly maxExecutionBytes: number;
  readonly ttlDays: number;
};

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== "" && Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** The configured bounds; an absent or malformed var takes its default. */
export const resolveCompileCacheLimits = (
  env: Pick<
    Env,
    | "COMPILE_CACHE_MAX_OBJECT_BYTES"
    | "COMPILE_CACHE_MAX_REPO_BYTES"
    | "COMPILE_CACHE_MAX_EXECUTION_BYTES"
    | "COMPILE_CACHE_TTL_DAYS"
  >,
): CompileCacheLimits => ({
  maxObjectBytes: positive(env.COMPILE_CACHE_MAX_OBJECT_BYTES, DEFAULT_MAX_OBJECT_BYTES),
  maxRepoBytes: positive(env.COMPILE_CACHE_MAX_REPO_BYTES, DEFAULT_MAX_REPO_BYTES),
  maxExecutionBytes: positive(env.COMPILE_CACHE_MAX_EXECUTION_BYTES, DEFAULT_MAX_EXECUTION_BYTES),
  ttlDays: positive(env.COMPILE_CACHE_TTL_DAYS, DEFAULT_TTL_DAYS),
});

/** A request path resolved to its repository and the key below it. */
export type CompileCachePath = {
  /** `owner/name`, lowercase. */
  readonly repo: string;
  /** The key below the repository, without a lane; ends in `/` for a collection. */
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
  const key = `${below.join("/")}${below.length > 0 && collection ? "/" : ""}`;
  if (new TextEncoder().encode(laneKey(repo, "read-only", key)).length > MAX_KEY_BYTES) return undefined;
  return { repo, key, collection: collection || below.length === 0 };
};

/** The lane-qualified R2 key of `key` in `repo`; the longest lane name bounds the key length. */
const laneKey = (repo: string, lane: string, key: string): string =>
  `${COMPILE_CACHE_PREFIX}${repo}/@${lane}/${key}`;

/** The lanes a token reads, in order; the first holding the key answers. */
const readLanes = (lane: CompileCacheLane): readonly string[] =>
  lane === "base" || lane === "read-only" ? ["base"] : [lane, "base"];

/** The ledger a deploy binds, by repository; `undefined` without the binding. */
export type CompileCacheLedgers = (repo: string) => CompileCacheLedgerApi | undefined;

/** The live ledger lookup over `COMPILE_CACHE_LEDGER`. */
export const ledgersOf =
  (env: Pick<Env, "COMPILE_CACHE_LEDGER">): CompileCacheLedgers =>
  (repo) => {
    const namespace = env.COMPILE_CACHE_LEDGER;
    if (namespace === undefined) return undefined;
    return namespace.get(namespace.idFromName(repo.toLowerCase())) as unknown as CompileCacheLedgerApi;
  };

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

/**
 * Ports the handler reads: the clock (epoch ms), and for the rewrite of an
 * aged entry, the request's `waitUntil` and a stream of known length (R2
 * stores a stream only when its length is known). Without `waitUntil` no
 * entry is rewritten.
 */
export type CompileCachePorts = {
  readonly now: () => number;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly fixedLength?: (stream: ReadableStream, length: number) => ReadableStream;
};

/** The Workers runtime's `FixedLengthStream`, or `undefined` outside it. */
const workersFixedLength = (stream: ReadableStream, length: number): ReadableStream | undefined => {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
  if (Fixed === undefined) return undefined;
  const fixed = new Fixed(length);
  stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
};

/** Serve one compile-cache request. */
export const handleCompileCache = async (
  request: Request,
  env: Pick<
    Env,
    | "HMAC_SECRET"
    | "COMPILE_CACHE_MAX_OBJECT_BYTES"
    | "COMPILE_CACHE_MAX_REPO_BYTES"
    | "COMPILE_CACHE_MAX_EXECUTION_BYTES"
    | "COMPILE_CACHE_TTL_DAYS"
    | "COMPILE_CACHE_LEDGER"
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
  const nowSec = Math.floor(ports.now() / 1000);
  const verdict = await verifyCompileCacheToken(secret, path.repo, bearer[1]!, nowSec);
  if (!verdict.ok) return text(403, `token ${verdict.reason}`);
  const scope = verdict.scope;

  const bucket = env.RUNS_STORAGE;
  const limits = resolveCompileCacheLimits(env);
  const lanes = readLanes(scope.lane);
  /** The first object a read lane holds, with the R2 key it holds it under. */
  const find = async <T>(read: (key: string) => Promise<T | null>): Promise<{ key: string; object: T } | null> => {
    for (const lane of lanes) {
      const key = laneKey(path.repo, lane, path.key);
      const object = await read(key);
      if (object !== null) return { key, object };
    }
    return null;
  };
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
        const found = await find((key) => bucket.head(key));
        if (found === null) return text(404, "not found");
        return new Response(null, { status: 200, headers: entryHeaders(found.object) });
      }
      const found = await find((key) => bucket.get(key));
      if (found === null) return text(404, "not found");
      const object = found.object;
      const refreshBefore = ports.now() - limits.ttlDays * 24 * 3600 * 1000 * REFRESH_AGE_RATIO;
      if (ports.waitUntil !== undefined && object.uploaded.getTime() < refreshBefore) {
        const [served, copied] = object.body.tee();
        const sized = (ports.fixedLength ?? workersFixedLength)(copied, object.size);
        if (sized === undefined) {
          copied.cancel().catch(() => {});
        } else {
          ports.waitUntil(
            bucket
              .put(found.key, sized, { httpMetadata: { contentType: "application/octet-stream" } })
              .catch(() => undefined),
          );
        }
        return new Response(served, { status: 200, headers: entryHeaders(object) });
      }
      return new Response(object.body, { status: 200, headers: entryHeaders(object) });
    }
    case "PUT": {
      if (path.collection) return text(405, "a collection takes no body", { allow: ALLOW });
      const declared = request.headers.get("content-length");
      if (declared === null || !/^[0-9]{1,16}$/.test(declared)) return text(411, "content-length required");
      const length = Number(declared);
      if (length > limits.maxObjectBytes)
        return text(413, `entry of ${length} bytes exceeds the ${limits.maxObjectBytes}-byte bound`);
      if (scope.lane === "read-only") return text(403, "token grants no writes");
      const ledger = ledgersOf(env)(path.repo);
      if (ledger === undefined) return text(503, "compile cache writes unavailable: no ledger");
      const reserved = await ledger.reserve({
        executionId: scope.executionId,
        expiresAt: scope.expiresAt,
        bytes: length,
        maxRepoBytes: limits.maxRepoBytes,
        maxExecutionBytes: limits.maxExecutionBytes,
      });
      if (!reserved.ok) {
        if (reserved.reason === "ended") return text(403, "execution ended");
        return reserved.reason === "execution"
          ? text(507, `execution's writes would pass its ${limits.maxExecutionBytes}-byte budget`)
          : text(507, `repository cache at ${reserved.repoBytes} bytes of its ${limits.maxRepoBytes}-byte bound`);
      }
      const key = laneKey(path.repo, scope.lane, path.key);
      const stored = await bucket.put(key, length === 0 || request.body === null ? "" : request.body, {
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
      const found = await find((key) => bucket.head(key));
      if (found === null) return text(404, "not found");
      const object = found.object;
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
  /** Bytes the repository holds after the sweep; for a partial listing, of the entries listed. */
  readonly bytes: number;
  readonly objects: number;
  readonly expired: number;
  readonly evicted: number;
  /** The tick listed the whole repository, so it evicted and measured. */
  readonly complete: boolean;
};

export type CompileCacheSweepResult = {
  readonly repos: readonly CompileCacheSweepRepo[];
  /** The tick stopped at its page bound; the next tick resumes from its cursor. */
  readonly truncated: boolean;
};

export type CompileCacheSweepOptions = {
  readonly ledger: CompileCacheLedgers;
  /** Listing pages this tick reads; default 500. */
  readonly maxPages?: number;
};

const repoOf = (key: string): string | undefined => {
  const parts = key.slice(COMPILE_CACHE_PREFIX.length).split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : undefined;
};

const deleteKeys = async (bucket: CompileCacheBucket, keys: readonly string[]): Promise<void> => {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
};

type Listed = { key: string; size: number; uploaded: number };

/**
 * One tick of the sweep. The listing is sorted by key, so each repository's
 * entries are contiguous and only the current repository's are held. The tick
 * starts from the stored cursor, deletes every expired entry it lists, and
 * for each repository it lists whole evicts the oldest entries down to 90% of
 * the ceiling and replaces the ledger's count with the remaining size. A
 * repository the tick lists in part (the one it resumed in, the one it
 * stopped in) has the bytes it deleted subtracted from its count instead.
 */
export const sweepCompileCache = async (
  bucket: CompileCacheBucket,
  limits: CompileCacheLimits,
  nowMs: number,
  options: CompileCacheSweepOptions,
): Promise<CompileCacheSweepResult> => {
  const maxPages = options.maxPages ?? MAX_SWEEP_PAGES;
  const nowSec = Math.floor(nowMs / 1000);
  const cutoff = nowMs - limits.ttlDays * 24 * 3600 * 1000;
  const target = Math.floor(limits.maxRepoBytes * EVICT_TO_RATIO);
  const state = await bucket.head(SWEEP_STATE_KEY);
  const resumedCursor = state?.customMetadata?.cursor;
  const resumedRepo = state?.customMetadata?.repo;

  const repos: CompileCacheSweepRepo[] = [];
  let current: { repo: string; complete: boolean; kept: Listed[]; expired: Listed[] } | undefined;

  const finish = async (complete: boolean): Promise<void> => {
    if (current === undefined) return;
    const { repo, kept, expired } = current;
    await deleteKeys(bucket, expired.map((entry) => entry.key));
    let bytes = kept.reduce((sum, entry) => sum + entry.size, 0);
    const evicted: string[] = [];
    if (complete) {
      if (bytes > limits.maxRepoBytes) {
        for (const entry of [...kept].sort((a, b) => a.uploaded - b.uploaded)) {
          if (bytes <= target) break;
          evicted.push(entry.key);
          bytes -= entry.size;
        }
        await deleteKeys(bucket, evicted);
      }
      await options.ledger(repo)?.measure({ bytes, nowSec });
    } else {
      const released = expired.reduce((sum, entry) => sum + entry.size, 0);
      await options.ledger(repo)?.release({ bytes: released, nowSec });
    }
    repos.push({ repo, bytes, objects: kept.length - evicted.length, expired: expired.length, evicted: evicted.length, complete });
    current = undefined;
  };

  let cursor = resumedCursor;
  let first = true;
  let finished = false;
  for (let page = 0; page < maxPages; page++) {
    const listed = await bucket.list({ prefix: COMPILE_CACHE_PREFIX, limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
    for (const object of listed.objects) {
      const repo = repoOf(object.key);
      if (repo === undefined) continue;
      if (current?.repo !== repo) {
        await finish(current?.complete ?? true);
        // A repository the previous tick stopped in started before this tick's listing.
        const complete = !(first && resumedCursor !== undefined && repo === resumedRepo);
        current = { repo, complete, kept: [], expired: [] };
        first = false;
      }
      const entry = { key: object.key, size: object.size, uploaded: object.uploaded.getTime() };
      (entry.uploaded < cutoff ? current.expired : current.kept).push(entry);
    }
    if (!listed.truncated) {
      finished = true;
      break;
    }
    cursor = listed.cursor;
  }

  if (finished) {
    await finish(current?.complete ?? true);
    if (state !== null) await bucket.delete(SWEEP_STATE_KEY);
  } else {
    const stoppedIn = current?.repo;
    await finish(false);
    await bucket.put(SWEEP_STATE_KEY, "", {
      customMetadata: { ...(cursor !== undefined ? { cursor } : {}), ...(stoppedIn !== undefined ? { repo: stoppedIn } : {}) },
    });
  }
  return { repos, truncated: !finished };
};
