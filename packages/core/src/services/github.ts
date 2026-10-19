// @fractalboxdev/flare-dispatch-core — the `github` capability (read-only GitHub access).
//
// The symmetric *read* surface to the `Checks` capability's write side
// (check-runs callback). Scoped to the installations of the FlareDispatch
// GitHub App; runs never see a token — the live Layer mints, caches, and
// scopes them via the same installation-token machinery the Checks Layer
// uses (`@fractalboxdev/flare-dispatch-github-app`).
//
// Deliberately read-only and narrow: a run produces `findings` and an
// output, and the Dispatcher renders the check-run. The capability exists
// so a run can *discover what to act on* (Schedule-mode enumeration:
// "every open PR across every installed repo"), not so it can act on GitHub
// directly.
//
// Spec: specs/03-dsl.md § github, specs/04-gha-integration.md § Schedule mode.

import { Context, Effect } from "effect";
import type { GitHubApiError } from "../errors";

/**
 * One issue — the unit of work for the triage desk's issue half (§5).
 *
 * `title` and `body` are prose a stranger wrote on a public repo. They are
 * **data everywhere downstream**: fenced before they reach a model, never
 * interpolated into an instruction, and never rendered into a comment. The
 * three fields that decide anything are `labels` (the state machine), `number`,
 * and `authorAssociation`.
 */
export type IssueRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly number: number;
  /** UNTRUSTED. */
  readonly title: string;
  /** UNTRUSTED, and possibly empty. */
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly author: string;
  /**
   * The author's standing in the repo, as GitHub reports it. §5 requires this
   * to travel with a captured repro: "whoever wires the dispatch must be able
   * to tell a repo member from a first-time external reporter", and by the time
   * a human reads the digest the association is the only thing that answers it.
   */
  readonly authorAssociation: string;
  readonly url: string;
  readonly commentCount: number;
  /** epoch ms. */
  readonly createdAt: number;
  /** epoch ms. */
  readonly updatedAt: number;
  /**
   * epoch ms when the issue was closed, or `undefined` while it is open.
   *
   * `updatedAt` cannot stand in: any touch resets it, so a window dated from it
   * never expires. This is the column the org store's `pulls` table lacks and
   * `issues` has — the whole reason an issue-shaped ledger needs no workaround
   * where a PR-shaped one needed a file in git.
   */
  readonly closedAt?: number;
};

/** The outcome of {@link GithubService.openIssue}. */
export type IssueCreated = {
  readonly number: number;
  /**
   * The issue's web URL. Never empty: a caller announces the issue by linking
   * it, so a create that came back without one fails rather than publishing a
   * link to nowhere.
   */
  readonly url: string;
};

/**
 * A GitHub Actions workflow run — the unit of work for `ci-triage`. The read
 * surface a Schedule-mode run enumerates to find recently-failed CI across the
 * repos the App is installed on.
 */
export type WorkflowRunRef = {
  /** "owner/name". */
  readonly repo: string;
  /** The workflow run id (`GET /repos/{o}/{r}/actions/runs/{id}`). */
  readonly id: number;
  /** The workflow file's display name (e.g. "CI/CD"). */
  readonly name: string;
  /** The head branch the run executed on. */
  readonly headBranch: string;
  /** The head SHA the run executed against. */
  readonly headSha: string;
  /** GitHub run status — `completed` for a finished run. */
  readonly status: string;
  /** The conclusion — `failure` / `timed_out` / `cancelled` / `success` / … */
  readonly conclusion: string;
  /** The run's web URL (the failing-run link a triage write-up points at). */
  readonly url: string;
  /** epoch ms — when the run was created. */
  readonly createdAt: number;
};

/**
 * A request to open (or update) a **draft pull request** carrying a set of
 * file edits — the one *content write* on the `github` capability, added for
 * the `spec-drift` / `ci-triage` recipes. The live Layer commits the files via
 * the GitHub Git Data API (blob → tree → commit → ref) from the Worker — no
 * container `git push` — then opens a draft PR. Idempotent on `headBranch`:
 * re-running updates the branch and reuses the already-open PR.
 *
 * Like `pullReview`, this is a deliberate, narrow exception to the capability's
 * read-only stance — a recipe whose entire purpose is "detect X, propose a fix
 * as a PR" needs exactly this and nothing more (it never force-merges, never
 * touches protected refs).
 */
