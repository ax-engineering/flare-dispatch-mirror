// D1ExecutionsLive under transient D1 faults.
//
// Every write the layer issues is idempotent (`INSERT OR IGNORE`, plain
// `UPDATE`), so a transient rejection is retried rather than killing the run.
// The terminal `finishExecution` is the write whose loss strands an execution
// in `running` — the parent's join and the check-run both wait on it.

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { Executions } from "@fractalboxdev/flare-dispatch-core";
import { makeD1ExecutionsLive } from "./executions-d1";

/** A D1 stub whose `run()` rejects the first `failures` calls, then resolves. */
const flakyDb = (failures: number) => {
  let calls = 0;
  const statement = {
    bind: () => statement,
    run: async () => {
      calls++;
      if (calls <= failures) throw new Error("D1_ERROR: Network connection lost.");
      return { success: true, meta: { changes: 1 }, results: [] };
    },
  };
  return {
    db: { prepare: () => statement } as unknown as D1Database,
    calls: () => calls,
  };
};

const CTX = { repo: "o/n", ref: "refs/heads/main", sha: "sha", input: {} };

const finish = (db: D1Database) =>
  Effect.runPromiseExit(
    Effect.flatMap(Executions, (e) =>
      e.finishExecution({ id: "exec-1", completedAt: 2000, status: "failure" }),
    ).pipe(Effect.provide(makeD1ExecutionsLive(db, CTX))),
  );

describe("D1ExecutionsLive transient faults", () => {
  it("retries a rejected terminal write until it lands", async () => {
    const d1 = flakyDb(3);
    const exit = await finish(d1.db);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(d1.calls()).toBe(4);
  });

  it("dies after a bounded number of attempts", async () => {
    const d1 = flakyDb(Number.POSITIVE_INFINITY);
    const exit = await finish(d1.db);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(d1.calls()).toBe(6);
  }, 20_000);
});
