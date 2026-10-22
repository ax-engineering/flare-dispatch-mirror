// Integration tests for ChecksGithubLive — the live `checks` capability.
//
// Mocks `api.github.com` with MSW (plain Node, no Workers pool — same reason
// the D1/R2 suites use Miniflare directly) and asserts the GitHub half of the
// `finalize` boundary against the real `Checks` Effect Layer:
//
//   * green run  — exactly one POST /check-runs (status:in_progress) followed
//                  by exactly one PATCH (status:completed, conclusion:success);
//   * red run    — same, but conclusion:failure;
//   * degraded   — with no App config the no-op Layer makes zero HTTP calls and
//                  the execution still completes.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6 acceptance.

import { __clearTokenCache } from "@fractalboxdev/flare-dispatch-github-app";
import { Effect, Exit } from "effect";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checks } from "@fractalboxdev/flare-dispatch-core";
import { TEST_APP_PRIVATE_KEY } from "@fractalboxdev/flare-dispatch-github-app/testing";
import { type ChecksGithubConfig, makeChecksGithubLive, NOOP_CHECK_RUN_ID } from "./checks-github";
import { __clearQuotas, quotaState } from "./github-quota";

/** Records the GitHub API calls MSW intercepted, for per-test assertions. */
type Recorded = {
  posts: { status: unknown; conclusion?: unknown }[];
  patches: { id: string; status: unknown; conclusion: unknown }[];
  tokenExchanges: number;
};
let recorded: Recorded;

const GH_CHECK_RUN_ID = 909_001;

const server = setupServer(
  http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
    recorded.tokenExchanges += 1;
    return HttpResponse.json({
      token: "ghs_install_token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }),
  http.post("https://api.github.com/repos/:owner/:repo/check-runs", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    recorded.posts.push({ status: body.status, conclusion: body.conclusion });
    return HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201 });
  }),
  http.patch(
    "https://api.github.com/repos/:owner/:repo/check-runs/:id",
    async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      recorded.patches.push({
        id: String(params.id),
        status: body.status,
        conclusion: body.conclusion,
      });
      return HttpResponse.json({ id: Number(params.id) });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  recorded = { posts: [], patches: [], tokenExchanges: 0 };
  __clearTokenCache();
  __clearQuotas();
});

const CONFIG: ChecksGithubConfig = {
  appId: "42",
  privateKeyPem: TEST_APP_PRIVATE_KEY,
  installationId: 12345,
};

/**
 * Drive the create → update check-run lifecycle exactly as `RunWorkflow` will:
 * open the check-run on start, complete it with the run's conclusion.
 */
const driveLifecycle = (
  layer: ReturnType<typeof makeChecksGithubLive>,
  conclusion: "success" | "failure",
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const checkRunId = yield* checks.create({
        repo: "owner/name",
        sha: "abc123",
        name: "flare-dispatch/offload-test",
        output: { title: "offload-test", summary: "running" },
      });
      yield* checks.update({
        repo: "owner/name",
        checkRunId,
        conclusion,
        output: { title: "offload-test", summary: "done" },
      });
    }).pipe(Effect.provide(layer)),
  );

