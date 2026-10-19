import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  checks,
  type CommitPullRequest,
  config,
  defineRun,
  DEPLOYED_VERSION_ENV,
  EXECUTION_CREATED_AT_ENV,
  github,
  handoffChildAdmission,
  io,
  isTerminalChildStatus,
  RunSkipped,
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

/** Why a gate stops spawning before every part has run. */
export type StopReason = "head superseded" | "pull request closed" | "admission backlog";

/** Whether the gated pull request is still open at the gated commit. */
export type Liveness = { readonly live: true } | { readonly live: false; readonly reason: StopReason };

const LIVE: Liveness = { live: true };

/**
 * Decide liveness from the gated pull request's state. An input naming `pr`
 * passes that PR (`pulls/{pr}`); an input naming none passes the PRs GitHub
 * associates with the gated commit (`commits/{sha}/pulls`) and gates every one
 * headed in the gated repository. A gated PR open at `sha` is live; one open at
 * another head is superseded; one closed or merged is closed. No gated PR in
 * the answer is unknown, and unknown is live: `commits/{sha}/pulls` answers []
 * alike for a commit force-pushed off its branch and for one no PR ever held,
 * which is why an input naming `pr` reads `pulls/{pr}` instead.
 */
export const prLiveness = (
  input: { readonly repo: string; readonly sha: string; readonly pr?: number | undefined },
  prs: readonly CommitPullRequest[],
): Liveness => {
  const gated = prs.filter((pr) =>
    input.pr !== undefined ? pr.number === input.pr : pr.headRepo === input.repo,
  );
  if (gated.length === 0) return LIVE;
  const open = gated.filter((pr) => pr.state === "open");
  if (open.some((pr) => pr.headSha.toLowerCase() === input.sha.toLowerCase())) return LIVE;
  return { live: false, reason: open.length > 0 ? "head superseded" : "pull request closed" };
};

/**
 * The gated pull request's liveness: `pulls/{pr}` when the input names it,
 * `commits/{sha}/pulls` otherwise. An unreadable answer is live.
 */
export const readLiveness = (input: {
  readonly repo: string;
  readonly sha: string;
  readonly pr?: number | undefined;
}) =>
  (input.pr !== undefined
    ? github.pullRequest({ repo: input.repo, number: input.pr }).pipe(Effect.map((pr) => [pr]))
    : github.commitPullRequests({ repo: input.repo, sha: input.sha })
  ).pipe(
    Effect.map((prs) => prLiveness(input, prs)),
    Effect.orElseSucceed((): Liveness => LIVE),
  );

/** The summary on the check of a part the gate did not run. */
export const unrunSummary = (reason: StopReason, timedOut: readonly string[]): string =>
  reason === "admission backlog"
    ? `not run — admission backlog: ${timedOut.join(", ")} waited past the ${STAGE_QUEUE_SEC / 60}-minute queue age, so the gate spawns no further parts into a saturated pool`
    : `not run — ${reason}`;

const Input = Schema.Struct({
  repo: Schema.Literal(REPO),
  sha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  baseSha: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i)),
  /** The pull request; a newer gate run of the same one supersedes this run. */
  pr: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /**
   * The pull request's `updated_at` in ms: the revision order within its
   * supersession group, so a later push outranks an earlier one whichever
   * gate registers first. A reopen adds {@link REOPEN_RANK_OFFSET_MS}.
   */
  revisedAt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
});

type InputType = Schema.Schema.Type<typeof Input>;

/**
 * A reopen ranks this far above its `updated_at`, past the close marker's
 * 1 ms (apps/dispatcher/src/pr-close.ts): GitHub reports `updated_at` to the
 * second, and a close and reopen in one second would otherwise leave the
 * reopen's gate below the marker, standing itself down. A push in the
 * reopen's own second ranks below that gate and stands down; the reopen's gate
 * then stops as head superseded, and the next push starts a gate.
 */
