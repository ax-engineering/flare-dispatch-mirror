// @fractalboxdev/flare-dispatch-core — tagged run errors.
//
// Every failure a run can produce is a Schema.TaggedError: serializable,
// pattern-matchable with Match.tag, and carrying a typed payload. Runs recover
// with Effect.catchTag / catchTags; anything uncaught fails the execution with
// the full Cause attached to the check-run summary.
//
// Spec: specs/03-dsl.md § Errors.

import { Schema } from "effect";

export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("CheckoutFailed", {
  repo: Schema.String,
  sha: Schema.String,
  cause: Schema.Unknown,
}) {}

export class ExecFailed extends Schema.TaggedError<ExecFailed>()("ExecFailed", {
  exitCode: Schema.Number,
  stderrTail: Schema.String,
}) {
  // Read by `runEffect` (step.ts) and folded into the own-property message of
  // the Error thrown at the Workflow boundary — a prototype getter does not
  // survive that crossing on its own (#80).
  override get message(): string {
    return `exec failed (exit ${this.exitCode}): ${this.stderrTail}`;
  }
}

export class ExecTimeout extends Schema.TaggedError<ExecTimeout>()("ExecTimeout", {
  timeoutSec: Schema.Number,
  command: Schema.String,
}) {
  // Read by `runEffect` (step.ts) and folded into the own-property message of
  // the Error thrown at the Workflow boundary — a prototype getter does not
  // survive that crossing on its own (#80).
  override get message(): string {
    return `exec timed out after ${this.timeoutSec}s: ${this.command}`;
  }
}

/**
 * A container file read failed (missing path, binary content, transport
 * error). Raised by `sandbox.readFile` — the path runs use to move command
 * output larger than the inlined `ExecResult.stdout` tail out of a container.
 */
export class ReadFileFailed extends Schema.TaggedError<ReadFileFailed>()("ReadFileFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * A run's command/suite ran to completion but exited non-zero (a real test
 * failure). A run raises this to fail itself so the dispatcher reports a
 * `failure` check-run — distinct from `ExecFailed` (the process could not run
 * at all).
 */
export class AcceptanceFailed extends Schema.TaggedError<AcceptanceFailed>()("AcceptanceFailed", {
  exitCode: Schema.Number,
  /**
   * Optional run-authored failure presentation — markdown the dispatcher
   * embeds beneath the generic "execution failed" line in the check-run
   * summary (and the notify email), so a red check explains itself instead
   * of pointing at R2. A run that already builds a human-readable verdict
   * (e.g. `product-demo`'s per-chapter table) attaches it here; absent ⇒
   * the generic line renders alone, exactly as before.
   */
  summaryMd: Schema.optional(Schema.String),
}) {}

export class ContainerLaunchFailed extends Schema.TaggedError<ContainerLaunchFailed>()(
  "ContainerLaunchFailed",
  { image: Schema.String, cause: Schema.Unknown },
) {}

/**
 * A run could not acquire its container's lease within the wait ceiling — the
 * container id is held by another execution that never released it in time.
 *
 * Two runs that share a sandbox container id (e.g. `playwright-demo` and
 * `product-demo` for the same repo+sha, whose ids both normalise to
 * `demo-<owner>-<repo>-<sha12>`) are serialized: the second waits for the first
 * to finish. This fires only when that wait exceeds `waitedMs` with the lease
 * still held — a genuinely wedged peer, not normal back-pressure — so the queued
 * run fails fast and loud instead of hanging until the Workflow's wall-clock cap.
 */
export class ContainerBusy extends Schema.TaggedError<ContainerBusy>()("ContainerBusy", {
  /** The shared container id the lease serializes. */
  containerId: Schema.String,
  /** The execution id still holding the lease when the wait gave up. */
  holder: Schema.String,
  /** Total time waited before giving up, ms. */
  waitedMs: Schema.Number,
}) {}

/**
 * A run timed out waiting for a global admission slot — the container pool
 * stayed saturated for the whole dispatch-age ceiling (issue #109).
 *
 * Every run passes a per-pool admission semaphore (cap = the pool's
 * `max_instances`) before its body starts; this fires when the queue never
 * drained in time. The run **never started** — no container booted, no test
 * ran — so the failure is capacity back-pressure, not a test failure, and the
 * check-run summary must say so (see the dispatcher's `failure-summary.ts`).
 */