describe("ChecksGithubLive — live GitHub App binding", () => {
  it("green run — one in_progress POST then one completed/success PATCH", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "success");

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.status).toBe("in_progress");

    expect(recorded.patches).toHaveLength(1);
    expect(recorded.patches[0]).toMatchObject({
      id: String(GH_CHECK_RUN_ID),
      status: "completed",
      conclusion: "success",
    });
  });

  it("red run — the closing PATCH carries conclusion:failure", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "failure");

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.status).toBe("in_progress");

    expect(recorded.patches).toHaveLength(1);
    expect(recorded.patches[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("reuses the cached installation token across create + update", async () => {
    await driveLifecycle(makeChecksGithubLive(CONFIG), "success");
    // create + update are two GitHub calls but share one installation token —
    // the in-memory cache means exactly one access_tokens exchange.
    expect(recorded.tokenExchanges).toBe(1);
  });

  const createOnly = (layer: ReturnType<typeof makeChecksGithubLive>) =>
    checks
      .create({
        repo: "owner/name",
        sha: "abc123",
        name: "flare-dispatch/offload-test",
      })
      .pipe(Effect.provide(layer));

  it("retries a transient 5xx on create, then succeeds on the next attempt", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ message: "upstream" }, { status: 502 })
          : HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201 });
      }),
    );

    const checkRunId = await Effect.runPromise(createOnly(makeChecksGithubLive(CONFIG)));

    // Recovered: the real id came back (not the degraded sentinel), after one retry.
    expect(checkRunId).not.toBe(NOOP_CHECK_RUN_ID);
    expect(attempts).toBe(2);
  });

  it("degrades a PERSISTENT 5xx to the no-op sentinel — a transient outage never kills a green run", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );

    // Resolves (does not reject as a defect): retries are exhausted, then the
    // create degrades to the sentinel id — exactly the no-credentials posture.
    const checkRunId = await Effect.runPromise(createOnly(makeChecksGithubLive(CONFIG)));
    expect(checkRunId).toBe(NOOP_CHECK_RUN_ID);
  });

  it("a non-retryable client error (404) still fails loudly (orDie), not silently degraded", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ message: "not found" }, { status: 404 }),
      ),
    );

    const exit = await Effect.runPromiseExit(createOnly(makeChecksGithubLive(CONFIG)));
    // A 404 is a genuine misconfiguration — it must surface as a defect, not
    // masquerade as a degraded no-op.
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("degraded — no App config makes zero GitHub calls and returns the sentinel id", async () => {
    const layer = makeChecksGithubLive(undefined);

    const checkRunId = await Effect.runPromise(
      checks
        .create({
          repo: "owner/name",
          sha: "abc123",
          name: "flare-dispatch/offload-test",
        })
        .pipe(Effect.provide(layer)),
    );
    expect(checkRunId).toBe(NOOP_CHECK_RUN_ID);

    await Effect.runPromise(
      checks
        .update({
          repo: "owner/name",
          checkRunId,
          conclusion: "success",
        })
        .pipe(Effect.provide(layer)),
    );

    // The no-op Layer never touches the network.
    expect(recorded.posts).toHaveLength(0);
    expect(recorded.patches).toHaveLength(0);
    expect(recorded.tokenExchanges).toBe(0);
  });
});

/** Quota headers for a window resetting ten minutes from now. */
const quotaHeaders = (remaining: number, limit = 5000): Record<string, string> => ({
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-limit": String(limit),
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
});

const REPO = { repo: "owner/name", sha: "abc123", name: "flare-dispatch/offload-test" };

