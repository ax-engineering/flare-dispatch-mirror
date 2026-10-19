import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { ChildStatusRecord } from "../services/child-runs";
import { IOFake, makeChildRunsFake, makeCFRuntimeTest } from "../testing";
import { IO } from "../services/io";
import { StepRunner, type StepRunnerService } from "../services/step-runner";
import { StepFailed } from "../errors";
import type { RunContext } from "../context";
import { waitForAnyChildDurably, waitForChildren, waitForChildrenDurably } from "./wait-for-children";

/** Run `waitForChildren` against a ChildRuns fake + the (no-op-sleep) IO fake. */
const run = (
  opts: Parameters<typeof waitForChildren>[0],
  fakeOpts: Parameters<typeof makeChildRunsFake>[0],
) => {
  const child = makeChildRunsFake(fakeOpts);
  return {
    child,
    exit: Effect.runPromiseExit(
      waitForChildren(opts).pipe(Effect.provide(Layer.merge(child.layer, IOFake))),
    ),
  };
};

describe("waitForChildren", () => {
  it("returns immediately when every child is already terminal", async () => {
    const { child, exit } = run(
      { ids: ["a", "b"] },
      {
        statuses: {
          a: { status: "success", summaryJson: '{"ok":1}' },
          b: "failure",
        },
      },
    );
    const result = await exit;

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual([
        { executionId: "a", status: "success", summaryJson: '{"ok":1}' },
        { executionId: "b", status: "failure" },
      ]);
    }
    // One poll — no sleep loop needed.
    expect(child.state.polls).toBe(1);
  });

  it("polls until pending children settle, then returns their records", async () => {
    // call 0: both running; call 1: a done; call 2: both done.
    const flip = (ids: readonly string[], call: number): readonly ChildStatusRecord[] =>
      ids.map((id) => {
        if (call >= 2) return { executionId: id, status: "success" };
        if (call === 1 && id === "a") return { executionId: id, status: "success" };
        return { executionId: id, status: "running" };
      });

    const { child, exit } = run(
      { ids: ["a", "b"], pollEvery: "10 millis", timeout: "1 minute" },
      { pollFn: flip },
    );
    const result = await exit;

    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.map((r) => r.status)).toEqual(["success", "success"]);
    }
    // Polled 3 times (calls 0,1,2) before all terminal.
    expect(child.state.polls).toBe(3);
  });

  it("fails ChildWaitTimeout with the still-pending ids when the ceiling elapses", async () => {
    const { exit } = run(
      // timeout/pollEvery = 30ms/10ms → 3 attempts, none terminal.
      { ids: ["a", "b"], pollEvery: "10 millis", timeout: "30 millis" },
      { statuses: { a: "success", b: "running" } },
    );
    const result = await exit;

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const err = result.cause.toString();
      expect(err).toContain("ChildWaitTimeout");
      // Only the never-terminal child is reported pending.
      expect(err).toContain("b");
    }
  });

  it("is a no-op for an empty id list", async () => {
    const { child, exit } = run({ ids: [] }, {});
    const result = await exit;
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) expect(result.value).toEqual([]);
    // Never polled.
    expect(child.state.polls).toBe(0);
  });
});

