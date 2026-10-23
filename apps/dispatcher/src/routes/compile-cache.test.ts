// `/v1/compile-cache/…` — the WebDAV subset sccache's backend issues, its
// token scope, its bounds, and the sweep that holds each prefix to its ceiling.

import type { CompileCacheLane } from "@fractalboxdev/flare-dispatch-core/primitives";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compileCacheOverrides,
  signCompileCacheToken,
  verifyCompileCacheToken,
} from "../compile-cache-token";
import { type LedgerStorage, makeCompileCacheLedger } from "../compile-cache-ledger";
import type { Env } from "../env";
import { handleRequest } from "../router";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import {
  type CompileCacheBucket,
  handleCompileCache,
  parseCompileCachePath,
  resolveCompileCacheLimits,
  SWEEP_STATE_KEY,
  sweepCompileCache,
} from "./compile-cache";

const SECRET = "compile-cache-secret-aaaaaaaaaaaaaaaa";
const EXEC = "check:owner_name:abc123def456";
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const BASE = "https://dispatch.example/v1/compile-cache/owner/name/1.90.0/x86_64-unknown-linux-gnu";

type Stored = { body: Uint8Array; uploaded: Date; customMetadata?: Record<string, string> };

/** An in-memory bucket with the R2 calls the route and the sweep make. */
const makeBucket = (pageSize = 1000) => {
  const store = new Map<string, Stored>();
  const meta = (key: string, obj: Stored) => ({
    key,
    size: obj.body.byteLength,
    uploaded: obj.uploaded,
    httpEtag: `"etag-${key}"`,
    customMetadata: obj.customMetadata ?? {},
  });
  const bucket = {
    get: async (key: string) => {
      const obj = store.get(key);
      return obj === undefined ? null : { ...meta(key, obj), body: new Response(obj.body).body };
    },
    head: async (key: string) => {
      const obj = store.get(key);
      return obj === undefined ? null : meta(key, obj);
    },
    put: async (key: string, body: ReadableStream | string, opts?: { customMetadata?: Record<string, string> }) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const obj: Stored = { body: bytes, uploaded: new Date(NOW_MS), ...(opts?.customMetadata ? { customMetadata: opts.customMetadata } : {}) };
      store.set(key, obj);
      return meta(key, obj);
    },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    list: async (opts: { prefix?: string; cursor?: string; limit?: number }) => {
      // The cursor names the last key returned, so deletions between pages
      // and between sweeps shift nothing, as with R2's opaque cursor.
      const keys = [...store.keys()]
        .filter((key) => key.startsWith(opts.prefix ?? "") && (opts.cursor === undefined || key > opts.cursor))
        .sort();
      const page = keys.slice(0, Math.min(pageSize, opts.limit ?? 1000));
      const more = page.length < keys.length;
      return {
        objects: page.map((key) => meta(key, store.get(key)!)),
        truncated: more,
        ...(more ? { cursor: page[page.length - 1] } : {}),
      };
    },
  } as unknown as CompileCacheBucket;
  const seed = (key: string, size: number, uploadedMs: number) =>
    store.set(key, { body: new Uint8Array(size), uploaded: new Date(uploadedMs) });
  return { bucket, store, seed };
};

const memoryStorage = (): LedgerStorage => {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>(opts: { prefix: string }) =>
      new Map([...map].filter(([key]) => key.startsWith(opts.prefix)) as [string, T][]),
  };
};

/** One in-memory ledger per repository, addressed the way the route addresses the Durable Object. */
const makeLedgers = () => {
  const byName = new Map<string, ReturnType<typeof makeCompileCacheLedger>>();
  const ledger = (name: string) => {
    let found = byName.get(name);
    if (found === undefined) {
      found = makeCompileCacheLedger(memoryStorage());
      byName.set(name, found);
    }
    return found;
  };
  const namespace = { idFromName: (name: string) => name, get: (id: string) => ledger(id) };
  return { ledger, namespace: namespace as unknown as Env["COMPILE_CACHE_LEDGER"] };
};

