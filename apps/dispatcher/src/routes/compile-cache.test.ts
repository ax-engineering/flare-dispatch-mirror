// `/v1/compile-cache/…` — the WebDAV subset sccache's backend issues, its
// token scope, its bounds, and the sweep that holds each prefix to its ceiling.

import { describe, expect, it } from "vitest";
import {
  compileCacheOverrides,
  signCompileCacheToken,
  verifyCompileCacheToken,
} from "../compile-cache-token";
import type { Env } from "../env";
import { handleRequest } from "../router";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import {
  type CompileCacheBucket,
  handleCompileCache,
  parseCompileCachePath,
  resolveCompileCacheLimits,
  sweepCompileCache,
  usageKey,
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
      const keys = [...store.keys()].filter((key) => key.startsWith(opts.prefix ?? "")).sort();
      const start = opts.cursor === undefined ? 0 : Number(opts.cursor);
      const page = keys.slice(start, start + Math.min(pageSize, opts.limit ?? 1000));
      const next = start + page.length;
      return {
        objects: page.map((key) => meta(key, store.get(key)!)),
        truncated: next < keys.length,
        ...(next < keys.length ? { cursor: String(next) } : {}),
      };
    },
  } as unknown as CompileCacheBucket;
  const seed = (key: string, size: number, uploadedMs: number) =>
    store.set(key, { body: new Uint8Array(size), uploaded: new Date(uploadedMs) });
  return { bucket, store, seed };
};

const envWith = (bucket: CompileCacheBucket, over: Partial<Env> = {}) => ({
  HMAC_SECRET: SECRET,
  RUNS_STORAGE: bucket,
  ...over,
});

const token = (over: { repo?: string; expiresAt?: number } = {}) =>
  signCompileCacheToken(SECRET, {
    repo: over.repo ?? "owner/name",
    executionId: EXEC,
    expiresAt: over.expiresAt ?? NOW + 3600,
  });

const call = async (
  bucket: CompileCacheBucket,
  method: string,
  url: string,
  opts: { token?: string | null; body?: string; headers?: Record<string, string>; env?: Partial<Env> } = {},
) => {
  const bearer = opts.token === undefined ? await token() : opts.token;
  const headers: Record<string, string> = { ...opts.headers };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  if (opts.body !== undefined && headers["content-length"] === undefined)
    headers["content-length"] = String(new TextEncoder().encode(opts.body).length);
  return handleCompileCache(
    new Request(url, { method, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) }),
    envWith(bucket, opts.env),
    { now: () => NOW_MS },
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
    const [v, , exec, mac] = minted.split(".");
    const res = await call(makeBucket().bucket, "GET", `${BASE}/a/b/c/abc`, { token: `${v}.${NOW + 999_999}.${exec}.${mac}` });
    expect(res.status).toBe(403);
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
    expect(verdict).toEqual({ ok: true, scope: { repo: "owner/name", executionId: EXEC, expiresAt: NOW + 3600 } });
  });
});

describe("compile-cache WebDAV", () => {
  it("stores a PUT under the repository prefix and serves it to GET, HEAD and PROPFIND", async () => {
    const { bucket, store } = makeBucket();
    const put = await call(bucket, "PUT", `${BASE}/a/b/c/abcdef`, { body: "rlib-bytes" });
    expect(put.status).toBe(201);
    expect([...store.keys()]).toEqual(["compile-cache/owner/name/1.90.0/x86_64-unknown-linux-gnu/a/b/c/abcdef"]);

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

  it("refuses a PUT once the measured prefix plus the entry exceeds the repository bound", async () => {
    const { bucket, store } = makeBucket();
    await bucket.put(usageKey("owner/name"), "", { customMetadata: { bytes: "95" } });
    const res = await call(bucket, "PUT", `${BASE}/a/b/c/x`, {
      body: "0123456789",
      env: { COMPILE_CACHE_MAX_REPO_BYTES: "100" },
    });
    expect(res.status).toBe(507);
    expect([...store.keys()]).toEqual([usageKey("owner/name")]);
  });

  it("rejects paths that escape or skip the repository", () => {
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/../other/x")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/%2e%2e/x")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/a//b")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner")).toBeUndefined();
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/")).toEqual({
      repo: "owner/name",
      key: "compile-cache/owner/name/",
      collection: true,
    });
    expect(parseCompileCachePath("/v1/compile-cache/owner/name/.sccache_check")).toEqual({
      repo: "owner/name",
      key: "compile-cache/owner/name/.sccache_check",
      collection: false,
    });
  });

  it("is reachable through the dispatcher router", async () => {
    const env = makeFakeEnv({ hmacSecret: SECRET, workflow: makeFakeWorkflow(), storage: makeFakeR2() });
    const res = await handleRequest(new Request(`${BASE}/a/b/c/abc`), env);
    expect(res.status).toBe(401);
  });
});

