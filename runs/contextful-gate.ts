import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  defineRun,
  handoffChildAdmission,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  fanOut,
  prebuildCargoBinary,
  prebuiltCommand,
  waitForChildrenDurably,
  workspace,
  type PrebuiltBinary,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { check } from "./check";

const REPO = "fractalboxdev/contextful";
const CI_PACKAGE = "contextful-ci";
const CARGO_RUN_CI = `cargo run --locked -q -p ${CI_PACKAGE} --`;
const DISCOVER = `${CARGO_RUN_CI} stages --parts`;
const STAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_STAGES = 64;
const MAX_STAGE_LIST_BYTES = 4096;
const STAGE_CONCURRENCY = 2;
/**
 * Each part's exec deadline. One cold build of the binary under one feature set
 * takes 550–760 s, and its ordinary suite another ~1100 s, so a single part needs
 * up to ~1750 s; 2700 s keeps that at about 65% of the deadline.
 */
const STAGE_TIMEOUT_SEC = 2700;
/** Admission queue age a part may wait before it starts. */
const STAGE_QUEUE_SEC = 90 * 60;

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  baseSha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
});

type InputType = Schema.Schema.Type<typeof Input>;

const Output = Schema.Struct({
  stages: Schema.Number,
  failed: Schema.Array(Schema.String),
});

/** A malformed or empty discovery cannot quietly remove required checks. */
export const parseStages = (stdout: string): readonly string[] | undefined => {
  if (new TextEncoder().encode(stdout).length > MAX_STAGE_LIST_BYTES) return undefined;
  const stages = stdout
    .trim()
    .split(/\r?\n/)
    .map((stage) => stage.trim());
  if (
    stages.length === 0 ||
    stages.length > MAX_STAGES ||
    stages.some((stage) => !STAGE_PATTERN.test(stage)) ||
    new Set(stages).size !== stages.length
  )
    return undefined;
  return stages;
};

/**
 * One part's command: the binary the parent built when there is one, `cargo run`
 * otherwise — and on the child too, when the restored binary is absent or broken.
 */
export const stageCommand = (
  stage: string,
  baseSha: string,
  prebuilt: PrebuiltBinary | null,
): string => {
  const args = `gate --predecessors --stage ${stage} --base ${baseSha}`;
  return prebuilt === null
    ? `${CARGO_RUN_CI} ${args}`
    : prebuiltCommand({ path: prebuilt.path, fallback: CARGO_RUN_CI, args });
};

/** Base-only checks remain required; complete base-aware parts refine their legacy whole check. */
export const mergeStages = (
  head: readonly string[],
  base: readonly string[],
  discovery: { readonly headDiscoveredAgainstBase: boolean } = { headDiscoveredAgainstBase: false },
): readonly string[] => {
  const splitTestFirst =
    discovery.headDiscoveredAgainstBase &&
    head.includes("test-first.validate") &&
    !head.includes("test-first");
  return [...new Set([...head, ...base.filter((stage) => !(splitTestFirst && stage === "test-first"))])];
};

