// Integration tests for the D1-backed run admission semaphore — the
// atomic-correctness surface the pure decision logic (`@fractalboxdev/flare-dispatch-core`
// run-admission.test.ts) cannot cover: the conditional FIFO claim against a
// real D1 binding, mirroring container-lease-d1.workers.test.ts. Runs INSIDE
// workerd via `@cloudflare/vitest-pool-workers` (see `vitest.workers.config.ts`).
//
// The bounded poll loop + dispatch-age timeout live in the dispatcher's
// `RunWorkflow` (durable steps) and are governed by the pure
// `admissionAcquireAttempts` / `decideAdmission` (unit-tested) plus an
// `AdmissionTimedOut` constructor sample (errors.test.ts), so they are not
// re-driven here. These tests cover the strongly-consistent state
// transitions: enqueue idempotence + parent FIFO-key inheritance, claim
// under/at the cap, FIFO no-barge among live waiters, stale-waiter
// unblocking, stale-admitted reclaim, replay re-entrancy, pool independence,
// and release + opportunistic GC.

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideAdmission, type AdmissionPool } from "@fractalboxdev/flare-dispatch-core";
import {
  ADMISSION_CAP_DEFAULT,
  ADMISSION_MAX_QUEUE_AGE_MS,
  ADMISSION_TTL_MS,
  ADMISSION_WAITER_TTL_MS,
  makeRunAdmissionD1,
  resolveAdmissionCap,
  resolvePoolAdmissionCap,
  RELEASE_ADMISSION_CAP_DEFAULT,
  AGENT_ADMISSION_CAP_DEFAULT,
} from "./run-admission-d1";
import { makeTestBindings, type TestBindings } from "./test-support-workers";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FBB";
const T0 = 1_000_000;

