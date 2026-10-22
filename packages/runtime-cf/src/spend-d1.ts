// @fractalboxdev/flare-dispatch-runtime-cf — spend guard I/O: the month-to-date read and the limits.
//
// The I/O shell around the pure spend math (`@fractalboxdev/flare-dispatch-core`
// spend.ts): one indexed D1 query for month-to-date spend and the admitted
// burn, the `CONFIG_KV` overrides for the limits, and the once-per-month
// warning marker. The dispatcher calls these inside durable `step.do` bodies,
// so a replay reads the checkpointed answer rather than a fresh one.
//
// Spec: specs/adr/0006-spend-guard.md § Spend read, § Monthly budget,
//       § Warning and visibility.

import { Effect, Schedule } from "effect";
import {
  type BudgetDecision,
  decideBudget,
  formatUsd,
  monthToDateMicroUsd,
  resolveSpendLimits,
  SPEND_BUDGET_KV_KEY,
  SPEND_BURN_KV_KEY,
  type SpendLimits,
  spendMonth,
  type SpendMonth,
  type SpendReading,
  type SpendVars,
  spendWarnedKvKey,
} from "@fractalboxdev/flare-dispatch-core";
import { ADMISSION_TTL_MS } from "./run-admission-d1";

const MS_PER_HOUR = 3_600_000;

/**
 * Read month-to-date spend and the live admitted burn — one statement:
 *
 *   * `finished` — `cost_micro_usd` of executions admitted since the month
 *     started (the `executions_admitted_at` range scan);
 *   * `in_flight_rate_ms` — Σ hourly rate × ms since admission over LIVE
 *     admitted `run_admissions` rows admitted this month. A row is deleted at
 *     release, before the finish path writes `cost_micro_usd`, so no execution
 *     counts in both terms;
 *   * `admitted_rate` / `admitted_count` — the live admitted set the burn
 *     ceiling sums, across every pool.
 *
 * A row written before migration 0011 has a NULL rate and counts as zero.
 */
