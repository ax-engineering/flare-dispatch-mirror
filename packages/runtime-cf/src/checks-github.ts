// @fractalboxdev/flare-dispatch-runtime-cf — ChecksGithubLive: the live `checks` capability.
//
// Backs the `Checks` Context.Tag with the GitHub App check-runs API, via
// `@fractalboxdev/flare-dispatch-github-app`: an RS256 App JWT is exchanged for a short-lived
// installation token (cached in Worker memory), and that token authenticates
// `POST` / `PATCH /repos/{owner}/{repo}/check-runs`. This is the GitHub half of
// the `finalize` boundary — the D1 half is `D1ExecutionsLive`.
//
// --- Out-of-band context (the `makeD1ExecutionsLive` pattern) ----------------
//
// The core `ChecksService` interface is run-agnostic — `create`/`update` carry
// only `repo` / `sha` / `name`, not the App credentials. The App id, PEM, and
// installation id are runtime-specific and per-execution, so — exactly like
// `makeD1ExecutionsLive`'s `ExecutionContext` — they are injected into the
// Layer constructor (`ChecksGithubConfig`) and closed over. `RunWorkflow`
// derives them from `env` + the dispatch payload.
//
// --- Graceful degradation ----------------------------------------------------
//
// In local dev (no `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` secret) or when a
// dispatch carries no `installation_id`, there are no credentials to mint a
// token with. A check-run is *reporting*, not *correctness* — a missing PR
// check must never fail an otherwise-green execution. So when credentials are
// absent, `makeChecksGithubLive` returns a **no-op** service: `create` resolves
// to a sentinel id and `update` is a no-op, both logging at info level. The
// execution still runs, records its D1 rows, and uploads its log — only the
// GitHub check-run is skipped. PR5 supplies `installation_id`; with real
// secrets configured the live path is taken.
//
// A failure *with* credentials present is classified, not blanket-`orDie`d — a
// blanket die contradicted the "never fail an otherwise-green execution" rule
// above, since one transient 502 while posting a check-run would kill the run.
// So: a transient (5xx / network) or rate-limited (429, or a 403 carrying a
// `Retry-After`) failure is RETRIED with bounded backoff, and if it still fails,
// DEGRADES to the same logged no-op as the no-credentials path — reporting must
// not fail correctness. A genuine client error (bad App id / 401 / 404 — a
// misconfiguration) is not retryable and still `orDie`s loudly.
//
// --- Rate limits and the verdict reserve -------------------------------------
//
// A retry waits at least as long as GitHub asked: the `Retry-After` header, or
// the reset of an exhausted window. A wait longer than `RETRY_AFTER_CAP_MS`
// is not slept through inside a Workflow step; the call degrades instead and
// the installation is marked exhausted until the wait lapses.
//
// Every response's quota headers feed github-quota.ts. Once an installation is
// down to its reserve (10% of the window), `progress` stops and only `create`,
// `update` and `conclude` proceed, so a burst of queue-position updates cannot
// spend the calls that open and conclude check-runs.
//
// `conclude` is the verdict write. It completes the check-run, or creates it
// already completed when the opener degraded to the sentinel id, and returns
// whether GitHub took it; it never fails, so the caller records the outcome
// as `executions.delivered_at` and the reconcile sweep re-sends the rest. A
// 404 or 422 comes back as `refused`: GitHub rejects that write for good, and
// the sweep stops re-sending it.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/05-byoc.md
// § Secrets / § Security posture, specs/pm/plan.md § PR6 / § 6.

