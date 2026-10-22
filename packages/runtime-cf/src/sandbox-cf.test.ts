// Unit coverage for the detached-boot reliability surface of
// `makeSandboxCloudflareLive`: the wait-for-port timeout ceiling (A), log
// capture on a failed boot (B), the `exposePort` reachable-URL capability (C),
// exec result folding (D), and the clone's credential handling (E).
//
// The Layer imports `@cloudflare/sandbox` for the live `getSandbox` call, which
// Node + Vitest can't resolve outside a `vitest-pool-workers` environment — so
// we `vi.mock` it to return an in-memory fake `box`. That keeps these tests in
// the plain forks pool (no Miniflare, no container runtime) while exercising the
// Effect-layer behavior the SDK's own `timeout` does not reliably enforce. The
// timeout test uses Effect's `TestClock`, so it is instant rather than waiting
// out a real 120s ceiling.
//
// Spec: specs/03-dsl.md § sandbox.

import { it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option, TestClock } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { type PortNeverOpened, Sandbox as SandboxTag } from "@fractalboxdev/flare-dispatch-core";

// --- The fake `box` the mocked `getSandbox` hands back -----------------------

/** Build a fake `box` whose process/expose behavior the test controls. */
const makeFakeBox = (opts: {
  proc?: {
    waitForPort?: () => Promise<void>;
    logs?: { stdout: string; stderr: string };
    command?: string;
  } | null;
  exposePort?: (
    port: number,
    options: { hostname: string; name?: string },
  ) => Promise<{ url: string; port: number; name: string | undefined }>;
}) => {
  const getLogs = vi.fn(
    async () => opts.proc?.logs ?? { stdout: "boot stdout", stderr: "boot stderr" },
  );
  const waitForPort = vi.fn(opts.proc?.waitForPort ?? (() => Promise.resolve()));
  const proc =
    opts.proc === null
      ? null
      : {
          id: "proc-1",
          command: opts.proc?.command ?? "pnpm dev",
          waitForPort,
          getLogs,
        };
  return {
    // Default `exec` — tests that exercise the exec path override this.
    exec: vi.fn(async () => ({
      exitCode: 0,
      duration: 0,
      stdout: "",
      stderr: "",
    })),
    // No `gitCheckout`: the Layer clones with `exec` (the SDK's checkout owns an
    // object filter it does not expose). Its absence is the assertion — a Layer
    // that reached for it again would fail here rather than quietly regress.
    getProcess: vi.fn(async () => proc),
    exposePort: vi.fn(
      opts.exposePort ??
        (async (port: number) => ({
          url: `https://${port}-fake.example.com`,
          port,
          name: undefined,
        })),
    ),
    // The SDK's per-container transport pin. Recorded rather than stubbed away:
    // which containers got which transport is the whole assertion for the
    // canary knob.
    setTransport: vi.fn(async (t: string) => {
      transportCalls.push(t);
    }),
    _getLogs: getLogs,
    _waitForPort: waitForPort,
  };
};

/** Every `setTransport` the Layer issued, in order. */
const transportCalls: string[] = [];

// A stand-in for the SDK's `SessionTerminatedError` (thrown when a command's
// shell exits). `vi.hoisted` so it exists before the hoisted `vi.mock` factory
// runs and so the tests can construct instances the Layer will `instanceof`.
const { FakeSessionTerminatedError } = vi.hoisted(() => ({
  FakeSessionTerminatedError: class SessionTerminatedError extends Error {
    readonly exitCode?: number;
    constructor(exitCode?: number) {
      super(`session terminated (exit ${exitCode})`);
      this.name = "SessionTerminatedError";
      this.exitCode = exitCode;
    }
  },
}));

// `getSandbox(ns, id)` is the only thing the Layer pulls from the SDK; the mock
// returns whatever the current test installed via `currentBox`. The error class
// is needed for `execToResult`'s `instanceof` recovery path.
let currentBox: ReturnType<typeof makeFakeBox>;
// Every id the Layer routed by, in order. The mock used to ignore its `id`
// argument entirely, which is why no test could see that `exec` was resolving
// the execution's container rather than the handle it was passed — the defect
// that made five "isolated" stages share one filesystem.
const requestedSandboxIds: string[] = [];

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: (_ns: unknown, id: string) => {
    requestedSandboxIds.push(id);
    return currentBox;
  },
  SessionTerminatedError: FakeSessionTerminatedError,
}));

// The clone's credential resolution is stubbed here so these tests assert what
// the LAYER does with a token (embed it, scrub it, keep it out of the failure
// record) rather than re-testing the resolution — that lives, against a mocked
// api.github.com, in `sandbox-clone-auth.test.ts`.
const { resolveCloneToken } = vi.hoisted(() => ({ resolveCloneToken: vi.fn() }));
vi.mock("./sandbox-clone-auth", () => ({ resolveCloneToken }));

// Imported AFTER the mock is registered so the Layer binds the mocked SDK.
const { makeSandboxCloudflareLive, isWorkingDirFailure, STDERR_TAIL_MAX } =
  await import("./sandbox-cf");

