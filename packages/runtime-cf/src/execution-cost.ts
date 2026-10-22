// @fractalboxdev/flare-dispatch-runtime-cf — per-execution cost rollup (the finish path).
//
// At `finishExecution` the Workflow calls `recordExecutionCost` to denormalize a
// cost rollup onto the `executions` row (the columns 0005 added). It combines:
//
//   * METERED model tokens — SUMmed from `execution_model_usage` (written per
//     call by the live `modelGateway` wrapper, model-gateway-cf.ts);
//   * MODELED container compute — the list rate of the run's container class,
//     priced on provisioned vCPU, memory and disk, × container-active seconds,
//     which run from admission (`executions.admitted_at`) to completion. Queue
//     wait costs nothing; an execution never admitted has no container time.
//
// via the pure `@fractalboxdev/flare-dispatch-core` cost engine, which decides the honest
// `metered | mixed | modeled | unmetered` basis. Each row it writes carries
// `cost_meter = 'admitted-active'`; rows priced on wall time before this rule
// carry `'modeled-wall'` (migration 0011). Best-effort: a cost-rollup failure
// logs a warning and never flips the run's verdict.
//
// Spec: specs/06-cost.md, specs/adr/0006-spend-guard.md § Meter,
//       infra/migrations/0005_execution_cost.sql, 0011_spend_guard.sql.

import { Effect } from "effect";
import {
  type InstanceType,
  type SandboxImage,
  INSTANCE_SPECS,
  containerMicroUsdPerHour,
  estimateExecutionCost,
} from "@fractalboxdev/flare-dispatch-core";

/**
 * The container class and instance type each sandbox image (= admission pool)
 * runs on — the one table the meter, the burn ceiling and the finish path
 * read. `execution-cost.test.ts` checks it against the committed
 * wrangler.jsonc `containers` entries, so a class resized there fails CI until
 * this table follows.
 */
export const SANDBOX_CONTAINER: Record<
  SandboxImage,
  { readonly className: string; readonly instance: InstanceType }
> = {
  lean: { className: "RunSandbox", instance: "standard-4" },
  browser: { className: "RunSandboxBrowser", instance: "standard-2" },
  agent: { className: "RunSandboxAgent", instance: "standard-3" },
  release: { className: "RunSandboxRelease", instance: "standard-4" },
};

/**
 * The container instance type a run lands on. Pass the ADMISSION POOL (the
 * image after the dispatcher's degrade-to-lean routing), so a run is priced on
 * the container it actually consumes; an un-set image is `lean`.
 */
export const instanceForSandboxImage = (sandboxImage: SandboxImage | undefined): InstanceType =>
  SANDBOX_CONTAINER[sandboxImage ?? "lean"].instance;

/** A sandbox image's list rate per hour, in micro-USD — what the burn ceiling sums. */
export const hourlyRateForSandboxImage = (sandboxImage: SandboxImage | undefined): number =>
  containerMicroUsdPerHour(instanceForSandboxImage(sandboxImage));

/** The `executions.cost_meter` label for a row priced by this rule. */
export const COST_METER_ADMITTED_ACTIVE = "admitted-active";

type UsageRow = {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly metered: number;
};

/**
 * Compute and persist this execution's cost rollup. Reads its admitted window and
 * model-usage rows from D1, models container compute from the instance type, and
 * writes the `executions` cost columns. Returns `void`; all failure is absorbed.
 *
 * @param db          D1 binding (`env.RUNS_METADATA`).
 * @param executionId the row to roll up.
 * @param instance    the container instance type (`instanceForSandboxImage(pool)`).
 */
export const recordExecutionCost = (opts: {
  readonly db: D1Database;
  readonly executionId: string;
  readonly instance: InstanceType;
}): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const { db, executionId, instance } = opts;

    // Admission → completion is the container-active window; queue wait and
    // a run never admitted cost no container time.
    const exec = await db
      .prepare(`SELECT admitted_at, completed_at FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<{ admitted_at: number | null; completed_at: number | null }>();
    const admittedAt = exec?.admitted_at ?? null;
    const completedAt = exec?.completed_at ?? null;
    const activeSeconds =
      admittedAt !== null && completedAt !== null && completedAt > admittedAt
        ? (completedAt - admittedAt) / 1000
        : 0;

    // SUM model token usage; pick the dominant model for the rate + the column.
    const usage = await db
      .prepare(
        `SELECT model, input_tokens, output_tokens, metered
           FROM execution_model_usage WHERE execution_id = ?`,
      )
      .bind(executionId)
      .all<UsageRow>();
    const rows = usage.results ?? [];

    let inTok = 0;
    let outTok = 0;
    let anyMetered = false;
    let dominant: { model: string; tok: number } | null = null;
    for (const r of rows) {
      inTok += r.input_tokens;
      outTok += r.output_tokens;
      if (r.metered === 1) anyMetered = true;
      const tok = r.input_tokens + r.output_tokens;
      if (dominant === null || tok > dominant.tok) dominant = { model: r.model, tok };
    }

    const cost = estimateExecutionCost({
      container: { instance, activeSeconds },
      ...(dominant !== null
        ? {
            model: {
              model: dominant.model,
              inputTokens: inTok,
              outputTokens: outTok,
              metered: anyMetered,
            },
          }
        : {}),
    });

    const vcpuSeconds = INSTANCE_SPECS[instance].vcpu * activeSeconds;

    await db
      .prepare(
        `UPDATE executions
           SET cost_micro_usd = ?, cost_basis = ?, cost_meter = ?, input_tokens = ?,
               output_tokens = ?, vcpu_seconds = ?, model = ?
         WHERE id = ?`,
      )
      .bind(
        cost.totalMicroUsd,
        cost.basis,
        COST_METER_ADMITTED_ACTIVE,
        rows.length > 0 ? inTok : null,
        rows.length > 0 ? outTok : null,
        vcpuSeconds,
        dominant?.model ?? null,
        executionId,
      )
      .run();
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning(`recordExecutionCost failed (non-fatal): ${cause}`),
    ),
  );
