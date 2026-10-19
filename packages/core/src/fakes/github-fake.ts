// @fractalboxdev/flare-dispatch-core — Github fake (read-only GitHub access).
//
// In-memory fake of the `github` capability. Tests pre-populate the state with
// `issues` / `workflowRuns` / `pullRequestHistory` arrays and a `files`
// map; the service applies the documented filters (archived skip, push age,
// draft skip, repo allow-list, update age, head-branch prefix) and returns the
// surviving rows. Call counts are recorded for assertions.
//
// `pullRequestHistory` goes further than filtering, because its *shape* is part
// of the contract: it sorts newest-updated-first and walks pages under a cap,
// the way the live read's `sort=updated&direction=desc` + `maxPages` do. A fake
// that returned seeded insertion order and ignored the cap would let a caller
// depending on either pass its tests and paginate differently in production.
//
// A test that wants `github` to fail with `GitHubApiError` constructs its own
// failing `Github` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import { GitHubApiError } from "../errors";
import {
  type CloseBotIssue,
  type CloseBotIssueResult,
  type CommitPullRequest,
  type CloseDraftPullRequest,
  type CloseDraftPullRequestResult,
  type CreateRelease,
  type DraftPullRequestResult,
  Github,
  type GithubService,
  type IssueRef,
  type OpenDraftPullRequest,
  type PullRequestHistoryRef,
  type PullReviewRequest,
  type ReadTextFileRequest,
  type ReleaseResult,
  type ReleaseAssetResult,
  type TextFileResult,
  type WorkflowRunRef,
} from "../services/github";

