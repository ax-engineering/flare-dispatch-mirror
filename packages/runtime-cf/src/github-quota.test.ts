// Unit tests for the per-installation quota cache the checks client reads
// before each GitHub call.

import { beforeEach, describe, expect, it } from "vitest";
import { __clearQuotas, blockQuota, observeQuota, quotaState } from "./github-quota";

const NOW = 1_700_000_000_000;
const RESET_S = String(NOW / 1000 + 600);

const quotaHeaders = (remaining: number, limit = 5000, reset = RESET_S): Headers =>
  new Headers({
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-reset": reset,
  });

beforeEach(() => __clearQuotas());

describe("quotaState", () => {
  it("is open for an installation no response has reported on", () => {
    expect(quotaState(1, NOW)).toBe("open");
  });

  it("is open above the reserve and reserve at or under 10% of the window", () => {
    observeQuota(1, quotaHeaders(501));
    expect(quotaState(1, NOW)).toBe("open");
    observeQuota(1, quotaHeaders(500));
    expect(quotaState(1, NOW)).toBe("reserve");
  });

  it("is exhausted at zero remaining until the window resets", () => {
    observeQuota(1, quotaHeaders(0));
    expect(quotaState(1, NOW)).toBe("exhausted");
    expect(quotaState(1, NOW + 600_000)).toBe("open");
  });

  it("is exhausted inside a Retry-After wait whatever the window reports", () => {
    observeQuota(1, quotaHeaders(4000));
    blockQuota(1, NOW + 30_000);
    expect(quotaState(1, NOW)).toBe("exhausted");
    // A later response inside the wait keeps the wait.
    observeQuota(1, quotaHeaders(3999));
    expect(quotaState(1, NOW + 29_999)).toBe("exhausted");
    expect(quotaState(1, NOW + 30_000)).toBe("open");
  });

  it("keeps installations apart", () => {
    observeQuota(1, quotaHeaders(0));
    expect(quotaState(2, NOW)).toBe("open");
  });

  it("ignores a response without quota headers", () => {
    observeQuota(1, quotaHeaders(0));
    observeQuota(1, new Headers());
    expect(quotaState(1, NOW)).toBe("exhausted");
  });
});
