// @fractalboxdev/flare-dispatch-core/primitives — waitForChildren: join on a fan-out.
//
// The other half of `fanOut`: poll the `childRuns` capability for the status of
// each spawned child execution until every one has settled (success / failure /
// cancelled), then return their records — including each terminal child's
// `summaryJson`, so a parent can decode and roll up its children's outputs
// (merge N shard reports into one, count pass/fail, etc.).
//
// Shaped exactly like `cdp-acceptance`'s `pollSentinelExit`: short, cheap polls
// (a single D1 read each) separated by `io.sleep`, never a long-held connection.
// A native checkpoint has a finite wall-clock timeout. Long joins use
// `waitForChildrenDurably` outside a containing checkpoint. This inline loop
// is bounded by `maxAttempts` derived from
// `timeout / pollEvery` (a count, not a wall-clock read) so it stays
// replay-deterministic — `io.now` drift across a checkpoint resume cannot change
// how many polls run.
//
// Spec: specs/03-dsl.md § Primitives + § spawnChildRun, specs/01-architecture.md
//       § Long-running test handling.

import { Duration, Effect } from "effect";
import { ChildWaitTimeout } from "../errors";
import { type ChildStatusRecord, ChildRuns, isTerminalChildStatus } from "../services/child-runs";
import { IO, io } from "../services/io";
import { StepRunner } from "../services/step-runner";
import { step } from "../step";

const POLL_EVERY_DEFAULT = "5 seconds";
const TIMEOUT_DEFAULT = "30 minutes";

/** Short status checkpoints and durable sleeps share one persisted deadline. */
export const waitForChildrenDurably = (opts: {
  readonly name: string;
  readonly ids: readonly string[];
  readonly pollEvery?: Duration.DurationInput;
  readonly timeout?: Duration.DurationInput;
}) => Effect.gen(function* () {
  if (opts.ids.length === 0) return [] as readonly ChildStatusRecord[];
  const pollMs = Math.max(1, Duration.toMillis(Duration.decode(opts.pollEvery ?? "2 minutes")));
  const timeoutMs = Duration.toMillis(Duration.decode(opts.timeout ?? TIMEOUT_DEFAULT));
  const deadline = yield* step(`${opts.name}-deadline`, () =>
    io.now.pipe(Effect.map((startedAt) => ({ startedAt, expiresAt: startedAt + timeoutMs }))),
    { timeoutSec: 60 },
  );
  const children = yield* ChildRuns;
  const runner = yield* StepRunner;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs) + 1);
  let pending = [...opts.ids];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observed = yield* step(`${opts.name}-poll-${attempt}`, () => Effect.gen(function* () {
      const before = yield* io.now;
      const records = before > deadline.expiresAt ? [] : yield* children.poll({ ids: opts.ids });
      return { records, observedAt: yield* io.now };
    }), { timeoutSec: 60 });
    const ordered = opts.ids.map((id) => observed.records.find((record) => record.executionId === id)
      ?? { executionId: id, status: "missing" as const });
    pending = ordered.filter((record) => !isTerminalChildStatus(record.status)).map((record) => record.executionId);
    if (observed.observedAt <= deadline.expiresAt && pending.length === 0) return ordered;
    if (observed.observedAt >= deadline.expiresAt || attempt === attempts - 1) {
      return yield* Effect.fail(new ChildWaitTimeout({
        pending: pending.length > 0 ? pending : [...opts.ids],
        waitedMs: Math.max(0, observed.observedAt - deadline.startedAt),
      }));
    }
    const delay = Math.min(pollMs, deadline.expiresAt - observed.observedAt);
    // Live runtimes persist the wake-up; inline runtimes use the injected clock.
    yield* runner.sleep !== undefined
      ? runner.sleep(`${opts.name}-sleep-${attempt}`, delay)
      : io.sleep(Duration.millis(delay));
  }
  return yield* Effect.fail(new ChildWaitTimeout({ pending, waitedMs: timeoutMs }));
});

/**
 * Short status checkpoints and durable sleeps until at least one child in `ids`
 * settles. Resolves to every record in input order — terminal and pending alike
 * — so a sliding-window caller frees exactly the slots that settled.
 *
 * `expiresAt` is an absolute epoch-ms deadline the caller computes from its own
 * checkpointed clock reads (a window's earliest per-child budget), so a resumed
 * wait keeps the deadline it started with. Fails `ChildWaitTimeout` naming the
 * still-pending ids once it passes with nothing settled. The poll count is
 * bounded by `(expiresAt - first observation) / pollEvery`, never by a clock
 * that may not advance.
 */
