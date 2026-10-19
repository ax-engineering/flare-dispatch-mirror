// @fractalboxdev/flare-dispatch-runtime-cf — ChildRunsCloudflare: the live `childRuns` capability.
//
// Backs `ChildRunsService.spawn` with the CF `Workflow` binding's
// `create({ id, params })` — the same call the dispatch route makes for a
// top-level execution (apps/dispatcher/src/routes/dispatch.ts), issued from
// *inside* a running parent execution for each child. The child boots its own
// `RunWorkflow` instance, decodes `params` as a `DispatchPayload`, and runs to
// its own verdict — independent step budget, container, and Browser Rendering
// session.
//
// --- Idempotent, replay-safe ids ---------------------------------------------
//
// A CF Workflow's `run` re-executes top-to-bottom on resume; a spawn that is not
// behind a memoized `step.do` re-runs. The child instance id must therefore be
// DETERMINISTIC so a re-run recreates the SAME id — and CF Workflows collapses a
// duplicate `create({id})` to `instance.already_exists`, which we surface as
// `created: false` rather than a failure. With an explicit `instanceId` the
// caller owns determinism; without one we derive
// `<run>.<parentExecutionId>.<fnv1a(input)>`, fully determined by the parent
// context + input. The result is hashed/truncated to stay within the CF 64-char
// instance-id limit and reduced to Cloudflare's `[A-Za-z0-9_-]` alphabet.
//
// `parentExecutionId` rides in the child's `DispatchPayload` so the child writes
// its `executions.parent_execution_id` lineage column on boot — the join key a
// fan-out parent reads back.
//
// Spec: specs/03-dsl.md § spawnChildRun, specs/01-architecture.md
//       § Durability and dedup.

import { Effect, Layer } from "effect";
import {
  type ChildRunStatus,
  ChildRuns,
  type ChildRunsService,
  ChildSpawnFailed,
  type ChildStatusRecord,
  isTerminalChildStatus,
} from "@fractalboxdev/flare-dispatch-core";
import { makeRunAdmissionD1 } from "./run-admission-d1";

/**
 * The minimal CF `Workflow`-binding surface: `spawn` creates instances, and
 * `poll` reads an instance's engine status when its D1 row has not settled.
 */
export type WorkflowBindingLike = {
  readonly create: (opts: { id: string; params: unknown }) => Promise<unknown>;
  readonly get?: (id: string) => Promise<{ status: () => Promise<{ status: string }> }>;
};

/**
 * Engine states in which an instance runs no more code. A child in one of these
 * whose row is still non-terminal never wrote its verdict (the terminal D1
 * write failed, or the instance died first), so the row will never settle.
 */
const ENDED_INSTANCE = new Set(["errored", "terminated", "complete"]);

/** The github context children inherit from their spawning parent. */
export type ChildGithubContext = {
  /** "owner/name". */
  readonly repo: string;
  /** git ref, e.g. "refs/heads/main". */
  readonly ref: string;
  /** head SHA. */
  readonly sha: string;
  /** GitHub App installation id, so the child can post its own check-run. */
  readonly installationId?: number;
};

/** Everything `makeChildRunsLive` needs to spawn + poll children of one execution. */
export type ChildRunsLiveConfig = {
  /** The `Workflow` binding — `env.RUNS_WORKFLOW`. */
  readonly workflow: WorkflowBindingLike;
  /**
   * D1 binding (`env.RUNS_METADATA`) — `poll` reads child `executions` rows
   * (status + summary_json) so `waitForChildren` can join on them.
   */
  readonly db: D1Database;
  /** The spawning (parent) execution id — written as each child's lineage. */
  readonly parentExecutionId: string;
  /** The github context children inherit (repo/ref/sha/installation). */
  readonly github: ChildGithubContext;
  /**
   * The dispatcher's public origin children inherit — rides the child's
   * `DispatchPayload` so the child's artifact URLs are absolute (the child
   * Workflow has no request to infer it from). Absent → relative paths.
   */
  readonly origin?: string;
};

/** Map a raw `executions.status` cell to the capability's `ChildRunStatus`. */
const toChildStatus = (raw: string | null | undefined): ChildRunStatus => {
  switch (raw) {
    case "success":
    case "failure":
    case "skipped":
    case "cancelled":
    case "running":
      return raw;
    // `queued` (or any unrecognized value) is not yet terminal → keep waiting.
    default:
      return "running";
  }
};

/** CF Workflows caps instance ids at 64 chars. */
const MAX_INSTANCE_ID_LEN = 64;

/** FNV-1a 32-bit hash → 8 hex chars. Deterministic, dependency-free. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // `* 0x01000193` via shifts to stay in 32-bit range without BigInt.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/**
 * Reduce a raw id to Cloudflare's Workflow instance-id alphabet and length cap.
 * The dispatch route applies the same `[A-Za-z0-9_-]` restriction.
 */
const sanitize = (raw: string): string => {
  const seg = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  // Over the cap → keep a readable prefix + a hash suffix so it stays unique.
  return seg.length <= MAX_INSTANCE_ID_LEN
    ? seg
    : `${seg.slice(0, MAX_INSTANCE_ID_LEN - 9)}_${fnv1a(seg)}`;
};

/**
 * Derive the child's deterministic instance id. Explicit `instanceId` wins
 * (sanitized); otherwise hash the input under the parent + run namespace.
 */
