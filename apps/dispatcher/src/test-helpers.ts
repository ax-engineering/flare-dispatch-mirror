// FlareDispatch Dispatcher — test fixtures.
//
// PR5 acceptance is exercised by invoking the `fetch` handler with a hand-built
// `Request` against a fake `Env` — NOT `@cloudflare/vitest-pool-workers`, which
// needs Vitest 3 (the repo is pinned to Vitest 2). The fakes here are the
// minimum binding surface the routes touch:
//
//   * RUNS_WORKFLOW.create  — records the `{ id, params }` it was called with.
//   * RUNS_STORAGE          — an in-memory `Map`-backed R2 stand-in (get/put).
//
// Only the methods the routes call are implemented; the rest are cast away.

import type { Env } from "./env";

/** A recorded `RUNS_WORKFLOW.create({ id, params })` call. */
type WorkflowCreateCall = { readonly id: string; readonly params: unknown };

/** A recorded `RUNS_WORKFLOW.get(id).sendEvent({type, payload})` call. */
type WorkflowSendEventCall = {
  readonly wfId: string;
  readonly type: string;
  readonly payload: unknown;
};

/** A fake `RUNS_WORKFLOW` that records create + sendEvent calls. */
export interface FakeWorkflow {
  readonly binding: Env["RUNS_WORKFLOW"];
  readonly calls: WorkflowCreateCall[];
  readonly events: WorkflowSendEventCall[];
}

export const makeFakeWorkflow = (
  opts: {
    rejectSendEventFor?: ReadonlySet<string>;
    /**
     * Ids that `create` should reject with the same shape CF Workflows
     * raises on duplicate-id creates: `Error: (instance.already_exists)
     * Instance already exists`. Used to exercise the dispatcher's
     * duplicate-create catch.
     */
    throwAlreadyExistsFor?: ReadonlySet<string>;
    /**
     * The status `get(id).status()` reports per instance id; `undefined` makes
     * the status read reject the way the platform does for an id it has no
     * instance for. Omitted → every id reports `running`.
     */
    instanceStatus?: (id: string) => string | undefined;
  } = {},
): FakeWorkflow => {
  const calls: WorkflowCreateCall[] = [];
  const events: WorkflowSendEventCall[] = [];
  const reject = opts.rejectSendEventFor ?? new Set<string>();
  const alreadyExists = opts.throwAlreadyExistsFor ?? new Set<string>();
  const statusOf = async (id: string) => {
    const status = opts.instanceStatus === undefined ? "running" : opts.instanceStatus(id);
    if (status === undefined) throw new Error(`instance.not_found: ${id}`);
    return { status };
  };
  const binding = {
    create: async (options?: { id?: string; params?: unknown }) => {
      const id = options?.id ?? "";
      if (alreadyExists.has(id)) {
        throw new Error(`(instance.already_exists) Instance already exists`);
      }
      calls.push({
        id,
        params: options?.params,
      });
      return {
        id,
        status: async () => ({ status: "queued" }),
      };
    },
    get: (id: string) => ({
      id,
      status: () => statusOf(id),
      sendEvent: async (e: { type: string; payload: unknown }) => {
        if (reject.has(id)) {
          throw new Error(`unknown_instance: ${id}`);
        }
        events.push({ wfId: id, type: e.type, payload: e.payload });
      },
    }),
  } as unknown as Env["RUNS_WORKFLOW"];
  return { binding, calls, events };
};

/** A stored object in the fake R2 bucket. */
type StoredObject = {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly uploaded: Date;
};

/** A fake `RUNS_STORAGE` (R2) backed by an in-memory Map. */
export interface FakeR2 {
  readonly binding: Env["RUNS_STORAGE"];
  /** Seed an object the way `R2ArtifactLive.upload` would. */
  put(key: string, body: string, contentType?: string): void;
}