let ledgers = makeLedgers();
beforeEach(() => {
  ledgers = makeLedgers();
});

const envWith = (bucket: CompileCacheBucket, over: Partial<Env> = {}) => ({
  HMAC_SECRET: SECRET,
  RUNS_STORAGE: bucket,
  COMPILE_CACHE_LEDGER: ledgers.namespace,
  ...over,
});

const token = (over: { repo?: string; expiresAt?: number; lane?: CompileCacheLane; executionId?: string } = {}) =>
  signCompileCacheToken(SECRET, {
    repo: over.repo ?? "owner/name",
    executionId: over.executionId ?? EXEC,
    lane: over.lane ?? "base",
    expiresAt: over.expiresAt ?? NOW + 3600,
  });

const call = async (
  bucket: CompileCacheBucket,
  method: string,
  url: string,
  opts: {
    token?: string | null;
    body?: string;
    headers?: Record<string, string>;
    env?: Partial<Env>;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
) => {
  const bearer = opts.token === undefined ? await token() : opts.token;
  const headers: Record<string, string> = { ...opts.headers };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  if (opts.body !== undefined && headers["content-length"] === undefined)
    headers["content-length"] = String(new TextEncoder().encode(opts.body).length);
  return handleCompileCache(
    new Request(url, { method, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) }),
    envWith(bucket, opts.env),
    {
      now: () => NOW_MS,
      ...(opts.waitUntil !== undefined ? { waitUntil: opts.waitUntil, fixedLength: (stream: ReadableStream) => stream } : {}),
    },
  );
};

describe("compile-cache auth", () => {
  it("refuses a request without a token", async () => {
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses an expired token", async () => {
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: await token({ expiresAt: NOW }) });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("token expired");
  });

  it("refuses a token minted for another repository", async () => {
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: await token({ repo: "owner/other" }) });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("token invalid");
  });

  it("refuses a token whose expiry was rewritten", async () => {
    const minted = await token();
    const [v, , exec, lane, mac] = minted.split(".");
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: `${v}.${NOW + 999_999}.${exec}.${lane}.${mac}` });
    expect(res.status).toBe(403);
  });

  it("refuses a token whose lane was rewritten", async () => {
    const minted = await token({ lane: "pr-7" });
    const [v, expiry, exec, , mac] = minted.split(".");
    const res = await call(makeBucket().bucket, "PUT", `${BASE}/a/b/c/abc`, { token: `${v}.${expiry}.${exec}.base.${mac}`, body: "x" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("token invalid");
  });

  it("refuses a malformed token", async () => {
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: "not-a-token" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("token malformed");
  });

  it("answers 503 on a deploy without a signing secret", async () => {
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { env: { HMAC_SECRET: "" } });
    expect(res.status).toBe(503);
  });

  it("matches the repository case-insensitively", async () => {
    const url = "https://dispatch.example/v1/compile-cache/Owner/Name/x/key";
    const res = await call(makeBucket().bucket, "GET", url);
    expect(res.status).toBe(404);
  });

  it("verifies a minted token's scope", async () => {
    const verdict = await verifyCompileCacheToken(SECRET, "owner/name", await token(), NOW);
    expect(verdict).toEqual({ ok: true, scope: { repo: "owner/name", executionId: EXEC, lane: "base", expiresAt: NOW + 3600 } });
  });
});

