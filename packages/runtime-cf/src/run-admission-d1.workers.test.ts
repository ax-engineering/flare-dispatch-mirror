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
import {
  ADMISSION_POLL_MAX_MS,
  containerMicroUsdPerHour,
  decideAdmission,
  type AdmissionClass,
  type AdmissionPool,
} from "@fractalboxdev/flare-dispatch-core";
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
  BROWSER_ADMISSION_CAP_DEFAULT,
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

  it("caps the browser pool by ADMISSION_CAP_BROWSER under the shared cap", () => {
    expect(BROWSER_ADMISSION_CAP_DEFAULT).toBe(16);
    expect(resolvePoolAdmissionCap("browser", { ADMISSION_CAP: "16" })).toBe(16);
    expect(resolvePoolAdmissionCap("browser", { ADMISSION_CAP: "16", ADMISSION_CAP_BROWSER: "6" })).toBe(6);
    expect(resolvePoolAdmissionCap("browser", { ADMISSION_CAP: "4", ADMISSION_CAP_BROWSER: "12" })).toBe(4);
    expect(resolvePoolAdmissionCap("browser", { ADMISSION_CAP: "16", ADMISSION_CAP_BROWSER: "six" })).toBe(16);
  });

  it("leaves the lean pool on the shared cap", () => {
    expect(
      resolvePoolAdmissionCap("lean", {
        ADMISSION_CAP: "16",
        ADMISSION_CAP_AGENT: "8",
        ADMISSION_CAP_BROWSER: "6",
        ADMISSION_CAP_RELEASE: "8",
      }),
    ).toBe(16);
    expect(resolvePoolAdmissionCap("lean", {})).toBe(ADMISSION_CAP_DEFAULT);
  });

  it("keeps a waiter live across three of the longest poll sleeps", () => {
    expect(ADMISSION_WAITER_TTL_MS).toBeGreaterThanOrEqual(3 * ADMISSION_POLL_MAX_MS);
  });
});

// The burn ceiling inside the claim (specs/adr/0006-spend-guard.md § Burn
// ceiling): admitted hourly rates across EVERY pool plus the claimant's own
// must fit, an oversized claimant admits only into an empty set, and a
// non-landing claim reports whether the ceiling or the cap held it.
describe("makeRunAdmissionD1 — the burn ceiling", () => {
  let bindings: TestBindings;
  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const S4 = containerMicroUsdPerHour("standard-4"); // 401_040 µ$/h
  const S2 = containerMicroUsdPerHour("standard-2"); // 129_024 µ$/h
  const CEILING = 1_500_000;

  const seedAdmitted = (executionId: string, pool: AdmissionPool, rate: number) =>
    bindings.db
      .prepare(
        `INSERT INTO run_admissions
           (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at, hourly_rate_micro_usd)
         VALUES (?, ?, 'admitted', ?, ?, ?, ?)`,
      )
      .bind(executionId, pool, T0 - 1_000, T0 - 1_000, T0, rate)
      .run();

  const claim = async (executionId: string, pool: AdmissionPool, rate: number, ceiling: number | null = CEILING) => {
    const store = makeRunAdmissionD1(bindings.db, () => T0, ADMISSION_CAP_DEFAULT, {
      hourlyRateMicroUsd: rate,
      burnMaxMicroUsdPerHour: ceiling,
    });
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(executionId, pool));
    return Effect.runPromise(store.attempt(executionId, pool, enqueuedAt));
  };

  it("records the claimant's hourly rate on its row", async () => {
    await claim(A, "lean", S4);
    const row = await bindings.db
      .prepare(`SELECT hourly_rate_micro_usd FROM run_admissions WHERE execution_id = ?`)
      .bind(A)
      .first<{ hourly_rate_micro_usd: number }>();
    expect(row?.hourly_rate_micro_usd).toBe(S4);
  });

  it("admits while the admitted burn plus its own fits, across pools", async () => {
    await seedAdmitted("peer-lean", "lean", S4);
    await seedAdmitted("peer-release", "release", S4);
    expect((await claim(A, "browser", S4)).admitted).toBe(true);
  });

  it("holds a claimant the ceiling cannot fit, with a free slot in its pool", async () => {
    // Three standard-4 rows admitted in other pools: 1.203 $/h + 0.401 > 1.50.
    await seedAdmitted("peer-1", "release", S4);
    await seedAdmitted("peer-2", "release", S4);
    await seedAdmitted("peer-3", "browser", S4);
    const observed = await claim(A, "lean", S4);
    expect(observed).toMatchObject({ admitted: false, poolBusy: 0, ceilingHeld: true });
    // A cheaper claimant still fits the headroom.
    expect((await claim(B, "browser", S2)).admitted).toBe(true);
  });

  it("admits a claimant whose own rate exceeds the ceiling only into an empty admitted set", async () => {
    expect((await claim(A, "lean", 2_000_000)).admitted).toBe(true);
    const observed = await claim(B, "lean", 2_000_000);
    expect(observed).toMatchObject({ admitted: false, ceilingHeld: true });
  });

  it("stops counting a stale admitted row's burn", async () => {
    await bindings.db
      .prepare(
        `INSERT INTO run_admissions
           (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at, hourly_rate_micro_usd)
         VALUES ('corpse', 'lean', 'admitted', ?, ?, ?, ?)`,
      )
      .bind(T0 - 1_000, T0 - 1_000, T0 - ADMISSION_TTL_MS - 1, CEILING)
      .run();
    expect((await claim(A, "lean", S4)).admitted).toBe(true);
  });

  it("admits on the cap alone with no ceiling", async () => {
    await seedAdmitted("peer-1", "release", 10_000_000);
    expect((await claim(A, "lean", S4, null)).admitted).toBe(true);
  });

  it("reports the cap, not the ceiling, when the pool is full", async () => {
    for (let i = 0; i < ADMISSION_CAP_DEFAULT; i++) {
      await seedAdmitted(`peer-${String(i).padStart(2, "0")}`, "lean", S4);
    }
    const observed = await claim(A, "lean", S4);
    expect(observed.admitted).toBe(false);
    expect(observed.ceilingHeld).toBeUndefined();
  });

  it("stamps executions.admitted_at from the claim, once", async () => {
    await bindings.db
      .prepare(
        `INSERT INTO executions (id, run, repo, ref, sha, status, started_at, input_json)
         VALUES (?, 'check', 'owner/name', 'refs/heads/main', 'abc', 'running', ?, '{}')`,
      )
      .bind(A, T0 - 5_000)
      .run();
    let clock = T0;
    const store = makeRunAdmissionD1(bindings.db, () => clock);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(A, "lean"));
    await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    // A replayed attempt later keeps the first stamp.
    clock = T0 + 60_000;
    await Effect.runPromise(store.attempt(A, "lean", enqueuedAt));
    const row = await bindings.db
      .prepare(`SELECT admitted_at FROM executions WHERE id = ?`)
      .bind(A)
      .first<{ admitted_at: number }>();
    expect(row?.admitted_at).toBe(T0);
  });
});

