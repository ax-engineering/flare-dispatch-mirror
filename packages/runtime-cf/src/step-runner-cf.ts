// @fractalboxdev/flare-dispatch-runtime-cf — StepRunnerCloudflare: the live step boundary.
//
// The production `StepRunner` binding — the CF counterpart to the test
// runtime's `StepRunnerInline`. It backs each `step(name, body, opts)` call
// with a real CF `WorkflowStep.do(name, ...)`, so the step is a durable,
// retryable Workflow checkpoint, and records the `ExecutionsService` lifecycle
// (one `startStep` at entry, one `finishStep` at exit).
//
// --- The runEffect / Workflows boundary, in one place ------------------------
//
// CF Workflows is imperative: `step.do(name, cb)` awaits `cb` as a Promise and
// treats a THROWN error as a step failure (so the platform records it and
// retries). Effect keeps errors in the typed `E` channel and never throws. The
// two are reconciled exactly as specs/03-dsl.md § The runEffect boundary shim
// prescribes:
//
//   1. The body Effect (`Effect<A, E, RunContext>`) has its ambient
//      `RunContext` provided — captured via `Effect.context()` — so it becomes
//      `Effect<A, E, never>`, runnable at the imperative boundary.
//   2. Inside the `step.do` callback, `runEffect` runs that Effect: on success
//      it returns `A`; on a typed failure it THROWS the failure (with the
//      Effect `Cause` attached as `.cause`) so Workflows fails+retries the step.
//   3. When `step.do`'s Promise settles, the runner converts back: success →
//      `Effect.succeed`; rejection → re-fail with the original `Cause` (read
//      off the thrown error) so the typed `E` is preserved end-to-end. A
//      rejection without an Effect `Cause` (an infra failure inside Workflows
//      itself) becomes a `StepFailed`.
//
// Net effect: a run author writes `yield* Effect.fail(...)` inside a step body
// and catches it with `Effect.catchTag` outside — the throw at the Workflow
// boundary is entirely internal to this runner.
//
// Spec: specs/03-dsl.md § step + § The runEffect boundary shim, plan § PR4.

import { ApprovalTimedOut, EventPayloadInvalid } from "@fractalboxdev/flare-dispatch-core";
import { NonRetryableError } from "cloudflare:workflows";
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  Executions,
  type ExecutionsService,
  IO,
  type IOService,
  isEngineInterruptedCause,
  runEffect,
  type RunContext,
  StepFailed,
  type StepOpts,
  StepRunner,
  type StepRunnerService,
} from "@fractalboxdev/flare-dispatch-core";
import { WorkflowEngine } from "./workflow-engine";

/**
 * The subset of CF's `WorkflowStepConfig` the runner sets from `StepOpts`.
 * `timeout` is a CF duration string ("1740 seconds"); `retries` mirrors CF's
 * `{ limit, delay, backoff }`.
 */
type WorkflowStepConfigLike = {
  readonly timeout?: string | number;
  readonly retries?: {
    readonly limit: number;
    readonly delay: string | number;
    readonly backoff?: "constant" | "linear" | "exponential";
  };
};

/**
 * Map a run's `StepOpts` onto a CF `WorkflowStepConfig`. Returns `undefined`
 * when neither a `timeoutSec` nor `retries` is set, so those steps keep the
 * bare `do(name, callback)` call (and CF's defaults). A `timeoutSec` becomes
 * a CF duration string; `retries` becomes a bounded exponential-backoff policy.
 */
export const buildStepConfig = (opts?: StepOpts): WorkflowStepConfigLike | undefined => {
  if (opts === undefined) return undefined;
  const config: {
    timeout?: string;
    retries?: WorkflowStepConfigLike["retries"];
  } = {};
  if (opts.timeoutSec !== undefined) {
    config.timeout = `${opts.timeoutSec} seconds`;
  }
  if (opts.retries !== undefined) {
    config.retries = {
      limit: opts.retries,
      delay: "5 seconds",
      backoff: "exponential",
    };
  }
  return config.timeout === undefined && config.retries === undefined ? undefined : config;
};

