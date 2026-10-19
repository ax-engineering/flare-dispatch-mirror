// @fractalboxdev/flare-dispatch-runtime-cf — the one door into a Workflows step API.
//
// `WorkflowEngine` is the invocation's `WorkflowStep` as an Effect service.
// Every `step.do` / `step.sleep` / `step.waitForEvent` call goes through it,
// and it reads each rejection while it is still the raw error the engine
// raised. That is the only place it can be read reliably: past this point an
// Effect wrapper (`tryPromise`'s `UnknownException`, a `StepFailed`, a
// `FiberFailure`) owns its message, and a classifier downstream ends up
// unwrapping chains of guesses.
//
// An engine rejection becomes the `EngineInterrupted` defect (see core's
// engine-interruption.ts for why a defect and not a failure); every other
// rejection is the caller's to map with `onReject`.
//
// The loss belongs to the invocation, not to the step that saw it. A run may
// recover any cause of a best-effort step (`catchAllCause` around an upload or
// a PR comment), which would recover the interruption with it and carry on
// deciding. So the engine latches the first interruption in a `Ref`: every
// later call dies with it without reaching the platform, and `lost` lets the
// dispatcher withhold the verdict even when a run body swallowed the defect
// and returned.

import { EngineInterrupted } from "@fractalboxdev/flare-dispatch-core";
import { Context, Effect, Either, Layer, Option, Ref, Runtime, identity } from "effect";

/** Messages the runtime raises when an instance's Durable Object goes away. */
const ENGINE_GONE = [
  /Durable Object instance is no longer active/i,
  /Durable Object reset because its code was updated/i,
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** True when `error` carries one of the engine's instance-loss messages. */
export const isEngineGone = (error: unknown): error is Error =>
  error instanceof Error && ENGINE_GONE.some((pattern) => pattern.test(error.message));

/** A step body as `step.do` calls it; the platform may pass it arguments. */
export type StepCallback<A> = (...args: ReadonlyArray<unknown>) => Promise<A>;

/** What `waitForEvent` waits on; `timeout` is in seconds. */
export type WaitForEventOptions = { readonly type: string; readonly timeout: number };

/** The minimal `WorkflowStep` surface the engine drives. */
export type WorkflowStepLike = {
  readonly do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
  readonly sleep?: (name: string, milliseconds: number) => Promise<void>;
  readonly waitForEvent?: (
    name: string,
    opts: WaitForEventOptions,
  ) => Promise<{ type: string; payload: unknown }>;
};

/** CF's `do(name, config, callback)` overload, which `WorkflowStepLike` leaves out. */
type DoWithConfig = <T>(name: string, config: object, callback: StepCallback<T>) => Promise<T>;

export interface WorkflowEngineService {
  /** `step.do(name, [config,] callback)`. */
  readonly do: <A, E>(
    name: string,
    callback: StepCallback<A>,
    onReject: (error: unknown) => E,
    config?: object,
  ) => Effect.Effect<A, E>;
  /** `step.sleep(name, ms)`; a platform without durable sleep rejects. */
  readonly sleep: <E>(
    name: string,
    milliseconds: number,
    onReject: (error: unknown) => E,
  ) => Effect.Effect<void, E>;
  /** `step.waitForEvent`, or `None` on a runtime that does not expose it. */
  readonly waitForEvent: Option.Option<
    <E>(
      name: string,
      opts: WaitForEventOptions,
      onReject: (error: unknown) => E,
    ) => Effect.Effect<{ type: string; payload: unknown }, E>
  >;
  /** True once any call on this invocation saw the engine lose the instance. */
  readonly lost: Effect.Effect<boolean>;
}

export class WorkflowEngine extends Context.Tag(
  "@fractalboxdev/flare-dispatch-runtime-cf/WorkflowEngine",
)<WorkflowEngine, WorkflowEngineService>() {
  static readonly layer = (step: WorkflowStepLike): Layer.Layer<WorkflowEngine> =>
    Layer.effect(WorkflowEngine, makeWorkflowEngine(step));
}

/** Build the engine over one invocation's `step`; the latch lives exactly as long. */
export const makeWorkflowEngine = (step: WorkflowStepLike): Effect.Effect<WorkflowEngineService> =>
  Effect.gen(function* () {
    const latch = yield* Ref.make(Option.none<EngineInterrupted>());
    const runPromise = Runtime.runPromise(yield* Effect.runtime<never>());

    /**
     * Call the platform once. `invoke` receives `track`, which wraps a step
     * callback to record the message of its latest throw.
     *
     * When a callback fails, `step.do` rejects with the callback's error (name
     * and message only). A body whose own Durable Object call failed — a
     * Sandbox reset by a deploy — quotes the engine's words while the engine is
     * alive; classifying that as an interruption would leave the run `running`
     * forever, because nothing replays an instance whose engine never left. An
     * engine loss during a retry backoff carries the engine's own message, so
     * matching the message, not "an attempt threw", keeps that loss an
     * interruption.
     */
    const call = <A, E>(
      name: string,
      invoke: (track: <T>(callback: StepCallback<T>) => StepCallback<T>) => Promise<A>,
      onReject: (error: unknown) => E,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const latched = yield* Ref.get(latch);
        if (Option.isSome(latched)) return yield* Effect.die(latched.value);

        const bodyFailure = yield* Ref.make(Option.none<string>());
        // The attempt's own rejection must reach the platform unchanged, so the
        // Effect settles to an `Either` and the promise rethrows its left.
        const track =
          <T>(callback: StepCallback<T>): StepCallback<T> =>
          (...args) =>
            runPromise(
              Effect.tryPromise({ try: () => callback(...args), catch: identity }).pipe(
                Effect.tapError((error) => Ref.set(bodyFailure, Option.some(messageOf(error)))),
                Effect.either,
              ),
            ).then(Either.getOrThrowWith(identity));

        return yield* Effect.tryPromise({ try: () => invoke(track), catch: identity }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const thrownByBody = Option.contains(yield* Ref.get(bodyFailure), messageOf(error));
              if (thrownByBody || !isEngineGone(error)) return yield* Effect.fail(onReject(error));
              const interrupted = new EngineInterrupted({ step: name, reason: error.message });
              yield* Ref.set(latch, Option.some(interrupted));
              return yield* Effect.die(interrupted);
            }),
          ),
        );
      });

    return {
      do: (name, callback, onReject, config) =>
        call(
          name,
          (track) =>
            config === undefined
              ? step.do(name, track(callback))
              : (step.do as unknown as DoWithConfig)(name, config, track(callback)),
          onReject,
        ),
      sleep: (name, milliseconds, onReject) =>
        call(
          name,
          async () => {
            if (step.sleep === undefined) throw new Error("Workflow durable sleep is unavailable");
            await step.sleep(name, milliseconds);
          },
          onReject,
        ),
      waitForEvent: Option.fromNullable(step.waitForEvent).pipe(
        Option.map(
          (wait) =>
            <E>(name: string, opts: WaitForEventOptions, onReject: (error: unknown) => E) =>
              call(name, () => wait.call(step, name, opts), onReject),
        ),
      ),
      lost: Effect.map(Ref.get(latch), Option.isSome),
    };
  });
