// Tests for the in-memory `Github` fake.
//
// Pins the filters `issues()` applies (repo, state, labels, recency) and the
// mutations the state-machine writes make to the seeded issue — a run test
// asserts "the label landed", so the fake has to actually move it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Github, type IssueRef, type PullRequestHistoryRef } from "../services/github";
import { makeGithubFake } from "./github-fake";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const issue = (overrides: Partial<IssueRef> = {}): IssueRef => ({
  repo: "owner/repo",
  number: 1,
  title: "Test issue",
  body: "",
  state: "open",
  labels: [],
  author: "alice",
  authorAssociation: "NONE",
  url: "https://github.com/owner/repo/issues/1",
  commentCount: 0,
  createdAt: NOW - DAY,
  updatedAt: NOW - HOUR,
  ...overrides,
});

describe("makeGithubFake — issues()", () => {
  const seeded = [
    issue({ number: 1 }),
    issue({ number: 2, labels: ["triage:needs-repro"] }),
    issue({ number: 3, state: "closed" }),
    issue({ number: 4, repo: "owner/other" }),
    issue({ number: 5, updatedAt: NOW - 30 * DAY }),
  ];

  const read = async (opts: {
    repo: string;
    state?: "open" | "closed" | "all";
    labels?: readonly string[];
    updatedWithinDays?: number;
  }) => {
    const { layer, state } = makeGithubFake({ now: NOW, issues: seeded });
    const got = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.issues(opts)).pipe(Effect.provide(layer)),
    );
    return { got, state };
  };

  it("returns this repo's open issues and records the call", async () => {
    const { got, state } = await read({ repo: "owner/repo" });
    expect(got.map((i) => i.number)).toEqual([1, 2, 5]);
    expect(state.issuesCalls[0]).toMatchObject({ repo: "owner/repo", state: "open" });
  });

  it("never leaks another repo's issues", async () => {
    const { got } = await read({ repo: "owner/repo" });
    expect(got.every((i) => i.repo === "owner/repo")).toBe(true);
  });

  it("filters by state and by label", async () => {
    expect((await read({ repo: "owner/repo", state: "closed" })).got.map((i) => i.number)).toEqual([
      3,
    ]);
    expect(
      (await read({ repo: "owner/repo", labels: ["triage:needs-repro"] })).got.map((i) => i.number),
    ).toEqual([2]);
  });

  it("applies the recency cutoff", async () => {
    const { got } = await read({ repo: "owner/repo", updatedWithinDays: 7 });
    expect(got.map((i) => i.number)).toEqual([1, 2]);
  });
});

describe("makeGithubFake — the state-machine writes", () => {
  const seedOne = () => makeGithubFake({ now: NOW, issues: [issue({ number: 7 })] });

  it("addIssueLabels records the call and moves the label onto the issue", async () => {
    const { layer, state } = seedOne();
    await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.addIssueLabels({ repo: "owner/repo", issue: 7, labels: ["triage:diagnosed"] }),
      ).pipe(Effect.provide(layer)),
    );
    expect(state.addIssueLabelsCalls).toEqual([
      { repo: "owner/repo", issue: 7, labels: ["triage:diagnosed"] },
    ]);
    expect(state.issues[0]!.labels).toEqual(["triage:diagnosed"]);
  });

  it("removeIssueLabel takes it off again, and tolerates one that was never on", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      issues: [issue({ number: 7, labels: ["triage:needs-repro"] })],
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        yield* g.removeIssueLabel({ repo: "owner/repo", issue: 7, label: "triage:needs-repro" });
        yield* g.removeIssueLabel({ repo: "owner/repo", issue: 7, label: "never-applied" });
      }).pipe(Effect.provide(layer)),
    );
    expect(state.issues[0]!.labels).toEqual([]);
    expect(state.removeIssueLabelCalls).toHaveLength(2);
  });

  it("commentOnIssue records the body it was asked to post", async () => {
    const { layer, state } = seedOne();
    await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.commentOnIssue({ repo: "owner/repo", issue: 7, body: "hello" }),
      ).pipe(Effect.provide(layer)),
    );
    expect(state.commentOnIssueCalls[0]).toMatchObject({ issue: 7, body: "hello" });
  });

  it("closeIssueAsDuplicate closes it and keeps the link", async () => {
    const { layer, state } = seedOne();
    await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.closeIssueAsDuplicate({ repo: "owner/repo", issue: 7, duplicateOf: 3 }),
      ).pipe(Effect.provide(layer)),
    );
    expect(state.closeIssueAsDuplicateCalls).toEqual([
      { repo: "owner/repo", issue: 7, duplicateOf: 3 },
    ]);
    expect(state.issues[0]!.state).toBe("closed");
  });

  it("closeBotIssue closes only an open, bot-opened issue carrying the label", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      issues: [
        issue({ number: 7, author: "flare-dispatch[bot]", labels: ["nightly-tier"] }),
        issue({ number: 8, author: "a-maintainer", labels: ["nightly-tier"] }),
        issue({ number: 9, author: "flare-dispatch[bot]", labels: [] }),
        issue({ number: 10, author: "other-app[bot]", labels: ["nightly-tier"] }),
      ],
    });
    const close = (n: number) =>
      Effect.runPromise(
        Effect.flatMap(Github, (g) =>
          g.closeBotIssue({ repo: "owner/repo", issue: n, label: "nightly-tier", comment: "green" }),
        ).pipe(Effect.provide(layer)),
      );
    expect(await close(7)).toEqual({ closed: true, number: 7 });
    expect(await close(7)).toEqual({ closed: false, reason: "not-open", number: 7 });
    expect(await close(8)).toEqual({ closed: false, reason: "human-owned", number: 8 });
    expect(await close(9)).toEqual({ closed: false, reason: "unlabelled", number: 9 });
    expect(await close(10)).toEqual({ closed: false, reason: "foreign-owned", number: 10 });
    expect(state.issues.map((i) => i.state)).toEqual(["closed", "open", "open", "open"]);
    expect(state.commentOnIssueCalls).toEqual([{ repo: "owner/repo", issue: 7, body: "green" }]);
  });
});

