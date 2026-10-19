// Unit tests for the issue surface — two reads and six writes.
//
// Mocks `api.github.com` with MSW and pins the WIRE SHAPE of each call. This is
// the module that puts labels on issues and closes them, so what matters here
// is not that the functions run but that they send exactly what they claim to:
// the run tests above this layer drive a hand-written fake, and a fake can only
// prove the run's wiring, never that the fake and the HTTP agree.
//
// Four properties the triage desk's safety argument actually rests on:
//
//   * pull requests never come back from the issue list (`GET /issues` returns
//     them, and a triage pass that labelled PRs as bugs would be the first
//     thing anyone noticed);
//   * a label removal that 404s is success, because "already absent" is the
//     requested end state;
//   * the duplicate close PATCHes `state_reason: "duplicate"` and nothing else, and
//     the bot-issue close touches only an open, bot-opened, ledger-labelled issue;
//   * every call carries the installation token as a Bearer credential.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addIssueLabels,
  closeBotIssue,
  closeIssueAsDuplicate,
  createIssue,
  createIssueComment,
  listIssues,
  removeIssueLabel,
} from "./index";

type Captured = {
  method: string;
  path: string;
  /** The pathname exactly as sent — MSW decodes `:params`, this does not. */
  rawPath: string;
  authorization: string | null;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Captured[] = [];
/** Pages the list handler serves, in order; each call shifts one off. */
let pages: unknown[][] = [];
/** Status the label-DELETE handler answers with. */
let removeStatus = 204;

const capture = async (request: Request, path: string): Promise<void> => {
  const url = new URL(request.url);
  let body: Record<string, unknown> | undefined;
  if (request.method !== "GET" && request.method !== "DELETE") {
    body = (await request.json()) as Record<string, unknown>;
  }
  calls.push({
    method: request.method,
    path,
    rawPath: url.pathname,
    authorization: request.headers.get("authorization"),
    query: Object.fromEntries(url.searchParams.entries()),
    body,
  });
};

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/issues", async ({ request }) => {
    await capture(request, "list");
    return HttpResponse.json(pages.shift() ?? []);
  }),
  http.post("https://api.github.com/repos/:owner/:repo/issues", async ({ request }) => {
    await capture(request, "create");
    return HttpResponse.json(
      { number: 41, html_url: "https://github.com/owner/name/issues/41" },
      { status: 201 },
    );
  }),
  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:n/labels",
    async ({ request, params }) => {
      await capture(request, `labels:${String(params.n)}`);
      return HttpResponse.json([], { status: 200 });
    },
  ),
  http.delete(
    "https://api.github.com/repos/:owner/:repo/issues/:n/labels/:label",
    async ({ request, params }) => {
      await capture(request, `unlabel:${String(params.n)}:${String(params.label)}`);
      return removeStatus === 204
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ message: "Label does not exist" }, { status: removeStatus });
    },
  ),
  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:n/comments",
    async ({ request, params }) => {
      await capture(request, `comment:${String(params.n)}`);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    },
  ),
  http.patch("https://api.github.com/repos/:owner/:repo/issues/:n", async ({ request, params }) => {
    await capture(request, `patch:${String(params.n)}`);
    return HttpResponse.json({ number: Number(params.n) }, { status: 200 });
  }),
  http.post("https://api.github.com/graphql", async ({ request }) => {
    await capture(request, "viewer");
    return HttpResponse.json({ data: { viewer: { login: "our-app[bot]" } } });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  calls = [];
  pages = [];
  removeStatus = 204;
});
afterAll(() => server.close());

const base = { token: "inst-token-abc", repo: "owner/name" } as const;

/** A GitHub issue JSON blob, in the shape the normalizer reads. */
const rawIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: "It broke",
  body: "here is how",
  state: "open",
  labels: [{ name: "bug" }, { name: "triage:needs-repro" }],
  user: { login: "stranger" },
  author_association: "NONE",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  html_url: "https://github.com/owner/name/issues/7",
  comments: 3,
  ...over,
});

