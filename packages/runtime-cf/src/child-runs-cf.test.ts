// Unit tests for ChildRunsCloudflare — the live `childRuns` capability.
//
// Drives `makeChildRunsLive` against an in-memory `Workflow`-binding stub (no
// Miniflare needed — `spawn` only calls `create({id, params})`). Pins: the child
// payload shape, deterministic + idempotent ids, the `already_exists` → created:
// false contract, and `ChildSpawnFailed` on any other create rejection.

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildRuns } from "@fractalboxdev/flare-dispatch-core";
import {
  type ChildRunsLiveConfig,
  deriveChildInstanceId,
  makeChildRunsLive,
  type WorkflowBindingLike,
} from "./child-runs-cf";
import { makeTestBindings, type TestBindings } from "./test-support";

type CreateCall = { id: string; params: unknown };

/** A D1 stub good enough for spawn-only tests (poll is covered with Miniflare). */
const NO_DB = {
  prepare: () => {
    throw new Error("poll not exercised in this test");
  },
} as unknown as D1Database;

/** A `Workflow` stub recording every `create` call; optionally throwing. */
const makeWorkflowStub = (opts?: {
  throwOn?: (id: string) => unknown;
}): WorkflowBindingLike & { calls: CreateCall[] } => {
  const calls: CreateCall[] = [];
  return {
    calls,
    create: async ({ id, params }) => {
      calls.push({ id, params });
      const thrown = opts?.throwOn?.(id);
      if (thrown !== undefined) throw thrown;
      return { id };
    },
  };
};

const CFG = (
  workflow: WorkflowBindingLike,
  over?: Partial<ChildRunsLiveConfig>,
): ChildRunsLiveConfig => ({
  workflow,
  db: NO_DB,
  parentExecutionId: "parent-exec-001",
  github: {
    repo: "owner/name",
    ref: "refs/heads/main",
    sha: "abc123def456",
    installationId: 99,
  },
  ...over,
});

const spawn = (
  cfg: ChildRunsLiveConfig,
  opts: { run: string; input: unknown; instanceId?: string },
) =>
  Effect.runPromiseExit(
    Effect.flatMap(ChildRuns, (c) => c.spawn(opts)).pipe(Effect.provide(makeChildRunsLive(cfg))),
  );

const handoff = (cfg: ChildRunsLiveConfig) =>
  Effect.runPromise(
    Effect.flatMap(ChildRuns, (c) => c.handoffAdmission()).pipe(
      Effect.provide(makeChildRunsLive(cfg)),
    ),
  );

