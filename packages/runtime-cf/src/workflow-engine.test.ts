import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  EngineInterrupted,
  EventPayloadInvalid,
  isEngineInterruptedCause,
  StepFailed,
  StepRunner,
} from "@fractalboxdev/flare-dispatch-core";
import { makeExecutionsFake, makeIOFake } from "@fractalboxdev/flare-dispatch-core/testing";
import { makeStepRunnerCloudflare } from "./step-runner-cf";
import { makeWorkflowEngine, WorkflowEngine, type WorkflowStepLike } from "./workflow-engine";

const inactive =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";
const reset = "Durable Object reset because its code was updated.";

const engineRejects = (message: string) => ({
  do: (): Promise<never> => Promise.reject(new Error(message)),
  sleep: (): Promise<never> => Promise.reject(new Error(message)),
  waitForEvent: (): Promise<never> => Promise.reject(new Error(message)),
});

/** A live engine: `do` runs the callback and rejects with its error, as Workflows does. */
const liveEngine = {
  do: <T>(_name: string, cb: () => Promise<T>): Promise<T> => cb(),
};

const toStepFailed = (step: string) => (cause: unknown) => new StepFailed({ step, cause });
const interrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && isEngineInterruptedCause(exit.cause);

const runnerOver = (step: WorkflowStepLike) => {
  const executions = makeExecutionsFake();
  const layer = makeStepRunnerCloudflare("exec-1").pipe(
    Layer.provide(Layer.mergeAll(executions.layer, makeIOFake().layer, WorkflowEngine.layer(step))),
  );
  return { layer, executions: executions.state };
};

describe("WorkflowEngine", () => {
  it.effect("an engine rejection dies EngineInterrupted, past catchTag, either and retry", () =>
    Effect.gen(function* () {
      const engine = yield* makeWorkflowEngine(engineRejects(inactive));
      const exit = yield* Effect.exit(
        engine
          .do("open", async () => 1, toStepFailed("open"))
          .pipe(
            Effect.retry({ times: 2 }),
            Effect.catchTag("StepFailed", () => Effect.succeed(0)),
            Effect.either,
          ),
      );
      expect(interrupted(exit)).toBe(true);
    }),
  );

  it.effect("any other rejection is the caller's typed failure and leaves the engine open", () =>
    Effect.gen(function* () {
      let calls = 0;
      const engine = yield* makeWorkflowEngine({
        do: <T>(_name: string, cb: () => Promise<T>): Promise<T> =>
          ++calls === 1 ? Promise.reject(new Error("boom")) : cb(),
      });
      const exit = yield* Effect.exit(engine.do("a", async () => 1, toStepFailed("a")));
      expect(interrupted(exit)).toBe(false);
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.failureOption(exit.cause))).toBeInstanceOf(StepFailed);
      expect(yield* engine.do("b", async () => 2, toStepFailed("b"))).toBe(2);
      expect(yield* engine.lost).toBe(false);
    }),
  );

  it.effect(
    "latches on the first engine rejection: later calls die without reaching the platform",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const engine = yield* makeWorkflowEngine({
          do: <T>(_name: string, cb: () => Promise<T>): Promise<T> =>
            ++calls === 1 ? Promise.reject(new Error(reset)) : cb(),
          sleep: async () => void calls++,
        });
        // A run body that recovers every cause still cannot carry on deciding.
        yield* engine
          .do("a", async () => 1, toStepFailed("a"))
          .pipe(Effect.catchAllCause(() => Effect.void));
        expect(yield* engine.lost).toBe(true);
        const later = yield* Effect.exit(engine.sleep("b", 1000, toStepFailed("b")));
        expect(interrupted(later)).toBe(true);
        expect(calls).toBe(1);
      }),
  );
});