describe("listIssues", () => {
  it("normalizes an issue and carries the author's standing", async () => {
    pages = [[rawIssue()]];
    const out = await listIssues({ ...base });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      number: 7,
      title: "It broke",
      body: "here is how",
      state: "open",
      labels: ["bug", "triage:needs-repro"],
      author: "stranger",
      authorAssociation: "NONE",
      commentCount: 3,
    });
    expect(calls[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("filters out pull requests — GET /issues returns them too", async () => {
    pages = [
      [
        rawIssue({ number: 7 }),
        // A PR wearing an issue's clothes: the `pull_request` key is the tell.
        rawIssue({ number: 8, pull_request: { url: "https://api.github.com/…/pulls/8" } }),
      ],
    ];
    const out = await listIssues({ ...base });
    expect(out.map((i) => i.number)).toEqual([7]);
  });

  it("asks for open issues newest-updated first, and passes `since` and labels", async () => {
    pages = [[]];
    await listIssues({
      ...base,
      labels: ["triage:needs-repro", "bug"],
      updatedSince: Date.UTC(2026, 7, 1),
    });
    expect(calls[0]?.query).toMatchObject({
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: "100",
      page: "1",
      labels: "triage:needs-repro,bug",
      since: "2026-08-01T00:00:00.000Z",
    });
  });

  it("stops on a short page rather than paging to the ceiling", async () => {
    pages = [[rawIssue()]]; // 1 < per_page → one request only
    await listIssues({ ...base, maxPages: 5 });
    expect(calls.filter((c) => c.path === "list")).toHaveLength(1);
  });

  it("honours maxPages on a backlog that keeps filling pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawIssue({ number: i + 1 }));
    pages = [full, full, full];
    const out = await listIssues({ ...base, maxPages: 2 });
    expect(calls.filter((c) => c.path === "list")).toHaveLength(2);
    expect(out).toHaveLength(200);
  });

  it("defaults an unrecognized author_association to NONE", async () => {
    pages = [[rawIssue({ author_association: "SOVEREIGN" })]];
    const out = await listIssues({ ...base });
    expect(out[0]?.authorAssociation).toBe("NONE");
  });

  it("surfaces a non-2xx rather than reporting an empty backlog", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/issues", () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    await expect(listIssues({ ...base })).rejects.toThrow();
  });

  it("reads closed_at, and leaves it empty while the issue is open", async () => {
    pages = [[rawIssue({ state: "closed", closed_at: "2026-08-10T09:00:00Z" }), rawIssue()]];
    const out = await listIssues({ ...base, state: "all" });
    expect(out[0]?.closedAt).toBe("2026-08-10T09:00:00Z");
    expect(out[1]?.closedAt).toBe("");
  });

  // The dedup read's whole job is answering "have I already filed this?", and a
  // list the ceiling cut short answers "no" for everything it never reached.
  it("throws under `strict` when the page ceiling cut the list short", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawIssue({ number: i + 1 }));
    pages = [full, full];
    await expect(listIssues({ ...base, maxPages: 1, strict: true })).rejects.toThrow(
      /page ceiling/,
    );
  });

  it("does not throw under `strict` when a short page ended the list", async () => {
    pages = [[rawIssue()]];
    await expect(listIssues({ ...base, maxPages: 1, strict: true })).resolves.toHaveLength(1);
  });

  // The boundary case: a full last page that happens to be the last page. GitHub
  // cannot say so, and neither can we — a strict caller is told to look again
  // rather than shown a list nobody can vouch for.
  it("throws under `strict` on an exactly-full last page", async () => {
    pages = [Array.from({ length: 100 }, (_, i) => rawIssue({ number: i + 1 })), []];
    await expect(listIssues({ ...base, maxPages: 1, strict: true })).rejects.toThrow();
  });
});

