// The spend guard's reader-facing surfaces: a budget or ceiling skip concludes
// the check neutral, and `GET /api/spend` / the dashboard line project one
// spend read (specs/adr/0006-spend-guard.md).

import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  decideBudget,
  resolveSpendLimits,
  RunSkipped,
  spendCeilingReason,
  spendMonth,
} from "@fractalboxdev/flare-dispatch-core";
import type { SpendStatus } from "@fractalboxdev/flare-dispatch-runtime-cf/spend";
import { runSkippedReason } from "../failure-summary";
import { handleRequest } from "../router";
import { makeFakeD1, makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import { checkConclusion } from "../terminal-verdict";
import { spendLine, spendView } from "./spend";

const NOW = Date.UTC(2026, 9, 22, 12, 0);

const status = (monthToDateMicroUsd: number, admittedMicroUsdPerHour = 401_040): SpendStatus => {
  const limits = resolveSpendLimits({});
  return {
    month: spendMonth(NOW),
    limits,
    reading: {
      finishedMicroUsd: monthToDateMicroUsd,
      inFlightMicroUsd: 0,
      admittedMicroUsdPerHour,
      admittedCount: 1,
    },
    monthToDateMicroUsd,
    decision: decideBudget(monthToDateMicroUsd, limits),
  };
};

describe("a spend skip concludes neutral", () => {
  it("records a budget skip as skipped with its reason, and a neutral check", () => {
    const decision = decideBudget(50_500_000, resolveSpendLimits({}));
    if (decision._kind !== "closed") throw new Error("expected a closed budget");
    const exit = Exit.fail(new RunSkipped({ reason: decision.reason }));
    expect(runSkippedReason(exit)).toBe("spend budget reached: $50.50 of $50.00 this month");
    expect(checkConclusion("skipped", true)).toBe("neutral");
  });

  it("records a burn-ceiling queue timeout as a skip", () => {
    const reason = spendCeilingReason({
      admittedMicroUsdPerHour: 1_203_120,
      ownMicroUsdPerHour: 401_040,
      burnMaxMicroUsdPerHour: 1_500_000,
    });
    expect(runSkippedReason(Exit.fail(new RunSkipped({ reason })))).toMatch(/^spend ceiling: /);
  });
});

describe("spendView", () => {
  it("returns month-to-date spend, the limits, the admitted burn and the reset", () => {
    expect(spendView(status(12_340_000))).toEqual({
      month: "2026-10",
      monthToDateUsd: 12.34,
      budgetUsd: 50,
      burnMaxUsdPerHour: 1.5,
      admittedUsdPerHour: 0.40104,
      admittedCount: 1,
      overheadFactor: 1.1,
      warnRatio: 0.8,
      budgetReached: false,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
  });

  it("reports an unlimited limit as null", () => {
    const open = status(1_000_000);
    const view = spendView({
      ...open,
      limits: { ...open.limits, budgetMicroUsd: null, burnMaxMicroUsdPerHour: null },
    });
    expect(view).toMatchObject({ budgetUsd: null, burnMaxUsdPerHour: null });
  });
});

describe("GET /api/spend", () => {
  const env = (viewerAccessMode?: "required") =>
    makeFakeEnv({
      hmacSecret: "s",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      metadata: makeFakeD1({ executions: [] }),
      ...(viewerAccessMode !== undefined ? { viewerAccessMode } : {}),
    });

  it("returns the deploy's spend view under the code defaults", async () => {
    const res = await handleRequest(new Request("https://dispatcher.example.com/api/spend"), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      monthToDateUsd: 0,
      budgetUsd: 50,
      burnMaxUsdPerHour: 1.5,
      budgetReached: false,
    });
  });

  it("is a GET viewer surface: Access gates it first, then the method", async () => {
    const gated = await handleRequest(
      new Request("https://dispatcher.example.com/api/spend"),
      env("required"),
    );
    expect(gated.status).toBe(503);
    const posted = await handleRequest(
      new Request("https://dispatcher.example.com/api/spend", { method: "POST" }),
      env(),
    );
    expect(posted.status).toBe(405);
  });
});

describe("spendLine", () => {
  it("is the dashboard's one-line summary", () => {
    expect(spendLine(status(12_340_000))).toBe(
      "Spend 2026-10: $12.34 of $50.00 · burn $0.40/h of $1.50/h · resets 2026-11-01",
    );
  });

  it("says when the budget closed", () => {
    expect(spendLine(status(55_000_000))).toContain("$55.00 of $50.00 — budget reached, runs skip");
  });
});