describe("a step body that quotes the engine", () => {
  it.effect("is the body's failure: the engine stays open and the call fails typed", () =>
    Effect.gen(function* () {
      const engine = yield* makeWorkflowEngine(liveEngine);
      const exit = yield* Effect.exit(
        engine.do(
          "exec-start",
          () => Promise.reject(new Error(`ExecFailed: ${reset}`)),
          toStepFailed("exec-start"),
        ),
      );
      expect(interrupted(exit)).toBe(false);
      expect(yield* engine.lost).toBe(false);
      expect(yield* engine.do("next", async () => 1, toStepFailed("next"))).toBe(1);
    }),
  );

  it.effect("an engine loss after a failed attempt is still an interruption", () =>
    Effect.gen(function* () {
      // Attempt 1 throws; the engine then dies during the retry backoff.
      const engine = yield* makeWorkflowEngine({
        do: async <T>(_name: string, cb: () => Promise<T>): Promise<T> => {
          await cb().catch(() => undefined);
          throw new Error(inactive);
        },
      });
      const exit = yield* Effect.exit(
        engine.do(
          "exec-start",
          () => Promise.reject(new Error("transient")),
          toStepFailed("exec-start"),
        ),
      );
      expect(interrupted(exit)).toBe(true);
      expect(yield* engine.lost).toBe(true);
    }),
  );

  it.effect(
    "the callback receives the platform's arguments, and its rejection reaches the platform unchanged",
    () =>
      Effect.gen(function* () {
        const thrown = new Error("own");
        let seen: unknown;
        const engine = yield* makeWorkflowEngine({
          do: <T>(_name: string, cb: () => Promise<T>): Promise<T> =>
            (cb as (ctx: string) => Promise<T>)("attempt-1").catch((error: unknown) => {
              seen = error;
              throw error;
            }),
        });
        expect(yield* engine.do("s", async (ctx) => ctx, toStepFailed("s"))).toBe("attempt-1");
        yield* Effect.exit(engine.do("t", () => Promise.reject(thrown), toStepFailed("t")));
        expect(seen).toBe(thrown);
      }),
  );

  it.effect("reaches the run as its typed failure through StepRunnerCloudflare", () => {
    const { layer, executions } = runnerOver(liveEngine);
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(
        runner.run("exec-start", () =>
          Effect.fail(new StepFailed({ step: "sandbox", cause: inactive })),
        ) as Effect.Effect<never, StepFailed>,
      );
      expect(interrupted(exit)).toBe(false);
      expect(executions.steps[0]?.status).toBe("failure");
    }).pipe(Effect.provide(layer));
  });
});

describe("StepRunnerCloudflare on an engine rejection", () => {
  it.effect("run dies EngineInterrupted and records no failed step", () => {
    const { layer, executions } = runnerOver(engineRejects(inactive));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      // The rejection lands before the body runs, so no capability is read.
      const exit = yield* Effect.exit(
        runner.run("exec-start", () => Effect.succeed(1)) as Effect.Effect<number, StepFailed>,
      );
      expect(interrupted(exit)).toBe(true);
      expect(executions.steps.filter((s) => s.status === "failure")).toHaveLength(0);
      expect(executions.steps[0]?.completedAt).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("sleep dies EngineInterrupted, not StepFailed", () => {
    const { layer } = runnerOver(engineRejects(inactive));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(runner.sleep!("exec-sleep-0", 5000));
      expect(interrupted(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("waitForEvent dies EngineInterrupted, not EventPayloadInvalid", () => {
    const { layer } = runnerOver(engineRejects(reset));
    return Effect.gen(function* () {
      const runner = yield* StepRunner;
      const exit = yield* Effect.exit(
        runner.waitForEvent("approval", {
          type: "approve",
          timeout: "1 hour",
          payloadSchema: Schema.Unknown,
        }) as Effect.Effect<unknown, unknown>,
      );
      expect(interrupted(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Option.isNone(Cause.failureOption(exit.cause))).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("EngineInterrupted", () => {
  it("is found anywhere in a composite cause, and a typed failure quoting the message is not", () => {
    const lost = Cause.die(new EngineInterrupted({ step: "s", reason: inactive }));
    expect(isEngineInterruptedCause(Cause.parallel(Cause.fail("other"), lost))).toBe(true);
    expect(
      isEngineInterruptedCause(
        Cause.fail(new EventPayloadInvalid({ eventName: "e", reason: inactive })),
      ),
    ).toBe(false);
    expect(isEngineInterruptedCause(Cause.die(new Error(inactive)))).toBe(false);
  });
});