import {
  createCheckRun,
  getCheckRunStatus,
  getInstallationToken,
  GithubApiError as GithubAppApiError,
  progressCheckRun,
  updateCheckRun,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";
import {
  type CheckDelivery,
  Checks,
  type CheckRunState,
  type ChecksService,
} from "@fractalboxdev/flare-dispatch-core";
import { blockQuota, observeQuota, quotaState, type QuotaState } from "./github-quota";

/**
 * The GitHub App credentials + installation context the live `Checks` Layer
 * needs but the run-agnostic `ChecksService` interface does not carry.
 * Supplied by `RunWorkflow` from `env` + the dispatch payload.
 */
export type ChecksGithubConfig = {
  /** `GITHUB_APP_ID` — the numeric App id. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — the App's PKCS#8 PEM private key. */
  readonly privateKeyPem: string;
  /** The installation id from the dispatch payload's `github.installation_id`. */
  readonly installationId: number;
};

/** Sentinel id `create` returns when running degraded (no credentials). */
export const NOOP_CHECK_RUN_ID = "noop";

/** The longest GitHub-signalled wait a retry sleeps through inside one call. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** The wait GitHub signalled on a failed call, when it signalled one. */
const retryAfterOf = (e: unknown): number | undefined =>
  e instanceof GithubAppApiError ? e.retryAfterMs : undefined;

/**
 * A check-run failure worth retrying: a rate limit (429, or a 403 carrying a
 * `Retry-After`) or a transient 5xx. A client error (401/404/malformed) is not
 * retryable and falls through to a loud `orDie`. A raw network throw is not a
 * `GithubApiError`, so it too is treated as a genuine defect (unchanged).
 */
const isRetryable = (e: unknown): boolean =>
  e instanceof GithubAppApiError &&
  (e.status === 429 || e.status >= 500 || (e.status === 403 && e.retryAfterMs !== undefined));

/**
 * A failure GitHub returns for this check-run itself — 404 (repository,
 * installation or commit gone) or 422 (payload rejected). The same write
 * fails again, unlike a rate limit, an outage or an App-wide 401.
 */
const isRefusal = (e: unknown): boolean =>
  e instanceof GithubAppApiError && (e.status === 404 || e.status === 422);

/** A retryable failure whose signalled wait, if any, fits inside one call. */
const isRetryableNow = (e: unknown): boolean =>
  isRetryable(e) && (retryAfterOf(e) ?? 0) <= RETRY_AFTER_CAP_MS;

/**
 * Bounded exponential backoff (4 retries, jittered) gated to the retryable
 * classes, each delay stretched to at least the wait GitHub signalled. Jitter
 * keeps a burst of concurrent runs from resynchronising onto GitHub.
 * `whileInput` reads a data field, not a `._tag`, so it stays within the
 * Effect convention for `Schedule` predicates.
 */
const checksRetry = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(4)),
  Schedule.intersect(Schedule.identity<unknown>()),
  Schedule.whileInput(isRetryableNow),
  Schedule.modifyDelay(([, e], delay) =>
    Duration.max(delay, Duration.millis(retryAfterOf(e) ?? 0)),
  ),
);

/** A failed call, named for a log line. */
const describeFailure = (e: unknown): string =>
  e instanceof GithubAppApiError ? `HTTP ${e.status}` : "transient failure";

/** Message for the degrade-to-no-op path once retries are exhausted. */
const degradeMsg = (op: string, e: unknown): string =>
  `checks.${op} degraded after retries (${describeFailure(e)}) — check-run not posted, execution unaffected`;

/**
 * A `ChecksService` that does nothing but log — the graceful-degradation path
 * when App credentials or the installation id are absent (local dev). The
 * execution proceeds; only the GitHub check-run is skipped.
 */
const makeNoopChecks = (reason: string): ChecksService => ({
  create: ({ name }) =>
    Effect.as(
      Effect.logInfo(`checks.create skipped (${reason}) — check-run "${name}" not posted`),
      NOOP_CHECK_RUN_ID,
    ),
  progress: () =>
    Effect.logInfo(`checks.progress skipped (${reason}) — in-progress output not posted`),
  status: () => Effect.succeed<CheckRunState>("unknown"),
  update: ({ conclusion }) =>
    Effect.logInfo(`checks.update skipped (${reason}) — conclusion "${conclusion}" not posted`),
  conclude: ({ conclusion }) =>
    Effect.as(
      Effect.logInfo(`checks.conclude skipped (${reason}) — conclusion "${conclusion}" not posted`),
      { _tag: "undelivered", reason } as const,
    ),
});

/**
 * Build the `Checks` Layer. When `config` is `undefined` (no App secrets) the
 * Layer is the no-op service above; otherwise it is the live GitHub-App-backed
 * service.
 */
export const makeChecksGithubLive = (
  config: ChecksGithubConfig | undefined,
): Layer.Layer<Checks> =>
  Layer.succeed(
    Checks,
    config === undefined
      ? makeNoopChecks("GitHub App credentials not configured")
      : makeChecksGithubService(config),
  );