export const makeFakeR2 = (): FakeR2 => {
  const store = new Map<string, StoredObject>();
  const encoder = new TextEncoder();
  // Each put lands one millisecond after the last, so `uploaded` follows write order.
  let clock = 0;

  const binding = {
    get: async (key: string) => {
      const obj = store.get(key);
      if (obj === undefined) return null;
      return {
        key,
        body: new Response(obj.body).body,
        httpEtag: `"fake-etag-${key}"`,
        httpMetadata: { contentType: obj.contentType },
        writeHttpMetadata: (headers: Headers) => {
          headers.set("content-type", obj.contentType);
        },
        arrayBuffer: async () =>
          obj.body.buffer.slice(obj.body.byteOffset, obj.body.byteOffset + obj.body.byteLength),
      };
    },
    // Prefix listing — what the artifacts route's directory index uses.
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      objects: Array.from(store.entries())
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, obj]) => ({ key, size: obj.body.byteLength, uploaded: obj.uploaded })),
      truncated: false,
    }),
  } as unknown as Env["RUNS_STORAGE"];

  return {
    binding,
    put: (key, body, contentType = "application/octet-stream") => {
      clock += 1;
      store.set(key, { body: encoder.encode(body), contentType, uploaded: new Date(clock) });
    },
  };
};

/** A seedable in-memory D1 stand-in for the read-side queries. */
export interface FakeD1 {
  readonly binding: Env["RUNS_METADATA"];
  readonly executions: Record<string, unknown>[];
  readonly steps: Record<string, unknown>[];
}

/**
 * A minimal `D1Database` fake for the executions/logs read routes. It does not
 * parse arbitrary SQL — it interprets the handful of statement shapes
 * `executions-read.ts` emits: a `WHERE col = ?` / `col < ?` chain (binds in
 * column order) plus an optional trailing `LIMIT ?`. Seed rows with snake_case
 * columns matching the schema.
 */
export const makeFakeD1 = (seed?: {
  executions?: Record<string, unknown>[];
  steps?: Record<string, unknown>[];
}): FakeD1 => {
  const executions = seed?.executions ?? [];
  const steps = seed?.steps ?? [];

  const matches = (
    row: Record<string, unknown>,
    col: string,
    op: string,
    val: unknown,
  ): boolean => {
    const cell = row[col];
    if (op === "=") return String(cell) === String(val);
    if (op === "<") return cell != null && Number(cell) < Number(val);
    return true;
  };

  const query = (sql: string, binds: unknown[]): Record<string, unknown>[] => {
    const source = /FROM\s+steps/.test(sql) ? steps : executions;
    const hasLimit = /LIMIT\s*\?/.test(sql);
    // The composite keyset shape `listExecutions` emits for the same-ms
    // tiebreak: `(started_at < ?) OR (started_at = ? AND id < ?)`. Its three
    // `?`s bind in string order like any other condition, but it is ONE logical
    // predicate, not three AND-ed ones.
    const composite = /\((\w+)\s*<\s*\?\)\s*OR\s*\((\w+)\s*=\s*\?\s*AND\s*(\w+)\s*<\s*\?/.exec(sql);

    const conditions: { col: string; op: string; bind: unknown }[] = [];
    let bindIdx = 0;
    let compositeBinds: unknown[] | null = null;
    for (const m of sql.matchAll(/(\w+)\s*(=|<)\s*\?/g)) {
      if (composite !== null && (m.index ?? 0) >= composite.index) {
        if (compositeBinds === null) compositeBinds = binds.slice(bindIdx, bindIdx + 3);
        bindIdx += 3;
        continue;
      }
      conditions.push({ col: m[1]!, op: m[2]!, bind: binds[bindIdx] });
      bindIdx += 1;
    }

    let rows = source.filter((row) => conditions.every((c) => matches(row, c.col, c.op, c.bind)));
    if (compositeBinds !== null) {
      const [lt, eq, idLt] = compositeBinds as unknown[];
      rows = rows.filter((row) => {
        const older = matches(row, "started_at", "<", lt);
        const sameMs = matches(row, "started_at", "=", eq);
        const idBefore = String(row["id"]) < String(idLt);
        return older || (sameMs && idBefore);
      });
    }
    const limit = hasLimit ? Number(binds[bindIdx]) : Infinity;
    if (/FROM\s+executions/.test(sql)) {
      rows = [...rows].sort((a, b) => Number(b["started_at"] ?? 0) - Number(a["started_at"] ?? 0));
    } else {
      rows = [...rows].sort((a, b) => Number(a["started_at"] ?? 0) - Number(b["started_at"] ?? 0));
    }
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  };

  const binding = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        all: async () => ({ results: query(sql, binds), success: true }),
        first: async () => query(sql, binds)[0] ?? null,
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as Env["RUNS_METADATA"];

  return { binding, executions, steps };
};

/** A fake KV namespace backed by an in-memory Map — get/put/delete only. */
export interface FakeKv {
  readonly binding: KVNamespace;
  /** Inspect stored entries. */
  readonly store: Map<string, string>;
}

export const makeFakeKv = (): FakeKv => {
  const store = new Map<string, string>();
  const binding = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: Array.from(store.keys()).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
  } as unknown as KVNamespace;
  return { binding, store };
};