describe("makeGithubFake — pullRequestHistory() / readTextFile()", () => {
  const history = (over: Partial<PullRequestHistoryRef> = {}): PullRequestHistoryRef => ({
    repo: "owner/control",
    number: 12,
    title: "docs(maintenance): open questions",
    body: "maintenance-key: org-spec-audit/spend-caps",
    headBranch: "flare-dispatch/spec-audit-questions-2026-07-01",
    headSha: "abc123",
    state: "closed",
    draft: true,
    labels: [],
    author: "flare-dispatch[bot]",
    requestedReviewers: [],
    url: "https://github.com/owner/control/pull/12",
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 5 * DAY,
    closedAt: NOW - 5 * DAY,
    ...over,
  });

  it("filters by repo, state, and head-branch prefix", async () => {
    const { layer, state } = makeGithubFake({
      now: NOW,
      pullRequestHistory: [
        history({ number: 1 }),
        history({ number: 2, repo: "owner/other" }),
        history({ number: 3, headBranch: "feat/unrelated" }),
        history({ number: 4, updatedAt: NOW - 90 * DAY }),
        history({ number: 5, state: "open", closedAt: undefined }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({
          repo: "owner/control",
          headBranchPrefix: "flare-dispatch/spec-audit-questions-",
          state: "closed",
          updatedWithinDays: 30,
        }),
      ).pipe(Effect.provide(layer)),
    );
    // #4 is outside the 30-day window but still returned: `updatedWithinDays`
    // is a pagination bound, and the live read only stops FETCHING at it — the
    // out-of-window rows sharing a page with in-window ones come back. A fake
    // that filtered them would be stricter than production.
    expect(result.map((p) => p.number)).toEqual([1, 4]);
    expect(state.pullRequestHistoryCalls).toHaveLength(1);
  });

  it("returns newest-updated first, matching the live sort", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      // Seeded oldest-first, so insertion order and the contract disagree.
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 20 * DAY }),
        history({ number: 2, updatedAt: NOW - 1 * DAY }),
        history({ number: 3, updatedAt: NOW - 10 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) => g.pullRequestHistory({ repo: "owner/control" })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("stops at maxPages, dropping the rows past the cap", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      historyPageSize: 2,
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 1 * DAY }),
        history({ number: 2, updatedAt: NOW - 2 * DAY }),
        history({ number: 3, updatedAt: NOW - 3 * DAY }),
        history({ number: 4, updatedAt: NOW - 4 * DAY }),
        history({ number: 5, updatedAt: NOW - 5 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({ repo: "owner/control", maxPages: 2 }),
      ).pipe(Effect.provide(layer)),
    );
    // Two pages of two — #5 is past the cap and never fetched, which is exactly
    // how a repo with more history than the cap loses its oldest rows in prod.
    expect(result.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });

  it("stops paginating once a page runs past the update window", async () => {
    const { layer } = makeGithubFake({
      now: NOW,
      historyPageSize: 2,
      pullRequestHistory: [
        history({ number: 1, updatedAt: NOW - 1 * DAY }),
        history({ number: 2, updatedAt: NOW - 90 * DAY }),
        history({ number: 3, updatedAt: NOW - 91 * DAY }),
      ],
    });
    const result = await Effect.runPromise(
      Effect.flatMap(Github, (g) =>
        g.pullRequestHistory({ repo: "owner/control", updatedWithinDays: 30, maxPages: 5 }),
      ).pipe(Effect.provide(layer)),
    );
    // Page 1 is [#1, #2]; its oldest predates the cutoff, so page 2 is never
    // fetched and #3 never appears — the cap is not what stopped it.
    expect(result.map((p) => p.number)).toEqual([1, 2]);
  });

  it("answers a ref-pinned file when the caller names that ref", async () => {
    const { layer, state } = makeGithubFake({
      files: {
        "owner/control:maintenance/declined.jsonl": "default-branch",
        "owner/control@release/2026-08:maintenance/declined.jsonl": "on-the-release-branch",
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        return [
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
            ref: "release/2026-08",
          }),
          // An unseeded ref falls back to the bare key — what most tests want.
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
            ref: "some-other-branch",
          }),
          yield* g.readTextFile({ repo: "owner/control", path: "maintenance/declined.jsonl" }),
        ];
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([
      { found: true, content: "on-the-release-branch" },
      { found: true, content: "default-branch" },
      { found: true, content: "default-branch" },
    ]);
    expect(state.readTextFileCalls[0]?.ref).toBe("release/2026-08");
  });

  it("answers a seeded file, and found:false for anything else", async () => {
    const { layer, state } = makeGithubFake({
      files: { "owner/control:maintenance/declined.jsonl": '{"key":"a/b"}' },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const g = yield* Github;
        return [
          yield* g.readTextFile({
            repo: "owner/control",
            path: "maintenance/declined.jsonl",
          }),
          yield* g.readTextFile({ repo: "owner/control", path: "nope.jsonl" }),
        ];
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([{ found: true, content: '{"key":"a/b"}' }, { found: false }]);
    expect(state.readTextFileCalls).toHaveLength(2);
  });
});