export type GithubFakeState = {
  /** Seeded issues — returned by `issues` (after filtering). */
  issues: IssueRef[];
  /** Seeded workflow runs — returned by `actionRuns` (after filtering). */
  workflowRuns: WorkflowRunRef[];
  /** Seeded PR history — returned by `pullRequestHistory` (after filtering). */
  pullRequestHistory: PullRequestHistoryRef[];
  /**
   * Seeded repo files answering `readTextFile`, keyed `"owner/name:path"` — or
   * `"owner/name@ref:path"` to pin one ref, which takes precedence when the
   * caller passes a matching `ref`.
   */
  files: Record<string, string>;
  /**
   * Seeded branch heads answering `branchHead`, keyed `"owner/name:branch"`.
   * An unseeded branch FAILS (404), as the live read does — mutate this map
   * mid-test to move a branch.
   */
  branchHeads: Record<string, string>;
  /** Every `branchHead` call, in order. */
  readonly branchHeadCalls: Array<{ repo: string; branch: string }>;
  /**
   * Seeded answers to `commitPullRequests`, keyed `"owner/name:sha"`. An
   * unseeded commit FAILS, as an unreadable live answer does.
   */
  commitPullRequests: Record<string, readonly CommitPullRequest[]>;
  /** Every `commitPullRequests` call, in order. */
  readonly commitPullRequestsCalls: Array<{ repo: string; sha: string }>;
  /**
   * Seeded answers to `pullRequest`, keyed `"owner/name#number"`. An unseeded
   * pull request FAILS, as an unreadable live answer does.
   */
  pullRequests: Record<string, CommitPullRequest>;
  /** Every `pullRequest` call, in order. */
  readonly pullRequestCalls: Array<{ repo: string; number: number }>;
  readonly appendMeasureNoteCalls: Array<{ repo: string; commit: string; text: string }>;
  /** Every `issues` call, in order. */
  readonly issuesCalls: Array<{
    repo: string;
    state: "open" | "closed" | "all";
    labels?: readonly string[];
    updatedWithinDays?: number;
    maxPages?: number;
    /**
     * Recorded, never simulated — the fake holds one page, so it can never
     * truncate. A dedup read's correctness depends on ASKING for `strict`, and
     * that is the half a test can pin here; the truncation itself is pinned
     * against the wire in `issues.test.ts`.
     */
    strict?: boolean;
  }>;
  /** Every `actionRuns` call, in order. */
  readonly actionRunsCalls: Array<{
    repos?: readonly string[];
    createdWithinHours?: number;
    status?: string;
    conclusion?: string;
  }>;
  /** Every `pullRequestHistory` call, in order. */
  readonly pullRequestHistoryCalls: Array<{
    repo: string;
    headBranchPrefix?: string;
    state: "open" | "closed" | "all";
    updatedWithinDays?: number;
    maxPages?: number;
  }>;
  /** Every `readTextFile` call, in order. */
  readonly readTextFileCalls: ReadTextFileRequest[];
  /** Every `pullReview` call, in order — lets a test assert a comment posted. */
  readonly pullReviewCalls: PullReviewRequest[];
  /** Every `openDraftPullRequest` call, in order. */
  readonly openDraftPullRequestCalls: OpenDraftPullRequest[];
  /** Every `closeDraftPullRequest` call, in order. */
  readonly closeDraftPullRequestCalls: CloseDraftPullRequest[];
  /**
   * Every `openIssue` call, in order — and each one also lands in `issues`.
   *
   * That second half is the point. A run whose whole job is "do not file what I
   * already filed" can only be tested if a filed issue is visible to the next
   * read, so the fake appends it rather than merely recording the call. Without
   * that, every test would pass against a run that dedups against nothing.
   */
  readonly openIssueCalls: Array<{
    repo: string;
    title: string;
    body: string;
    labels?: readonly string[];
  }>;
  /** Every `createRelease` call, in order — lets a test assert a release published. */
  readonly createReleaseCalls: CreateRelease[];
  readonly publishReleaseCalls: Array<{ repo: string; releaseId: number }>;
  readonly publishContainerImageCalls: Array<{ repo: string; profile: string; version: string }>;
  readonly releases: Record<string, ReleaseResult>;
  readonly tagCommits: Record<string, string>;
  /** Every label ADD, in order. */
  readonly addIssueLabelsCalls: Array<{ repo: string; issue: number; labels: readonly string[] }>;
  /** Every label REMOVE, in order. */
  readonly removeIssueLabelCalls: Array<{ repo: string; issue: number; label: string }>;
  /** Every issue comment, in order — body included, so a test can assert the template. */
  readonly commentOnIssueCalls: Array<{ repo: string; issue: number; body: string }>;
  /**
   * Every close, in order. The only close there is, and it carries the link —
   * so `closeIssueAsDuplicateCalls` being empty IS the assertion that nothing
   * was closed, with no second close path to check.
   */
  readonly closeIssueAsDuplicateCalls: Array<{ repo: string; issue: number; duplicateOf: number }>;
  /**
   * Every `closeBotIssue` call, in order — refused ones included. A call closes
   * the seeded issue only when it is open, its author ends in `[bot]`, and it
   * carries the label, mirroring the live read-then-close.
   */
  readonly closeBotIssueCalls: CloseBotIssue[];
};

/** Default reference clock — fakes use this when callers don't override. */
const NOW_DEFAULT = 1_700_000_000_000;

/**
 * Page size the live PR-history read requests (GitHub's maximum), and its hard
 * page cap — `listPullRequests`'s `PAGE_SIZE_DEFAULT` / `MAX_PAGES_DEFAULT`.
 *
 * The page size is seedable (`historyPageSize`) purely so `maxPages` is
 * assertable: at the real 100-per-page, no plausible test seeds enough rows for
 * the cap to bite, and a cap that no test can reach is a cap nothing pins.
 */
const HISTORY_PAGE_SIZE_DEFAULT = 100;
const HISTORY_MAX_PAGES_DEFAULT = 5;

