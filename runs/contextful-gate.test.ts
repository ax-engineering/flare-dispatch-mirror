import { it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  DEPLOYED_VERSION_ENV,
  EXECUTION_CREATED_AT_ENV,
  IO,
  StepFailed,
  StepRunner,
  type CommitPullRequest,
  type StepRunnerService,
} from "@fractalboxdev/flare-dispatch-core";
import { check } from "./check";
import {
  contextfulGate,
  lightLabelsKey,
  mergeStages,
  NOT_AFFECTED_SUMMARY,
  parseAffected,
  parseLightLabels,
  parseStages,
  parseWindow,
  planStages,
  prLiveness,
  stageCommand,
  tierParts,
  unrunSummary,
  WINDOW_DEFAULT,
  WINDOW_MAX,
} from "./contextful-gate";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const DISCOVER = "cargo run --locked -q -p contextful-ci -- stages --parts";
const DISCOVER_HEAD = `${DISCOVER} --base ${BASE_SHA}`;
const DISCOVER_AFFECTED = `${DISCOVER_HEAD} --affected`;
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
      expect(result).toEqual({ stages: 1, failed: [], notAffected: [] });
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
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 6, failed: [], notAffected: [] });
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
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 1, failed: [], notAffected: [] });
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
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [], notAffected: [] });
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
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 3, failed: [], notAffected: [] });
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
    expect(trigger?.inputs({ payload } as never)).toEqual({ ...input, pr: 42 });
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

  it.effect("starts the next part as soon as any running part settles", () => {
    // pins (check:0) settles on the first poll; workspace.compile (check:1)
    // stays running until formal (check:2) has started in pins' freed slot.
    const { layer, handles } = makeCFRuntimeTest({
      config: { "contextful-gate.window:fractalboxdev/contextful": "2" },
      sandboxProgram: {
        [DISCOVER_HEAD]: {
          stdout: "pins\nworkspace.compile\nformal\ntest-first.contextful-core\n",
          exitCode: 0,
        },
        [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
      },
      childRuns: {
        pollFn: (ids) => ids.map((executionId) => ({
          executionId,
          status: executionId === "check:1" && !ids.includes("check:2") ? "running" : "success",
        })),
      },
    });
    return Effect.gen(function* () {
      const output = yield* contextfulGate.run(input);
      expect(output).toEqual({ stages: 4, failed: [], notAffected: [] });
      expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual(
        ["pins", "workspace.compile", "formal", "test-first.contextful-core"].map((stage) =>
          expect.objectContaining({
            checkLabel: stage,
            command: expect.stringContaining(`--stage ${stage} --base ${BASE_SHA}`),
          }),
        ),
      );
      expect(handles.executions.steps.map((entry) => entry.name).filter((name) => !name.startsWith("checkout") && !name.startsWith("discover") && name !== "release-discovery-container")).toEqual([
        "resolve-tiers",
        "prebuild-ci-binary",
        "resolve-window",
        "spawn-parts-0",
        "handoff-admission",
        "await-parts-0-poll-0",
        "spawn-parts-2",
        "await-parts-1-poll-0",
        "spawn-parts-3",
        "await-parts-2-poll-0",
      ]);
      // No seeded answer: every lookup fails, and the gate spawns as before.
      expect(handles.github.commitPullRequestsCalls).toHaveLength(3);
      expect(handles.sandbox.destroyed).toEqual(["fake-container"]);
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
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [], notAffected: [] });
        const builds = handles.sandbox.execs.filter((exec) => exec.command.includes("cargo build"));
        expect(builds).toHaveLength(1);
        const restore = [{ key: `contextful-ci-${DIGEST}`, base: "/tmp/flare-dispatch-prebuilt/contextful-ci", paths: ["bin"] }];
        expect(handles.childRuns.spawned.map((spawn) => spawn.input)).toEqual(
          ["pins", "workspace.compile"].map((stage) =>
            expect.objectContaining({
              checkLabel: stage,
              install: true,
              compileCache: true,
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
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [], notAffected: [] });
        for (const spawn of handles.childRuns.spawned) {
          const part = spawn.input as { checkLabel: string; command: string; install: boolean; restore?: unknown };
          expect(part.command).toBe(`${CARGO_RUN} gate --predecessors --stage ${part.checkLabel} --base ${BASE_SHA}`);
          expect(part.install).toBe(true);
          expect((part as { compileCache?: boolean }).compileCache).toBe(true);
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

  it.effect("keeps ten parts in flight by default", () => {
    const stages = Array.from({ length: 12 }, (_, i) => `part${i}`).join("\n");
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER_HEAD]: { stdout: stages, exitCode: 0 }, [DISCOVER]: { stdout: stages, exitCode: 0 } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 12, failed: [], notAffected: [] });
      const spawns = handles.executions.steps.map((entry) => entry.name).filter((name) => name.startsWith("spawn-parts-"));
      expect(spawns).toEqual(["spawn-parts-0", "spawn-parts-10"]);
      expect(WINDOW_DEFAULT).toBe(10);
    }).pipe(Effect.provide(layer));
  });

  it("clamps the configured window below the default admission cap", () => {
    expect(parseWindow(undefined)).toBe(WINDOW_DEFAULT);
    expect(parseWindow("")).toBe(WINDOW_DEFAULT);
    expect(parseWindow("abc")).toBe(WINDOW_DEFAULT);
    expect(parseWindow("0")).toBe(WINDOW_DEFAULT);
    expect(parseWindow("2.5")).toBe(WINDOW_DEFAULT);
    expect(parseWindow(" 4 ")).toBe(4);
    expect(parseWindow("40")).toBe(WINDOW_MAX);
    expect(WINDOW_MAX).toBeLessThan(16);
  });

  it.effect("discovers head then base in its one container and destroys it before handing off its slot", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_AFFECTED]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER_HEAD]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 1, failed: [], notAffected: [] });
      // No second container: every acquisition is the execution's own.
      expect(handles.sandbox.acquired.every((acquire) => acquire.key === undefined)).toBe(true);
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha: SHA }]);
      // The base runs in the head's checkout, after the head is fully discovered
      // and its contextful-ci keyed for the prebuilt binary.
      const setup = /^(test|sha256sum|pnpm) /;
      expect(handles.sandbox.execs.map((exec) => exec.command).filter((command) => !setup.test(command))).toEqual([
        DISCOVER_HEAD,
        expect.stringMatching(/^cargo tree --locked -p contextful-ci /),
        `git -c advice.detachedHead=false checkout --quiet --force --detach ${BASE_SHA}`,
        DISCOVER,
      ]);
      const steps = handles.executions.steps.map((entry) => entry.name);
      expect(handles.sandbox.destroyed).toEqual(["fake-container"]);
      expect(steps.indexOf("release-discovery-container")).toBeLessThan(steps.indexOf("handoff-admission"));
      expect(steps.indexOf("release-discovery-container")).toBeLessThan(steps.indexOf("spawn-parts-0"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("clones the base on its own when the head checkout cannot reach it", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [`--detach ${BASE_SHA}`]: { stdout: "", stderr: "fatal: reference is not a tree", exitCode: 128 },
        [DISCOVER_HEAD]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 1, failed: [], notAffected: [] });
      expect(handles.sandbox.clones).toEqual([
        { repo: input.repo, sha: SHA },
        { repo: input.repo, sha: BASE_SHA },
      ]);
      expect(handles.sandbox.acquired.every((acquire) => acquire.key === undefined)).toBe(true);
      expect(handles.sandbox.destroyed).toEqual(["fake-container"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finishes from a pre-window checkpoint whose spawn steps returned bare handle arrays", () => {
    // A gate in flight across the deploy replays its old `spawn-stages-<offset>`
    // and `await-stages-<offset>` checkpoints; none of them is read again.
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DISCOVER_HEAD]: { stdout: "pins\nformal\n", exitCode: 0 }, [DISCOVER]: { stdout: "pins\nformal\n", exitCode: 0 } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const replayed: string[] = [];
      const runner: StepRunnerService = {
        ...ordinary,
        run: (name, body, opts) =>
          /^(spawn|await)-stages-/.test(name)
            ? Effect.sync(() => { replayed.push(name); return [{ executionId: "old" }] as never; })
            : ordinary.run(name, body, opts),
      };
      expect(yield* contextfulGate.run(input).pipe(Effect.provideService(StepRunner, runner))).toEqual({ stages: 2, failed: [], notAffected: [] });
      expect(replayed).toEqual([]);
      expect(handles.childRuns.spawned).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never opens synthetic checks for a head-selected subset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_AFFECTED]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER_HEAD]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      const ordinary = yield* StepRunner;
      const failedOnce = new Set<string>();
      // The engine re-runs a step whose body failed: the first attempt of each
      // conclusion runs its body, then fails as a transient GitHub error would.
      const runner: StepRunnerService = {
        ...ordinary,
        run: (name, body, opts) =>
          /^(conclude-not-affected-|report-not-affected$)/.test(name) && !failedOnce.has(name)
            ? Effect.gen(function* () {
                failedOnce.add(name);
                yield* Effect.exit(body());
                return yield* ordinary.run(name, body, opts);
              })
            : ordinary.run(name, body, opts),
      };
      expect(yield* contextfulGate.run(input).pipe(Effect.provideService(StepRunner, runner))).toEqual({
        stages: 3, failed: [], notAffected: [],
      });
      expect(failedOnce.size).toBe(0);
      expect(handles.checks.creates).toEqual([]);
      expect(handles.childRuns.spawned).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it("dispatches every required part even if the head claims only one is affected", () => {
    const head = ["pins", "workspace.compile", "formal"];
    const base = ["pins", "workspace.compile", "legacy"];
    expect(planStages(head, base, { headDiscoveredAgainstBase: true }, ["pins"])).toEqual({
      required: ["pins", "workspace.compile", "formal", "legacy"],
      dispatch: ["pins", "workspace.compile", "formal", "legacy"],
      notAffected: [],
    });
    expect(planStages(head, base, { headDiscoveredAgainstBase: true }, undefined)).toEqual({
      required: ["pins", "workspace.compile", "formal", "legacy"],
      dispatch: ["pins", "workspace.compile", "formal", "legacy"],
      notAffected: [],
    });
    expect(planStages(head, base, { headDiscoveredAgainstBase: true }, []).dispatch).toEqual([
      "pins", "workspace.compile", "formal", "legacy",
    ]);
  });

  it("accepts an empty affected list and refuses parts outside the required set", () => {
    const required = ["pins", "formal"];
    expect(parseAffected("", required)).toEqual([]);
    expect(parseAffected("\n", required)).toEqual([]);
    expect(parseAffected("formal\n", required)).toEqual(["formal"]);
    expect(parseAffected("budget.full\n", required)).toBeUndefined();
    expect(parseAffected("pins\npins\n", required)).toBeUndefined();
    expect(parseAffected(" ".repeat(4097), required)).toBeUndefined();
  });

  it.effect("dispatches all required parts despite a head-selected subset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_AFFECTED]: { stdout: "pins\n", exitCode: 0 },
        [DISCOVER_HEAD]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\nworkspace.compile\nlegacy\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({
        stages: 4, failed: [], notAffected: [],
      });
      expect(handles.childRuns.spawned.map((spawn) => (spawn.input as { checkLabel: string }).checkLabel)).toEqual([
        "pins", "workspace.compile", "formal", "legacy",
      ]);
      expect(handles.checks.creates).toEqual([]);
      expect(NOT_AFFECTED_SUMMARY).toBe("not affected by this change");
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs every head part when untrusted discovery reports an empty affected set", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_AFFECTED]: { stdout: "", exitCode: 0 },
        [DISCOVER_HEAD]: { stdout: "pins\nformal\n", exitCode: 0 },
        [DISCOVER]: { stdout: "pins\nformal\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      expect(yield* contextfulGate.run(input)).toEqual({ stages: 2, failed: [], notAffected: [] });
      expect(handles.childRuns.spawned).toHaveLength(2);
      expect(handles.checks.updates).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("dispatches every part when the consumer rejects or garbles --affected", () => {
    return Effect.gen(function* () {
      for (const affected of [
        { stdout: "", stderr: "error: unexpected argument '--affected' found\nUsage: contextful-ci stages --parts", exitCode: 2 },
        { stdout: "", exitCode: 1 },
        { stdout: "budget.full\n", exitCode: 0 },
      ]) {
        const { layer, handles } = makeCFRuntimeTest({
          sandboxProgram: {
            [DISCOVER_AFFECTED]: affected,
            [DISCOVER_HEAD]: { stdout: "pins\nformal\n", exitCode: 0 },
            [DISCOVER]: { stdout: "pins\nformal\n", exitCode: 0 },
          },
          childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
        });
        expect(yield* contextfulGate.run(input).pipe(Effect.provide(layer))).toEqual({ stages: 2, failed: [], notAffected: [] });
        expect(handles.childRuns.spawned).toHaveLength(2);
        expect(handles.checks.creates).toHaveLength(0);
      }
    });
  });

  it.effect("never asks an older head without --base for its affected parts", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DISCOVER_HEAD]: { stdout: "", stderr: "error: unexpected argument '--base' found\nUsage: contextful-ci stages --parts", exitCode: 2 },
        [DISCOVER]: { stdout: "pins\n", exitCode: 0 },
      },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
    });
    return Effect.gen(function* () {
      yield* contextfulGate.run(input);
      expect(handles.sandbox.execs.some((exec) => exec.command.includes("--affected"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it("joins one supersession group per pull request", () => {
    expect(contextfulGate.supersede?.({ ...input, pr: 42 })).toEqual({ group: "contextful-gate:fractalboxdev/contextful#42" });
    expect(contextfulGate.supersede?.(input)).toBeUndefined();
  });

  it("ranks a gate within its group by the pull request's revision time, not by arrival", () => {
    const trigger = contextfulGate.triggers?.[0];
    const payloadAt = (updatedAt: string | undefined) => ({
      payload: {
        repository: { full_name: input.repo },
        pull_request: {
          number: 42,
          ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
          head: { sha: SHA, repo: { full_name: input.repo } },
          base: { sha: BASE_SHA },
        },
      },
    }) as never;
    const earlier = trigger?.inputs(payloadAt("2026-10-19T10:00:00Z")) as typeof input & { revisedAt?: number };
    const later = trigger?.inputs(payloadAt("2026-10-19T10:00:05Z")) as typeof input & { revisedAt?: number };
    expect(earlier?.revisedAt).toBe(Date.parse("2026-10-19T10:00:00Z"));
    expect(contextfulGate.supersede?.(later!)?.order).toBeGreaterThan(contextfulGate.supersede?.(earlier!)?.order ?? Infinity);
    expect(trigger?.inputs(payloadAt("not a time"))).toEqual({ ...input, pr: 42 });
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
      expect(output).toEqual({ stages: 1, failed: [], notAffected: [] });
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
  describe("liveness and admission backlog", () => {
    const REPO = input.repo;
    const KEY = `${REPO}:${SHA}`;
    const pr = (over: Partial<CommitPullRequest> = {}): CommitPullRequest => ({
      number: 42, state: "open", merged: false, headSha: SHA, headRepo: REPO, ...over,
    });
    const three = { [DISCOVER_HEAD]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 }, [DISCOVER]: { stdout: "pins\nworkspace.compile\nformal\n", exitCode: 0 } };
    const cancelledChecks = (handles: ReturnType<typeof makeCFRuntimeTest>["handles"]) =>
      handles.checks.updates.map((update) => ({
        name: handles.checks.creates.find((create) => create.checkRunId === update.checkRunId)?.name,
        conclusion: update.conclusion,
        summary: update.output?.summary,
      }));

    it("decides liveness from the gated pull request's state and head", () => {
      const withPr = { repo: REPO, sha: SHA, pr: 42 };
      expect(prLiveness(withPr, [pr()])).toEqual({ live: true });
      expect(prLiveness(withPr, [pr({ headSha: "c".repeat(40) })])).toEqual({ live: false, reason: "head superseded" });
      expect(prLiveness(withPr, [pr({ state: "closed", merged: true })])).toEqual({ live: false, reason: "pull request closed" });
      expect(prLiveness(withPr, [pr({ state: "closed" })])).toEqual({ live: false, reason: "pull request closed" });
      // Another PR's state says nothing about the gated one; no answer is live.
      expect(prLiveness(withPr, [pr({ number: 7, state: "closed" })])).toEqual({ live: true });
      expect(prLiveness(withPr, [])).toEqual({ live: true });
      // An input without `pr` gates every PR headed in the repository.
      const bare = { repo: REPO, sha: SHA };
      // `commits/{sha}/pulls` answers [] both for a commit force-pushed off its
      // branch and for one no PR ever held: unknown, and unknown is live.
      expect(prLiveness(bare, [])).toEqual({ live: true });
      expect(prLiveness(bare, [pr({ headSha: "c".repeat(40) })])).toEqual({ live: false, reason: "head superseded" });
      expect(prLiveness(bare, [pr({ state: "closed", merged: true })])).toEqual({ live: false, reason: "pull request closed" });
      expect(prLiveness(bare, [pr({ state: "closed" }), pr({ number: 43 })])).toEqual({ live: true });
      expect(prLiveness(bare, [pr({ headRepo: "fork/contextful", state: "closed" })])).toEqual({ live: true });
    });

    it.effect("spawns nothing for a merged pull request and posts every part cancelled", () => {
      // An input started before gates carried `pr` resolves its PR from the commit.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: three,
        github: { commitPullRequests: { [KEY]: [pr({ state: "closed", merged: true })] } },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulGate.run(input));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("pull request closed — 3 of 3 parts not run");
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(handles.childRuns.admissionHandoffs).toBe(0);
        expect(cancelledChecks(handles)).toEqual(["pins", "workspace.compile", "formal"].map((stage) => ({
          name: `flare-dispatch/check:${stage}`, conclusion: "cancelled", summary: "not run — pull request closed",
        })));
      }).pipe(Effect.provide(layer));
    });

    it.effect("stops spawning once the pull request's head moves past the gated commit", () => {
      // A gate that knows its PR reads it directly: `commits/{sha}/pulls` loses
      // a force-pushed head, `pulls/{pr}` does not.
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        github: { pullRequests: { [`${REPO}#42`]: pr() }, commitPullRequests: { [KEY]: [] } },
        childRuns: {
          pollFn: (ids) => {
            handles.github.pullRequests[`${REPO}#42`] = pr({ headSha: "c".repeat(40) });
            return ids.map((executionId) => ({ executionId, status: "success" }));
          },
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulGate.run({ ...input, pr: 42 }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("head superseded — 2 of 3 parts not run");
        expect(handles.childRuns.spawned.map((spawn) => (spawn.input as { checkLabel: string }).checkLabel)).toEqual(["pins"]);
        expect(cancelledChecks(handles).map((check) => check.name)).toEqual([
          "flare-dispatch/check:workspace.compile", "flare-dispatch/check:formal",
        ]);
        expect(handles.github.pullRequestCalls).toEqual([{ repo: REPO, number: 42 }, { repo: REPO, number: 42 }]);
        expect(handles.github.commitPullRequestsCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("spawns every part for an input without `pr` whose commit no pull request holds", () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: three,
        github: { commitPullRequests: { [KEY]: [] } },
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 3, failed: [], notAffected: [] });
        expect(handles.childRuns.spawned).toHaveLength(3);
        expect(handles.checks.updates).toEqual([]);
        expect(handles.github.commitPullRequestsCalls.length).toBeGreaterThan(0);
        expect(handles.github.pullRequestCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("replays spawns cached before the liveness read existed and posts only unspawned parts as not run", () => {
      // An instance created before the read: `spawn-parts-0`, its poll and
      // `spawn-parts-1` are checkpointed, and the pull request has since closed.
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        github: { pullRequests: { [`${REPO}#42`]: pr({ state: "closed", merged: true }) } },
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        const ordinary = yield* StepRunner;
        const clock = yield* IO;
        const at = yield* clock.now;
        const cached: Record<string, unknown> = {
          "spawn-parts-0": { handles: [{ executionId: "pins-old" }], spawnedAt: at },
          "await-parts-0-poll-0": { records: [{ executionId: "pins-old", status: "success" }], observedAt: at },
          "spawn-parts-1": { handles: [{ executionId: "compile-old" }], spawnedAt: at },
        };
        const replayed: string[] = [];
        const runner: StepRunnerService = {
          ...ordinary,
          run: (name, body, opts) =>
            name in cached
              ? Effect.sync(() => { replayed.push(name); return cached[name] as never; })
              : ordinary.run(name, body, opts),
        };
        const exit = yield* Effect.exit(contextfulGate.run({ ...input, pr: 42 }).pipe(Effect.provideService(StepRunner, runner)));
        expect(replayed).toEqual(["spawn-parts-0", "await-parts-0-poll-0", "spawn-parts-1"]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("pull request closed — 1 of 3 parts not run");
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(cancelledChecks(handles)).toEqual([
          { name: "flare-dispatch/check:formal", conclusion: "cancelled", summary: "not run — pull request closed" },
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("reads liveness inside each spawn checkpoint, never in a step of its own", () => {
      // An instance whose `spawn-parts-0` was cached before the read existed
      // replays that spawn before any fresh read, so a stop never re-posts a
      // part it already spawned as not run.
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        github: { pullRequests: { [`${REPO}#42`]: pr() } },
        childRuns: {
          pollFn: (ids) => {
            handles.github.pullRequests[`${REPO}#42`] = pr({ state: "closed", merged: true });
            return ids.map((executionId) => ({ executionId, status: "success" }));
          },
        },
      });
      return Effect.gen(function* () {
        yield* Effect.exit(contextfulGate.run({ ...input, pr: 42 }));
        const names = handles.executions.steps.map((record) => record.name);
        expect(names.filter((name) => name.startsWith("spawn-parts-"))).toEqual(["spawn-parts-0", "spawn-parts-1"]);
        expect(names.some((name) => name.startsWith("check-liveness-"))).toBe(false);
        expect(handles.childRuns.spawned).toHaveLength(1);
        expect(cancelledChecks(handles).map((check) => check.name)).toEqual([
          "flare-dispatch/check:workspace.compile", "flare-dispatch/check:formal",
        ]);
      }).pipe(Effect.provide(layer));
    });

    it("keys a reopen apart from the gate the close ended, and a redelivery onto the same key", () => {
      const trigger = contextfulGate.triggers![0]!;
      const payload = (action: string, updatedAt: string) => ({
        action,
        pull_request: { number: 42, updated_at: updatedAt, head: { sha: SHA }, base: { sha: BASE_SHA } },
      });
      const synchronize = trigger.idempotencyKey({ payload: payload("synchronize", "2026-10-19T10:00:00Z") });
      const reopened = trigger.idempotencyKey({ payload: payload("reopened", "2026-10-19T11:00:00Z") });
      expect(synchronize).toBe(`contextful-gate:42:${SHA}:${BASE_SHA}`);
      expect(reopened).toBe(`contextful-gate:42:${SHA}:${BASE_SHA}:reopened:2026-10-19T11:00:00Z`);
      expect(trigger.idempotencyKey({ payload: payload("reopened", "2026-10-19T11:00:00Z") })).toBe(reopened);
    });

    it.effect("spawns no further parts after one times out in the admission queue", () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        childRuns: {
          pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "failure", failureTag: "AdmissionTimedOut" })),
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulGate.run(input));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const pretty = Cause.pretty(exit.cause);
          expect(pretty).toContain("Admission backlog: pins waited past the 90-minute queue age");
          expect(pretty).toContain("Not run: workspace.compile, formal");
        }
        expect(handles.childRuns.spawned).toHaveLength(1);
        expect(cancelledChecks(handles)).toEqual(["workspace.compile", "formal"].map((stage) => ({
          name: `flare-dispatch/check:${stage}`, conclusion: "cancelled", summary: unrunSummary("admission backlog", ["pins"]),
        })));
        expect(unrunSummary("admission backlog", ["pins"])).toContain("admission backlog");
      }).pipe(Effect.provide(layer));
    });

    it.effect("spawns no part once the monthly spend budget is reached, and skips", () => {
      const reason = "spend budget reached: $90.00 of $90.00 this month";
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        childRuns: { spendClosed: reason },
      });
      return Effect.gen(function* () {
        const failure = yield* Effect.flip(contextfulGate.run(input));
        expect(failure).toMatchObject({ _tag: "RunSkipped", reason: `${reason} — 3 of 3 parts not run` });
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(cancelledChecks(handles)).toEqual(["pins", "workspace.compile", "formal"].map((stage) => ({
          name: `flare-dispatch/check:${stage}`, conclusion: "cancelled", summary: `not run — ${reason}`,
        })));
      }).pipe(Effect.provide(layer));
    });

    it.effect("keeps spawning after an ordinary red part", () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: { "contextful-gate.window:fractalboxdev/contextful": "1" },
        sandboxProgram: three,
        childRuns: {
          pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "failure", failureTag: "ExecFailed" })),
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulGate.run(input));
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Gate stages failed: pins, workspace.compile, formal");
        expect(handles.childRuns.spawned).toHaveLength(3);
        expect(handles.checks.updates).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("logs the execution's creation time and the deployed version at each spawn", () => {
      const { layer, handles } = makeCFRuntimeTest({
        io: { vars: { [EXECUTION_CREATED_AT_ENV]: "2026-10-18T09:00:00.000Z", [DEPLOYED_VERSION_ENV]: "v-abc" } },
        config: { "contextful-gate.window:fractalboxdev/contextful": "2" },
        sandboxProgram: three,
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        yield* contextfulGate.run(input);
        expect(handles.io.logs.filter((log) => log.msg.startsWith("spawn-parts-")).map((log) => log.msg)).toEqual([
          "spawn-parts-0: execution created 2026-10-18T09:00:00.000Z, deployed version v-abc",
          "spawn-parts-2: execution created 2026-10-18T09:00:00.000Z, deployed version v-abc",
        ]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("two-tier gate", () => {
    const LIGHT_KEY = "gate.lightLabels:fractalboxdev/contextful";
    const parts = ["pins", "workspace.compile", "formal"];
    const program = {
      [DISCOVER_HEAD]: { stdout: `${parts.join("\n")}\n`, exitCode: 0 },
      [DISCOVER]: { stdout: `${parts.join("\n")}\n`, exitCode: 0 },
    };
    const heavyInput = { ...input, tier: "heavy", branch: "main" } as const;
    const spawnedLabels = (handles: { childRuns: { spawned: readonly { input: unknown }[] } }) =>
      handles.childRuns.spawned.map((spawn) => (spawn.input as { checkLabel: string }).checkLabel);

    it("parses a comma or JSON list, and reads unset, blank, empty or malformed as no light labels", () => {
      expect(lightLabelsKey("o/r")).toBe("gate.lightLabels:o/r");
      expect(parseLightLabels(undefined)).toBeUndefined();
      expect(parseLightLabels("  ")).toBeUndefined();
      expect(parseLightLabels(",, ,")).toBeUndefined();
      expect(parseLightLabels("[]")).toBeUndefined();
      expect(parseLightLabels("[pins")).toBeUndefined();
      expect(parseLightLabels('["pins", 3]')).toBeUndefined();
      expect(parseLightLabels('{"pins": true}')).toBeUndefined();
      expect(parseLightLabels(" pins , formal,pins ")).toEqual(["pins", "formal"]);
      expect(parseLightLabels('["pins", " formal "]')).toEqual(["pins", "formal"]);
    });

    it("splits the plan into light parts for pull requests and heavy parts for the default branch", () => {
      expect(tierParts(parts, ["formal", "pins"], "pull-request")).toEqual(["pins", "formal"]);
      expect(tierParts(parts, ["formal", "pins"], "heavy")).toEqual(["workspace.compile"]);
      expect(tierParts(parts, ["absent"], "pull-request")).toEqual([]);
      expect(tierParts(parts, ["absent"], "heavy")).toEqual(parts);
    });

    it("unset: a pull-request gate runs every part and the heavy tier none", () => {
      expect(tierParts(parts, undefined, "pull-request")).toBe(parts);
      expect(tierParts(parts, undefined, "heavy")).toEqual([]);
    });

    it.effect("unset: a pull-request gate spawns every part", () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: program,
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(input)).toEqual({ stages: 3, failed: [], notAffected: [] });
        expect(spawnedLabels(handles)).toEqual(parts);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a pull-request gate spawns only the light parts and posts no check for the heavy ones", () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: program,
        config: { [LIGHT_KEY]: "pins,formal" },
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(input)).toEqual({
          stages: 3,
          failed: [],
          notAffected: [],
          deferred: ["workspace.compile"],
        });
        expect(spawnedLabels(handles)).toEqual(["pins", "formal"]);
        expect(handles.checks.creates).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("a default-branch push spawns only the heavy parts without reading pull-request liveness", () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: program,
        config: { [LIGHT_KEY]: '["pins"]' },
        childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "success" })) },
      });
      return Effect.gen(function* () {
        expect(yield* contextfulGate.run(heavyInput)).toEqual({
          stages: 3,
          failed: [],
          notAffected: [],
          deferred: ["pins"],
        });
        expect(spawnedLabels(handles)).toEqual(["workspace.compile", "formal"]);
        expect(handles.github.commitPullRequestsCalls).toHaveLength(0);
        expect(handles.github.pullRequestCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("unset: a default-branch push skips before it checks anything out", () => {
      const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: program });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulGate.run(heavyInput));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("two-tier gate not configured");
        expect(handles.sandbox.clones).toEqual([]);
        expect(handles.childRuns.spawned).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it("triggers once per default-branch head, opted in by the light-label key", () => {
      const push = contextfulGate.triggers?.[1];
      expect(push?.event).toBe("push");
      const payload = {
        ref: "refs/heads/main",
        before: BASE_SHA,
        after: SHA,
        repository: { full_name: input.repo, default_branch: "main" },
      };
      expect(push?.gate?.({ payload } as never)).toBe(true);
      expect(push?.idempotencyKey?.({ payload } as never)).toBe(`contextful-gate:push:${SHA}`);
      expect(push?.inputs({ payload } as never)).toEqual(heavyInput);
      for (const other of [
        { ...payload, ref: "refs/heads/feature" },
        { ...payload, ref: "refs/tags/v1.0.0" },
        { ...payload, after: "0".repeat(40) },
        { ...payload, before: "0".repeat(40) },
        { ...payload, repository: { full_name: "other/repo", default_branch: "main" } },
      ]) {
        expect(push?.gate?.({ payload: other } as never)).toBe(false);
      }
      expect(contextfulGate.optIn?.({ input: heavyInput })).toEqual([LIGHT_KEY]);
      expect(contextfulGate.optIn?.({ input: { ...input, pr: 42 } })).toEqual([]);
    });

    it("serializes heavy-tier gates per repo and leaves pull-request gates unserialized", () => {
      expect(contextfulGate.serialize?.({ ...input, pr: 42 })).toBeUndefined();
      expect(contextfulGate.serialize?.(heavyInput)).toEqual({
        group: "contextful-gate:heavy:fractalboxdev/contextful",
        revision: SHA,
        current: expect.anything(),
      });
      expect(contextfulGate.supersede?.(heavyInput)).toBeUndefined();
    });
  });
});
