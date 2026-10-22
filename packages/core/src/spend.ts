// @fractalboxdev/flare-dispatch-core — spend guard: the pure budget and burn-ceiling math.
//
// Cloudflare has no spend cap for Containers, so admission is where a deploy
// caps its own spend: every run passes the admission semaphore before it
// starts a container. Two limits bind there:
//
//   * a MONTHLY BUDGET — month-to-date spend at or over it closes admission,
//     and the run ends `RunSkipped` (a neutral check, a `skipped` row);
//   * a BURN CEILING — the summed hourly rate of every admitted execution,
//     across all pools, stays at or under it. The claim SQL enforces it
//     (runtime-cf run-admission-d1.ts); `fitsBurnCeiling` is its pure mirror.
//
// Money is integer micro-USD throughout, like the cost engine (cost.ts). This
// module holds no I/O and no clock: the runtime reads D1 and CONFIG_KV inside
// a durable step and hands the readings here.
//
// Spec: specs/adr/0006-spend-guard.md.

import { MICRO_USD_PER_USD } from "./cost";

/** The monthly budget a deploy that sets nothing gets, in USD. */
export const SPEND_BUDGET_MONTHLY_USD_DEFAULT = 50;
/** The burn ceiling a deploy that sets nothing gets, in USD per hour. */
export const SPEND_BURN_MAX_USD_PER_HOUR_DEFAULT = 1.5;
/** Multiplier for Workflow steps and Durable Objects on top of container + model spend. */
export const SPEND_OVERHEAD_FACTOR_DEFAULT = 1.1;
/** Fraction of the budget whose crossing sends the month's one warning. */
export const SPEND_WARN_RATIO_DEFAULT = 0.8;

/** The value that disables a limit, in a var or a `CONFIG_KV` override. */
export const SPEND_UNLIMITED = "unlimited";

/** The spend-guard settings an admission decides with. `null` = unlimited. */
export type SpendLimits = {
  readonly budgetMicroUsd: number | null;
  readonly burnMaxMicroUsdPerHour: number | null;
  readonly overheadFactor: number;
  readonly warnRatio: number;
};

/** The raw spend settings: wrangler vars, each overridable from `CONFIG_KV`. */
export type SpendVars = {
  readonly SPEND_BUDGET_MONTHLY_USD?: string | undefined;
  readonly SPEND_BURN_MAX_USD_PER_HOUR?: string | undefined;
  readonly SPEND_OVERHEAD_FACTOR?: string | undefined;
  readonly SPEND_WARN_RATIO?: string | undefined;
};

/** The `CONFIG_KV` overrides an operator writes to change a limit without a deploy. */
export type SpendOverrides = {
  readonly budgetMonthlyUsd?: string | null | undefined;
  readonly burnMaxUsdPerHour?: string | null | undefined;
};

const toMicro = (usd: number): number => Math.round(usd * MICRO_USD_PER_USD);

/** A present, non-blank override wins; otherwise the var. */
const pick = (override: string | null | undefined, value: string | undefined): string | undefined =>
  override !== null && override !== undefined && override.trim() !== "" ? override : value;

/**
 * Parse a USD limit into micro-USD. `unlimited` → `null`; a finite number ≥ 0
 * → its micro-USD value; absent, blank or garbage → `fallbackUsd`. A typo
 * degrades to the default limit, never to no limit.
 */
export const parseUsdLimit = (raw: string | null | undefined, fallbackUsd: number): number | null => {
  const text = raw?.trim();
  if (text === undefined || text === "") return toMicro(fallbackUsd);
  if (text.toLowerCase() === SPEND_UNLIMITED) return null;
  const usd = Number(text);
  return Number.isFinite(usd) && usd >= 0 ? toMicro(usd) : toMicro(fallbackUsd);
};

/** Parse a bounded ratio; outside `[min, max]` or unparsable → `fallback`. */
const parseRatio = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const text = raw?.trim();
  if (text === undefined || text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
};

/**
 * Resolve the limits: a present `CONFIG_KV` override wins over the var, and
 * the var over the code default. The defaults live here rather than in the
 * committed wrangler.jsonc because an operator overlay replaces that file.
 */
export const resolveSpendLimits = (vars: SpendVars, overrides: SpendOverrides = {}): SpendLimits => ({
  budgetMicroUsd: parseUsdLimit(
    pick(overrides.budgetMonthlyUsd, vars.SPEND_BUDGET_MONTHLY_USD),
    SPEND_BUDGET_MONTHLY_USD_DEFAULT,
  ),
  burnMaxMicroUsdPerHour: parseUsdLimit(
    pick(overrides.burnMaxUsdPerHour, vars.SPEND_BURN_MAX_USD_PER_HOUR),
    SPEND_BURN_MAX_USD_PER_HOUR_DEFAULT,
  ),
  overheadFactor: parseRatio(vars.SPEND_OVERHEAD_FACTOR, SPEND_OVERHEAD_FACTOR_DEFAULT, 1, 10),
  warnRatio: parseRatio(vars.SPEND_WARN_RATIO, SPEND_WARN_RATIO_DEFAULT, Number.MIN_VALUE, 1),
});

