// Run-level unit tests for the `worker-deploy` run.
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network. Mirrors the
// offload-test suite; the run-specific cases are:
//
//   (a) green path      — deploy command exits 0 → `{ deployed: true }`
//   (b) not configured  — no `worker-deploy.command:<repo>` in the config
//                          store → no-op green (`deployed: false`,
//                          `skippedReason: "not-configured"`), nothing cloned
//                          or exec'd
//   (c) secrets         — env-var names resolve from
//                          `worker-deploy.secrets:<repo>` (+ prefix key) and
//                          the values are injected into the exec env
//   (d) missing secret  — a named-but-unset key fails with `SecretsMissing`
//                          before the exec
//   (e) red check       — `failOnNonZeroExit: true` (the webhook shape) turns
//                          a non-zero exit into `AcceptanceFailed`
//   (f) trigger mapping — the `check_suite.requested` payload maps to inputs;
//                          the gate admits only the default branch
//   (g) step opts       — without a durable owner, the single exec step
//                          carries `retries: 0` and a step timeout of the exec
//                          timeout + headroom
//   (h) timeout key     — `worker-deploy.timeoutSec:<repo>` sets the webhook
//                          exec timeout; a dispatched value wins
//   (i) checkLabel      — a labelled dispatch reads only its labelled command
//   (j) ordering        — the serialization group; the dequeue-time head check
//                          skips a stale commit (unless `requireHead: false`)
//                          and hands the head to the command as env, empty
//                          when unknown
//   (k) durable exec    — with a durable owner the deploy launches once over
//                          retryable steps, at any exec timeout; a lost
//                          process fails unless the dispatch sets
//                          `relaunchOnProcessLoss`, which relaunches it
//                          exactly once, and only while the relaunch fits the
//                          run ceiling; no secret lands in a checkpoint
//
// Plus the standard determinism source guard.
//
// Spec: specs/02-runs.md § worker-deploy, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Either, Exit, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  Sandbox,
  StepRunner,
  type CheckCommandService,
  type StepRunnerService,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { workerDeploy } from "./worker-deploy";

const DEPLOY_CMD = "pnpm build && pnpm exec wrangler deploy";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: DEPLOY_CMD,
  secrets: [] as readonly string[],
  install: false,
  requireHead: true,
  failOnNonZeroExit: false,
  relaunchOnProcessLoss: false,
} as const;

