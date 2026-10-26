// Primitive: durableExec — run a long command without a long Workflow step
//
// A Workflow step is a unit of retry, not of waiting. Holding one step open
// for the length of a command (a 30-minute check, a 4-hour cross-build) pins
// the instance to a single attempt: the command outcome is lost with the
// Worker that awaited it, and a retry re-runs the whole command from scratch.
//
// So a long command is a sequence of short, individually retryable steps over
// a process the sandbox owns:
//
//   <name>-workspace   re-establish the checkout (the caller's `ensure`)
//   <name>-prepare     record the launch intent at the durable process owner
//   <name>-start       launch it; a retry recovers the same intent, never a second process
//   <name>-observe-<i> poll the process, streaming its log to R2
//   <name>-sleep-<i>   `step.sleep` between polls — hibernates, and costs no step
//   <name>-finalize    the exit status and the assembled log, as an `ExecResult`
//
// Polls back off from 5 s to 60 s, so a four-hour command spends a few hundred
// steps against the instance step cap, not thousands. The command's own
// deadline (the supervisor's) ends it; the poll count is only a backstop.
//
// A container recycled mid-command takes the process table with it and the
// owner answers `missing`. That loss is the platform's, so the command
// relaunches in a destroyed-and-rebuilt container under
// `<name>-relaunch-<n>-*` step names (a new `stepName` is a new process
// identity), up to `relaunches` times, and then fails `SandboxProcessLost`.
// A caller with a run ceiling passes `relaunchDeadlineMs`, and a relaunch that
// could not finish before it fails `SandboxProcessLost` instead of starting.
//
// A deploy without a durable process owner (`Sandbox.checkCommand` absent),
// and a command short enough that one step is the honest unit, run as a
// single retryable `<name>` step with `ensure` inside it. A command that must
// not run twice (a deploy) passes `minDurableTimeoutSec: 0`, so it takes the
// durable form at any length wherever an owner exists, and
// `singleStepRetries: 0` for the step it runs in without one.
//
// Layer: 03-dsl § Primitives. Rides on `sandbox`, `step` and `checkpointSleep`.

import { Effect } from "effect";
import type { RunContext } from "../context";
import { type ExecFailed, type ExecTimeout, SandboxProcessLost, type StepFailed } from "../errors";
import { io } from "../services/io";
import { sandbox, Sandbox, type ExecResult } from "../services/sandbox";
import { checkpointSleep, step } from "../step";
import type { Workspace } from "./workspace";

/** At or below this, one step is the unit: a lost response costs little to re-run. */
export const DURABLE_EXEC_MIN_TIMEOUT_SEC = 600;
/** Headroom between the command deadline and a single-step ceiling, so `ExecTimeout` fires first. */
const STEP_TIMEOUT_HEADROOM_SEC = 120;
/**
 * A launch or observation can be the call that wakes a recycled container, and
 * a cold start in a saturated pool outlasts a minute.
 */
const CONTAINER_CALL_STEP_TIMEOUT_SEC = 300;
/**
 * Finalize re-reads the terminal record, drains the spool and re-reads it at
 * `finish`; each spool read in a loaded container can take a minute.
 */
const FINALIZE_STEP_TIMEOUT_SEC = CONTAINER_CALL_STEP_TIMEOUT_SEC;
/**
 * What a relaunch spends besides its command: destroying the container,
 * rebuilding the checkout, the launch, and the last poll and finalize.
 */
const RELAUNCH_HEADROOM_SEC = CONTAINER_CALL_STEP_TIMEOUT_SEC;
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 60_000;
/** Polls at each interval before it doubles. */
const POLLS_PER_INTERVAL = 12;
/** Polls past the deadline, for the supervisor to publish its timeout. */
const POLL_GRACE = 3;

/**
 * Platform failures every durable step retries. A command that runs and exits
 * non-zero is a returned `ExecResult`, so no class here can retry a verdict,
 * and `ExecTimeout` is absent: a command that outran its ceiling will outrun it
 * again. `StepFailed` is the name a platform kill leaves (no `Cause` to read a
 * tag from); `CheckoutFailed` covers a clone that flakes inside `ensure`.
 */
export const DURABLE_EXEC_RETRY_ON = ["ExecFailed", "StepFailed", "CheckoutFailed"] as const;

export const pollDelayMs = (poll: number): number =>
  Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.floor(poll / POLLS_PER_INTERVAL));

export type DurableExecCommand = {
  readonly command: string | readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Secret values to scrub from every durable surface; [] declares none. */
  readonly redactValues: readonly string[];
  readonly timeoutSec: number;
};