export const contextfulGate = defineRun({
  name: "contextful-gate",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      idempotencyKey: ({ payload }) =>
        `contextful-gate:${String(payload.pull_request?.number ?? "")}:${String(payload.pull_request?.head?.sha ?? "")}:${String(payload.pull_request?.base?.sha ?? "")}`,
      gate: ({ payload }) =>
        payload.repository?.full_name === REPO &&
        payload.pull_request?.head?.repo?.full_name === REPO,
      inputs: ({ payload }): InputType => ({
        repo: REPO,
        sha: String(payload.pull_request?.head?.sha ?? ""),
        baseSha: String(payload.pull_request?.base?.sha ?? ""),
      }),
    },
  ],
  limits: { maxDurationSec: 30 * 3600, admissionMaxQueueAgeSec: 90 * 60 },
  run: (input) =>
    Effect.gen(function* () {
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: input.repo, sha: input.sha, install: true }),
      );
      const discovery = yield* step(
        "discover-stages",
        () =>
          ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha }).pipe(
            Effect.flatMap((ws) =>
              sandbox
                .exec({
                  container: ws.container,
                  cwd: ws.dir,
                  command: `${DISCOVER} --base ${input.baseSha}`,
                  timeoutSec: 1800,
                })
                .pipe(
                  Effect.flatMap((result) =>
                    result.exitCode === 2 &&
                    result.stdout.trim() === "" &&
                    /unexpected argument '--base' found/.test(result.stderr) &&
                    /Usage:/.test(result.stderr)
                      ? sandbox.exec({
                          container: ws.container,
                          cwd: ws.dir,
                          command: DISCOVER,
                          timeoutSec: 1800,
                        }).pipe(Effect.map((fallback) => ({ ...fallback, headDiscoveredAgainstBase: false })))
                      : Effect.succeed({ ...result, headDiscoveredAgainstBase: result.exitCode === 0 }),
                  ),
                ),
            ),
          ),
        { timeoutSec: 1920, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      const headStages = discovery.exitCode === 0 ? parseStages(discovery.stdout) : undefined;
      // Discovery compiled the tool in this checkout; storing that one executable
      // spares every part its own cold compile. `null` keeps the parts on cargo run.
      const prebuilt =
        headStages === undefined
          ? null
          : yield* step(
              "prebuild-ci-binary",
              () =>
                ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha, install: true }).pipe(
                  Effect.flatMap((ws) => prebuildCargoBinary({ workspace: ws, pkg: CI_PACKAGE, bin: CI_PACKAGE })),
                ),
              { timeoutSec: 1920, retries: 1, retryOn: ["CheckoutFailed"] },
            ).pipe(Effect.orElseSucceed((): PrebuiltBinary | null => null));
      const baseWorkspace = yield* step("checkout-base", () =>
        workspace({ repo: input.repo, sha: input.baseSha }),
      );
      const baseDiscovery = yield* step(
        "discover-base-stages",
        () =>
          ensureWorkspace({ current: baseWorkspace, repo: input.repo, sha: input.baseSha }).pipe(
            Effect.flatMap((ws) =>
              sandbox
                .exec({
                  container: ws.container,
                  cwd: ws.dir,
                  command: DISCOVER,
                  timeoutSec: 1800,
                })
                .pipe(Effect.map((result) => ({ ...result, container: ws.container }))),
            ),
          ),
        { timeoutSec: 1920, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      const baseStages =
        baseDiscovery.exitCode === 0 ? parseStages(baseDiscovery.stdout) : undefined;
      yield* step("release-discovery-container", () =>
        sandbox.destroy({ container: baseDiscovery.container }),
      );
      if (headStages === undefined || baseStages === undefined) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: discovery.exitCode || baseDiscovery.exitCode || 1,
            summaryMd:
              "The head or base gate stage list is empty, invalid, or could not be discovered.",
          }),
        );
      }
      const stages = mergeStages(headStages, baseStages, discovery);
      if (stages.length > MAX_STAGES) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: "The combined head and base gate stage lists exceed 64 parts.",
          }),
        );
      }

      const failed: string[] = [];
      for (let offset = 0; offset < stages.length; offset += STAGE_CONCURRENCY) {
        const batch = stages.slice(offset, offset + STAGE_CONCURRENCY);
        const handles = yield* step(`spawn-stages-${offset}`, () =>
          fanOut({
            run: "check",
            items: batch,
            concurrency: STAGE_CONCURRENCY,
            toInput: (stage) => ({
              repo: input.repo,
              sha: input.sha,
              checkLabel: stage,
              command: stageCommand(stage, input.baseSha, prebuilt),
              failOnNonZeroExit: true,
              timeoutSec: STAGE_TIMEOUT_SEC,
              admissionMaxQueueAgeSec: STAGE_QUEUE_SEC,
              install: true,
              ...(prebuilt === null
                ? {}
                : { restore: [{ key: prebuilt.key, base: prebuilt.base, paths: prebuilt.paths }] }),
              secrets: [],
            }),
          }),
        );
        if (offset === 0) {
          yield* step("handoff-admission", () => handoffChildAdmission());
        }
        const results = yield* waitForChildrenDurably({
            name: `await-stages-${offset}`,
            ids: handles.map((handle) => handle.executionId),
            // A batch waits out its parts' queue age and the check run's whole ceiling,
            // so a part still inside its own budget is never reported failed.
            timeout: `${(STAGE_QUEUE_SEC + check.limits.maxDurationSec) / 60} minutes`,
          });
        results.forEach((result, index) => {
          if (result.status !== "success") failed.push(batch[index]!);
        });
      }
      if (failed.length > 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: `Gate stages failed: ${failed.join(", ")}`,
          }),
        );
      }
      return { stages: stages.length, failed };
    }),
});
