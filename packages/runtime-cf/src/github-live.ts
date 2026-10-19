// @fractalboxdev/flare-dispatch-runtime-cf — GithubLive: the live `github` capability (write).
//
// Backs the one *write* on the `Github` Tag — `pullReview` — with the GitHub
// App PR-reviews API, via `@fractalboxdev/flare-dispatch-github-app`: an App JWT is exchanged
// for a short-lived installation token (cached in Worker memory), and that
// token authenticates `POST /repos/{o}/{r}/pulls/{n}/reviews`.
//
// There is no installation-wide *enumeration* surface. `repositories` and
// `openPullRequests` used to sit here as `Effect.die` stubs — correct in a
// deferred Layer, a landmine in a live one — and are now deleted rather than
// implemented: nothing called them, and a surface whose natural output is
// "every repo the App can see" hands every caller a list it must remember to
// filter. Every method is pointed at a **named** repo: `actionRuns`,
// `pullRequestHistory`, `readTextFile`, `issues`, and the writes.
//
// --- Graceful degradation ----------------------------------------------------
//
// A PR comment is *reporting*, never *correctness* — it must not fail an
// otherwise-green run. When App credentials are absent (local dev, no secrets)
// OR a request carries no installation id, `pullReview` is a logged no-op,
// exactly like the no-op `Checks` Layer. With credentials present, a genuine
// API failure is a typed `GitHubApiError` the run's error boundary handles
// (and still posts a fallback comment path where possible).
//
// Spec: specs/04-gha-integration.md § Check-runs callback (symmetric write).

import {
  appendGitNote,
  addIssueLabels,
  closeBotPullRequest,
  closeBotIssue,
  closeIssueAsDuplicate,
  createIssue,
  createIssueComment,
  createPullReview,
  createRelease,
  getReleaseByTag,
  publishRelease,
  resolveTagCommit,
  resolveTagTarget,
  commitOnDefaultBranch,
  uploadReleaseAsset,
  getInstallationToken,
  listActionRuns,
  listIssues,
  listPullRequests,
  openDraftPullRequest,
  readBranchHead,
  getPullRequest,
  listCommitPullRequests,
  readRepoTextFile,
  removeIssueLabel,
  resolveRepoInstallationId,
  GithubApiError as GithubAppApiError,
} from "@fractalboxdev/flare-dispatch-github-app";
import { Effect, Layer, Schedule } from "effect";
import {
  type CloseBotIssueResult,
  type CloseDraftPullRequestResult,
  type CommitPullRequest,
  type DraftPullRequestResult,
  Github,
  GitHubApiError,
  type GithubService,
  type IssueCreated,
  type IssueRef,
  type PullRequestHistoryRef,
  type ReleaseResult,
  type ReleaseAssetResult,
  type TextFileResult,
  type WorkflowRunRef,
} from "@fractalboxdev/flare-dispatch-core";
import { artifactKey } from "./artifact-r2";
import { pushGhcrImage } from "./ghcr-push";

/** The GitHub App credentials the live `pullReview` write needs. */
export type GithubLiveConfig = {
  /** `GITHUB_APP_ID`. */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM. */
  readonly privateKeyPem: string;
};

/**
 * Classify a GitHub failure into the typed `GitHubApiError.reason`. The
 * rate-limit signal — not the status alone — decides 403: GitHub returns **403
 * with a `Retry-After`** for *secondary* rate limits (the ones content-generating
 * POSTs like a PR review or check-run trip), so a 403 carrying a retry hint is
 * `rate-limited`, not `unauthorized` (which would send an operator hunting for a
 * bad PEM). A raw network throw surfaces as status 0 → `transient` (retryable).
 * Exported for unit tests.
 */
export const classifyReason = (
  status: number,
  retryAfterMs: number | undefined,
): GitHubApiError["reason"] =>
  status === 429 || (status === 403 && retryAfterMs !== undefined)
    ? "rate-limited"
    : status === 401 || status === 403
      ? "unauthorized"
      : status === 0 || status >= 500
        ? "transient"
        : "other";