describe("createIssue", () => {
  it("POSTs title, body and labels to /issues and returns the number and url", async () => {
    const out = await createIssue({
      ...base,
      title: "Is ADR-0002 accepted?",
      body: "maintenance-key: org-spec-audit/memory-capability",
      labels: ["maintenance:open-question", "question:decide"],
    });

    expect(out).toEqual({ number: 41, url: "https://github.com/owner/name/issues/41" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "create" });
    expect(calls[0]?.body).toEqual({
      title: "Is ADR-0002 accepted?",
      body: "maintenance-key: org-spec-audit/memory-capability",
      labels: ["maintenance:open-question", "question:decide"],
    });
    expect(calls[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("omits `labels` entirely when none were given", async () => {
    await createIssue({ ...base, title: "t", body: "b" });
    expect(calls[0]?.body).toEqual({ title: "t", body: "b" });
  });

  it("fails when the create returns no issue number — #0 links nowhere", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/issues", () =>
        HttpResponse.json({ html_url: "https://github.com/owner/name/issues/?" }, { status: 201 }),
      ),
    );
    await expect(createIssue({ ...base, title: "t", body: "b" })).rejects.toThrow(
      /no issue number/,
    );
  });

  it("fails when the create returns no url — a notice would link nowhere", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/issues", () =>
        HttpResponse.json({ number: 41 }, { status: 201 }),
      ),
    );
    await expect(createIssue({ ...base, title: "t", body: "b" })).rejects.toThrow(/no html_url/);
  });

  it("surfaces a non-2xx", async () => {
    server.use(
      http.post("https://api.github.com/repos/:owner/:repo/issues", () =>
        HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }),
      ),
    );
    await expect(createIssue({ ...base, title: "t", body: "b" })).rejects.toThrow();
  });
});

