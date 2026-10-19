// Integration tests for D1ExecutionsLive — the live `executions` capability.
//
// Runs INSIDE workerd via `@cloudflare/vitest-pool-workers` (see
// `vitest.workers.config.ts` + test-support-workers.ts). Asserts the
// `executions` + `steps` rows the service writes, and pins the per-step D1
// write count (plan § 6 flags D1 hot-path writes — PR4 keeps it bounded).

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executions } from "@fractalboxdev/flare-dispatch-core";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { makeRunSupersedeD1 } from "./run-supersede-d1";
import { countRows, makeTestBindings, type TestBindings } from "./test-support-workers";

const EXECUTION_ID = "01TEST00000000000000000001";
const CTX: ExecutionContext = {
  repo: "owner/name",
  ref: "refs/heads/main",
  sha: "abc123",
  input: { command: "pnpm test" },
};

describe("D1ExecutionsLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("writes one executions row spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 1000,
        });
        yield* executions.finishExecution({
          id: EXECUTION_ID,
          completedAt: 2000,
          status: "success",
        });
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one executions row — start INSERTs, finish UPDATEs the same row.
    expect(await countRows(bindings.db, "executions")).toBe(1);

    const row = await bindings.db
      .prepare(
        `SELECT id, run, repo, ref, sha, status, started_at, completed_at, input_json
           FROM executions WHERE id = ?`,
      )
      .bind(EXECUTION_ID)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      id: EXECUTION_ID,
      run: "offload-test",
      repo: "owner/name",
      ref: "refs/heads/main",
      sha: "abc123",
      status: "success",
      started_at: 1000,
      completed_at: 2000,
    });
    expect(JSON.parse(String(row?.input_json))).toEqual({ command: "pnpm test" });
  });

  it("does not overwrite cancellation with a late run verdict", async () => {
    const executions = await Effect.runPromise(Executions.pipe(Effect.provide(makeD1ExecutionsLive(bindings.db, CTX))));
    const supersessions = makeRunSupersedeD1(bindings.db, () => 1_500);
    await Effect.runPromise(executions.startExecution({ id: EXECUTION_ID, run: "offload-test", startedAt: 1_000 }));
    await Effect.runPromise(supersessions.markCancelled(EXECUTION_ID));
    expect(await Effect.runPromise(executions.finishExecution({ id: EXECUTION_ID, completedAt: 2_000, status: "success" }))).toBe(false);
    expect(await Effect.runPromise(supersessions.status(EXECUTION_ID))).toBe("cancelled");
  });

  it("keeps a finished verdict when cancellation arrives later", async () => {
    const executions = await Effect.runPromise(Executions.pipe(Effect.provide(makeD1ExecutionsLive(bindings.db, CTX))));
    const supersessions = makeRunSupersedeD1(bindings.db, () => 2_000);
    await Effect.runPromise(executions.startExecution({ id: EXECUTION_ID, run: "offload-test", startedAt: 1_000 }));
    expect(await Effect.runPromise(executions.finishExecution({ id: EXECUTION_ID, completedAt: 1_500, status: "success" }))).toBe(true);
    await Effect.runPromise(supersessions.markCancelled(EXECUTION_ID));
    expect(await Effect.runPromise(supersessions.status(EXECUTION_ID))).toBe("success");
  });

  it("records parent_execution_id lineage for a spawned child, NULL for a top-level row", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const childId = "01TEST00000000000000000002";

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        // Top-level execution — no parent.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "matrix-fanout",
          startedAt: 0,
        });
        // Child spawned by it — carries the parent's id.
        yield* executions.startExecution({
          id: childId,
          run: "matrix-fanout-shard",
          startedAt: 1,
          parentExecutionId: EXECUTION_ID,
        });
      }).pipe(Effect.provide(layer)),
    );

    const parent = await bindings.db
      .prepare(`SELECT parent_execution_id FROM executions WHERE id = ?`)
      .bind(EXECUTION_ID)
      .first<{ parent_execution_id: string | null }>();
    expect(parent?.parent_execution_id).toBeNull();

    const child = await bindings.db
      .prepare(`SELECT parent_execution_id FROM executions WHERE id = ?`)
      .bind(childId)
      .first<{ parent_execution_id: string | null }>();
    expect(child?.parent_execution_id).toBe(EXECUTION_ID);
  });

  it("records attempt 1 / NULL retry_of by default, and the lineage a re-run passes", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const rerunId = "01TEST00000000000000000003";

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({ id: EXECUTION_ID, run: "check", startedAt: 0 });
        yield* executions.startExecution({
          id: rerunId,
          run: "check",
          startedAt: 1,
          attempt: 2,
          retryOf: EXECUTION_ID,
        });
      }).pipe(Effect.provide(layer)),
    );

    const lineage = async (id: string) =>
      bindings.db
        .prepare(`SELECT attempt, retry_of FROM executions WHERE id = ?`)
        .bind(id)
        .first<{ attempt: number; retry_of: string | null }>();
    expect(await lineage(EXECUTION_ID)).toEqual({ attempt: 1, retry_of: null });
    expect(await lineage(rerunId)).toEqual({ attempt: 2, retry_of: EXECUTION_ID });
  });

  it("writes one steps row per step, each spanning start → finish", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);
    const stepNames = ["checkout", "exec", "upload-log"];

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        // One start + one finish per step — the inline/CF StepRunner contract.
        for (const name of stepNames) {
          yield* executions.startStep({
            executionId: EXECUTION_ID,
            name,
            startedAt: 10,
          });
          yield* executions.finishStep({
            executionId: EXECUTION_ID,
            name,
            completedAt: 20,
            status: "success",
          });
        }
      }).pipe(Effect.provide(layer)),
    );

    // Exactly one steps row per step — `finishStep` UPDATEs, never INSERTs.
    expect(await countRows(bindings.db, "steps")).toBe(stepNames.length);

    const rows = await bindings.db
      .prepare(
        `SELECT name, status, started_at, completed_at
           FROM steps WHERE execution_id = ? ORDER BY started_at, name`,
      )
      .bind(EXECUTION_ID)
      .all<{ name: string; status: string }>();

    expect(rows.results.map((r) => r.name).sort()).toEqual([...stepNames].sort());
    expect(rows.results.every((r) => r.status === "success")).toBe(true);
  });

  it("is replay-idempotent — repeated startExecution / startStep are no-ops", async () => {
    // A CF Workflow's `run` re-executes on every Worker resume, so the INSERTs
    // here run more than once. Calling `startExecution` twice and `startStep`
    // for the same `(executionId, name)` twice must NOT raise (no PK violation)
    // and must NOT duplicate rows. This is the resume-from-checkpoint guard.
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        // First pass.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 10,
        });
        // Second pass — simulates a Workflow resume re-running `run`.
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 999,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 999,
        });
      }).pipe(Effect.provide(layer)),
    );

    // Still exactly one row each — `INSERT OR IGNORE` collapsed the replays.
    expect(await countRows(bindings.db, "executions")).toBe(1);
    expect(await countRows(bindings.db, "steps")).toBe(1);

    // The IGNOREd second insert did not overwrite the first row's values.
    const exec = await bindings.db
      .prepare(`SELECT started_at FROM executions WHERE id = ?`)
      .bind(EXECUTION_ID)
      .first<{ started_at: number }>();
    expect(exec?.started_at).toBe(0);
  });

  it("records a step failure with its error tag", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({
          executionId: EXECUTION_ID,
          name: "exec",
          startedAt: 10,
        });
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
          errorTag: "ExecFailed",
        });
      }).pipe(Effect.provide(layer)),
    );

    // This assertion is the point of the test and it did not exist: the test
    // passed no `errorTag` and checked only `status`, so it went green through
    // the entire period in which the tag was computed on every failure and
    // dropped — there was no column and the store never read the field (#80).
    const step = await bindings.db
      .prepare(`SELECT status, error_tag FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(EXECUTION_ID, "exec")
      .first<{ status: string; error_tag: string | null }>();
    expect(step?.status).toBe("failure");
    expect(step?.error_tag).toBe("ExecFailed");
  });

  it("keeps a recorded error tag when the step is finished again on replay", async () => {
    const layer = makeD1ExecutionsLive(bindings.db, CTX);

    await Effect.runPromise(
      Effect.gen(function* () {
        const executions = yield* Executions;
        yield* executions.startExecution({
          id: EXECUTION_ID,
          run: "offload-test",
          startedAt: 0,
        });
        yield* executions.startStep({ executionId: EXECUTION_ID, name: "exec", startedAt: 10 });
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
          errorTag: "ExecFailed",
        });
        // A Workflow replay re-runs the surrounding Effect, and the success
        // path carries no tag. A plain assignment would blank the reason.
        yield* executions.finishStep({
          executionId: EXECUTION_ID,
          name: "exec",
          completedAt: 20,
          status: "failure",
        });
      }).pipe(Effect.provide(layer)),
    );

    const step = await bindings.db
      .prepare(`SELECT error_tag FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(EXECUTION_ID, "exec")
      .first<{ error_tag: string | null }>();
    expect(step?.error_tag).toBe("ExecFailed");
  });
});
