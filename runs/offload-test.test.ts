// Run-level unit tests for the `offload-test` run.
//
// These exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest` + `sandboxFakeProgram`) — no CF, no Docker, no network.
// The three acceptance cases from specs/pm/plan.md § PR3:
//
//   (a) green path  — fake `pnpm test` exits 0  → output `.exitCode === 0`
//   (b) red path    — fake `pnpm test` exits 1  → output `.exitCode === 1`,
//                      the run Effect *succeeds* (a non-zero exit is a normal
//                      ExecResult, never an Effect failure — specs/03-dsl.md
//                      § sandbox)
//   (c) timeout     — fake `exec` raises ExecTimeout → the run Effect *fails*
//                      with the `ExecTimeout` tag, re-failed unchanged
//   (d) secrets     — config-store secrets are resolved by `loadSecrets` and
//                      injected into the exec env (per-dispatch `env` wins on
//                      a key collision); a named-but-unset key fails the run
//                      with `SecretsMissing` before the exec
//   (e) install     — `install: true` runs the R2-cached dependency install
//                      inside the checkout step; the `image` override reaches
//                      the container acquire
//   (f) repo secrets — webhook mode resolves secret NAMES from
//                      `offload-test.secrets:<repo>`; the values reach every
//                      exec path and the install, and never a step result
//
// Plus a determinism guard: the run body must not call `Date.now()` /
// `crypto.randomUUID()` directly — non-determinism flows only through `io`,
// and `durationMs` is sourced from the checkpointed `exec` step result so it
// is stable across Workflow replays (specs/pm/plan.md § 6 "Run replay
// determinism").
//
// Spec: specs/pm/plan.md § PR3, specs/03-dsl.md § Unit-testing runs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect } from "vitest";
import { StepRunner, type StepRunnerService } from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { offloadTest } from "./offload-test";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: "pnpm test",
  secrets: [] as readonly string[],
  install: false,
  failOnNonZeroExit: false,
} as const;

