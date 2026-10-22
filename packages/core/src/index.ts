// @fractalboxdev/flare-dispatch-core — public API.
//
// The DSL a run author builds against: the run frame (`defineRun`, `step`),
// the six capability namespaces, and the tagged error types. Primitives — the
// reusable compositions built on these capabilities — are a separate entry
// point so the layer boundary stays visible:
//
//   import { defineRun, step, sandbox } from "@fractalboxdev/flare-dispatch-core";
//   import { workspace, sharded }       from "@fractalboxdev/flare-dispatch-core/primitives";
//
// Spec: specs/03-dsl.md.

// --- Run frame ---------------------------------------------------------------
export {
  defineRun,
  type Run,
  type RunSpec,
  type RunLimits,
  type CooldownSpec,
  type OptInContext,
  type HumanGateSpec,
  type SandboxImage,
  type SerializeSpec,
  type SupersedeSpec,
  type TriggerSpec,
  type ScheduleSpec,
  type ScheduleContext,
  type WebhookPayload,
} from "./define-run";
export { step, checkpointSleep, runEffect, type StepOpts } from "./step";
export { CurrentStep, type CurrentStepInfo } from "./current-step";
export {
  CheckCommandHandle,
  CheckCommandObservation,
  CheckCommandLogState,
  CheckCommandChunk,
  type CheckCommandOwner,
  type CheckCommandPrepare,
  type CheckCommandOpts,
} from "./check-command";
export { type RunContext } from "./context";

// --- Writeback (run-declared "propose a diff as a PR") -----------------------
export {
  WRITEBACK_ARTIFACT,
  WRITEBACK_MANIFEST_FILE,
  WRITEBACK_FILES_DIR,
  WRITEBACK_MAX_BYTES_DEFAULT,
  WRITEBACK_MAX_FILES_DEFAULT,
  WritebackEntry,
  WritebackManifest,
  decodeManifest,
  validateManifest,
  describeRejection,
  resolveHeadBranch,
  matchGlob,
  isSensitivePath,
  resolvePrMeta,
  WRITEBACK_PR_META_FILE,
  WritebackPrMeta,
  MAX_WRITEBACK_PR_BODY_CHARS,
  MAX_WRITEBACK_PR_LABELS,
  MAX_WRITEBACK_PR_LABEL_CHARS,
  type WritebackSpec,
  type WritebackBranch,
  type WritebackPr,
  type WritebackMode,
  type WritebackRejection,
  type WritebackValidation,
  type ValidatedEntry,
} from "./writeback";

// --- Container lease (pure decision logic) -----------------------------------
export {
  decideLease,
  isLeaseStale,
  leaseAcquireAttempts,
  type LeaseRecord,
  type LeaseDecision,
} from "./container-lease";

// --- Run admission (pure decision logic) --------------------------------------
export {
  decideAdmission,
  admissionAcquireAttempts,
  admissionPollSleepMs,
  admissionJitterMs,
  ADMISSION_CLASS_DEFAULT,
  ADMISSION_POLL_MIN_MS,
  ADMISSION_POLL_MAX_MS,
  ADMISSION_JITTER_MAX_MS,
  type AdmissionClass,
  type AdmissionPool,
  type AdmissionObservation,
  type AdmissionDecision,
} from "./run-admission";

// --- Spend guard (pure budget + burn-ceiling math, ADR-0006) -----------------
export {
  SPEND_BUDGET_MONTHLY_USD_DEFAULT,
  SPEND_BURN_MAX_USD_PER_HOUR_DEFAULT,
  SPEND_OVERHEAD_FACTOR_DEFAULT,
  SPEND_WARN_RATIO_DEFAULT,
  SPEND_UNLIMITED,
  SPEND_BUDGET_KV_KEY,
  SPEND_BURN_KV_KEY,
  spendWarnedKvKey,
  parseUsdLimit,
  resolveSpendLimits,
  spendMonth,
  monthToDateMicroUsd,
  formatUsd,
  decideBudget,
  fitsBurnCeiling,
  spendCeilingReason,
  type SpendLimits,
  type SpendVars,
  type SpendOverrides,
  type SpendMonth,
  type SpendReading,
  type BudgetDecision,
} from "./spend";

// --- Run ceiling (limits.maxDurationSec, replay-stable) ----------------------
export { withRunCeiling, type RunCeiling } from "./run-ceiling";
export {
  EngineInterrupted,
  isEngineInterruptedCause,
  isEngineInterruption,
} from "./engine-interruption";

// --- Agent token-budget (pure decision logic for the AgentBudget DO) ----------
export {
  AGENT_TOKEN_BUDGET_DEFAULT,
  AGENT_MAX_REQUESTS_DEFAULT,
  initialBudget,
  remaining,
  decideReserve,
  settle,
  kill,
  type AgentBudgetState,
  type ReserveDecision,
} from "./agent-budget";

