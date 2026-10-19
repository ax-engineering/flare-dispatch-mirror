// @fractalboxdev/flare-dispatch-runtime-cf — D1ExecutionsLive: the live `executions` capability.
//
// Backs `ExecutionsService` with the D1 binding: one row in `executions` per
// run invocation, one row in `steps` per step transition (INSERT at entry,
// UPDATE at exit). Schema is infra/d1-schema.sql verbatim.
//
// --- One design seam, documented ---------------------------------------------
//
// `ExecutionsService.startExecution` (defined in @fractalboxdev/flare-dispatch-core) carries
// only `{ id, run, startedAt }`, but the `executions` table has NOT NULL
// `repo`, `ref`, `sha`, `input_json`, `status` columns. The core interface is
// fixed and run-agnostic, so the missing columns are supplied *out of band*:
// `makeD1ExecutionsLive` takes an `ExecutionContext` ({ repo, ref, sha, input })
// that `RunWorkflow` derives from the dispatch event. The Layer closes over it;
// `startExecution` then has every NOT NULL column. This keeps the core service
// contract narrow while satisfying the real schema — the Layer is the place
// runtime-specific context is injected.
//
// D1 write rate (specs/pm/plan.md § 6): this runtime writes exactly two D1
// statements per step (one INSERT, one UPDATE) plus two for the execution.
// `offload-test` (3 run-body steps) is therefore 8 writes — the PR4 integration
// test pins this with a row-count assertion.
//
// --- Replay idempotency ------------------------------------------------------
//
// A CF Workflow's `run(event, step)` re-executes top-to-bottom on every Worker
// eviction/resume — only `WorkflowStep.do` *results* are memoized. Every
// `ExecutionsService` call here runs OUTSIDE a `step.do` (`startExecution` from
// `RunWorkflow`, `startStep`/`finishStep` from `StepRunnerCloudflare` around
// the checkpoint), so each one re-runs on resume. The INSERTs must therefore be
// idempotent or a resume would PK-violate (`executions`) or duplicate rows
// (`steps`):
//
//   * both INSERTs are `INSERT OR IGNORE` — a replayed insert is a silent
//     no-op once the row already exists;
//   * the `steps` PK is DETERMINISTIC — `${executionId}:${name}:${attempt}` —
//     so a replay computes the same PK and `OR IGNORE` collapses it (a fresh
//     random PK would defeat `OR IGNORE` and accumulate duplicates);
//   * `finishExecution` / `finishStep` are plain `UPDATE`s, idempotent by
//     construction — re-running them just rewrites the same row.
//
// This preserves the "an evicted Worker resumes from the last completed step"
// property the architecture spec sells (specs/01-architecture.md § Workflow
// Engine). There is no non-deterministic call left in this layer.
//
// Spec: specs/05-byoc.md § D1 schema, specs/pm/plan.md § PR4.

import { Effect, Layer, Schedule } from "effect";
import { Executions, type ExecutionsService } from "@fractalboxdev/flare-dispatch-core";

/** Five retries, 200 ms doubling: about 6 s of D1 unavailability absorbed. */
const WRITE_RETRY = Schedule.exponential("200 millis").pipe(
  Schedule.intersect(Schedule.recurs(5)),
);

/**
 * The run-invocation context the `executions` row needs but the core
 * `ExecutionsService` interface does not carry — supplied by `RunWorkflow`
 * from the dispatch event.
 */
export type ExecutionContext = {
  /** "owner/name". */
  readonly repo: string;
  /** git ref, e.g. "refs/heads/main". */
  readonly ref: string;
  /** head SHA. */
  readonly sha: string;
  /** the decoded run input, persisted as `input_json`. */
  readonly input: unknown;
};

/**
 * Build the live `Executions` Layer bound to a D1 database.
 *
 * @param db   the D1 binding (`env.RUNS_METADATA`).
 * @param ctx  the repo/ref/sha/input the `executions` row requires.
 */
