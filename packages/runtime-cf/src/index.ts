// @fractalboxdev/flare-dispatch-runtime-cf — public API.
//
// The live Cloudflare-binding runtime: the Layers that back the
// `@fractalboxdev/flare-dispatch-core` capability Tags with real D1 / R2 / Containers /
// Workflows. The Dispatcher's `RunWorkflow` builds `makeCFRuntimeLive(...)`
// from a dispatch event and provides it to a run Effect.
//
//   import { makeCFRuntimeLive } from "@fractalboxdev/flare-dispatch-runtime-cf";
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4.

// --- The composed runtime ----------------------------------------------------
export { makeCFRuntimeLive, type CFRuntimeLiveOptions, type SubstrateExecution } from "./runtime";

// --- Individual capability Layers (also exported for targeted tests) ---------
export { IOLive, makeIOLive } from "./io-live";
export { makeD1ExecutionsLive, type ExecutionContext } from "./executions-d1";
export { makeR2ArtifactLive } from "./artifact-r2";
export {
  type BrowserRenderingConfig,
  composeCdpEndpoint,
  makeBrowserRenderingLive,
} from "./browser-cf";
export { makeCacheR2Live } from "./cache-r2";
export { makeConfigKvLive } from "./config-kv";
export { makeSecretsLive } from "./secrets-live";
export {
  makeEmailCloudflareLive,
  type EmailCloudflareConfig,
  type SendEmailBinding,
} from "./email-cf";
export {
  makeNoticeCloudflareLive,
  noticeDeliveryId,
  type NoticeCloudflareConfig,
  type NoticeEmission,
  type NoticeEmissionResult,
} from "./notice-cf";
export { makeSandboxCloudflareLive } from "./sandbox-cf";
// `SandboxGithubAuth` only — it is param 4 of the exported
// `makeSandboxCloudflareLive`, so a consumer needs the type to call it.
// `resolveCloneToken` stays internal: its only caller is `sandbox-cf.ts`, in
// this package.
export type { SandboxGithubAuth } from "./sandbox-clone-auth";
export {
  describeRefusal,
  makeSandboxFacadeLive,
  SUBSTRATE_WORKSPACE,
  type SandboxFacadeOptions,
} from "./sandbox-facade";
export { previewSafeSandboxId } from "./preview-sandbox-id";
export {
  makeContainerLeaseD1,
  LEASE_TTL_MS,
  LEASE_POLL_EVERY_MS,
  LEASE_HEARTBEAT_EVERY_MS,
  LEASE_WAIT_TIMEOUT_MS,
  type ContainerLeaseStore,
  type LeaseHandle,
} from "./container-lease-d1";
export {
  makeRunAdmissionD1,
  BURN_UNLIMITED,
  type BurnCeiling,
  resolveAdmissionCap,
  resolvePoolAdmissionCap,
  ADMISSION_CAP_DEFAULT,
  RELEASE_ADMISSION_CAP_DEFAULT,
  AGENT_ADMISSION_CAP_DEFAULT,
  BROWSER_ADMISSION_CAP_DEFAULT,
  ADMISSION_POLL_EVERY_MS,
  ADMISSION_MAX_QUEUE_AGE_MS,
  ADMISSION_TTL_MS,
  ADMISSION_WAITER_TTL_MS,
  type AdmissionCapVars,
  type RunAdmissionStore,
} from "./run-admission-d1";
export {
  makeSerialQueueD1,
  runSerialGate,
  decideSerial,
  revisionMatches,
  SERIAL_POLL_EVERY_MS,
  SERIAL_MAX_WAIT_MS,
  SERIAL_HOLDER_TTL_MS,
  type SerialQueueStore,
  type SerialObservation,
  type SerialDecision,
} from "./serial-queue-d1";
export {
  makeRunSupersedeD1,
  TERMINAL_EXECUTION_STATUSES,
  type RunSupersedeStore,
  type SupersededRow,
} from "./run-supersede-d1";
export { makeStepRunnerCloudflare } from "./step-runner-cf";
export {
  isEngineGone,
  makeWorkflowEngine,
  WorkflowEngine,
  type WorkflowEngineService,
  type WorkflowStepLike,
} from "./workflow-engine";
export { makeChecksGithubLive, NOOP_CHECK_RUN_ID, type ChecksGithubConfig } from "./checks-github";
export { makeGithubLive, type GithubLiveConfig } from "./github-live";
export {
  makeCloudflareLive,
  type CloudflareLiveConfig,
  cfReason,
  pagesDeploymentsUrl,
  pagesProjectsUrl,
  normalizeDeployment,
} from "./cloudflare-live";
export {
  makeChildRunsLive,
  deriveChildInstanceId,
  type ChildRunsLiveConfig,
  type ChildGithubContext,
  type WorkflowBindingLike,
} from "./child-runs-cf";
export { makeModelGatewayLive, type AiBinding, type ModelUsageSink } from "./model-gateway-cf";
export {
  recordExecutionCost,
  instanceForSandboxImage,
  hourlyRateForSandboxImage,
  SANDBOX_CONTAINER,
  COST_METER_ADMITTED_ACTIVE,
} from "./execution-cost";
export {
  readSpend,
  readSpendLimits,
  readSpendStatus,
  warnSpendOnce,
  type SpendStatus,
} from "./spend-d1";
export {
  BrowserDeferred,
  ChildRunsDeferred,
  CloudflareDeferred,
  ConfigDeferred,
  GithubDeferred,
  ModelGatewayDeferred,
  OidcDeferred,
} from "./deferred";
export { makeOidcLive, publicJwkFromSigning, type OidcLiveConfig } from "./oidc-live";
export {
  runWriteback,
  describeOutcome,
  makeWritebackTokenMinter,
  type RunWritebackOptions,
  type WritebackOutcome,
} from "./writeback-r2";

// --- The Sandbox Durable Object class ----------------------------------------
// Re-exported so `apps/dispatcher` can `extends` it for the `RUNS_SANDBOX`
// container binding without a direct `@cloudflare/sandbox` import.
export { Sandbox as SandboxContainer } from "@cloudflare/sandbox";
export { makeCheckCommandOwner } from "./check-command";
export { checkCommandStorage } from "./check-command-storage";
