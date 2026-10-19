// Unit tests for the commit → pull requests read.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commitPullsUrl, getPullRequest, GithubApiError, listCommitPullRequests } from "./index";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "f".repeat(40);

let requests: Array<{ url: URL; authorization: string | null }> = [];
let respond: () => Response = () => HttpResponse.json([]);

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/commits/:sha/pulls", ({ request }) => {
    requests.push({ url: new URL(request.url), authorization: request.headers.get("authorization") });
    return respond();
  }),
  http.get("https://api.github.com/repos/:owner/:repo/pulls/:number", ({ request }) => {
    requests.push({ url: new URL(request.url), authorization: request.headers.get("authorization") });
    return respond();
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
  respond = () => HttpResponse.json([]);
});
afterAll(() => server.close());

describe("listCommitPullRequests", () => {
  it("returns each PR's state, merge and current head", async () => {
    respond = () =>
      HttpResponse.json([
        { number: 7, state: "closed", merged_at: "2026-10-19T10:00:00Z", head: { sha: SHA, repo: { full_name: "owner/name" } } },
        { number: 8, state: "open", merged_at: null, head: { sha: OTHER, repo: null } },
        { number: "x", state: "open", head: { sha: SHA } },
      ]);
    await expect(listCommitPullRequests({ token: "inst", repo: "owner/name", sha: SHA })).resolves.toEqual([
      { number: 7, state: "closed", merged: true, headSha: SHA, headRepo: "owner/name" },
      { number: 8, state: "open", merged: false, headSha: OTHER, headRepo: "" },
    ]);
    expect(requests[0]?.url.pathname).toBe(`/repos/owner/name/commits/${SHA}/pulls`);
    expect(requests[0]?.authorization).toBe("Bearer inst");
  });

  it("throws on a non-2xx and on a body that is not a list", async () => {
    respond = () => HttpResponse.json({ message: "Not Found" }, { status: 404 });
    await expect(listCommitPullRequests({ token: "t", repo: "owner/name", sha: SHA })).rejects.toBeInstanceOf(GithubApiError);
    respond = () => HttpResponse.json({ number: 1 });
    await expect(listCommitPullRequests({ token: "t", repo: "owner/name", sha: SHA })).rejects.toBeInstanceOf(GithubApiError);
  });

  it("refuses a sha that is not 40 hex", () => {
    expect(() => commitPullsUrl({ repo: "owner/name", sha: "main" })).toThrow(GithubApiError);
  });
});

describe("getPullRequest", () => {
  it("reads one pull request's state and current head", async () => {
    respond = () =>
      HttpResponse.json({ number: 42, state: "open", merged_at: null, head: { sha: OTHER, repo: { full_name: "owner/name" } } });
    await expect(getPullRequest({ token: "inst", repo: "owner/name", number: 42 })).resolves.toEqual({
      number: 42, state: "open", merged: false, headSha: OTHER, headRepo: "owner/name",
    });
    expect(requests[0]?.url.pathname).toBe("/repos/owner/name/pulls/42");
    expect(requests[0]?.authorization).toBe("Bearer inst");
  });

  it("throws on a non-2xx, a body that is not a pull request, and a malformed number", async () => {
    respond = () => HttpResponse.json({ message: "Not Found" }, { status: 404 });
    await expect(getPullRequest({ token: "t", repo: "owner/name", number: 42 })).rejects.toBeInstanceOf(GithubApiError);
    respond = () => HttpResponse.json([]);
    await expect(getPullRequest({ token: "t", repo: "owner/name", number: 42 })).rejects.toBeInstanceOf(GithubApiError);
    await expect(getPullRequest({ token: "t", repo: "owner/name", number: 0 })).rejects.toBeInstanceOf(GithubApiError);
    expect(requests).toHaveLength(2);
  });
});
