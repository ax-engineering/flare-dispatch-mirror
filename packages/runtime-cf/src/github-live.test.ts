// Integration tests for makeGithubLive — the live `github` write capability.
//
// Mocks `api.github.com` with MSW (plain Node) and asserts the `pullReview`
// write against the real `Github` Effect Layer:
//
//   * configured  — one access-token exchange then one POST /pulls/{n}/reviews
//                   with event:COMMENT, the body, and the head sha as commit_id;
//   * degraded    — with no App config, `pullReview` makes zero HTTP calls and
//                   still succeeds (reporting must never fail a run);
//   * no install  — with config but a request lacking an installation id, it
//                   resolves the installation from GET /repos/{repo}/installation
//                   (App JWT), then exchanges a token and posts the review.

import {
  __clearTokenCache,
  __clearRepoInstallationCache,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Effect, Exit } from "effect";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { github } from "@fractalboxdev/flare-dispatch-core";
import { TEST_APP_PRIVATE_KEY } from "@fractalboxdev/flare-dispatch-github-app/testing";
import { classifyReason, type GithubLiveConfig, makeGithubLive } from "./github-live";

type Recorded = {
  tokenExchanges: number;
  installationLookups: number;
  reviews: { pr: string; authorization: string | null; body: Record<string, unknown> }[];
  assets: { name: string | null; authorization: string | null; bytes: Uint8Array }[];
};
let recorded: Recorded;

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/installation", () => {
    recorded.installationLookups += 1;
    return HttpResponse.json({ id: 778899 }, { status: 200 });
  }),
  http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
    recorded.tokenExchanges += 1;
    return HttpResponse.json({
      token: "ghs_install_token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }),
  http.post(
    "https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews",
    async ({ request, params }) => {
      recorded.reviews.push({
        pr: String(params.pr),
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json({ id: 999_001 }, { status: 200 });
    },
  ),
  http.post(
    "https://uploads.github.com/repos/:owner/:repo/releases/:id/assets",
    async ({ request }) => {
      recorded.assets.push({
        name: new URL(request.url).searchParams.get("name"),
        authorization: request.headers.get("authorization"),
        bytes: new Uint8Array(await request.arrayBuffer()),
      });
      return HttpResponse.json(
        {
          id: 71,
          name: "build.tar.gz",
          size: 3,
          browser_download_url: "https://github.com/owner/name/releases/download/v1/build.tar.gz",
        },
        { status: 201 },
      );
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  recorded = { tokenExchanges: 0, installationLookups: 0, reviews: [], assets: [] };
  __clearTokenCache();
  __clearRepoInstallationCache();
});

describe("makeGithubLive — publishReleaseAsset", () => {
  const request = {
    repo: "owner/name",
    releaseId: 55,
    artifactName: "build.tar.gz",
    contentType: "application/gzip",
    installationId: 12345,
  };
  it("streams a completed R2 artifact with Worker-held App credentials", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const bucket = {
      get: async (key: string) => {
        expect(key).toBe("artifacts/01EXEC/build.tar.gz");
        return {
          size: bytes.length,
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
        };
      },
    } as unknown as R2Bucket;
    const result = await Effect.runPromise(
      github
        .publishReleaseAsset(request)
        .pipe(Effect.provide(makeGithubLive(CONFIG, bucket, "01EXEC"))),
    );
    expect(result.downloadUrl).toContain("/build.tar.gz");
    expect(recorded.assets).toEqual([
      { name: "build.tar.gz", authorization: "Bearer ghs_install_token", bytes },
    ]);
  });

  it("fails when the R2 artifact is absent", async () => {
    const bucket = { get: async () => null } as unknown as R2Bucket;
    const exit = await Effect.runPromiseExit(
      github
        .publishReleaseAsset(request)
        .pipe(Effect.provide(makeGithubLive(CONFIG, bucket, "01EXEC"))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(recorded.assets).toHaveLength(0);
  });

  it("surfaces a rate limit with its retry hint after one upload, leaving the wait to the run", async () => {
    server.use(
      http.post("https://uploads.github.com/repos/:owner/:repo/releases/:id/assets", async ({ request }) => {
        recorded.assets.push({
          name: new URL(request.url).searchParams.get("name"),
          authorization: request.headers.get("authorization"),
          bytes: new Uint8Array(await request.arrayBuffer()),
        });
        return HttpResponse.json({ message: "secondary rate limit" }, { status: 403, headers: { "retry-after": "700" } });
      }),
    );
    const bucket = {
      get: async () => ({ size: 3, body: new Blob([new Uint8Array([1, 2, 3])]).stream() }),
    } as unknown as R2Bucket;
    const exit = await Effect.runPromiseExit(
      github
        .publishReleaseAsset(request)
        .pipe(Effect.provide(makeGithubLive(CONFIG, bucket, "01EXEC"))),
    );
    expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : undefined)
      .toMatchObject({ status: 403, reason: "rate-limited", retryAfterMs: 700_000 });
    expect(recorded.assets).toHaveLength(1);
  });
});

const CONFIG: GithubLiveConfig = {
  appId: "42",
  privateKeyPem: TEST_APP_PRIVATE_KEY,
};

const post = (
  layer: ReturnType<typeof makeGithubLive>,
  req: Parameters<typeof github.pullReview>[0],
): Promise<void> => Effect.runPromise(github.pullReview(req).pipe(Effect.provide(layer)));

describe("makeGithubLive — pullReview", () => {
  it("configured — exchanges a token then POSTs a COMMENT review", async () => {
    await post(makeGithubLive(CONFIG), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
      installationId: 12345,
    });

    expect(recorded.tokenExchanges).toBe(1);
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.reviews[0]!.pr).toBe("42");
    expect(recorded.reviews[0]!.authorization).toBe("Bearer ghs_install_token");
    expect(recorded.reviews[0]!.body.event).toBe("COMMENT");
    expect(recorded.reviews[0]!.body.commit_id).toBe("headsha");
  });

  it("degraded — no App config → zero HTTP calls, still succeeds", async () => {
    await post(makeGithubLive(undefined), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
      installationId: 12345,
    });
    expect(recorded.tokenExchanges).toBe(0);
    expect(recorded.reviews).toHaveLength(0);
  });

  it("no installation id — resolves it from the repo, then posts the review", async () => {
    await post(makeGithubLive(CONFIG), {
      repo: "owner/name",
      pr: 42,
      sha: "headsha",
      body: "summary",
    });
    // resolve installation → exchange token → POST review
    expect(recorded.installationLookups).toBe(1);
    expect(recorded.tokenExchanges).toBe(1);
    expect(recorded.reviews).toHaveLength(1);
    expect(recorded.reviews[0]!.body.event).toBe("COMMENT");
  });

  it("surfaces a GitHub API failure as a typed GitHubApiError", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/pulls/:pr/reviews", () =>
        HttpResponse.json({ message: "gone" }, { status: 404 }),
      ),
    );
    const exit = await Effect.runPromiseExit(
      github
        .pullReview({
          repo: "owner/name",
          pr: 42,
          sha: "headsha",
          body: "summary",
          installationId: 12345,
        })
        .pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(exit._tag).toBe("Failure");
  });
});