/** The current UTC calendar month: its bounds and its `YYYY-MM` key. */
export type SpendMonth = {
  readonly key: string;
  readonly startMs: number;
  /** When the month resets — the first instant of the next UTC month. */
  readonly resetsAtMs: number;
};

/** The UTC calendar month containing `nowMs`. */
export const spendMonth = (nowMs: number): SpendMonth => {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    startMs: Date.UTC(year, month, 1),
    resetsAtMs: Date.UTC(year, month + 1, 1),
  };
};

/**
 * What one spend read observed in D1 (runtime-cf spend-d1.ts), before the
 * overhead factor:
 *
 *   * `finishedMicroUsd` — `cost_micro_usd` of executions admitted this month;
 *   * `inFlightMicroUsd` — each admitted, unfinished execution's hourly rate ×
 *     the time since its admission;
 *   * `admittedMicroUsdPerHour` / `admittedCount` — the live admitted set the
 *     burn ceiling sums, across every pool.
 */
export type SpendReading = {
  readonly finishedMicroUsd: number;
  readonly inFlightMicroUsd: number;
  readonly admittedMicroUsdPerHour: number;
  readonly admittedCount: number;
};

/** Month-to-date spend: finished + in-flight, times the overhead factor. */
export const monthToDateMicroUsd = (reading: SpendReading, overheadFactor: number): number =>
  Math.round((reading.finishedMicroUsd + reading.inFlightMicroUsd) * overheadFactor);

/** `$12.34` — two decimals, the precision a budget line reads at. */
export const formatUsd = (microUsd: number): string => `$${(microUsd / MICRO_USD_PER_USD).toFixed(2)}`;

/**
 * The monthly-budget decision for one admission or spawn.
 *
 *   - `open`   — under budget (or unlimited); `warn` is true once spend sits at
 *                or over `warnRatio` of the budget.
 *   - `closed` — at or over budget: the run skips with `reason`.
 */
export type BudgetDecision =
  | { readonly _kind: "open"; readonly warn: boolean }
  | { readonly _kind: "closed"; readonly reason: string };

/** Decide the monthly budget from month-to-date spend. Pure. */
export const decideBudget = (spendMicroUsd: number, limits: SpendLimits): BudgetDecision => {
  const budget = limits.budgetMicroUsd;
  if (budget === null) return { _kind: "open", warn: false };
  if (spendMicroUsd >= budget) {
    return {
      _kind: "closed",
      reason: `spend budget reached: ${formatUsd(spendMicroUsd)} of ${formatUsd(budget)} this month`,
    };
  }
  return { _kind: "open", warn: spendMicroUsd >= budget * limits.warnRatio };
};

/**
 * Whether a claimant at `ownMicroUsdPerHour` fits under the burn ceiling — the
 * pure mirror of the claim SQL's ceiling clause. The admitted rates plus the
 * claimant's own must fit; a claimant whose own rate alone exceeds the
 * ceiling fits only an empty admitted set, so it never waits forever.
 */
export const fitsBurnCeiling = (opts: {
  readonly admittedMicroUsdPerHour: number;
  readonly admittedCount: number;
  readonly ownMicroUsdPerHour: number;
  readonly burnMaxMicroUsdPerHour: number | null;
}): boolean =>
  opts.burnMaxMicroUsdPerHour === null ||
  opts.admittedCount === 0 ||
  opts.admittedMicroUsdPerHour + opts.ownMicroUsdPerHour <= opts.burnMaxMicroUsdPerHour;

/** The `RunSkipped` reason for a run the burn ceiling held in the queue past its age. */
export const spendCeilingReason = (opts: {
  readonly admittedMicroUsdPerHour: number;
  readonly ownMicroUsdPerHour: number;
  readonly burnMaxMicroUsdPerHour: number;
}): string =>
  `spend ceiling: admitted runs burn ${formatUsd(opts.admittedMicroUsdPerHour)}/h of the ` +
  `${formatUsd(opts.burnMaxMicroUsdPerHour)}/h ceiling, this run needs ${formatUsd(opts.ownMicroUsdPerHour)}/h`;

/** The `CONFIG_KV` key that overrides the monthly budget (USD, or `unlimited`). */
export const SPEND_BUDGET_KV_KEY = "spend.budgetMonthlyUsd";
/** The `CONFIG_KV` key that overrides the burn ceiling (USD per hour, or `unlimited`). */
export const SPEND_BURN_KV_KEY = "spend.burnMaxUsdPerHour";
/** The `CONFIG_KV` marker that a month's warning went out. */
export const spendWarnedKvKey = (monthKey: string): string => `spend.warned:${monthKey}`;