/** A minimal R2 stub that records `put` calls. */
const makeBucket = () => {
  const puts: { key: string; body: unknown }[] = [];
  const bucket = {
    put: async (key: string, body: unknown) => {
      puts.push({ key, body });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
};

// The Layer only ever passes `ns` to the (mocked) `getSandbox`, so a bare stub
// suffices; the cast satisfies the `DurableObjectNamespace<Sandbox>` parameter.
const ns = {} as Parameters<typeof makeSandboxCloudflareLive>[0];
const handle = { id: "proc-1", container: { id: "exec-1" } };

/** Pull the typed failure value off an Exit, or `undefined` on success. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

describe("makeSandboxCloudflareLive — waitForPort timeout (A)", () => {
  it.effect("fails with PortNeverOpened at the ceiling when the SDK wait never resolves", () => {
    // The SDK `waitForPort` never resolves — modelling the ~17-min hang. The
    // Effect-layer ceiling must fail it fast at `timeoutSec`.
    currentBox = makeFakeBox({
      proc: { waitForPort: () => new Promise<void>(() => {}) },
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const fiber = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit, Effect.fork);

      // Advance virtual time past the 120s ceiling; the wait fails instantly.
      yield* TestClock.adjust(Duration.seconds(121));
      const exit = yield* Fiber.join(fiber);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(err?.port).toBe(4173);
      expect(err?.timeoutSec).toBe(120);

      // (B) the detached process's logs were captured to R2 on the failure
      // path, and the logPath is surfaced on the error for diagnosis.
      expect(puts.length).toBe(1);
      expect(err?.logPath).toBe(puts[0]?.key);
    });
  });
});

describe("makeSandboxCloudflareLive — log capture on boot failure (B)", () => {
  it.effect("captures logs and surfaces logPath when the SDK wait rejects", () => {
    // The SDK rejects immediately (not a hang) — still a failed boot; logs
    // must be captured and the logPath surfaced.
    currentBox = makeFakeBox({
      proc: {
        waitForPort: () => Promise.reject(new Error("port closed")),
        logs: { stdout: "starting…", stderr: "EADDRINUSE" },
      },
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(puts.length).toBe(1);
      expect(err?.logPath).toBe(puts[0]?.key);
      // The NDJSON body carries the detached process's captured stderr.
      expect(String(puts[0]?.body)).toContain("EADDRINUSE");
    });
  });

  it.effect("a log-capture failure does not mask the original PortNeverOpened", () => {
    // The process has vanished by the time we try to capture logs
    // (`getProcess` → null on the second call). The original timeout must
    // still surface — just without a logPath.
    let call = 0;
    currentBox = makeFakeBox({
      proc: {
        waitForPort: () => Promise.reject(new Error("port closed")),
      },
    });
    currentBox.getProcess = vi.fn(async () => {
      call += 1;
      // First call (inside the wait) sees the proc; the capture pass sees
      // none — the process is gone.
      return call === 1
        ? ({
            id: "proc-1",
            command: "pnpm dev",
            waitForPort: () => Promise.reject(new Error("port closed")),
            getLogs: async () => ({ stdout: "", stderr: "" }),
          } as never)
        : null;
    });
    const { bucket, puts } = makeBucket();
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
      ).pipe(Effect.provide(layer), Effect.exit);

      const err = failureOf<PortNeverOpened>(exit);
      expect(err?._tag).toBe("PortNeverOpened");
      expect(err?.logPath).toBeUndefined();
      expect(puts.length).toBe(0);
    });
  });
});

describe("makeSandboxCloudflareLive — exposePort (C)", () => {
  it.effect("returns the SDK preview URL, passing the preview hostname", () => {
    currentBox = makeFakeBox({
      exposePort: async (port, options) => ({
        url: `https://${port}-${options.hostname}/`,
        port,
        name: options.name,
      }),
    });
    const { bucket } = makeBucket();
    const layer = makeSandboxCloudflareLive(
      ns,
      bucket,
      "exec-1",
      undefined,
      "fd.example.workers.dev",
    );

    return Effect.gen(function* () {
      const result = yield* Effect.flatMap(SandboxTag, (s) => s.exposePort({ port: 4173 })).pipe(
        Effect.provide(layer),
      );

      expect(result.url).toBe("https://4173-fd.example.workers.dev/");
      expect(currentBox.exposePort).toHaveBeenCalledWith(4173, {
        hostname: "fd.example.workers.dev",
        name: undefined,
      });
    });
  });

  it.effect("fails with ExposePortFailed when no preview hostname is configured", () => {
    currentBox = makeFakeBox({});
    const { bucket } = makeBucket();
    // No `previewHostname` — the SDK cannot build a URL, so the run fails
    // loudly rather than handing the suite an unreachable localhost.
    const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) => s.exposePort({ port: 4173 })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      const err = failureOf<{ _tag: string }>(exit);
      expect(err?._tag).toBe("ExposePortFailed");
      expect(currentBox.exposePort).not.toHaveBeenCalled();
    });
  });
});

// (D) exec result folding — a command that RAN (any exit code, even one whose
// shell then exited) is a result the run can report + upload artifacts for;
// only a could-not-launch error is an Effect failure. This is what lets a
// failing `playwright-demo` still surface its videoUri/logUri.
describe("makeSandboxCloudflareLive — container routing", () => {
  const routingLayer = () => makeSandboxCloudflareLive(ns, makeBucket().bucket, "route-1");

  it.effect("acquire is one container per execution, and a distinct one per key", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      const [a, b, keyed, keyed2] = yield* Effect.flatMap(SandboxTag, (s) =>
        Effect.all([
          s.acquire({}),
          s.acquire({}),
          s.acquire({ key: "features" }),
          s.acquire({ key: "workspace" }),
        ]),
      ).pipe(Effect.provide(routingLayer()));

      expect(a.id).toBe(b.id);
      expect(keyed.id).not.toBe(a.id);
      expect(keyed2.id).not.toBe(keyed.id);
      // Ids stay DNS-safe and inside the preview-URL budget — the constraint
      // `previewSafeSandboxId` exists for, now applied to keyed ids too.
      for (const c of [a, keyed, keyed2]) {
        expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
        expect(c.id.length).toBeLessThanOrEqual(40);
      }
    }),
  );

  it.effect("no transport option leaves the container on the SDK default", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      transportCalls.length = 0;
      yield* Effect.flatMap(SandboxTag, (s) => s.acquire({})).pipe(
        Effect.provide(makeSandboxCloudflareLive(ns, makeBucket().bucket, "route-2")),
      );
      // Untouched: the Layer pins only what its caller resolved. The runtime
      // always passes one (`resolveSandboxTransport`), so this is the SDK
      // default for a caller that opts out.
      expect(transportCalls).toEqual([]);
    }),
  );

  it.effect("a transport option pins EVERY container the execution acquires", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      transportCalls.length = 0;
      yield* Effect.flatMap(SandboxTag, (s) =>
        Effect.all([s.acquire({}), s.acquire({ key: "features" })]),
      ).pipe(
        Effect.provide(
          makeSandboxCloudflareLive(
            ns,
            makeBucket().bucket,
            "route-3",
            undefined,
            undefined,
            undefined,
            "rpc",
          ),
        ),
      );
      // Per CONTAINER, not per Layer: a keyed container is a different DO and
      // carries its own transport, so pinning the first would leave the stage
      // containers on the compatibility client — which is where the streaming
      // file APIs do not exist.
      expect(transportCalls).toEqual(["rpc", "rpc"]);
    }),
  );

  it.effect("re-acquiring a container does not re-pin it", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      transportCalls.length = 0;
      yield* Effect.flatMap(SandboxTag, (s) =>
        // Three acquires, two containers. `acquire` is also how a caller derives
        // an id without provisioning — `ensureWorkspace` on a rebuild, and the
        // stage reaper naming the container it is about to destroy. Each of
        // those would otherwise wake a Durable Object to re-assert a setting it
        // already has.
        Effect.all([
          s.acquire({}),
          s.acquire({}),
          s.acquire({ key: "features" }),
          s.acquire({ key: "features" }),
        ]),
      ).pipe(
        Effect.provide(
          makeSandboxCloudflareLive(
            ns,
            makeBucket().bucket,
            "route-4",
            undefined,
            undefined,
            undefined,
            "rpc",
          ),
        ),
      );
      expect(transportCalls).toEqual(["rpc", "rpc"]);
    }),
  );

  it.effect("exec routes by the handle it is given, not by the execution", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({ exitCode: 0, duration: 1, stdout: "", stderr: "" }));

      yield* Effect.flatMap(SandboxTag, (s) =>
        Effect.gen(function* () {
          const own = yield* s.acquire({});
          const keyed = yield* s.acquire({ key: "features" });
          requestedSandboxIds.length = 0;
          yield* s.exec({ command: "one", container: own });
          yield* s.exec({ command: "two", container: keyed });
          yield* s.exec({ command: "three" });
          return { own, keyed };
        }),
      ).pipe(
        Effect.provide(routingLayer()),
        Effect.flatMap(({ own, keyed }) =>
          Effect.sync(() => {
            // The whole bug in one assertion: the second exec must reach the
            // keyed container, and an exec with no handle still reaches the
            // execution's own.
            expect(requestedSandboxIds).toEqual([own.id, keyed.id, own.id]);
          }),
        ),
      );
    }),
  );
});

describe("makeSandboxCloudflareLive — exec result folding (D)", () => {
  const execLayer = () => makeSandboxCloudflareLive(ns, makeBucket().bucket, "exec-1");

  it.effect("a non-zero exit is a result, not a failure", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 1,
        duration: 5,
        stdout: "boom",
        stderr: "e",
      }));
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "playwright test", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(1);
    }),
  );

  it.effect("SessionTerminatedError folds into a result with its exitCode", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new FakeSessionTerminatedError(7);
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "run-test; exit 7", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.exitCode).toBe(7);
    }),
  );

  it.effect("CommandError folds into a result, preserving stdout/stderr", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        const e = new Error("non-zero") as Error & {
          exitCode: number;
          stdout: string;
          stderr: string;
        };
        e.name = "CommandError";
        e.exitCode = 2;
        e.stdout = "out-tail";
        e.stderr = "err-tail";
        throw e;
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "false", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.exitCode).toBe(2);
        expect(exit.value.stdout).toBe("out-tail");
      }
    }),
  );

  it.effect("a genuine launch error still fails as ExecFailed", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new Error("container vanished");
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "anything", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{ _tag: string; stderrTail?: string; message?: string }>(exit);
      expect(err?._tag).toBe("ExecFailed");
      expect(err?.stderrTail).toBe("container vanished");
      expect(err?.message).toBe("exec failed (exit -1): container vanished");
    }),
  );

  it.effect("ExecFailed.stderrTail prefers stdout/stderr attached to the thrown error", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        const e = new Error("rpc reset") as Error & {
          stdout: string;
          stderr: string;
        };
        e.stdout = "partial out";
        e.stderr = "partial err";
        throw e;
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "deploy", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{ _tag: string; stderrTail?: string }>(exit);
      expect(err?._tag).toBe("ExecFailed");
      expect(err?.stderrTail).toBe("partial err\npartial out");
    }),
  );

  it.effect("timeout throws surface as ExecTimeout with a self-diagnosing message", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new Error("command timed out after 900000ms");
      });
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: "pnpm build && wrangler deploy",
          cwd: "/w",
          env: {},
          timeoutSec: 900,
        }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{
        _tag: string;
        timeoutSec?: number;
        command?: string;
        message?: string;
      }>(exit);
      expect(err?._tag).toBe("ExecTimeout");
      expect(err?.timeoutSec).toBe(900);
      expect(err?.command).toBe("pnpm build && wrangler deploy");
      expect(err?.message).toBe("exec timed out after 900s: pnpm build && wrangler deploy");
    }),
  );

  it.effect(
    "a missing working dir (checkout reaped between steps) fails as ExecFailed, not a phantom non-zero result",
    () =>
      Effect.gen(function* () {
        currentBox = makeFakeBox({ proc: null });
        // The shell could not `cd` into the (gone) checkout dir: non-zero exit,
        // no stdout, the directory-change error on stderr. Folding this into a
        // result would let `oxlint` / `offload-test` render a never-ran command
        // as a red lint/test verdict — so it must surface as ExecFailed.
        currentBox.exec = vi.fn(async () => ({
          exitCode: 1,
          duration: 0,
          stdout: "",
          stderr: "Failed to change directory to '/workspace/repo'",
        }));
        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.exec({
            command: "npx --yes oxlint@1",
            cwd: "/workspace/repo",
            env: {},
          }),
        ).pipe(Effect.provide(execLayer()), Effect.exit);
        const err = failureOf<{ _tag: string }>(exit);
        expect(err?._tag).toBe("ExecFailed");
      }),
  );

  it.effect("a checkout path containing 'timeout' still fails as ExecFailed, not ExecTimeout", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 1,
        duration: 0,
        stdout: "",
        stderr: "Failed to change directory to '/workspace/request-timeout'",
      }));
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "cargo test", cwd: "/workspace/request-timeout", env: {} }),
      ).pipe(Effect.provide(execLayer()), Effect.exit);
      const err = failureOf<{ _tag: string; stderrTail?: string }>(exit);
      expect(err?._tag).toBe("ExecFailed");
      expect(err?.stderrTail).toContain("was missing at exec time");
    }),
  );

  it("isWorkingDirFailure — fires only on a cwd-set, non-zero, no-stdout, cd-error result", () => {
    const cd = (over: Record<string, unknown> = {}) => ({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to change directory to '/w'",
      ...over,
    });
    expect(isWorkingDirFailure(cd(), "/w")).toBe(true);
    // a real failing command (has stdout) is NEVER misread as an infra failure
    expect(isWorkingDirFailure(cd({ stdout: "boom" }), "/w")).toBe(false);
    // a clean exit is never an infra failure
    expect(isWorkingDirFailure(cd({ exitCode: 0 }), "/w")).toBe(false);
    // no cwd requested → not applicable
    expect(isWorkingDirFailure(cd(), undefined)).toBe(false);
    // unrelated stderr (a genuine lint finding) is left alone
    expect(isWorkingDirFailure({ exitCode: 1, stdout: "", stderr: "1 error" }, "/w")).toBe(false);
  });

  it.effect("inlines only a bounded stdout tail; full log streams to R2", () =>
    Effect.gen(function* () {
      const big = "x".repeat(200_000);
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 0,
        duration: 1,
        stdout: big,
        stderr: "",
      }));
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "noisy", cwd: "/w", env: {} }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        // Inline preview is bounded (would otherwise bloat the checkpoint).
        expect(exit.value.stdout.length).toBeLessThan(20_000);
        expect(exit.value.stdout).toContain("truncated");
      }
      // The FULL output is still written to R2 (the durable log).
      const logBody = puts.map((p) => String(p.body)).join("");
      expect(logBody.length).toBeGreaterThan(190_000);
    }),
  );

  it.effect("short exec retains the baseline ordering of overlapping redaction values", () =>
    Effect.gen(function* () {
      for (const [values, expected] of [
        [["abc", "abcdef"], "***def"],
        [["abcdef", "abc"], "***"],
      ] as const) {
        currentBox = makeFakeBox({ proc: null });
        currentBox.exec = vi.fn(async () => ({
          exitCode: 0,
          duration: 1,
          stdout: "abcdef",
          stderr: "abcdef",
        }));
        const { bucket, puts } = makeBucket();
        const layer = makeSandboxCloudflareLive(ns, bucket, "short-overlap");
        const result = yield* Effect.flatMap(SandboxTag, (s) =>
          s.exec({ command: "echo abcdef", cwd: "/w", env: {}, redactValues: values }),
        ).pipe(Effect.provide(layer));
        expect(result.stdout).toBe(expected);
        expect(result.stderr).toBe(expected);
        expect(puts.map((p) => String(p.body)).join("")).toContain(expected);
      }
    }),
  );

  it.effect("redactValues scrubs secret values from both the R2 log and the inline tail", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 0,
        duration: 1,
        stdout: "using token super-secret for install",
        stderr: "auth failed: super-secret",
      }));
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: "pnpm install",
          cwd: "/w",
          env: {},
          redactValues: ["super-secret"],
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.stdout).not.toContain("super-secret");
        expect(exit.value.stderr).not.toContain("super-secret");
        expect(exit.value.stdout).toContain("***");
      }
      const logBody = puts.map((p) => String(p.body)).join("");
      expect(logBody).not.toContain("super-secret");
    }),
  );

  it.effect("the COMMAND is scrubbed before it lands in the R2 meta line", () =>
    Effect.gen(function* () {
      // `writeLog` writes `{stream:"meta", command}` into the durable log. A
      // command that inlines a credential reached R2 in the clear, beside the
      // streams that had just been scrubbed.
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => ({
        exitCode: 0,
        duration: 1,
        stdout: "",
        stderr: "",
      }));
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: 'curl -H "Authorization: Bearer tok-abc123" https://api.example.com',
          cwd: "/w",
          env: {},
          redactValues: ["tok-abc123"],
        }),
      ).pipe(Effect.provide(layer));
      const logBody = puts.map((p) => String(p.body)).join("");
      expect(logBody).not.toContain("tok-abc123");
      expect(logBody).toContain("***");
    }),
  );

  it.effect("a timed-out exec does not carry its raw command into the Workflow record", () =>
    Effect.gen(function* () {
      // `ExecTimeout.message` inlines the command, and Workflows persists that
      // as the attempt record — a second durable surface beside the R2 log.
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw new Error("Command timeout after 30000ms");
      });
      const { bucket } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: 'curl -H "Authorization: Bearer tok-abc123" https://api.example.com',
          cwd: "/w",
          env: {},
          timeoutSec: 30,
          redactValues: ["tok-abc123"],
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      const failure = failureOf(exit);
      expect(failure?._tag).toBe("ExecTimeout");
      expect(JSON.stringify(failure)).not.toContain("tok-abc123");
    }),
  );

  it.effect("redacts before truncating, so a secret on the 4KB cut leaves no fragment", () =>
    Effect.gen(function* () {
      const secret = "SECRET_TOKEN_VALUE";
      const discardedPrefix = "x".repeat(100);
      const trailThatPutsTheCutMidSecret = "y".repeat(
        STDERR_TAIL_MAX - Math.floor(secret.length / 2),
      );
      currentBox = makeFakeBox({ proc: null });
      currentBox.exec = vi.fn(async () => {
        throw Object.assign(new Error("boom"), {
          stderr: `${discardedPrefix}${secret}${trailThatPutsTheCutMidSecret}`,
        });
      });
      const { bucket } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({ command: "wrangler deploy", cwd: "/w", env: {}, redactValues: [secret] }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).not.toContain(secret);
      const FRAGMENT = 8;
      for (let i = 0; i + FRAGMENT <= secret.length; i++) {
        expect(rendered).not.toContain(secret.slice(i, i + FRAGMENT));
      }
    }),
  );

  it.effect("redactValues scrubs a thrown error's diagnostic too", () =>
    Effect.gen(function* () {
      currentBox = makeFakeBox({ proc: null });
      const thrown = Object.assign(new Error("launch failed"), {
        stderr: "fatal: token super-secret rejected",
      });
      currentBox.exec = vi.fn(async () => {
        throw thrown;
      });
      const { bucket } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exec({
          command: "wrangler deploy",
          cwd: "/w",
          env: {},
          redactValues: ["super-secret"],
        }),
      ).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).not.toContain("super-secret");
      expect(rendered).toContain("***");
    }),
  );
});

// (E) gitClone credential handling. A cron tick carries no GitHub payload and
// therefore no `installation_id`, so the clone used to go out unauthenticated
// and 404 on every private repo — reported as a bare `Failed to clone
// repository`. The Layer now authenticates whenever App credentials exist and
// resolves the installation for the repo it is cloning; the token reaches git
// only through clone and optional missing-head fetch execs' environment, and is
// never persisted into a failure record (ADR-0006).
describe("makeSandboxCloudflareLive — gitClone credentials (E)", () => {
  /** App credentials with no installation id — the Schedule-mode shape. */
  const SCHEDULED_AUTH = { appId: "42", privateKeyPem: "-----BEGIN PRIVATE KEY-----" };
  const TOKEN = "ghs_clone_token";
  const CLONE_URL = "https://github.com/acme/beacon.git";
  /** The shape this layer must NOT use — a URL carrying its own credential. */
  const AUTHED_URL = `https://x-access-token:${TOKEN}@github.com/acme/beacon.git`;

  /**
   * Every command string the Layer ran, in order. The fake `exec` declares no
   * parameters (tests that need them replace it wholesale), so its recorded
   * calls are read back as a bare argument list.
   */
  const execCommands = (): string[] =>
    (currentBox.exec.mock.calls as unknown as unknown[][]).map((call) => String(call[0]));

  /** The options object the Layer passed alongside the `git clone`. */
  const cloneOpts = (): { env?: Record<string, string>; timeout?: number } | undefined =>
    (currentBox.exec.mock.calls as unknown as unknown[][]).find((call) =>
      String(call[0]).startsWith("git "),
    )?.[1] as { env?: Record<string, string>; timeout?: number } | undefined;

  /** The `git clone` the Layer issued, or `undefined` if it never cloned. */
  const cloneExec = (): string | undefined =>
    execCommands().find((c) => c.includes("clone --quiet"));

  /** An `exec` fake that fails only the commands matching `pattern`. */
  const execFailing = (pattern: RegExp, stderr: string) =>
    vi.fn(async (command: string) =>
      pattern.test(command)
        ? { exitCode: 1, duration: 0, stdout: "", stderr }
        : { exitCode: 0, duration: 0, stdout: "", stderr: "" },
    );

  const cloneLayer = (auth?: typeof SCHEDULED_AUTH) =>
    makeSandboxCloudflareLive(ns, makeBucket().bucket, "exec-1", auth);

  const clone = (auth?: typeof SCHEDULED_AUTH) =>
    Effect.flatMap(SandboxTag, (s) => s.gitClone({ repo: "acme/beacon", sha: "deadbee" })).pipe(
      Effect.provide(cloneLayer(auth)),
      Effect.exit,
    );

  beforeEach(() => {
    currentBox = makeFakeBox({ proc: null });
    resolveCloneToken.mockReset();
    resolveCloneToken.mockResolvedValue(TOKEN);
  });

  it.effect("a run with no installation id still clones a private repo", () =>
    Effect.gen(function* () {
      const exit = yield* clone(SCHEDULED_AUTH);

      expect(Exit.isSuccess(exit)).toBe(true);
      // The installation is resolved for the repo being CLONED — not for the
      // dispatch payload's repo, which a scheduled run does not have.
      expect(resolveCloneToken).toHaveBeenCalledWith(SCHEDULED_AUTH, "acme/beacon");
      expect(cloneExec()).toContain(`clone --quiet '${CLONE_URL}' '/workspace/beacon'`);
    }),
  );

  // The token reaches git through the environment, read back by a credential
  // helper — never through the URL. A URL carrying its own credential would put
  // it in the command string (redacted today only by an internal of the pinned
  // `@cloudflare/sandbox`, which ADR-0011 says is not a guarantee to lean on),
  // in git's stderr, and in `.git/config`. This closes all three at the source.
  it.effect("passes the token in the environment, never in the command or the URL", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      const cmd = cloneExec() as string;
      expect(cmd).not.toContain(TOKEN);
      expect(cmd).not.toContain(AUTHED_URL);
      expect(cmd).not.toContain("x-access-token:");
      // The command names the variable; the value rides in `env`.
      expect(cmd).toContain("$FLARE_DISPATCH_CLONE_TOKEN");
      expect(cloneOpts()?.env).toEqual({ FLARE_DISPATCH_CLONE_TOKEN: TOKEN });
      // No other exec is handed the token.
      const withToken = (currentBox.exec.mock.calls as unknown as unknown[][]).filter((call) =>
        JSON.stringify(call[1] ?? {}).includes(TOKEN),
      );
      expect(withToken.length).toBe(1);
    }),
  );

  // A helper the container's own git configuration prepended would answer first.
  it.effect("resets any inherited credential helper before installing its own", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      expect(cloneExec()).toContain("-c credential.helper= -c ");
    }),
  );

  // The clone provides complete history; the optional immutable-head fetch
  // only covers an object absent from ordinary branch refs. A `--filter`/`--depth` clone
  // leaves objects to fetch later, and there is nothing left to fetch them with:
  // `pr-review`'s three-dot diff reads merge-base blobs that are in neither the
  // default-branch tree the clone lands on nor the head `git checkout` moves to,
  // so git reached for the promisor remote and died on `could not read Username`.
  it.effect("clones completely — no object filter, no depth, no single-branch", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      const cmd = cloneExec() as string;
      expect(cmd).not.toMatch(/--filter/);
      expect(cmd).not.toMatch(/--depth/);
      expect(cmd).not.toMatch(/--single-branch/);
      expect(cmd).not.toMatch(/--bare|--mirror|--sparse/);
    }),
  );

  it.effect("fails the checkout when the clone itself exits non-zero", () =>
    Effect.gen(function* () {
      currentBox.exec = execFailing(/clone --quiet/, "fatal: repository not found");

      const exit = yield* clone(SCHEDULED_AUTH);

      const cause = failureOf<{ _tag: string; cause: unknown }>(exit)?.cause as Error;
      expect(cause.message).toContain("git clone exited 1");
      expect(cause.message).toContain("repository not found");
    }),
  );

  it.effect(
    "fetches an immutable PR head missing from the default clone before scrubbing auth",
    () =>
      Effect.gen(function* () {
        const prHead = "f".repeat(40);
        let fetched = false;
        currentBox.exec = vi.fn(async (command: string) => {
          if (command.startsWith("git checkout") && !fetched) {
            return {
              exitCode: 128,
              duration: 0,
              stdout: "",
              stderr: "fatal: reference is not a tree",
            };
          }
          if (command.includes("fetch") && command.includes(prHead)) fetched = true;
          return { exitCode: 0, duration: 0, stdout: "", stderr: "" };
        });

        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.gitClone({ repo: "acme/beacon", sha: prHead }),
        ).pipe(Effect.provide(cloneLayer(SCHEDULED_AUTH)), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        const commands = execCommands();
        const fetchIndex = commands.findIndex(
          (command) => command.includes("fetch") && command.includes(prHead),
        );
        expect(fetchIndex).toBeGreaterThan(
          commands.findIndex((command) => command.startsWith("git checkout")),
        );
        expect(fetchIndex).toBeLessThan(
          commands.findIndex((command) => command.includes("remote set-url")),
        );
        expect((currentBox.exec.mock.calls as unknown as unknown[][])[fetchIndex]?.[1]).toEqual(
          expect.objectContaining({ env: { FLARE_DISPATCH_CLONE_TOKEN: TOKEN } }),
        );
      }),
  );

  it.effect("scrubs credentials and fails when the missing head cannot be fetched", () =>
    Effect.gen(function* () {
      const prHead = "f".repeat(40);
      currentBox.exec = vi.fn(async (command: string) => {
        if (command.startsWith("git checkout") || command.includes("fetch --no-tags")) {
          return { exitCode: 128, duration: 0, stdout: "", stderr: "fatal: object unavailable" };
        }
        return { exitCode: 0, duration: 0, stdout: "", stderr: "" };
      });

      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.gitClone({ repo: "acme/beacon", sha: prHead }),
      ).pipe(Effect.provide(cloneLayer(SCHEDULED_AUTH)), Effect.exit);

      const failure = failureOf<{ _tag: string; cause: unknown }>(exit);
      expect(failure?._tag).toBe("CheckoutFailed");
      expect(failure?.cause).toBeInstanceOf(Error);
      if (failure?.cause instanceof Error) {
        expect(failure.cause.message).toContain(`git fetch ${prHead} exited 128`);
      }
      expect(execCommands().some((command) => command.includes("remote set-url"))).toBe(true);
    }),
  );

  it.effect("scrubs the token out of the remote before the workload runs", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      // The credential helper means `.git/config` never receives a token; the
      // scrub stays as the backstop that PROVES the remote is credential-free.
      const scrub = execCommands().find((c) => c.includes("remote set-url"));
      expect(scrub).toContain("git -C '/workspace/beacon' remote set-url origin");
      expect(scrub).toContain("'https://github.com/acme/beacon.git'");
      expect(scrub).not.toContain(TOKEN);
      // …and it runs after the checkout, not before it.
      expect(execCommands().indexOf(scrub as string)).toBeGreaterThan(
        execCommands().findIndex((c) => c.startsWith("git checkout")),
      );
    }),
  );

  it.effect("fails, naming the repo, when no installation covers it", () =>
    Effect.gen(function* () {
      resolveCloneToken.mockRejectedValue(
        new Error("no GitHub App installation for acme/beacon — install the GitHub App"),
      );

      const exit = yield* clone(SCHEDULED_AUTH);

      const err = failureOf<{ _tag: string; cause: unknown }>(exit);
      expect(err?._tag).toBe("CheckoutFailed");
      const cause = err?.cause as Error;
      expect(cause.message).toContain("no GitHub App installation for acme/beacon");
      // The whole point: no silent degrade to an unauthenticated clone that
      // 404s and reports it as a git problem.
      expect(cloneExec()).toBeUndefined();
    }),
  );

  it.effect("keeps the token out of a clone failure, which Workflows persists", () =>
    Effect.gen(function* () {
      // git puts the URL it failed on straight into its error text.
      currentBox.exec = vi.fn(async (command: string) => {
        if (command.includes("clone --quiet")) {
          const e = new Error(`GitError: failed to clone ${AUTHED_URL}`);
          e.name = "GitError";
          throw e;
        }
        return { exitCode: 0, duration: 0, stdout: "", stderr: "" };
      });

      const exit = yield* clone(SCHEDULED_AUTH);

      const err = failureOf<{ _tag: string; cause: unknown }>(exit);
      expect(err?._tag).toBe("CheckoutFailed");
      const cause = err?.cause as Error;
      expect(cause.message).not.toContain(TOKEN);
      expect(cause.message).toContain("***");
      // The diagnosis survives the redaction.
      expect(cause.name).toBe("GitError");
      // A failed clone can still leave a `.git` holding the authed remote.
      expect(execCommands().some((c) => c.includes("remote set-url"))).toBe(true);
    }),
  );

  it.effect(
    "a scrub that cannot run fails the checkout rather than handing over a live token",
    () =>
      Effect.gen(function* () {
        currentBox.exec = vi.fn(async (command: string) =>
          command.includes("remote set-url")
            ? { exitCode: 1, duration: 0, stdout: "", stderr: "git: not found" }
            : { exitCode: 0, duration: 0, stdout: "", stderr: "" },
        );

        const exit = yield* clone(SCHEDULED_AUTH);

        const err = failureOf<{ _tag: string; cause: unknown }>(exit);
        expect(err?._tag).toBe("CheckoutFailed");
        const cause = err?.cause as Error;
        expect(cause.message).toContain("clone-credential scrub");
      }),
  );

  // The rewrite must be its OWN command, with no `|| true`, or its exit code is
  // not the compound's and the guard above is dead: `a || true; b || true` exits
  // 0 whatever `a` did. This asserts the command SHAPE, which is what the fake
  // `exec` cannot otherwise tell us — the guard test above stubs a non-zero exit
  // that a `|| true`-chained string could never actually produce.
  it.effect("issues the credential rewrite as its own ungated command", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      const setUrl = execCommands().find((c) => c.includes("remote set-url")) as string;
      expect(setUrl).not.toContain("|| true");
      expect(setUrl).not.toContain(";");
      // The tolerant clauses are a separate exec — absence of the section is the
      // desired end state, so those legitimately keep `|| true`.
      const tolerant = execCommands().find((c) => c.includes("--remove-section credential"));
      expect(tolerant).toContain("|| true");
      expect(tolerant).not.toContain("remote set-url");
    }),
  );

  // "The command exited 0" is a weaker claim than "the remote no longer carries
  // a credential" — a git that silently no-ops still exits 0. Exit 4 is the
  // in-shell verdict for "userinfo survived".
  it.effect("fails when the remote still carries a credential after the rewrite", () =>
    Effect.gen(function* () {
      currentBox.exec = vi.fn(async (command: string) =>
        command.includes("remote.origin.url")
          ? { exitCode: 4, duration: 0, stdout: "", stderr: "" }
          : { exitCode: 0, duration: 0, stdout: "", stderr: "" },
      );

      const exit = yield* clone(SCHEDULED_AUTH);

      const err = failureOf<{ _tag: string; cause: unknown }>(exit);
      expect(err?._tag).toBe("CheckoutFailed");
      const cause = err?.cause as Error;
      expect(cause.message).toContain("still carries an embedded credential");
      expect(cause.message).not.toContain(TOKEN);
    }),
  );

  // The verification must not PRINT the URL to prove it is clean: in exactly the
  // case the guard exists to catch, that URL is the token — emitted into an
  // `exec` result the SDK may retain.
  it.effect("verifies the remote without ever emitting it", () =>
    Effect.gen(function* () {
      yield* clone(SCHEDULED_AUTH);

      const verify = execCommands().find((c) => c.includes("remote.origin.url")) as string;
      // Captured by a shell assignment and matched in-shell; only an exit code
      // crosses back.
      expect(verify).toContain("url=$(");
      expect(verify).toContain("case");
      expect(verify).toContain("exit 4");
      // Never a bare read that puts the URL on stdout.
      expect(verify).not.toMatch(/^git -C .* --get remote\.origin\.url$/);
    }),
  );

  // A URL an App token cannot authenticate must never be blocked on — or fail
  // on — an installation lookup about it.
  it.effect("skips the installation lookup entirely for a non-github.com URL", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.gitClone({ repo: "https://gitlab.example.com/group/repo.git", sha: "deadbee" }),
      ).pipe(Effect.provide(cloneLayer(SCHEDULED_AUTH)), Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(resolveCloneToken).not.toHaveBeenCalled();
      expect(execCommands().some((c) => c.includes("remote set-url"))).toBe(false);
    }),
  );

  // `repoUrl` passes a URL-shaped `repo` straight through, and every run input
  // but `runs/check.ts` declares `repo` as an unconstrained `Schema.String`.
  // `GET /repos/{owner}/{repo}/installation` takes the SLUG — looking up the
  // raw URL 404s and fails a clone of a repo that HAS an installation.
  it.effect("looks up the slug, not the raw input, for a full github.com URL", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.flatMap(SandboxTag, (s) =>
        s.gitClone({ repo: "https://github.com/acme/beacon.git", sha: "deadbee" }),
      ).pipe(Effect.provide(cloneLayer(SCHEDULED_AUTH)), Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(resolveCloneToken).toHaveBeenCalledWith(SCHEDULED_AUTH, "acme/beacon");
    }),
  );

  // A scrub failure on the failure path must not REPLACE the git diagnosis —
  // but it must not vanish either: the container is reused, so a surviving
  // token is readable by whatever runs next.
  it.effect("keeps the git diagnosis when the post-failure scrub also fails", () =>
    Effect.gen(function* () {
      currentBox.exec = vi.fn(async (command: string) => {
        if (command.includes("clone --quiet")) {
          const e = new Error(`GitError: failed to clone ${AUTHED_URL}`);
          e.name = "GitError";
          throw e;
        }
        return command.includes("remote set-url")
          ? { exitCode: 1, duration: 0, stdout: "", stderr: "git: not found" }
          : { exitCode: 0, duration: 0, stdout: "", stderr: "" };
      });

      const exit = yield* clone(SCHEDULED_AUTH);

      const cause = failureOf<{ cause: unknown }>(exit)?.cause as Error;
      // The real diagnosis survives, redacted…
      expect(cause.message).toContain("failed to clone");
      expect(cause.message).not.toContain(TOKEN);
      // …and the scrub failure is surfaced rather than swallowed.
      expect(cause.message).toContain("credential scrub ALSO failed");
    }),
  );

  // `redactCloneFailure` deliberately drops the original error instead of
  // attaching it — the original still holds the raw, unredacted token.
  it.effect("does not attach the unredacted original as the error's cause", () =>
    Effect.gen(function* () {
      currentBox.exec = vi.fn(async (command: string) => {
        if (command.includes("clone --quiet")) {
          throw new Error(`GitError: failed to clone ${AUTHED_URL}`);
        }
        return { exitCode: 0, duration: 0, stdout: "", stderr: "" };
      });

      const exit = yield* clone(SCHEDULED_AUTH);

      const cause = failureOf<{ cause: unknown }>(exit)?.cause as Error;
      expect(cause.cause).toBeUndefined();
    }),
  );

  // `repo` is an unconstrained `Schema.String` in every run but `runs/check.ts`,
  // and the scrub interpolates values derived from it into a shell command.
  it.effect("shell-quotes the values it interpolates into the scrub", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(SandboxTag, (s) =>
        s.gitClone({ repo: "acme/ha'kiri", sha: "deadbee" }),
      ).pipe(Effect.provide(cloneLayer(SCHEDULED_AUTH)), Effect.exit);

      const setUrl = execCommands().find((c) => c.includes("remote set-url")) as string;
      // The quote is escaped, so it cannot end the quoted word and let the rest
      // of the value be parsed as shell.
      expect(setUrl).toContain(`'/workspace/ha'\\''kiri'`);
    }),
  );

  it.effect("an unconfigured deploy still clones public repos unauthenticated", () =>
    Effect.gen(function* () {
      // No App secrets (local dev): there is no credential to resolve, so the
      // public-repo path is exactly what it was — and nothing to scrub.
      const exit = yield* clone(undefined);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(resolveCloneToken).not.toHaveBeenCalled();
      // No credential helper, and no environment carrying one.
      expect(cloneExec()).toBe(`git clone --quiet '${CLONE_URL}' '/workspace/beacon'`);
      expect(cloneOpts()?.env).toBeUndefined();
      expect(execCommands().some((c) => c.includes("remote set-url"))).toBe(false);
    }),
  );
});