describe("ChecksGithubLive — rate limits and the verdict reserve", () => {
  it("waits out a Retry-After before the retry instead of the default backoff", async () => {
    const at: number[] = [];
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () => {
        at.push(Date.now());
        return at.length === 1
          ? HttpResponse.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "1" } })
          : HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201 });
      }),
    );

    const id = await Effect.runPromise(checks.create(REPO).pipe(Effect.provide(makeChecksGithubLive(CONFIG))));

    expect(id).toBe(String(GH_CHECK_RUN_ID));
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(990);
  });

  it("degrades a wait longer than one call allows and stops calling until it lapses", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () => {
        attempts += 1;
        return HttpResponse.json(
          { message: "quota" },
          { status: 403, headers: { ...quotaHeaders(0), "retry-after": "600" } },
        );
      }),
    );
    const layer = makeChecksGithubLive(CONFIG);

    const first = await Effect.runPromise(checks.create(REPO).pipe(Effect.provide(layer)));
    expect(first).toBe(NOOP_CHECK_RUN_ID);
    expect(attempts).toBe(1);
    expect(quotaState(CONFIG.installationId, Date.now())).toBe("exhausted");

    // The next create does not spend a call on a wait GitHub already named.
    const second = await Effect.runPromise(checks.create(REPO).pipe(Effect.provide(layer)));
    expect(second).toBe(NOOP_CHECK_RUN_ID);
    expect(attempts).toBe(1);
  });

  it("stops position updates inside the reserve while create and conclude proceed", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201, headers: quotaHeaders(500) }),
      ),
      http.patch("https://api.github.com/repos/:owner/:repo/check-runs/:id", async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        recorded.patches.push({ id: String(params.id), status: body.status, conclusion: body.conclusion });
        return HttpResponse.json({ id: Number(params.id) }, { headers: quotaHeaders(499) });
      }),
    );
    const layer = makeChecksGithubLive(CONFIG);

    const delivery = await Effect.runPromise(
      Effect.gen(function* () {
        const checkRunId = yield* checks.create(REPO);
        yield* checks.progress({
          repo: REPO.repo,
          checkRunId,
          output: { title: "t", summary: "Queued" },
        });
        return yield* checks.conclude({ ...REPO, checkRunId, conclusion: "success" });
      }).pipe(Effect.provide(layer)),
    );

    expect(recorded.patches.map((p) => p.status)).toEqual(["completed"]);
    expect(delivery).toEqual({ _tag: "delivered", checkRunId: String(GH_CHECK_RUN_ID) });
  });

  it("writes position updates while the quota is above the reserve", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201, headers: quotaHeaders(501) }),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const checkRunId = yield* checks.create(REPO);
        yield* checks.progress({ repo: REPO.repo, checkRunId, output: { title: "t", summary: "Queued" } });
      }).pipe(Effect.provide(makeChecksGithubLive(CONFIG))),
    );
    expect(recorded.patches.map((p) => p.status)).toEqual(["in_progress"]);
  });

  it("creates the check-run with the verdict when the opener degraded to the sentinel", async () => {
    const delivery = await Effect.runPromise(
      checks
        .conclude({ ...REPO, checkRunId: NOOP_CHECK_RUN_ID, conclusion: "failure" })
        .pipe(Effect.provide(makeChecksGithubLive(CONFIG))),
    );

    expect(recorded.posts).toEqual([{ status: "completed", conclusion: "failure" }]);
    expect(recorded.patches).toHaveLength(0);
    expect(delivery).toEqual({ _tag: "delivered", checkRunId: String(GH_CHECK_RUN_ID) });
  });

  it("reports a conclusion GitHub never took as undelivered instead of failing", async () => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/check-runs/:id", () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const delivery = await Effect.runPromise(
      checks
        .conclude({ ...REPO, checkRunId: "77", conclusion: "success" })
        .pipe(Effect.provide(makeChecksGithubLive(CONFIG))),
    );
    expect(delivery).toEqual({ _tag: "undelivered", reason: "HTTP 503" });
  });

  it.each([404, 422])("reports a conclusion GitHub rejects with %i as refused", async (status) => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/check-runs/:id", () =>
        HttpResponse.json({ message: "no" }, { status }),
      ),
    );
    const delivery = await Effect.runPromise(
      checks
        .conclude({ ...REPO, checkRunId: "77", conclusion: "success" })
        .pipe(Effect.provide(makeChecksGithubLive(CONFIG))),
    );
    expect(delivery).toEqual({ _tag: "refused", reason: `HTTP ${status}` });
  });

  it("reports undelivered without a call when the installation is exhausted", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ id: GH_CHECK_RUN_ID }, { status: 201, headers: quotaHeaders(0) }),
      ),
    );
    const layer = makeChecksGithubLive(CONFIG);
    const checkRunId = await Effect.runPromise(checks.create(REPO).pipe(Effect.provide(layer)));
    const delivery = await Effect.runPromise(
      checks.conclude({ ...REPO, checkRunId, conclusion: "success" }).pipe(Effect.provide(layer)),
    );
    expect(delivery._tag).toBe("undelivered");
    expect(recorded.patches).toHaveLength(0);
  });

  it("the no-op Layer reports every conclusion undelivered", async () => {
    const delivery = await Effect.runPromise(
      checks
        .conclude({ ...REPO, checkRunId: NOOP_CHECK_RUN_ID, conclusion: "success" })
        .pipe(Effect.provide(makeChecksGithubLive(undefined))),
    );
    expect(delivery._tag).toBe("undelivered");
    expect(recorded.posts).toHaveLength(0);
  });
});