/**
 * Bounded exponential backoff for the two retryable classes — a transient 5xx /
 * network blip, or a rate limit. Capped at 4 retries with jitter so a burst of
 * concurrent runs doesn't resynchronise onto GitHub. Non-retryable reasons
 * (`unauthorized`, `other`) stop immediately and surface to the run boundary.
 * `whileInput` reads the error's data field (`.reason`) — not a `._tag` — so it
 * is within the Effect convention for `Schedule` predicates.
 */
const githubRetry = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(4)),
  Schedule.whileInput(
    (e: GitHubApiError) => e.reason === "transient" || e.reason === "rate-limited",
  ),
);

/**
 * Run a github-app call as an Effect: map any throw to the typed
 * `GitHubApiError` and retry the two retryable classes with bounded backoff.
 * One chokepoint so every GitHub call gets the same error mapping + resilience,
 * instead of each site re-deriving `catch: toGitHubApiError`.
 */
const ghCall = <A>(thunk: () => Promise<A>): Effect.Effect<A, GitHubApiError> =>
  Effect.tryPromise({ try: thunk, catch: toGitHubApiError }).pipe(Effect.retry(githubRetry));

const logSkip = (repo: string, pr: number, why: string): Effect.Effect<void> =>
  Effect.logInfo(`github.pullReview skipped (${why}) — PR comment on ${repo}#${pr} not posted`);

/**
 * Build the live `Github` Layer. When `config` is `undefined` (no App secrets)
 * `pullReview` is a logged no-op for every request; the read surface always
 * dies (V3 work). With credentials, `pullReview` mints an installation token
 * from each request's `installationId` and posts the review.
 */