/** Build a fake `Env` with the given HMAC secret and binding fakes. */
export const makeFakeEnv = (opts: {
  hmacSecret: string;
  workflow: FakeWorkflow;
  storage: FakeR2;
  idempotencyKv?: KVNamespace;
  configKv?: KVNamespace;
  githubWebhookSecret?: string;
  /** `GITHUB_APP_ID` — the App a check-run re-run must belong to. */
  githubAppId?: string;
  adminToken?: string;
  logLinkSecret?: string;
  metadata?: FakeD1;
  publicOrigin?: string;
  cloudflareAccountId?: string;
  /**
   * Viewer Cloudflare-Access mode (access-auth.ts). Defaults to "token-only" —
   * the local/no-Access-app equivalent — so router-driven tests exercise the
   * capability-token gate, not the Access gate (which has its own unit tests).
   * Pass "required" to drive the Access path through `handleRequest`.
   */
  viewerAccessMode?: "required" | "token-only";
  /** Workers Static Assets binding — the SPA shell source for `/` navigations. */
  assets?: Fetcher;
}): Env =>
  ({
    HMAC_SECRET: opts.hmacSecret,
    VIEWER_ACCESS_MODE: opts.viewerAccessMode ?? "token-only",
    RUNS_WORKFLOW: opts.workflow.binding,
    RUNS_STORAGE: opts.storage.binding,
    ...(opts.idempotencyKv !== undefined ? { IDEMPOTENCY_KV: opts.idempotencyKv } : {}),
    ...(opts.configKv !== undefined ? { CONFIG_KV: opts.configKv } : {}),
    ...(opts.githubWebhookSecret !== undefined
      ? { GITHUB_WEBHOOK_SECRET: opts.githubWebhookSecret }
      : {}),
    ...(opts.githubAppId !== undefined ? { GITHUB_APP_ID: opts.githubAppId } : {}),
    ...(opts.adminToken !== undefined ? { ADMIN_TOKEN: opts.adminToken } : {}),
    ...(opts.logLinkSecret !== undefined ? { LOG_LINK_SECRET: opts.logLinkSecret } : {}),
    ...(opts.publicOrigin !== undefined ? { PUBLIC_ORIGIN: opts.publicOrigin } : {}),
    ...(opts.cloudflareAccountId !== undefined
      ? { CLOUDFLARE_ACCOUNT_ID: opts.cloudflareAccountId }
      : {}),
    ...(opts.assets !== undefined ? { ASSETS: opts.assets } : {}),
    // Not exercised by PR5 routes — cast away.
    RUNS_SANDBOX: {} as Env["RUNS_SANDBOX"],
    RUNS_METADATA: (opts.metadata?.binding ?? {}) as Env["RUNS_METADATA"],
  }) satisfies Env;
