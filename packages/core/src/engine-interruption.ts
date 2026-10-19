// @fractalboxdev/flare-dispatch-core — an engine interruption is not a verdict.
//
// When the durable engine loses its connection to an instance mid-step, the
// pending step call rejects in the invocation that is still running, and the
// engine restarts the instance from its last checkpoint. The invocation that
// saw the rejection must not decide anything: a terminal row or a concluded
// check-run written from it reads as the run's verdict while the replay keeps
// running, and a fan-out parent counts the part failed.
//
// The runtime classifies the rejection once, at the step API boundary, and
// raises it as an `EngineInterrupted` DEFECT — never a typed failure. A typed
// failure is something a run handles: `catchTag`, `either`, `retry` and
// `orElse` would all act on it, and a run body would take the dead
// invocation's half-step as a fact. A defect passes every one of them, so it
// reaches the dispatcher's exit unchanged however the run composed its steps,
// and the dispatcher ends the invocation without writing anything.

import { Cause, Chunk, Exit, Schema } from "effect";

export class EngineInterrupted extends Schema.TaggedError<EngineInterrupted>()(
  "EngineInterrupted",
  {
    /** The durable step whose call the engine rejected. */
    step: Schema.String,
    /** The engine's own rejection message. */
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `the engine lost the instance during step ${this.step} — the replay owns the verdict (${this.reason})`;
  }
}

/** True when any defect in `cause` — sequential, parallel or nested — is an engine interruption. */
export const isEngineInterruptedCause = (cause: Cause.Cause<unknown>): boolean =>
  Chunk.some(Cause.defects(cause), (defect) => defect instanceof EngineInterrupted);

/** True when the run's exit is an engine interruption rather than a verdict. */
export const isEngineInterruption = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause);