export const makeGithubFake = (
  opts: {
    issues?: readonly IssueRef[];
    workflowRuns?: readonly WorkflowRunRef[];
    /** PR history (closed PRs included) — what `pullRequestHistory` returns. */
    pullRequestHistory?: readonly PullRequestHistoryRef[];
    /**
     * Repo files keyed `"owner/name:path"`, or `"owner/name@ref:path"` to pin a
     * ref; an unseeded path is `found: false`.
     */
    files?: Record<string, string>;
    /** Branch heads keyed `"owner/name:branch"`; an unseeded branch fails. */
    branchHeads?: Record<string, string>;
    /** Commit → PRs keyed `"owner/name:sha"`; an unseeded commit fails. */
    commitPullRequests?: Record<string, readonly CommitPullRequest[]>;
    /** Pull request keyed `"owner/name#number"`; an unseeded one fails. */
    pullRequests?: Record<string, CommitPullRequest>;
    /** Clock used to evaluate `pushedWithinDays` / `updatedWithinHours`. */
    now?: number;
    /**
     * Rows per page for `pullRequestHistory` — defaults to the live read's 100.
     * Lower it to make `maxPages` observable without seeding hundreds of PRs.
     */
    historyPageSize?: number;
    /** Login returned for the installation-token viewer in bot-owned issue tests. */
    botLogin?: string;
    /**
     * Head branches keyed `"owner/name#branch"` a human has pushed to — the
     * fake's stand-in for non-bot commits. `openDraftPullRequest` with
     * `preserveHumanCommits` reports `skipped: true` on them, and
     * `closeDraftPullRequest` leaves their PR open.
     */
    humanOwnedBranches?: readonly string[];
  } = {},
): { layer: Layer.Layer<Github>; state: GithubFakeState } => {
  const state: GithubFakeState = {
    issues: [...(opts.issues ?? [])],
    workflowRuns: [...(opts.workflowRuns ?? [])],
    pullRequestHistory: [...(opts.pullRequestHistory ?? [])],
    files: { ...opts.files },
    branchHeads: { ...opts.branchHeads },
    branchHeadCalls: [],
    commitPullRequests: { ...opts.commitPullRequests },
    commitPullRequestsCalls: [],
    pullRequests: { ...opts.pullRequests },
    pullRequestCalls: [],
    appendMeasureNoteCalls: [],
    issuesCalls: [],
    actionRunsCalls: [],
    pullRequestHistoryCalls: [],
    readTextFileCalls: [],
    pullReviewCalls: [],
    openDraftPullRequestCalls: [],
    closeDraftPullRequestCalls: [],
    openIssueCalls: [],
    createReleaseCalls: [],
    publishReleaseCalls: [],
    publishContainerImageCalls: [],
    releases: {},
    tagCommits: {},
    addIssueLabelsCalls: [],
    removeIssueLabelCalls: [],
    commentOnIssueCalls: [],
    closeIssueAsDuplicateCalls: [],
    closeBotIssueCalls: [],
  };
  const now = opts.now ?? NOW_DEFAULT;
  const pageSize = Math.max(1, opts.historyPageSize ?? HISTORY_PAGE_SIZE_DEFAULT);
  // Branches the fake has already "opened" a PR for — so a re-run with the same
  // headBranch reports `created: false`, mirroring the live idempotency.
  const openedBranches = new Set<string>();
  const humanOwned = new Set(opts.humanOwnedBranches ?? []);

  const service: GithubService = {
    issues: ({ repo, state: want = "open", labels, updatedWithinDays, maxPages, strict }) =>
      Effect.sync(() => {
        state.issuesCalls.push({ repo, state: want, labels, updatedWithinDays, maxPages, strict });
        const need = labels === undefined ? undefined : new Set(labels);
        return state.issues.filter((i) => {
          if (i.repo !== repo) return false;
          if (want !== "all" && i.state !== want) return false;
          if (need !== undefined && ![...need].every((l) => i.labels.includes(l))) return false;
          if (
            updatedWithinDays !== undefined &&
            i.updatedAt < now - updatedWithinDays * 86_400_000
          ) {
            return false;
          }
          return true;
        });
      }),

    openIssue: ({ repo, title, body, labels }) =>
      Effect.sync(() => {
        state.openIssueCalls.push({ repo, title, body, labels });
        // Numbered above every issue the fake knows about, in this repo or any
        // other, because GitHub's numbering is per repo but a test asserting on
        // `#3` should not have it mean two different issues.
        const number = state.issues.reduce((max, i) => Math.max(max, i.number), 0) + 1;
        const url = `https://github.com/${repo}/issues/${number}`;
        state.issues = [
          ...state.issues,
          {
            repo,
            number,
            title,
            body,
            state: "open" as const,
            labels: [...(labels ?? [])],
            author: "flare-dispatch[bot]",
            authorAssociation: "OWNER",
            url,
            commentCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        ];
        return { number, url };
      }),

    // The writes record and mutate the seeded issue, so a test can assert both
    // "the call was made" and "the state machine advanced".
    addIssueLabels: ({ repo, issue, labels }) =>
      Effect.sync(() => {
        state.addIssueLabelsCalls.push({ repo, issue, labels });
        const target = state.issues.find((i) => i.repo === repo && i.number === issue);
        if (target !== undefined) {
          const merged = [...new Set([...target.labels, ...labels])];
          state.issues = state.issues.map((i) => (i === target ? { ...i, labels: merged } : i));
        }
      }),

    removeIssueLabel: ({ repo, issue, label }) =>
      Effect.sync(() => {
        state.removeIssueLabelCalls.push({ repo, issue, label });
        state.issues = state.issues.map((i) =>
          i.repo === repo && i.number === issue
            ? { ...i, labels: i.labels.filter((l) => l !== label) }
            : i,
        );
      }),

    commentOnIssue: ({ repo, issue, body }) =>
      Effect.sync(() => {
        state.commentOnIssueCalls.push({ repo, issue, body });
      }),

    closeIssueAsDuplicate: ({ repo, issue, duplicateOf }) =>
      Effect.sync(() => {
        state.closeIssueAsDuplicateCalls.push({ repo, issue, duplicateOf });
        state.issues = state.issues.map((i) =>
          i.repo === repo && i.number === issue
            ? { ...i, state: "closed" as const, closedAt: now }
            : i,
        );
      }),

    closeBotIssue: (req): Effect.Effect<CloseBotIssueResult, never> =>
      Effect.sync(() => {
        state.closeBotIssueCalls.push(req);
        const number = req.issue;
        const target = state.issues.find((i) => i.repo === req.repo && i.number === number);
        if (target === undefined || target.state !== "open") {
          return { closed: false, reason: "not-open", number } as const;
        }
        if (!target.author.endsWith("[bot]")) {
          return { closed: false, reason: "human-owned", number } as const;
        }
        if (!target.labels.includes(req.label)) {
          return { closed: false, reason: "unlabelled", number } as const;
        }
        if (
          target.author.toLowerCase() !== (opts.botLogin ?? "flare-dispatch[bot]").toLowerCase()
        ) {
          return { closed: false, reason: "foreign-owned", number } as const;
        }
        state.commentOnIssueCalls.push({ repo: req.repo, issue: number, body: req.comment });
        state.issues = state.issues.map((i) =>
          i === target ? { ...i, state: "closed" as const, closedAt: now } : i,
        );
        return { closed: true, number } as const;
      }),

    actionRuns: ({ repos, createdWithinHours, status, conclusion } = {}) =>
      Effect.sync(() => {
        state.actionRunsCalls.push({
          repos,
          createdWithinHours,
          status,
          conclusion,
        });
        const allow = repos === undefined ? undefined : new Set(repos);
        return state.workflowRuns.filter((r) => {
          if (allow !== undefined && !allow.has(r.repo)) return false;
          if (status !== undefined && r.status !== status) return false;
          if (conclusion !== undefined && r.conclusion !== conclusion) return false;
          if (createdWithinHours !== undefined) {
            const cutoff = now - createdWithinHours * 3_600_000;
            if (r.createdAt < cutoff) return false;
          }
          return true;
        });
      }),

    pullRequestHistory: ({
      repo,
      headBranchPrefix,
      state: prState = "all",
      updatedWithinDays,
      maxPages,
    }) =>
      Effect.sync(() => {
        state.pullRequestHistoryCalls.push({
          repo,
          headBranchPrefix,
          state: prState,
          updatedWithinDays,
          maxPages,
        });

        // Mirror the live read's server-side query — one repo, `state=` — and
        // its `sort=updated&direction=desc`. The order is the contract: it is
        // what makes `updatedWithinDays` a sound stopping rule rather than a
        // guess, so a fake returning seeded insertion order lets a caller that
        // depends on newest-first pass here and misbehave in production.
        const matching = state.pullRequestHistory
          .filter((pr) => pr.repo === repo && (prState === "all" || pr.state === prState))
          .sort((a, b) => b.updatedAt - a.updatedAt);

        const cutoff =
          updatedWithinDays === undefined ? undefined : now - updatedWithinDays * 86_400_000;

        // Walk pages the way the live read does, and stop where it stops: at the
        // page cap, on a short page, or once the oldest row collected predates
        // the cutoff. `updatedWithinDays` is a PAGINATION bound, not a filter —
        // live returns the out-of-window rows that share a page with in-window
        // ones, so the fake must too, or a caller that mishandles them is green
        // here and wrong in production.
        const collected: PullRequestHistoryRef[] = [];
        const pageCap = Math.max(1, maxPages ?? HISTORY_MAX_PAGES_DEFAULT);
        for (let page = 0; page < pageCap; page += 1) {
          const rows = matching.slice(page * pageSize, (page + 1) * pageSize);
          collected.push(...rows);
          if (rows.length < pageSize) break;
          const oldest = collected[collected.length - 1];
          if (cutoff !== undefined && oldest !== undefined && oldest.updatedAt < cutoff) break;
        }

        // GitHub's `head=` matches one exact branch, so the live read filters the
        // prefix client-side, after collection — it narrows what is returned,
        // never what is paginated.
        return headBranchPrefix === undefined || headBranchPrefix.length === 0
          ? collected
          : collected.filter((pr) => pr.headBranch.startsWith(headBranchPrefix));
      }),

    readTextFile: (req): Effect.Effect<TextFileResult, never> =>
      Effect.sync(() => {
        state.readTextFileCalls.push(req);
        // `ref` is part of the live read's identity — it goes into the URL — so a
        // fake that ignored it would answer every ref with the same bytes and
        // leave `ledgerRef` untested at any level. A ref-qualified key wins when
        // seeded; the bare key is the "any ref" fallback most tests want.
        const content =
          (req.ref === undefined ? undefined : state.files[`${req.repo}@${req.ref}:${req.path}`]) ??
          state.files[`${req.repo}:${req.path}`];
        return content === undefined ? { found: false } : { found: true, content };
      }),

    branchHead: ({ repo, branch }): Effect.Effect<string, GitHubApiError> =>
      Effect.suspend(() => {
        state.branchHeadCalls.push({ repo, branch });
        const sha = state.branchHeads[`${repo}:${branch}`];
        return sha === undefined
          ? Effect.fail(new GitHubApiError({ status: 404, reason: "other" }))
          : Effect.succeed(sha);
      }),

    commitPullRequests: ({ repo, sha }): Effect.Effect<readonly CommitPullRequest[], GitHubApiError> =>
      Effect.suspend(() => {
        state.commitPullRequestsCalls.push({ repo, sha });
        const prs = state.commitPullRequests[`${repo}:${sha}`];
        return prs === undefined
          ? Effect.fail(new GitHubApiError({ status: 404, reason: "other" }))
          : Effect.succeed(prs);
      }),

    pullRequest: ({ repo, number }): Effect.Effect<CommitPullRequest, GitHubApiError> =>
      Effect.suspend(() => {
        state.pullRequestCalls.push({ repo, number });
        const pr = state.pullRequests[`${repo}#${number}`];
        return pr === undefined
          ? Effect.fail(new GitHubApiError({ status: 404, reason: "other" }))
          : Effect.succeed(pr);
      }),

    appendMeasureNote: ({ repo, commit, text }) =>
      Effect.sync(() => {
        state.appendMeasureNoteCalls.push({ repo, commit, text });
      }),

    pullReview: (req) =>
      Effect.sync(() => {
        state.pullReviewCalls.push(req);
      }),

    openDraftPullRequest: (req): Effect.Effect<DraftPullRequestResult, never> =>
      Effect.sync(() => {
        state.openDraftPullRequestCalls.push(req);
        const key = `${req.repo}#${req.headBranch}`;
        if (req.preserveHumanCommits === true && humanOwned.has(key)) {
          return { number: 0, url: "", created: false, skipped: true };
        }
        const created = !openedBranches.has(key);
        openedBranches.add(key);
        // Deterministic fake PR number derived from call order.
        const number = state.openDraftPullRequestCalls.length;
        return {
          number,
          url: `https://github.com/${req.repo}/pull/${number}`,
          created,
          skipped: false,
        };
      }),

    closeDraftPullRequest: (req): Effect.Effect<CloseDraftPullRequestResult, never> =>
      Effect.sync((): CloseDraftPullRequestResult => {
        state.closeDraftPullRequestCalls.push(req);
        const key = `${req.repo}#${req.headBranch}`;
        if (!openedBranches.has(key)) return { closed: false, reason: "none-open" };
        if (humanOwned.has(key)) return { closed: false, reason: "human-owned" };
        openedBranches.delete(key);
        return { closed: true, number: 0 };
      }),

    createRelease: (req): Effect.Effect<ReleaseResult, never> =>
      Effect.sync(() => {
        state.createReleaseCalls.push(req);
        // Deterministic fake release id derived from call order.
        const id = state.createReleaseCalls.length;
        const release = {
          id,
          url: `https://github.com/${req.repo}/releases/tag/${req.tag}`,
          tag: req.tag,
          published: !req.draft,
          draft: req.draft ?? false,
        };
        state.releases[`${req.repo}:${req.tag}`] = release;
        return release;
      }),
    tagCommit: (req) => Effect.sync(() => state.tagCommits[`${req.repo}:${req.tag}`] ?? ""),
    tagTarget: (req) => Effect.sync(() => ({ refSha: state.tagCommits[`${req.repo}:${req.tag}`] ?? "", commitSha: state.tagCommits[`${req.repo}:${req.tag}`] ?? "" })),
    commitOnDefaultBranch: () => Effect.succeed(true),
    releaseByTag: (req) => Effect.sync(() => state.releases[`${req.repo}:${req.tag}`]),
    publishRelease: (req) => Effect.sync(() => {
      state.publishReleaseCalls.push(req);
      const release = Object.values(state.releases).find((entry) => entry.id === req.releaseId);
      if (release === undefined) throw new Error("release not found");
      const published = { ...release, published: true, draft: false };
      state.releases[`${req.repo}:${release.tag}`] = published;
      return published;
    }),
    publishReleaseAsset: (req): Effect.Effect<ReleaseAssetResult, never> =>
      Effect.succeed({
        id: req.releaseId,
        name: req.artifactName,
        size: 0,
        downloadUrl: `https://github.com/${req.repo}/releases/download/${req.releaseId}/${req.artifactName}`,
      }),
    publishContainerImage: (req) => Effect.sync(() => {
      state.publishContainerImageCalls.push({ repo: req.repo, profile: req.profile, version: req.version });
    }),
  };

  return { layer: Layer.succeed(Github, service), state };
};

/** A ready-to-use Github fake Layer — empty repos + PRs. */
export const GithubFake: Layer.Layer<Github> = makeGithubFake().layer;
