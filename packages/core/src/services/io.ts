// @fractalboxdev/flare-dispatch-core — the `io` capability (non-deterministic primitives).
//
// Effect-friendly access to time, UUIDs, env, sleep, structured logging, and
// prior-execution metadata. Must be used instead of `Date.now()` /
// `crypto.randomUUID()` / `process.env` so Workflow step replay is
// deterministic.
//
// Spec: specs/03-dsl.md § io.

import { Context, type Duration, Effect, type Option, type Schema } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * `io.env` keys the dispatcher answers for every execution: when the Workflow
 * engine created this instance (ISO 8601), and the Worker version running this
 * invocation. Comparing the two tells an operator whether an instance created
 * before a deploy runs the deployed code.
 */
export const EXECUTION_CREATED_AT_ENV = "FLARE_DISPATCH_EXECUTION_CREATED_AT";
export const DEPLOYED_VERSION_ENV = "FLARE_DISPATCH_DEPLOYED_VERSION";

/** The most recent terminal execution in a run's semantic family. */
export type PriorExecution<O> = {
  readonly executionId: string;
  readonly sha: string;
  readonly output: O;
  readonly finishedAt: number; // epoch ms
};

export interface IOService {
  readonly now: Effect.Effect<number>;
  readonly uuid: Effect.Effect<string>;
  /**
   * THIS execution's id — which is also the Workflow `instanceId`
   * (`RUNS_WORKFLOW.create({ id: executionId })`). A run reads it to correlate
   * an external surface back to itself: e.g. the `release-notes` run embeds it
   * in the release-PR body so the webhook can `sendEvent` to the exact paused
   * instance on merge/label. `""` when no per-execution id is wired (a bare
   * stand-alone IO layer).
   */
  readonly executionId: Effect.Effect<string>;
  readonly env: (key: string) => Effect.Effect<string | undefined>;
  readonly sleep: (d: Duration.Duration | string) => Effect.Effect<void>;
  readonly log: (
    level: LogLevel,
    msg: string,
    attrs?: Record<string, unknown>,
  ) => Effect.Effect<void>;
  // The schema's encoded type `I` is left free — the prior output is decoded
  // from stored JSON (`unknown`), so `I` is irrelevant to the caller.
  readonly priorExecution: <O, I>(opts: {
    family: string;
    outputSchema: Schema.Schema<O, I>;
  }) => Effect.Effect<Option.Option<PriorExecution<O>>>;
  /**
   * The tokened log-viewer base URL for THIS execution
   * (`https://<origin>/logs/<id>?t=<token>`) — the readable surface that, since
   * the artifact work in #137, also lists a run's produced artifacts (e.g.
   * `pr-review`'s reviewed diff). A run reads it to deep-link its own
   * human-facing output (a PR comment) back to the full logs. `Option.none()`
   * when the deploy has no public origin or no log-link key material — the run
   * then renders its link-less historical form. Minted by the dispatcher (it
   * owns the log-token secret); a run can only read it, never forge it.
   */
  readonly viewerUrl: Effect.Effect<Option.Option<string>>;
}

export class IO extends Context.Tag("@fractalboxdev/flare-dispatch-core/IO")<IO, IOService>() {}

export const io = {
  now: Effect.flatMap(IO, (s) => s.now),
  uuid: Effect.flatMap(IO, (s) => s.uuid),
  executionId: Effect.flatMap(IO, (s) => s.executionId),
  env: (key: string) => Effect.flatMap(IO, (s) => s.env(key)),
  sleep: (d: Duration.Duration | string) => Effect.flatMap(IO, (s) => s.sleep(d)),
  log: (level: LogLevel, msg: string, attrs?: Record<string, unknown>) =>
    Effect.flatMap(IO, (s) => s.log(level, msg, attrs)),
  priorExecution: <O, I>(opts: { family: string; outputSchema: Schema.Schema<O, I> }) =>
    Effect.flatMap(IO, (s) => s.priorExecution(opts)),
  viewerUrl: Effect.flatMap(IO, (s) => s.viewerUrl),
} as const;