export const deriveChildInstanceId = (opts: {
  run: string;
  parentExecutionId: string;
  input: unknown;
  instanceId?: string;
}): string => {
  if (opts.instanceId !== undefined && opts.instanceId.length > 0) {
    return sanitize(opts.instanceId);
  }
  let inputHash: string;
  try {
    inputHash = fnv1a(JSON.stringify(opts.input) ?? "null");
  } catch {
    // Non-serializable input (shouldn't happen for a dispatch payload) — fall
    // back to a stable marker so the id stays deterministic per call site.
    inputHash = "noinput";
  }
  return sanitize(`${opts.run}.${opts.parentExecutionId}.${inputHash}`);
};

/** Build the live `ChildRuns` Layer bound to a CF `Workflow` binding. */
export const makeChildRunsLive = (cfg: ChildRunsLiveConfig): Layer.Layer<ChildRuns> => {
  const service: ChildRunsService = {
    handoffAdmission: () =>
      makeRunAdmissionD1(cfg.db).release(cfg.parentExecutionId).pipe(Effect.orDie),
    spawn: ({ run, input, instanceId }) => {
      const id = deriveChildInstanceId({
        run,
        parentExecutionId: cfg.parentExecutionId,
        input,
        ...(instanceId !== undefined ? { instanceId } : {}),
      });
      // The child `DispatchPayload` — the exact shape `RunWorkflow.run` decodes.
      // `executionId === id` (the dispatcher uses one id for the instance AND
      // the D1 row); `parentExecutionId` is the lineage the child persists.
      const params = {
        executionId: id,
        run,
        github: {
          repo: cfg.github.repo,
          ref: cfg.github.ref,
          sha: cfg.github.sha,
          ...(cfg.github.installationId !== undefined
            ? { installation_id: cfg.github.installationId }
            : {}),
        },
        inputs: input,
        parentExecutionId: cfg.parentExecutionId,
        ...(cfg.origin !== undefined ? { origin: cfg.origin } : {}),
      };
      return Effect.tryPromise({
        try: async () => {
          try {
            await cfg.workflow.create({ id, params });
            return { executionId: id, instanceId: id, created: true };
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            // A duplicate id is the idempotent end-state, not a failure — same
            // contract as the dispatch route's create. Anything else rethrows
            // into the `catch` below as a `ChildSpawnFailed`.
            if (/already_exists/i.test(msg)) {
              return { executionId: id, instanceId: id, created: false };
            }
            throw cause;
          }
        },
        catch: (cause) => new ChildSpawnFailed({ run, instanceId: id, cause }),
      });
    },

    poll: ({ ids }) => {
      if (ids.length === 0) {
        return Effect.succeed([] as readonly ChildStatusRecord[]);
      }
      const readRows = async (wanted: readonly string[]) => {
        const { results } = await cfg.db
          .prepare(
            `SELECT e.id, e.status, e.summary_json, e.check_run_id,
                    (SELECT s.error_tag FROM steps AS s
                      WHERE s.execution_id = e.id AND s.status = 'failure' AND s.error_tag IS NOT NULL
                      ORDER BY s.completed_at DESC LIMIT 1) AS failure_tag
               FROM executions AS e
              WHERE e.id IN (${wanted.map(() => "?").join(", ")})`,
          )
          .bind(...wanted)
          .all<{
            id: string;
            status: string;
            summary_json: string | null;
            check_run_id: number | string | null;
            failure_tag: string | null;
          }>();
        const byId = new Map(results.map((r) => [r.id, r]));
        // Preserve input order; an id with no row yet is `missing`.
        return wanted.map((id): ChildStatusRecord => {
          const row = byId.get(id);
          if (row === undefined) return { executionId: id, status: "missing" };
          return {
            executionId: id,
            status: toChildStatus(row.status),
            ...(row.summary_json !== null ? { summaryJson: row.summary_json } : {}),
            ...(row.check_run_id !== null ? { checkRunId: String(row.check_run_id) } : {}),
            ...(row.status === "failure" && row.failure_tag !== null
              ? { failureTag: row.failure_tag }
              : {}),
          };
        });
      };
      return Effect.tryPromise(async () => {
        const fromRows = await readRows(ids);
        // A non-terminal row whose instance has ended reports `failure`: no
        // verdict was recorded, and waiting on it only holds the parent until
        // its deadline. A failed lookup keeps the row's own status.
        const get = cfg.workflow.get;
        if (get === undefined) return fromRows;
        const ended = new Set<string>();
        await Promise.all(
          fromRows.map(async (record) => {
            if (isTerminalChildStatus(record.status)) return;
            try {
              const { status } = await (await get(record.executionId)).status();
              if (ENDED_INSTANCE.has(status)) ended.add(record.executionId);
            } catch {
              // Unknown instance state: keep waiting on the row.
            }
          }),
        );
        if (ended.size === 0) return fromRows;
        // The row was read before the engine: a child that recorded its verdict
        // and completed in between is re-read, never misreported as failed.
        const reread = new Map((await readRows([...ended])).map((r) => [r.executionId, r]));
        return fromRows.map((record): ChildStatusRecord => {
          const fresh = reread.get(record.executionId);
          if (fresh === undefined) return record;
          return isTerminalChildStatus(fresh.status)
            ? fresh
            : {
                executionId: record.executionId,
                status: "failure",
                ...(fresh.checkRunId !== undefined ? { checkRunId: fresh.checkRunId } : {}),
              };
        });
      }).pipe(
        // A transient D1 read fault must not fail the join — degrade every id to
        // `missing` (non-terminal) so the loop polls again; `waitForChildren`'s
        // overall timeout is the real backstop. Matches `io.priorExecution`'s
        // "best-effort read, never fatal" posture.
        Effect.orElseSucceed(() =>
          ids.map((id): ChildStatusRecord => ({ executionId: id, status: "missing" })),
        ),
      );
    },
  };

  return Layer.succeed(ChildRuns, service);
};
