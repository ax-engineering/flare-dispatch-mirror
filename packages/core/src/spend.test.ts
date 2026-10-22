// Spend-guard math — the limits a deploy resolves, the month window, the
// budget decision and the burn-ceiling fit (specs/adr/0006-spend-guard.md).

import { describe, expect, it } from "vitest";
import { containerMicroUsdPerHour } from "./cost";
import {
  decideBudget,
  fitsBurnCeiling,
  monthToDateMicroUsd,
  parseUsdLimit,
  resolveSpendLimits,
  spendCeilingReason,
  spendMonth,
  type SpendLimits,
} from "./spend";

const LIMITS: SpendLimits = {
  budgetMicroUsd: 90_000_000,
  burnMaxMicroUsdPerHour: 1_500_000,
  overheadFactor: 1.1,
  warnRatio: 0.8,
};

describe("resolveSpendLimits", () => {
  it("caps a deploy that sets nothing at 50 USD a month and 1.50 USD an hour", () => {
    expect(resolveSpendLimits({})).toEqual({ ...LIMITS, budgetMicroUsd: 50_000_000 });
  });

  it("reads the vars, and a CONFIG_KV override wins over them", () => {
    const vars = { SPEND_BUDGET_MONTHLY_USD: "200", SPEND_BURN_MAX_USD_PER_HOUR: "3" };
    expect(resolveSpendLimits(vars)).toMatchObject({
      budgetMicroUsd: 200_000_000,
      burnMaxMicroUsdPerHour: 3_000_000,
    });
    expect(
      resolveSpendLimits(vars, { budgetMonthlyUsd: "250", burnMaxUsdPerHour: null }),
    ).toMatchObject({ budgetMicroUsd: 250_000_000, burnMaxMicroUsdPerHour: 3_000_000 });
  });

  it("disables a limit on `unlimited`, from either source", () => {
    expect(resolveSpendLimits({ SPEND_BUDGET_MONTHLY_USD: "unlimited" }).budgetMicroUsd).toBeNull();
    expect(
      resolveSpendLimits({}, { burnMaxUsdPerHour: " Unlimited " }).burnMaxMicroUsdPerHour,
    ).toBeNull();
  });

  it("degrades a typo to the default, never to no limit", () => {
    expect(parseUsdLimit("ninety", 90)).toBe(90_000_000);
    expect(parseUsdLimit("-5", 90)).toBe(90_000_000);
    expect(parseUsdLimit("", 90)).toBe(90_000_000);
    expect(resolveSpendLimits({ SPEND_OVERHEAD_FACTOR: "0.5", SPEND_WARN_RATIO: "2" })).toMatchObject({
      overheadFactor: 1.1,
      warnRatio: 0.8,
    });
  });

  it("treats a blank override as absent", () => {
    expect(
      resolveSpendLimits({ SPEND_BUDGET_MONTHLY_USD: "40" }, { budgetMonthlyUsd: "  " }).budgetMicroUsd,
    ).toBe(40_000_000);
  });
});

describe("spendMonth", () => {
  it("is the UTC calendar month and resets at the next one", () => {
    const month = spendMonth(Date.UTC(2026, 9, 22, 13, 5));
    expect(month).toEqual({
      key: "2026-10",
      startMs: Date.UTC(2026, 9, 1),
      resetsAtMs: Date.UTC(2026, 10, 1),
    });
    expect(spendMonth(Date.UTC(2026, 11, 31, 23, 59)).resetsAtMs).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("monthToDateMicroUsd", () => {
  it("adds finished and in-flight spend, times the overhead factor", () => {
    expect(
      monthToDateMicroUsd(
        { finishedMicroUsd: 10_000_000, inFlightMicroUsd: 2_000_000, admittedMicroUsdPerHour: 0, admittedCount: 0 },
        1.1,
      ),
    ).toBe(13_200_000);
  });
});

describe("decideBudget", () => {
  it("stays open under the budget and warns past the warn ratio", () => {
    expect(decideBudget(10_000_000, LIMITS)).toEqual({ _kind: "open", warn: false });
    expect(decideBudget(72_000_000, LIMITS)).toEqual({ _kind: "open", warn: true });
  });

  it("closes at the budget with the skip reason", () => {
    expect(decideBudget(90_000_000, LIMITS)).toEqual({
      _kind: "closed",
      reason: "spend budget reached: $90.00 of $90.00 this month",
    });
    expect(decideBudget(91_234_567, LIMITS)).toMatchObject({
      reason: "spend budget reached: $91.23 of $90.00 this month",
    });
  });

  it("never closes an unlimited budget", () => {
    expect(decideBudget(10 ** 12, { ...LIMITS, budgetMicroUsd: null })).toEqual({
      _kind: "open",
      warn: false,
    });
  });
});

describe("fitsBurnCeiling", () => {
  const fits = (admitted: readonly number[], own: number, ceiling: number | null = 1_500_000) =>
    fitsBurnCeiling({
      admittedMicroUsdPerHour: admitted.reduce((a, b) => a + b, 0),
      admittedCount: admitted.length,
      ownMicroUsdPerHour: own,
      burnMaxMicroUsdPerHour: ceiling,
    });

  it("admits three standard-4 containers, or eleven standard-2, under the default ceiling", () => {
    const s4 = containerMicroUsdPerHour("standard-4");
    const s2 = containerMicroUsdPerHour("standard-2");
    expect(fits([s4, s4], s4)).toBe(true);
    expect(fits([s4, s4, s4], s4)).toBe(false);
    expect(fits(Array(10).fill(s2), s2)).toBe(true);
    expect(fits(Array(11).fill(s2), s2)).toBe(false);
  });

  it("admits a claimant whose own rate exceeds the ceiling into an empty set only", () => {
    expect(fits([], 2_000_000)).toBe(true);
    expect(fits([100_000], 2_000_000)).toBe(false);
  });

  it("always fits with no ceiling", () => {
    expect(fits([10_000_000], 10_000_000, null)).toBe(true);
  });
});

describe("spendCeilingReason", () => {
  it("names the burn and the ceiling", () => {
    expect(
      spendCeilingReason({
        admittedMicroUsdPerHour: 1_203_120,
        ownMicroUsdPerHour: 401_040,
        burnMaxMicroUsdPerHour: 1_500_000,
      }),
    ).toBe("spend ceiling: admitted runs burn $1.20/h of the $1.50/h ceiling, this run needs $0.40/h");
  });
});
