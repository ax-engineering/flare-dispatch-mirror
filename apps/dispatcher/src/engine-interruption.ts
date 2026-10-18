// An engine interruption is not a verdict.
//
// When the Workflows engine loses the connection to an instance mid-step, the
// pending `step.do` rejects in the invocation that is still running — with a
// plain Error and no Effect Cause, because the step body never produced it. The
// engine then restarts the instance from its last checkpoint. The invocation
// that saw the rejection cannot record anything durable: a terminal row and a
// concluded check-run written from it read as the run's verdict while the
// replay keeps running, and a fan-out parent counts the part failed.
//
// `RunWorkflow` rethrows such an exit instead of finishing the execution, and
// the replay reaches the terminal path on its own.

import { Cause, Exit, Option } from "effect";
import { StepFailed } from "@fractalboxdev/flare-dispatch-core";

/** Messages the runtime raises when an instance's Durable Object goes away. */
const ENGINE_GONE = [
  /Durable Object instance is no longer active/i,
  /Durable Object reset because its code was updated/i,
];

const isEngineGone = (error: unknown): boolean =>
  error instanceof Error && ENGINE_GONE.some((pattern) => pattern.test(error.message));

/**
 * True when the run's exit is a durable-step rejection the engine raised as
 * its instance went away: a `StepFailed` carrying the raw rejection (the step
 * runner's no-Cause path) or a raw durable step that died with it.
 */
export const isEngineInterruption = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.match(exit, {
    onSuccess: () => false,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onSome: (failure) => failure instanceof StepFailed && isEngineGone(failure.cause),
        onNone: () =>
          Option.match(Cause.dieOption(cause), {
            onSome: isEngineGone,
            onNone: () => false,
          }),
      }),
  });