export type OpenDraftPullRequest = {
  /** "owner/name". */
  readonly repo: string;
  /**
   * The base branch to open the PR against and branch the commit from.
   * Defaults to the repo's default branch when omitted.
   */
  readonly baseBranch?: string;
  /** The head branch to create/update (e.g. `flare-dispatch/spec-drift`). */
  readonly headBranch: string;
  /** PR title. */
  readonly title: string;
  /** PR body (markdown). */
  readonly body: string;
  /** The commit message for the file edits. */
  readonly commitMessage: string;
  /** The files to write — full new contents, keyed by repo-relative path. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /**
   * Open the PR as a draft. Defaults to `true` (the spec-drift / ci-triage
   * recipes want a draft a human promotes). The `release-notes` recipe opens a
   * NON-draft PR (`draft: false`) so "merge to approve" is a one-click action.
   */
  readonly draft?: boolean;
  /**
   * Leave the head branch untouched when it carries any commit a bot account
   * did not author — a rolling PR's reviewer pushed to it, and a force-update
   * would discard that work. The result reports `skipped: true`. Default
   * `false`.
   */
  readonly preserveHumanCommits?: boolean;
  /**
   * The GitHub installation id authenticating the writes. Optional — the live
   * Layer resolves it from the repo when absent (the App is the source of truth
   * for which installation covers a repo).
   */
  readonly installationId?: number;
};

/** The outcome of {@link GithubService.openDraftPullRequest}. */
export type DraftPullRequestResult = {
  /** The PR number (existing or newly opened). */
  readonly number: number;
  /** The PR's web URL. */
  readonly url: string;
  /** `true` when this call opened a new PR; `false` when it updated an open one. */
  readonly created: boolean;
  /** `true` when `preserveHumanCommits` left a human-touched branch untouched. */
  readonly skipped: boolean;
};

/**
 * A request to retract a rolling proposal PR — close the open PR on
 * `headBranch` after posting `comment`. The live Layer closes only a PR a bot
 * account opened whose commits are all bot-authored; anything a human opened
 * or pushed to stays open.
 */
export type CloseDraftPullRequest = {
  /** "owner/name". */
  readonly repo: string;
  readonly headBranch: string;
  /** Posted on the PR before it closes — a rendered template, never model prose. */
  readonly comment: string;
  readonly installationId?: number;
};

/**
 * A request to close a ledger issue the loop itself filed, once the condition it
 * reports clears. The live Layer reads the issue and closes it as `completed`
 * only when it is open, this installation's bot opened it, and it carries
 * `label`; it posts `comment` first. Anything else stays open.
 */
export type CloseBotIssue = {
  /** "owner/name". */
  readonly repo: string;
  readonly issue: number;
  /** The ledger label the issue must carry. */
  readonly label: string;
  /** Posted before the close — a rendered template, never model prose. */
  readonly comment: string;
  readonly installationId?: number;
};

/** The outcome of {@link GithubService.closeBotIssue}. */
export type CloseBotIssueResult =
  | { readonly closed: true; readonly number: number }
  | {
      readonly closed: false;
      /** `not-open`, `human-owned`, `foreign-owned`, `unlabelled`: left as found. `uncredentialed`: no App. */
      readonly reason:
        | "not-open"
        | "human-owned"
        | "foreign-owned"
        | "unlabelled"
        | "uncredentialed";
      readonly number: number;
    };

/** The outcome of {@link GithubService.closeDraftPullRequest}. */
export type CloseDraftPullRequestResult =
  | { readonly closed: true; readonly number: number }
  | {
      readonly closed: false;
      /** `none-open`: nothing to close. `human-owned`: left open on purpose. `uncredentialed`: no App. */
      readonly reason: "none-open" | "human-owned" | "uncredentialed";
      readonly number?: number;
    };