export class AdmissionTimedOut extends Schema.TaggedError<AdmissionTimedOut>()(
  "AdmissionTimedOut",
  {
    /** Total time queued before giving up, ms. */
    queuedForMs: Schema.Number,
    /** Live queued runs still ahead when the wait gave up. */
    position: Schema.Number,
    /** Admission slots in use in the run's pool when the wait gave up. */
    poolBusy: Schema.Number,
  },
) {
  // The Workflows attempt record persists only error.name + error.message
  // (#88) — make the message read as an infra-wait timeout on its own.
  override get message(): string {
    return (
      `timed out waiting for a sandbox slot after ${Math.round(this.queuedForMs / 60_000)} min ` +
      `(${this.position} run(s) ahead, ${this.poolBusy} slot(s) busy) — the run never started`
    );
  }
}

/**
 * A run declaring `serialize` waited its whole ceiling behind an in-flight
 * execution of the same group, which kept heartbeating the entire time. The
 * run **never started**. Distinct from `AdmissionTimedOut`: the pool may have
 * been idle — one peer held the group, and a serialized group never runs two.
 */
export class SerialQueueTimedOut extends Schema.TaggedError<SerialQueueTimedOut>()(
  "SerialQueueTimedOut",
  {
    /** The serialization group, e.g. `worker-deploy:owner/name@main`. */
    group: Schema.String,
    /** Revision the in-flight holder was running when the wait gave up. */
    holderRevision: Schema.String,
    /** Total time queued before giving up, ms. */
    waitedMs: Schema.Number,
  },
) {
  override get message(): string {
    return (
      `timed out after ${Math.round(this.waitedMs / 60_000)} min queued behind ` +
      `${this.holderRevision.slice(0, 12)} in ${this.group} — the run never started`
    );
  }
}

export class PortNeverOpened extends Schema.TaggedError<PortNeverOpened>()("PortNeverOpened", {
  port: Schema.Number,
  timeoutSec: Schema.Number,
  /**
   * R2 key of the detached process's captured stdout/stderr at the moment
   * the wait timed out, when log capture succeeded. A detached boot fails
   * with no other diagnostic — this is the only window into *why* the port
   * never opened. `undefined` when the runtime could not capture logs (e.g.
   * the process had already vanished), so a capture failure never masks the
   * original timeout.
   */
  logPath: Schema.optional(Schema.String),
}) {}

export class ExposePortFailed extends Schema.TaggedError<ExposePortFailed>()("ExposePortFailed", {
  port: Schema.Number,
  cause: Schema.Unknown,
}) {}

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  {
    reason: Schema.Literal("quota", "transient", "session-cap"),
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

/**
 * Render an error's `cause` field for `message` getters. The Workflows
 * attempt record only persists `error.name` + `error.message` — a swallowed
 * cause turns a diagnosable failure ("readFile: encoding 'none' requires the
 * rpc transport") into an opaque artifact name (#88). Keep it short: the
 * attempt record is a log line, not a stack dump.
 */
const renderCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  phase: Schema.Literal("restore", "save"),
  key: Schema.String,
  cause: Schema.Unknown,
}) {
  override get message(): string {
    return `cache ${this.phase} "${this.key}" failed: ${renderCause(this.cause)}`;
  }
}

export class ArtifactUploadFailed extends Schema.TaggedError<ArtifactUploadFailed>()(
  "ArtifactUploadFailed",
  { name: Schema.String, cause: Schema.Unknown },
) {
  // NOTE: the `name` FIELD shadows `Error.name` on instances — the attempt
  // record's name/message pair is the only diagnostic surface, so the
  // message must carry both the artifact name and the cause (#88).
  override get message(): string {
    return `artifact "${this.name}" upload failed: ${renderCause(this.cause)}`;
  }
}

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  cause: Schema.Unknown,
  /**
   * Optional run-authored failure presentation — markdown the dispatcher
   * renders in the check-run summary instead of fencing `cause` as code.
   * Same contract as `AcceptanceFailed.summaryMd`. Exists for failures that
   * have a rundown worth rendering but no exit code to report: a stage step
   * that DIED (timeout / platform kill) never produced an `ExecResult`, so
   * `AcceptanceFailed` — whose `exitCode` is required and means "the command
   * ran to completion" — cannot carry it honestly.
   */
  summaryMd: Schema.optional(Schema.String),
}) {}

