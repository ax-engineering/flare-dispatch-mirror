// @fractalboxdev/flare-dispatch-runtime-cf — per-installation GitHub quota.
//
// GitHub reports an installation's primary quota on every REST response
// (`x-ratelimit-remaining` / `-limit` / `-reset`), and a rate-limited response
// names its wait (`Retry-After`, or the reset of an exhausted window). The
// checks client records both here and reads them back before each call:
//
//   * `open`      — quota above the reserve: every call proceeds.
//   * `reserve`   — at or under 10% of the window: only create and conclude
//                   proceed; queue-position updates stop.
//   * `exhausted` — nothing left, or inside a `Retry-After` wait: no call
//                   proceeds until the window resets or the wait lapses.
//
// The quota itself lives on GitHub, so the state here is a cache of GitHub's
// last answer, not a counter. It is per isolate: two isolates each hold the
// value their own last response carried, and each refreshes on its next call.
// Between calls an isolate may spend into the reserve that another isolate
// already saw, which bounds the overshoot at one call per isolate.

import { rateLimitFromHeaders } from "@fractalboxdev/flare-dispatch-github-app";

/** The share of an installation's hourly quota kept for create and conclude calls. */
export const QUOTA_RESERVE_FRACTION = 0.1;

/** What the cache knows about one installation's quota. */
type QuotaEntry = {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAtMs: number;
  /** A `Retry-After` wait in force until this ms epoch, when one was signalled. */
  readonly blockedUntilMs?: number;
};

/** Which calls an installation's quota currently admits. */
export type QuotaState = "open" | "reserve" | "exhausted";

const quotas = new Map<number, QuotaEntry>();

/** Test hook: forget every installation's quota. */
export const __clearQuotas = (): void => quotas.clear();

/** Record the quota a response's headers report for `installationId`. */
export const observeQuota = (installationId: number, headers: Headers): void => {
  const snapshot = rateLimitFromHeaders(headers);
  if (snapshot === undefined) return;
  const prior = quotas.get(installationId);
  quotas.set(installationId, {
    ...snapshot,
    ...(prior?.blockedUntilMs !== undefined ? { blockedUntilMs: prior.blockedUntilMs } : {}),
  });
};

/** Record a rate-limit wait GitHub signalled for `installationId`. */
export const blockQuota = (installationId: number, untilMs: number): void => {
  const prior = quotas.get(installationId);
  quotas.set(installationId, {
    remaining: prior?.remaining ?? 0,
    limit: prior?.limit ?? 0,
    resetAtMs: prior?.resetAtMs ?? untilMs,
    blockedUntilMs: Math.max(untilMs, prior?.blockedUntilMs ?? 0),
  });
};

/** The calls `installationId`'s quota admits at `nowMs`. */
export const quotaState = (installationId: number, nowMs: number): QuotaState => {
  const entry = quotas.get(installationId);
  if (entry === undefined) return "open";
  if (entry.blockedUntilMs !== undefined && nowMs < entry.blockedUntilMs) return "exhausted";
  if (nowMs >= entry.resetAtMs || entry.limit <= 0) return "open";
  if (entry.remaining <= 0) return "exhausted";
  return entry.remaining <= Math.ceil(entry.limit * QUOTA_RESERVE_FRACTION) ? "reserve" : "open";
};