// The interactive admission class (specs/adr/0009-fast-trustworthy-verdicts.md
// § Interactive admission class): a claim admits the oldest live interactive
// waiter before any batch waiter; FIFO and the queue position apply within a
// class, interactive ahead of batch; the burn ceiling never reorders the line.
describe("makeRunAdmissionD1 — the interactive admission class", () => {
  let bindings: TestBindings;
  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  const BATCH_OLD = "01ARZ3NDEKTSV4RRFFQ69G5F01";
  const BATCH_NEW = "01ARZ3NDEKTSV4RRFFQ69G5F02";
  const INTER_1 = "01ARZ3NDEKTSV4RRFFQ69G5F03";
  const INTER_2 = "01ARZ3NDEKTSV4RRFFQ69G5F04";

  const storeFor = (
    admissionClass: AdmissionClass,
    clock: () => number,
    cap = 1,
    burn = { hourlyRateMicroUsd: 0, burnMaxMicroUsdPerHour: null as number | null },
  ) => makeRunAdmissionD1(bindings.db, clock, cap, burn, admissionClass);

  /** Enqueue `id` at `at` in `admissionClass` and return its store + FIFO key. */
  const enqueueAt = async (
    id: string,
    admissionClass: AdmissionClass,
    at: number,
    cap = 1,
    burn?: { hourlyRateMicroUsd: number; burnMaxMicroUsdPerHour: number | null },
  ) => {
    const store = storeFor(admissionClass, () => at, cap, burn);
    const { enqueuedAt } = await Effect.runPromise(store.enqueue(id, "lean"));
    return { store, enqueuedAt };
  };

  const attemptAt = (
    id: string,
    admissionClass: AdmissionClass,
    enqueuedAt: number,
    at: number,
    cap = 1,
    burn?: { hourlyRateMicroUsd: number; burnMaxMicroUsdPerHour: number | null },
  ) => Effect.runPromise(storeFor(admissionClass, () => at, cap, burn).attempt(id, "lean", enqueuedAt));

  const holdSlot = () =>
    bindings.db
      .prepare(
        `INSERT INTO run_admissions (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at)
         VALUES ('holder', 'lean', 'admitted', ?, ?, ?)`,
      )
      .bind(T0 - 5_000, T0 - 5_000, T0)
      .run();
  const freeSlot = () => bindings.db.prepare(`DELETE FROM run_admissions WHERE execution_id = 'holder'`).run();

  it("records the class on the row; a store without one enqueues batch", async () => {
    await enqueueAt(INTER_1, "interactive", T0);
    await Effect.runPromise(makeRunAdmissionD1(bindings.db, () => T0).enqueue(BATCH_OLD, "lean"));
    const classes = await bindings.db
      .prepare(`SELECT execution_id, admission_class FROM run_admissions ORDER BY execution_id`)
      .all<{ execution_id: string; admission_class: string }>();
    expect(classes.results).toEqual([
      { execution_id: BATCH_OLD, admission_class: "batch" },
      { execution_id: INTER_1, admission_class: "interactive" },
    ]);
  });

  it("admits a later interactive waiter before an earlier batch waiter", async () => {
    await holdSlot();
    const batch = await enqueueAt(BATCH_OLD, "batch", T0 - 60_000);
    const inter = await enqueueAt(INTER_1, "interactive", T0);
    // Full pool: the interactive waiter is first in line, the batch one second.
    expect(await attemptAt(INTER_1, "interactive", inter.enqueuedAt, T0 + 1)).toMatchObject({
      admitted: false,
      position: 0,
    });
    expect(await attemptAt(BATCH_OLD, "batch", batch.enqueuedAt, T0 + 2)).toMatchObject({
      admitted: false,
      position: 1,
    });
    await freeSlot();
    // The batch waiter cannot barge past the live interactive one.
    expect((await attemptAt(BATCH_OLD, "batch", batch.enqueuedAt, T0 + 3)).admitted).toBe(false);
    expect((await attemptAt(INTER_1, "interactive", inter.enqueuedAt, T0 + 4)).admitted).toBe(true);
  });

  it("keeps FIFO within the interactive class", async () => {
    await holdSlot();
    const first = await enqueueAt(INTER_1, "interactive", T0 - 10_000);
    const second = await enqueueAt(INTER_2, "interactive", T0);
    expect((await attemptAt(INTER_2, "interactive", second.enqueuedAt, T0 + 1)).position).toBe(1);
    await freeSlot();
    expect((await attemptAt(INTER_2, "interactive", second.enqueuedAt, T0 + 2)).admitted).toBe(false);
    expect((await attemptAt(INTER_1, "interactive", first.enqueuedAt, T0 + 3)).admitted).toBe(true);
  });

  it("keeps FIFO within the batch class, behind every interactive waiter", async () => {
    await holdSlot();
    await enqueueAt(INTER_1, "interactive", T0);
    await enqueueAt(BATCH_OLD, "batch", T0 - 20_000);
    const newer = await enqueueAt(BATCH_NEW, "batch", T0 - 10_000);
    expect((await attemptAt(BATCH_NEW, "batch", newer.enqueuedAt, T0 + 1)).position).toBe(2);
  });

  it("ranks a pre-0011 row with no class as batch", async () => {
    await holdSlot();
    await bindings.db
      .prepare(
        `INSERT INTO run_admissions (execution_id, pool, state, enqueued_at, heartbeat_at)
         VALUES (?, 'lean', 'queued', ?, ?)`,
      )
      .bind(BATCH_OLD, T0 - 60_000, T0)
      .run();
    const inter = await enqueueAt(INTER_1, "interactive", T0);
    expect((await attemptAt(INTER_1, "interactive", inter.enqueuedAt, T0 + 1)).position).toBe(0);
    const batch = await enqueueAt(BATCH_NEW, "batch", T0);
    expect((await attemptAt(BATCH_NEW, "batch", batch.enqueuedAt, T0 + 2)).position).toBe(2);
  });

  it("stops a dead interactive waiter from blocking the batch line", async () => {
    await enqueueAt(INTER_1, "interactive", T0 - ADMISSION_WAITER_TTL_MS - 10);
    const batch = await enqueueAt(BATCH_OLD, "batch", T0);
    expect((await attemptAt(BATCH_OLD, "batch", batch.enqueuedAt, T0 + 1)).admitted).toBe(true);
  });

  it("holds a batch claimant the ceiling would fit behind an interactive waiter it holds", async () => {
    // One admitted row at 1.0 $/h; ceiling 1.5 $/h. The interactive waiter at
    // 0.8 $/h does not fit; the batch waiter at 0.2 $/h would, but stays in line.
    const ceiling = 1_500_000;
    await bindings.db
      .prepare(
        `INSERT INTO run_admissions
           (execution_id, pool, state, enqueued_at, admitted_at, heartbeat_at, hourly_rate_micro_usd)
         VALUES ('holder', 'release', 'admitted', ?, ?, ?, 1000000)`,
      )
      .bind(T0 - 5_000, T0 - 5_000, T0)
      .run();
    const interBurn = { hourlyRateMicroUsd: 800_000, burnMaxMicroUsdPerHour: ceiling };
    const batchBurn = { hourlyRateMicroUsd: 200_000, burnMaxMicroUsdPerHour: ceiling };
    const inter = await enqueueAt(INTER_1, "interactive", T0, 16, interBurn);
    const batch = await enqueueAt(BATCH_OLD, "batch", T0 - 60_000, 16, batchBurn);
    expect(await attemptAt(INTER_1, "interactive", inter.enqueuedAt, T0 + 1, 16, interBurn)).toMatchObject({
      admitted: false,
      ceilingHeld: true,
    });
    expect((await attemptAt(BATCH_OLD, "batch", batch.enqueuedAt, T0 + 2, 16, batchBurn)).admitted).toBe(false);
    // Burn frees: the interactive waiter admits first, then the batch one fits.
    await freeSlot();
    expect((await attemptAt(INTER_1, "interactive", inter.enqueuedAt, T0 + 3, 16, interBurn)).admitted).toBe(true);
    expect((await attemptAt(BATCH_OLD, "batch", batch.enqueuedAt, T0 + 4, 16, batchBurn)).admitted).toBe(true);
  });
});
