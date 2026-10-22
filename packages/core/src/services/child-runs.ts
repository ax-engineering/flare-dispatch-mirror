// @fractalboxdev/flare-dispatch-core — the `childRuns` capability (child-Workflow fan-out).
//
// `spawnChildRun` instantiates an independent `RunWorkflow` instance — a child
// execution that runs in its own durable Workflow, with its own step budget,
// its own container, and (for browser runs) its own Browser Rendering session.
// This is the parallelism lever the architecture calls "enumerate, then fan
// out" (specs/01-architecture.md § Scheduling): a parent run shards its work
// and spawns one child per shard, sidestepping the per-instance step quota and
// the per-exec container-kill window that bound a single big instance.
//
// Distinct from the `sharded` primitive, which fans out *inside one instance*
// (`Effect.forEach` over containers in the same Workflow). `sharded` shares the
// parent's CPU/step budget; `spawnChildRun` does not. Use `sharded` for a
// handful of shards on one container; use `fanOut` (built on this capability)
// when shard count, per-shard duration, or per-shard browser sessions would
// strain a single instance.
//
// Backed by a Layer — the live binding (`makeChildRunsLive`) calls the CF
// `Workflow` binding's `create({ id, params })`; the fake records spawns for
// unit tests. A run author imports the `spawnChildRun` accessor, never the Tag.
//
// Spec: specs/03-dsl.md § spawnChildRun, specs/01-architecture.md
//       § Long-running test handling + § Platform limits.

import { Context, Effect } from "effect";
import type { ChildSpawnFailed, RunSkipped } from "../errors";

/**
 * The result of a spawn. `executionId` and `instanceId` are equal — the
 * dispatcher uses one id as BOTH the CF Workflow instance id AND the D1
 * execution-row id (see apps/dispatcher/src/routes/dispatch.ts), and child
 * spawns follow the same contract — but both names are surfaced so call sites
 * read clearly (`executionId` to build a details URL, `instanceId` to reason
 * about dedup). `created` is `false` when an instance with this id already
 * existed: CF Workflows treats a duplicate `create({id})` as a no-op, which is
 * exactly the idempotency a fan-out parent wants across Workflow replays.
 */
export type ChildRunHandle = {
  readonly executionId: string;
  readonly instanceId: string;
  readonly created: boolean;
};

/** Arguments to `spawnChildRun`. */
export type SpawnChildRunOpts = {
  /** The child run name — must be registered on the same deploy. */
  readonly run: string;
  /**
   * The child run's input. Validated against the child run's `inputs` Schema by
   * the child `RunWorkflow` when it boots (a mismatch fails the *child*, not the
   * parent). Typed `unknown` because the parent rarely shares the child's Schema
   * type at the call site; `fanOut` callers supply a typed mapper.
   */
  readonly input: unknown;
  /**
   * The semantic instance id — the child's CF Workflow id, its D1 row id, and
   * its dedup key. When omitted, the live layer derives a deterministic id from
   * the parent execution id + run + a hash of the input, so a parent replay
   * recreates the SAME id (a no-op) rather than spawning a duplicate child.
   * Supply an explicit id (e.g. `pr-review:owner/name:42:<sha>`) when the child
   * has its own semantic identity that should collapse duplicate logical work
   * across different parents.
   */
  readonly instanceId?: string;
};

/**
 * A child execution's lifecycle status, read back from the D1 `executions`
 * table by `poll`. `missing` is a child whose row has not appeared yet — its
 * Workflow instance has not booted far enough to `startExecution`; the
 * `waitForChildren` primitive treats it as still-pending, the same as `running`.
 */
export type ChildRunStatus =
  | "running"
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "missing";

/** A child's polled status, plus its JSON-encoded output when terminal. */
export type ChildStatusRecord = {
  readonly executionId: string;
  readonly status: ChildRunStatus;
  /**
   * The child's `executions.summary_json` — its terminal output, JSON-encoded,
   * when it finished with output. Absent while pending, or for a failed child
   * (a failed Exit records no output). A parent decodes it to roll up results.
   */
  readonly summaryJson?: string;
  /**
   * The GitHub check-run id the child posted, from `executions.check_run_id`.
   * Absent until the child opens its check-run, and for a child that posts none.
   */
  readonly checkRunId?: string;
  /**
   * The error tag of the child's last failed step, for a `failure` child that
   * recorded one — `AdmissionTimedOut` for a child that never left the
   * admission queue. Absent otherwise.
   */
  readonly failureTag?: string;
};

/** Terminal child statuses — `waitForChildren` stops polling once all reach one. */
const TERMINAL: ReadonlySet<ChildRunStatus> = new Set([
  "success",
  "failure",
  "skipped",
  "cancelled",
]);

/** True once a child has settled (success / failure / skipped / cancelled). */
export const isTerminalChildStatus = (status: ChildRunStatus): boolean => TERMINAL.has(status);

/** The service contract a runtime Layer implements. */
export interface ChildRunsService {
  readonly spawn: (opts: SpawnChildRunOpts) => Effect.Effect<ChildRunHandle, ChildSpawnFailed>;
  /**
   * Read the deploy's month-to-date spend before a fan-out spawns children of
   * `run` (ADR-0006 § Monthly budget). At or over the monthly budget it fails
   * `RunSkipped` with the budget reason, and the parent spawns none; an
   * unreadable spend fails `ChildSpawnFailed` rather than reading as open.
   * Call it inside the spawn step, so a replay reads the checkpointed answer.
   */
  readonly spendGate: (run: string) => Effect.Effect<void, RunSkipped | ChildSpawnFailed>;
  /**
   * Release the parent's global admission slot after it has finished its own
   * sandbox work. A parent waiting on children must not occupy a slot that a
   * child needs to finish. The Workflow finalizer releases the same row again;
   * both deletions are idempotent.
   */
  readonly handoffAdmission: () => Effect.Effect<void>;
  /**
   * Read the current status of each child execution id. Returns one record per
   * requested id, in the input order; an id with no `executions` row yet is
   * `missing`. Total — a transient D1 read fault degrades every id to a
   * non-terminal status (the `waitForChildren` timeout is the real backstop)
   * rather than failing the poll.
   */
  readonly poll: (opts: { ids: readonly string[] }) => Effect.Effect<readonly ChildStatusRecord[]>;
}

/** Context.Tag — the child-Workflow dependency a fan-out run carries. */
export class ChildRuns extends Context.Tag("@fractalboxdev/flare-dispatch-core/ChildRuns")<
  ChildRuns,
  ChildRunsService
>() {}

/**
 * Spawn a child `RunWorkflow` instance. The accessor a run author imports:
 * `spawnChildRun({ run, input })` rather than
 * `Effect.flatMap(ChildRuns, (c) => c.spawn(...))`.
 *
 * Call inside a `step` for a checkpointed, named spawn — though the deterministic
 * instance id already makes the underlying `create` idempotent on replay even
 * when called outside one. The `fanOut` primitive
 * (`@fractalboxdev/flare-dispatch-core/primitives`) is the common caller.
 */
export const spawnChildRun = (
  opts: SpawnChildRunOpts,
): Effect.Effect<ChildRunHandle, ChildSpawnFailed, ChildRuns> =>
  Effect.flatMap(ChildRuns, (c) => c.spawn(opts));

/** Hand the parent's admission slot to its children before a durable join. */
export const handoffChildAdmission = (): Effect.Effect<void, never, ChildRuns> =>
  Effect.flatMap(ChildRuns, (c) => c.handoffAdmission());