/**
 * A request to publish a **GitHub Release** — the narrow *release write* the
 * `release-notes` recipe uses on approval. Like `openDraftPullRequest` and
 * `pullReview`, this is a deliberate, bounded exception to the capability's
 * read-only stance: a run that drafts release notes and waits for a human gate
 * needs exactly "publish this tag with this body" and nothing more.
 *
 * The live Layer creates the release via `POST /repos/{o}/{r}/releases`, which
 * also creates the git tag at `target` when it does not exist — no separate
 * container `git push --tags`. A deploy without App credentials degrades to a
 * logged no-op (`published: false`), mirroring the other writes.
 */
export type CreateRelease = {
  /** "owner/name". */
  readonly repo: string;
  /** The tag to create/point the release at (e.g. `v0.1.0`). */
  readonly tag: string;
  /**
   * The commit sha (or branch) the tag is created at when it does not already
   * exist — pin it to the drafted HEAD sha for a reproducible tag. Defaults to
   * the repo's default-branch tip when omitted.
   */
  readonly target?: string;
  /** The release title — defaults to `tag`. */
  readonly name?: string;
  /** The release body (markdown). */
  readonly body: string;
  /** Publish as a pre-release. Default `false`. */
  readonly prerelease?: boolean;
  /** Keep the release unpublished while child artifacts are uploaded. */
  readonly draft?: boolean;
  /**
   * The GitHub installation id authenticating the write. Optional — the live
   * Layer resolves it from the repo when absent.
   */
  readonly installationId?: number;
};

/** The outcome of {@link GithubService.createRelease}. */
export type ReleaseResult = {
  /** The release's numeric id (`0` when degraded to a no-op). */
  readonly id: number;
  /** The release's web URL (`""` when degraded to a no-op). */
  readonly url: string;
  /** The tag the release points at. */
  readonly tag: string;
  /** `true` when a release was actually published; `false` on a no-op deploy. */
  readonly published: boolean;
  readonly draft?: boolean;
};

export type ReleaseLookup = {
  readonly repo: string;
  readonly tag: string;
  readonly installationId?: number;
};

export type TagTarget = { readonly refSha: string; readonly commitSha: string };

export type PublishRelease = {
  readonly repo: string;
  readonly releaseId: number;
  /** Release notes replacing the draft's body as it publishes. */
  readonly body?: string;
  readonly installationId?: number;
};

/** A completed artifact in the execution's R2 namespace. */
export type PublishReleaseAsset = {
  readonly repo: string;
  readonly releaseId: number;
  readonly artifactName: string;
  readonly contentType: string;
  readonly sha256?: string;
  readonly installationId?: number;
};

export type ReleaseAssetResult = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
};

export type PublishContainerImage = {
  readonly repo: string;
  readonly profile: string;
  readonly version: string;
  readonly sourceExecutionId: string;
  readonly layerArtifactName: string;
  readonly layerSize: number;
  readonly layerDigest: string;
  readonly diffId: string;
};

/**
 * A request to read **one text file** out of a repo — `readTextFile`.
 *
 * Narrow on purpose: this is not a filesystem, and it never becomes one. The
 * maintenance loop's suppression ledger lives in git in a private repo, and a
 * run that has to clone a repo to read one line on every cron tick pays a
 * container for a string. Everything wider already has a home — a run that
 * needs a working tree clones one (`workspace`), and writes go through
 * `openDraftPullRequest`.
 */
export type ReadTextFileRequest = {
  /** "owner/name". */
  readonly repo: string;
  /** Repo-relative path (e.g. `maintenance/declined.jsonl`). */
  readonly path: string;
  /** Branch, tag, or sha. Defaults to the repo's default branch. */
  readonly ref?: string;
  /**
   * The GitHub installation id authenticating the read. Optional — the live
   * Layer resolves it from the repo when absent, which is what a cron tick
   * (carrying no webhook payload) always needs.
   */
  readonly installationId?: number;
};