/** The live GitHub-App-backed `ChecksService` for one installation. */
export const makeChecksGithubService = (config: ChecksGithubConfig): ChecksService => {
  const installationId = config.installationId;

  // Resolve a fresh-or-cached installation token. The typed `GithubApiError` is
  // preserved (not flattened to a generic Error) so the per-method retry can
  // classify it; the terminal orDie/degrade decision lives at the call site.
  const token = (): Effect.Effect<string, GithubAppApiError | Error> =>
    Effect.tryPromise({
      try: () =>
        getInstallationToken({
          appId: config.appId,
          privateKeyPem: config.privateKeyPem,
          installationId,
        }),
      catch: (cause) =>
        cause instanceof GithubAppApiError
          ? cause
          : new Error("ChecksGithubLive: installation-token exchange failed", {
              cause,
            }),
    });

  /** The calls this installation's quota admits now. */
  const admits: Effect.Effect<QuotaState> = Effect.map(Clock.currentTimeMillis, (now) =>
    quotaState(installationId, now),
  );

  /**
   * One GitHub call with the installation token: its response headers feed
   * the quota cache, a signalled wait marks the installation exhausted, and a
   * retryable failure is retried under `checksRetry`.
   */
  const call = <A>(
    what: string,
    run: (token: string, observe: (headers: Headers) => void) => Promise<A>,
  ): Effect.Effect<A, unknown> =>
    Effect.gen(function* () {
      const accessToken = yield* token();
      return yield* Effect.tryPromise({
        try: () => run(accessToken, (headers) => observeQuota(installationId, headers)),
        catch: (cause) =>
          cause instanceof GithubAppApiError
            ? cause
            : new Error(`ChecksGithubLive: check-run ${what} failed`, { cause }),
      });
    }).pipe(
      Effect.tapError((e) => {
        const waitMs = retryAfterOf(e);
        return waitMs === undefined
          ? Effect.void
          : Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.sync(() => blockQuota(installationId, now + waitMs)),
            );
      }),
      Effect.retry(checksRetry),
    );

  return {
    create: ({ repo, sha, name, output, detailsUrl }) =>
      Effect.gen(function* () {
        if ((yield* admits) === "exhausted") {
          yield* Effect.logWarning(
            `checks.create skipped — installation quota exhausted; the verdict creates check-run "${name}"`,
          );
          return NOOP_CHECK_RUN_ID;
        }
        return yield* call("create", (t, observe) =>
          createCheckRun({ token: t, repo, sha, name, output, detailsUrl, observe }),
        ).pipe(
          Effect.catchIf(isRetryable, (e) =>
            Effect.as(Effect.logWarning(degradeMsg("create", e)), NOOP_CHECK_RUN_ID),
          ),
          Effect.orDie,
        );
      }),

    progress: ({ repo, checkRunId, output, detailsUrl }) =>
      Effect.gen(function* () {
        // Same sentinel handling as `update`: a degraded create has no real
        // check-run to PATCH.
        if (checkRunId === NOOP_CHECK_RUN_ID) {
          yield* Effect.logInfo("checks.progress skipped — create returned the no-op sentinel id");
          return;
        }
        // Position updates stop first: the reserve belongs to create and conclude.
        const state = yield* admits;
        if (state !== "open") {
          yield* Effect.logInfo(`checks.progress skipped — installation quota ${state}`);
          return;
        }
        yield* call("progress update", (t, observe) =>
          progressCheckRun({ token: t, repo, checkRunId, output, detailsUrl, observe }),
        ).pipe(
          Effect.catchIf(isRetryable, (e) => Effect.logWarning(degradeMsg("progress", e))),
          Effect.orDie,
        );
      }),

    status: ({ repo, checkRunId }) =>
      checkRunId === NOOP_CHECK_RUN_ID
        ? Effect.succeed<CheckRunState>("unknown")
        : Effect.gen(function* () {
            if ((yield* admits) === "exhausted") return "unknown" as const;
            const status = yield* call("read", (t, observe) =>
              getCheckRunStatus({ token: t, repo, checkRunId, observe }),
            );
            return status === "completed" ? ("completed" as const) : ("open" as const);
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.as(
                Effect.logWarning(`checks.status unreadable — ${cause}`),
                "unknown" as const,
              ),
            ),
          ),

    update: ({ repo, checkRunId, conclusion, output, detailsUrl }) =>
      Effect.gen(function* () {
        // A no-op create (degraded earlier in the same execution) yields the
        // sentinel id — there is no real check-run to PATCH, so skip cleanly.
        if (checkRunId === NOOP_CHECK_RUN_ID) {
          yield* Effect.logInfo("checks.update skipped — create returned the no-op sentinel id");
          return;
        }
        if ((yield* admits) === "exhausted") {
          yield* Effect.logWarning(
            `checks.update skipped — installation quota exhausted; conclusion "${conclusion}" not posted`,
          );
          return;
        }
        yield* call("update", (t, observe) =>
          updateCheckRun({ token: t, repo, checkRunId, conclusion, output, detailsUrl, observe }),
        ).pipe(
          Effect.catchIf(isRetryable, (e) => Effect.logWarning(degradeMsg("update", e))),
          Effect.orDie,
        );
      }),

    conclude: ({ repo, sha, name, checkRunId, conclusion, output, detailsUrl }) =>
      Effect.gen(function* () {
        if ((yield* admits) === "exhausted") {
          return { _tag: "undelivered", reason: "installation quota exhausted" } as const;
        }
        // An opener that degraded left no check-run: create it with the verdict.
        const write: Effect.Effect<string, unknown> =
          checkRunId === NOOP_CHECK_RUN_ID
            ? call("create", (t, observe) =>
                createCheckRun({ token: t, repo, sha, name, conclusion, output, detailsUrl, observe }),
              )
            : call("update", (t, observe) =>
                updateCheckRun({ token: t, repo, checkRunId, conclusion, output, detailsUrl, observe }),
              ).pipe(Effect.as(checkRunId));
        return yield* write.pipe(
          Effect.map((id): CheckDelivery => ({ _tag: "delivered", checkRunId: id })),
          Effect.catchAll((e) => {
            const delivery: CheckDelivery = isRefusal(e)
              ? { _tag: "refused", reason: describeFailure(e) }
              : { _tag: "undelivered", reason: describeFailure(e) };
            return Effect.as(
              Effect.logWarning(
                `checks.conclude ${delivery._tag} (${delivery.reason}) — conclusion "${conclusion}" not posted`,
              ),
              delivery,
            );
          }),
        );
      }),
  };
};
