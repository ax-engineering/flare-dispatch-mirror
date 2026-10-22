// @fractalboxdev/flare-dispatch-github-app — shared REST plumbing.
//
// The bits every github-app fetch module repeated: the API host + version, the
// `owner/repo` splitter, the installation-token header set, the `fetchImpl ??
// fetch` / `apiBase ?? base` resolution, and the non-2xx → `GithubApiError`
// guard. One home so the `X-GitHub-Api-Version` string (a deprecation-sensitive
// constant) lives in exactly one place.
//
// Provider-neutral plain `async`, no Effect — same property the rest of the
// package keeps so the Effect Layer in @fractalboxdev/flare-dispatch-runtime-cf can wrap it.

import { GithubApiError } from "./errors";

/** GitHub's API host — overridable per call for tests / GitHub Enterprise. */
export const API_BASE_DEFAULT = "https://api.github.com";

/** The GitHub REST API version every call pins. Bump in one place. */
const GITHUB_API_VERSION = "2022-11-28";

/** Split an `"owner/repo"` slug; throws on a malformed slug. */
export const splitRepo = (repo: string): { owner: string; name: string } => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new GithubApiError(`malformed repo slug "${repo}"`, 0, "");
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

/**
 * Request headers for a Bearer-authenticated call (installation token OR App
 * JWT — both are `Authorization: Bearer`). Pass `{ json: true }` for a request
 * that carries a JSON body (POST/PATCH).
 */
export const ghHeaders = (
  token: string,
  opts: { json?: boolean } = {},
): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  ...(opts.json ? { "Content-Type": "application/json" } : {}),
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
  "User-Agent": "flare-dispatch",
});

/** Resolve the per-call `apiBase` + `fetch` defaults in one place. */
export const resolveClient = (opts: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): { apiBase: string; doFetch: typeof fetch } => ({
  apiBase: opts.apiBase ?? API_BASE_DEFAULT,
  doFetch: opts.fetchImpl ?? fetch,
});

/**
 * Derive a retry delay (ms) from GitHub's rate-limit response headers, or
 * `undefined` when none is present. `Retry-After` (whole seconds — GitHub's
 * signal for secondary rate limits and transient 5xx) takes precedence; failing
 * that, an exhausted primary quota (`x-ratelimit-remaining: 0`) yields the wait
 * until `x-ratelimit-reset` (epoch seconds). `nowMs` is injectable for tests.
 * The HTTP-date form of `Retry-After` is not emitted by GitHub here and is
 * ignored (a non-numeric value simply yields no delay).
 */
export const retryAfterMsFromHeaders = (
  headers: Headers,
  nowMs: number = Date.now(),
): number | undefined => {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const resetS = Number(reset);
    if (Number.isFinite(resetS)) return Math.max(0, Math.ceil(resetS * 1000 - nowMs));
  }
  return undefined;
};

/** An installation's primary quota as one response reported it. */
export type RateLimitSnapshot = {
  /** `x-ratelimit-remaining` — calls left in the current window. */
  readonly remaining: number;
  /** `x-ratelimit-limit` — the window's size. */
  readonly limit: number;
  /** `x-ratelimit-reset` as ms epoch — when the window refills. */
  readonly resetAtMs: number;
};

/**
 * Read the primary-quota headers GitHub sends on every REST response, or
 * `undefined` when any of the three is missing or non-numeric.
 */
export const rateLimitFromHeaders = (headers: Headers): RateLimitSnapshot | undefined => {
  const remaining = Number(headers.get("x-ratelimit-remaining") ?? Number.NaN);
  const limit = Number(headers.get("x-ratelimit-limit") ?? Number.NaN);
  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(reset)) {
    return undefined;
  }
  return { remaining, limit, resetAtMs: reset * 1000 };
};

/**
 * Throw a `GithubApiError` (status + body text + any rate-limit retry hint
 * attached) when a response is non-2xx. Each caller keeps its own success-body
 * decode after this guard, so decode semantics (strict vs tolerant) stay
 * per-call.
 */
export const assertOk = async (res: Response, message: string): Promise<void> => {
  if (!res.ok) {
    throw new GithubApiError(
      message,
      res.status,
      await res.text().catch(() => ""),
      retryAfterMsFromHeaders(res.headers),
    );
  }
};