describe("makeChildRunsLive", () => {
  it("hands off the parent's admission row; a repeated handoff is safe", async () => {
    const deleted: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({ sql, values }),
      }),
      batch: async (statements: { sql: string; values: unknown[] }[]) => {
        deleted.push(String(statements[0]?.values[0]));
        return [];
      },
    } as unknown as D1Database;
    const cfg = CFG(makeWorkflowStub(), { db });
    await handoff(cfg);
    await handoff(cfg);
    expect(deleted).toEqual(["parent-exec-001", "parent-exec-001"]);
  });

  it("creates a child with the DispatchPayload shape the parent inherits", async () => {
    const wf = makeWorkflowStub();
    const exit = await spawn(CFG(wf), {
      run: "pr-review",
      input: { pr: 42 },
      instanceId: "pr-review:owner_name:42",
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(wf.calls).toHaveLength(1);
    const call = wf.calls[0]!;
    expect(call.id).toBe("pr-review_owner_name_42");
    // id is BOTH the instance id and the child's executionId (dispatch contract).
    expect(call.params).toEqual({
      executionId: "pr-review_owner_name_42",
      run: "pr-review",
      github: {
        repo: "owner/name",
        ref: "refs/heads/main",
        sha: "abc123def456",
        installation_id: 99,
      },
      inputs: { pr: 42 },
      parentExecutionId: "parent-exec-001",
    });
  });

  it("forwards the parent's public origin into the child payload", async () => {
    const wf = makeWorkflowStub();
    await spawn(CFG(wf, { origin: "https://dispatcher.example" }), {
      run: "shard",
      input: {},
      instanceId: "shard-1",
    });
    expect(wf.calls[0]!.params).toMatchObject({
      origin: "https://dispatcher.example",
    });
    // And absent origin stays absent (no `origin: undefined` key).
    await spawn(CFG(wf), { run: "shard", input: {}, instanceId: "shard-2" });
    expect(wf.calls[1]!.params).not.toHaveProperty("origin");
  });

  it("omits installation_id when the parent has none", async () => {
    const wf = makeWorkflowStub();
    await spawn(CFG(wf, { github: { repo: "o/n", ref: "r", sha: "s" } }), {
      run: "x",
      input: {},
      instanceId: "x-1",
    });
    expect(wf.calls[0]!.params).not.toHaveProperty("github.installation_id");
    expect((wf.calls[0]!.params as { github: object }).github).toEqual({
      repo: "o/n",
      ref: "r",
      sha: "s",
    });
  });

  it("derives a deterministic id from parent + run + input when none is given", async () => {
    const wf = makeWorkflowStub();
    await spawn(CFG(wf), { run: "shard", input: { i: 1 } });
    await spawn(CFG(wf), { run: "shard", input: { i: 1 } });
    await spawn(CFG(wf), { run: "shard", input: { i: 2 } });

    // Same (parent, run, input) → same id; different input → different id.
    expect(wf.calls[0]!.id).toBe(wf.calls[1]!.id);
    expect(wf.calls[0]!.id).not.toBe(wf.calls[2]!.id);
    // And it matches the exported deriver.
    expect(wf.calls[0]!.id).toBe(
      deriveChildInstanceId({
        run: "shard",
        parentExecutionId: "parent-exec-001",
        input: { i: 1 },
      }),
    );
  });

  it("uses Cloudflare's instance-id alphabet for explicit and derived children", () => {
    for (const id of [
      deriveChildInstanceId({ run: "check", parentExecutionId: "contextful-gate_390_sha", input: { stage: "pins" } }),
      deriveChildInstanceId({ run: "check", parentExecutionId: "parent", input: {}, instanceId: "review:owner/repo:42" }),
    ]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it("treats a duplicate instance as created: false, not a failure", async () => {
    const wf = makeWorkflowStub({
      throwOn: () => new Error("instance.already_exists: duplicate id"),
    });
    const exit = await spawn(CFG(wf), {
      run: "pr-review",
      input: {},
      instanceId: "dup",
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        executionId: "dup",
        instanceId: "dup",
        created: false,
      });
    }
  });

  it("fails with ChildSpawnFailed on any other create rejection", async () => {
    const wf = makeWorkflowStub({
      throwOn: () => new Error("rate_limited: too many instances"),
    });
    const exit = await spawn(CFG(wf), {
      run: "pr-review",
      input: {},
      instanceId: "boom",
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause.toString();
      expect(err).toContain("ChildSpawnFailed");
    }
  });

  it("keeps a long derived id within the 64-char CF instance-id limit", () => {
    const id = deriveChildInstanceId({
      run: "a-very-long-run-name-that-keeps-going-and-going-and-going",
      parentExecutionId: "01HXXXXXXXXXXXXXXXXXXXXXXXXX-with-a-long-suffix-too",
      input: { lots: "of", data: [1, 2, 3, 4, 5] },
    });
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).not.toMatch(/[/\s]/);
  });
});

describe("makeChildRunsLive.poll (live D1 via Miniflare)", () => {
  let bindings: TestBindings;
  // A no-op Workflow stub — poll never touches it.
  const wf: WorkflowBindingLike = { create: async () => ({}) };

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  /** Insert one executions row directly (bypassing the service). */
  const insertRow = (row: {
    id: string;
    status: string;
    summaryJson?: string;
    parentExecutionId?: string;
  }) =>
    bindings.db
      .prepare(
        `INSERT INTO executions
           (id, run, repo, ref, sha, status, started_at, input_json, summary_json, parent_execution_id)
         VALUES (?, 'shard', 'o/n', 'refs/heads/main', 'sha', ?, 0, '{}', ?, ?)`,
      )
      .bind(row.id, row.status, row.summaryJson ?? null, row.parentExecutionId ?? null)
      .run();

  const poll = (ids: readonly string[]) =>
    Effect.runPromise(
      Effect.flatMap(ChildRuns, (c) => c.poll({ ids })).pipe(
        Effect.provide(
          makeChildRunsLive({
            workflow: wf,
            db: bindings.db,
            parentExecutionId: "parent-1",
            github: { repo: "o/n", ref: "refs/heads/main", sha: "sha" },
          }),
        ),
      ),
    );

  it("maps each id's row to its status, preserving input order; absent → missing", async () => {
    await insertRow({ id: "c-running", status: "running" });
    await insertRow({
      id: "c-success",
      status: "success",
      summaryJson: '{"exitCode":0}',
    });
    await insertRow({ id: "c-failure", status: "failure" });

    const records = await poll(["c-success", "c-missing", "c-running", "c-failure"]);

    expect(records).toEqual([
      { executionId: "c-success", status: "success", summaryJson: '{"exitCode":0}' },
      { executionId: "c-missing", status: "missing" },
      { executionId: "c-running", status: "running" },
      { executionId: "c-failure", status: "failure" },
    ]);
  });

  it("carries the check-run id a child row records", async () => {
    await insertRow({ id: "c-checked", status: "failure" });
    await bindings.db
      .prepare(`UPDATE executions SET check_run_id = 4242 WHERE id = ?`)
      .bind("c-checked")
      .run();
    const [rec] = await poll(["c-checked"]);
    expect(rec).toEqual({ executionId: "c-checked", status: "failure", checkRunId: "4242" });
  });

  it("treats an unrecognized status (queued) as non-terminal running", async () => {
    await insertRow({ id: "c-queued", status: "queued" });
    const [rec] = await poll(["c-queued"]);
    expect(rec).toEqual({ executionId: "c-queued", status: "running" });
  });

  it("returns [] for an empty id list without touching D1", async () => {
    expect(await poll([])).toEqual([]);
  });

  // A child whose Workflow instance ended without writing its terminal row
  // (the terminal D1 write itself failed) never settles in D1. The engine's
  // instance status is the ground truth the parent joins on instead.
  describe("non-terminal rows consult the Workflow instance", () => {
    const engine = (statuses: Record<string, string | Error>): WorkflowBindingLike => ({
      create: async () => ({}),
      get: async (id) => {
        const s = statuses[id];
        if (s instanceof Error) throw s;
        return { status: async () => ({ status: s ?? "running" }) };
      },
    });
    const pollWith = (workflow: WorkflowBindingLike, ids: readonly string[]) =>
      Effect.runPromise(
        Effect.flatMap(ChildRuns, (c) => c.poll({ ids })).pipe(
          Effect.provide(
            makeChildRunsLive({
              workflow,
              db: bindings.db,
              parentExecutionId: "parent-1",
              github: { repo: "o/n", ref: "refs/heads/main", sha: "sha" },
            }),
          ),
        ),
      );

    it("reports failure for a running row whose instance errored or terminated", async () => {
      await insertRow({ id: "c-errored", status: "running" });
      await insertRow({ id: "c-terminated", status: "running" });
      await insertRow({ id: "c-live", status: "running" });
      const records = await pollWith(
        engine({ "c-errored": "errored", "c-terminated": "terminated", "c-live": "running" }),
        ["c-errored", "c-terminated", "c-live"],
      );
      expect(records).toEqual([
        { executionId: "c-errored", status: "failure" },
        { executionId: "c-terminated", status: "failure" },
        { executionId: "c-live", status: "running" },
      ]);
    });

    it("reports failure for an instance that completed without a terminal row", async () => {
      await insertRow({ id: "c-unrecorded", status: "running" });
      const [rec] = await pollWith(engine({ "c-unrecorded": "complete" }), ["c-unrecorded"]);
      expect(rec).toEqual({ executionId: "c-unrecorded", status: "failure" });
    });

    it("re-reads the row when the child records its verdict between the two reads", async () => {
      await insertRow({ id: "c-racing", status: "running" });
      const workflow: WorkflowBindingLike = {
        create: async () => ({}),
        get: async () => ({
          status: async () => {
            await bindings.db
              .prepare(`UPDATE executions SET status = 'success', summary_json = '{}' WHERE id = ?`)
              .bind("c-racing")
              .run();
            return { status: "complete" };
          },
        }),
      };
      const [rec] = await pollWith(workflow, ["c-racing"]);
      expect(rec).toEqual({ executionId: "c-racing", status: "success", summaryJson: "{}" });
    });

    it("reports failure for a missing row whose instance errored before writing it", async () => {
      const [rec] = await pollWith(engine({ "c-boot": "errored" }), ["c-boot"]);
      expect(rec).toEqual({ executionId: "c-boot", status: "failure" });
    });

    it("keeps waiting when the instance lookup fails or is still queued", async () => {
      await insertRow({ id: "c-lookup", status: "running" });
      const records = await pollWith(
        engine({ "c-lookup": new Error("instance.not_found"), "c-new": "queued" }),
        ["c-lookup", "c-new"],
      );
      expect(records).toEqual([
        { executionId: "c-lookup", status: "running" },
        { executionId: "c-new", status: "missing" },
      ]);
    });

    it("never consults the engine for a terminal row", async () => {
      await insertRow({ id: "c-done", status: "success", summaryJson: "{}" });
      const workflow: WorkflowBindingLike = {
        create: async () => ({}),
        get: async () => {
          throw new Error("terminal rows must not reach the engine");
        },
      };
      const [rec] = await pollWith(workflow, ["c-done"]);
      expect(rec).toEqual({ executionId: "c-done", status: "success", summaryJson: "{}" });
    });
  });
});