// --- The two reads suppression rides on -------------------------------------
//
// Both are pointed at a PRIVATE repo (the ledger lives in one), so the App-auth
// path matters as much as the payload: with no installation id — which is every
// cron tick — the Layer resolves the repo's installation itself before minting
// a token.

describe("makeGithubLive — readTextFile", () => {
  it("resolves the installation, mints a token, and returns the file", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/contents/*", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer ghs_install_token");
        return HttpResponse.text('{"key":"org-spec-audit/a"}');
      }),
    );
    const result = await Effect.runPromise(
      github
        .readTextFile({ repo: "owner/private", path: "maintenance/declined.jsonl" })
        .pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(result).toEqual({ found: true, content: '{"key":"org-spec-audit/a"}' });
    expect(recorded.installationLookups).toBe(1);
    expect(recorded.tokenExchanges).toBe(1);
  });

  it("returns found:false for a file that is not there", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/contents/*", () =>
        HttpResponse.text("Not Found", { status: 404 }),
      ),
    );
    const result = await Effect.runPromise(
      github
        .readTextFile({ repo: "owner/private", path: "nope.jsonl", installationId: 12345 })
        .pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(result).toEqual({ found: false });
  });

  it("degraded — no App config FAILS rather than reporting an empty file", async () => {
    // The writes degrade to a logged no-op; a read must not, because
    // `{ found: false }` here would be a missing credential wearing a missing
    // file's clothes, and a caller would suppress (or not) on a lie.
    const exit = await Effect.runPromiseExit(
      github
        .readTextFile({ repo: "owner/private", path: "a.jsonl" })
        .pipe(Effect.provide(makeGithubLive(undefined))),
    );
    expect(exit._tag).toBe("Failure");
    expect(recorded.tokenExchanges).toBe(0);
  });
});

describe("makeGithubLive — branchHead", () => {
  const HEAD = "fedcba9876543210fedcba9876543210fedcba98";

  it("resolves the installation, mints a token, and returns the ref's SHA", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/git/ref/*", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer ghs_install_token");
        expect(new URL(request.url).pathname).toBe("/repos/owner/private/git/ref/heads/main");
        return HttpResponse.json({ object: { sha: HEAD, type: "commit" } });
      }),
    );
    const sha = await Effect.runPromise(
      github
        .branchHead({ repo: "owner/private", branch: "main" })
        .pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(sha).toBe(HEAD);
    expect(recorded.tokenExchanges).toBe(1);
  });

  it("degraded — no App config FAILS; no string may stand in for a SHA", async () => {
    const exit = await Effect.runPromiseExit(
      github
        .branchHead({ repo: "owner/private", branch: "main" })
        .pipe(Effect.provide(makeGithubLive(undefined))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(recorded.tokenExchanges).toBe(0);
  });
});

describe("makeGithubLive — pullRequestHistory", () => {
  it("asks for every state and tags each row with its repo", async () => {
    let seen: URL | undefined;
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/pulls", ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json([
          {
            number: 12,
            title: "t",
            body: "maintenance-key: org-spec-audit/a",
            head: { ref: "flare-dispatch/spec-audit-questions-2026-07-01" },
            state: "closed",
            draft: true,
            html_url: "https://github.com/owner/private/pull/12",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            closed_at: "2026-07-02T00:00:00Z",
            merged_at: null,
          },
        ]);
      }),
    );
    const prs = await Effect.runPromise(
      github
        .pullRequestHistory({
          repo: "owner/private",
          headBranchPrefix: "flare-dispatch/spec-audit-questions-",
          updatedWithinDays: 30,
          installationId: 12345,
        })
        .pipe(Effect.provide(makeGithubLive(CONFIG))),
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      repo: "owner/private",
      number: 12,
      state: "closed",
      closedAt: Date.parse("2026-07-02T00:00:00Z"),
    });
    expect(prs[0]!.mergedAt).toBeUndefined();
    expect(seen?.searchParams.get("state")).toBe("all");
  });

  it("degraded — no App config FAILS rather than reporting an empty history", async () => {
    const exit = await Effect.runPromiseExit(
      github
        .pullRequestHistory({ repo: "owner/private" })
        .pipe(Effect.provide(makeGithubLive(undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("classifyReason", () => {
  it("classifies a 403 carrying a Retry-After as rate-limited, not unauthorized", () => {
    // The headline fix: GitHub returns 403 (not 429) for secondary rate limits,
    // the ones content-generating POSTs like a PR review trip. Without the retry
    // hint a 403 is a genuine auth failure.
    expect(classifyReason(403, 60_000)).toBe("rate-limited");
    expect(classifyReason(403, undefined)).toBe("unauthorized");
  });

  it("classifies 429 as rate-limited and 401 as unauthorized", () => {
    expect(classifyReason(429, undefined)).toBe("rate-limited");
    expect(classifyReason(401, undefined)).toBe("unauthorized");
  });

  it("classifies 5xx and a raw network throw (status 0) as transient", () => {
    expect(classifyReason(502, undefined)).toBe("transient");
    expect(classifyReason(0, undefined)).toBe("transient");
  });

  it("classifies other 4xx as other (non-retryable)", () => {
    expect(classifyReason(404, undefined)).toBe("other");
    expect(classifyReason(422, undefined)).toBe("other");
  });
});