export const makeD1ExecutionsLive = (
  db: D1Database,
  ctx: ExecutionContext,
): Layer.Layer<Executions> => {
  // A D1 write wrapped as an Effect — `tryPromise` keeps a binding failure in
  // the Effect channel rather than escaping as a rejected Promise. The service
  // contract is `Effect.Effect<void>` (no typed error), so a write failure
  // surfaces as a defect: a D1 outage mid-run is genuinely exceptional and
  // should fail the execution loudly, not be silently swallowed.
  //
  // Every statement here is idempotent (see "Replay idempotency"), so a
  // rejected write retries before it dies: a transient D1 fault on the
  // terminal `finishExecution` otherwise strands the row in `running`, and
  // the parent join and the check-run wait on a verdict that never lands.
  const run = (label: string, stmt: () => Promise<D1Result | D1Response>): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => stmt().then(() => undefined),
      catch: (cause) => new Error(`D1ExecutionsLive: ${label} failed`, { cause }),
    }).pipe(Effect.retry(WRITE_RETRY), Effect.orDie);

  const service: ExecutionsService = {
    startExecution: ({ id, run: runName, startedAt, parentExecutionId, attempt, retryOf }) =>
      run("startExecution", () =>
        db
          // `OR IGNORE`: the PK `id` is deterministic (the executionId), so a
          // replayed insert on Workflow resume is a no-op, not a PK violation.
          // `parent_execution_id` is NULL for a top-level execution and the
          // spawning parent's id for a `spawnChildRun` child — the lineage a
          // fan-out parent reads back to join on its children. `attempt` /
          // `retry_of` tie a check-run re-run to the family it retries
          // (infra/migrations/0007) — 1 / NULL for every dispatched execution.
          .prepare(
            `INSERT OR IGNORE INTO executions
               (id, run, repo, ref, sha, status, started_at, input_json, parent_execution_id,
                attempt, retry_of)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            runName,
            ctx.repo,
            ctx.ref,
            ctx.sha,
            startedAt,
            JSON.stringify(ctx.input),
            parentExecutionId ?? null,
            attempt ?? 1,
            retryOf ?? null,
          )
          .run(),
      ),

    finishExecution: ({ id, completedAt, status, summaryJson }) =>
      Effect.tryPromise({
        try: () => (summaryJson === undefined
          ? db
              .prepare(
                `UPDATE executions
                   SET status = ?, completed_at = ?
                 WHERE id = ? AND status = 'running'`,
              )
              .bind(status, completedAt, id)
              .run()
          : db
              .prepare(
                `UPDATE executions
                   SET status = ?, completed_at = ?, summary_json = ?
                 WHERE id = ? AND status = 'running'`,
              )
              .bind(status, completedAt, summaryJson, id)
              .run()).then((result) => result.meta.changes > 0),
        catch: (cause) => new Error("D1ExecutionsLive: finishExecution failed", { cause }),
      }).pipe(Effect.retry(WRITE_RETRY), Effect.orDie),

    startStep: ({ executionId, name, startedAt }) =>
      run("startStep", () =>
        db
          // `OR IGNORE` + a DETERMINISTIC PK: a replayed insert on Workflow
          // resume recomputes the same `${executionId}:${name}:${attempt}` id
          // and is collapsed to a no-op — no duplicate `steps` rows. A random
          // PK would defeat this and accumulate a row per replay.
          .prepare(
            `INSERT OR IGNORE INTO steps
               (id, execution_id, name, status, started_at, attempt)
             VALUES (?, ?, ?, 'running', ?, 1)`,
          )
          // The PK is `${executionId}:${name}:${attempt}` (attempt = 1 in V0).
          // `(execution_id, name)` remains the logical key `finishStep` UPDATEs.
          .bind(`${executionId}:${name}:1`, executionId, name, startedAt)
          .run(),
      ),

    finishStep: ({ executionId, name, completedAt, status, errorTag }) =>
      run("finishStep", () =>
        db
          .prepare(
            // `COALESCE(?, error_tag)` rather than a plain assignment: the
            // success path passes no tag, and a step that is finished twice
            // (Workflow replay re-runs this UPDATE) must not have a recorded
            // reason overwritten with NULL by the second call.
            `UPDATE steps
               SET status = ?, completed_at = ?, error_tag = COALESCE(?, error_tag)
             WHERE execution_id = ? AND name = ?`,
          )
          .bind(status, completedAt, errorTag ?? null, executionId, name)
          .run(),
      ),
  };

  return Layer.succeed(Executions, service);
};