// --- Capabilities ------------------------------------------------------------
export {
  sandbox,
  Sandbox,
  flattenCommand,
  type SandboxService,
  type Container,
  type DetachedHandle,
  type ExecResult,
  ExecResultSchema,
  type CheckCommandService,
  type ExecOpts,
  type ExposeResult,
} from "./services/sandbox";
export { browser, Browser, type BrowserService, type CDPSession } from "./services/browser";
export { cache, Cache, type CacheService } from "./services/cache";
export { artifact, Artifact, type ArtifactService, type ArtifactInfo } from "./services/artifact";
export {
  DEPLOYED_VERSION_ENV,
  EXECUTION_CREATED_AT_ENV,
  io,
  IO,
  type IOService,
  type LogLevel,
  type PriorExecution,
} from "./services/io";
export { config, Config, type ConfigService } from "./services/config";
export { secrets, Secrets, type SecretsService } from "./services/secrets";
export {
  modelGateway,
  ModelGateway,
  ModelGatewayError,
  type ModelGatewayService,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelTool,
  type ModelToolCall,
} from "./services/model-gateway";
export {
  email,
  Email,
  type EmailService,
  type EmailSendRequest,
  type EmailSendResult,
  type EmailRejection,
} from "./services/email";
export {
  notice,
  Notice,
  type NoticeService,
  type NoticeRequest,
  type NoticeResult,
  type NoticeLink,
} from "./services/notice";
export { mailbox, Mailbox, type MailboxService, type AllocateOpts } from "./services/mailbox";
export {
  INBOX_EVENT_TYPE,
  INBOX_LOCAL_PREFIX,
  INBOX_LOCAL_PART_RE,
  INBOX_TTL_SEC_DEFAULT,
  INBOX_WAIT_DEFAULT,
  InboxMessage,
  InboxAddress,
  buildInboxAddress,
  mintLocalPart,
  isInboxLocalPart,
  parseInboxLocalPart,
  type OtpExtraction,
} from "./mailbox/contract";
export { extractOtp, extractCode, extractLink } from "./mailbox/extract";
export {
  github,
  Github,
  type GithubService,
  type CommitPullRequest,
  type IssueCreated,
  type IssueRef,
  type PullRequestHistoryRef,
  type ReadTextFileRequest,
  type TextFileResult,
  type WorkflowRunRef,
  type PullReviewRequest,
  type OpenDraftPullRequest,
  type DraftPullRequestResult,
  type CloseDraftPullRequest,
  type CloseDraftPullRequestResult,
  type CloseBotIssue,
  type CloseBotIssueResult,
  type CreateRelease,
  type ReleaseResult,
  type PublishReleaseAsset,
  type ReleaseAssetResult,
} from "./services/github";
export {
  cloudflare,
  Cloudflare,
  type CloudflareService,
  type DeploymentRef,
  type CloudflareUsage,
  type WorkerUsage,
  type AiModelUsage,
} from "./services/cloudflare";
export {
  oidc,
  Oidc,
  type OidcService,
  type OidcToken,
  OIDC_TOKEN_TTL_SEC_DEFAULT,
  OIDC_TOKEN_MAX_TTL_SEC,
  OIDC_RESERVED_CLAIMS,
} from "./services/oidc";
export {
  checks,
  Checks,
  type ChecksService,
  type CheckConclusion,
  type CheckOutput,
  type CheckRunState,
  type CheckDelivery,
  type CheckConcludeOptions,
} from "./services/checks";
export {
  spawnChildRun,
  handoffChildAdmission,
  ChildRuns,
  isTerminalChildStatus,
  type ChildRunsService,
  type ChildRunHandle,
  type SpawnChildRunOpts,
  type ChildRunStatus,
  type ChildStatusRecord,
} from "./services/child-runs";
export {
  Executions,
  type ExecutionsService,
  type ExecutionRecord,
  type StepRecord,
  type StepStatus,
} from "./services/executions";
export { StepRunner, type StepRunnerService } from "./services/step-runner";

// --- Signals (the vendor-blind `signals/v1` contract) -------------------------
export {
  SIGNALS_CONTRACT_VERSION,
  MAX_SIGNALS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_URL_CHARS,
  Signal,
  SignalArray,
  type SignalT,
} from "./signals";

// --- Demo→signals adapter (product-demo failures as `signals/v1`) -------------
export {
  DemoFailureKind,
  storyResultsToSignals,
  storyResultsToIncident,
  type DemoFailureKindT,
  type DemoChapterResult,
  type DemoSignalContext,
  type DemoIncidentContext,
} from "./demo-signals";

// --- Incident (the fix-side `incident/v1` context-pack contract) --------------
export {
  INCIDENT_CONTRACT_VERSION,
  MAX_INCIDENT_CI_FAILURES,
  MAX_INCIDENT_DEMO_CHAPTERS,
  MAX_INCIDENT_SUSPECT_FILES,
  MAX_INCIDENT_LOGTAIL_CHARS,
  MAX_INCIDENT_TEXT_CHARS,
  MAX_INCIDENT_SHORT_CHARS,
  MAX_INCIDENT_PATH_CHARS,
  MAX_INCIDENT_URL_CHARS,
  IncidentClass,
  Diagnosis,
  CiFailure,
  DemoChapter,
  SuspectRef,
  Repro,
  Incident,
  type IncidentClassT,
  type IncidentT,
  type IncidentInput,
} from "./incident";

// --- CI→incident adapter (offload-test command failure as `incident/v1`) ------
export { commandFailureToIncident, type CiIncidentContext } from "./ci-incident";

// --- Cost engine -------------------------------------------------------------
export {
  MICRO_USD_PER_USD,
  INSTANCE_SPECS,
  CONTAINER_VCPU_MICRO_USD_PER_SEC,
  CONTAINER_GIB_MICRO_USD_PER_SEC,
  CONTAINER_DISK_MICRO_USD_PER_SEC,
  containerMicroUsdPerSec,
  containerMicroUsdPerHour,
  modelRate,
  modelCost,
  containerCostMicroUsd,
  estimateExecutionCost,
  microUsdToUsd,
  formatMicroUsd,
  type InstanceType,
  type InstanceSpec,
  type ModelRate,
  type ModelCost,
  type CostBasis,
  type ExecutionCost,
} from "./cost";

// --- Errors ------------------------------------------------------------------
export * from "./errors";
