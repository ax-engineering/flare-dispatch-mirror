// Tests for the admission-queue check-run line (issue #109) — pure string
// formatting, exercised with fixed inputs like failure-summary.test.ts.

import { describe, expect, it } from "vitest";
import {
  nextPositionReport,
  POSITION_UPDATE_EVERY_MS,
  type PositionReport,
  positionBucket,
  queuedSummary,
  serialQueuedSummary,
} from "./admission-summary";

describe("positionBucket", () => {
  it("places a waiter with nobody ahead in bucket 1", () => {
    expect(positionBucket(0)).toBe("1");
  });

  it("buckets places 2-5, 6-20 and over 20 at their boundaries", () => {
    expect([1, 4, 5, 19, 20, 100].map(positionBucket)).toEqual([
      "2-5",
      "2-5",
      "6-20",
      "6-20",
      "over 20",
      "over 20",
    ]);
  });
});

describe("nextPositionReport", () => {
  const T0 = 1_000_000;

  it("writes the first position it sees", () => {
    expect(nextPositionReport(undefined, 7, T0)).toEqual({ bucket: "6-20", at: T0 });
  });

  it("writes nothing while the bucket holds, however long", () => {
    const last = { bucket: "6-20" as const, at: T0 };
    expect(nextPositionReport(last, 6, T0 + 10 * POSITION_UPDATE_EVERY_MS)).toBeUndefined();
  });

  it("holds a crossed bucket until a minute has passed since the last write", () => {
    const last = { bucket: "6-20" as const, at: T0 };
    expect(nextPositionReport(last, 3, T0 + POSITION_UPDATE_EVERY_MS - 1)).toBeUndefined();
    expect(nextPositionReport(last, 3, T0 + POSITION_UPDATE_EVERY_MS)).toEqual({
      bucket: "2-5",
      at: T0 + POSITION_UPDATE_EVERY_MS,
    });
  });

  it("bounds a draining queue of 30 polled every 20s to one write a minute at most", () => {
    let last: PositionReport | undefined;
    let writes = 0;
    for (let i = 0; i <= 30; i++) {
      const next = nextPositionReport(last, 30 - i, T0 + i * 20_000);
      if (next !== undefined) {
        writes += 1;
        last = next;
      }
    }
    // over 20 → 6-20 → 2-5 → 1: one write per bucket.
    expect(writes).toBe(4);
  });
});

describe("queuedSummary", () => {
  // 2026-06-05T12:34:00.000Z
  const TIMES_OUT_AT = Date.UTC(2026, 5, 5, 12, 34, 0);

  it("renders the bucket, pool usage, and the UTC give-up time", () => {
    expect(queuedSummary("2-5", 16, 16, TIMES_OUT_AT)).toBe(
      "Queued — waiting for a sandbox slot, 2–5 in line (16/16 in use); times out 12:34 UTC",
    );
  });

  it("names bucket 1 as next in line and the top bucket as over 20th", () => {
    expect(queuedSummary("1", 16, 16, TIMES_OUT_AT)).toContain("next in line (");
    expect(queuedSummary("over 20", 16, 16, TIMES_OUT_AT)).toContain("over 20th in line (");
  });

  it("zero-pads single-digit hours and minutes", () => {
    // 2026-06-05T03:05:00.000Z
    expect(queuedSummary("1", 16, 16, Date.UTC(2026, 5, 5, 3, 5, 0))).toContain(
      "times out 03:05 UTC",
    );
  });
});

describe("serialQueuedSummary", () => {
  it("names the in-flight revision and warns that a newer dispatch replaces this one", () => {
    expect(serialQueuedSummary("0123456789abcdef0123")).toBe(
      "Queued — waiting for the in-flight run of `0123456789ab` to finish; runs of this group " +
        "never overlap. A newer dispatch replaces this one while it waits.",
    );
  });

  it("omits the revision when the holder is not known", () => {
    expect(serialQueuedSummary(undefined)).toContain("waiting for the in-flight run to finish");
  });
});