export type DurableExecOpts<E> = {
  /** Step-name prefix; unique within the run. */
  readonly name: string;
  /** The workspace the command last ran in, or the fresh checkout. */
  readonly workspace: Workspace;
  /**
   * The workspace the command needs, rebuilt if it is gone. Runs inside a
   * retryable step, so a re-clone is part of what a retry re-runs.
   */
  readonly ensure: (current: Workspace) => Effect.Effect<Workspace, E, RunContext>;
  readonly exec: (ws: Workspace) => DurableExecCommand;
  /** Relaunches after the sandbox loses the process. Default 2. */
  readonly relaunches?: number;
  /** Platform retries per step. Default 3. */
  readonly retries?: number;
  /**
   * Platform retries for the single-step form (a command within
   * `minDurableTimeoutSec`, or no durable owner). That step re-runs the whole
   * command, so a caller whose command must not run twice passes 0.
   * Default `retries`.
   */
  readonly singleStepRetries?: number;
  /**
   * At or below this command timeout, one step is the unit even where a
   * durable owner exists. Default `DURABLE_EXEC_MIN_TIMEOUT_SEC`. A command
   * that must not run twice passes 0: a short one then survives a lost
   * attempt as well as a long one does.
   */
  readonly minDurableTimeoutSec?: number;
  /**
   * Epoch ms a relaunch must finish by — the caller's run ceiling. A relaunch
   * whose command timeout plus `RELAUNCH_HEADROOM_SEC` would outrun it fails
   * `SandboxProcessLost` instead: the ceiling would interrupt it mid-command.
   * Absent, only `relaunches` bounds them.
   */
  readonly relaunchDeadlineMs?: number;
};

export type DurableExecResult = { readonly result: ExecResult; readonly workspace: Workspace };

export const durableExec = <E>(
  opts: DurableExecOpts<E>,
): Effect.Effect<
  DurableExecResult,
  E | ExecFailed | ExecTimeout | SandboxProcessLost | StepFailed,
  RunContext
> =>
  Effect.gen(function* () {
    const retry = { retries: opts.retries ?? 3, retryOn: DURABLE_EXEC_RETRY_ON };
    const durable = (yield* Sandbox).checkCommand;
    const timeoutSec = opts.exec(opts.workspace).timeoutSec;

    if (durable === undefined || timeoutSec <= (opts.minDurableTimeoutSec ?? DURABLE_EXEC_MIN_TIMEOUT_SEC)) {
      const singleStepRetries = opts.singleStepRetries ?? retry.retries;
      // The checkpoint stays an `ExecResult` with the workspace beside it, so an
      // instance that checkpointed a bare `ExecResult` replays unchanged.
      const { workspace = opts.workspace, ...result } = yield* step(
        opts.name,
        () =>
          Effect.gen(function* () {
            const ws = yield* opts.ensure(opts.workspace);
            const result = yield* sandbox.exec({ ...opts.exec(ws), container: ws.container });
            return { ...result, workspace: ws } as ExecResult & { workspace?: Workspace };
          }),
        {
          // With no retries, no failure class applies.
          ...(singleStepRetries > 0 ? { ...retry, retries: singleStepRetries } : { retries: 0 }),
          timeoutSec: timeoutSec + STEP_TIMEOUT_HEADROOM_SEC,
        },
      );
      return { result, workspace };
    }

    const relaunches = opts.relaunches ?? 2;
    let ws = opts.workspace;
    for (let launch = 0; launch <= relaunches; launch++) {
      // The first launch keeps the step names an in-flight instance already
      // checkpointed; each relaunch gets its own names and process identity.
      const name = launch === 0 ? opts.name : `${opts.name}-relaunch-${launch}`;
      if (launch > 0) {
        if (opts.relaunchDeadlineMs !== undefined) {
          // Checkpointed, so a replay takes the same decision.
          const { at } = yield* step(`${name}-clock`, () => Effect.map(io.now, (at) => ({ at })));
          if (at + (timeoutSec + RELAUNCH_HEADROOM_SEC) * 1000 > opts.relaunchDeadlineMs) {
            yield* io.log(
              "warn",
              `${opts.name}: the sandbox lost the process, and a relaunch could not finish before the run ceiling — not relaunching`,
            );
            return yield* Effect.fail(new SandboxProcessLost({ launches: launch }));
          }
        }
        // A supervisor that died may leave its process group running, so the
        // relaunch starts from a destroyed container and `ensure` rebuilds it.
        const lost = ws.container;
        yield* step(`${name}-destroy`, () => sandbox.destroy({ container: lost }));
      }
      const current = ws;
      ws = yield* step(`${name}-workspace`, () => opts.ensure(current), retry);
      const command = { ...opts.exec(ws), container: ws.container };
      const handle = yield* step(`${name}-prepare`, () =>
        durable.prepare({ ...command, stepName: name }),
      );
      // Only the owner's recorded intent authorizes a launch; a retry recovers it.
      yield* step(`${name}-start`, () => durable.start(handle, command), {
        ...retry,
        timeoutSec: CONTAINER_CALL_STEP_TIMEOUT_SEC,
      });
      let state = "running";
      let waitedMs = 0;
      for (let poll = 0; state === "running"; poll++) {
        const status = yield* step(
          `${name}-observe-${poll}`,
          () => durable.observe(handle, command),
          { ...retry, timeoutSec: CONTAINER_CALL_STEP_TIMEOUT_SEC },
        );
        state = status.state;
        if (state !== "running" || waitedMs > timeoutSec * 1000 + POLL_GRACE * POLL_MAX_MS) break;
        const delay = pollDelayMs(poll);
        yield* checkpointSleep(`${name}-sleep-${poll}`, delay);
        waitedMs += delay;
      }
      // `missing`: the sandbox holds no process and no terminal record for
      // this launch, so no exit status exists to report.
      if (state === "missing") continue;
      const result = yield* step(`${name}-finalize`, () => durable.finalize(handle, command), {
        ...retry,
        timeoutSec: FINALIZE_STEP_TIMEOUT_SEC,
      });
      return { result, workspace: ws };
    }
    return yield* Effect.fail(new SandboxProcessLost({ launches: relaunches + 1 }));
  });
