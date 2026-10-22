// @fractalboxdev/flare-dispatch-github-app — public API.
//
// GitHub App authentication helpers for the FlareDispatch check-run callback:
//
//   * `signAppJwt`           — RS256 App JWT from the PEM private key.
//   * `getInstallationToken` — exchange the JWT for a short-lived installation
//                              token (in-memory cached, per Worker isolate).
//   * `createCheckRun` / `updateCheckRun` — post the run verdict.
//
// Provider-neutral fetch code: plain typed `async` functions, no Effect
// dependency. The Effect Layer (`ChecksGithubLive` in @fractalboxdev/flare-dispatch-runtime-cf)
// wraps these.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6.

export { signAppJwt, type SignAppJwtOptions } from "./jwt";
export {
  getInstallationToken,
  resolveRepoInstallationId,
  __clearTokenCache,
  __clearRepoInstallationCache,
  type GetInstallationTokenOptions,
  type ResolveRepoInstallationOptions,
} from "./installation-token";
export { rateLimitFromHeaders, type RateLimitSnapshot } from "./http";
export {
  createCheckRun,
  getCheckRunStatus,
  progressCheckRun,
  updateCheckRun,
  type CheckConclusion,
  type CheckRunOutput,
  type CreateCheckRunOptions,
  type GetCheckRunStatusOptions,
  type ProgressCheckRunOptions,
  type UpdateCheckRunOptions,
} from "./check-runs";
export { createPullReview, type PullReviewEvent, type CreatePullReviewOptions } from "./reviews";
export {
  listActionRuns,
  actionRunsUrl,
  normalizeRun,
  type ActionRun,
  type ListActionRunsOptions,
} from "./actions";
export {
  openDraftPullRequest,
  closeBotPullRequest,
  commitFilesAndOpenPr,
  treeEntry,
  deletionEntry,
  type FileEdit,
  type FileDeletion,
  type TreeEntry,
  type CommitFilesOptions,
  type CommitFilesResult,
  type OpenDraftPullRequestOptions,
  type OpenDraftPullRequestResult,
  type CloseBotPullRequestOptions,
  type CloseBotPullRequestResult,
} from "./pull-requests";
export {
  listPullRequests,
  normalizePullRequest,
  pullRequestsUrl,
  type ListPullRequestsOptions,
  type PullRequestSummary,
} from "./pull-request-list";
export {
  readRepoTextFile,
  repoContentsUrl,
  type ReadRepoTextFileOptions,
  type ReadRepoTextFileResult,
} from "./repo-files";
export { readBranchHead, branchRefUrl, type ReadBranchHeadOptions } from "./branch-head";
export {
  commitPullsUrl,
  getPullRequest,
  listCommitPullRequests,
  type CommitPullRequest,
  type ListCommitPullRequestsOptions,
} from "./commit-pulls";
export { appendGitNote, type AppendGitNoteOptions } from "./git-notes";
export {
  addIssueLabels,
  closeBotIssue,
  closeIssueAsDuplicate,
  createIssue,
  createIssueComment,
  listIssues,
  removeIssueLabel,
  type AddIssueLabelsOptions,
  type AuthorAssociation,
  type CloseBotIssueOptions,
  type CloseBotIssueResult,
  type CloseIssueAsDuplicateOptions,
  type CreateIssueCommentOptions,
  type CreateIssueOptions,
  type CreateIssueResult,
  type IssueListItem,
  type ListIssuesOptions,
  type RemoveIssueLabelOptions,
} from "./issues";
export {
  createRelease,
  getReleaseByTag,
  publishRelease,
  resolveTagCommit,
  resolveTagTarget,
  commitOnDefaultBranch,
  uploadReleaseAsset,
  type CreateReleaseOptions,
  type CreateReleaseResult,
  type UploadReleaseAssetOptions,
  type UploadReleaseAssetResult,
} from "./releases";
export {
  fetchPublicAppRegistration,
  diffRegistration,
  hasFailingDrift,
  appSettingsUrl,
  type AppRegistration,
  type DesiredRegistration,
  type PermissionDrift,
  type RegistrationDrift,
  type FetchAppRegistrationOptions,
} from "./registration";
export { GithubApiError } from "./errors";
