// Run-level unit tests for the `check` run.
//
// Exercise the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network. Covers:
//
//   (a) not configured — no `check.command:<repo>` → no-op green
//   (b) KV resolve     — webhook-shaped input resolves the per-repo command
//   (c) input wins     — explicit `command` skips needing KV
//   (d) green path     — exit 0 → output + four steps
//   (e) red path       — exit 1 + failOnNonZeroExit → AcceptanceFailed
//   (f) advisory       — failOnNonZeroExit off → successful Effect, exitCode 1
//   (g) install        — install:true runs cached dep install before command
//   (h) secrets        — Worker secrets inject into exec env; missing → SecretsMissing
//   (i) webhook trig   — PR payload maps to inputs; gate skips drafts/dependabot
//
// Plus the standard determinism source guard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Cause, Effect, Either, Exit, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { Sandbox, type CheckCommandService } from "@fractalboxdev/flare-dispatch-core";
import { check } from "./check";

const CHECK_CMD = "pnpm lint";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  command: CHECK_CMD,
  install: false,
  secrets: [] as readonly string[],
  failOnNonZeroExit: false,
} as const;

describe("check", () => {
  it.effect(
    "long checks checkpoint one prepared process and preserve an actual nonzero verdict",
    () => {
      const { layer, handles } = makeCFRuntimeTest();
      const calls: string[] = [];
      const durable: CheckCommandService = {
        prepare: (opts) =>
          Effect.sync(() => {
            calls.push("prepare");
            expect(opts.timeoutSec).toBe(1800);
            return {
              id: "stable-command",
              container: opts.container!,
              fingerprint: "stable",
              startedAt: 1000,
              deadline: 1801000,
            };
          }),
        start: (h) =>
          Effect.sync(() => {
            calls.push("start");
            expect(h.deadline).toBe(1801000);
          }),
        observe: (h) =>
          Effect.sync(() => {
            calls.push("observe");
            expect(h.deadline).toBe(1801000);
            return { state: "exited", exitCode: 7, durationMs: 27 };
          }),
        finalize: () =>
          Effect.sync(() => {
            calls.push("finalize");
            return {
              exitCode: 7,
              durationMs: 27,
              logPath: "logs/actual.ndjson",
              stdout: "",
              stderr: "actual failure",
            };
          }),
      };
      return Effect.gen(function* () {
        const original = yield* Sandbox;
        const result = yield* Effect.either(
          check
            .run({ ...baseInput, timeoutSec: 1800, failOnNonZeroExit: true })
            .pipe(Effect.provideService(Sandbox, { ...original, checkCommand: durable })),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) expect(result.left).toMatchObject({ exitCode: 7 });
        expect(calls).toEqual(["prepare", "start", "observe", "finalize"]);
        expect(handles.sandbox.execs.map((e) => e.command)).not.toContain(CHECK_CMD);
        expect(handles.executions.steps.map((s) => s.name)).toContain("exec-finalize");
      }).pipe(Effect.provide(layer));
    },
  );
  const lossyDurable = (lostAttempts: number, calls: string[]): CheckCommandService => ({
    prepare: (opts) =>
      Effect.sync(() => {
        calls.push(`prepare:${opts.stepName}`);
        return {
          id: `handle-${opts.stepName}`,
          container: opts.container!,
          fingerprint: "stable",
          startedAt: 1000,
          deadline: 1801000,
        };
      }),
    start: (h) => Effect.sync(() => void calls.push(`start:${h.id}`)),
    observe: (h) =>
      Effect.sync(() => {
        calls.push(`observe:${h.id}`);
        const attempt = calls.filter((c) => c.startsWith("prepare:")).length;
        return attempt <= lostAttempts
          ? { state: "missing" as const }
          : { state: "exited" as const, exitCode: 0, durationMs: 27 };
      }),
    finalize: (h) =>
      Effect.sync(() => {
        calls.push(`finalize:${h.id}`);
        return { exitCode: 0, durationMs: 27, logPath: "logs/relaunched.ndjson", stdout: "", stderr: "" };
      }),
  });
  it.effect(
    "a long check whose process is lost with its container relaunches in a fresh container and reports that verdict",
    () => {
      const { layer, handles } = makeCFRuntimeTest();
      const calls: string[] = [];
      return Effect.gen(function* () {
        const original = yield* Sandbox;
        const result = yield* check
          .run({ ...baseInput, timeoutSec: 1800, failOnNonZeroExit: true })
          .pipe(
            Effect.provideService(Sandbox, { ...original, checkCommand: lossyDurable(1, calls) }),
          );
        expect(result.exitCode).toBe(0);
        expect(calls).toEqual([
          "prepare:exec",
          "start:handle-exec",
          "observe:handle-exec",
          "prepare:exec-relaunch-1",
          "start:handle-exec-relaunch-1",
          "observe:handle-exec-relaunch-1",
          "finalize:handle-exec-relaunch-1",
        ]);
        expect(handles.sandbox.destroyed).toContain("fake-container");
        expect(handles.executions.steps.map((s) => s.name)).toEqual(
          expect.arrayContaining(["exec-observe-0", "exec-relaunch-1-observe-0", "exec-relaunch-1-finalize"]),
        );
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect(
    "a long check that loses its process on every launch fails as a sandbox loss, never a command verdict",
    () => {
      const { layer } = makeCFRuntimeTest();
      const calls: string[] = [];
      return Effect.gen(function* () {
        const original = yield* Sandbox;
        const exit = yield* Effect.exit(
          check
            .run({ ...baseInput, timeoutSec: 1800, failOnNonZeroExit: true })
            .pipe(
              Effect.provideService(Sandbox, { ...original, checkCommand: lossyDurable(99, calls) }),
            ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
          expect(failure).toMatchObject({ _tag: "SandboxProcessLost", launches: 3 });
        }
        expect(calls.filter((c) => c.startsWith("prepare:"))).toHaveLength(3);
        expect(calls.some((c) => c.startsWith("finalize:"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("not configured — no per-repo command no-ops green: nothing cloned or exec'd", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
    });
    const input = {
      repo: "owner/name",
      sha: "abc123",
      install: false,
      secrets: [] as readonly string[],
      failOnNonZeroExit: true,
    };

    return Effect.gen(function* () {
      const result = yield* check.run(input);

      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(result.skippedReason).toBe("not-configured");
      expect(result.logUri).toBeUndefined();
      expect(handles.sandbox.clones).toHaveLength(0);
      expect(handles.sandbox.execs).toHaveLength(0);
      expect(handles.executions.steps.map((s) => s.name)).toEqual(["resolve-config"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "webhook command resolution — resolves `check.command:<repo>` from the config store",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        config: { "check.command:owner/name": CHECK_CMD },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);
        expect(result.skippedReason).toBeUndefined();
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(CHECK_CMD);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "per-repo timeout — `check.timeoutSec:<repo>` reaches exec, over the 600s default",
    () => {
      // This gate was built for linters, so the default is 600s. A repo whose
      // `check.command` COMPILES has to say otherwise, and webhook mode has no
      // other channel: the trigger's `inputs` is sync + payload-only and omits
      // `timeoutSec` entirely, so without this key such a command is killed
      // mid-build with nothing an operator can configure.
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        config: {
          "check.command:owner/name": CHECK_CMD,
          "check.timeoutSec:owner/name": "1800",
        },
      });
      const input = {
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      };

      return Effect.gen(function* () {
        yield* check.run(input);
        const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
        expect(exec).toBeDefined();
        expect(exec?.timeoutSec).toBe(1800);

        // The STEP wrapping the exec carries that ceiling plus headroom — the
        // exec's own deadline must fire first, yielding a log — and retries
        // ONLY the platform. A command that runs and exits non-zero is a normal
        // `ExecResult`, so `retryOn: ExecFailed` cannot replay a verdict; it
        // covers the case where the container failed the command never ran.
        const execStep = handles.executions.steps.find((s) => s.name === "exec");
        expect(execStep?.metadata?.["stepOpts.timeoutSec"]).toBe(1800 + 120);
        expect(execStep?.metadata?.["stepOpts.retries"]).toBe(3);
        expect(execStep?.metadata?.["stepOpts.retryOn"]).toEqual([
          "ExecFailed",
          "StepFailed",
          "CheckoutFailed",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("per-repo timeout — absent key keeps the 600s default", () => {
    // The control. Without it the assertion above passes for a run that ignores
    // the key entirely and is handed 1800 by some other path.
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      config: { "check.command:owner/name": CHECK_CMD },
    });
    const input = {
      repo: "owner/name",
      sha: "abc123",
      install: false,
      secrets: [] as readonly string[],
      failOnNonZeroExit: true,
    };

    return Effect.gen(function* () {
      yield* check.run(input);
      const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
      expect(exec?.timeoutSec).toBe(600);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "labelled gate — `check.command:<repo>:<label>` wins over the repo's default gate",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "shellcheck scripts/deploy.sh": { exitCode: 0 } },
        config: {
          "check.command:owner/name:lint-shell": "shellcheck scripts/deploy.sh",
          "check.command:owner/name": CHECK_CMD,
        },
      });

      return Effect.gen(function* () {
        const result = yield* check.run({
          repo: "owner/name",
          sha: "abc123",
          checkLabel: "lint-shell",
          install: false,
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        expect(result.exitCode).toBe(0);
        expect(handles.sandbox.execs.map((e) => e.command)).toEqual([
          "test -d /workspace/name/.git",
          "shellcheck scripts/deploy.sh",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "labelled gate — a label with no key of its own falls back to the repo's default gate",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        config: { "check.command:owner/name": CHECK_CMD },
      });

      return Effect.gen(function* () {
        const result = yield* check.run({
          repo: "owner/name",
          sha: "abc123",
          checkLabel: "unconfigured",
          install: false,
          secrets: [] as readonly string[],
          failOnNonZeroExit: true,
        });
        // Adding a second gate to a repo must not require re-keying the first.
        expect(result.exitCode).toBe(0);
        expect(handles.sandbox.execs.map((e) => e.command)).toContain(CHECK_CMD);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("labelled gate — an UNLABELLED dispatch never reads a labelled key", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "shellcheck scripts/deploy.sh": { exitCode: 0 } },
      // Only a labelled key exists — the repo's default gate is unconfigured.
      config: {
        "check.command:owner/name:lint-shell": "shellcheck scripts/deploy.sh",
      },
    });

    return Effect.gen(function* () {
      const result = yield* check.run({
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [] as readonly string[],
        failOnNonZeroExit: true,
      });
      // The opt-out contract is per-key: configuring one labelled gate must
      // not silently opt the repo's webhook-triggered default gate in.
      expect(result.skippedReason).toBe("not-configured");
      expect(handles.sandbox.execs).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it("key confusion — a `repo` carrying `:` is rejected by the input schema", () => {
    // `check.command:<repo>[:<label>]` has two `:`-delimited segments, so an
    // unconstrained `repo` makes them ambiguous: repo `owner/name:lint-shell`
    // with no label resolves the key belonging to `owner/name`'s `lint-shell`
    // gate. GitHub repo names cannot contain `:`, so rejecting it at the schema
    // keeps one repo's config unreachable from another's dispatch.
    const decode = Schema.decodeUnknownEither(check.inputs);
    expect(Either.isLeft(decode({ repo: "owner/name:lint-shell", sha: "abc123" }))).toBe(true);
    expect(Either.isRight(decode({ repo: "owner/name", sha: "abc123" }))).toBe(true);
    // Legal GitHub names keep working — dots, underscores, hyphens.
    expect(Either.isRight(decode({ repo: "my-org/my_repo.js", sha: "abc123" }))).toBe(true);
  });

  it.effect("labelled gate — the red-check summary names the gate that failed", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 1 } },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        check.run({
          ...baseInput,
          checkLabel: "codegen",
          failOnNonZeroExit: true,
        }),
      );
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { summaryMd?: string } | undefined)?.summaryMd).toContain("check:codegen");
    }).pipe(Effect.provide(layer));
  });

  it.effect("input command wins — explicit command skips needing KV", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      // KV has a different command — input must win.
      config: { "check.command:owner/name": "npx eslint ." },
    });

    return Effect.gen(function* () {
      const result = yield* check.run(baseInput);
      expect(result.exitCode).toBe(0);
      expect(handles.sandbox.execs.map((e) => e.command)).toContain(CHECK_CMD);
      expect(handles.sandbox.execs.map((e) => e.command)).not.toContain("npx eslint .");
    }).pipe(Effect.provide(layer));
  });

  it.effect("green path — exit 0, four steps, log uploaded", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0, durationMs: 1234 } },
    });

    return Effect.gen(function* () {
      const result = yield* check.run(baseInput);

      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(1234);
      expect(result.skippedReason).toBeUndefined();
      expect(typeof result.logUri).toBe("string");
      expect(result.logUri!.length).toBeGreaterThan(0);

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

  it.effect("red path — exit 1 with failOnNonZeroExit ON fails with AcceptanceFailed", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [CHECK_CMD]: { exitCode: 1, stderr: "1 error" },
      },
    });
    const input = { ...baseInput, failOnNonZeroExit: true };

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(check.run(input));

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.failureOption(exit.cause))
        : undefined;
      expect((failure as { _tag?: string })?._tag).toBe("AcceptanceFailed");
      expect((failure as { exitCode?: number })?.exitCode).toBe(1);

      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "checkout",
        "exec",
        "upload-log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("advisory mode — failOnNonZeroExit off makes a finding a successful Effect", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 1 } },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(check.run(baseInput));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("install — runs the cached dependency install before the check command", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
    });
    const input = { ...baseInput, install: true, image: "custom/image:1" };

    return Effect.gen(function* () {
      const result = yield* check.run(input);
      expect(result.exitCode).toBe(0);

      expect(handles.sandbox.acquired[0]).toEqual({
        image: "custom/image:1",
      });

      const commands = handles.sandbox.execs.map((e) => e.command);
      expect(commands).toContain("pnpm install --frozen-lockfile");
      expect(commands.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
        commands.indexOf(CHECK_CMD),
      );

      // Install lives inside checkout — still four run steps.
      expect(handles.executions.steps.map((s) => s.name)).toEqual([
        "resolve-config",
        "checkout",
        "exec",
        "upload-log",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "secrets — Worker secret values are injected into the exec env, per-dispatch env wins",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
        secrets: {
          NPM_TOKEN: "token_from_worker",
          REGISTRY_URL: "https://store.example.com",
        },
      });
      const input = {
        ...baseInput,
        secrets: ["NPM_TOKEN", "REGISTRY_URL"],
        // Collides with the Worker secret — the per-dispatch value wins.
        env: { REGISTRY_URL: "https://dispatch.example.com" },
      };

      return Effect.gen(function* () {
        const result = yield* check.run(input);
        expect(result.exitCode).toBe(0);

        const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
        expect(exec?.env).toEqual({
          NPM_TOKEN: "token_from_worker",
          REGISTRY_URL: "https://dispatch.example.com",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "secrets — a named-but-unset secret fails with SecretsMissing before checkout or exec",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { [CHECK_CMD]: { exitCode: 0 } },
      });
      const input = { ...baseInput, secrets: ["NPM_TOKEN"] };

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(check.run(input));

        expect(Exit.isFailure(exit)).toBe(true);
        const tag = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onSome: (f) => (f as { _tag?: string })._tag,
              onNone: () => undefined,
            })
          : undefined;
        expect(tag).toBe("SecretsMissing");
        // Fail-fast: secrets resolve BEFORE checkout — neither the clone nor
        // the check command ran, so a misconfigured dispatch never pays for
        // provisioning a container it can't use.
        expect(handles.sandbox.clones).toHaveLength(0);
        expect(handles.sandbox.execs).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("log redaction — secret values are scrubbed from captured stdout/stderr", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        [CHECK_CMD]: {
          exitCode: 0,
          stdout: "using token super-secret-value for install",
          stderr: "auth: super-secret-value",
        },
      },
      secrets: { NPM_TOKEN: "super-secret-value" },
    });
    const input = { ...baseInput, secrets: ["NPM_TOKEN"] };

    return Effect.gen(function* () {
      const result = yield* check.run(input);
      expect(result.exitCode).toBe(0);

      const exec = handles.sandbox.execs.find((e) => e.command === CHECK_CMD);
      expect(exec?.stdout).not.toContain("super-secret-value");
      expect(exec?.stderr).not.toContain("super-secret-value");
      expect(exec?.stdout).toContain("***");
      expect(exec?.stderr).toContain("***");
    }).pipe(Effect.provide(layer));
  });

  // --- Webhook trigger -------------------------------------------------------

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
    const trigger = check.triggers?.[0];
    expect(trigger?.event).toBe("pull_request");
    expect(trigger?.actions).toContain("synchronize");

    const ctx = { payload: prPayload() };
    expect(trigger?.inputs(ctx)).toEqual({
      repo: "owner/name",
      sha: "abcdef0123456789cafe",
      failOnNonZeroExit: true,
      install: false,
      secrets: [],
    });
    expect(trigger?.idempotencyKey(ctx)).toBe("check:owner_name:abcdef012345");
  });

  it("webhook trigger — gate skips drafts and dependabot, admits real PRs", () => {
    const gate = check.triggers?.[0]?.gate;
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
});

// --- Source guard: no direct Date.now() / crypto.randomUUID() in the run -----
describe("check source determinism", () => {
  it.effect("the run body never calls Date.now()/crypto.randomUUID()", () =>
    Effect.sync(() => {
      const src = readFileSync(fileURLToPath(new URL("./check.ts", import.meta.url)), "utf8");
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bDate\s*\.\s*now\b/);
      expect(code).not.toMatch(/\bcrypto\s*\.\s*randomUUID\b/);
      expect(code).not.toMatch(/\bMath\s*\.\s*random\b/);
    }),
  );

  it.effect("a recycled container is re-cloned rather than retried into", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        // The probe answers non-zero: the container was recycled between
        // durable steps and took the checkout with it. This is what the runtime
        // reports as `working directory … was missing at exec time`.
        "test -d /workspace/name/.git": { exitCode: 1 },
        "pnpm lint": { exitCode: 0 },
      },
      config: { "check.command:owner/name": "pnpm lint" },
    });

    return Effect.gen(function* () {
      const result = yield* check.run({
        repo: "owner/name",
        sha: "abc123",
        install: false,
        secrets: [],
        failOnNonZeroExit: true,
      });

      // TWO clones: the run's own checkout, then the rebuild inside the exec
      // step. Without it the command runs in a directory that is not there,
      // fails as `ExecFailed`, and is retried into the same absence three times
      // — reporting a missing directory as the repo's verdict.
      expect(handles.sandbox.clones).toEqual([
        { repo: "owner/name", sha: "abc123" },
        { repo: "owner/name", sha: "abc123" },
      ]);
      expect(result.exitCode).toBe(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("run ceiling (issue #42)", () => {
  it("covers a full 2700 s exec — the gate's per-stage ceiling — plus checkout and upload", () => {
    // A ceiling at the exec ceiling cuts every stage that uses its full exec
    // budget before the sandbox's own deadline reports `ExecTimeout`.
    expect(check.limits.maxDurationSec).toBeGreaterThanOrEqual(2700 + 1800);
  });
});