/**
 * The outcome of {@link GithubService.readTextFile}.
 *
 * Absent is a **value**, not a failure: a ledger nobody has written yet is
 * `{ found: false }`, and a caller must be able to tell that apart from "GitHub
 * returned 500" (a `GitHubApiError`) because the two demand opposite behavior.
 * A path that exists but is not a file (a directory) reads as `found: false`
 * too — it is not the text file that was asked for.
 */
export type TextFileResult =
  | { readonly found: true; readonly content: string }
  | { readonly found: false };

/**
 * A pull request as {@link GithubService.pullRequestHistory} returns it —
 * **including closed ones**, and carrying the two timestamps that date a
 * decision.
 *
 * This is now the ONLY pull-request shape on the service. It used to sit beside
 * a `PullRequestRef` carrying head/base shas for an installation-wide open-PR
 * sweep; that type and its two enumeration methods are gone (see the note on
 * {@link GithubService}), so history answers both questions: "what is in
 * flight" via `state: "open"`, and "was this proposed before, and what happened
 * to it" via `body` (where a proposal's `maintenance-key` lines live) and
 * `closedAt`.
 */
export type PullRequestHistoryRef = {
  /** "owner/name". */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** The PR body — a proposal's machine-readable lines ride here. */
  readonly body: string;
  /** The head branch name (no `owner:` prefix). */
  readonly headBranch: string;
  /** The head commit sha — what a CI run is matched against. */
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  /**
   * Label names on the PR — the `triage:*` state machine's storage. GitHub's
   * list endpoint returns these; the org context store's `pulls` table does
   * not, which is why triage routing reads the API rather than the store.
   */
  readonly labels: readonly string[];
  /** The login that opened it — `""` when GitHub returned no user. */
  readonly author: string;
  /** Reviewers requested but not yet responded — empty means nobody is on it. */
  readonly requestedReviewers: readonly string[];
  /** The PR's web URL. */
  readonly url: string;
  /** epoch ms. */
  readonly createdAt: number;
  /** epoch ms — resets on ANY touch; never date a cooldown from this. */
  readonly updatedAt: number;
  /** epoch ms — `undefined` while open. The one field that dates a decision. */
  readonly closedAt?: number;
  /** epoch ms — `undefined` unless merged. Closed-and-merged ≠ closed-unmerged. */
  readonly mergedAt?: number;
};

/**
 * A top-level PR review to post — `POST /repos/{o}/{r}/pulls/{n}/reviews`.
 * `event: "COMMENT"` leaves a visible review comment without approving or
 * requesting changes (the run's *verdict* is reported separately via the
 * check-run). This is the one *write* on the `github` capability — it exists so
 * a run can leave an always-visible PR comment (on success AND failure), which
 * the read-only check-run summary alone does not guarantee.
 */
/**
 * One pull request GitHub associates with a commit — what a gate reads to
 * learn whether the PR it gates is still open and still at that commit.
 */
export type CommitPullRequest = {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  /** The PR's current head commit. */
  readonly headSha: string;
  /** `owner/name` of the head repository; `""` when unknown. */
  readonly headRepo: string;
};

export type PullReviewRequest = {
  /** "owner/name". */
  readonly repo: string;
  /** PR number. */
  readonly pr: number;
  /** Head SHA the review is anchored to. */
  readonly sha: string;
  /** Markdown body of the review comment. */
  readonly body: string;
  /**
   * The GitHub installation id authenticating the write. A run carries it as an
   * input (the webhook payload's `installation.id`); the live Layer mints the
   * installation token from it. Omitted in local dev → the no-op Layer.
   */
  readonly installationId?: number;
};

