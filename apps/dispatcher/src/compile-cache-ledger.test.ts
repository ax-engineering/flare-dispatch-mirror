// The compile-cache ledger: the per-repository byte count every PUT reserves
// against, and the per-execution budget and end marker that stop a token's
// writes.

import { describe, expect, it } from "vitest";
import { type LedgerStorage, makeCompileCacheLedger } from "./compile-cache-ledger";

const memoryStorage = (): LedgerStorage & { readonly map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>(opts: { prefix: string }) =>
      new Map([...map].filter(([key]) => key.startsWith(opts.prefix)) as [string, T][]),
  };
};

const NOW = 1_800_000_000;
const bounds = { maxRepoBytes: 100, maxExecutionBytes: 60 };
const reserve = (executionId: string, bytes: number) => ({ executionId, expiresAt: NOW + 3600, bytes, ...bounds });

describe("compile-cache ledger", () => {
  it("admits writes until the repository bound and counts every admitted byte", async () => {
    const ledger = makeCompileCacheLedger(memoryStorage());
    expect(await ledger.reserve(reserve("a", 50))).toEqual({ ok: true, repoBytes: 50 });
    expect(await ledger.reserve(reserve("b", 50))).toEqual({ ok: true, repoBytes: 100 });
    expect(await ledger.reserve(reserve("c", 1))).toEqual({ ok: false, reason: "repository", repoBytes: 100 });
  });

  it("refuses an execution's write past its own budget while other executions still write", async () => {
    const ledger = makeCompileCacheLedger(memoryStorage());
    expect(await ledger.reserve(reserve("a", 60))).toEqual({ ok: true, repoBytes: 60 });
    expect(await ledger.reserve(reserve("a", 1))).toEqual({ ok: false, reason: "execution", repoBytes: 60 });
    expect(await ledger.reserve(reserve("b", 10))).toEqual({ ok: true, repoBytes: 70 });
  });

  it("refuses every write of an execution that ended, before or after its first write", async () => {
    const ledger = makeCompileCacheLedger(memoryStorage());
    await ledger.reserve(reserve("a", 10));
    await ledger.end({ executionId: "a", expiresAt: NOW + 3600 });
    expect(await ledger.reserve(reserve("a", 1))).toEqual({ ok: false, reason: "ended", repoBytes: 10 });
    await ledger.end({ executionId: "never-wrote", expiresAt: NOW + 3600 });
    expect(await ledger.reserve(reserve("never-wrote", 1))).toEqual({ ok: false, reason: "ended", repoBytes: 10 });
  });

  it("subtracts released bytes, never below zero", async () => {
    const ledger = makeCompileCacheLedger(memoryStorage());
    await ledger.reserve(reserve("a", 40));
    expect(await ledger.release({ bytes: 30, nowSec: NOW })).toBe(10);
    expect(await ledger.release({ bytes: 30, nowSec: NOW })).toBe(0);
  });

  it("replaces the count with a measured size and forgets executions whose tokens expired", async () => {
    const storage = memoryStorage();
    const ledger = makeCompileCacheLedger(storage);
    await ledger.reserve({ ...reserve("old", 10), expiresAt: NOW - 1 });
    await ledger.reserve(reserve("live", 10));
    expect(await ledger.measure({ bytes: 75, nowSec: NOW })).toBe(75);
    expect([...storage.map.keys()].filter((key) => key.startsWith("x:"))).toEqual(["x:live"]);
    expect(await ledger.reserve(reserve("live", 25))).toEqual({ ok: true, repoBytes: 100 });
  });
});