describe("worker-deploy", () => {
  it.effect("green path — deploy exits 0, output reports deployed: true", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* workerDeploy.run(baseInput);

      expect(result.deployed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.skippedReason).toBeUndefined();
      expect(typeof result.logUri).toBe("string");

      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(handles.sandbox.clones).toHaveLength(1);
      expect(handles.sandbox.clones[0]).toEqual({
        repo: "owner/name",
        sha: "abc123",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "webhook command resolution — resolves `worker-deploy.command:<repo>` from the config store",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: { "worker-deploy.command:owner/name": DEPLOY_CMD },
      });
      // No `command` — webhook-shaped input.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        requireHead: true,
        failOnNonZeroExit: true,
        relaunchOnProcessLoss: false,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);
        expect(result.deployed).toBe(true);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(DEPLOY_CMD);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "not configured — no per-repo command no-ops green: deployed false, nothing cloned or exec'd",
    () => {
      // No `config` seed and no `command` input — the repo never opted in.
      // The run must SUCCEED (green check) rather than fail every push of
      // every installed repo, and must not touch a container.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        requireHead: true,
        failOnNonZeroExit: true,
        relaunchOnProcessLoss: false,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);

        expect(result.deployed).toBe(false);
        expect(result.skippedReason).toBe("not-configured");
        expect(result.logUri).toBeUndefined();
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — names from `worker-deploy.secrets:<repo>` resolve from Worker secrets into the exec env",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: {
          "worker-deploy.command:owner/name": DEPLOY_CMD,
          "worker-deploy.secrets:owner/name": "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
        },
        secrets: {
          CLOUDFLARE_API_TOKEN: "cf_token_from_worker",
          CLOUDFLARE_ACCOUNT_ID: "cf_account_from_worker",
        },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        requireHead: true,
        failOnNonZeroExit: true,
        relaunchOnProcessLoss: false,
      };

      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(input);
        expect(result.deployed).toBe(true);

        const exec = handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD);
        expect(exec?.env).toEqual({
          CLOUDFLARE_API_TOKEN: "cf_token_from_worker",
          CLOUDFLARE_ACCOUNT_ID: "cf_account_from_worker",
          FLAREDISPATCH_BRANCH: "",
          FLAREDISPATCH_BRANCH_HEAD_SHA: "",
          FLAREDISPATCH_SHA: "abc123",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("secrets — a named-but-unset key fails with SecretsMissing before the exec", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      config: {
        "worker-deploy.command:owner/name": DEPLOY_CMD,
        "worker-deploy.secrets:owner/name": "CLOUDFLARE_API_TOKEN",
        // the Worker secret itself is NOT seeded
      },
    });
    const input = {
      repo: "owner/name",
      sha: "abc123",
      secrets: [] as readonly string[],
      install: false,
      requireHead: true,
      failOnNonZeroExit: true,
      relaunchOnProcessLoss: false,
    };

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(workerDeploy.run(input));

      expect(Exit.isFailure(exit)).toBe(true);
      const tag = Exit.isFailure(exit)
        ? Option.match(Cause.failureOption(exit.cause), {
            onSome: (f) => (f as { _tag?: string })._tag,
            onNone: () => undefined,
          })
        : undefined;
      expect(tag).toBe("SecretsMissing");
      // Fail-fast: the deploy command never ran.
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("log redaction — secret values are scrubbed from captured stdout/stderr", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [DEPLOY_CMD]: {
          exitCode: 0,
          stdout: "wrangler: authenticating with cf_token_from_worker",
          stderr: "auth failed for cf_token_from_worker",
        },
      },
      config: {
        "worker-deploy.command:owner/name": DEPLOY_CMD,
        "worker-deploy.secrets:owner/name": "CLOUDFLARE_API_TOKEN",
      },
      secrets: { CLOUDFLARE_API_TOKEN: "cf_token_from_worker" },
    });
    const input = {
      repo: "owner/name",
      sha: "abc123",
      secrets: [] as readonly string[],
      install: false,
      requireHead: true,
      failOnNonZeroExit: true,
      relaunchOnProcessLoss: false,
    };

    return Effect.gen(function* () {
      const result = yield* workerDeploy.run(input);
      expect(result.deployed).toBe(true);

      // The deploy log is uploaded to R2 on a stable path, so an echoed
      // token there is durable — this is the run that carries a
      // write-scoped cloud credential.
      const exec = handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD);
      expect(exec?.stdout).not.toContain("cf_token_from_worker");
      expect(exec?.stderr).not.toContain("cf_token_from_worker");
      expect(exec?.stdout).toContain("***");
      expect(exec?.stderr).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "failOnNonZeroExit — a failed deploy turns into AcceptanceFailed (red check) carrying the exit code",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          [DEPLOY_CMD]: { exitCode: 1, stderr: "deploy failed" },
        },
      });
      const input = { ...baseInput, failOnNonZeroExit: true };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(workerDeploy.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(1);

        // The deploy ran end-to-end — the failure is the verdict, not a
        // skipped step.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-config",
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit defaults off — Action-mode red path stays a successful Effect surfacing exitCode",
    () => {
      const { layer } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 1 } },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(workerDeploy.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.deployed).toBe(false);
          expect(exit.value.exitCode).toBe(1);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  // --- exec StepOpts — without a durable owner, one step that never retries ---

  const execStepOf = (steps: ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>) =>
    steps.find((s) => s.name === "exec");

  it.effect("exec StepOpts — retries 0 and a step timeout above the default exec timeout", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run(baseInput);
      const exec = execStepOf(handles.executions.steps);
      // Unset, the step inherits CF Workflows' 600s timeout + default
      // retries, and a deploy over 600s publishes twice.
      expect(exec?.metadata?.["stepOpts.retries"]).toBe(0);
      expect(exec?.metadata?.["stepOpts.timeoutSec"]).toBe(900 + 120);
      expect(exec?.metadata?.["stepOpts.retryOn"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("exec StepOpts — the step timeout tracks a dispatched timeoutSec", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run({ ...baseInput, timeoutSec: 1500 });
      const exec = execStepOf(handles.executions.steps);
      expect(exec?.metadata?.["stepOpts.timeoutSec"]).toBe(1500 + 120);
      expect(exec?.metadata?.["stepOpts.retries"]).toBe(0);
      expect(handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.timeoutSec).toBe(1500);
    }).pipe(Effect.provide(layer));
  });

  // --- worker-deploy.timeoutSec:<repo> — the webhook-mode timeout knob --------

  const webhookInput = {
    repo: "owner/name",
    sha: "abc123",
    secrets: [] as readonly string[],
    install: false,
    requireHead: true,
    failOnNonZeroExit: true,
    relaunchOnProcessLoss: false,
  };

  it.effect("timeoutSec — a webhook dispatch reads `worker-deploy.timeoutSec:<repo>`", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      config: {
        "worker-deploy.command:owner/name": DEPLOY_CMD,
        "worker-deploy.timeoutSec:owner/name": "1500",
      },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run(webhookInput);
      expect(handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.timeoutSec).toBe(1500);
      expect(execStepOf(handles.executions.steps)?.metadata?.["stepOpts.timeoutSec"]).toBe(
        1500 + 120,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("timeoutSec — a dispatched value wins over the config key", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      config: { "worker-deploy.timeoutSec:owner/name": "1500" },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run({ ...baseInput, timeoutSec: 300 });
      expect(handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.timeoutSec).toBe(300);
    }).pipe(Effect.provide(layer));
  });

  it.effect("timeoutSec — a malformed config value degrades to the 900s default", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      config: {
        "worker-deploy.command:owner/name": DEPLOY_CMD,
        "worker-deploy.timeoutSec:owner/name": "25m",
      },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run(webhookInput);
      expect(handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.timeoutSec).toBe(900);
    }).pipe(Effect.provide(layer));
  });

  // --- durable exec — the deploy launches once ---------------------------------

  type Launch = Parameters<CheckCommandService["prepare"]>[0];

  /**
   * A durable process owner that loses the first `lost` launches (the sandbox
   * holds no process for them), then reports exit 0. Records every call, and
   * what each `prepare` was asked to launch.
   */
  const owner = (lost: number, calls: string[], launched: Launch[] = []): CheckCommandService => ({
    prepare: (opts) =>
      Effect.sync(() => {
        calls.push(`prepare:${opts.stepName}`);
        launched.push(opts);
        return { id: opts.stepName, container: opts.container!, fingerprint: "f", startedAt: 0, deadline: 1 };
      }),
    start: (h) => Effect.sync(() => void calls.push(`start:${h.id}`)),
    observe: (h) =>
      Effect.sync(() => {
        calls.push(`observe:${h.id}`);
        return calls.filter((c) => c.startsWith("start:")).length <= lost
          ? { state: "missing" as const }
          : { state: "exited" as const, exitCode: 0, durationMs: 1 };
      }),
    finalize: (h) =>
      Effect.sync(() => {
        calls.push(`finalize:${h.id}`);
        return { exitCode: 0, durationMs: 1, logPath: "logs/exec.ndjson", stdout: "", stderr: "" };
      }),
  });

  /** Run the deploy against a sandbox that has a durable process owner. */
  const runWithOwner = (input: Parameters<typeof workerDeploy.run>[0], checkCommand: CheckCommandService) =>
    Effect.flatMap(Sandbox, (original) =>
      workerDeploy.run(input).pipe(Effect.provideService(Sandbox, { ...original, checkCommand })),
    );

  const startsOf = (calls: string[]) => calls.filter((c) => c.startsWith("start:"));
  const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

  it.effect("durable exec — the deploy launches once, over short steps, from the checkout", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    const launched: Launch[] = [];
    return Effect.gen(function* () {
      const result = yield* runWithOwner(baseInput, owner(0, calls, launched));
      expect(result.deployed).toBe(true);
      // PRE-FIX: ["resolve-config", "checkout", "exec", "upload-log"]
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "checkout",
        "exec-workspace",
        "exec-prepare",
        "exec-start",
        "exec-observe-0",
        "exec-finalize",
        "upload-log",
      ]);
      expect(startsOf(calls)).toEqual(["start:exec"]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({ command: DEPLOY_CMD, cwd: "/workspace/name", timeoutSec: 900 });
      // The owner runs the command; the sandbox never holds it in a blocking exec.
      expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(DEPLOY_CMD);
    }).pipe(Effect.provide(layer));
  });

  it.effect("durable exec — a lost process fails SandboxProcessLost, with no relaunch by default", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runWithOwner(baseInput, owner(1, calls)));
      // PRE-FIX: success — the owner is never asked
      expect(failureOf(exit)).toMatchObject({ _tag: "SandboxProcessLost", launches: 1 });
      expect(startsOf(calls)).toEqual(["start:exec"]);
      expect(handles.executions.steps.some((s) => s.name.startsWith("exec-relaunch-"))).toBe(false);
      expect(handles.sandbox.destroyed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("durable exec — launch and observation retry platform failures only", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      yield* runWithOwner(baseInput, owner(0, calls));
      const retried = handles.executions.steps.filter(
        (s) => s.name === "exec-start" || s.name.startsWith("exec-observe-"),
      );
      // PRE-FIX: [] — one blocking exec step
      expect(retried.map((s) => s.name)).toEqual(["exec-start", "exec-observe-0"]);
      for (const s of retried) {
        expect(s.metadata?.["stepOpts.retries"]).toBe(3);
        expect(s.metadata?.["stepOpts.retryOn"]).toEqual(["ExecFailed", "StepFailed", "CheckoutFailed"]);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunchOnProcessLoss — a lost process relaunches exactly once, in a fresh container", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const result = yield* runWithOwner({ ...baseInput, relaunchOnProcessLoss: true }, owner(1, calls));
      // PRE-FIX: SandboxProcessLost — the input is ignored
      expect(result.deployed).toBe(true);
      expect(startsOf(calls)).toEqual(["start:exec", "start:exec-relaunch-1"]);
      expect(handles.executions.steps.map((s) => s.name)).toEqual(
        expect.arrayContaining([
          "exec-relaunch-1-destroy",
          "exec-relaunch-1-workspace",
          "exec-relaunch-1-prepare",
          "exec-relaunch-1-start",
          "exec-relaunch-1-finalize",
        ]),
      );
      expect(handles.sandbox.destroyed).toEqual(["fake-container"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunchOnProcessLoss — a second loss fails after exactly two launches", () => {
    const { layer } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runWithOwner({ ...baseInput, relaunchOnProcessLoss: true }, owner(2, calls)),
      );
      // PRE-FIX: success — the owner is never asked
      expect(failureOf(exit)).toMatchObject({ _tag: "SandboxProcessLost", launches: 2 });
      expect(startsOf(calls)).toEqual(["start:exec", "start:exec-relaunch-1"]);
      expect(calls.some((c) => c.startsWith("finalize:"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("durable exec — a short exec timeout still runs the deploy durably", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    return Effect.gen(function* () {
      yield* runWithOwner({ ...baseInput, timeoutSec: 300 }, owner(0, calls));
      // PRE-FIX: ["resolve-config", "checkout", "exec", "upload-log"] — one
      // step that cannot retry, so a lost attempt still reds the deploy
      expect(handles.executions.steps.map((s) => s.name)).toContain("exec-observe-0");
      expect(handles.executions.steps.map((s) => s.name)).not.toContain("exec");
      expect(startsOf(calls)).toEqual(["start:exec"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunchOnProcessLoss — no relaunch the run ceiling would cut short", () => {
    const { layer, handles } = makeCFRuntimeTest();
    const calls: string[] = [];
    const lostLate = owner(1, calls);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runWithOwner(
          { ...baseInput, relaunchOnProcessLoss: true },
          {
            ...lostLate,
            // The process is lost 700 s in: a 900 s relaunch plus its rebuild
            // would end past the 1800 s ceiling.
            observe: (h, c) =>
              Effect.sync(() => void (handles.io.nowCursor += 700_000)).pipe(
                Effect.zipRight(lostLate.observe(h, c)),
              ),
          },
        ),
      );
      // PRE-FIX: success — relaunched, and the ceiling would interrupt it mid-publish
      expect(failureOf(exit)).toMatchObject({ _tag: "SandboxProcessLost", launches: 1 });
      expect(startsOf(calls)).toEqual(["start:exec"]);
      expect(handles.sandbox.destroyed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it("relaunchOnProcessLoss — the input defaults to false and rejects a non-boolean", () => {
    const decode = Schema.decodeUnknownEither(workerDeploy.inputs);
    // PRE-FIX: undefined — the schema drops the key
    expect(Either.getOrUndefined(decode({ repo: "owner/name", sha: "abc123" }))?.relaunchOnProcessLoss).toBe(false);
    expect(
      Either.getOrUndefined(decode({ repo: "owner/name", sha: "abc123", relaunchOnProcessLoss: true }))
        ?.relaunchOnProcessLoss,
    ).toBe(true);
    expect(Either.isLeft(decode({ repo: "owner/name", sha: "abc123", relaunchOnProcessLoss: "yes" }))).toBe(true);
  });

  it.effect("durable exec — the secret reaches the command, never a checkpoint or a step record", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: {
        "worker-deploy.command:owner/name": DEPLOY_CMD,
        "worker-deploy.secrets:owner/name": "CLOUDFLARE_API_TOKEN",
      },
      secrets: { CLOUDFLARE_API_TOKEN: "cf_token_from_worker" },
    });
    const calls: string[] = [];
    const launched: Launch[] = [];
    const checkpoints: { name: string; value: string }[] = [];
    return Effect.gen(function* () {
      // Every step's return value is what Workflows checkpoints durably.
      const ordinary = yield* StepRunner;
      const recording: StepRunnerService = {
        ...ordinary,
        run: (name, body, opts) =>
          ordinary
            .run(name, body, opts)
            .pipe(Effect.tap((value) => Effect.sync(() => void checkpoints.push({ name, value: JSON.stringify(value) ?? "" })))),
      };
      const result = yield* runWithOwner(webhookInput, owner(0, calls, launched)).pipe(
        Effect.provideService(StepRunner, recording),
      );
      expect(result.deployed).toBe(true);
      // PRE-FIX: undefined — the owner is never asked
      expect(launched[0]?.env?.["CLOUDFLARE_API_TOKEN"]).toBe("cf_token_from_worker");
      // ...with the policy that scrubs it from the command's log.
      expect(launched[0]?.redactValues).toEqual(["cf_token_from_worker"]);
      expect(checkpoints.map((c) => c.name)).toEqual(
        expect.arrayContaining(["resolve-config", "exec-prepare", "exec-start", "exec-finalize"]),
      );
      for (const c of checkpoints) expect(c.value).not.toContain("cf_token_from_worker");
      for (const s of handles.executions.steps) {
        expect(JSON.stringify(s.metadata ?? {})).not.toContain("cf_token_from_worker");
      }
    }).pipe(Effect.provide(layer));
  });

  // --- checkLabel — a second deploy of one commit -----------------------------

  it.effect(
    "checkLabel — a command-less labelled dispatch reads ONLY its labelled command key",
    () => {
      const LABELLED_CMD = "pnpm deploy:containers";
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 }, [LABELLED_CMD]: { exitCode: 0 } },
        config: {
          "worker-deploy.command:owner/name": DEPLOY_CMD,
          "worker-deploy.command:owner/name:containers": LABELLED_CMD,
          "worker-deploy.timeoutSec:owner/name": "1500",
        },
      });
      return Effect.gen(function* () {
        yield* workerDeploy.run({ ...webhookInput, checkLabel: "containers" });
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(LABELLED_CMD);
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(DEPLOY_CMD);
        // The timeout, unlike the command, falls back to the repo key.
        expect(handles.sandbox.execs.find((e) => e.command === LABELLED_CMD)?.timeoutSec).toBe(
          1500,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "checkLabel — no labelled command no-ops rather than re-running the unlabelled deploy",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
        config: { "worker-deploy.command:owner/name": DEPLOY_CMD },
      });
      return Effect.gen(function* () {
        const result = yield* workerDeploy.run({ ...webhookInput, checkLabel: "containers" });
        expect(result.skippedReason).toBe("not-configured");
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it("checkLabel — the input schema keeps a valid label and rejects a malformed one", () => {
    const decode = Schema.decodeUnknownEither(workerDeploy.inputs);
    const ok = decode({ repo: "owner/name", sha: "abc123", checkLabel: "containers" });
    expect(Either.isRight(ok) && ok.right.checkLabel).toBe("containers");
    expect(Either.isLeft(decode({ repo: "owner/name", sha: "abc123", checkLabel: "a b" }))).toBe(
      true,
    );
  });

  // --- Deploy ordering — serialization group + the dequeue-time head check ----

  const PUSHED = "1111111111111111111111111111111111111111";
  const NEWER = "2222222222222222222222222222222222222222";
  const onMain = { ...baseInput, sha: PUSHED, branch: "main" };

  it("serialize — one group per repo, branch, and label; the revision is the SHA", () => {
    const spec = (i: Parameters<NonNullable<typeof workerDeploy.serialize>>[0]) =>
      workerDeploy.serialize?.(i);
    expect(spec({ ...onMain })).toMatchObject({
      group: "worker-deploy:owner/name@main",
      revision: PUSHED,
    });
    expect(spec({ ...onMain, checkLabel: "containers" })?.group).toBe(
      "worker-deploy:owner/name@main:containers",
    );
    expect(spec({ ...onMain, branch: "staging" })?.group).toBe("worker-deploy:owner/name@staging");
    expect(spec({ ...baseInput })?.group).toBe("worker-deploy:owner/name");
  });

  it.effect(
    "serialize — the group's current revision is the branch head, read through the App",
    () => {
      const { layer } = makeCFRuntimeTest({
        github: { branchHeads: { "owner/name:main": NEWER } },
      });
      return Effect.gen(function* () {
        const current = workerDeploy.serialize?.(onMain)?.current;
        expect(current).toBeDefined();
        if (current !== undefined) expect(yield* current).toBe(NEWER);
        // An unreadable head is unknown, never a placeholder SHA.
        const unknown = workerDeploy.serialize?.({ ...onMain, branch: "gone" })?.current;
        if (unknown !== undefined) expect(yield* unknown).toBeUndefined();
        // No head read for a rollback or a branchless dispatch.
        expect(
          workerDeploy.serialize?.({ ...onMain, requireHead: false })?.current,
        ).toBeUndefined();
        expect(workerDeploy.serialize?.(baseInput)?.current).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("head env — the command sees the branch, its head at dequeue, and the SHA", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      github: { branchHeads: { "owner/name:main": PUSHED } },
    });
    return Effect.gen(function* () {
      const result = yield* workerDeploy.run({
        ...onMain,
        // A dispatch cannot spoof the head.
        env: { FLAREDISPATCH_BRANCH_HEAD_SHA: NEWER, NODE_ENV: "production" },
      });
      expect(result.deployed).toBe(true);
      expect(handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.env).toEqual({
        NODE_ENV: "production",
        FLAREDISPATCH_BRANCH: "main",
        FLAREDISPATCH_BRANCH_HEAD_SHA: PUSHED,
        FLAREDISPATCH_SHA: PUSHED,
      });
      expect(handles.github.branchHeadCalls).toEqual([{ repo: "owner/name", branch: "main" }]);
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "branch-head",
        "checkout",
        "exec",
        "upload-log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stale at dequeue — a newer head skips the deploy, naming it, before any clone", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      github: { branchHeads: { "owner/name:main": NEWER } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(workerDeploy.run(onMain));
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect(failure).toMatchObject({ _tag: "RunSkipped" });
      expect((failure as { reason: string }).reason).toBe(
        "superseded by 222222222222 — main moved past 111111111111 before this deploy started",
      );
      expect(handles.sandbox.clones).toHaveLength(0);
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stale at dequeue — an abbreviated dispatch SHA that prefixes the head deploys", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      github: { branchHeads: { "owner/name:main": PUSHED } },
    });
    return Effect.gen(function* () {
      const result = yield* workerDeploy.run({ ...onMain, sha: PUSHED.slice(0, 12) });
      expect(result.deployed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("requireHead: false — a rollback deploys an older commit on purpose", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      github: { branchHeads: { "owner/name:main": NEWER } },
    });
    return Effect.gen(function* () {
      const result = yield* workerDeploy.run({ ...onMain, requireHead: false });
      expect(result.deployed).toBe(true);
      expect(
        handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.env?.[
          "FLAREDISPATCH_BRANCH_HEAD_SHA"
        ],
      ).toBe(NEWER);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "head unknown — an unreadable head deploys with an EMPTY head env, never a match",
    () => {
      // The fake fails an unseeded branch, as the live read does on a 404, a
      // missing installation, or an uncredentialed deploy.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      });
      return Effect.gen(function* () {
        const result = yield* workerDeploy.run(onMain);
        expect(result.deployed).toBe(true);
        const env = handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.env;
        expect(env?.["FLAREDISPATCH_BRANCH_HEAD_SHA"]).toBe("");
        expect(env?.["FLAREDISPATCH_BRANCH"]).toBe("main");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("no branch — no head read; both head vars are empty", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [DEPLOY_CMD]: { exitCode: 0 } },
      github: { branchHeads: { "owner/name:main": NEWER } },
    });
    return Effect.gen(function* () {
      yield* workerDeploy.run(baseInput);
      expect(handles.github.branchHeadCalls).toHaveLength(0);
      const env = handles.sandbox.execs.find((e) => e.command === DEPLOY_CMD)?.env;
      expect(env?.["FLAREDISPATCH_BRANCH"]).toBe("");
      expect(env?.["FLAREDISPATCH_BRANCH_HEAD_SHA"]).toBe("");
    }).pipe(Effect.provide(layer));
  });

  // --- Webhook trigger — check_suite as the default-branch push signal --------

  const checkSuitePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    action: "requested",
    repository: { full_name: "owner/name", default_branch: "main" },
    check_suite: {
      head_branch: "main",
      head_sha: "abcdef0123456789cafe",
    },
    ...overrides,
  });

  it("webhook trigger — maps the check_suite payload to inputs", () => {
    const trigger = workerDeploy.triggers?.[0];
    expect(trigger?.event).toBe("check_suite");
    expect(trigger?.actions).toEqual(["requested"]);

    const ctx = { payload: checkSuitePayload() };
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      branch: "main",
      failOnNonZeroExit: true,
      install: false,
      secrets: [],
      requireHead: true,
      relaunchOnProcessLoss: false,
    });
    expect(trigger?.idempotencyKey(ctx)).toBe("worker-deploy:owner_name:abcdef012345");
  });

  it("webhook trigger — gate admits only the repo's default branch", () => {
    const gate = workerDeploy.triggers?.[0]?.gate;
    expect(gate?.({ payload: checkSuitePayload() })).toBe(true);
    // Feature-branch push suites (PR lanes) never reach the deploy run.
    expect(
      gate?.({
        payload: checkSuitePayload({
          check_suite: {
            head_branch: "feat/thing",
            head_sha: "abcdef0123456789cafe",
          },
        }),
      }),
    ).toBe(false);
    // A repo whose default branch isn't `main` still gates correctly.
    expect(
      gate?.({
        payload: checkSuitePayload({
          repository: { full_name: "owner/name", default_branch: "trunk" },
          check_suite: {
            head_branch: "trunk",
            head_sha: "abcdef0123456789cafe",
          },
        }),
      }),
    ).toBe(true);
    // Malformed payload (no head_branch) is gated out, not dispatched.
    expect(
      gate?.({
        payload: checkSuitePayload({
          check_suite: { head_sha: "abcdef0123456789cafe" },
        }),
      }),
    ).toBe(false);
  });

  it("optIn — names the command key resolve-config reads; none when the dispatch carries one", () => {
    const input = workerDeploy.triggers![0]!.inputs({ payload: checkSuitePayload() });
    expect(workerDeploy.optIn?.({ input })).toEqual(["worker-deploy.command:owner/name"]);
    expect(workerDeploy.optIn?.({ input: { ...input, checkLabel: "docs" } })).toEqual([
      "worker-deploy.command:owner/name:docs",
    ]);
    expect(workerDeploy.optIn?.({ input: { ...input, command: "pnpm deploy" } })).toEqual([]);
  });
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("worker-deploy source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./worker-deploy.ts", import.meta.url)),
        "utf8",
      );
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});