export const waitForAnyChildDurably = (opts: {
  readonly name: string;
  readonly ids: readonly string[];
  readonly expiresAt: number;
  readonly pollEvery?: Duration.DurationInput;
}) => Effect.gen(function* () {
  if (opts.ids.length === 0) return [] as readonly ChildStatusRecord[];
  const pollMs = Math.max(1, Duration.toMillis(Duration.decode(opts.pollEvery ?? "1 minute")));
  const children = yield* ChildRuns;
  const runner = yield* StepRunner;
  let firstObservedAt: number | undefined;
  let attempts = 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observed = yield* step(`${opts.name}-poll-${attempt}`, () => Effect.gen(function* () {
      const before = yield* io.now;
      const records = before > opts.expiresAt ? [] : yield* children.poll({ ids: opts.ids });
      return { records, observedAt: yield* io.now };
    }), { timeoutSec: 60 });
    if (firstObservedAt === undefined) {
      firstObservedAt = observed.observedAt;
      attempts = Math.max(1, Math.ceil(Math.max(0, opts.expiresAt - firstObservedAt) / pollMs) + 1);
    }
    const ordered = opts.ids.map((id) => observed.records.find((record) => record.executionId === id)
      ?? { executionId: id, status: "missing" as const });
    if (observed.observedAt <= opts.expiresAt && ordered.some((record) => isTerminalChildStatus(record.status))) {
      return ordered;
    }
    if (observed.observedAt >= opts.expiresAt || attempt === attempts - 1) {
      return yield* Effect.fail(new ChildWaitTimeout({
        pending: [...opts.ids],
        waitedMs: Math.max(0, observed.observedAt - firstObservedAt),
      }));
    }
    const delay = Math.min(pollMs, opts.expiresAt - observed.observedAt);
    yield* runner.sleep !== undefined
      ? runner.sleep(`${opts.name}-sleep-${attempt}`, delay)
      : io.sleep(Duration.millis(delay));
  }
  return yield* Effect.fail(new ChildWaitTimeout({ pending: [...opts.ids], waitedMs: 0 }));
});

/**
 * Wait until every child in `ids` reaches a terminal status, returning their
 * status records (input order). Fails `ChildWaitTimeout` if the overall ceiling
 * elapses with children still pending.
 *
 * @example
 * const handles = yield* step("fanout", () => fanOut({ ... }));
 * const results = yield* step("await-children", () =>
 *   waitForChildren({ ids: handles.map((h) => h.executionId) }),
 * );
 * const failed = results.filter((r) => r.status === "failure");
 */
export const waitForChildren = (opts: {
  /** The child execution ids to join on — typically `fanOut` handle ids. */
  readonly ids: readonly string[];
  /** Delay between polls. Default 5s. */
  readonly pollEvery?: Duration.DurationInput;
  /** Overall wait ceiling before `ChildWaitTimeout`. Default 30m. */
  readonly timeout?: Duration.DurationInput;
}): Effect.Effect<readonly ChildStatusRecord[], ChildWaitTimeout, ChildRuns | IO> => {
  const pollEvery = Duration.decode(opts.pollEvery ?? POLL_EVERY_DEFAULT);
  const pollEveryMs = Duration.toMillis(pollEvery);
  const timeoutMs = Duration.toMillis(Duration.decode(opts.timeout ?? TIMEOUT_DEFAULT));
  // At least one poll; one poll per `pollEvery` up to the ceiling.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollEveryMs)));

  return Effect.gen(function* () {
    // Nothing to wait for — a fan-out over zero items, or a caller that already
    // filtered everything out.
    if (opts.ids.length === 0) return [];

    const childRuns = yield* ChildRuns;
    let last: readonly ChildStatusRecord[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = yield* childRuns.poll({ ids: opts.ids });
      const pending = last.filter((r) => !isTerminalChildStatus(r.status));
      if (pending.length === 0) return last;

      // Don't sleep after the final attempt — fall straight through to timeout.
      if (attempt < maxAttempts - 1) {
        yield* io.sleep(pollEvery);
      } else {
        return yield* Effect.fail(
          new ChildWaitTimeout({
            pending: pending.map((r) => r.executionId),
            waitedMs: attempt * pollEveryMs,
          }),
        );
      }
    }
    // Unreachable (the final-attempt branch returns/fails), but keeps the
    // function total without a non-null assertion.
    return last;
  });
};