describe("makeRunAdmissionD1 — atomic admission against real D1", () => {
  let bindings: TestBindings;

  it("keeps a queued run live through a 30-minute pool turnover", () => {
    const observed = { admitted: false, position: 14, poolBusy: 16 };
    expect(decideAdmission(observed, 0, 19 * 60_000, ADMISSION_MAX_QUEUE_AGE_MS)._kind).toBe(
      "wait",
    );
    expect(decideAdmission(observed, 0, 20 * 60_000, ADMISSION_MAX_QUEUE_AGE_MS)._kind).toBe(
      "timeout",
    );
    expect(decideAdmission(observed, 0, 30 * 60_000, 90 * 60_000)._kind).toBe("wait");
    expect(decideAdmission(observed, 0, 90 * 60_000, 90 * 60_000)._kind).toBe("timeout");
  });

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const row = (executionId: string) =>
    bindings.db
      .prepare(`SELECT * FROM run_admissions WHERE execution_id = ?`)
      .bind(executionId)
      .first<{
        execution_id: string;
        pool: string;
        state: string;
        enqueued_at: number;
        admitted_at: number | null;
        heartbeat_at: number;
      }>();

  /** Seed a peer row directly — fills the pool without driving N claims. */
  const seed = (
    executionId: string,
    pool: AdmissionPool,
    state: "queued" | "admitted",
    enqueuedAt: number,
    heartbeatAt: number,
  ) =>
    bindings.db
      .prepare(
        `INSERT INTO run_admissions
           (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        executionId,
        pool,
        state,
        enqueuedAt,
        state === "admitted" ? enqueuedAt : null,
        heartbeatAt,
      )
      .run();

  /** Fill a pool to the cap with live admitted peers. */
  const fillPool = async (pool: AdmissionPool, heartbeatAt: number) => {
    for (let i = 0; i < ADMISSION_CAP_DEFAULT; i++) {
      await seed(
        `peer-${pool}-${String(i).padStart(2, "0")}`,
        pool,
        "admitted",
        T0 - 1_000,
        heartbeatAt,
      );
    }
  };

  it("enqueue writes a queued row and is idempotent (replay keeps the FIFO key)", async () => {
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);

    const first = await Effect.runPromise(store.enqueue(A, "lean"));
    expect(first.enqueuedAt).toBe(T0);
    expect(await row(A)).toMatchObject({
      pool: "lean",
      state: "queued",
      enqueued_at: T0,
      heartbeat_at: T0,
    });

    // A replayed enqueue at a later clock returns the ORIGINAL timestamp —
    // the FIFO key and the dispatch-age basis never move.
    clock = T0 + 60_000;
    const replayed = await Effect.runPromise(store.enqueue(A, "lean"));
    expect(replayed.enqueuedAt).toBe(T0);
  });

  it("a child inherits its parent's enqueued_at (matrix-children mitigation, ADR note 2)", async () => {
    // The parent enqueued (and was admitted) long before the child spawns;
    // the child must NOT queue behind other parents' later rows.
    await seed("parent", "lean", "admitted", T0 - 500_000, T0);
    const store = makeRunAdmissionD1(bindings.db, () => T0);

    const child = await Effect.runPromise(store.enqueue("child", "lean", "parent"));
    expect(child.enqueuedAt).toBe(T0 - 500_000);
  });

  it("a missing parent row degrades to the child's own clock", async () => {
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const child = await Effect.runPromise(store.enqueue("orphan", "lean", "long-gone-parent"));
    expect(child.enqueuedAt).toBe(T0);
  });

  it("admits under the cap — the claim flips the row atomically", async () => {
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));

    const observed = await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    expect(observed.admitted).toBe(true);
    expect(await row(A)).toMatchObject({
      state: "admitted",
      admitted_at: T0,
    });
  });

  it("is re-entrant — a replayed attempt after the claim landed stays admitted", async () => {
    // A Worker that died after the claim UPDATE but before the step
    // checkpointed replays the attempt with the row already 'admitted'; it
    // must short-circuit to admitted, not spin until timeout holding a slot.
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));
    await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));

    clock = T0 + 20_000;
    const replayed = await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    expect(replayed.admitted).toBe(true);
    // The short-circuit refreshed the holder heartbeat.
    expect((await row(A))?.heartbeat_at).toBe(T0 + 20_000);
  });

  it("waits at the cap, reporting the busy count", async () => {
    await fillPool("lean", T0);
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));

    const observed = await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    expect(observed).toMatchObject({
      admitted: false,
      position: 0,
      poolBusy: ADMISSION_CAP_DEFAULT,
    });
    expect((await row(A))?.state).toBe("queued");
  });

  it("FIFO no-barge: a later waiter cannot take a freed slot past a live earlier one", async () => {
    // Pool one slot short of the cap; A queued before B.
    for (let i = 0; i < ADMISSION_CAP_DEFAULT - 1; i++) {
      await seed(`peer-${i}`, "lean", "admitted", T0 - 1_000, T0);
    }
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);
    const a = await Effect.runPromise(store.enqueue(A, "lean"));
    clock = T0 + 1_000;
    const b = await Effect.runPromise(store.enqueue(B, "lean"));

    // B polls first (claim races are arrival-order-free) — must NOT barge.
    const bObserved = await Effect.runPromise(store.attempt(B, "lean", b.enqueuedAt));
    expect(bObserved.admitted).toBe(false);
    expect(bObserved.position).toBe(1); // A is ahead
    // A takes the slot; only then can B (pool now full again) keep waiting.
    const aObserved = await Effect.runPromise(store.attempt(A, "lean", a.enqueuedAt));
    expect(aObserved.admitted).toBe(true);
  });

  it("ULID tiebreak: equal enqueued_at falls back to execution-id order", async () => {
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    await Effect.runPromise(store.enqueue(B, "lean"));
    await Effect.runPromise(store.enqueue(A, "lean"));

    // B has the lexicographically LARGER id, so with equal enqueued_at A is
    // ahead of B — B must wait even with the whole pool free.
    const bObserved = await Effect.runPromise(store.attempt(B, "lean", T0));
    expect(bObserved.admitted).toBe(false);
    expect(bObserved.position).toBe(1);
    const aObserved = await Effect.runPromise(store.attempt(A, "lean", T0));
    expect(aObserved.admitted).toBe(true);
  });

  it("a stale waiter stops blocking the line (dead waiter never wedges FIFO)", async () => {
    // A enqueued earlier but its Worker died — heartbeat staled past the
    // waiter TTL. B (later) must claim straight past it.
    await seed(A, "lean", "queued", T0 - 10_000, T0 - ADMISSION_WAITER_TTL_MS - 1);
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const b = await Effect.runPromise(store.enqueue(B, "lean"));

    const observed = await Effect.runPromise(store.attempt(B, "lean", b.enqueuedAt));
    expect(observed.admitted).toBe(true);
  });

  it("stale admitted rows stop counting toward the cap (crashed-run slots free themselves)", async () => {
    // A full pool of presumed-dead holders: every heartbeat predates the TTL.
    await fillPool("lean", T0 - ADMISSION_TTL_MS - 1);
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));

    const observed = await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    expect(observed.admitted).toBe(true);
  });

  it("pools are independent semaphores — a saturated lean pool never blocks browser", async () => {
    await fillPool("lean", T0);
    const store = makeRunAdmissionD1(bindings.db, () => T0);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "browser"));

    const observed = await Effect.runPromise(store.attempt(A, "browser", enqueuedAt));
    expect(observed.admitted).toBe(true);
  });

  it("release deletes the caller's row and GCs stale corpses, sparing live peers", async () => {
    // Release runs on EVERY workflow exit path (Effect.ensuring) — including
    // failures — so the slot a failed run held frees immediately.
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));
    await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));

    // A live peer and a long-dead corpse, both sharing the table.
    await seed(B, "lean", "admitted", T0, T0);
    await seed("corpse", "lean", "queued", T0 - 9_000_000, T0 - ADMISSION_TTL_MS - 1);

    await Effect.runPromise(store.release(A));
    expect(await row(A)).toBeNull(); // own slot freed
    expect(await row("corpse")).toBeNull(); // opportunistic GC
    expect((await row(B))?.state).toBe("admitted"); // live peer untouched

    // Idempotent — a second release (double ensuring) is a no-op.
    await Effect.runPromise(store.release(A));
    expect((await row(B))?.state).toBe("admitted");
  });

  it("heartbeat refreshes only the caller's row", async () => {
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));
    await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    await seed(B, "lean", "admitted", T0, T0);

    clock = T0 + 150_000;
    await Effect.runPromise(store.heartbeat(A));
    expect((await row(A))?.heartbeat_at).toBe(T0 + 150_000);
    expect((await row(B))?.heartbeat_at).toBe(T0);
  });

  it("honours an operator-tuned cap below the default (ADMISSION_CAP var)", async () => {
    // Cap = 2 with two live admitted peers — full despite the default of 16.
    await seed("peer-0", "lean", "admitted", T0 - 1_000, T0);
    await seed("peer-1", "lean", "admitted", T0 - 1_000, T0);
    const store = makeRunAdmissionD1(bindings.db, () => T0, 2);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));

    const observed = await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    expect(observed).toMatchObject({ admitted: false, poolBusy: 2 });

    // The same state under the DEFAULT cap admits — only the cap differs.
    const storeDefault = makeRunAdmissionD1(bindings.db, () => T0);
    const admitted = await Effect.runPromise(storeDefault.attempt(A, "lean", enqueuedAt));
    expect(admitted.admitted).toBe(true);
  });

  it("a second release's cells queue once eight release cells are admitted", async () => {
    const cap = resolvePoolAdmissionCap("release", { ADMISSION_CAP: "16" });
    expect(cap).toBe(8);
    for (let i = 0; i < cap; i++) await seed(`cell-${i}`, "release", "admitted", T0 - 1_000, T0);
    const store = makeRunAdmissionD1(bindings.db, () => T0, cap);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "release"));
    expect(await Effect.runPromise(store.attempt(A, "release", enqueuedAt))).toMatchObject({ admitted: false, poolBusy: cap });
  });
});

describe("resolveAdmissionCap — the ADMISSION_CAP wrangler var", () => {
  it("parses a numeric var", () => {
    expect(resolveAdmissionCap("14")).toBe(14);
  });

  it("defaults when unset", () => {
    expect(resolveAdmissionCap(undefined)).toBe(ADMISSION_CAP_DEFAULT);
  });

  it("degrades garbage / non-positive values to the default, never zero slots", () => {
    expect(resolveAdmissionCap("sixteen")).toBe(ADMISSION_CAP_DEFAULT);
    expect(resolveAdmissionCap("")).toBe(ADMISSION_CAP_DEFAULT);
    expect(resolveAdmissionCap("0")).toBe(ADMISSION_CAP_DEFAULT);
    expect(resolveAdmissionCap("-3")).toBe(ADMISSION_CAP_DEFAULT);
  });
});

describe("resolvePoolAdmissionCap — one cap per pool", () => {
  it("caps the release pool at its eight containers under the shared cap of 16", () => {
    expect(RELEASE_ADMISSION_CAP_DEFAULT).toBe(8);
    expect(resolvePoolAdmissionCap("release", { ADMISSION_CAP: "16" })).toBe(8);
    expect(resolvePoolAdmissionCap("release", { ADMISSION_CAP: "16", ADMISSION_CAP_RELEASE: "10" })).toBe(10);
    expect(resolvePoolAdmissionCap("release", { ADMISSION_CAP: "16", ADMISSION_CAP_RELEASE: "eight" })).toBe(8);
  });

  it("never lets the release cap exceed the shared cap", () => {
    expect(resolvePoolAdmissionCap("release", { ADMISSION_CAP: "4" })).toBe(4);
    expect(resolvePoolAdmissionCap("release", { ADMISSION_CAP: "4", ADMISSION_CAP_RELEASE: "12" })).toBe(4);
  });

  it("caps the agent pool at its eight containers under the shared cap of 16", () => {
    expect(AGENT_ADMISSION_CAP_DEFAULT).toBe(8);
    expect(resolvePoolAdmissionCap("agent", { ADMISSION_CAP: "16" })).toBe(8);
    expect(resolvePoolAdmissionCap("agent", { ADMISSION_CAP: "16", ADMISSION_CAP_AGENT: "6" })).toBe(6);
    expect(resolvePoolAdmissionCap("agent", { ADMISSION_CAP: "4", ADMISSION_CAP_AGENT: "12" })).toBe(4);
  });

  it("leaves the lean and browser pools on the shared cap", () => {
    for (const pool of ["lean", "browser"] as const) {
      expect(resolvePoolAdmissionCap(pool, { ADMISSION_CAP: "16", ADMISSION_CAP_AGENT: "8", ADMISSION_CAP_RELEASE: "8" })).toBe(16);
      expect(resolvePoolAdmissionCap(pool, {})).toBe(ADMISSION_CAP_DEFAULT);
    }
  });
});
