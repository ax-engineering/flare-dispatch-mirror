// FlareDispatch Dispatcher — `GET /api/spend`: the spend guard's month-to-date view.
//
// Returns the deploy's month-to-date spend, the monthly budget, the burn
// ceiling, the admitted hourly rate and when the month resets — the same
// numbers admission decides with (runtime-cf spend-d1.ts). The dashboard
// renders `spendLine` of the same view. Access-gated like the executions and
// analytics reads.
//
// Spec: specs/adr/0006-spend-guard.md § Warning and visibility.

import { Effect } from "effect";
import { MICRO_USD_PER_USD, formatUsd } from "@fractalboxdev/flare-dispatch-core";
import { readSpendLimits, readSpendStatus, type SpendStatus } from "@fractalboxdev/flare-dispatch-runtime-cf/spend";
import type { Env } from "../env";

/** The JSON body of `GET /api/spend`. USD figures; `null` = unlimited. */
export type SpendView = {
  /** The UTC calendar month, `YYYY-MM`. */
  readonly month: string;
  readonly monthToDateUsd: number;
  readonly budgetUsd: number | null;
  readonly burnMaxUsdPerHour: number | null;
  /** The summed hourly rate of every admitted execution, across all pools. */
  readonly admittedUsdPerHour: number;
  readonly admittedCount: number;
  readonly overheadFactor: number;
  readonly warnRatio: number;
  /** `true` once month-to-date spend reaches the budget: runs skip. */
  readonly budgetReached: boolean;
  /** The first instant of the next UTC month, ISO 8601. */
  readonly resetsAt: string;
};

const usd = (microUsd: number): number => microUsd / MICRO_USD_PER_USD;

/** Project a spend read onto the API view. Pure. */
export const spendView = (status: SpendStatus): SpendView => ({
  month: status.month.key,
  monthToDateUsd: usd(status.monthToDateMicroUsd),
  budgetUsd: status.limits.budgetMicroUsd === null ? null : usd(status.limits.budgetMicroUsd),
  burnMaxUsdPerHour:
    status.limits.burnMaxMicroUsdPerHour === null ? null : usd(status.limits.burnMaxMicroUsdPerHour),
  admittedUsdPerHour: usd(status.reading.admittedMicroUsdPerHour),
  admittedCount: status.reading.admittedCount,
  overheadFactor: status.limits.overheadFactor,
  warnRatio: status.limits.warnRatio,
  budgetReached: status.decision._kind === "closed",
  resetsAt: new Date(status.month.resetsAtMs).toISOString(),
});

/** The one-line summary the dashboard shows. Pure. */
export const spendLine = (status: SpendStatus): string => {
  const budget = status.limits.budgetMicroUsd;
  const ceiling = status.limits.burnMaxMicroUsdPerHour;
  return [
    `Spend ${status.month.key}: ${formatUsd(status.monthToDateMicroUsd)} of ${
      budget === null ? "unlimited" : formatUsd(budget)
    }${status.decision._kind === "closed" ? " — budget reached, runs skip" : ""}`,
    `burn ${formatUsd(status.reading.admittedMicroUsdPerHour)}/h of ${
      ceiling === null ? "unlimited" : `${formatUsd(ceiling)}/h`
    }`,
    `resets ${new Date(status.month.resetsAtMs).toISOString().slice(0, 10)}`,
  ].join(" · ");
};

/** Read the deploy's spend status now. */
export const readSpendNow = (env: Env, nowMs: number = Date.now()): Effect.Effect<SpendStatus, Error> =>
  readSpendLimits(env.CONFIG_KV, env).pipe(
    Effect.flatMap((limits) => readSpendStatus(env.RUNS_METADATA, limits, nowMs)),
  );

/** `GET /api/spend`. A D1 read failure answers 503 with the reason. */
export const handleSpend = (env: Env, nowMs: number = Date.now()): Promise<Response> =>
  Effect.runPromise(
    readSpendNow(env, nowMs).pipe(
      Effect.map(
        (status) =>
          new Response(JSON.stringify(spendView(status)), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      ),
      Effect.catchAll((error) =>
        Effect.succeed(
          new Response(JSON.stringify({ error: "spend_unreadable", detail: error.message }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );
