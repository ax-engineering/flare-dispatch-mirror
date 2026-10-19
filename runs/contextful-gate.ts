import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  checks,
  config,
  defineRun,
  handoffChildAdmission,
  io,
  isTerminalChildStatus,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  fanOut,
  prebuildCargoBinary,
  prebuiltCommand,
  waitForAnyChildDurably,
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
/** Moves the head checkout's work tree to `sha`; the clone holds every branch's history. */
const checkoutCommand = (sha: string): string =>
  `git -c advice.detachedHead=false checkout --quiet --force --detach ${sha}`;
/**
 * Each part's exec deadline. One cold build of the binary under one feature set
 * takes 550–760 s, and its ordinary suite another ~1100 s, so a single part needs
 * up to ~1750 s; 2700 s keeps that at about 65% of the deadline.
 */
const STAGE_TIMEOUT_SEC = 2700;
/** Admission queue age a part may wait before it starts. */
const STAGE_QUEUE_SEC = 90 * 60;
/** A spawned part's whole budget: its queue age plus the check run's ceiling. */
const STAGE_BUDGET_MS = (STAGE_QUEUE_SEC + check.limits.maxDurationSec) * 1000;
/** Status-poll cadence while the window is full. */
const STAGE_POLL_EVERY = "1 minute";

/**
 * Parts in flight at once, unless `contextful-gate.window:<repo>` in the config
 * store names another value.
 *
 * Fairness. Admission is a FIFO counting semaphore per sandbox pool
 * (`ADMISSION_CAP`, default 16). A part enqueues at its own spawn time: the
 * gate hands its admission row off right after its first spawn, and a child
 * whose parent holds no row keeps its own clock (run-admission-d1.ts). So a run
 * that arrives while a gate is live queues behind only the parts already
 * spawned, never behind the parts the gate spawns later, and each gate
 * contributes at most `window` rows — queued or admitted — to that line.
 * {@link WINDOW_MAX} keeps one gate four below the default cap; concurrent
 * gates on different pull requests each add their own `window`, and rows past
 * the cap queue in arrival order like any other run. A deploy whose
 * `ADMISSION_CAP` is lower sets the window below it.
 */
export const WINDOW_DEFAULT = 10;
export const WINDOW_MAX = 12;
const windowKey = (repo: string): string => `contextful-gate.window:${repo}`;

/** The configured window, clamped to `[1, WINDOW_MAX]`; absent or garbage → the default. */
export const parseWindow = (raw: string | undefined): number => {
  const n = Number(raw?.trim());
  return raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 1
    ? WINDOW_DEFAULT
    : Math.min(n, WINDOW_MAX);
};

/**
 * The check-run name a part's `check` child posts (`flare-dispatch/check:<label>`,
 * apps/dispatcher/src/check-name.ts); a part not dispatched is posted under it.
 */
export const partCheckName = (stage: string): string => `flare-dispatch/check:${stage}`;
export const NOT_AFFECTED_SUMMARY = "not affected by this change";

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  baseSha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  /** The pull request; a newer gate run of the same one supersedes this run. */
  pr: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /**
   * The pull request's `updated_at` in ms: the revision order within its
   * supersession group, so a later push outranks an earlier one whichever
   * gate registers first.
   */
  revisedAt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
});

type InputType = Schema.Schema.Type<typeof Input>;

const Output = Schema.Struct({
  stages: Schema.Number,
  failed: Schema.Array(Schema.String),
  notAffected: Schema.Array(Schema.String),
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

/**
 * The `--affected` subset of the head's required parts. Empty output is a valid
 * answer — nothing the diff reaches. A part outside `required`, a duplicate or a
 * malformed line is `undefined`, and the gate then dispatches every part.
 */
export const parseAffected = (
  stdout: string,
  required: readonly string[],
): readonly string[] | undefined => {
  if (new TextEncoder().encode(stdout).length > MAX_STAGE_LIST_BYTES) return undefined;
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((stage) => stage.trim())
    .filter((stage) => stage !== "");
  const known = new Set(required);
  if (lines.some((stage) => !known.has(stage)) || new Set(lines).size !== lines.length)
    return undefined;
  return lines;
};

/**
 * The required set: the head's parts plus every base-only part, so a change
 * cannot drop a required check by deleting it. A complete base-aware head
 * discovery refines the base's whole `test-first` check into its parts.
 */
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

export type StagePlan = {
  /** Every required part, in run order. */
  readonly required: readonly string[];
  /** The parts that run: the head's affected parts, then every base-only part. */
  readonly dispatch: readonly string[];
  /** Head parts the diff cannot reach — posted green without running. */
  readonly notAffected: readonly string[];
};

/**
 * Which required parts run. The head's `--affected` output is untrusted, so
 * every required part runs until a trusted selector is available.
 */
export const planStages = (
  head: readonly string[],
  base: readonly string[],
  discovery: { readonly headDiscoveredAgainstBase: boolean },
  _affected: readonly string[] | undefined,
): StagePlan => {
  const required = mergeStages(head, base, discovery);
  return { required, dispatch: required, notAffected: [] };
};

export const contextfulGate = defineRun({
  name: "contextful-gate",
  // 1.1.0 — `pr` input, `--affected` selection, sliding window, supersession.
  version: "1.1.0",
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
      inputs: ({ payload }): InputType => {
        const pr = Number(payload.pull_request?.number);
        const revisedAt = Date.parse(String(payload.pull_request?.updated_at ?? ""));
        return {
          repo: REPO,
          sha: String(payload.pull_request?.head?.sha ?? ""),
          baseSha: String(payload.pull_request?.base?.sha ?? ""),
          ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}),
          ...(Number.isInteger(revisedAt) && revisedAt >= 0 ? { revisedAt } : {}),
        };
      },
    },
  ],
  // One gate run per pull request is live: a newer revision cancels the older
  // run, its children and their checks (apps/dispatcher/src/supersede.ts).
  supersede: (input) =>
    input.pr === undefined
      ? undefined
      : {
          group: `contextful-gate:${input.repo}#${input.pr}`,
          ...(input.revisedAt !== undefined ? { order: input.revisedAt } : {}),
        },
  limits: { maxDurationSec: 30 * 3600, admissionMaxQueueAgeSec: 90 * 60 },
  run: (input) =>
    Effect.gen(function* () {
      // Discovery runs in the execution's one container, the one its admission
      // slot pays for: head first, then the base in the same checkout, so the
      // base build reuses the head's `target/` and compiles only what differs.
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
      // PR-head code can choose its own `--affected` answer, including an empty
      // one. Only a trusted selector may authorize synthetic success checks.
      const baseDiscovery = yield* step(
        "discover-base-stages",
        () =>
          ensureWorkspace({ current: { container, dir }, repo: input.repo, sha: input.sha }).pipe(
            Effect.flatMap((ws) =>
              Effect.gen(function* () {
                const moved = yield* sandbox.exec({
                  container: ws.container,
                  cwd: ws.dir,
                  command: checkoutCommand(input.baseSha),
                  timeoutSec: 120,
                });
                // A base the head clone lacks gets a checkout of its own, in the
                // same container.
                const baseWs =
                  moved.exitCode === 0 ? ws : yield* workspace({ repo: input.repo, sha: input.baseSha });
                const result = yield* sandbox.exec({
                  container: baseWs.container,
                  cwd: baseWs.dir,
                  command: DISCOVER,
                  timeoutSec: 1800,
                });
                return { ...result, container: baseWs.container };
              }),
            ),
          ),
        { timeoutSec: 2100, retries: 3, retryOn: ["ExecFailed", "StepFailed", "CheckoutFailed"] },
      );
      // The gate's container goes before its admission slot does: the parts
      // run in containers of their own.
      yield* step("release-discovery-container", () =>
        sandbox.destroy({ container: baseDiscovery.container }),
      );
      const head = {
        exitCode: discovery.exitCode,
        headStages,
        headDiscoveredAgainstBase: discovery.headDiscoveredAgainstBase,
      };
      const base = {
        exitCode: baseDiscovery.exitCode,
        stages: baseDiscovery.exitCode === 0 ? parseStages(baseDiscovery.stdout) : undefined,
      };
      if (head.headStages === undefined || base.stages === undefined) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: head.exitCode || base.exitCode || 1,
            summaryMd:
              "The head or base gate stage list is empty, invalid, or could not be discovered.",
          }),
        );
      }
      const plan = planStages(head.headStages, base.stages, head, undefined);
      if (plan.required.length > MAX_STAGES) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: "The combined head and base gate stage lists exceed 64 parts.",
          }),
        );
      }

      // Branch protection requires every part's check: a part the diff cannot
      // reach is posted green under the same name instead of running. Creating
      // and concluding are separate checkpoints per part, so a retried
      // conclusion never opens a second check-run.
      yield* Effect.forEach(
        plan.notAffected,
        (stage) =>
          Effect.gen(function* () {
            const name = partCheckName(stage);
            const output = { title: name, summary: NOT_AFFECTED_SUMMARY };
            const checkRunId = yield* step(`open-not-affected-${stage}`, () =>
              checks.create({ repo: input.repo, sha: input.sha, name, output }),
            );
            yield* step(`conclude-not-affected-${stage}`, () =>
              checks.update({ repo: input.repo, checkRunId, conclusion: "success", output }),
            );
          }),
        { concurrency: 4, discard: true },
      );

      const window = yield* step("resolve-window", () =>
        config.get(windowKey(input.repo)).pipe(Effect.map(parseWindow)),
      );

      // Sliding window: the next part spawns as soon as any running part
      // settles. Every spawn and every observation is a checkpoint, so a replay
      // walks the same sequence of spawns and slot frees. The `-parts-` step
      // names share no checkpoint with the paired batches' `-stages-` steps, so
      // a gate in flight across a deploy re-spawns under new names; a child's
      // instance id derives from its input, so the re-spawn finds the same
      // children.
      const queue = [...plan.dispatch];
      const running: { readonly stage: string; readonly id: string; readonly expiresAt: number }[] = [];
      const failed = new Set<string>();
      let spawned = 0;
      for (let round = 0; queue.length > 0 || running.length > 0; round++) {
        const free = window - running.length;
        if (queue.length > 0 && free > 0) {
          const batch = queue.splice(0, free);
          const { handles, spawnedAt } = yield* step(`spawn-parts-${spawned}`, () =>
            Effect.gen(function* () {
              const handles = yield* fanOut({
                run: "check",
                items: batch,
                concurrency: batch.length,
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
              });
              return { handles, spawnedAt: yield* io.now };
            }),
          );
          if (spawned === 0) {
            yield* step("handoff-admission", () => handoffChildAdmission());
          }
          batch.forEach((stage, index) => {
            running.push({
              stage,
              id: handles[index]!.executionId,
              // A part still inside its queue age and its check run's ceiling
              // is never reported failed.
              expiresAt: spawnedAt + STAGE_BUDGET_MS,
            });
          });
          spawned += batch.length;
        }
        const records = yield* waitForAnyChildDurably({
          name: `await-parts-${round}`,
          ids: running.map((part) => part.id),
          expiresAt: Math.min(...running.map((part) => part.expiresAt)),
          pollEvery: STAGE_POLL_EVERY,
        });
        const settled = new Map(
          records
            .filter((record) => isTerminalChildStatus(record.status))
            .map((record) => [record.executionId, record.status]),
        );
        for (let index = running.length - 1; index >= 0; index--) {
          const part = running[index]!;
          const status = settled.get(part.id);
          if (status === undefined) continue;
          if (status !== "success") failed.add(part.stage);
          running.splice(index, 1);
        }
      }
      const failedInOrder = plan.dispatch.filter((stage) => failed.has(stage));
      if (failedInOrder.length > 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: `Gate stages failed: ${failedInOrder.join(", ")}`,
          }),
        );
      }
      return { stages: plan.required.length, failed: failedInOrder, notAffected: plan.notAffected };
    }),
});