/**
 * The service contract a runtime Layer implements.
 *
 * --- Two methods that used to be here, and why they are not -------------------
 *
 * `repositories()` and `openPullRequests()` both enumerated **installation-wide**
 * — every repo the App can see — and both were `Effect.die` in the LIVE Layer
 * while type-checking clean everywhere. A stub that dies is correct in a
 * deferred/no-op Layer, where "this deploy has no such binding" is the honest
 * answer; in the live Layer it is a landmine that reviews clean and takes the
 * run down when something finally calls it.
 *
 * Deleted rather than implemented, on two grounds. Nothing called them: the only
 * intended consumer, the triage desk, uses `pullRequestHistory({ state: "open" })`
 * instead, which is per-repo and matches "listing is the attestation". And
 * installation-wide enumeration is the wrong shape for this estate — the loop's
 * §9 forbids writes into client repos, so a surface whose natural output is
 * "every repo the App can see" hands every caller a list it must then remember
 * to filter. A per-repo call over a configured estate cannot make that mistake.
 */
export interface GithubService {
  /**
   * Recent GitHub Actions workflow runs across the App's installations — the
   * enumeration surface `ci-triage` scans for failures. `status` defaults to
   * `completed`; pass `conclusion: "failure"` to narrow to failed runs.
   * Paginates internally and backs off on secondary rate limits.
   */
  readonly actionRuns: (opts?: {
    /** Restrict to these repos (else every installed repo). */
    repos?: readonly string[];
    /** Only runs created within this window. */
    createdWithinHours?: number;
    /** GitHub run status filter — defaults to `completed`. */
    status?: string;
    /** Only runs with this conclusion (e.g. `failure`). */
    conclusion?: string;
  }) => Effect.Effect<readonly WorkflowRunRef[], GitHubApiError>;

  /**
   * A repo's PRs, **closed ones included**, newest-touched first — the read a
   * caller needs to ask "was this proposed before, and did a human close it
   * unmerged, and when". `openPullRequests` cannot answer it and must not
   * pretend to; this is the separate question. Paginates internally (bounded by
   * `updatedSince` and a page cap) and backs off on secondary rate limits.
   *
   * `headBranchPrefix` filters on the head branch — dated proposal branches
   * (`flare-dispatch/spec-audit-questions-2026-08-08`) share a prefix and
   * nothing else, and GitHub's own `head=` parameter matches one exact branch.
   */
  readonly pullRequestHistory: (opts: {
    /** "owner/name" — one repo; history is asked about a known place. */
    repo: string;
    /** Keep only PRs whose head branch starts with this. */
    headBranchPrefix?: string;
    /** `open` | `closed` | `all` — defaults to `all`. */
    state?: "open" | "closed" | "all";
    /**
     * Stop paginating past PRs last updated before this many days ago. A
     * pagination bound only — `updatedAt >= closedAt` always, so nothing closed
     * inside the window is missed, and every date the caller reasons about
     * still comes from `closedAt`.
     */
    updatedWithinDays?: number;
    /** Hard page cap (100 per page). */
    maxPages?: number;
    /** Installation authenticating the read; resolved from the repo when absent. */
    installationId?: number;
  }) => Effect.Effect<readonly PullRequestHistoryRef[], GitHubApiError>;

  /**
   * Read one text file from a repo at an optional ref. `{ found: false }` for a
   * path that is not there — the answer a not-yet-written ledger gives, which a
   * caller must be able to tell apart from an API failure.
   */
  readonly readTextFile: (
    req: ReadTextFileRequest,
  ) => Effect.Effect<TextFileResult, GitHubApiError>;

  /**
   * A branch's current head commit SHA — the read `worker-deploy` uses to tell
   * whether the commit it is about to deploy is still the tip. Fails on a
   * missing branch, an unreadable ref, and an uncredentialed deploy alike: no
   * answer here can stand in for a SHA, so the caller decides what "unknown"
   * means rather than comparing against a placeholder.
   */
  readonly branchHead: (req: {
    repo: string;
    /** Branch name without `refs/heads/`. */
    branch: string;
    installationId?: number;
  }) => Effect.Effect<string, GitHubApiError>;

  /**
   * The pull requests associated with a commit (`commits/{sha}/pulls`). Fails
   * on any unreadable answer and on an uncredentialed deploy: an empty list is
   * a real answer here, so no degraded read may stand in for it.
   */
  readonly commitPullRequests: (req: {
    repo: string;
    sha: string;
    installationId?: number;
  }) => Effect.Effect<readonly CommitPullRequest[], GitHubApiError>;