describe("compile-cache WebDAV", () => {
  it("stores a PUT under the repository prefix and serves it to GET, HEAD and PROPFIND", async () => {
    const { bucket, store } = makeBucket();
    const put = await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { body: "rlib-bytes" });
    expect(put.status).toBe(201);
    expect([...store.keys()]).toEqual(["compile-cache/owner/name/@base/1.90.0/x86_64-unknown-linux-gnu/a/b/c/abcdef"]);

    const get = await call(bucket, "GET", `${BASE}/a/b/c/abcdef`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("rlib-bytes");

    const head = await call(bucket, "HEAD", `${BASE}/a/b/c/abcdef`);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");

    const stat = await call(bucket, "PROPFIND", `${BASE}/a/b/c/abcdef`, { headers: { depth: "0" } });
    expect(stat.status).toBe(207);
    const xml = await stat.text();
    expect(xml).toContain("<D:getcontentlength>10</D:getcontentlength>");
    expect(xml).toContain("<D:status>HTTP/1.1 200 OK</D:status>");
    expect(xml).toContain("<D:resourcetype/>");
  });

  it("answers a miss with 404", async () => {
    expect((await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/missing`)).status).toBe(404);
    expect((await call(makeBucket().bucket, "PROPFIND", `${BASE}/a/b/c/missing`)).status).toBe(404);
  });

  it("reports every collection as existing, so a PUT needs no MKCOL", async () => {
    const res = await call(makeBucket().bucket, "PROPFIND", `${BASE}/a/b/c/`, { headers: { depth: "0" } });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("<D:collection/>");
    expect(xml).toContain("<D:getlastmodified>");
    expect((await call(makeBucket().bucket, "MKCOL", `${BASE}/a/b/c/`)).status).toBe(201);
  });

  it("serves only Depth: 0", async () => {
    const res = await call(makeBucket().bucket, "PROPFIND", `${BASE}/`, { headers: { depth: "1" } });
    expect(res.status).toBe(403);
  });

  it("refuses a method sccache never issues", async () => {
    const res = await call(makeBucket().bucket, "DELETE", `${BASE}/a/b/c/abcdef`);
    expect(res.status).toBe(405);
  });

  it("refuses an entry over the object bound", async () => {
    const { bucket, store } = makeBucket();
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/big`, {
      body: "0123456789",
      env: { COMPILE_CACHE_MAX_OBJECT_BYTES: "9" },
    });
    expect(res.status).toBe(413);
    expect(store.size).toBe(0);
  });

  it("refuses a PUT without a Content-Length", async () => {
    const res = await call(makeBucket().bucket, "PUT", `${BASE}/a/b/c/x`, { headers: { "content-length": "" } });
    expect(res.status).toBe(411);
  });

  it("refuses a PUT once the repository's admitted bytes plus the entry exceed its bound", async () => {
    const { bucket, store } = makeBucket();
    const env = { COMPILE_CACHE_MAX_REPO_BYTES: "15" };
    expect((await call(bucket, "PUT", `${BASE}/a/b/c/x`, { body: "0123456789", env })).status).toBe(201);
    const other = await token({ executionId: "check:owner_name:other" });
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/y`, { token: other, body: "0123456789", env });
    expect(res.status).toBe(507);
    expect(store.size).toBe(1);
  });

  it("counts every PUT at once, so writes between sweeps cannot pass the repository bound", async () => {
    const { bucket, store } = makeBucket();
    const env = { COMPILE_CACHE_MAX_REPO_BYTES: "25" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(bucket, "PUT", `${BASE}/a/b/c/k${i}`, { body: "0123456789", env })).status);
    expect(statuses).toEqual([201, 201, 507, 507, 507]);
    expect(store.size).toBe(2);
  });

  it("refuses an execution's PUT past its own byte budget", async () => {
    const { bucket } = makeBucket();
    const env = { COMPILE_CACHE_MAX_EXECUTION_BYTES: "15" };
    expect((await call(bucket, "PUT", `${BASE}/a/b/c/x`, { body: "0123456789", env })).status).toBe(201);
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/y`, { body: "0123456789", env });
    expect(res.status).toBe(507);
    expect(await res.text()).toContain("execution");
  });

  it("refuses a PUT once the execution ended, though its token has not expired", async () => {
    const { bucket } = makeBucket();
    await ledgers.ledger("owner/name").end({ executionId: EXEC, expiresAt: NOW + 3600 });
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/x`, { body: "0123456789" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("execution ended");
    expect((await call(bucket, "GET", `${BASE}/a/b/c/x`)).status).toBe(404);
  });

  it("refuses every PUT on a deploy without the ledger, and still serves reads", async () => {
    const { bucket, seed } = makeBucket();
    seed("compile-cache/owner/name/@base/1.90.0/x86_64-unknown-linux-gnu/a/b/c/x", 3, NOW_MS);
    const env = { COMPILE_CACHE_LEDGER: undefined };
    expect((await call(bucket, "PUT", `${BASE}/a/b/c/y`, { body: "0123456789", env })).status).toBe(503);
    expect((await call(bucket, "GET", `${BASE}/a/b/c/x`, { env })).status).toBe(200);
  });

  it("rejects paths that escape or skip the repository", () => {
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/../other/x")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/%2e%2e/x")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/a//b")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/")).toEqual({
      repo: "owner/name",
      key: "",
      collection: true,
    });
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/.sccache_check")).toEqual({
      repo: "owner/name",
      key: ".sccache_check",
      collection: false,
    });
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/@base/x")).toBeUndefined();
  });

  it("is reachable through the dispatcher router", async () => {
    const env = makeFakeEnv({ hmacSecret: SECRET, workflow: makeFakeWorkflow(), storage: makeFakeR2() });
    const res = await handleRequest(new Request(`${BASE}/a/b/c/abc`), env);
    expect(res.status).toBe(401);
  });
});

describe("compile-cache lanes", () => {
  const entry = "1.90.0/x86_64-unknown-linux-gnu/a/b/c/abcdef";

  it("lands a pull request's PUT in its own lane, which no other lane reads", async () => {
    const { bucket, store } = makeBucket();
    const pr7 = await token({ lane: "pr-7" });
    expect((await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { token: pr7, body: "planted" })).status).toBe(201);
    expect([...store.keys()]).toEqual([`compile-cache/owner/name/@pr-7/${entry}`]);
    expect((await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: await token() })).status).toBe(404);
    expect((await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: await token({ lane: "pr-8" }) })).status).toBe(404);
    expect((await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: await token({ lane: "read-only" }) })).status).toBe(404);
    expect(await (await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: pr7 })).text()).toBe("planted");
  });

  it("serves a pull request the default branch's entry, and its own entry over it", async () => {
    const { bucket } = makeBucket();
    const pr7 = await token({ lane: "pr-7" });
    await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { body: "from-base" });
    expect(await (await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: pr7 })).text()).toBe("from-base");
    expect((await call(bucket, "HEAD", `${BASE}/a/b/c/abcdef`, { token: pr7 })).status).toBe(200);
    expect((await call(bucket, "PROPFIND", `${BASE}/a/b/c/abcdef`, { token: pr7, headers: { depth: "0" } })).status).toBe(207);
    await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { token: pr7, body: "from-pr" });
    expect(await (await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { token: pr7 })).text()).toBe("from-pr");
    expect(await (await call(bucket, "GET", `${BASE}/a/b/c/abcdef`)).text()).toBe("from-base");
  });

  it("refuses a PUT from a read-only token", async () => {
    const { bucket, store } = makeBucket();
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { token: await token({ lane: "read-only" }), body: "x" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("token grants no writes");
    expect(store.size).toBe(0);
  });

  it("rewrites an entry read past half its lifetime, so the sweep ages entries by last use", async () => {
    const { bucket, store, seed } = makeBucket();
    const DAY = 24 * 3600 * 1000;
    const key = `compile-cache/owner/name/@base/${entry}`;
    seed(key, 4, NOW_MS - 8 * DAY);
    const pending: Promise<unknown>[] = [];
    const res = await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, {
      token: await token({ lane: "pr-7" }),
      waitUntil: (promise) => pending.push(promise),
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(4);
    await Promise.all(pending);
    expect(store.get(key)?.uploaded.getTime()).toBe(NOW_MS);
    expect([...store.keys()]).toEqual([key]);
  });

  it("leaves an entry read within half its lifetime as written", async () => {
    const { bucket, store, seed } = makeBucket();
    const DAY = 24 * 3600 * 1000;
    const key = `compile-cache/owner/name/@base/${entry}`;
    seed(key, 4, NOW_MS - 6 * DAY);
    const pending: Promise<unknown>[] = [];
    await (await call(bucket, "GET", `${BASE}/a/b/c/abcdef`, { waitUntil: (promise) => pending.push(promise) })).arrayBuffer();
    expect(pending).toEqual([]);
    expect(store.get(key)?.uploaded.getTime()).toBe(NOW_MS - 6 * DAY);
  });
});

describe("compile-cache limits", () => {
  it("records its defaults and reads overrides from the Worker vars", () => {
    expect(resolveCompileCacheLimits({})).toEqual({
      maxObjectBytes: 100 * 1024 * 1024,
      maxRepoBytes: 20 * 1024 * 1024 * 1024,
      maxExecutionBytes: 10 * 1024 * 1024 * 1024,
      ttlDays: 14,
    });
    expect(
      resolveCompileCacheLimits({
        COMPILE_CACHE_MAX_OBJECT_BYTES: "10",
        COMPILE_CACHE_MAX_REPO_BYTES: "garbage",
        COMPILE_CACHE_TTL_DAYS: "3",
      }),
    ).toEqual({ maxObjectBytes: 10, maxRepoBytes: 20 * 1024 * 1024 * 1024, maxExecutionBytes: 10 * 1024 * 1024 * 1024, ttlDays: 3 });
  });
});

describe("sweepCompileCache", () => {
  const DAY = 24 * 3600 * 1000;
  const limits = { maxObjectBytes: 100, maxRepoBytes: 100, maxExecutionBytes: 100, ttlDays: 7 };
  const repoBytes = async (repo: string) =>
    (await ledgers.ledger(repo).reserve({ executionId: "probe", expiresAt: NOW + 1, bytes: 0, maxRepoBytes: 1e12, maxExecutionBytes: 1e12 })).repoBytes;
  const sweep = (bucket: CompileCacheBucket, maxPages?: number) =>
    sweepCompileCache(bucket, limits, NOW_MS, {
      ledger: (repo) => ledgers.ledger(repo),
      ...(maxPages !== undefined ? { maxPages } : {}),
    });

  it("deletes expired entries, evicts the oldest-written to 90% of the ceiling, and records the size", async () => {
    const { bucket, store, seed } = makeBucket(2);
    seed("compile-cache/owner/name/@base/r/t/expired", 10, NOW_MS - 8 * DAY);
    seed("compile-cache/owner/name/@base/r/t/oldest", 40, NOW_MS - 3 * DAY);
    seed("compile-cache/owner/name/@base/r/t/older", 40, NOW_MS - 2 * DAY);
    seed("compile-cache/owner/name/@pr-7/r/t/newest", 40, NOW_MS - 1 * DAY);
    seed("compile-cache/other/repo/@base/r/t/kept", 5, NOW_MS);

    const result = await sweep(bucket);

    expect(result.truncated).toBe(false);
    expect(result.repos).toEqual([
      { repo: "other/repo", bytes: 5, objects: 1, expired: 0, evicted: 0, complete: true },
      { repo: "owner/name", bytes: 80, objects: 2, expired: 1, evicted: 1, complete: true },
    ]);
    expect([...store.keys()].sort()).toEqual([
      "compile-cache/other/repo/@base/r/t/kept",
      "compile-cache/owner/name/@base/r/t/older",
      "compile-cache/owner/name/@pr-7/r/t/newest",
    ]);
    expect(await repoBytes("owner/name")).toBe(80);
    expect(await repoBytes("other/repo")).toBe(5);
  });

  it("resumes where the last tick stopped, so entries past one tick's listing still expire", async () => {
    const { bucket, store, seed } = makeBucket(2);
    for (const repo of ["a/one", "b/two", "c/three"]) {
      seed(`compile-cache/${repo}/@base/r/t/1-expired`, 10, NOW_MS - 8 * DAY);
      seed(`compile-cache/${repo}/@base/r/t/2-kept`, 10, NOW_MS);
      seed(`compile-cache/${repo}/@base/r/t/3-kept`, 10, NOW_MS);
    }

    const first = await sweep(bucket, 2);
    expect(first.truncated).toBe(true);
    expect(first.repos).toEqual([
      { repo: "a/one", bytes: 20, objects: 2, expired: 1, evicted: 0, complete: true },
      { repo: "b/two", bytes: 0, objects: 0, expired: 1, evicted: 0, complete: false },
    ]);
    expect(store.has(SWEEP_STATE_KEY)).toBe(true);

    const second = await sweep(bucket, 3);
    expect(second.truncated).toBe(false);
    expect(second.repos.map((repo) => [repo.repo, repo.complete, repo.expired])).toEqual([
      ["b/two", false, 0],
      ["c/three", true, 1],
    ]);
    expect([...store.keys()].filter((key) => key.includes("expired"))).toEqual([]);
    expect(store.has(SWEEP_STATE_KEY)).toBe(false);
  });

  it("releases the bytes it deletes from a repository it could not list whole", async () => {
    const { bucket, seed } = makeBucket(1);
    await ledgers.ledger("a/one").reserve({ executionId: "x", expiresAt: NOW + 60, bytes: 50, maxRepoBytes: 100, maxExecutionBytes: 100 });
    seed("compile-cache/a/one/@base/r/t/1-expired", 30, NOW_MS - 8 * DAY);
    seed("compile-cache/a/one/@base/r/t/2-kept", 20, NOW_MS);
    const result = await sweep(bucket, 1);
    expect(result.repos).toEqual([{ repo: "a/one", bytes: 0, objects: 0, expired: 1, evicted: 0, complete: false }]);
    expect(await repoBytes("a/one")).toBe(20);
  });
});

describe("compileCacheOverrides", () => {
  const mint = {
    lane: "pr-7" as CompileCacheLane | undefined,
    repo: "owner/name",
    executionId: EXEC,
    createdAtMs: NOW_MS,
    ceilingSec: 5400 + 4500,
    publicOrigin: "https://dispatch.example/",
    secret: SECRET,
  };

  it("hands the run the endpoint and a token valid until creation plus the ceiling", async () => {
    const minted = await compileCacheOverrides(mint);
    expect(minted?.expiresAt).toBe(NOW + 9900);
    expect(minted?.lane).toBe("pr-7");
    expect(minted?.overrides["compile-cache.endpoint"]).toBe("https://dispatch.example/v1/compile-cache");
    const verdict = await verifyCompileCacheToken(SECRET, "owner/name", minted!.overrides["compile-cache.token"]!, NOW);
    expect(verdict).toEqual({ ok: true, scope: { repo: "owner/name", executionId: EXEC, lane: "pr-7", expiresAt: NOW + 9900 } });
  });

  it("mints the same token on every invocation of one execution", async () => {
    expect(await compileCacheOverrides(mint)).toEqual(await compileCacheOverrides(mint));
  });

  it("mints nothing for a run that does not want the cache or a deploy that cannot serve it", async () => {
    expect(await compileCacheOverrides({ ...mint, lane: undefined })).toBeUndefined();
    expect(await compileCacheOverrides({ ...mint, publicOrigin: undefined })).toBeUndefined();
    expect(await compileCacheOverrides({ ...mint, secret: undefined })).toBeUndefined();
  });
});