export const readSpend = (db: D1Database, nowMs: number): Effect.Effect<SpendReading, Error> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM executions
               WHERE admitted_at >= ?1 AND cost_micro_usd IS NOT NULL) AS finished,
             (SELECT COALESCE(SUM(COALESCE(hourly_rate_micro_usd, 0) * (?2 - admitted_at)), 0)
                FROM run_admissions
               WHERE state = 'admitted' AND heartbeat_at > ?3
                 AND admitted_at >= ?1 AND admitted_at <= ?2) AS in_flight_rate_ms,
             (SELECT COALESCE(SUM(hourly_rate_micro_usd), 0) FROM run_admissions
               WHERE state = 'admitted' AND heartbeat_at > ?3) AS admitted_rate,
             (SELECT COUNT(*) FROM run_admissions
               WHERE state = 'admitted' AND heartbeat_at > ?3) AS admitted_count`,
        )
        .bind(spendMonth(nowMs).startMs, nowMs, nowMs - ADMISSION_TTL_MS)
        .first<{
          finished: number;
          in_flight_rate_ms: number;
          admitted_rate: number;
          admitted_count: number;
        }>(),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.retry(Schedule.recurs(2).pipe(Schedule.addDelay(() => "200 millis"))),
    Effect.map((row) => ({
      finishedMicroUsd: row?.finished ?? 0,
      inFlightMicroUsd: Math.round((row?.in_flight_rate_ms ?? 0) / MS_PER_HOUR),
      admittedMicroUsdPerHour: row?.admitted_rate ?? 0,
      admittedCount: row?.admitted_count ?? 0,
    })),
  );

/**
 * Resolve the limits: `CONFIG_KV` `spend.budgetMonthlyUsd` /
 * `spend.burnMaxUsdPerHour` override the vars, and the vars override the code
 * defaults. A KV read that fails falls back to the vars and logs: the limit
 * then binds at the configured value, never at none.
 */
export const readSpendLimits = (
  kv: KVNamespace | undefined,
  vars: SpendVars,
): Effect.Effect<SpendLimits> =>
  (kv === undefined
    ? Effect.succeed({})
    : Effect.tryPromise(async () => {
        const [budgetMonthlyUsd, burnMaxUsdPerHour] = await Promise.all([
          kv.get(SPEND_BUDGET_KV_KEY),
          kv.get(SPEND_BURN_KV_KEY),
        ]);
        return { budgetMonthlyUsd, burnMaxUsdPerHour };
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(`spend: CONFIG_KV limit overrides unreadable, using vars — ${cause}`).pipe(
            Effect.as({}),
          ),
        ),
      )
  ).pipe(Effect.map((overrides) => resolveSpendLimits(vars, overrides)));

/** One spend read with its verdict against the budget. */
export type SpendStatus = {
  readonly month: SpendMonth;
  readonly limits: SpendLimits;
  readonly reading: SpendReading;
  /** Finished + in-flight, times the overhead factor. */
  readonly monthToDateMicroUsd: number;
  readonly decision: BudgetDecision;
};

/** Read spend and decide the monthly budget against `limits`. */
export const readSpendStatus = (
  db: D1Database,
  limits: SpendLimits,
  nowMs: number,
): Effect.Effect<SpendStatus, Error> =>
  Effect.map(readSpend(db, nowMs), (reading) => {
    const spend = monthToDateMicroUsd(reading, limits.overheadFactor);
    return {
      month: spendMonth(nowMs),
      limits,
      reading,
      monthToDateMicroUsd: spend,
      decision: decideBudget(spend, limits),
    };
  });

/**
 * Send the month's one spend warning when `status` crossed the warn ratio and
 * the month carries no `spend.warned:<YYYY-MM>` marker yet. Writes the marker
 * before notifying, so a failed notification is not retried by every later
 * admission. Returns whether this call sent it. Best-effort: a KV or notify
 * failure logs and returns `false`; it never touches the run.
 *
 * Without `CONFIG_KV` there is nowhere to mark the month, so it logs
 * `spend.warn` and sends nothing.
 */
export const warnSpendOnce = (opts: {
  readonly kv: KVNamespace | undefined;
  readonly status: SpendStatus;
  readonly notify: (text: string, monthKey: string) => Promise<void>;
}): Effect.Effect<boolean> => {
  const { status } = opts;
  if (status.decision._kind !== "open" || !status.decision.warn) return Effect.succeed(false);
  const budget = status.limits.budgetMicroUsd ?? 0;
  const text =
    `FlareDispatch spend reached ${formatUsd(status.monthToDateMicroUsd)} of the ` +
    `${formatUsd(budget)} monthly budget for ${status.month.key}. ` +
    `Checks skip once it reaches the budget; raise it with CONFIG_KV ${SPEND_BUDGET_KV_KEY}.`;
  const kv = opts.kv;
  if (kv === undefined) {
    return Effect.logWarning(`spend.warn ${text} (no CONFIG_KV — not notified)`).pipe(Effect.as(false));
  }
  const marker = spendWarnedKvKey(status.month.key);
  return Effect.gen(function* () {
    const warned = yield* Effect.tryPromise(() => kv.get(marker));
    if (warned !== null) return false;
    yield* Effect.tryPromise(() =>
      kv.put(marker, String(status.monthToDateMicroUsd), {
        // Outlive the month, then expire — a stale marker never silences a later year.
        expiration: Math.floor(status.month.resetsAtMs / 1000) + 7 * 24 * 3600,
      }),
    );
    yield* Effect.logWarning(`spend.warn ${text}`);
    yield* Effect.tryPromise(() => opts.notify(text, status.month.key));
    return true;
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(`spend.warn not delivered — ${cause}`).pipe(Effect.as(false)),
    ),
  );
};
