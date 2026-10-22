// Integration tests for recordExecutionCost — the per-execution cost rollup.
//
// Runs INSIDE workerd (real D1) like executions-d1.workers.test.ts. Seeds an
// `executions` row + `execution_model_usage` rows, then asserts the denormalized
// cost columns the rollup writes (and the metered/modeled basis the core cost
// engine derives).

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordExecutionCost } from "./execution-cost";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const EXEC = "01TEST0000000000000000COST";

/**
 * Insert a finished executions row admitted `activeMs` before it completed,
 * after `queuedMs` in the admission queue (`admittedAt: null` = never admitted).
 */
const seedExecution = (
  db: D1Database,
  id: string,
  activeMs: number,
  opts: { readonly queuedMs?: number; readonly admitted?: boolean } = {},
) => {
  const admittedAt = 1000 + (opts.queuedMs ?? 0);
  return db
    .prepare(
      `INSERT INTO executions
         (id, run, repo, ref, sha, status, started_at, admitted_at, completed_at, input_json)
       VALUES (?, 'pr-review', 'owner/name', 'refs/heads/main', 'abc', 'success', 1000, ?, ?, '{}')`,
    )
    .bind(id, opts.admitted === false ? null : admittedAt, admittedAt + activeMs)
    .run();
};

const seedUsage = (
  db: D1Database,
  id: string,
  model: string,
  inTok: number,
  outTok: number,
  metered: number,
) =>
  db
    .prepare(
      `INSERT INTO execution_model_usage
         (id, execution_id, model, input_tokens, output_tokens, calls, metered, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
    )
    .bind(`${id}:${model}`, id, model, inTok, outTok, metered)
    .run();

describe("recordExecutionCost", () => {
  let bindings: TestBindings;
  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("rolls up metered model tokens + modeled container compute as 'mixed'", async () => {
    // 480s admitted on standard-2 → 17_203 µ$ modeled container (vCPU +
    // memory + disk); sonnet 20k in / 2k out → 20000×3 + 2000×15 = 90_000 µ$
    // metered model.
    await seedExecution(bindings.db, EXEC, 480_000);
    await seedUsage(bindings.db, EXEC, "anthropic/claude-sonnet-4-6", 20_000, 2_000, 1);

    await Effect.runPromise(
      recordExecutionCost({ db: bindings.db, executionId: EXEC, instance: "standard-2" }),
    );

    const row = await bindings.db
      .prepare(
        `SELECT cost_micro_usd, cost_basis, input_tokens, output_tokens, vcpu_seconds, model
           FROM executions WHERE id = ?`,
      )
      .bind(EXEC)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({
      cost_micro_usd: 107_203, // 17_203 container + 90_000 model
      cost_basis: "mixed",
      input_tokens: 20_000,
      output_tokens: 2_000,
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(row?.vcpu_seconds).toBeCloseTo(480, 3); // 1 vCPU × 480 s
  });

  it("rolls up a container-only execution as 'modeled' with null token columns", async () => {
    await seedExecution(bindings.db, EXEC, 480_000);

    await Effect.runPromise(
      recordExecutionCost({ db: bindings.db, executionId: EXEC, instance: "standard-2" }),
    );

    const row = await bindings.db
      .prepare(
        `SELECT cost_micro_usd, cost_basis, input_tokens, output_tokens, model
           FROM executions WHERE id = ?`,
      )
      .bind(EXEC)
      .first<Record<string, unknown>>();

    expect(row).toMatchObject({ cost_micro_usd: 17_203, cost_basis: "modeled" });
    expect(row?.input_tokens).toBeNull();
    expect(row?.output_tokens).toBeNull();
    expect(row?.model).toBeNull();
  });

  it("prices admission to completion: queue wait costs nothing, and the row reads admitted-active", async () => {
    // 10 minutes queued, then 480 s admitted on standard-4.
    await seedExecution(bindings.db, EXEC, 480_000, { queuedMs: 600_000 });

    await Effect.runPromise(
      recordExecutionCost({ db: bindings.db, executionId: EXEC, instance: "standard-4" }),
    );

    const row = await bindings.db
      .prepare(`SELECT cost_micro_usd, cost_meter, vcpu_seconds FROM executions WHERE id = ?`)
      .bind(EXEC)
      .first<{ cost_micro_usd: number; cost_meter: string; vcpu_seconds: number }>();
    // (4 × 20 + 12 × 2.5 + 20 × 0.07) µ$/s × 480 s = 111.4 × 480.
    expect(row).toMatchObject({ cost_micro_usd: 53_472, cost_meter: "admitted-active" });
    expect(row?.vcpu_seconds).toBeCloseTo(1920, 3);
  });

  it("charges no container time to an execution never admitted", async () => {
    await seedExecution(bindings.db, EXEC, 480_000, { admitted: false });

    await Effect.runPromise(
      recordExecutionCost({ db: bindings.db, executionId: EXEC, instance: "standard-4" }),
    );

    const row = await bindings.db
      .prepare(`SELECT cost_micro_usd FROM executions WHERE id = ?`)
      .bind(EXEC)
      .first<{ cost_micro_usd: number }>();
    expect(row?.cost_micro_usd).toBe(0);
  });

  it("upsert-SUM accumulates a same-model fan-out (no double-count on the PK)", async () => {
    await seedExecution(bindings.db, EXEC, 10_000);
    // Two writes to the SAME (execution, model) PK — the gateway wrapper's
    // ON CONFLICT DO UPDATE sums them (a 7-way pr-review fan-out lands here).
    const upsert = (inTok: number, outTok: number) =>
      bindings.db
        .prepare(
          `INSERT INTO execution_model_usage
             (id, execution_id, model, input_tokens, output_tokens, calls, metered, updated_at)
           VALUES (?, ?, 'anthropic/claude-opus-4-6', ?, ?, 1, 1, 0)
           ON CONFLICT(id) DO UPDATE SET
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             calls = calls + 1`,
        )
        .bind(`${EXEC}:anthropic/claude-opus-4-6`, EXEC, inTok, outTok)
        .run();
    await upsert(1_000, 100);
    await upsert(1_000, 100);

    await Effect.runPromise(
      recordExecutionCost({ db: bindings.db, executionId: EXEC, instance: "standard-2" }),
    );

    const row = await bindings.db
      .prepare(`SELECT input_tokens, output_tokens FROM executions WHERE id = ?`)
      .bind(EXEC)
      .first<{ input_tokens: number; output_tokens: number }>();
    expect(row?.input_tokens).toBe(2_000); // summed, not 1_000
    expect(row?.output_tokens).toBe(200);
  });
});
