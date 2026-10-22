// Unit coverage for the pure run-admission decision logic. No I/O, no clock
// read — every transition is exercised by feeding `decideAdmission` a
// hand-built observation + a fixed `now`, mirroring `container-lease.test.ts`.
// The strongly-consistent storage + durable-step poll loop that drive these
// decisions live in `@fractalboxdev/flare-dispatch-runtime-cf` / the dispatcher and cannot
// run under plain Node, so the logic is isolated here for full coverage.

import { describe, expect, it } from "vitest";
import {
  admissionAcquireAttempts,
  admissionJitterMs,
  admissionPollSleepMs,
  ADMISSION_JITTER_MAX_MS,
  ADMISSION_POLL_MAX_MS,
  ADMISSION_POLL_MIN_MS,
  type AdmissionObservation,
  decideAdmission,
} from "./run-admission";

const MAX_QUEUE_AGE = 1_200_000; // 20 min dispatch-age ceiling
const ENQUEUED_AT = 10_000;

const observed = (over: Partial<AdmissionObservation> = {}): AdmissionObservation => ({
  admitted: false,
  position: 0,
  poolBusy: 16,
  ...over,
});

describe("decideAdmission", () => {
  it("admits when the atomic claim landed (a slot under the cap was free)", () => {
    expect(
      decideAdmission(
        observed({ admitted: true, poolBusy: 3 }),
        ENQUEUED_AT,
        ENQUEUED_AT + 1,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "admit" });
  });

  it("admit wins even at the deadline — a slot taken at the boundary is kept", () => {
    expect(
      decideAdmission(
        observed({ admitted: true }),
        ENQUEUED_AT,
        ENQUEUED_AT + MAX_QUEUE_AGE + 1,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "admit" });
  });

  it("waits when the pool is at the cap, carrying position + busy count", () => {
    expect(
      decideAdmission(
        observed({ position: 3, poolBusy: 16 }),
        ENQUEUED_AT,
        ENQUEUED_AT + 60_000,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({ _kind: "wait", position: 3, poolBusy: 16 });
  });

  it("times out once queued for exactly the dispatch-age ceiling", () => {
    expect(
      decideAdmission(
        observed({ position: 2, poolBusy: 16 }),
        ENQUEUED_AT,
        ENQUEUED_AT + MAX_QUEUE_AGE,
        MAX_QUEUE_AGE,
      ),
    ).toEqual({
      _kind: "timeout",
      queuedForMs: MAX_QUEUE_AGE,
      position: 2,
      poolBusy: 16,
      ceilingHeld: false,
    });
  });

  it("carries the burn ceiling hold into the timeout", () => {
    const decision = decideAdmission(
      { admitted: false, position: 0, poolBusy: 3, ceilingHeld: true },
      ENQUEUED_AT,
      ENQUEUED_AT + MAX_QUEUE_AGE,
      MAX_QUEUE_AGE,
    );
    expect(decision).toMatchObject({ _kind: "timeout", ceilingHeld: true });
  });

  it("still waits one tick before the ceiling", () => {
    const decision = decideAdmission(
      observed(),
      ENQUEUED_AT,
      ENQUEUED_AT + MAX_QUEUE_AGE - 1,
      MAX_QUEUE_AGE,
    );
    expect(decision._kind).toBe("wait");
  });

  it("clamps queuedForMs to zero when the clock appears to move backwards", () => {
    // A backwards clock must never produce a negative age (nor a spurious
    // timeout with a tiny ceiling) — clamp to 0 and keep waiting.
    const decision = decideAdmission(observed(), ENQUEUED_AT, ENQUEUED_AT - 5_000, MAX_QUEUE_AGE);
    expect(decision._kind).toBe("wait");
  });
});

describe("admissionAcquireAttempts", () => {
  it("derives one attempt per poll interval up to the ceiling (defaults: 60)", () => {
    expect(admissionAcquireAttempts(1_200_000, 20_000)).toBe(60);
  });

  it("rounds a partial final interval up to a whole attempt", () => {
    expect(admissionAcquireAttempts(1_210_000, 20_000)).toBe(61);
  });

  it("always makes at least one attempt", () => {
    expect(admissionAcquireAttempts(0, 20_000)).toBe(1);
    expect(admissionAcquireAttempts(1_000, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("admissionPollSleepMs — min(60 s, 20 s × ceil(position / cap))", () => {
  it("keeps the head of the queue on the 20-second poll", () => {
    expect(admissionPollSleepMs(0, 16)).toBe(20_000);
    expect(admissionPollSleepMs(16, 16)).toBe(20_000);
  });

  it("scales with the slots between the waiter and the head", () => {
    expect(admissionPollSleepMs(17, 16)).toBe(40_000);
    expect(admissionPollSleepMs(32, 16)).toBe(40_000);
    expect(admissionPollSleepMs(33, 16)).toBe(60_000);
    expect(admissionPollSleepMs(9, 8)).toBe(40_000);
  });

  it("never sleeps longer than 60 seconds", () => {
    expect(admissionPollSleepMs(500, 16)).toBe(ADMISSION_POLL_MAX_MS);
    expect(admissionPollSleepMs(500, 1)).toBe(ADMISSION_POLL_MAX_MS);
  });

  it("shortens a long sleep to the time left, never below the 20-second poll", () => {
    expect(admissionPollSleepMs(500, 16, 45_000)).toBe(45_000);
    expect(admissionPollSleepMs(500, 16, 5_000)).toBe(ADMISSION_POLL_MIN_MS);
    expect(admissionPollSleepMs(0, 16, -1_000)).toBe(ADMISSION_POLL_MIN_MS);
  });

  it("treats a zero cap as one slot", () => {
    expect(admissionPollSleepMs(2, 0)).toBe(40_000);
  });

  it("covers the queue age within the attempts derived from the shortest sleep", () => {
    // Every sleep is ≥ the shortest, so attempts × shortest ≥ the queue age.
    const attempts = admissionAcquireAttempts(MAX_QUEUE_AGE, ADMISSION_POLL_MIN_MS);
    expect(attempts * ADMISSION_POLL_MIN_MS).toBeGreaterThanOrEqual(MAX_QUEUE_AGE);
    // A waiter far back reaches the age limit in a third of the attempts.
    expect(Math.ceil(MAX_QUEUE_AGE / admissionPollSleepMs(500, 16))).toBe(attempts / 3);
  });
});

describe("admissionJitterMs", () => {
  it("is the same for the same execution id", () => {
    expect(admissionJitterMs("01ARZ3NDEKTSV4RRFFQ69G5FAA")).toBe(admissionJitterMs("01ARZ3NDEKTSV4RRFFQ69G5FAA"));
  });

  it("stays within 0..2 s and spreads a burst", () => {
    const draws = Array.from({ length: 200 }, (_, i) => admissionJitterMs(`01ARZ3NDEKTSV4RRFFQ69G${String(i).padStart(4, "0")}`));
    for (const ms of draws) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(ADMISSION_JITTER_MAX_MS);
      expect(Number.isInteger(ms)).toBe(true);
    }
    expect(new Set(draws).size).toBeGreaterThan(150);
    expect(Math.min(...draws)).toBeLessThan(500);
    expect(Math.max(...draws)).toBeGreaterThan(1_500);
  });
});