describe("compile-cache limits", () => {
  it("records its defaults and reads overrides from the Worker vars", () => {
    expect(resolveCompileCacheLimits({})).toEqual({
      maxObjectBytes: 100 * 1024 * 1024,
      maxRepoBytes: 20 * 1024 * 1024 * 1024,
      ttlDays: 14,
    });
    expect(
      resolveCompileCacheLimits({
        COMPILE_CACHE_MAX_OBJECT_BYTES: "10",
        COMPILE_CACHE_MAX_REPO_BYTES: "garbage",
        COMPILE_CACHE_TTL_DAYS: "3",
      }),
    ).toEqual({ maxObjectBytes: 10, maxRepoBytes: 20 * 1024 * 1024 * 1024, ttlDays: 3 });
  });
});

describe("sweepCompileCache", () => {
  const DAY = 24 * 3600 * 1000;
  const limits = { maxObjectBytes: 100, maxRepoBytes: 100, ttlDays: 7 };

  it("deletes expired entries, evicts the oldest-written to 90% of the ceiling, and records the size", async () => {
    const { bucket, store, seed } = makeBucket(2);
    seed("compile-cache/owner/name/r/t/expired", 10, NOW_MS - 8 * DAY);
    seed("compile-cache/owner/name/r/t/oldest", 40, NOW_MS - 3 * DAY);
    seed("compile-cache/owner/name/r/t/older", 40, NOW_MS - 2 * DAY);
    seed("compile-cache/owner/name/r/t/newest", 40, NOW_MS - 1 * DAY);
    seed("compile-cache/other/repo/r/t/kept", 5, NOW_MS);

    const result = await sweepCompileCache(bucket, limits, NOW_MS);

    expect(result.truncated).toBe(false);
    expect(result.repos).toEqual([
      { repo: "other/repo", bytes: 5, objects: 1, expired: 0, evicted: 0 },
      { repo: "owner/name", bytes: 80, objects: 2, expired: 1, evicted: 1 },
    ]);
    expect([...store.keys()].filter((key) => key.startsWith("compile-cache/")).sort()).toEqual([
      "compile-cache/other/repo/r/t/kept",
      "compile-cache/owner/name/r/t/newest",
      "compile-cache/owner/name/r/t/older",
    ]);
    expect(store.get(usageKey("owner/name"))?.customMetadata?.bytes).toBe("80");
  });

  it("deletes the usage record of a prefix that no longer holds entries", async () => {
    const { bucket, store } = makeBucket();
    await bucket.put(usageKey("gone/repo"), "", { customMetadata: { bytes: "999" } });
    await sweepCompileCache(bucket, limits, NOW_MS);
    expect(store.has(usageKey("gone/repo"))).toBe(false);
  });
});

describe("compileCacheOverrides", () => {
  const mint = {
    wanted: true,
    repo: "owner/name",
    executionId: EXEC,
    createdAtMs: NOW_MS,
    ceilingSec: 5400 + 4500,
    publicOrigin: "https://dispatch.example/",
    secret: SECRET,
  };

  it("hands the run the endpoint and a token valid until creation plus the ceiling", async () => {
    const overrides = await compileCacheOverrides(mint);
    expect(overrides?.["compile-cache.endpoint"]).toBe("https://dispatch.example/v1/compile-cache");
    const verdict = await verifyCompileCacheToken(SECRET, "owner/name", overrides!["compile-cache.token"]!, NOW);
    expect(verdict).toEqual({ ok: true, scope: { repo: "owner/name", executionId: EXEC, expiresAt: NOW + 9900 } });
  });

  it("mints the same token on every invocation of one execution", async () => {
    expect(await compileCacheOverrides(mint)).toEqual(await compileCacheOverrides(mint));
  });

  it("mints nothing for a run that does not want the cache or a deploy that cannot serve it", async () => {
    expect(await compileCacheOverrides({ ...mint, wanted: false })).toBeUndefined();
    expect(await compileCacheOverrides({ ...mint, publicOrigin: undefined })).toBeUndefined();
    expect(await compileCacheOverrides({ ...mint, secret: undefined })).toBeUndefined();
  });
});
