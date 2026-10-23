// FlareDispatch Dispatcher — the compile-cache ledger.
//
// One ledger per repository (the `CompileCacheLedger` Durable Object,
// compile-cache-ledger-do.ts, addressed by `idFromName(<owner/name>)`) holds:
//
//   repo        the repository's bytes: every admitted PUT adds its length,
//               the sweep subtracts what it deletes and, after listing the
//               whole repository, replaces the count with the measured size
//   x:<exec>    one execution's admitted bytes, whether it ended, and when
//               its token expires
//
// A PUT reserves its length here before it writes, so the repository bound
// and the per-execution budget hold at admission rather than as of the last
// sweep. The workflow ends an execution's record when the run finishes, which
// refuses that token's further writes. The Durable Object runs one call at a
// time, so two reserves never both pass on the same headroom.
//
// An overwritten key counts twice until the next whole-repository sweep; the
// count errs high, never low.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Shared compile cache.

/** The storage the ledger reads and writes: a Durable Object's `ctx.storage`. */
export type LedgerStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};

type ExecutionRecord = { readonly bytes: number; readonly ended: boolean; readonly expiresAt: number };

const REPO_KEY = "repo";
const EXECUTION_PREFIX = "x:";

export type ReserveRequest = {
  readonly executionId: string;
  /** The token's expiry, epoch seconds: the record is kept until then. */
  readonly expiresAt: number;
  readonly bytes: number;
  readonly maxRepoBytes: number;
  readonly maxExecutionBytes: number;
};

/** A reserve's verdict, with the repository's count after it. */
export type ReserveResult =
  | { readonly ok: true; readonly repoBytes: number }
  | { readonly ok: false; readonly reason: "ended" | "execution" | "repository"; readonly repoBytes: number };

/** The ledger's calls, as the route and the sweep make them. */
export type CompileCacheLedgerApi = {
  reserve(request: ReserveRequest): Promise<ReserveResult>;
  end(request: { readonly executionId: string; readonly expiresAt: number }): Promise<void>;
  release(request: { readonly bytes: number; readonly nowSec: number }): Promise<number>;
  measure(request: { readonly bytes: number; readonly nowSec: number }): Promise<number>;
};

/** The ledger over `storage`. */
export const makeCompileCacheLedger = (storage: LedgerStorage): CompileCacheLedgerApi => {
  const repoBytes = async (): Promise<number> => (await storage.get<number>(REPO_KEY)) ?? 0;
  const forgetExpired = async (nowSec: number): Promise<void> => {
    const records = await storage.list<ExecutionRecord>({ prefix: EXECUTION_PREFIX });
    for (const [key, record] of records) if (record.expiresAt <= nowSec) await storage.delete(key);
  };
  return {
    reserve: async (request) => {
      const key = `${EXECUTION_PREFIX}${request.executionId}`;
      const execution = (await storage.get<ExecutionRecord>(key)) ?? {
        bytes: 0,
        ended: false,
        expiresAt: request.expiresAt,
      };
      const repo = await repoBytes();
      if (execution.ended) return { ok: false, reason: "ended", repoBytes: repo };
      if (execution.bytes + request.bytes > request.maxExecutionBytes)
        return { ok: false, reason: "execution", repoBytes: repo };
      if (repo + request.bytes > request.maxRepoBytes) return { ok: false, reason: "repository", repoBytes: repo };
      await storage.put(key, { ...execution, bytes: execution.bytes + request.bytes });
      await storage.put(REPO_KEY, repo + request.bytes);
      return { ok: true, repoBytes: repo + request.bytes };
    },
    end: async (request) => {
      const key = `${EXECUTION_PREFIX}${request.executionId}`;
      const execution = await storage.get<ExecutionRecord>(key);
      await storage.put(key, {
        bytes: execution?.bytes ?? 0,
        ended: true,
        expiresAt: Math.max(execution?.expiresAt ?? 0, request.expiresAt),
      });
    },
    release: async (request) => {
      const next = Math.max(0, (await repoBytes()) - request.bytes);
      await storage.put(REPO_KEY, next);
      await forgetExpired(request.nowSec);
      return next;
    },
    measure: async (request) => {
      await storage.put(REPO_KEY, request.bytes);
      await forgetExpired(request.nowSec);
      return request.bytes;
    },
  };
};
