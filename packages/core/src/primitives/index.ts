// @fractalboxdev/flare-dispatch-core/primitives — public exports.
//
// Primitives are reusable Effect-TS compositions built on the capabilities
// (`sandbox`, `browser`, `cache`, `artifact`, `io`, `config`). Recipes import
// them from here; the layer boundary stays visible at the top of each recipe:
//
//   import { defineRun, step, sandbox } from "@fractalboxdev/flare-dispatch-core";
//   import { workspace, sharded } from "@fractalboxdev/flare-dispatch-core/primitives";
//
// See specs/03-dsl.md § Primitives and ./README.md.

export { ensureWorkspace, workspace, type Workspace } from "./workspace";
export {
  durableExec,
  pollDelayMs,
  DURABLE_EXEC_MIN_TIMEOUT_SEC,
  DURABLE_EXEC_RETRY_ON,
  type DurableExecCommand,
  type DurableExecOpts,
  type DurableExecResult,
} from "./durable-exec";
export { installCached } from "./install-cached";
export {
  isRestorableEntry,
  keyMaterialCommand,
  parsePathPackages,
  prebuildCargoBinary,
  prebuiltCommand,
  prebuiltEntry,
  prebuiltKey,
  restorePrebuilt,
  KEY_FILES,
  PREBUILT_ROOT,
  type CacheEntry,
  type PrebuiltBinary,
} from "./prebuilt-binary";
export { sharded, type Shard } from "./sharded";
export { fanOut, type FanOutShard } from "./fan-out";
export { waitForAnyChildDurably, waitForChildren, waitForChildrenDurably } from "./wait-for-children";
export { bootApp } from "./boot-app";
export { probeHttp, type ProbeResult } from "./probe-http";
export { loadSecrets } from "./load-secrets";
export { provisionInbox, waitForOtp, type OtpResult } from "./wait-for-otp";
export { awsAssumeRole, type AwsCredentials } from "./aws-assume-role";
export { isoDate, parseGitRef, parseList, parseRepo, parseRepoRelativePath } from "./scheduling";
export { isNothingToLint } from "./oxlint";
export { resolveControlRepo, resolveRepoRelativePath } from "./control-plane";
export {
  checkSuppression,
  decideSuppression,
  describeVerdict,
  parseDeclinedLedger,
  parseMaintenanceKeys,
  renderSuppressionNote,
  COOLDOWN_DAYS_DEFAULT,
  DECLINED_LEDGER_PATH,
  type CheckSuppressionArgs,
  type DeclineEntry,
  type LedgerParse,
  type SuppressedKey,
  type SuppressionReport,
  type SuppressionVerdict,
} from "./suppression";
export {
  evaluateAutomerge,
  loadAutomergeConfig,
  parseAutomergeConfig,
  matchesSensitivePath,
  describeVerdict as describeMergeVerdict,
  AUTOMERGE_CONFIG_CLOSED,
  AUTOMERGE_CONFIG_PATH,
  LADDER_NOT_IMPLEMENTED,
  type AutomergeConfig,
  type MergeCandidate,
  type MergeVerdict,
  type RefusalReason,
} from "./automerge-gate";
export {
  classifierUser,
  decideIssueActions,
  duplicateCandidates,
  DUPLICATE_CANDIDATE_LIMIT,
  duplicateComment,
  extractCommandRepro,
  quoteReproForRecord,
  fenceUntrusted,
  parseVerdict,
  ARMING_LABEL,
  CLASSIFIER_SCHEMA,
  CLASSIFIER_SYSTEM,
  DECLINED_LABEL,
  NEEDS_REPRO_COMMENT,
  NEVER_WRITTEN,
  TRIAGE_LABELS,
  UNTRUSTED_FENCE,
  VERDICT_KINDS,
  WRITEABLE_LABELS,
  type CapturedRepro,
  type IssueAction,
  type IssueDecision,
  type IssueVerdict,
} from "./issue-triage";
