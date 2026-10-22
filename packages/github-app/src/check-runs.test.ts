// Unit tests for check-run create / update.
//
// Mocks `api.github.com` with MSW and asserts: `createCheckRun` POSTs with
// `status: in_progress` and returns the assigned id; `updateCheckRun` PATCHes
// `/check-runs/{id}` with `status: completed` + the conclusion; both attach
// the installation token as a Bearer credential; a non-2xx surfaces a
// GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createCheckRun,
  getCheckRunStatus,
  GithubApiError,
  progressCheckRun,
  updateCheckRun,
} from "./index";

/** Records the requests MSW intercepted, for per-test assertions. */
type CapturedPost = {
  authorization: string | null;
  body: Record<string, unknown>;
};
type CapturedPatch = CapturedPost & { id: string };

let posts: CapturedPost[] = [];
let patches: CapturedPatch[] = [];

const server = setupServer(
  http.post("https://api.github.com/repos/:owner/:repo/check-runs", async ({ request }) => {
    posts.push({
      authorization: request.headers.get("authorization"),
      body: (await request.json()) as Record<string, unknown>,
    });
    return HttpResponse.json({ id: 555_001 }, { status: 201 });
  }),
  http.patch(
    "https://api.github.com/repos/:owner/:repo/check-runs/:id",
    async ({ request, params }) => {
      patches.push({
        id: String(params.id),
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json({ id: Number(params.id) });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  posts = [];
  patches = [];
});
afterAll(() => server.close());

describe("createCheckRun", () => {
  it("POSTs status:in_progress and returns the assigned check-run id", async () => {
    const id = await createCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      sha: "abc123",
      name: "flare-dispatch/offload-test",
      output: { title: "offload-test", summary: "running" },
    });

    expect(id).toBe("555001");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.authorization).toBe("Bearer ghs_test");
    expect(posts[0]!.body).toMatchObject({
      name: "flare-dispatch/offload-test",
      head_sha: "abc123",
      status: "in_progress",
    });
  });

  it("attaches details_url when provided, omits it otherwise", async () => {
    await createCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      sha: "abc123",
      name: "flare-dispatch/cdp-acceptance",
      detailsUrl:
        "https://dash.cloudflare.com/acct/workers/workflows/runs-workflow/instance/exec-1",
    });
    expect(posts[0]!.body.details_url).toBe(
      "https://dash.cloudflare.com/acct/workers/workflows/runs-workflow/instance/exec-1",
    );

    posts = [];
    await createCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      sha: "abc123",
      name: "flare-dispatch/cdp-acceptance",
    });
    expect(posts[0]!.body).not.toHaveProperty("details_url");
  });

  it("creates the check-run already completed when a conclusion is given", async () => {
    await createCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      sha: "abc123",
      name: "flare-dispatch/offload-test",
      conclusion: "failure",
    });
    expect(posts[0]!.body).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(posts[0]!.body.completed_at).toEqual(expect.any(String));
  });

  it("hands every response's headers to observe, a failed one included", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json(
          { message: "slow down" },
          { status: 429, headers: { "x-ratelimit-remaining": "0", "retry-after": "5" } },
        ),
      ),
    );
    await expect(
      createCheckRun({
        token: "ghs_test",
        repo: "owner/name",
        sha: "abc123",
        name: "flare-dispatch/offload-test",
        observe: (headers) => seen.push(headers.get("x-ratelimit-remaining")),
      }),
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(seen).toEqual(["0"]);
  });

  it("surfaces a GithubApiError on a non-2xx response", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/check-runs", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await expect(
      createCheckRun({
        token: "ghs_test",
        repo: "owner/name",
        sha: "abc123",
        name: "flare-dispatch/offload-test",
      }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("progressCheckRun", () => {
  it("PATCHes /check-runs/{id} with status:in_progress and NO conclusion", async () => {
    await progressCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      checkRunId: "555001",
      output: {
        title: "flare-dispatch/offload-test",
        summary:
          "Queued — waiting for a sandbox slot behind 3 runs (16/16 in use); times out 12:34 UTC",
      },
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]!.id).toBe("555001");
    expect(patches[0]!.authorization).toBe("Bearer ghs_test");
    expect(patches[0]!.body).toMatchObject({ status: "in_progress" });
    expect(patches[0]!.body).not.toHaveProperty("conclusion");
    expect(patches[0]!.body).not.toHaveProperty("completed_at");
  });

  it("surfaces a GithubApiError on a non-2xx response", async () => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/check-runs/:id", () =>
        HttpResponse.json({ message: "Gone" }, { status: 410 }),
      ),
    );
    await expect(
      progressCheckRun({
        token: "ghs_test",
        repo: "owner/name",
        checkRunId: "555001",
        output: { title: "t", summary: "s" },
      }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("updateCheckRun", () => {
  it("PATCHes /check-runs/{id} with status:completed + conclusion:success", async () => {
    await updateCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      checkRunId: "555001",
      conclusion: "success",
      output: { title: "offload-test", summary: "✓ passed" },
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]!.id).toBe("555001");
    expect(patches[0]!.authorization).toBe("Bearer ghs_test");
    expect(patches[0]!.body).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("PATCHes conclusion:failure for a red run", async () => {
    await updateCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      checkRunId: "555001",
      conclusion: "failure",
    });
    expect(patches[0]!.body).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("preserves details_url on completion when provided", async () => {
    await updateCheckRun({
      token: "ghs_test",
      repo: "owner/name",
      checkRunId: "555001",
      conclusion: "success",
      detailsUrl:
        "https://dash.cloudflare.com/acct/workers/workflows/runs-workflow/instance/exec-1",
    });
    expect(patches[0]!.body.details_url).toBe(
      "https://dash.cloudflare.com/acct/workers/workflows/runs-workflow/instance/exec-1",
    );
  });

  it("surfaces a GithubApiError on a non-2xx response", async () => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/check-runs/:id", () =>
        HttpResponse.json({ message: "Gone" }, { status: 410 }),
      ),
    );
    await expect(
      updateCheckRun({
        token: "ghs_test",
        repo: "owner/name",
        checkRunId: "555001",
        conclusion: "success",
      }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("getCheckRunStatus", () => {
  it("GETs /check-runs/{id} and resolves to its status", async () => {
    let authorization: string | null = null;
    server.use(
      http.get(
        "https://api.github.com/repos/:owner/:repo/check-runs/:id",
        ({ request, params }) => {
          authorization = request.headers.get("authorization");
          return HttpResponse.json({
            id: Number(params.id),
            status: params.id === "1" ? "completed" : "in_progress",
          });
        },
      ),
    );
    await expect(
      getCheckRunStatus({ token: "ghs_test", repo: "owner/name", checkRunId: "1" }),
    ).resolves.toBe("completed");
    await expect(
      getCheckRunStatus({ token: "ghs_test", repo: "owner/name", checkRunId: "2" }),
    ).resolves.toBe("in_progress");
    expect(authorization).toBe("Bearer ghs_test");
  });

  it("surfaces a GithubApiError on a non-2xx response", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/check-runs/:id", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await expect(
      getCheckRunStatus({ token: "ghs_test", repo: "owner/name", checkRunId: "9" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});