describe("waitForChildrenDurably", () => {
  const fixture = (poll: (ids: readonly string[], clock: { now: number }) => readonly ChildStatusRecord[]) => {
    const clock = { now: 0 };
    const sleeps: number[] = [];
    const checkpoints = new Map<string, unknown>();
    let interruptSleep = false;
    const { layer, handles } = makeCFRuntimeTest({ childRuns: { pollFn: (ids) => poll(ids, clock) } });
    const program = (timeout = 100) => Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const io = yield* IO;
      const runner: StepRunnerService = {
        ...ordinary,
        run: <A, E>(name: string, body: () => Effect.Effect<A, E, RunContext>) =>
          checkpoints.has(name) ? Effect.succeed(checkpoints.get(name) as A)
            : body().pipe(Effect.tap((value) => Effect.sync(() => { checkpoints.set(name, value); }))),
        sleep: (name, ms) => Effect.suspend(() => {
          if (interruptSleep) return Effect.fail(new StepFailed({ step: name, cause: "interrupted" }));
          sleeps.push(ms);
          clock.now += ms;
          return Effect.void;
        }),
      };
      return yield* waitForChildrenDurably({ name: "join", ids: ["a", "b"], timeout, pollEvery: 40 }).pipe(
        Effect.provideService(StepRunner, runner), Effect.provideService(IO, { ...io, now: Effect.sync(() => clock.now) }),
      );
    }).pipe(Effect.provide(layer));
    return { clock, sleeps, handles, program, interrupt: () => { interruptSleep = true; }, resume: () => { interruptSleep = false; } };
  };

  it("returns terminal failures in input order and preserves summaries", async () => {
    const f = fixture(() => [{ executionId: "b", status: "failure" }, { executionId: "a", status: "success", summaryJson: "{}" }]);
    const result = await Effect.runPromise(f.program());
    expect(result.map((record) => record.executionId)).toEqual(["a", "b"]);
    expect(result[0]?.summaryJson).toBe("{}");
    expect(result[1]?.status).toBe("failure");
    expect(f.sleeps).toEqual([]);
  });

  it("refuses missing records at the original deadline and bounds the final sleep", async () => {
    const f = fixture(() => [{ executionId: "a", status: "success" }]);
    const exit = await Effect.runPromiseExit(f.program());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ChildWaitTimeout");
    expect(f.sleeps).toEqual([40, 40, 20]);
    expect(f.clock.now).toBe(100);
  });

  it("refuses a terminal result whose status read crosses the deadline", async () => {
    const f = fixture((ids, clock) => { clock.now = 101; return ids.map((executionId) => ({ executionId, status: "success" })); });
    const exit = await Effect.runPromiseExit(f.program());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ChildWaitTimeout");
  });

  it("replays the persisted deadline instead of renewing it after interruption", async () => {
    const f = fixture((ids, clock) => ids.map((executionId) => ({ executionId, status: clock.now > 100 ? "success" : "running" })));
    f.interrupt();
    expect(Exit.isFailure(await Effect.runPromiseExit(f.program()))).toBe(true);
    f.clock.now = 200;
    f.resume();
    const exit = await Effect.runPromiseExit(f.program());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ChildWaitTimeout");
    expect(f.handles.childRuns.polls).toBe(1);
  });
});

describe("waitForAnyChildDurably", () => {
  const fixture = (poll: (ids: readonly string[], clock: { now: number }) => readonly ChildStatusRecord[]) => {
    const clock = { now: 0 };
    const sleeps: number[] = [];
    const { layer, handles } = makeCFRuntimeTest({ childRuns: { pollFn: (ids) => poll(ids, clock) } });
    const program = (expiresAt = 100) => Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const io = yield* IO;
      const runner: StepRunnerService = {
        ...ordinary,
        sleep: (_name, ms) => Effect.sync(() => { sleeps.push(ms); clock.now += ms; }),
      };
      return yield* waitForAnyChildDurably({ name: "slot", ids: ["a", "b", "c"], expiresAt, pollEvery: 40 }).pipe(
        Effect.provideService(StepRunner, runner), Effect.provideService(IO, { ...io, now: Effect.sync(() => clock.now) }),
      );
    }).pipe(Effect.provide(layer));
    return { clock, sleeps, handles, program };
  };

  it("returns as soon as one child settles, with every record in input order", async () => {
    const f = fixture((ids, clock) => ids.map((executionId) => ({
      executionId, status: executionId === "b" && clock.now >= 40 ? "failure" : "running",
    })));
    const result = await Effect.runPromise(f.program());
    expect(result.map((record) => [record.executionId, record.status])).toEqual([
      ["a", "running"], ["b", "failure"], ["c", "running"],
    ]);
    expect(f.sleeps).toEqual([40]);
  });

  it("fails ChildWaitTimeout at the caller's deadline when nothing settles", async () => {
    const f = fixture((ids) => ids.map((executionId) => ({ executionId, status: "running" })));
    const exit = await Effect.runPromiseExit(f.program(100));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ChildWaitTimeout");
    expect(f.sleeps).toEqual([40, 40, 20]);
  });

  it("bounds its polls when the clock never advances", async () => {
    const { layer, handles } = makeCFRuntimeTest({
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "running" })) },
    });
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const io = yield* IO;
      return yield* waitForAnyChildDurably({ name: "slot", ids: ["a"], expiresAt: 200, pollEvery: 100 }).pipe(
        Effect.provideService(StepRunner, { ...ordinary, sleep: () => Effect.void }),
        Effect.provideService(IO, { ...io, now: Effect.succeed(0) }),
      );
    }).pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(handles.childRuns.polls).toBe(3);
  });
});
