// Unit tests for the shared REST plumbing — specifically the rate-limit signal
// extraction that `assertOk` attaches to a `GithubApiError`, which the Effect
// Layer one level up uses to classify a 403 as `rate-limited` and to back off.

import { describe, expect, it } from "vitest";
import { GithubApiError } from "./errors";
import { assertOk, rateLimitFromHeaders, retryAfterMsFromHeaders } from "./http";

describe("retryAfterMsFromHeaders", () => {
  it("reads Retry-After (whole seconds) as milliseconds", () => {
    expect(retryAfterMsFromHeaders(new Headers({ "retry-after": "30" }))).toBe(30_000);
  });

  it("prefers Retry-After over the reset window when both are present", () => {
    const headers = new Headers({
      "retry-after": "5",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "9999999999",
    });
    expect(retryAfterMsFromHeaders(headers)).toBe(5_000);
  });

  it("uses x-ratelimit-reset only when the quota is exhausted", () => {
    const now = 1_000_000_000_000; // fixed clock
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(now / 1000 + 42), // 42s in the future
    });
    expect(retryAfterMsFromHeaders(headers, now)).toBe(42_000);
  });

  it("ignores the reset window when quota remains", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "17",
      "x-ratelimit-reset": "9999999999",
    });
    expect(retryAfterMsFromHeaders(headers)).toBeUndefined();
  });

  it("returns undefined when no rate-limit signal is present", () => {
    expect(retryAfterMsFromHeaders(new Headers())).toBeUndefined();
  });

  it("ignores a non-numeric Retry-After (HTTP-date form is not emitted here)", () => {
    expect(
      retryAfterMsFromHeaders(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    ).toBeUndefined();
  });
});

describe("assertOk", () => {
  it("attaches the derived retry hint to the thrown GithubApiError", async () => {
    const res = new Response("secondary rate limit", {
      status: 403,
      headers: { "retry-after": "60" },
    });
    const err = await assertOk(res, "post failed").then(
      () => undefined,
      (e) => e as GithubApiError,
    );
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err!.status).toBe(403);
    expect(err!.retryAfterMs).toBe(60_000);
  });

  it("leaves retryAfterMs undefined when no signal is present", async () => {
    const res = new Response("not found", { status: 404 });
    const err = await assertOk(res, "get failed").then(
      () => undefined,
      (e) => e as GithubApiError,
    );
    expect(err!.status).toBe(404);
    expect(err!.retryAfterMs).toBeUndefined();
  });

  it("does not throw on a 2xx response", async () => {
    await expect(
      assertOk(new Response("ok", { status: 200 }), "should not throw"),
    ).resolves.toBeUndefined();
  });
});

describe("rateLimitFromHeaders", () => {
  it("reads remaining, limit and the reset as ms epoch", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "412",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": "1700000000",
    });
    expect(rateLimitFromHeaders(headers)).toEqual({
      remaining: 412,
      limit: 5000,
      resetAtMs: 1_700_000_000_000,
    });
  });

  it("returns undefined when any of the three headers is missing", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "412", "x-ratelimit-limit": "5000" });
    expect(rateLimitFromHeaders(headers)).toBeUndefined();
  });

  it("returns undefined for a non-numeric value", () => {
    const headers = new Headers({
      "x-ratelimit-remaining": "lots",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": "1700000000",
    });
    expect(rateLimitFromHeaders(headers)).toBeUndefined();
  });
});
