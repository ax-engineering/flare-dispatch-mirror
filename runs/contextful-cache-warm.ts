// `contextful-cache-warm` — fills the compile cache's `base` lane from each
// default-branch head, so a pull request's first gate reads compiled crates
// instead of compiling cold.
//
// One container per head: checkout, the gate's prebuilt `contextful-ci`, then
// the gate's compile part under sccache. The part runs through the same
// command, checkout path, install and cache wrapper as a gate part, because
// sccache keys an entry on the compile's arguments, working directory and
// `CARGO_*` environment: any difference turns every pull-request read into a
// miss. No child runs and no part check-runs.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Base-lane warm.

import { Effect, Schema } from "effect";
import { config, defineRun, github, io, RunSkipped, step } from "@fractalboxdev/flare-dispatch-core";
import {
  compileCacheCommand,
  compileCacheEnv,
  COMPILE_CACHE_ENDPOINT_KEY,
  COMPILE_CACHE_TOKEN_KEY,
  durableExec,
  ensureWorkspace,
  prebuildCargoBinary,
  restorePrebuilt,
  workspace,
  type PrebuiltBinary,
  type Workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { CI_PACKAGE, lightLabelsKey, parseLightLabels, STAGE_TIMEOUT_SEC, stageCommand } from "./contextful-gate";

const REPO = "fractalboxdev/contextful";
const BRANCH = "main";
const SHA40 = /^[a-f0-9]{40}$/i;
const ZERO_SHA = "0".repeat(40);

/**
 * The gate part this run compiles: `cargo test --workspace --no-run` in the
 * workspace stage's target directory, the build every `workspace.*` part
 * links against.
 */
export const WARM_PART = "workspace.compile";

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(SHA40)),
  /** The push's `before`: the `--base` a gate part passes. */
  baseSha: Schema.String.pipe(Schema.pattern(SHA40)),
  /** The pushed head commit's timestamp in ms: the rank within the supersession group. */
  revisedAt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
});

type InputType = Schema.Schema.Type<typeof Input>;

const Output = Schema.Struct({
  part: Schema.String,
  exitCode: Schema.Number,
});

export const contextfulCacheWarm = defineRun({
  name: "contextful-cache-warm",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  triggers: [
    {
      event: "push",
      // A redelivered push, or a second push of the same head, collapses onto
      // the execution that already warmed it.
      idempotencyKey: ({ payload }) => `contextful-cache-warm:${String(payload.after ?? "")}`,
      gate: ({ payload }) =>
        payload.repository?.full_name === REPO &&
        payload.repository?.default_branch === BRANCH &&
        payload.ref === `refs/heads/${BRANCH}` &&
        typeof payload.after === "string" && SHA40.test(payload.after) && payload.after !== ZERO_SHA &&
        typeof payload.before === "string" && SHA40.test(payload.before) && payload.before !== ZERO_SHA,
      inputs: ({ payload }): InputType => {
        const revisedAt = Date.parse(String(payload.head_commit?.timestamp ?? ""));
        return {
          repo: REPO,
          sha: String(payload.after),
          baseSha: String(payload.before),
          ...(Number.isInteger(revisedAt) && revisedAt >= 0 ? { revisedAt } : {}),
        };
      },
    },
  ],
  // Only default-branch heads write `base`; the body refuses any other sha
  // before the token reaches a container.
  compileCache: () => "base",
  // A newer head cancels the older warm, queued or running: its entries
  // already written stay, and the newer head's compile reads them.
  supersede: (input) => ({ group: `contextful-cache-warm:${input.repo}:${BRANCH}`, order: input.revisedAt ?? 0 }),
  limits: { maxDurationSec: 5400, admissionMaxQueueAgeSec: 90 * 60 },
  run: (input) =>
    Effect.gen(function* () {
      // A configured two-tier gate compiles its heavy parts on this push into
      // `base` already; warm only when the compile part is light.
      const lightLabels = yield* step("resolve-tiers", () =>
        config.get(lightLabelsKey(input.repo)).pipe(Effect.map((raw) => parseLightLabels(raw) ?? null)),
      );
      if (lightLabels !== null && !lightLabels.includes(WARM_PART)) {
        return yield* Effect.fail(
          new RunSkipped({ reason: `the two-tier gate's heavy tier compiles ${WARM_PART} into base on this push` }),
        );
      }
      const current = yield* step("read-head", () =>
        github.branchHead({ repo: input.repo, branch: BRANCH }).pipe(
          Effect.map((sha): string | null => sha),
          Effect.orElseSucceed((): string | null => null),
        ),
      );
      if (current === null) {
        return yield* Effect.fail(
          new RunSkipped({ reason: `the head of ${BRANCH} could not be read; only a default-branch head writes base` }),
        );
      }
      if (current.toLowerCase() !== input.sha.toLowerCase()) {
        return yield* Effect.fail(new RunSkipped({ reason: `${input.sha} is no longer the head of ${BRANCH}` }));
      }
      // Read INLINE, as `check` does: the token is a credential and stays out
      // of checkpointed state.
      const endpoint = yield* config.get(COMPILE_CACHE_ENDPOINT_KEY);
      const token = yield* config.get(COMPILE_CACHE_TOKEN_KEY);
      if (endpoint === undefined || endpoint === "" || token === undefined || token === "") {
        return yield* Effect.fail(new RunSkipped({ reason: "compile cache not injected on this deploy" }));
      }

      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );
      const prebuilt = yield* step(
        "prebuild-ci-binary",
        () =>
          ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha, install: true }).pipe(
            Effect.flatMap((ws) => prebuildCargoBinary({ workspace: ws, pkg: CI_PACKAGE, bin: CI_PACKAGE })),
          ),
        { timeoutSec: 1920, retries: 1, retryOn: ["CheckoutFailed"] },
      ).pipe(Effect.orElseSucceed((): PrebuiltBinary | null => null));
      // A re-cloned container lost the binary; restore it as a gate part does.
      const restore = (ws: Workspace) =>
        prebuilt === null
          ? Effect.succeed(ws)
          : restorePrebuilt({ container: ws.container, dir: ws.dir, entry: prebuilt }).pipe(Effect.as(ws));
      const { result } = yield* durableExec({
        name: "warm",
        workspace: { container, dir },
        ensure: (ws) =>
          ensureWorkspace({ current: ws, repo: input.repo, sha: input.sha, install: true }).pipe(
            Effect.flatMap((next) => (next === ws ? Effect.succeed(next) : restore(next))),
          ),
        exec: (ws) => ({
          cwd: ws.dir,
          command: compileCacheCommand(stageCommand(WARM_PART, input.baseSha, prebuilt), input.repo),
          env: compileCacheEnv({ endpoint, token }),
          redactValues: [token],
          timeoutSec: STAGE_TIMEOUT_SEC,
        }),
      });
      // The gate gives the verdict on this head; a failed compile still
      // leaves every entry it wrote.
      if (result.exitCode !== 0) {
        yield* io.log("warn", `contextful-cache-warm: ${WARM_PART} exited ${result.exitCode}; base holds what it compiled`);
      }
      return { part: WARM_PART, exitCode: result.exitCode };
    }),
});