/** Workflows retries any thrown Error; `NonRetryableError` is how a step opts out. */
export const rethrowForRetryPolicy = (error: unknown, retryOn?: readonly string[]): unknown => {
  if (retryOn === undefined) return error;
  const tag = errorTagOf(causeOf(error));
  return tag !== undefined && retryOn.includes(tag) ? error : asNonRetryable(error);
};

const asNonRetryable = (error: unknown): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new NonRetryableError(message) as Error & { cause?: unknown };
  wrapped.cause = (error as CausalError)?.cause;
  return wrapped;
};

/** A thrown error carrying an Effect `Cause` — produced by `runEffect`. */
type CausalError = { readonly cause?: unknown };

/** Extract the Effect `Cause` `runEffect` attached to a thrown failure. */
const causeOf = (error: unknown): Cause.Cause<unknown> | undefined => {
  const candidate = (error as CausalError | null | undefined)?.cause;
  return Cause.isCause(candidate) ? candidate : undefined;
};

/** A tagged error's `_tag` from a Cause, via `Option.match` — no raw `._tag`. */
const errorTagOf = (cause: Cause.Cause<unknown> | undefined): string | undefined =>
  cause === undefined
    ? "StepFailed"
    : Option.match(Cause.failureOption(cause), {
        onSome: (failure) => {
          const tag = (failure as { _tag?: unknown })._tag;
          return typeof tag === "string" ? tag : "UnknownError";
        },
        onNone: () => undefined,
      });

/**
 * Build a `StepRunner` Layer backed by the invocation's `WorkflowEngine`.
 * Depends on `Executions` (lifecycle records) and `IO` (deterministic step
 * timestamps), so the resulting Layer requires all three.
 *
 * @param executionId   the execution the `steps` rows are recorded under.
 */