  /**
   * One pull request's state and current head (`pulls/{number}`). Fails on
   * any unreadable answer and on an uncredentialed deploy.
   */
  readonly pullRequest: (req: {
    repo: string;
    number: number;
    installationId?: number;
  }) => Effect.Effect<CommitPullRequest, GitHubApiError>;

  /** Append one JSON report to a commit's refs/notes/measures note. */
  readonly appendMeasureNote: (req: {
    repo: string;
    commit: string;
    text: string;
    installationId?: number;
  }) => Effect.Effect<void, GitHubApiError>;

  /**
   * Post a top-level PR review comment (`event: "COMMENT"`). The run uses this
   * to leave an always-visible comment on every review — success or failure.
   * Best-effort reporting: a live deploy without App credentials degrades to a
   * logged no-op rather than failing the run.
   */
  /**
   * Open (or closed, or all) issues in ONE repo, carrying their labels and the
   * author's standing. Pull requests are filtered out — `GET /issues` returns
   * them too, and a triage pass that labelled pull requests as bugs would be
   * the first thing anyone noticed.
   *
   * Per-repo, never installation-wide: the caller names the estate, so a client
   * repo cannot arrive in the result set by accident (§9).
   *
   * FAILS rather than degrades on an uncredentialed deploy — an empty issue list
   * reading as "nothing to triage" is a lie a scheduled run would act on.
   */
  readonly issues: (opts: {
    repo: string;
    state?: "open" | "closed" | "all";
    labels?: readonly string[];
    updatedWithinDays?: number;
    maxPages?: number;
    /**
     * Fail rather than return a list the page ceiling cut short.
     *
     * A triage pass wants the default: the 500 most recently updated issues are
     * the tick's work and a longer backlog waits. A **deduplication** read
     * cannot — it asks "have I filed this already?", and a truncated list says
     * "no" for every issue it did not reach, so the caller duplicates whatever
     * fell off the end. Set it wherever an absent row is read as a fact.
     */
    strict?: boolean;
    installationId?: number;
  }) => Effect.Effect<readonly IssueRef[], GitHubApiError>;

  /**
   * Open one issue — the write the spec-audit sweep files an open question with.
   *
   * **Fails rather than degrading to a logged no-op**, which is the opposite of
   * `openDraftPullRequest` below, and the difference is what the artifact is. A
   * PR write that no-ops loses nothing: the branch is idempotent and the content
   * is a file that still exists in the commit the next tick will re-derive. Here
   * the issue *is* the question — there is no file, no branch, and no second
   * copy — so a silent no-op drops it, and the loop then has no record that it
   * ever had something to ask.
   *
   * Narrow on purpose: a title, a body, and labels. No assignee, no milestone,
   * no template. What bounds it is the caller — the sweep files into one control
   * repo resolved from config, and never files a question it did not first fail
   * to find among that repo's existing issues.
   */
  readonly openIssue: (req: {
    repo: string;
    title: string;
    body: string;
    labels?: readonly string[];
    installationId?: number;
  }) => Effect.Effect<IssueCreated, GitHubApiError>;

  /** Add labels to an issue — the state machine's write (§5). */
  readonly addIssueLabels: (req: {
    repo: string;
    issue: number;
    labels: readonly string[];
    installationId?: number;
  }) => Effect.Effect<void, GitHubApiError>;

  /** Remove one label. Already-absent is the requested end state, not an error. */
  readonly removeIssueLabel: (req: {
    repo: string;
    issue: number;
    label: string;
    installationId?: number;
  }) => Effect.Effect<void, GitHubApiError>;

  /**
   * Comment on an issue. Callers pass a rendered TEMPLATE — no model-authored
   * prose reaches a comment, because a comment is the loop speaking in its own
   * name and a model cannot be held to what it says.
   */
  readonly commentOnIssue: (req: {
    repo: string;
    issue: number;
    body: string;
    installationId?: number;
  }) => Effect.Effect<void, GitHubApiError>;

