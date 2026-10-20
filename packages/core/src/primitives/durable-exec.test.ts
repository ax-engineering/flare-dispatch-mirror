import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import { Sandbox, type CheckCommandService } from "../services/sandbox";
import { makeCFRuntimeTest } from "../testing";
import { durableExec, pollDelayMs } from "./durable-exec";

const ws = { container: { id: "fake-container" }, dir: "/workspace/repo" };
const exec = (timeoutSec: number) => () => ({
  command: ["cargo", "build"],
  redactValues: [],
  timeoutSec,
});

/** An owner whose process never leaves `running`; counts observations. */
const neverExits = (calls: string[]): CheckCommandService => ({
  prepare: (opts) =>
    Effect.succeed({ id: opts.stepName, container: opts.container!, fingerprint: "f", startedAt: 0, deadline: 1 }),
  start: () => Effect.void,
  observe: () => Effect.sync(() => (calls.push("observe"), { state: "running" as const })),
  finalize: () =>
    Effect.succeed({ exitCode: 0, durationMs: 1, logPath: "logs/x", stdout: "", stderr: "" }),
});

describe("durableExec", () => {
  it("backs polls off from 5 s to a 60 s ceiling", () => {
    expect([0, 11, 12, 24, 36, 48, 500].map(pollDelayMs)).toEqual([
      5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });

  it.effect("a four-hour command spends a few hundred steps, well inside the instance step cap", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      const running = yield* Effect.fork(
        durableExec({ name: "build", workspace: ws, ensure: Effect.succeed, exec: exec(14_400) }).pipe(
          Effect.provideService(Sandbox, { ...original, checkCommand: neverExits(calls) }),
        ),
      );
      yield* TestClock.adjust("5 hours");
      yield* Fiber.join(running);
      expect(calls.length).toBeGreaterThan(200);
      expect(calls.length).toBeLessThan(320);
      // Sleeps hibernate the instance and do not count toward the step cap.
      expect(handles.executions.steps.filter((s) => !s.name.includes("-sleep-")).length).toBeLessThan(330);
    }).pipe(Effect.provide(layer));
  });

  it.effect("without a durable owner, the command is one retryable step bounded by its own deadline", () => {
    const { layer, handles } = makeCFRuntimeTest();
    return Effect.gen(function* () {
      const { workspace } = yield* durableExec({
        name: "build",
        workspace: ws,
        ensure: (current) => Effect.succeed({ ...current, dir: "/workspace/rebuilt" }),
        exec: exec(14_400),
      });
      expect(workspace.dir).toBe("/workspace/rebuilt");
      const only = handles.executions.steps.find((s) => s.name === "build");
      expect(only?.metadata?.["stepOpts.timeoutSec"]).toBe(14_520);
      expect(only?.metadata?.["stepOpts.retries"]).toBe(3);
      expect(handles.sandbox.execs.find((e) => e.command === "cargo build")?.cwd).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a command within ten minutes stays one step even where a durable owner exists", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      yield* durableExec({ name: "lint", workspace: ws, ensure: Effect.succeed, exec: exec(600) }).pipe(
        Effect.provideService(Sandbox, { ...original, checkCommand: neverExits(calls) }),
      );
      expect(calls).toEqual([]);
      expect(handles.executions.steps.map((s) => s.name)).toEqual(["lint"]);
    }).pipe(Effect.provide(layer));
  });
  /** An owner that loses the first `lost` launches, then exits 0. */
  const loses = (lost: number, calls: string[]): CheckCommandService => ({
    prepare: (opts) =>
      Effect.sync(() => {
        calls.push(`prepare:${opts.stepName}`);
        return { id: opts.stepName, container: opts.container!, fingerprint: "f", startedAt: 0, deadline: 1 };
      }),
    start: () => Effect.void,
    observe: (h) =>
      Effect.succeed(
        calls.filter((c) => c.startsWith("prepare:")).length <= lost
          ? { state: "missing" as const }
          : { state: "exited" as const, exitCode: 0, durationMs: 1 },
      ).pipe(Effect.tap(() => Effect.sync(() => calls.push(`observe:${h.id}`)))),
    finalize: (h) =>
      Effect.sync(() => {
        calls.push(`finalize:${h.id}`);
        return { exitCode: 0, durationMs: 1, logPath: "logs/x", stdout: "", stderr: "" };
      }),
  });

  it.effect("a lost process relaunches in a destroyed, rebuilt container under its own step names", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    let ensured = 0;
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      const { result } = yield* durableExec({
        name: "build",
        workspace: ws,
        ensure: (current) => Effect.sync(() => (ensured++, current)),
        exec: exec(14_400),
      }).pipe(Effect.provideService(Sandbox, { ...original, checkCommand: loses(1, calls) }));
      expect(result.exitCode).toBe(0);
      expect(calls.filter((c) => c.startsWith("prepare:"))).toEqual(["prepare:build", "prepare:build-relaunch-1"]);
      expect(calls).toContain("finalize:build-relaunch-1");
      expect(handles.sandbox.destroyed).toEqual(["fake-container"]);
      expect(ensured).toBe(2);
      const workspaceStep = handles.executions.steps.find((s) => s.name === "build-relaunch-1-workspace");
      expect(workspaceStep?.metadata?.["stepOpts.retries"]).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finalize gets the container-call ceiling, room for a drain over a slow spool", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      yield* durableExec({ name: "build", workspace: ws, ensure: Effect.succeed, exec: exec(14_400) }).pipe(
        Effect.provideService(Sandbox, { ...original, checkCommand: loses(0, calls) }),
      );
      const finalize = handles.executions.steps.find((s) => s.name === "build-finalize");
      expect(finalize?.metadata?.["stepOpts.timeoutSec"]).toBe(300);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a process lost on every launch fails SandboxProcessLost and never finalizes", () => {
    const { layer } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      const exit = yield* Effect.exit(
        durableExec({ name: "build", workspace: ws, ensure: Effect.succeed, exec: exec(14_400), relaunches: 1 }).pipe(
          Effect.provideService(Sandbox, { ...original, checkCommand: loses(99, calls) }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.failureOption(exit.cause))).toMatchObject({
          _tag: "SandboxProcessLost",
          launches: 2,
        });
      expect(calls.some((c) => c.startsWith("finalize:"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