export const makeStepRunnerCloudflare = (
  executionId: string,
): Layer.Layer<StepRunner, never, Executions | IO | WorkflowEngine> =>
  Layer.effect(
    StepRunner,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const executions: ExecutionsService = yield* Executions;
      const ioSvc: IOService = yield* IO;

      const service: StepRunnerService = {
        sleep: (name, milliseconds) =>
          engine.sleep(name, milliseconds, (cause) => new StepFailed({ step: name, cause })),
        run: (name, body, stepOpts) =>
          Effect.gen(function* () {
            // Capture the ambient RunContext so the body — which still needs
            // its capabilities — can be run at the imperative `step.do`
            // boundary, where the Effect's `R` must be `never`.
            const context = yield* Effect.context<RunContext>();

            const startedAt = yield* ioSvc.now;
            yield* executions.startStep({
              executionId,
              name,
              startedAt,
              metadata: stepOpts?.metadata,
            });

            // Drive the body through the durable Workflow checkpoint. The
            // `step.do` callback runs the (context-provided) body via the
            // `runEffect` shim — which throws a typed failure so Workflows
            // records+retries it. `Effect.tryPromise` brings the settled
            // Promise back: a rejection lands in the failure channel as
            // `{ error }`, so failure is data the match below branches on.
            //
            // Pass the per-step CF config (timeout/retries) when the run set
            // one — otherwise the bare `do(name, callback)` keeps CF's
            // defaults (notably the 10-minute step timeout). A long step like
            // the acceptance suite raises its ceiling via `StepOpts.timeoutSec`.
            const stepConfig = buildStepConfig(stepOpts);
            const retryOn = stepOpts?.retryOn;
            const runBody = () =>
              runEffect(Effect.provide(body(), context)).catch((error: unknown) => {
                throw rethrowForRetryPolicy(error, retryOn);
              });
            // An engine interruption dies here, before `finishStep`: the
            // invocation that saw it writes no `steps` row the replay would
            // contradict.
            const exit = yield* Effect.exit(
              engine.do(
                name,
                runBody,
                (error): { readonly error: unknown } => ({ error }),
                stepConfig,
              ),
            );
            // A die carries no typed failure, so the cause narrows to `never`.
            if (Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause)) {
              return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
            }

            const completedAt = yield* ioSvc.now;

            return yield* Exit.match(exit, {
              onSuccess: (value) =>
                executions
                  .finishStep({
                    executionId,
                    name,
                    completedAt,
                    status: "success",
                  })
                  .pipe(Effect.as(value)),

              onFailure: (failCause) => {
                // `tryPromise`'s `catch` wrapped the rejection as `{ error }`
                // in the failure channel — recover the real thrown error.
                const thrown = Option.match(Cause.failureOption(failCause), {
                  onSome: (wrapped) => (wrapped as { error: unknown }).error,
                  onNone: () => undefined,
                });

                // The Effect Cause `runEffect` preserved on the thrown error:
                // re-failing with it keeps the typed `E` channel intact across
                // the Workflow boundary. No Cause ⇒ a Workflows-internal infra
                // failure (or `tryPromise` defect) ⇒ surface as `StepFailed`.
                const original = causeOf(thrown);
                const reFail =
                  original === undefined
                    ? Effect.fail(
                        new StepFailed({
                          step: name,
                          cause: thrown ?? failCause,
                        }),
                      )
                    : Effect.failCause(original as Cause.Cause<never>);

                return executions
                  .finishStep({
                    executionId,
                    name,
                    completedAt,
                    status: "failure",
                    errorTag: errorTagOf(original),
                  })
                  .pipe(Effect.andThen(reFail));
              },
            });
          }),

        // `step.waitForEvent` (specs/03-dsl.md § Human-in-the-loop):
        //   - Pre-flight: if the platform doesn't expose `waitForEvent`,
        //     fail with `ApprovalTimedOut` immediately (better than dying
        //     mid-Workflow on a stale Workers runtime).
        //   - On settle: decode the inbound `event.payload` against the
        //     run's `payloadSchema`; mismatch → `EventPayloadInvalid`.
        //   - On reject: read GitHub-shaped "timeout" rejections as
        //     `ApprovalTimedOut`; anything else surfaces as
        //     `EventPayloadInvalid` (the safer choice — a corrupted event
        //     surface in production is a bug, not a wait-longer condition).
        waitForEvent: (name, { type, timeout, payloadSchema }) =>
          Option.match(engine.waitForEvent, {
            onNone: () => {
              const timeoutMs = Duration.toMillis(
                Duration.decode(timeout as Duration.DurationInput),
              );
              return Effect.fail(new ApprovalTimedOut({ eventName: type, timeoutMs }));
            },
            onSome: (wait) => {
              const timeoutMs = Duration.toMillis(
                Duration.decode(timeout as Duration.DurationInput),
              );
              // CF Workflows `waitForEvent` accepts either an ISO-8601 duration
              // string or a number-of-seconds. Pass ms-converted-to-seconds for
              // unambiguous behaviour across runtime versions.
              return wait(
                name,
                {
                  type,
                  timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
                },
                (cause) => {
                  const message = cause instanceof Error ? cause.message : String(cause);
                  if (/timeout|timed[- ]?out/i.test(message)) {
                    return new ApprovalTimedOut({
                      eventName: type,
                      timeoutMs,
                    }) as ApprovalTimedOut | EventPayloadInvalid;
                  }
                  return new EventPayloadInvalid({
                    eventName: type,
                    reason: message,
                  });
                },
              ).pipe(
                Effect.flatMap((event) => {
                  const decoded = Schema.decodeUnknownEither(payloadSchema)(event.payload);
                  if (decoded._tag === "Left") {
                    return Effect.fail(
                      new EventPayloadInvalid({
                        eventName: type,
                        reason: "decode failed",
                      }),
                    );
                  }
                  return Effect.succeed(decoded.right);
                }),
              );
            },
          }),
      };

      return service;
    }),
  );