  /**
   * Close an issue **as a duplicate of `duplicateOf`** — the only close of a
   * reporter's issue on this service, and deliberately not spellable as a bare
   * "close". `closeBotIssue` closes only the loop's own ledger issues.
   *
   * §5 authorizes closing for exactly one verdict. Requiring the link in the
   * signature makes closing-on-another-verdict unrepresentable rather than
   * merely forbidden: there is no call to review, because there is no call to
   * write. GitHub records `state_reason: "duplicate"`, so the claim survives in
   * the timeline rather than only in a comment.
   */
  readonly closeIssueAsDuplicate: (req: {
    repo: string;
    issue: number;
    duplicateOf: number;
    installationId?: number;
  }) => Effect.Effect<void, GitHubApiError>;

  /**
   * Close a bot-opened ledger issue **as completed** — the one other close.
   *
   * It closes no reporter's issue: the live Layer reads the issue and refuses
   * (`closed: false`) unless a bot account opened it and it carries `label`, so
   * the verdict recorded is the loop's claim about its own artifact. Closing any
   * other issue, or on any other verdict, remains unspellable.
   */
  readonly closeBotIssue: (req: CloseBotIssue) => Effect.Effect<CloseBotIssueResult, GitHubApiError>;

  readonly pullReview: (req: PullReviewRequest) => Effect.Effect<void, GitHubApiError>;

  /**
   * Open (or update) a draft PR carrying a set of file edits — the content
   * write the `spec-drift` / `ci-triage` recipes use to propose a fix. Commits
   * via the Git Data API from the Worker; idempotent on `headBranch`. A deploy
   * without App credentials degrades to a logged no-op (`created: false`).
   */
  readonly openDraftPullRequest: (
    req: OpenDraftPullRequest,
  ) => Effect.Effect<DraftPullRequestResult, GitHubApiError>;

  /**
   * Close a rolling proposal PR a later run no longer stands behind — the
   * counterpart of `openDraftPullRequest` for a fire that finds nothing to
   * propose. Only a bot-opened, bot-only PR closes. A deploy without App
   * credentials degrades to a logged no-op (`reason: "uncredentialed"`).
   */
  readonly closeDraftPullRequest: (
    req: CloseDraftPullRequest,
  ) => Effect.Effect<CloseDraftPullRequestResult, GitHubApiError>;

