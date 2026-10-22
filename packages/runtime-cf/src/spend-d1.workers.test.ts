// Integration tests for the spend guard's I/O against real D1 and KV: the
// month-to-date read, the CONFIG_KV limit overrides, and the once-per-month
// warning marker (specs/adr/0006-spend-guard.md). The pure math is covered by
// core spend.test.ts.

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSpendLimits, type SpendLimits } from "@fractalboxdev/flare-dispatch-core";
import { readSpend, readSpendLimits, readSpendStatus, warnSpendOnce } from "./spend-d1";
import { ADMISSION_TTL_MS } from "./run-admission-d1";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const NOW = Date.UTC(2026, 9, 22, 12, 0);
const MONTH_START = Date.UTC(2026, 9, 1);
const HOUR = 3_600_000;

describe("spend-d1", () => {
  let bindings: TestBindings;
  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const seedFinished = (id: string, admittedAt: number | null, cost: number) =>
    bindings.db
      .prepare(
        `INSERT INTO executions
           (id, run, repo, ref, sha, status, started_at, admitted_at, completed_at, input_json, cost_micro_usd)
         VALUES (?, 'check', 'owner/name', 'refs/heads/main', 'abc', 'success', ?, ?, ?, '{}', ?)`,
      )
      .bind(id, admittedAt ?? NOW, admittedAt, NOW, cost)
      .run();

  const seedAdmitted = (id: string, admittedAt: number, rate: number, heartbeatAt = NOW) =>
    bindings.db
      .prepare(
        `INSERT INTO run_admissions
           (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at, hourly_rate_micro_usd)
         VALUES (?, 'lean', 'admitted', ?, ?, ?, ?)`,
      )
      .bind(id, admittedAt, admittedAt, heartbeatAt, rate)
      .run();

  it("sums finished executions admitted this month and in-flight burn since admission", async () => {
    await seedFinished("f1", MONTH_START + HOUR, 3_000_000);
    await seedFinished("f2", NOW - HOUR, 1_000_000);
    // Admitted last month: not this month's spend.
    await seedFinished("old", MONTH_START - HOUR, 50_000_000);
    // Priced before the meter (no admission stamp): not counted.
    await seedFinished("legacy", null, 7_000_000);
    // In flight for two hours at $0.40/h; a stale row counts for nothing.
    await seedAdmitted("live", NOW - 2 * HOUR, 400_000);
    await seedAdmitted("corpse", NOW - 2 * HOUR, 400_000, NOW - ADMISSION_TTL_MS - 1);

    const reading = await Effect.runPromise(readSpend(bindings.db, NOW));
    expect(reading).toEqual({
      finishedMicroUsd: 4_000_000,
      inFlightMicroUsd: 800_000,
      admittedMicroUsdPerHour: 400_000,
      admittedCount: 1,
    });
  });

  it("closes the budget once spend times the overhead reaches it", async () => {
    await seedFinished("f1", NOW - HOUR, 46_000_000);
    const limits = resolveSpendLimits({});
    const status = await Effect.runPromise(readSpendStatus(bindings.db, limits, NOW));
    // 46 × 1.10 = 50.60 ≥ 50.
    expect(status.monthToDateMicroUsd).toBe(50_600_000);
    expect(status.decision).toEqual({
      _kind: "closed",
      reason: "spend budget reached: $50.60 of $50.00 this month",
    });
    expect(status.month.key).toBe("2026-10");
  });

  it("reads the CONFIG_KV overrides over the vars", async () => {
    await bindings.kv.put("spend.budgetMonthlyUsd", "unlimited");
    await bindings.kv.put("spend.burnMaxUsdPerHour", "4");
    const limits = await Effect.runPromise(
      readSpendLimits(bindings.kv, { SPEND_BUDGET_MONTHLY_USD: "50", SPEND_BURN_MAX_USD_PER_HOUR: "2" }),
    );
    expect(limits).toMatchObject({ budgetMicroUsd: null, burnMaxMicroUsdPerHour: 4_000_000 });
    expect(await Effect.runPromise(readSpendLimits(undefined, { SPEND_BUDGET_MONTHLY_USD: "50" }))).toMatchObject(
      { budgetMicroUsd: 50_000_000 },
    );
  });

  it("warns once per month past the warn ratio, marking the month in CONFIG_KV", async () => {
    await seedFinished("f1", NOW - HOUR, 40_000_000);
    const limits: SpendLimits = resolveSpendLimits({});
    const status = await Effect.runPromise(readSpendStatus(bindings.db, limits, NOW));
    const sent: string[] = [];
    const notify = async (text: string, month: string) => {
      sent.push(`${month}: ${text}`);
    };

    expect(await Effect.runPromise(warnSpendOnce({ kv: bindings.kv, status, notify }))).toBe(true);
    expect(await Effect.runPromise(warnSpendOnce({ kv: bindings.kv, status, notify }))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("2026-10: FlareDispatch spend reached $44.00 of the $50.00 monthly budget");
    expect(await bindings.kv.get("spend.warned:2026-10")).toBe("44000000");
  });

  it("sends no warning under the warn ratio", async () => {
    await seedFinished("f1", NOW - HOUR, 10_000_000);
    const status = await Effect.runPromise(readSpendStatus(bindings.db, resolveSpendLimits({}), NOW));
    let calls = 0;
    const warned = await Effect.runPromise(
      warnSpendOnce({ kv: bindings.kv, status, notify: async () => void calls++ }),
    );
    expect(warned).toBe(false);
    expect(calls).toBe(0);
    expect(await bindings.kv.get("spend.warned:2026-10")).toBeNull();
  });
});