export const REOPEN_RANK_OFFSET_MS = 2;

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
  // 1.2.2 — a reopen ranks above the close marker of its own second.
  version: "1.2.2",
  inputs: Input,
  outputs: Output,
  triggers: [
    {
      event: "pull_request",
      actions: ["opened", "synchronize", "reopened", "ready_for_review"],
      // A reopen keys on its own `updated_at`: the close terminated the gate
      // keyed on this head and base, and a reopen without a push must start a
      // new one rather than collapse onto it.
      idempotencyKey: ({ payload }) =>
        `contextful-gate:${String(payload.pull_request?.number ?? "")}:${String(payload.pull_request?.head?.sha ?? "")}:${String(payload.pull_request?.base?.sha ?? "")}${
          payload.action === "reopened" ? `:reopened:${String(payload.pull_request?.updated_at ?? "")}` : ""
        }`,
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
          ...(Number.isInteger(revisedAt) && revisedAt >= 0
            ? { revisedAt: revisedAt + (payload.action === "reopened" ? REOPEN_RANK_OFFSET_MS : 0) }
            : {}),
        };
      },
    },
  ],
  // One gate run per pull request is live: a newer revision cancels the older
  // run, its children and their checks (apps/dispatcher/src/supersede.ts), and
  // the pull request's close cancels the live one (apps/dispatcher/src/pr-close.ts).
  supersede: (input) =>
    input.pr === undefined
      ? undefined
      : {
          group: `contextful-gate:${input.repo}#${input.pr}`,
          ...(input.revisedAt !== undefined ? { order: input.revisedAt } : {}),
        },
  // The gate reads every part's verdict: a part still queued once the gate
  // has ended leaves the admission queue (apps/dispatcher/src/admission-parent.ts).
  joinsChildren: true,
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
      //
      // Each spawn step first asks GitHub whether the pull request is still
      // open at this commit, and spawns nothing when it is not; an unreadable
      // answer spawns as before. The read lives inside the spawn checkpoint, so
      // an instance replaying spawns cached before the read existed replays
      // them all before the first fresh read. A part that times out in the
      // admission queue also stops it: the pool is saturated, and further
      // windows would only queue behind the backlog.
      const queue = [...plan.dispatch];
      const running: { readonly stage: string; readonly id: string; readonly expiresAt: number }[] = [];
      const failed = new Set<string>();
      const timedOut: string[] = [];
      let stopped: StopReason | undefined;
      let spawned = 0;
      const createdAt = (yield* io.env(EXECUTION_CREATED_AT_ENV)) ?? "unknown";
      const deployedVersion = (yield* io.env(DEPLOYED_VERSION_ENV)) ?? "unknown";
      for (let round = 0; stopped === undefined && (queue.length > 0 || running.length > 0); round++) {
        const free = window - running.length;
        if (queue.length > 0 && free > 0) {
          // Logged on every invocation that reaches a spawn, replays included:
          // an instance created before a deploy that logs this line runs the
          // deployed code.
          yield* io.log("info", `spawn-parts-${spawned}: execution created ${createdAt}, deployed version ${deployedVersion}`, {
            step: `spawn-parts-${spawned}`,
            executionCreatedAt: createdAt,
            deployedVersion,
          });
          const batch = queue.slice(0, free);
          const spawn = yield* step(`spawn-parts-${spawned}`, () =>
            Effect.gen(function* () {
              const liveness = yield* readLiveness(input);
              if (!liveness.live) return { stopped: liveness.reason };
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
          if ("stopped" in spawn) {
            stopped = spawn.stopped;
            break;
          }
          const { handles, spawnedAt } = spawn;
          queue.splice(0, batch.length);
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
            .map((record) => [record.executionId, record]),
        );
        for (let index = running.length - 1; index >= 0; index--) {
          const part = running[index]!;
          const record = settled.get(part.id);
          if (record === undefined) continue;
          if (record.status !== "success") failed.add(part.stage);
          if (record.failureTag === "AdmissionTimedOut") timedOut.push(part.stage);
          running.splice(index, 1);
        }
        if (timedOut.length > 0 && queue.length > 0) stopped = "admission backlog";
      }
      if (stopped !== undefined) {
        // Branch protection requires every part's check: each part never
        // spawned is posted cancelled, naming why. A part still running or
        // queued ends on its own; a queued one leaves the queue once this
        // gate has ended.
        const reason = stopped;
        const unrun = [...queue];
        const timedOutInOrder = plan.dispatch.filter((stage) => timedOut.includes(stage));
        yield* Effect.forEach(
          unrun,
          (stage) =>
            Effect.gen(function* () {
              const name = partCheckName(stage);
              const output = { title: name, summary: unrunSummary(reason, timedOutInOrder) };
              const checkRunId = yield* step(`open-unrun-${stage}`, () =>
                checks.create({ repo: input.repo, sha: input.sha, name, output }),
              );
              yield* step(`conclude-unrun-${stage}`, () =>
                checks.update({ repo: input.repo, checkRunId, conclusion: "cancelled", output }),
              );
            }),
          { concurrency: 4, discard: true },
        );
        if (reason !== "admission backlog") {
          return yield* Effect.fail(
            new RunSkipped({ reason: `${reason} — ${unrun.length} of ${plan.dispatch.length} parts not run` }),
          );
        }
        const failedParts = plan.dispatch.filter((stage) => failed.has(stage));
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd: [
              `Admission backlog: ${timedOutInOrder.join(", ")} waited past the ${STAGE_QUEUE_SEC / 60}-minute queue age; the gate spawned no further parts.`,
              `Not run: ${unrun.join(", ")}`,
              ...(failedParts.length > 0 ? [`Gate stages failed: ${failedParts.join(", ")}`] : []),
            ].join("\n\n"),
          }),
        );
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