  /**
   * Publish a GitHub Release (creating the tag at `target` when absent) — the
   * release write the `release-notes` recipe calls on human approval. A deploy
   * without App credentials degrades to a logged no-op (`published: false`).
   */
  readonly createRelease: (req: CreateRelease) => Effect.Effect<ReleaseResult, GitHubApiError>;
  readonly tagCommit: (req: ReleaseLookup) => Effect.Effect<string, GitHubApiError>;
  readonly tagTarget: (req: ReleaseLookup) => Effect.Effect<TagTarget, GitHubApiError>;
  readonly commitOnDefaultBranch: (req: { repo: string; commitSha: string; installationId?: number }) => Effect.Effect<boolean, GitHubApiError>;
  readonly releaseByTag: (req: ReleaseLookup) => Effect.Effect<ReleaseResult | undefined, GitHubApiError>;
  readonly publishRelease: (req: PublishRelease) => Effect.Effect<ReleaseResult, GitHubApiError>;
  /** Stream a completed R2 artifact to a GitHub Release with App credentials held in the Worker. */
  readonly publishReleaseAsset: (
    req: PublishReleaseAsset,
  ) => Effect.Effect<ReleaseAssetResult, GitHubApiError>;
  readonly publishContainerImage: (req: PublishContainerImage) => Effect.Effect<void, GitHubApiError>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Github extends Context.Tag("@fractalboxdev/flare-dispatch-core/Github")<
  Github,
  GithubService
>() {}

/**
 * The `github` accessor namespace. Each function reads the Github service
 * from context and delegates — so a run writes `github.issues({ repo })`
 * rather than `Effect.flatMap(Github, (g) => g.issues({ repo }))`.
 */
export const github = {
  actionRuns: (
    opts: {
      repos?: readonly string[];
      createdWithinHours?: number;
      status?: string;
      conclusion?: string;
    } = {},
  ) => Effect.flatMap(Github, (g) => g.actionRuns(opts)),
  pullRequestHistory: (opts: {
    repo: string;
    headBranchPrefix?: string;
    state?: "open" | "closed" | "all";
    updatedWithinDays?: number;
    maxPages?: number;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.pullRequestHistory(opts)),
  readTextFile: (req: ReadTextFileRequest) => Effect.flatMap(Github, (g) => g.readTextFile(req)),
  branchHead: (req: { repo: string; branch: string; installationId?: number }) =>
    Effect.flatMap(Github, (g) => g.branchHead(req)),
  commitPullRequests: (req: { repo: string; sha: string; installationId?: number }) =>
    Effect.flatMap(Github, (g) => g.commitPullRequests(req)),
  pullRequest: (req: { repo: string; number: number; installationId?: number }) =>
    Effect.flatMap(Github, (g) => g.pullRequest(req)),
  appendMeasureNote: (req: {
    repo: string;
    commit: string;
    text: string;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.appendMeasureNote(req)),
  issues: (opts: {
    repo: string;
    state?: "open" | "closed" | "all";
    labels?: readonly string[];
    updatedWithinDays?: number;
    maxPages?: number;
    strict?: boolean;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.issues(opts)),
  openIssue: (req: {
    repo: string;
    title: string;
    body: string;
    labels?: readonly string[];
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.openIssue(req)),
  addIssueLabels: (req: {
    repo: string;
    issue: number;
    labels: readonly string[];
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.addIssueLabels(req)),
  removeIssueLabel: (req: {
    repo: string;
    issue: number;
    label: string;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.removeIssueLabel(req)),
  commentOnIssue: (req: { repo: string; issue: number; body: string; installationId?: number }) =>
    Effect.flatMap(Github, (g) => g.commentOnIssue(req)),
  closeIssueAsDuplicate: (req: {
    repo: string;
    issue: number;
    duplicateOf: number;
    installationId?: number;
  }) => Effect.flatMap(Github, (g) => g.closeIssueAsDuplicate(req)),
  closeBotIssue: (req: CloseBotIssue) => Effect.flatMap(Github, (g) => g.closeBotIssue(req)),
  pullReview: (req: PullReviewRequest) => Effect.flatMap(Github, (g) => g.pullReview(req)),
  openDraftPullRequest: (req: OpenDraftPullRequest) =>
    Effect.flatMap(Github, (g) => g.openDraftPullRequest(req)),
  closeDraftPullRequest: (req: CloseDraftPullRequest) =>
    Effect.flatMap(Github, (g) => g.closeDraftPullRequest(req)),
  createRelease: (req: CreateRelease) => Effect.flatMap(Github, (g) => g.createRelease(req)),
  tagCommit: (req: ReleaseLookup) => Effect.flatMap(Github, (g) => g.tagCommit(req)),
  tagTarget: (req: ReleaseLookup) => Effect.flatMap(Github, (g) => g.tagTarget(req)),
  commitOnDefaultBranch: (req: { repo: string; commitSha: string; installationId?: number }) => Effect.flatMap(Github, (g) => g.commitOnDefaultBranch(req)),
  releaseByTag: (req: ReleaseLookup) => Effect.flatMap(Github, (g) => g.releaseByTag(req)),
  publishRelease: (req: PublishRelease) => Effect.flatMap(Github, (g) => g.publishRelease(req)),
  publishReleaseAsset: (req: PublishReleaseAsset) =>
    Effect.flatMap(Github, (g) => g.publishReleaseAsset(req)),
  publishContainerImage: (req: PublishContainerImage) =>
    Effect.flatMap(Github, (g) => g.publishContainerImage(req)),
} as const;