/**
 * The run could not do its job and is bowing out — the work was never
 * attempted-and-failed, it was impossible to attempt: a CAPACITY reason (e.g.
 * pr-review's diff exceeds the model's context window even after truncation)
 * or a repo that never opted in (offload-test with no configured command).
 * The dispatcher concludes the check-run `neutral` with `reason` in the
 * summary instead of `failure`: a review that didn't happen is not a failed
 * review, and a red that isn't actionable trains people to ignore the check.
 */
export class RunSkipped extends Schema.TaggedError<RunSkipped>()("RunSkipped", {
  /** Operator/reader-facing one-liner: why the run was skipped. */
  reason: Schema.String,
}) {
  // Read by `runEffect` (step.ts) and folded into the own-property message of
  // the Error thrown at the Workflow boundary — a prototype getter does not
  // survive that crossing on its own (#80).
  override get message(): string {
    return `run skipped: ${this.reason}`;
  }
}

export class ApprovalTimedOut extends Schema.TaggedError<ApprovalTimedOut>()("ApprovalTimedOut", {
  eventName: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class EventPayloadInvalid extends Schema.TaggedError<EventPayloadInvalid>()(
  "EventPayloadInvalid",
  { eventName: Schema.String, reason: Schema.String },
) {}

export class SecretsMissing extends Schema.TaggedError<SecretsMissing>()("SecretsMissing", {
  keys: Schema.Array(Schema.String),
}) {}

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()("GitHubApiError", {
  status: Schema.Number,
  reason: Schema.Literal("rate-limited", "unauthorized", "transient", "other"),
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    status: Schema.Number,
    reason: Schema.Literal("rate-limited", "unauthorized", "transient", "other"),
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

export class OidcSigningFailed extends Schema.TaggedError<OidcSigningFailed>()(
  "OidcSigningFailed",
  {
    // "key-load" — signing key absent or malformed;
    // "subtle-sign" — WebCrypto SubtleCrypto.sign rejected;
    // "subject-pinned" — the runtime pins this execution's subject and the caller asked for another;
    // "reserved-claim" — `claims` named a registered claim the signer sets (`iss`, `sub`, `aud`, …).
    reason: Schema.Literal("key-load", "subtle-sign", "subject-pinned", "reserved-claim"),
    cause: Schema.Unknown,
  },
) {}

export class StsAssumeRoleFailed extends Schema.TaggedError<StsAssumeRoleFailed>()(
  "StsAssumeRoleFailed",
  {
    provider: Schema.Literal("aws", "gcp", "azure", "other"),
    status: Schema.Number,
    reason: Schema.Literal("mistrusted-issuer", "role-mismatch", "audience-mismatch", "other"),
  },
) {}

/**
 * A `spawnChildRun` could not instantiate a child Workflow instance. Carries
 * the child `run` name and the semantic `instanceId` the spawn targeted so a
 * fan-out parent can report which shard failed to launch. A duplicate
 * instance id is NOT this error — it resolves to `created: false`; this fires
 * only when the platform `create({id})` call itself rejected for another
 * reason (binding missing, rate limit, transport).
 */
export class ChildSpawnFailed extends Schema.TaggedError<ChildSpawnFailed>()("ChildSpawnFailed", {
  run: Schema.String,
  instanceId: Schema.String,
  cause: Schema.Unknown,
}) {}

/**
 * A `waitForChildren` join exceeded its overall wait ceiling with children
 * still pending. Carries the execution ids that had not reached a terminal
 * status and the total time waited, so a fan-out parent can report which shards
 * hung. Distinct from a child that finished `failure` — that is a terminal
 * status the join returns normally; this fires only when children never settle.
 */
export class ChildWaitTimeout extends Schema.TaggedError<ChildWaitTimeout>()("ChildWaitTimeout", {
  pending: Schema.Array(Schema.String),
  waitedMs: Schema.Number,
}) {}

/** The closed union of every error a run can fail with. */
export type RunError =
  | CheckoutFailed
  | ExecFailed
  | ExecTimeout
  | AcceptanceFailed
  | ContainerLaunchFailed
  | ContainerBusy
  | AdmissionTimedOut
  | SerialQueueTimedOut
  | PortNeverOpened
  | ExposePortFailed
  | BrowserUnavailable
  | CacheError
  | ArtifactUploadFailed
  | StepFailed
  | RunSkipped
  | ApprovalTimedOut
  | EventPayloadInvalid
  | SecretsMissing
  | GitHubApiError
  | CloudflareApiError
  | OidcSigningFailed
  | StsAssumeRoleFailed
  | ChildSpawnFailed
  | ChildWaitTimeout;