describe("offload-test", () => {
  it.effect("green path — exec exits 0, output reports exitCode 0", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri.length).toBeGreaterThan(0);

      // checkout → exec → upload-log, each recorded once, all successful.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "checkout",
        "exec",
        "upload-log",
      ]);
      expect(handles.executions.steps.every((s) => s.status === "success")).toBe(true);
      expect(handles.sandbox.clones).toHaveLength(1);
      expect(handles.sandbox.clones[0]).toEqual({
        repo: "owner/name",
        sha: "abc123",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("red path — exec exits 1, output reports exitCode 1 and the Effect succeeds", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "pnpm test": { exitCode: 1, stderr: "1 failing" },
      },
    });

    return Effect.gen(function* () {
      // The run Effect must *succeed* — a failing test is a normal result,
      // surfaced as `exitCode`, not an Effect failure.
      const exit = yield* Effect.exit(offloadTest.run(baseInput));

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.exitCode).toBe(1);
      }

      // All three steps still recorded as successful — a non-zero exit does
      // not fail the `exec` step.
      expect(handles.executions.steps.every((s) => s.status === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("timeout — exec raises ExecTimeout, the run re-fails with the same tag", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "pnpm test": { fail: "ExecTimeout", timeoutSec: 600 },
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(baseInput));

      expect(Exit.isFailure(exit)).toBe(true);
      // The failure is the `ExecTimeout` tag, not swallowed, not remapped.
      const tag = Exit.isFailure(exit)
        ? Option.match(Cause.failureOption(exit.cause), {
            onSome: (f) => (f as { _tag?: string })._tag,
            onNone: () => undefined,
          })
        : undefined;
      expect(tag).toBe("ExecTimeout");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the exec step asks the platform to retry only a platform failure", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run(baseInput);
      const execStep = handles.executions.steps.find((st) => st.name === "exec");
      expect(execStep?.metadata?.["stepOpts.retries"]).toBe(3);
      expect(execStep?.metadata?.["stepOpts.retryOn"]).toEqual([
        "ExecFailed",
        "StepFailed",
        "CheckoutFailed",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("durationMs is the checkpointed exec ExecResult's durationMs", () => {
    // The run reports `result.durationMs` straight from the `exec` step's
    // `ExecResult` — the replay-safe source, since only step results are
    // memoized across Workflow replays. The run must not recompute it from
    // wall-clock reads. Pin a distinctive `durationMs` on the canned exec
    // result and assert the run output carries exactly that value.
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0, durationMs: 4242 } },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);
      expect(result.durationMs).toBe(4242);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "install — runs the cached dependency install in the checkout, image override reaches acquire",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, install: true, image: "custom/image:1" };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // The container acquire honours the `image` override (previously the
        // input was declared but never threaded).
        expect(handles.sandbox.acquired[0]).toEqual({ image: "custom/image:1" });

        // `installCached` detected pnpm from the lockfile probe and — the test
        // Cache fake always misses — ran the real install before the command.
        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");
        expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
          commands.indexOf("pnpm test"),
        );

        // Still exactly the three run steps — the install lives inside
        // `checkout`, not a fourth step.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "webhook exec options — install + timeoutSec resolve from CONFIG_KV when the dispatch omits them",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "true",
          "offload-test.timeoutSec:owner/name": "1800",
        },
      });
      // Webhook-shaped: no command, no install, no timeoutSec.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // install:true came from config — the cached install ran before the
        // command, which is the whole point (a suite needs its deps).
        const commands = handles.sandbox.execs.map((e) => e.command);
        expect(commands).toContain("pnpm install --frozen-lockfile");

        // timeoutSec:1800 came from config, not the 600s default — the other
        // half of the pair, since a suite that needs an install outruns 600s.
        const testExec = handles.sandbox.execs.find((e) => e.command === "pnpm test");
        expect(testExec?.timeoutSec).toBe(1800);

        // ...and the STEP wrapping that exec carries that ceiling plus the
        // headroom, so the exec's own deadline fires first (a clean
        // `ExecTimeout` with a log) rather than the platform killing both at
        // the same instant (`WorkflowTimeoutError`, empty artifact).
        //
        // Two timeouts, and only one of them was being set. A Workflow step
        // defaults to 600s, so a repo configuring 1800 got
        // `WorkflowTimeoutError: Execution timed out after 600000ms` at ten
        // minutes — from a limit its config never mentions, with an empty log
        // because the step died rather than the command. The assertion above
        // passed throughout: it only ever proved the inner half.
        const execStep = handles.executions.steps.find((s) => s.name === "exec");
        expect(execStep?.metadata?.["stepOpts.timeoutSec"]).toBe(1800 + 120);

        // Platform retries, and only for `ExecFailed`. A step-level timeout is
        // raised by the engine, so `retryOn` cannot gate it: a wedged exec is
        // replayed for the whole budget.
        expect(execStep?.metadata?.["stepOpts.retries"]).toBe(3);
        expect(execStep?.metadata?.["stepOpts.retryOn"]).toEqual([
          "ExecFailed",
          "StepFailed",
          "CheckoutFailed",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("webhook exec options — an explicit dispatch value beats CONFIG_KV", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      config: {
        "offload-test.install:owner/name": "true",
        "offload-test.timeoutSec:owner/name": "1800",
      },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run({
        ...baseInput,
        install: false,
        timeoutSec: 120,
      });
      // `install: false` is now distinguishable from "unset" — the whole
      // reason the schema default was removed — so config must NOT win.
      expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
        "pnpm install --frozen-lockfile",
      );
      expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(120);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "webhook exec options — no config and no dispatch value keeps the historical defaults",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: { "offload-test.command:owner/name": "pnpm test" },
      });

      return Effect.gen(function* () {
        yield* offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        // Unchanged from before this feature: no install, 600s.
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
          "pnpm install --frozen-lockfile",
        );
        expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(600);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "webhook exec options — a malformed config value degrades to the default, never NaN",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "yes-please",
          "offload-test.timeoutSec:owner/name": "half an hour",
        },
      });

      return Effect.gen(function* () {
        yield* offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        // A typo'd timeout must not reach sandbox.exec as NaN — that is a
        // timeout that never fires, i.e. a hung run holding a container.
        expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.timeoutSec).toBe(600);
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(
          "pnpm install --frozen-lockfile",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it("webhook trigger — omits install so CONFIG_KV can supply it", () => {
    const inputs = offloadTest.triggers?.[0]?.inputs?.({
      payload: {
        repository: { full_name: "owner/name" },
        pull_request: {
          draft: false,
          user: { login: "a-human" },
          head: { sha: "0123456789abcdef" },
        },
      },
    } as never) as Record<string, unknown> | undefined;

    // Restating `install: false` here would read as an explicit caller choice
    // and shadow `offload-test.install:<repo>` — the exact bug this guards.
    expect(inputs && "install" in inputs).toBe(false);
    expect(inputs && "timeoutSec" in inputs).toBe(false);
    // `secrets` stays pinned empty — a PR-triggered dispatch carries no creds.
    expect(inputs?.["secrets"]).toEqual([]);
  });

  it.effect(
    "secrets — Worker secret values are injected into the exec env, per-dispatch env wins",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        secrets: {
          SOME_API_KEY: "key_from_worker",
          SOME_BASE_URL: "https://store.example.com",
        },
      });
      const input = {
        ...baseInput,
        secrets: ["SOME_API_KEY", "SOME_BASE_URL"],
        // Collides with the Worker secret — the per-dispatch value (the
        // more specific source) must win.
        env: { SOME_BASE_URL: "https://dispatch.example.com" },
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find((e) => e.command === "pnpm test");
        expect(exec?.env).toEqual({
          SOME_API_KEY: "key_from_worker",
          SOME_BASE_URL: "https://dispatch.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails the run with SecretsMissing before the exec",
    () => {
      // No `config` seed — the named secret resolves to nothing. `loadSecrets`
      // runs with `required: true`, so the run fails fast instead of executing
      // the command without the credential.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = { ...baseInput, secrets: ["SOME_API_KEY"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");

        // Fail-fast: the command never ran.
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- Pure webhook mode (specs/04-gha-integration.md § Pure webhook mode) ----

  // A minimal `pull_request` webhook payload — the standard fields the trigger
  // reads (`repository.full_name`, `pull_request.head.sha`, draft/user gates).
  const prPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    action: "synchronize",
    repository: { full_name: "owner/name" },
    pull_request: {
      draft: false,
      head: { sha: "abcdef0123456789cafe" },
      user: { login: "alice" },
    },
    ...overrides,
  });

  it("webhook trigger — maps the pull_request payload to inputs", () => {
    const trigger = offloadTest.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toContain("synchronize");

    const ctx = { payload: prPayload() };
    // command / install / timeoutSec all omitted — resolved from CONFIG_KV in
    // the body. `install` must NOT be restated: doing so reads as an explicit
    // caller choice and shadows `offload-test.install:<repo>`. fail-on-nonzero
    // is forced on so a red suite turns the check red; `secrets` stays pinned
    // empty because a PR-triggered dispatch must never carry credentials.
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      failOnNonZeroExit: true,
      secrets: [],
    });
    // instanceId mirrors Action mode's `{run}:{repo_}:{sha12}`.
    expect(trigger?.idempotencyKey(ctx)).toBe("offload-test:owner_name:abcdef012345");
  });

  it("webhook trigger — gate skips drafts and dependabot, admits real PRs", () => {
    const gate = offloadTest.triggers?.[0]?.gate;
    expect(gate?.({ payload: prPayload() })).toBe(true);
    expect(
      gate?.({
        payload: prPayload({
          pull_request: {
            draft: true,
            head: { sha: "abcdef0123456789cafe" },
            user: { login: "alice" },
          },
        }),
      }),
    ).toBe(false);
    expect(
      gate?.({
        payload: prPayload({
          pull_request: {
            draft: false,
            head: { sha: "abcdef0123456789cafe" },
            user: { login: "dependabot[bot]" },
          },
        }),
      }),
    ).toBe(false);
  });

  it("optIn — names the keys resolve-command decides on; none when the dispatch carries a command", () => {
    const input = offloadTest.triggers![0]!.inputs({ payload: prPayload() });
    expect(offloadTest.optIn?.({ input })).toEqual([
      "offload-test.command:owner/name",
      "offload-test.command",
      "offload-test.stages:owner/name",
    ]);
    expect(offloadTest.optIn?.({ input: { ...input, command: "pnpm test" } })).toEqual([]);
  });

  it.effect(
    "command resolution — a dispatch without `command` resolves it from CONFIG_KV (per-repo wins over the default)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "cargo test --workspace": { exitCode: 0 } },
        config: {
          // Per-repo key wins over the dispatcher-wide default.
          "offload-test.command:owner/name": "cargo test --workspace",
          "offload-test.command": "pnpm test",
        },
      });
      // No `command` — webhook-shaped input.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);

        // The resolve-command step precedes the usual three.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-command",
          "checkout",
          "exec",
          "upload-log",
        ]);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain("cargo test --workspace");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command resolution — falls back to the dispatcher-wide `offload-test.command` when no per-repo key is set",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: { "offload-test.command": "pnpm test" },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(input);
        expect(result.exitCode).toBe(0);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain("pnpm test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command resolution — a webhook dispatch with no CONFIG_KV command skips with RunSkipped (neutral) before checkout",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        // no `config` seed — neither command key resolves.
      });
      // Webhook-shaped: the trigger never passes `command`.
      const input = {
        repo: "owner/name",
        sha: "abc123",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("RunSkipped");
        // The neutral check names the key that opts the repo in.
        expect((failure as { reason?: string })?.reason).toContain(
          "offload-test.command:owner/name",
        );
        // Skipped before any work: never cloned, never exec'd.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "command resolution — an Action dispatch passing an empty `command` fails fast with StepFailed",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        command: "  ",
        secrets: [] as readonly string[],
        install: false,
        failOnNonZeroExit: false,
      };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("StepFailed");
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit — a non-zero exit fails the run with AcceptanceFailed (red check), carrying the exit code",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 2, stderr: "2 failing" } },
      });
      const input = { ...baseInput, failOnNonZeroExit: true };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(2);

        // The suite still ran end-to-end — the failure is the verdict, not a
        // skipped step. checkout → exec → upload-log all recorded.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
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
        sandboxProgram: { "pnpm test": { exitCode: 1 } },
      });
      // baseInput carries no `failOnNonZeroExit` — the default-off path.
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(baseInput));
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  // --- CI self-heal auto-dispatch (gated, specs/08-self-healing.md § 4) --------

  it.effect(
    "dispatches a ci-class self-heal-pr on a non-zero exit when self-heal.ci.enabled=true",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test": { exitCode: 1, stdout: "FAIL: expected 2, got 3" },
        },
        config: { "self-heal.ci.enabled": "true" },
      });
      return Effect.gen(function* () {
        // failOnNonZeroExit defaults off ⇒ the Effect succeeds; the dispatch
        // happens before that gate, so it fires regardless of the check colour.
        yield* Effect.exit(offloadTest.run(baseInput));
        expect(handles.childRuns.spawned).toHaveLength(1);
        const spawn = handles.childRuns.spawned[0]!;
        expect(spawn.run).toBe("self-heal-pr");
        expect(spawn.instanceId).toContain("self-heal:ci:");
        const incident = (
          spawn.input as {
            incident: {
              class: string;
              repo: string;
              repro?: { command?: string };
            };
          }
        ).incident;
        expect(incident.class).toBe("ci");
        expect(incident.repo).toBe("owner/name");
        expect(incident.repro?.command).toBe("pnpm test");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does NOT dispatch self-heal when the failing command inlines a secret value", () => {
    // Neither version of such a command can honestly reach the healer: raw, it
    // smuggles a live credential into the credential-free agent sandbox and
    // into a pack an injection-steerable LLM reads; scrubbed, its `***` makes
    // the verify re-run fail after the agent spend is already paid.
    const { layer, handles } = makeCFRuntimeTest({
      secrets: { DEPLOY_TOKEN: "tok-abc123" },
      sandboxProgram: {
        "curl -H 'Authorization: Bearer tok-abc123' https://x": { exitCode: 7 },
      },
      config: { "self-heal.ci.enabled": "true" },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(
        offloadTest.run({
          ...baseInput,
          command: "curl -H 'Authorization: Bearer tok-abc123' https://x",
          secrets: ["DEPLOY_TOKEN"],
        }),
      );
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("scrubs the value the container actually received, not the shadowed store value", () => {
    // Per-dispatch `env` wins over a same-named store secret. Scrubbing
    // `Object.values(secretEnv)` alone would keep the LIVE credential in the
    // rendered summary and redact a string that was never printed.
    const { layer } = makeCFRuntimeTest({
      secrets: { DEPLOY_TOKEN: "shadowed-store-value" },
      sandboxProgram: {
        "deploy --token live-dispatch-value": { exitCode: 3 },
      },
      config: {
        "offload-test.stages:owner/name": "a",
        "offload-test.command:owner/name:a": "deploy --token live-dispatch-value",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          failOnNonZeroExit: true,
          secrets: ["DEPLOY_TOKEN"],
          env: { DEPLOY_TOKEN: "live-dispatch-value" },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      const rendered = `${(failure as { summaryMd?: string })?.summaryMd ?? ""} ${
        (failure as { cause?: unknown })?.cause ?? ""
      }`;
      expect(rendered).not.toContain("live-dispatch-value");
      expect(rendered).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the shadowed store value stays scrubbed too — it is still a live credential", () => {
    // The mirror image of the shadow case: env overrides the key, but the
    // command inlines the STORE value. Scrubbing only the effective value would
    // put a live store credential in the rendered summary.
    const { layer } = makeCFRuntimeTest({
      secrets: { DEPLOY_TOKEN: "store-secret-value" },
      sandboxProgram: {
        "deploy --token store-secret-value": { exitCode: 3 },
      },
      config: {
        "offload-test.stages:owner/name": "a",
        "offload-test.command:owner/name:a": "deploy --token store-secret-value",
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        offloadTest.run({
          repo: "owner/name",
          sha: "abc123",
          failOnNonZeroExit: true,
          secrets: ["DEPLOY_TOKEN"],
          env: { DEPLOY_TOKEN: "override-value" },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      const rendered = `${(failure as { summaryMd?: string })?.summaryMd ?? ""} ${
        (failure as { cause?: unknown })?.cause ?? ""
      }`;
      expect(rendered).not.toContain("store-secret-value");
      expect(rendered).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT dispatch self-heal when the gate is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 1 } },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(offloadTest.run(baseInput));
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT dispatch self-heal on a green run even when enabled", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      config: { "self-heal.ci.enabled": "true" },
    });
    return Effect.gen(function* () {
      yield* offloadTest.run(baseInput);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

// --- Staged mode (`offload-test.stages:<repo>`, run header § Staged mode) ----
//
// The production defect this exists for: one 40–60-min buffered exec killed by
// the platform takes its whole log with it — no artifact ever lands. With the
// stages key set, each stage runs as its own `exec-<label>` step and uploads
// `step-<label>.log` IMMEDIATELY, so a later stage dying cannot orphan an
// earlier stage's log; a stage step that dies gets a one-line marker uploaded
// under its log name. ABSENT key → the 1.1.0 behaviour, byte-identical — the
// unstaged tests above are the pin for that.
describe("offload-test single-exec", () => {
  it.effect("a recycled container is re-cloned rather than retried into", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        // The probe answers non-zero: the container was recycled between
        // `checkout` and `exec`, which is one boundary every run has.
        "test -d /workspace/name/.git": { exitCode: 1 },
        "pnpm test": { exitCode: 0 },
      },
    });

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(baseInput);

      // TWO clones: the run's own checkout, then the rebuild inside the exec
      // step. #128 left this path uncovered on the grounds that its "exposure
      // is one step"; the exposure is one BOUNDARY, and every run has one.
      expect(handles.sandbox.clones).toEqual([
        { repo: "owner/name", sha: "abc123" },
        { repo: "owner/name", sha: "abc123" },
      ]);
      expect(result.exitCode).toBe(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("offload-test staged mode", () => {
  // Webhook-shaped input — staged mode only exists on the path that omits
  // `command` (the resolve step is where the stages key is read).
  const webhookInput = {
    repo: "owner/name",
    sha: "abc123",
    secrets: [] as readonly string[],
    failOnNonZeroExit: true,
  };

  it.effect(
    "per-stage execs in order — labelled command/timeout rungs win, fallback is recorded, logs upload per stage",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm run workspace": { exitCode: 0, durationMs: 1000 },
          "pnpm fallback": { exitCode: 0, durationMs: 500 },
        },
        config: {
          "offload-test.stages:owner/name": "workspace, features",
          // `features` has NO labelled command — falls back to this unlabelled
          // per-repo command, and the fallback is flagged on its exec step.
          "offload-test.command:owner/name": "pnpm fallback",
          "offload-test.command:owner/name:workspace": "pnpm run workspace",
          // Labelled timeout rung wins for `workspace`; `features` falls
          // through to the unlabelled per-repo rung.
          "offload-test.timeoutSec:owner/name:workspace": "900",
          "offload-test.timeoutSec:owner/name": "1800",
        },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(webhookInput);

        // One exec per stage, in declaration order, each followed by ITS OWN
        // upload — the log is durable before the next stage can die.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-command",
          "checkout",
          "exec-workspace",
          "upload-log-workspace",
          "exec-features",
          "upload-log-features",
        ]);
        // Each stage probes for its checkout before running its command — the
        // container can be recycled between durable steps, and a stage that
        // assumed its workspace would retry into a directory that is gone.
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
          "test -d /workspace/name/.git",
          "pnpm run workspace",
          "test -d /workspace/name/.git",
          "pnpm fallback",
        ]);

        // Documented timeout precedence: labelled rung ?? dispatch ??
        // unlabelled rung ?? default.
        // Indexes 1 and 3 — 0 and 2 are the per-stage checkout probes, which
        // carry their own short ceiling rather than the stage's.
        expect(handles.sandbox.execs[1]?.timeoutSec).toBe(900);
        expect(handles.sandbox.execs[3]?.timeoutSec).toBe(1800);
        expect(handles.sandbox.execs[0]?.timeoutSec).toBe(30);

        // Every stage step carries its derived ceiling + headroom and the same
        // retry contract as the single exec.
        const execWorkspace = handles.executions.steps.find((s) => s.name === "exec-workspace");
        expect(execWorkspace?.metadata?.["stepOpts.timeoutSec"]).toBe(900 + 120);
        expect(execWorkspace?.metadata?.["stepOpts.retries"]).toBe(3);
        expect(execWorkspace?.metadata?.["stepOpts.retryOn"]).toEqual([
          "ExecFailed",
          "StepFailed",
          "CheckoutFailed",
        ]);
        // The suspicious labelled-key-missing fallback is recorded on the
        // stage's step metadata — `workspace` resolved its own key, so only
        // `features` is flagged.
        expect(execWorkspace?.metadata?.["offload-test.commandFallback"]).toBeUndefined();
        const execFeatures = handles.executions.steps.find((s) => s.name === "exec-features");
        expect(execFeatures?.metadata?.["offload-test.commandFallback"]).toBe(true);
        expect(execFeatures?.metadata?.["stepOpts.timeoutSec"]).toBe(1800 + 120);

        // Per-stage artifact names.
        expect(handles.artifact.uploads.map((u) => u.name)).toEqual([
          "step-workspace.log",
          "step-features.log",
        ]);

        // Output mirrors the single-exec contract: exit 0, SUM of the
        // checkpointed stage durations, last stage's log URL.
        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(1500);
        expect(result.logUri).toBe(handles.artifact.urls.get("step-features.log"));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a stage whose checkout is gone re-clones before running, instead of retrying into nothing",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          // The probe answers non-zero: the container was recycled between
          // durable steps and took the checkout with it. This is the shape the
          // runtime reports as `working directory … was missing at exec time`.
          "test -d /workspace/name/.git": { exitCode: 1 },
          "run-a": { exitCode: 0 },
        },
        config: {
          "offload-test.stages:owner/name": "a",
          "offload-test.command:owner/name:a": "run-a",
        },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(webhookInput);

        // TWO clones: the run's own checkout, then the stage's rebuild. Without
        // the rebuild the command would run in a directory that is not there,
        // fail as `ExecFailed`, and be retried into the same absence three
        // times — a retry that could never work, reporting a missing directory
        // instead of anything about the code.
        expect(handles.sandbox.clones).toEqual([
          { repo: "owner/name", sha: "abc123" },
          { repo: "owner/name", sha: "abc123" },
        ]);
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
          "test -d /workspace/name/.git",
          "run-a",
        ]);
        expect(result.exitCode).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a dead stage's marker keeps the platform's own incident id", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        // What a dying container actually reports. The class is the half a
        // consumer can already infer; the reference is the half only the
        // platform's operator can act on, and it used to be dropped.
        "run-a": {
          fail: "ExecFailed",
          exitCode: -1,
          stderrTail: "exec failed (exit -1): internal error; reference = aggq3f5m407e2vb2ht76l2vf",
        },
      },
      config: {
        "offload-test.stages:owner/name": "a",
        "offload-test.command:owner/name:a": "run-a",
      },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(offloadTest.run(webhookInput));
      const markerWrite = handles.sandbox.execs.find((e) => e.command.includes("stage=a"));
      expect(markerWrite?.command).toContain("reference=aggq3f5m407e2vb2ht76l2vf");
      // Shell-safe by construction: whatever lands after `reference=` is drawn
      // from `[A-Za-z0-9_-]` only, so no vendor text can close the quote the
      // marker is printed inside.
      const id = /reference=([^\s']*)/.exec(markerWrite?.command ?? "")?.[1];
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "an Action dispatch that passes `command` stays single-exec even with stages set",
    () => {
      // Staged mode lives in the resolve step, which a dispatch carrying
      // `command` skips entirely — the Action-mode contract is untouched.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: { "offload-test.stages:owner/name": "workspace,features" },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(baseInput);
        expect(result.exitCode).toBe(0);
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "checkout",
          "exec",
          "upload-log",
        ]);
        expect(handles.artifact.uploads.map((u) => u.name)).toEqual(["step.log"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a secret inlined in a stage command never reaches the check-run summary", () => {
    // `redactValues` on the exec covers what the sandbox layer persists. It
    // does not reach the command string this run embeds in `summaryMd`, which
    // `stepFailedMd` renders as UNFENCED markdown into the GitHub check-run
    // summary — public on a public repo, and the loudest of the three surfaces.
    const { layer } = makeCFRuntimeTest({
      secrets: { DEPLOY_TOKEN: "tok-abc123" },
      sandboxProgram: {
        "curl -H 'Authorization: Bearer tok-abc123' https://x": { exitCode: 3 },
      },
      config: {
        "offload-test.stages:owner/name": "a",
        "offload-test.command:owner/name:a": "curl -H 'Authorization: Bearer tok-abc123' https://x",
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        offloadTest.run({ ...webhookInput, secrets: ["DEPLOY_TOKEN"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      const rendered = `${(failure as { summaryMd?: string })?.summaryMd ?? ""} ${
        (failure as { cause?: unknown })?.cause ?? ""
      }`;
      expect(rendered).not.toContain("tok-abc123");
      expect(rendered).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a DYING stage's command is scrubbed too — the path that skips ExecTimeout", () => {
    // The non-obvious half, and the one the red-path test above does not reach.
    // A stage that dies is caught and replaced by `deadFailure`, so the raw
    // `ExecTimeout` (whose `command` the sandbox layer scrubs) never surfaces —
    // the run renders `stage.command` itself into `cause` and `summaryMd`.
    const { layer } = makeCFRuntimeTest({
      secrets: { DEPLOY_TOKEN: "tok-abc123" },
      sandboxProgram: {
        "deploy --token tok-abc123": { fail: "ExecTimeout", timeoutSec: 600 },
      },
      config: {
        "offload-test.stages:owner/name": "a",
        "offload-test.command:owner/name:a": "deploy --token tok-abc123",
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        offloadTest.run({ ...webhookInput, secrets: ["DEPLOY_TOKEN"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
      const rendered = `${(failure as { summaryMd?: string })?.summaryMd ?? ""} ${
        (failure as { cause?: unknown })?.cause ?? ""
      }`;
      expect(rendered).not.toContain("tok-abc123");
      expect(rendered).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a non-zero stage stops the sequence — later stages skipped, failure names the stage, earlier logs uploaded",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "run-a": { exitCode: 0, durationMs: 1000 },
          "run-b": { exitCode: 2, stderr: "2 failing", durationMs: 2000 },
          "run-c": { exitCode: 0 },
        },
        config: {
          "offload-test.stages:owner/name": "a,b,c",
          "offload-test.command:owner/name:a": "run-a",
          "offload-test.command:owner/name:b": "run-b",
          "offload-test.command:owner/name:c": "run-c",
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(webhookInput));

        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
        expect((failure as { exitCode?: number })?.exitCode).toBe(2);

        // The failure summary names the stage and lists EVERY stage with its
        // outcome — ✓ ran green, ✗ went red, ⊘ never ran.
        const summaryMd = (failure as { summaryMd?: string })?.summaryMd ?? "";
        expect(summaryMd).toContain("Stage `b`");
        expect(summaryMd).toContain("✓ `a`");
        expect(summaryMd).toContain("✗ `b`");
        expect(summaryMd).toContain("⊘ `c` — skipped");

        // `c` never ran; `a` and `b` both have their logs already uploaded —
        // the failing stage cannot orphan the earlier ones.
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
          "test -d /workspace/name/.git",
          "run-a",
          "test -d /workspace/name/.git",
          "run-b",
        ]);
        expect(handles.artifact.uploads.map((u) => u.name)).toEqual(["step-a.log", "step-b.log"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a stage step that DIES uploads a marker log under the stage's log name and fails naming the stage",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "run-a": { exitCode: 0 },
          "run-b": { fail: "ExecTimeout", timeoutSec: 600 },
          "run-c": { exitCode: 0 },
        },
        config: {
          "offload-test.stages:owner/name": "a,b,c",
          "offload-test.command:owner/name:a": "run-a",
          "offload-test.command:owner/name:b": "run-b",
          "offload-test.command:owner/name:c": "run-c",
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(webhookInput));

        // The run fails with a StepFailed NAMING the dead stage's step —
        // not the raw ExecTimeout, which says nothing about which stage died.
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
        expect((failure as { step?: string })?.step).toBe("exec-b");
        expect(String((failure as { cause?: unknown })?.cause)).toContain("ExecTimeout");

        // The ✓/✗/⊘ rundown rides `summaryMd` — the run-authored-markdown
        // channel — NOT the cause, whose renderer fences it as a code block
        // (links unclickable, emoji literal). The dispatcher splices
        // `summaryMd` as real markdown, same as `AcceptanceFailed`.
        const summaryMd = (failure as { summaryMd?: string })?.summaryMd ?? "";
        expect(summaryMd).toContain("✓ `a`");
        expect(summaryMd).toContain("✗ `b`");
        expect(summaryMd).toContain("⊘ `c` — skipped");
        expect(summaryMd).toContain("step-b.log");

        // Stage `a`'s log survived — uploaded before `b` ran at all. Stage
        // `b`'s artifact is the one-line marker (stage, error class, elapsed),
        // uploaded under the REAL log's name so the artifact endpoint never
        // 404s (issue #39). `c` never ran.
        expect(handles.artifact.uploads.map((u) => u.name)).toEqual(["step-a.log", "step-b.log"]);
        const markerWrite = handles.sandbox.execs.find((e) => e.command.includes("stage=b"));
        expect(markerWrite?.command).toMatch(/stage=b error=ExecTimeout elapsedMs=\d+/);

        // The marker upload is R2-SOURCE mode: `path` is the marker exec's
        // own streamed R2 log key (`result.logPath`), and NO `container`
        // handle rides the upload — container-mode upload throws on the
        // facade backend (no Sandbox namespace wired), so the marker would
        // never land there.
        expect(handles.artifact.uploads[1]?.path).toBe("logs/fake/exec.ndjson");
        expect(handles.artifact.uploads[1]?.container).toBeUndefined();

        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain("run-c");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "failOnNonZeroExit off — a red stage still stops the sequence, exit surfaces as the run's exitCode",
    () => {
      // `set -e` semantics: later stages are dependents of the one that went
      // red, so they don't run — but with the flag off the Effect SUCCEEDS
      // (Action-mode contract: the exit code is data, the caller decides).
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "run-a": { exitCode: 3, durationMs: 700 },
          "run-b": { exitCode: 0 },
        },
        config: {
          "offload-test.stages:owner/name": "a,b",
          "offload-test.command:owner/name:a": "run-a",
          "offload-test.command:owner/name:b": "run-b",
        },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run({ ...webhookInput, failOnNonZeroExit: false });
        expect(result.exitCode).toBe(3);
        expect(result.durationMs).toBe(700);
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
          "test -d /workspace/name/.git",
          "run-a",
        ]);
        expect(handles.artifact.uploads.map((u) => u.name)).toEqual(["step-a.log"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "a malformed stage label fails the resolve step loudly — never a silent un-staging",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {},
        config: {
          "offload-test.stages:owner/name": "good, bad label!",
          "offload-test.command:owner/name": "pnpm test",
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(webhookInput));
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
        // Fail-fast: never cloned, never exec'd — a typo'd stages key degrading
        // to a single 40-min exec would resurrect the exact defect staging fixes.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  // Two stages MAY share a command — the facade keys exec identity on the
  // enclosing step as well as the command (#86), so they stay distinct
  // executions. A repo staging one command for the timeout/log split is a
  // legitimate config, so it must run both stages, not refuse.
  it.effect("two stages may share a command — both stages run", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0, stdout: "ok" } },
      config: {
        "offload-test.stages:owner/name": "quick,slow",
        "offload-test.command:owner/name": "pnpm test",
        "offload-test.timeoutSec:owner/name:slow": "1800",
      },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(offloadTest.run(webhookInput));
      expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
        "test -d /workspace/name/.git",
        "pnpm test",
        "test -d /workspace/name/.git",
        "pnpm test",
      ]);
      expect(handles.artifact.uploads.map((u) => u.name)).toEqual([
        "step-quick.log",
        "step-slow.log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a duplicate stage label fails the resolve step loudly", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {},
      config: {
        "offload-test.stages:owner/name": "build,test,build",
        "offload-test.command:owner/name": "pnpm test",
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(webhookInput));
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
      // Two `exec-build` steps would mint two `step-build.log` artifacts, the
      // second silently clobbering the first — refused before any work.
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a whitespace-only stages value fails loudly — a present key never silently un-stages",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {},
        config: {
          "offload-test.stages:owner/name": " , ",
          "offload-test.command:owner/name": "pnpm test",
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(webhookInput));
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.failureOption(exit.cause))
          : undefined;
        expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("offload-test isolated stages", () => {
  const webhookInput = {
    repo: "owner/name",
    sha: "abc123",
    secrets: [] as readonly string[],
    failOnNonZeroExit: true,
  };

  it.effect(
    "each stage acquires its OWN workspace inside its retryable step — no shared checkout",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "run-a": { exitCode: 0, durationMs: 100 },
          "run-b": { exitCode: 0, durationMs: 200 },
        },
        config: {
          "offload-test.stages:owner/name": "a,b",
          "offload-test.command:owner/name:a": "run-a",
          "offload-test.command:owner/name:b": "run-b",
          "offload-test.stageConcurrency:owner/name": "2",
          "offload-test.install:owner/name": "true",
        },
      });

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(webhookInput);

        // No `checkout` step at all — a shared container would be one acquired
        // and never used.
        const stepNames = handles.executions.steps.map((s) => s.name);
        expect(stepNames).not.toContain("checkout");
        expect(stepNames).toContain("exec-a");
        expect(stepNames).toContain("exec-b");

        // One container PER STAGE, named by the stage — and the clone inside the
        // stage's own retryable step. That placement is the point: a platform
        // retry after a container death re-runs the acquire and the clone, so
        // the command does not land on a fresh disk with no checkout.
        //
        // Counted by DISTINCT KEY rather than by call: `acquire` derives an id
        // and provisions nothing, so the reaper re-deriving it to destroy it is
        // a second call to the same container, not a second container.
        expect(new Set(handles.sandbox.acquired.map((x) => x.key))).toEqual(
          new Set(["a", "b"]),
        );
        // And each one is given back rather than left to idle out `sleepAfter`.
        expect(new Set(handles.sandbox.destroyed)).toEqual(
          new Set(["fake-container:a", "fake-container:b"]),
        );
        expect(handles.sandbox.clones).toEqual([
          { repo: "owner/name", sha: "abc123" },
          { repo: "owner/name", sha: "abc123" },
        ]);

        // The retry contract is unchanged — it is the UNIT that changed.
        const execA = handles.executions.steps.find((s) => s.name === "exec-a");
        expect(execA?.metadata?.["stepOpts.retries"]).toBe(3);
        expect(execA?.metadata?.["stepOpts.retryOn"]).toEqual([
          "ExecFailed",
          "StepFailed",
          "CheckoutFailed",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.durationMs).toBe(300);
        expect(handles.artifact.uploads.map((u) => u.name).sort()).toEqual([
          "step-a.log",
          "step-b.log",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a stage whose workspace never comes up still gives its container back", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        // The stage dies before it ever runs its command — the shape a failed
        // acquire/clone/install takes. Enumerated cleanup would have missed it.
        "run-a": { fail: "ExecFailed", exitCode: -1, stderrTail: "container died" },
        "run-b": { exitCode: 0 },
      },
      config: {
        // Two stages, because concurrency is clamped to the stage count — one
        // stage is never isolated however high the knob goes.
        "offload-test.stages:owner/name": "a,b",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.stageConcurrency:owner/name": "2",
      },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(offloadTest.run(webhookInput));
      expect(handles.sandbox.destroyed).toContain("fake-container:a");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a red stage does not skip its peers — every stage runs, then the run reports", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "run-a": { exitCode: 0 },
        "run-b": { exitCode: 2 },
        "run-c": { exitCode: 0 },
      },
      config: {
        "offload-test.stages:owner/name": "a,b,c",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.command:owner/name:c": "run-c",
        "offload-test.stageConcurrency:owner/name": "3",
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(webhookInput));

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
      expect((failure as { exitCode?: number })?.exitCode).toBe(2);

      // `c` RAN — it is not a dependent of `b`, and the whole reason for its
      // own container is that it never was. Sequential mode's `⊘ skipped` has
      // no meaning here and must not appear.
      expect(handles.sandbox.execs.map((e) => e.command).sort()).toEqual([
        "run-a",
        "run-b",
        "run-c",
      ]);
      const summaryMd = (failure as { summaryMd?: string })?.summaryMd ?? "";
      expect(summaryMd).toContain("✓ `a`");
      expect(summaryMd).toContain("✗ `b`");
      expect(summaryMd).toContain("✓ `c`");
      expect(summaryMd).not.toContain("⊘");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a dead isolated stage still lands a marker under its own log name", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "run-a": { exitCode: 0 },
        "run-b": { fail: "ExecTimeout", timeoutSec: 600 },
      },
      config: {
        "offload-test.stages:owner/name": "a,b",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.stageConcurrency:owner/name": "2",
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(webhookInput));

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
      expect((failure as { step?: string })?.step).toBe("exec-b");

      // The dead stage's own container went with it and no peer's is reachable
      // from here, so the marker acquires one of its own — `step-b.log` has to
      // resolve, because a death is exactly when someone opens it.
      const markerWrite = handles.sandbox.execs.find((e) => e.command.includes("stage=b"));
      expect(markerWrite?.command).toMatch(/stage=b error=ExecTimeout elapsedMs=\d+/);
      expect(handles.artifact.uploads.map((u) => u.name).sort()).toEqual([
        "step-a.log",
        "step-b.log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("one stage's failed log upload does not cancel its peers", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "run-a": { exitCode: 0 },
        "run-b": { exitCode: 0 },
        "run-c": { exitCode: 0 },
      },
      config: {
        "offload-test.stages:owner/name": "a,b,c",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.command:owner/name:c": "run-c",
        "offload-test.stageConcurrency:owner/name": "3",
      },
      artifactUploadFailures: ["step-b.log"],
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(offloadTest.run(webhookInput));

      // Every stage still RAN. Letting the upload failure escape would have
      // interrupted the concurrent peers, so one R2 hiccup would take down
      // stages that had nothing to do with it.
      expect(handles.sandbox.execs.map((e) => e.command).sort()).toEqual([
        "run-a",
        "run-b",
        "run-c",
      ]);
      expect(handles.artifact.uploads.map((u) => u.name).sort()).toEqual([
        "step-a.log",
        "step-c.log",
      ]);

      // And it still fails the run — naming the upload step, not calling the
      // stage dead: it ran to a verdict, and only the log is missing.
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("StepFailed");
      expect((failure as { step?: string })?.step).toBe("upload-log-b");
      const summaryMd = (failure as { summaryMd?: string })?.summaryMd ?? "";
      expect(summaryMd).toContain("did not upload");
      expect(summaryMd).not.toContain("died");
    }).pipe(Effect.provide(layer));
  });

  it.effect("concurrency of 1 keeps the shared container and the dependent semantics", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "run-a": { exitCode: 0 }, "run-b": { exitCode: 0 } },
      config: {
        "offload-test.stages:owner/name": "a,b",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.stageConcurrency:owner/name": "1",
      },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run(webhookInput);
      // One checkout, one container, shared — the pre-isolation behaviour, and
      // the default an absent key resolves to.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-command",
        "checkout",
        "exec-a",
        "upload-log-a",
        "exec-b",
        "upload-log-b",
      ]);
      expect(handles.sandbox.acquired).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("concurrency above the stage count is clamped, not honoured as written", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "run-a": { exitCode: 0 }, "run-b": { exitCode: 0 } },
      config: {
        "offload-test.stages:owner/name": "a,b",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        "offload-test.stageConcurrency:owner/name": "16",
      },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run(webhookInput);
      // Two stages can never need more than two containers; asking for 16 is a
      // typo, and honouring it would be a bill rather than a speed-up.
      expect(new Set(handles.sandbox.acquired.map((x) => x.key))).toEqual(new Set(["a", "b"]));
    }).pipe(Effect.provide(layer));
  });
});

// --- Per-repo secrets (webhook mode) -----------------------------------------
// The trigger pins `secrets: []`, so a webhook dispatch names its credentials
// in `offload-test.secrets:<repo>`. Names are checkpointed; values are not.

/**
 * Wrap the ambient StepRunner so every step's success value is captured — the
 * value CF Workflows would checkpoint. Lets a test assert that no secret VALUE
 * ever rides a step result.
 */
const recordStepResults = (into: { name: string; result: unknown }[]) =>
  Layer.effect(
    StepRunner,
    Effect.map(StepRunner, (inner): StepRunnerService => ({
      waitForEvent: inner.waitForEvent,
      run: (name, body, opts) =>
        inner.run(name, body, opts).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              into.push({ name, result });
            }),
          ),
        ),
    })),
  );

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.match(Cause.failureOption(exit.cause), {
        onSome: (f) => (f as { _tag?: string })._tag,
        onNone: () => undefined,
      })
    : undefined;

describe("offload-test per-repo secrets", () => {
  const webhookInput = {
    repo: "owner/name",
    sha: "abc123",
    secrets: [] as readonly string[],
    failOnNonZeroExit: true,
  };
  const TOKEN = "tok-registry-5f3a9c";
  const EXTRA = "extra-value-81d2";
  const SECRETS_KEY = "offload-test.secrets:owner/name";

  const expectNoSecretInSteps = (results: { name: string; result: unknown }[]) => {
    expect(results.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(EXTRA);
  };

  it.effect(
    "single exec — KV-named secrets reach the command and the install, never a step result",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "pnpm test": { exitCode: 0, stdout: `auth ${TOKEN}` },
          "pnpm install --frozen-lockfile": { exitCode: 0, stdout: `registry ${TOKEN}` },
        },
        secrets: { NODE_AUTH_TOKEN: TOKEN, EXTRA_KEY: EXTRA },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "true",
          // Trimmed, empties dropped.
          [SECRETS_KEY]: " NODE_AUTH_TOKEN , ,EXTRA_KEY ",
          "offload-test.secret-prefix:owner/name": "ci/",
        },
      });
      const steps: { name: string; result: unknown }[] = [];

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(webhookInput);
        expect(result.exitCode).toBe(0);

        const expected = { NODE_AUTH_TOKEN: TOKEN, EXTRA_KEY: EXTRA };
        const testExec = handles.sandbox.execs.find((e) => e.command === "pnpm test");
        expect(testExec?.env).toEqual(expected);

        // The install runs inside `checkout`, before the command — a private
        // registry needs the token there, and its log is scrubbed.
        const install = handles.sandbox.execs.find(
          (e) => e.command === "pnpm install --frozen-lockfile",
        );
        expect(install?.env).toEqual(expected);
        expect(install?.stdout).not.toContain(TOKEN);
        expect(testExec?.stdout).not.toContain(TOKEN);

        // Same step list as any webhook run — no new step for secrets.
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-command",
          "checkout",
          "exec",
          "upload-log",
        ]);
        // The resolve step checkpoints the NAMES (and prefix), never values.
        const resolved = steps.find((s) => s.name === "resolve-command")?.result as {
          secretNames?: readonly string[];
          secretPrefix?: string;
        };
        expect(resolved.secretNames).toEqual(["NODE_AUTH_TOKEN", "EXTRA_KEY"]);
        expect(resolved.secretPrefix).toBe("ci/");
        expectNoSecretInSteps(steps);
      }).pipe(Effect.provide(recordStepResults(steps)), Effect.provide(layer));
    },
  );

  it.effect("sequential stages — every stage's exec receives the KV-named secrets", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "run-a": { exitCode: 0, stdout: `a ${TOKEN}` },
        "run-b": { exitCode: 0 },
      },
      secrets: { NODE_AUTH_TOKEN: TOKEN },
      config: {
        "offload-test.stages:owner/name": "a,b",
        "offload-test.command:owner/name:a": "run-a",
        "offload-test.command:owner/name:b": "run-b",
        [SECRETS_KEY]: "NODE_AUTH_TOKEN",
      },
    });
    const steps: { name: string; result: unknown }[] = [];

    return Effect.gen(function* () {
      const result = yield* offloadTest.run(webhookInput);
      expect(result.exitCode).toBe(0);
      for (const command of ["run-a", "run-b"]) {
        expect(handles.sandbox.execs.find((e) => e.command === command)?.env).toEqual({
          NODE_AUTH_TOKEN: TOKEN,
        });
      }
      expect(handles.executions.steps.map((s) => s.name)).toContain("checkout");
      expectNoSecretInSteps(steps);
    }).pipe(Effect.provide(recordStepResults(steps)), Effect.provide(layer));
  });

  it.effect(
    "isolated stages — each stage's own workspace install and exec receive the secrets",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: {
          "run-a": { exitCode: 0, stdout: `a ${TOKEN}` },
          "run-b": { exitCode: 0 },
        },
        secrets: { NODE_AUTH_TOKEN: TOKEN },
        config: {
          "offload-test.stages:owner/name": "a,b",
          "offload-test.command:owner/name:a": "run-a",
          "offload-test.command:owner/name:b": "run-b",
          "offload-test.stageConcurrency:owner/name": "2",
          "offload-test.install:owner/name": "true",
          [SECRETS_KEY]: "NODE_AUTH_TOKEN",
        },
      });
      const steps: { name: string; result: unknown }[] = [];

      return Effect.gen(function* () {
        const result = yield* offloadTest.run(webhookInput);
        expect(result.exitCode).toBe(0);
        expect(handles.executions.steps.map((s) => s.name)).not.toContain("checkout");

        for (const command of ["run-a", "run-b"]) {
          expect(handles.sandbox.execs.find((e) => e.command === command)?.env).toEqual({
            NODE_AUTH_TOKEN: TOKEN,
          });
        }
        // One install per stage, each inside its stage's retryable step.
        const installs = handles.sandbox.execs.filter(
          (e) => e.command === "pnpm install --frozen-lockfile",
        );
        expect(installs).toHaveLength(2);
        for (const install of installs) {
          expect(install.env).toEqual({ NODE_AUTH_TOKEN: TOKEN });
        }
        expectNoSecretInSteps(steps);
      }).pipe(Effect.provide(recordStepResults(steps)), Effect.provide(layer));
    },
  );

  it.effect("dispatch-supplied secrets override the KV names", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "pnpm test": { exitCode: 0 } },
      secrets: { NODE_AUTH_TOKEN: TOKEN, EXTRA_KEY: EXTRA },
      config: {
        "offload-test.command:owner/name": "pnpm test",
        [SECRETS_KEY]: "NODE_AUTH_TOKEN",
      },
    });

    return Effect.gen(function* () {
      yield* offloadTest.run({ ...webhookInput, secrets: ["EXTRA_KEY"] });
      expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.env).toEqual({
        EXTRA_KEY: EXTRA,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a KV-named secret with no Worker value fails with SecretsMissing before checkout",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          [SECRETS_KEY]: "NODE_AUTH_TOKEN",
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(offloadTest.run(webhookInput));
        expect(failureTag(exit)).toBe("SecretsMissing");
        // Fail-fast: no container work at all — not even the clone.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
        expect(handles.executions.steps.map((s) => s.name)).toEqual(["resolve-command"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "absent key — same steps, same resolve-step result, no env; no dispatcher-wide fallback",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "pnpm test": { exitCode: 0 } },
        secrets: { NODE_AUTH_TOKEN: TOKEN },
        config: {
          "offload-test.command:owner/name": "pnpm test",
          "offload-test.install:owner/name": "true",
          // An unscoped list is NOT a fallback — secrets stay per-repo.
          "offload-test.secrets": "NODE_AUTH_TOKEN",
        },
      });
      const steps: { name: string; result: unknown }[] = [];

      return Effect.gen(function* () {
        yield* offloadTest.run(webhookInput);
        expect(handles.executions.steps.map((s) => s.name)).toEqual([
          "resolve-command",
          "checkout",
          "exec",
          "upload-log",
        ]);
        // Exactly the pre-secrets checkpoint shape.
        expect(steps.find((s) => s.name === "resolve-command")?.result).toStrictEqual({
          command: "pnpm test",
          install: true,
          timeoutSec: undefined,
        });
        expect(handles.sandbox.execs.find((e) => e.command === "pnpm test")?.env).toEqual({});
        const install = handles.sandbox.execs.find(
          (e) => e.command === "pnpm install --frozen-lockfile",
        );
        expect(install?.env).toBeUndefined();
      }).pipe(Effect.provide(recordStepResults(steps)), Effect.provide(layer));
    },
  );
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
// A grep guard per specs/pm/plan.md § 6 — the run body must not introduce
// non-determinism; replay-sensitive values come from checkpointed step results
// (or `io`), so Workflow checkpoint replay is consistent.
describe("offload-test source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(
        fileURLToPath(new URL("./offload-test.ts", import.meta.url)),
        "utf8",
      );
      // Strip line comments so a mention in a comment never trips the guard.
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );
});

describe("run ceiling (issue #42)", () => {
  it("covers one documented 1800 s exec plus setup, and bounds its retries", () => {
    // Four aligned 1800 s exec attempts ran 3h11m; the ceiling ends that at an hour.
    expect(offloadTest.limits.maxDurationSec).toBeGreaterThanOrEqual(3600);
    expect(offloadTest.limits.maxDurationSec).toBeLessThan(4 * 1800);
  });
});