describe("addIssueLabels", () => {
  it("POSTs the labels to /labels", async () => {
    await addIssueLabels({ ...base, issue: 7, labels: ["triage:needs-repro"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "labels:7" });
    expect(calls[0]?.body).toEqual({ labels: ["triage:needs-repro"] });
    expect(calls[0]?.authorization).toBe("Bearer inst-token-abc");
  });

  it("sends nothing at all for an empty label list", async () => {
    await addIssueLabels({ ...base, issue: 7, labels: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("removeIssueLabel", () => {
  it("DELETEs the label url-encoded, so a `:` in the name cannot alter the path", async () => {
    await removeIssueLabel({ ...base, issue: 7, label: "triage:needs-repro" });
    expect(calls[0]?.method).toBe("DELETE");
    // Asserted on the raw pathname: MSW decodes `:label` before handing it over,
    // so the decoded form would pass whether or not the code encoded anything.
    expect(calls[0]?.rawPath).toBe("/repos/owner/name/issues/7/labels/triage%3Aneeds-repro");
  });

  it("encodes a label containing a slash rather than growing a path segment", async () => {
    server.use(
      http.delete(
        "https://api.github.com/repos/:owner/:repo/issues/:n/labels/*",
        async ({ request }) => {
          await capture(request, "unlabel-wild");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await removeIssueLabel({ ...base, issue: 7, label: "area/api" });
    expect(calls[0]?.rawPath).toBe("/repos/owner/name/issues/7/labels/area%2Fapi");
  });

  it("treats 404 as the requested end state, not a failure", async () => {
    removeStatus = 404;
    await expect(
      removeIssueLabel({ ...base, issue: 7, label: "never-was-there" }),
    ).resolves.toBeUndefined();
  });

  it("still surfaces a real failure", async () => {
    removeStatus = 500;
    await expect(removeIssueLabel({ ...base, issue: 7, label: "bug" })).rejects.toThrow();
  });
});

describe("createIssueComment", () => {
  it("POSTs the caller's body verbatim — this module renders nothing", async () => {
    await createIssueComment({ ...base, issue: 7, body: "Thanks for the report." });
    expect(calls[0]).toMatchObject({ method: "POST", path: "comment:7" });
    expect(calls[0]?.body).toEqual({ body: "Thanks for the report." });
  });
});

describe("closeIssueAsDuplicate", () => {
  it("PATCHes state closed with state_reason duplicate, and nothing else", async () => {
    await closeIssueAsDuplicate({ ...base, issue: 7, duplicateOf: 3 });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "patch:7" });
    // Pinned deliberately: `state_reason` is the claim that survives in the
    // timeline, and this is the only close the service has. A change to this
    // body is a change to what the loop records about a stranger's issue.
    expect(calls[0]?.body).toEqual({ state: "closed", state_reason: "duplicate" });
  });

  it("names the duplicate target when the close fails", async () => {
    server.use(
      http.patch("https://api.github.com/repos/:owner/:repo/issues/:n", () =>
        HttpResponse.json({ message: "Validation failed" }, { status: 422 }),
      ),
    );
    await expect(closeIssueAsDuplicate({ ...base, issue: 7, duplicateOf: 3 })).rejects.toThrow(
      /duplicate of #3/,
    );
  });
});

describe("closeBotIssue", () => {
  const req = { ...base, issue: 41, label: "nightly-tier", comment: "Passed on abc." };
  const serve = (issue: Record<string, unknown>) =>
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/issues/:n", async ({ request, params }) => {
        await capture(request, `read:${String(params.n)}`);
        return HttpResponse.json({ number: Number(params.n), ...issue });
      }),
    );
  const botIssue = {
    state: "open",
    user: { type: "Bot", login: "our-app[bot]" },
    labels: [{ name: "nightly-tier" }],
  };

  it("comments, then PATCHes state closed with state_reason completed", async () => {
    serve(botIssue);
    expect(await closeBotIssue(req)).toEqual({ closed: true, number: 41 });
    expect(calls.map((c) => c.path)).toEqual(["read:41", "viewer", "comment:41", "patch:41"]);
    expect(calls[1]?.authorization).toBe("Bearer inst-token-abc");
    expect(calls[2]?.body).toEqual({ body: "Passed on abc." });
    expect(calls[3]?.body).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("leaves another App bot's labelled issue open and silent", async () => {
    serve({ ...botIssue, user: { type: "Bot", login: "other-app[bot]" } });
    expect(await closeBotIssue(req)).toEqual({
      closed: false,
      reason: "foreign-owned",
      number: 41,
    });
    expect(calls.map((c) => c.path)).toEqual(["read:41", "viewer"]);
  });

  it("fails closed when the installation's bot identity is unavailable", async () => {
    serve(botIssue);
    server.use(
      http.post("https://api.github.com/graphql", async ({ request }) => {
        await capture(request, "viewer");
        return HttpResponse.json({ data: { viewer: null } });
      }),
    );
    await expect(closeBotIssue(req)).rejects.toThrow(/identity unavailable/);
    expect(calls.map((c) => c.path)).toEqual(["read:41", "viewer"]);
  });

  it("leaves a human-opened issue open and silent", async () => {
    serve({ ...botIssue, user: { type: "User" } });
    expect(await closeBotIssue(req)).toEqual({ closed: false, reason: "human-owned", number: 41 });
    expect(calls.map((c) => c.path)).toEqual(["read:41"]);
  });

  it("leaves a bot issue without the ledger label open", async () => {
    serve({ ...botIssue, labels: [{ name: "bug" }] });
    expect(await closeBotIssue(req)).toEqual({ closed: false, reason: "unlabelled", number: 41 });
    expect(calls.map((c) => c.path)).toEqual(["read:41"]);
  });

  it("writes nothing to an issue already closed", async () => {
    serve({ ...botIssue, state: "closed" });
    expect(await closeBotIssue(req)).toEqual({ closed: false, reason: "not-open", number: 41 });
    expect(calls.map((c) => c.path)).toEqual(["read:41"]);
  });
});