export const makeGithubLive = (
  config: GithubLiveConfig | undefined,
  artifactsBucket?: R2Bucket,
  executionId?: string,
  db?: D1Database,
  ghcr?: { readonly username: string; readonly token: string },
): Layer.Layer<Github> => {
  /**
   * Mint a fresh installation token for a repo. Prefers an explicit
   * `installationId`, else resolves the repo's installation from the App JWT
   * (the App is the source of truth for which installation covers a repo).
   * Only callable when `config` is present — both callers guard that first.
   */
  const mintToken = (
    cfg: GithubLiveConfig,
    repo: string,
    installationId?: number,
  ): Effect.Effect<string, GitHubApiError> =>
    Effect.gen(function* () {
      const resolvedInstallationId =
        installationId !== undefined && installationId > 0
          ? installationId
          : yield* ghCall(() =>
              resolveRepoInstallationId({
                appId: cfg.appId,
                privateKeyPem: cfg.privateKeyPem,
                repo,
              }),
            );
      return yield* ghCall(() =>
        getInstallationToken({
          appId: cfg.appId,
          privateKeyPem: cfg.privateKeyPem,
          installationId: resolvedInstallationId,
        }),
      );
    });

  /**
   * The uncredentialed answer for a READ: fail, never an empty list.
   *
   * An empty issue list is indistinguishable from "nothing to triage", and a
   * scheduled run would act on it — labelling nothing, closing nothing, and
   * reporting a clean estate. Same reasoning `pullRequestHistory` states.
   */
  const readNeedsCredentials = <A>(): Effect.Effect<A, GitHubApiError> =>
    Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" }));

  const service: GithubService = {
    actionRuns: ({ repos, createdWithinHours, status, conclusion } = {}) =>
      Effect.gen(function* () {
        if (config === undefined) {
          yield* Effect.logInfo("github.actionRuns skipped (no GitHub App credentials) — empty");
          return [];
        }
        if (repos === undefined || repos.length === 0) {
          // Enumerating every installed repo (listing installations) is V3 work;
          // the `ci-triage` recipe always passes its configured repo list.
          yield* Effect.logInfo(
            "github.actionRuns: no repos passed — pass a repo list (installation-wide enumeration is not yet wired)",
          );
          return [];
        }
        const cutoff =
          createdWithinHours !== undefined
            ? Date.now() - createdWithinHours * 3_600_000
            : undefined;

        const perRepo = yield* Effect.forEach(
          repos,
          (repo) =>
            Effect.gen(function* () {
              const token = yield* mintToken(config, repo);
              const runs = yield* ghCall(() =>
                listActionRuns({
                  token,
                  repo,
                  ...(status !== undefined ? { status } : {}),
                }),
              );
              return runs
                .filter(
                  (r) =>
                    (conclusion === undefined || r.conclusion === conclusion) &&
                    (cutoff === undefined || r.createdAt >= cutoff),
                )
                .map((r): WorkflowRunRef => ({
                  repo,
                  id: r.id,
                  name: r.name,
                  headBranch: r.headBranch,
                  headSha: r.headSha,
                  status: r.status,
                  conclusion: r.conclusion,
                  url: r.url,
                  createdAt: r.createdAt,
                }));
            }),
          { concurrency: 4 },
        );
        return perRepo.flat();
      }),

    pullRequestHistory: ({
      repo,
      headBranchPrefix,
      state,
      updatedWithinDays,
      maxPages,
      installationId,
    }): Effect.Effect<readonly PullRequestHistoryRef[], GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // Unlike the writes, a read does NOT degrade to a no-op: an empty
          // history is indistinguishable from "never proposed", and a caller
          // deciding suppression from it would silently decide wrong. Failing
          // is what lets that caller fail open *loudly*.
          return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" }));
        }
        const token = yield* mintToken(config, repo, installationId);
        const prs = yield* ghCall(() =>
          listPullRequests({
            token,
            repo,
            ...(state !== undefined ? { state } : {}),
            ...(headBranchPrefix !== undefined ? { headBranchPrefix } : {}),
            ...(updatedWithinDays !== undefined
              ? { updatedSince: Date.now() - updatedWithinDays * 86_400_000 }
              : {}),
            ...(maxPages !== undefined ? { maxPages } : {}),
          }),
        );
        return prs.map((p): PullRequestHistoryRef => ({ repo, ...p }));
      }),

    readTextFile: ({
      repo,
      path,
      ref,
      installationId,
    }): Effect.Effect<TextFileResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // Same reasoning as `pullRequestHistory`: `{ found: false }` here
          // would be a missing *credential* wearing a missing *file*'s clothes.
          return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "unauthorized" }));
        }
        // The ledger repo is private, so this always needs App auth — and a
        // cron tick carries no installation id, which `mintToken` resolves from
        // the repo itself (the App is the source of truth for which
        // installation covers a repo).
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() =>
          readRepoTextFile({ token, repo, path, ...(ref !== undefined ? { ref } : {}) }),
        );
      }),

    branchHead: ({ repo, branch, installationId }) =>
      Effect.gen(function* () {
        // A placeholder SHA would compare unequal to every deploy and skip it;
        // an uncredentialed deploy fails like every other read.
        if (config === undefined) return yield* readNeedsCredentials<string>();
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() => readBranchHead({ token, repo, branch }));
      }),

    commitPullRequests: ({ repo, sha, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* readNeedsCredentials<readonly CommitPullRequest[]>();
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() => listCommitPullRequests({ token, repo, sha }));
      }),

    pullRequest: ({ repo, number, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* readNeedsCredentials<CommitPullRequest>();
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() => getPullRequest({ token, repo, number }));
      }),

    appendMeasureNote: ({ repo, commit, text, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* readNeedsCredentials<void>();
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() => appendGitNote({ token, repo, commit, text }));
      }),

    issues: ({ repo, state, labels, updatedWithinDays, maxPages, strict, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* readNeedsCredentials<readonly IssueRef[]>();
        const token = yield* mintToken(config, repo, installationId);
        const raw = yield* ghCall(() =>
          listIssues({
            token,
            repo,
            ...(state !== undefined ? { state } : {}),
            ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
            ...(updatedWithinDays !== undefined
              ? { updatedSince: Date.now() - updatedWithinDays * 86_400_000 }
              : {}),
            ...(maxPages !== undefined ? { maxPages } : {}),
            ...(strict === true ? { strict: true } : {}),
          }),
        );
        return raw.map((i): IssueRef => {
          // `closed_at` is absent on an open issue and unparseable on a malformed
          // one; both leave the field off rather than dating a close at the
          // epoch, which would read as "closed in 1970" to anything computing a
          // window from it.
          const closedAt = i.closedAt === "" ? Number.NaN : Date.parse(i.closedAt);
          return {
            repo,
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            labels: i.labels,
            author: i.author,
            authorAssociation: i.authorAssociation,
            url: i.url,
            commentCount: i.commentCount,
            createdAt: Date.parse(i.createdAt) || 0,
            updatedAt: Date.parse(i.updatedAt) || 0,
            ...(Number.isFinite(closedAt) ? { closedAt } : {}),
          };
        });
      }),

    // `openIssue` is the exception to the paragraph below: it FAILS without
    // credentials rather than logging a skip. The state-machine writes annotate
    // an issue that exists whether or not the write lands, and the PR write
    // leaves its content in git — but this one *is* the artifact, so a no-op
    // discards the question and leaves the loop with no record it had one.
    openIssue: ({ repo, title, body, labels, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* readNeedsCredentials<IssueCreated>();
        const token = yield* mintToken(config, repo, installationId);
        return yield* ghCall(() =>
          createIssue({
            token,
            repo,
            title,
            body,
            ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
          }),
        );
      }),

    // The four state-machine writes + the one close. Each degrades to a logged
    // no-op without credentials, matching `pullReview` — though in practice the
    // read above fails first, so an uncredentialed deploy never reaches here.
    addIssueLabels: ({ repo, issue, labels, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* logSkip(repo, issue, "no GitHub App credentials");
        const token = yield* mintToken(config, repo, installationId);
        yield* ghCall(() => addIssueLabels({ token, repo, issue, labels }));
      }),

    removeIssueLabel: ({ repo, issue, label, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* logSkip(repo, issue, "no GitHub App credentials");
        const token = yield* mintToken(config, repo, installationId);
        yield* ghCall(() => removeIssueLabel({ token, repo, issue, label }));
      }),

    commentOnIssue: ({ repo, issue, body, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* logSkip(repo, issue, "no GitHub App credentials");
        const token = yield* mintToken(config, repo, installationId);
        yield* ghCall(() => createIssueComment({ token, repo, issue, body }));
      }),

    closeIssueAsDuplicate: ({ repo, issue, duplicateOf, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* logSkip(repo, issue, "no GitHub App credentials");
        const token = yield* mintToken(config, repo, installationId);
        yield* ghCall(() => closeIssueAsDuplicate({ token, repo, issue, duplicateOf }));
      }),

    closeBotIssue: (req): Effect.Effect<CloseBotIssueResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          yield* Effect.logInfo(
            `github.closeBotIssue skipped (no GitHub App credentials) — ${req.repo}#${req.issue} left open`,
          );
          return { closed: false, reason: "uncredentialed", number: req.issue } as const;
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() =>
          closeBotIssue({
            token,
            repo: req.repo,
            issue: req.issue,
            label: req.label,
            comment: req.comment,
          }),
        );
      }),

    pullReview: ({ repo, pr, sha, body, installationId }) =>
      Effect.gen(function* () {
        if (config === undefined) {
          return yield* logSkip(repo, pr, "no GitHub App credentials");
        }

        // `mintToken` prefers the webhook-threaded installation id but falls back
        // to resolving it from the App JWT (the App is the source of truth for
        // which installation covers a repo) — Action-mode dispatch, or a dropped
        // `installation.id`, still posts.
        const token = yield* mintToken(config, repo, installationId);

        yield* ghCall(() => createPullReview({ token, repo, pr, sha, body, event: "COMMENT" }));
      }),

    openDraftPullRequest: (req): Effect.Effect<DraftPullRequestResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // No App credentials (local dev / no secrets) — a logged no-op, the
          // same graceful degradation `pullReview` uses. The recipe sees
          // `created: false` and reports "no PR opened (App not configured)".
          yield* Effect.logInfo(
            `github.openDraftPullRequest skipped (no GitHub App credentials) — ${req.repo}#${req.headBranch} not opened`,
          );
          return { number: 0, url: "", created: false, skipped: false };
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() =>
          openDraftPullRequest({
            token,
            repo: req.repo,
            ...(req.baseBranch !== undefined ? { baseBranch: req.baseBranch } : {}),
            headBranch: req.headBranch,
            title: req.title,
            body: req.body,
            commitMessage: req.commitMessage,
            files: req.files,
            ...(req.draft !== undefined ? { draft: req.draft } : {}),
            ...(req.preserveHumanCommits !== undefined
              ? { preserveHumanCommits: req.preserveHumanCommits }
              : {}),
          }),
        );
      }),

    closeDraftPullRequest: (req): Effect.Effect<CloseDraftPullRequestResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          yield* Effect.logInfo(
            `github.closeDraftPullRequest skipped (no GitHub App credentials) — ${req.repo}#${req.headBranch} left open`,
          );
          return { closed: false, reason: "uncredentialed" } as const;
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() =>
          closeBotPullRequest({
            token,
            repo: req.repo,
            headBranch: req.headBranch,
            comment: req.comment,
          }),
        );
      }),

    createRelease: (req): Effect.Effect<ReleaseResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined) {
          // No App credentials (local dev / no secrets) — a logged no-op, the
          // same graceful degradation the other writes use. The recipe sees
          // `published: false` and reports "release not published (App not
          // configured)".
          yield* Effect.logInfo(
            `github.createRelease skipped (no GitHub App credentials) — ${req.repo}@${req.tag} not published`,
          );
          return { id: 0, url: "", tag: req.tag, published: false };
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        const result = yield* ghCall(() =>
          createRelease({
            token,
            repo: req.repo,
            tag: req.tag,
            ...(req.target !== undefined ? { target: req.target } : {}),
            ...(req.name !== undefined ? { name: req.name } : {}),
            body: req.body,
            ...(req.prerelease !== undefined ? { prerelease: req.prerelease } : {}),
            ...(req.draft !== undefined ? { draft: req.draft } : {}),
          }),
        );
        return {
          id: result.id,
          url: result.htmlUrl,
          tag: result.tagName,
          published: !req.draft,
          draft: req.draft ?? false,
        };
      }),
    tagCommit: (req) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() => resolveTagCommit({ token, repo: req.repo, tag: req.tag }));
      }),
    tagTarget: (req) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() => resolveTagTarget({ token, repo: req.repo, tag: req.tag }));
      }),
    commitOnDefaultBranch: (req) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() => commitOnDefaultBranch({ token, repo: req.repo, commitSha: req.commitSha }));
      }),
    releaseByTag: (req) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        const token = yield* mintToken(config, req.repo, req.installationId);
        const release = yield* ghCall(() => getReleaseByTag({ token, repo: req.repo, tag: req.tag }));
        return release === undefined ? undefined : {
          id: release.id, url: release.htmlUrl, tag: release.tagName,
          published: !release.draft, draft: release.draft,
        };
      }),
    publishRelease: (req) =>
      Effect.gen(function* () {
        if (config === undefined) return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        const token = yield* mintToken(config, req.repo, req.installationId);
        const release = yield* ghCall(() => publishRelease({ token, repo: req.repo, releaseId: req.releaseId }));
        return { id: release.id, url: release.htmlUrl, tag: release.tagName, published: true, draft: false };
      }),
    publishReleaseAsset: (req): Effect.Effect<ReleaseAssetResult, GitHubApiError> =>
      Effect.gen(function* () {
        if (config === undefined || artifactsBucket === undefined || executionId === undefined) {
          return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        }
        const source = yield* Effect.tryPromise({
          try: () => artifactsBucket.get(artifactKey(executionId, req.artifactName)),
          catch: () => new GitHubApiError({ status: 0, reason: "transient" }),
        });
        if (source === null) {
          return yield* Effect.fail(new GitHubApiError({ status: 404, reason: "other" }));
        }
        const token = yield* mintToken(config, req.repo, req.installationId);
        return yield* ghCall(() =>
          uploadReleaseAsset({
            token,
            repo: req.repo,
            releaseId: req.releaseId,
            name: req.artifactName,
            contentType: req.contentType,
            content: source.body,
            size: source.size,
            ...(req.sha256 !== undefined ? { sha256: req.sha256 } : {}),
          }),
        );
      }),
    publishContainerImage: (req): Effect.Effect<void, GitHubApiError> =>
      Effect.gen(function* () {
        if (ghcr === undefined || artifactsBucket === undefined || executionId === undefined || db === undefined) {
          return yield* Effect.fail(new GitHubApiError({ status: 0, reason: "other" }));
        }
        if (req.repo !== "fractalboxdev/contextful" ||
          !["contextful-control", "contextful-edge", "contextful-full"].includes(req.profile) ||
          !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(req.version) ||
          req.layerArtifactName !== `${req.profile}-${req.version}-linux-amd64.layer.tar.gz` ||
          !/^[a-f0-9]{64}$/.test(req.layerDigest) || !/^[a-f0-9]{64}$/.test(req.diffId)) {
          return yield* Effect.fail(new GitHubApiError({ status: 400, reason: "other" }));
        }
        const child = yield* Effect.tryPromise({
          try: () => db.prepare("SELECT status FROM executions WHERE id = ? AND parent_execution_id = ? AND run = ?")
            .bind(req.sourceExecutionId, executionId, "contextful-release-cell").first<{ status: string }>(),
          catch: () => new GitHubApiError({ status: 0, reason: "transient" }),
        });
        if (child?.status !== "success") return yield* Effect.fail(new GitHubApiError({ status: 403, reason: "other" }));
        const source = yield* Effect.tryPromise({
          try: () => artifactsBucket.get(artifactKey(req.sourceExecutionId, req.layerArtifactName)),
          catch: () => new GitHubApiError({ status: 0, reason: "transient" }),
        });
        if (source === null || source.size !== req.layerSize) {
          return yield* Effect.fail(new GitHubApiError({ status: 404, reason: "other" }));
        }
        return yield* Effect.tryPromise({
          try: () => pushGhcrImage({
            username: ghcr.username, token: ghcr.token,
            name: `${req.repo}/${req.profile}`, tag: req.version,
            layer: source.body, layerSize: source.size,
            layerDigest: req.layerDigest, diffId: req.diffId,
          }),
          catch: () => new GitHubApiError({ status: 0, reason: "transient" }),
        });
      }),
  };

  return Layer.succeed(Github, service);
};

/**
 * Coerce an unknown thrown value into the core `GitHubApiError`, carrying the
 * rate-limit retry hint through from the low-level `GithubApiError` so the
 * classification (and any backoff) can honour it. A non-API throw (network
 * failure) has no status → 0 → `transient`.
 */
const toGitHubApiError = (cause: unknown): GitHubApiError => {
  if (cause instanceof GithubAppApiError) {
    const retryAfterMs = cause.retryAfterMs;
    return new GitHubApiError({
      status: cause.status,
      reason: classifyReason(cause.status, retryAfterMs),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return new GitHubApiError({ status: 0, reason: "transient" });
};
