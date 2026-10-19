// Integration tests for the D1-backed supersession store against a real D1
// binding inside workerd: the newest member of a group supersedes every older
// pending one, a re-run registration returns the same set, a retry joins without
// superseding, and `cancel` ends rows and frees their admission slots.

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRunAdmissionD1 } from "./run-admission-d1";
import { makeRunSupersedeD1, type RunSupersedeStore } from "./run-supersede-d1";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const G = "contextful-gate:owner/name#7";

describe("makeRunSupersedeD1: supersession against real D1", () => {
  let bindings: TestBindings;
  let clock: number;
  let store: RunSupersedeStore;

  beforeEach(async () => {
    bindings = await makeTestBindings();
    clock = 1_000_000;
    store = makeRunSupersedeD1(bindings.db, () => clock);
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e);
  const insertExecution = (id: string, status: string, parent?: string, checkRunId?: number) =>
    bindings.db
      .prepare(
        `INSERT INTO executions (id, run, repo, ref, sha, status, parent_execution_id, input_json, check_run_id)
         VALUES (?, ?, 'owner/name', 'refs/pull/7/head', 'aaaa', ?, ?, '{}', ?)`,
      )
      .bind(id, parent === undefined ? "contextful-gate" : "check", status, parent ?? null, checkRunId ?? null)
      .run();
  const superseded = async (id: string, group: string, opts: { supersedeOlder: boolean; rank?: number }) =>
    (await run(store.register(id, group, opts))).superseded;
  const executionStatus = async (id: string) =>
    (await bindings.db.prepare(`SELECT status FROM executions WHERE id = ?`).bind(id).first<{ status: string }>())?.status;

  it("supersedes every older pending member, oldest first, and only those", async () => {
    expect(await superseded("exec-a", G, { supersedeOlder: true })).toEqual([]);
    clock += 1;
    expect(await superseded("exec-b", G, { supersedeOlder: true })).toEqual(["exec-a"]);
    clock += 1;
    await superseded("exec-other", "contextful-gate:owner/name#8", { supersedeOlder: true });
    expect(await superseded("exec-c", G, { supersedeOlder: true })).toEqual(["exec-a", "exec-b"]);
  });

  it("transfers pending cancellation to a newer member when the previous canceller stops", async () => {
    await insertExecution("exec-a", "running");
    await insertExecution("exec-b", "running");
    await insertExecution("exec-c", "running");
    expect(await superseded("exec-a", G, { supersedeOlder: true })).toEqual([]);
    clock += 1;
    expect(await superseded("exec-b", G, { supersedeOlder: true })).toEqual(["exec-a"]);
    // B has not cancelled A when C supersedes B.
    // A's run finalizer must not erase its pending cleanup registration.
    await run(store.release("exec-a"));
    clock += 1;
    expect(await superseded("exec-c", G, { supersedeOlder: true })).toEqual(["exec-a", "exec-b"]);
    expect(await superseded("exec-c", G, { supersedeOlder: true })).toEqual(["exec-a", "exec-b"]);
    await run(store.cancel(["exec-a", "exec-b"]));
    expect(await executionStatus("exec-a")).toBe("cancelled");
    expect(await executionStatus("exec-b")).toBe("cancelled");
    expect(await executionStatus("exec-c")).toBe("running");
  });

  it("returns the same superseded set when the registration re-runs", async () => {
    await superseded("exec-a", G, { supersedeOlder: true });
    clock += 1;
    const first = await superseded("exec-b", G, { supersedeOlder: true });
    clock += 1;
    expect(await superseded("exec-b", G, { supersedeOlder: true })).toEqual(first);
  });

  it("joins a re-run without superseding, and the next arrival supersedes it", async () => {
    await superseded("exec-a", G, { supersedeOlder: true });
    clock += 1;
    expect(await superseded("exec-retry", G, { supersedeOlder: false })).toEqual([]);
    clock += 1;
    expect(await superseded("exec-c", G, { supersedeOlder: true })).toEqual(["exec-a", "exec-retry"]);
  });

  it("never supersedes a member that already left the group", async () => {
    await superseded("exec-a", G, { supersedeOlder: true });
    await run(store.release("exec-a"));
    clock += 1;
    expect(await superseded("exec-b", G, { supersedeOlder: true })).toEqual([]);
  });

  it("orders members by rank: a lower rank registering later supersedes itself, not the newer one", async () => {
    expect(await run(store.register("gate-h2", G, { supersedeOlder: true, rank: 2_000 }))).toEqual({
      superseded: [],
      supersededBy: undefined,
    });
    clock += 60_000;
    expect(await run(store.register("gate-h1", G, { supersedeOlder: true, rank: 1_000 }))).toEqual({
      superseded: [],
      supersededBy: "gate-h2",
    });
    // A re-run of the late registration reads the same answer back.
    expect(await run(store.register("gate-h1", G, { supersedeOlder: true, rank: 1_000 }))).toEqual({
      superseded: [],
      supersededBy: "gate-h2",
    });
    clock += 1;
    expect(await run(store.register("gate-h3", G, { supersedeOlder: true, rank: 3_000 }))).toEqual({
      superseded: ["gate-h1", "gate-h2"],
      supersededBy: undefined,
    });
  });

  it("a close marker ranked at the close ends the group's gates; only a reopen outranks it", async () => {
    await run(store.register("gate-push", G, { supersedeOlder: true, rank: 1_000 }));
    clock += 1;
    // The close lands at the PR's `updated_at`, after the landing push.
    expect(await superseded("pr-closed:1500:g", G, { supersedeOlder: true, rank: 1_500 })).toEqual(["gate-push"]);
    clock += 1;
    // A gate for the closed head that registers late stands itself down.
    expect(await run(store.register("gate-late", G, { supersedeOlder: true, rank: 1_000 }))).toEqual({
      superseded: [],
      supersededBy: "pr-closed:1500:g",
    });
    clock += 1;
    // A reopen's revision ranks above the close and supersedes the marker.
    expect(await superseded("gate-reopen", G, { supersedeOlder: true, rank: 2_000 })).toContain("pr-closed:1500:g");
  });

  it("a gate at the close's own second ranks below the marker even when it registers later", async () => {
    // The marker ranks one millisecond after the close's `updated_at` (pr-close.ts).
    expect(await superseded("pr-closed:1001:g", G, { supersedeOlder: true, rank: 1_001 })).toEqual([]);
    clock += 1;
    expect(await run(store.register("gate-same-second", G, { supersedeOlder: true, rank: 1_000 }))).toEqual({
      superseded: [],
      supersededBy: "pr-closed:1001:g",
    });
  });

  it("a re-run with a lower rank joins without standing down", async () => {
    await run(store.register("gate-h2", G, { supersedeOlder: true, rank: 2_000 }));
    clock += 1;
    expect(await run(store.register("gate-h1-retry", G, { supersedeOlder: false, rank: 1_000 }))).toEqual({
      superseded: [],
      supersededBy: undefined,
    });
  });

  it("breaks an equal rank by registration time", async () => {
    await run(store.register("gate-a", G, { supersedeOlder: true, rank: 5_000 }));
    clock += 1;
    expect(await superseded("gate-b", G, { supersedeOlder: true, rank: 5_000 })).toEqual(["gate-a"]);
  });

  it("reads an execution's status and run name", async () => {
    await insertExecution("parent", "success");
    await insertExecution("child", "running", "parent");
    expect(await run(store.row("parent"))).toEqual({ status: "success", run: "contextful-gate" });
    expect(await run(store.row("child"))).toEqual({ status: "running", run: "check" });
    expect(await run(store.row("absent"))).toBeUndefined();
  });

  it("reads the open tree, cancels it and frees its admission slots", async () => {
    await insertExecution("parent", "running", undefined, 11);
    await insertExecution("child-running", "running", "parent", 12);
    await insertExecution("child-done", "success", "parent", 13);
    await insertExecution("grandchild-running", "running", "child-running", 14);
    const admissions = makeRunAdmissionD1(bindings.db, () => clock);
    await run(admissions.enqueue("child-running", "lean", "parent"));
    await run(admissions.enqueue("grandchild-running", "lean", "child-running"));

    await run(store.markCancelled("parent"));
    await run(store.markCancelled("child-running"));
    expect(await run(store.status("parent"))).toBe("cancelled");
    const tree = await run(store.openTree("parent"));
    expect(tree.map((row) => [row.id, row.checkRunId]).sort()).toEqual([
      ["child-running", "12"],
      ["grandchild-running", "14"],
      ["parent", "11"],
    ]);

    await run(store.cancel(tree.map((row) => row.id)));
    expect(await executionStatus("child-running")).toBe("cancelled");
    expect(await executionStatus("grandchild-running")).toBe("cancelled");
    expect(await executionStatus("child-done")).toBe("success");
    const left = await bindings.db
      .prepare(`SELECT COUNT(*) AS n FROM run_admissions WHERE execution_id IN ('child-running', 'grandchild-running')`)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
