import { it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { IO, StepFailed, StepRunner, type StepRunnerService } from "@fractalboxdev/flare-dispatch-core";
import { check } from "./check";
import { contextfulGate, mergeStages, parseStages, stageCommand } from "./contextful-gate";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const DISCOVER = "cargo run --locked -q -p contextful-ci -- stages --parts";
const DISCOVER_HEAD = `${DISCOVER} --base ${BASE_SHA}`;
const input = { repo: "fractalboxdev/contextful", sha: SHA, baseSha: BASE_SHA } as const;

describe("contextful-gate", () => {
  it.effect("joins a successful child beyond the native ten-minute checkpoint ceiling", () => {
    let now = 0;
    const sleeps: number[] = [];
    const callbacks: { name: string; elapsed: number; timeout: number }[] = [];
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({ executionId,
          status: now < 610_000 ? "running" : "success" })),
      },
    });
    return Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const io = yield* IO;
      const bounded: StepRunnerService = {
        ...ordinary,
        run: (name, body, opts) => Effect.gen(function* () {
          const start = now;
          const result = yield* ordinary.run(name, body, opts);
          const timeout = (opts?.timeoutSec ?? 600) * 1000;
          callbacks.push({ name, elapsed: now - start, timeout });
          if (now - start > timeout) {
            return yield* Effect.fail(new StepFailed({ step: name,
              cause: new Error("WorkflowTimeoutError: native checkpoint ceiling") }));
          }
          return result;
        }),
        sleep: (_name, milliseconds) => Effect.sync(() => { sleeps.push(milliseconds); now += milliseconds; }),
      };
      const result = yield* contextfulGate.run(input).pipe(
        Effect.provideService(StepRunner, bounded),
        Effect.provideService(IO, { ...io,
          now: Effect.sync(() => now),
          sleep: (duration) => Effect.sync(() => { now += Duration.toMillis(Duration.decode(duration as Duration.DurationInput)); }),
        }),
      );
      expect(result).toEqual({ stages: 1, failed: [] });
      expect(now).toBeGreaterThan(600_000);
      expect(sleeps.length).toBeGreaterThan(0);
      expect(callbacks.every((call) => call.elapsed <= call.timeout)).toBe(true);
      expect(handles.childRuns.spawned).toHaveLength(1);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it("accepts one unique check label per stage", () => {
    expect(parseStages("pins\nworkspace.compile\nbudget.full\n")).toEqual([
      "pins",
      "workspace.compile",
      "budget.full",
    ]);
    expect(parseStages("\n")).toBeUndefined();
    expect(parseStages("pins\npins\n")).toBeUndefined();
    expect(parseStages("pins\nunsafe; command\n")).toBeUndefined();
    expect(
      parseStages(Array.from({ length: 65 }, (_, i) => `part${i}`).join("\n")),
    ).toBeUndefined();
    expect(parseStages(" ".repeat(4097))).toBeUndefined();
    expect(parseStages(Array.from({ length: 48 }, (_, i) => `part${i}`).join("\n"))).toHaveLength(
      48,
    );
  });

  it("keeps base stages when the head removes them", () => {
    expect(mergeStages(["pins", "formal"], ["pins", "workspace.compile"])).toEqual([
      "pins",
      "formal",
      "workspace.compile",
    ]);
  });

  it("refines the whole test-first stage only with successful base-aware discovery", () => {
    const head = ["pins", "test-first.validate", "test-first.contextful-core"];
    const base = ["pins", "test-first", "test-first.deleted-package", "formal"];
    expect(mergeStages(head, base, { headDiscoveredAgainstBase: true })).toEqual([
      ...head, "test-first.deleted-package", "formal",
    ]);
    expect(mergeStages(head, base)).toEqual([...head, ...base.slice(1)]);
    expect(mergeStages(["pins", "test-first.contextful-core"], base, { headDiscoveredAgainstBase: true })).toContain("test-first");
    expect(mergeStages(["pins", "test-first", "test-first.validate"], base, { headDiscoveredAgainstBase: true })).toContain("test-first");
  });

  it.effect("runs complete package parts and retains unrelated base-only stages", () => {
    const head = "pins\ntest-first.validate\ntest-first.contextful-core\ntest-first.contextful-cli\n";
    const base = "pins\ntest-first\ntest-first.deleted-package\nformal\n";
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER_HEAD]: { stdout: head, exitCode: 0 }, [DISCOVER]: { stdout: base, exitCode: 0 } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 6, failed: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual([
        "pins", "test-first.validate", "test-first.contextful-core", "test-first.contextful-cli", "test-first.deleted-package", "formal",
      ].map((checkLabel) => expect.objectContaining({ checkLabel })));
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("stages --parts")).map((exec) => exec.command)).toEqual([DISCOVER_HEAD, DISCOVER]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives each part a 2700 s exec deadline inside the check run's ceiling", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER_HEAD]: { stdout: "budget.full\n", exitCode: 0 }, [DISCOVER]: { stdout: "budget.full\n", exitCode: 0 } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 1, failed: [] });
      const [part] = handles.childRuns.spawned.map((spawn) => spawn.input as { timeoutSec: number });
      expect(part?.timeoutSec).toBe(2700);
      expect(check.limits.maxDurationSec).toBeGreaterThan(part!.timeoutSec);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refines validate-only discovery when no changed Rust package needs a base run", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER_HEAD]: { stdout: "pins\ntest-first.validate\n", exitCode: 0 }, [DISCOVER]: { stdout: "pins\ntest-first\n", exitCode: 0 } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual(["pins", "test-first.validate"].map((checkLabel) => expect.objectContaining({ checkLabel })));
    }).pipe(Effect.provide(layer));
  });

  it.effect("retains the whole check after unsupported-base compatibility discovery", () => {
    let discoveries = 0;
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "", stderr: "error: unexpected argument '--base' found\nUsage: contextful-ci stages --parts", exitCode: 2 },
        [DISCOVER]: {
          get stdout() { return ++discoveries === 1 ? "pins\ntest-first.validate\n" : "pins\ntest-first\n"; },
          exitCode: 0,
        },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 3, failed: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual(["pins", "test-first.validate", "test-first"].map((checkLabel) => expect.objectContaining({ checkLabel })));
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("stages --parts")).map((exec) => exec.command)).toEqual([DISCOVER_HEAD, DISCOVER, DISCOVER]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses deleted-package discovery errors and malformed lists without dispatch", () => {
    return Effect.gen(function* () {
      for (const result of [
        { stdout: "", stderr: "the changed path's package has a name", exitCode: 1 },
        { stdout: "test-first.validate\ntest-first.validate\n", exitCode: 0 },
      ]) {
        const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: { [DISCOVER_HEAD]: result, [DISCOVER]: { stdout: "test-first\n", exitCode: 0 } } });
        const exit = yield* Effect.exit(contextfulGate.run(input).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(handles.childRuns.spawned).toHaveLength(0);
      }
    });
  });

  it("admits draft same-repo PRs and refuses fork heads", () => {
    const trigger = contextfulGate.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
    const payload = {
      repository: { full_name: input.repo },
      pull_request: {
        number: 42,
        draft: true,
        head: { sha: SHA, repo: { full_name: input.repo } },
        base: { sha: BASE_SHA },
      },
    };
    expect(trigger?.gate?.({ payload } as never)).toBe(true);
    expect(trigger?.inputs({ payload } as never)).toEqual(input);
    const event = { payload } as never;
    expect(trigger?.idempotencyKey?.(event)).toBe(`contextful-gate:42:${SHA}:${BASE_SHA}`);
    expect(
      trigger?.idempotencyKey?.({
        payload: { ...payload, pull_request: { ...payload.pull_request, number: 43 } },
      } as never),
    ).not.toBe(trigger?.idempotencyKey?.(event));
    expect(
      trigger?.idempotencyKey?.({
        payload: {
          ...payload,
          pull_request: { ...payload.pull_request, base: { sha: "c".repeat(40) } },
        },
      } as never),
    ).not.toBe(trigger?.idempotencyKey?.(event));
    expect(
      trigger?.gate?.({
        payload: {
          ...payload,
          pull_request: {
            ...payload.pull_request,
            head: { ...payload.pull_request.head, repo: { full_name: "fork/contextful" } },
          },
        },
      } as never),
    ).toBe(false);
  });

  it.effect("spawns at most two stages per wave and reports every stage", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: {
          stdout: "pins\nworkspace.compile\nformal\ntest-first.contextful-core\n",
          exitCode: 0,
        },
        [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })),
      },
    });
    return Effect.gen(function* () {
      const output = yield* contextfulGate.run(input);
      expect(output).toEqual({ stages: 4, failed: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual([
        expect.objectContaining({
          checkLabel: "pins",
          command: expect.stringContaining(`--stage pins --base ${BASE_SHA}`),
        }),
        expect.objectContaining({
          checkLabel: "workspace.compile",
          command: expect.stringContaining(`--stage workspace.compile --base ${BASE_SHA}`),
        }),
        expect.objectContaining({
          checkLabel: "formal",
          command: expect.stringContaining(`--stage formal --base ${BASE_SHA}`),
        }),
        expect.objectContaining({
          checkLabel: "test-first.contextful-core",
          command: expect.stringContaining(`--stage test-first.contextful-core --base ${BASE_SHA}`),
        }),
      ]);
      expect(handles.executions.steps.map((entry) => entry.name)).toEqual([
        "checkout",
        "discover-stages",
        "prebuild-ci-binary",
        "checkout-base",
        "discover-base-stages",
        "release-discovery-container",
        "spawn-stages-0",
        "handoff-admission",
        "await-stages-0-deadline",
        "await-stages-0-poll-0",
        "spawn-stages-2",
        "await-stages-2-deadline",
        "await-stages-2-poll-0",
      ]);
      expect(handles.sandbox.destroyed).toHaveLength(1);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  describe("prebuilt contextful-ci", () => {
    const DIGEST = "c".repeat(64);
    const BIN = "/tmp/flare-dispatch-prebuilt/contextful-ci/bin/contextful-ci";
    const CARGO_RUN = "cargo run --locked -q -p contextful-ci --";
    const keyed = {
      "cargo tree": {
        stdout: "contextful-ci v0.16.0 (/workspace/contextful/tools/ci)\ncontextful-eval v0.16.0 (/workspace/contextful/tools/eval)\n",
        exitCode: 0,
      },
      "sha256sum /tmp/flare-dispatch-prebuilt-key.txt": { stdout: `${DIGEST}  /tmp/flare-dispatch-prebuilt-key.txt\n`, exitCode: 0 },
    };
    const gate = (program: Record<string, { stdout?: string; exitCode: number }>) =>
      makeCFRuntimeTest({
        sandboxProgram: {
          [DISCOVER_HEAD]: { stdout: "pins\nworkspace.compile\n", exitCode: 0 },
          [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
          ...program,
        },
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });

    it.effect("builds the tool once and runs every part through it, with the registry cache", () => {
      const { layer, handles } = gate(keyed);
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [] });
        const builds = handles.sandbox.execs.filter((exec) => exec.command.includes("cargo build"));
        expect(builds).toHaveLength(1);
        const restore = [{ key: `contextful-ci-${DIGEST}`, base: "/tmp/flare-dispatch-prebuilt/contextful-ci", paths: ["bin"] }];
        expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual(
          ["pins", "workspace.compile"].map((stage) =>
            expect.objectContaining({
              checkLabel: stage,
              install: true,
              restore,
              command: `if [ -x ${BIN} ] && ${BIN} --help >/dev/null 2>&1; then exec ${BIN} gate --predecessors --stage ${stage} --base ${BASE_SHA}; else exec ${CARGO_RUN} gate --predecessors --stage ${stage} --base ${BASE_SHA}; fi`,
            }),
          ),
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect("keeps every part on cargo run when the tool cannot be built", () => {
      const { layer, handles } = gate({ ...keyed, "cargo build": { exitCode: 101 } });
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [] });
        for (const spawn of handles.childRuns.spawned) {
          const part = spawn.input as { checkLabel: string; command: string; install: boolean; restore?: unknown };
          expect(part.command).toBe(`${CARGO_RUN} gate --predecessors --stage ${part.checkLabel} --base ${BASE_SHA}`);
          expect(part.install).toBe(true);
          expect(part.restore).toBeUndefined();
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("restores the cargo registry in the gate's own checkout", () => {
      const { layer, handles } = gate({
        ...keyed,
        "test -f pnpm-lock.yaml": { exitCode: 1 },
        "test -f package-lock.json": { exitCode: 1 },
      });
      return Effect.gen(function* () {
        yield* contextfulGate.run(input);
        const commands = handles.sandbox.execs.map((exec) => exec.command);
        expect(commands.indexOf("sha256sum Cargo.lock")).toBeGreaterThanOrEqual(0);
        expect(commands.indexOf("sha256sum Cargo.lock")).toBeLessThan(commands.indexOf(DISCOVER_HEAD));
        expect(commands.indexOf("cargo fetch --locked")).toBeGreaterThanOrEqual(0);
        expect(commands.indexOf("cargo fetch --locked")).toBeLessThan(commands.indexOf(DISCOVER_HEAD));
      }).pipe(Effect.provide(layer));
    });

    it("names the cargo run command when no binary was stored", () => {
      expect(stageCommand("pins", BASE_SHA, null)).toBe(`${CARGO_RUN} gate --predecessors --stage pins --base ${BASE_SHA}`);
    });
  });

  it.effect("fails its own check when discovery fails", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "", exitCode: 1 },
        [DISCOVER]: { stdout: "", exitCode: 1 },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("discovers older heads only when clap rejects the base argument", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: {
          stdout: "",
          stderr: "error: unexpected argument '--base' found\nUsage: contextful-ci stages --parts",
          exitCode: 2,
        },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })),
      },
    });
    return Effect.gen(function* () {
      const output = yield* contextfulGate.run(input);
      expect(output).toEqual({ stages: 1, failed: [] });
      expect(
        handles.sandbox.execs
          .map((exec) => exec.command)
          .filter((command) => command.includes("stages --parts")),
      ).toEqual([DISCOVER_HEAD, DISCOVER, DISCOVER]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a compilation failure red without compatibility discovery", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "", stderr: "compilation failed", exitCode: 101 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
    });
    return Effect.gen(function* () {
      const output = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(output)).toBe(true);
      expect(
        handles.sandbox.execs
          .map((exec) => exec.command)
          .filter((command) => command.includes("stages --parts")),
      ).toEqual([DISCOVER_HEAD, DISCOVER]);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues after a red child and makes the parent red", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) =>
          ids.map((executionId) => ({
            executionId,
            status: executionId.includes("check:0") ? "failure" : "success",
          })),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain("Gate stages failed: pins");
      expect(handles.childRuns.spawned).toHaveLength(3);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("makes the parent red when a queued child never settles", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "missing" })),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulGate.run(input));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ChildWaitTimeout");
      expect(handles.childRuns.spawned).toHaveLength(1);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
