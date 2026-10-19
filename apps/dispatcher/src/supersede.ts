// Cancelling a superseded execution tree — the dispatcher's half of `supersede`.
//
// A run that declares `supersede` (core define-run.ts) registers in its group
// before admission; every older live member it supersedes is cancelled here,
// wherever it stands: queued for a slot, running, or joined on children.
//
// Order, per superseded root:
//   1. mark the root row 'cancelled' — a child whose row is not yet visible
//      checks its parent's status when it boots (`standsDown`) and ends itself;
//   2. terminate the root's Workflow instance, so it spawns nothing more;
//   3. read the root and every child row still open;
//   4. terminate each child's instance and tear down each container;
//   5. end those rows 'cancelled' and delete their admission, serial-queue
//      and supersession rows — the freed slots admit the next waiter at once;
//   6. conclude every still-open check-run of the tree `cancelled`.
//
// D1 writes and instance termination fail the step so it retries the
// idempotent sequence. Container and check-run calls are best-effort.

import { Effect } from "effect";
import type { ChecksService, SupersedeSpec } from "@fractalboxdev/flare-dispatch-core";
import type { RunSupersedeStore, SupersededRow } from "@fractalboxdev/flare-dispatch-runtime-cf";

/** The no-op sentinel a degraded `checks.create` returns — no check-run to conclude. */
const NOOP_CHECK_RUN_ID = "noop";

export type SupersedePorts = {
  readonly store: Pick<RunSupersedeStore, "markCancelled" | "status" | "openTree" | "cancel">;
  /** Terminate one Workflow instance; an instance already ended is not an error. */
  readonly terminate: (executionId: string) => Promise<void>;
  /** Tear down the container an execution's run body uses. */
  readonly destroySandbox: (row: SupersededRow) => Promise<void>;
  readonly checks: Pick<ChecksService, "status" | "update">;
};

export const supersededSummary = (supersededBy: string): string =>
  `⊘ Cancelled — execution \`${supersededBy}\` superseded this run for a newer revision of the same group.`;

const bestEffort = (label: string, thunk: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise(thunk).pipe(
    Effect.timeout("30 seconds"),
    Effect.asVoid,
    Effect.catchAllCause((cause) => Effect.logWarning(`supersede: ${label} — ${cause}`)),
  );

const terminate = (id: string, ports: SupersedePorts): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => ports.terminate(id),
    catch: (cause) => new Error(`supersede: terminate ${id} failed`, { cause }),
  }).pipe(Effect.timeout("30 seconds"), Effect.mapError((cause) => new Error(`supersede: terminate ${id} failed`, { cause })));

// Opening a GitHub check and storing its id cannot be atomic. Leave the
// Workflow alive until the id is visible so its opener can reconcile the
// cancellation; the durable cancellation step retries without freeing slots.
const requireCheckRunId = (row: SupersededRow | undefined): Effect.Effect<void, Error> =>
  row?.checkRunId != null
    ? Effect.void
    : Effect.fail(new Error("supersede: waiting for check-run id persistence"));

/**
 * Cancel `rootId` and its children on behalf of `supersededBy`. Resolves to the
 * ids whose rows it ended.
 */
export const cancelSupersededTree = (
  rootId: string,
  supersededBy: string,
  ports: SupersedePorts,
): Effect.Effect<readonly string[], Error> =>
  Effect.gen(function* () {
    yield* ports.store.markCancelled(rootId);
    if ((yield* ports.store.status(rootId)) !== "cancelled") return [];
    const openingTree = yield* ports.store.openTree(rootId);
    yield* requireCheckRunId(openingTree.find((row) => row.id === rootId));
    yield* terminate(rootId, ports);
    const stopped = new Set([rootId]);
    let tree: readonly SupersededRow[];
    while (true) {
      tree = yield* ports.store.openTree(rootId);
      const children = tree.filter((row) => !stopped.has(row.id));
      if (children.length === 0) break;
      yield* Effect.forEach(
        children,
        (row) => Effect.gen(function* () {
          // Claim the verdict before terminating: completion may be in flight.
          yield* ports.store.markCancelled(row.id);
          if ((yield* ports.store.status(row.id)) === "cancelled") {
            yield* requireCheckRunId(row);
            yield* terminate(row.id, ports);
          }
          stopped.add(row.id);
        }),
        { concurrency: 4, discard: true },
      );
      // A descendant may have spawned while its parent was being stopped.
      // Re-read after termination; later boots observe the cancelled parent.
    }
    yield* Effect.forEach(
      tree,
      (row) => bestEffort(`destroy ${row.id}`, () => ports.destroySandbox(row)),
      { concurrency: 4, discard: true },
    );
    const ids = tree.map((row) => row.id);
    yield* ports.store.cancel(ids);
    yield* Effect.forEach(
      tree,
      (row) =>
        Effect.gen(function* () {
          const checkRunId = row.checkRunId;
          if (checkRunId === null || checkRunId === NOOP_CHECK_RUN_ID) return;
          const state = yield* ports.checks.status({ repo: row.repo, checkRunId });
          if (state !== "open") return;
          yield* ports.checks.update({
            repo: row.repo,
            checkRunId,
            conclusion: "cancelled",
            output: { title: "Superseded", summary: supersededSummary(supersededBy) },
          });
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logWarning(`supersede: check-run of ${row.id} not concluded — ${cause}`),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    return ids;
  });

/**
 * Whether a child must stand down at boot: its parent was cancelled before
 * the child's row existed, so no canceller saw it.
 */
export const standsDown = (parentStatus: string | undefined): boolean =>
  parentStatus === "cancelled";

export type SupersessionPorts = {
  /** A durable checkpoint (RunWorkflow's `step.do`). */
  readonly stepDo: <T>(name: string, body: () => Promise<T>) => Effect.Effect<T>;
  readonly store: Pick<RunSupersedeStore, "status" | "cancel" | "register">;
  /** Cancel one superseded tree (`cancelSupersededTree` bound to live ports). */
  readonly cancelTree: (olderId: string) => Effect.Effect<unknown, Error>;
  /** Conclude this execution's own check-run `cancelled` with `summary`. */
  readonly concludeCancelled: (summary: string) => Effect.Effect<void>;
};

/**
 * RunWorkflow's supersession prelude, run after the check-run opens and before
 * serialization and admission. `stood-down` means this execution ended itself
 * `cancelled`: its parent was cancelled before its row existed, or a
 * higher-ranked member of its group is already live. `proceed` means every
 * lower-ranked member it superseded is cancelled, one checkpoint per tree. A
 * re-run (`retryOf`) joins its group and cancels nothing.
 */
export const enterSupersession = (
  args: {
    readonly executionId: string;
    readonly parentExecutionId?: string;
    readonly retryOf?: string;
    readonly spec: SupersedeSpec | undefined;
  },
  ports: SupersessionPorts,
): Effect.Effect<"proceed" | "stood-down"> =>
  Effect.gen(function* () {
    const standDown = (supersededBy: string) =>
      Effect.gen(function* () {
        yield* ports.stepDo("stand-down", () =>
          Effect.runPromise(ports.store.cancel([args.executionId])).then(() => true),
        );
        yield* ports.concludeCancelled(supersededSummary(supersededBy));
        return "stood-down" as const;
      });
    if (args.parentExecutionId !== undefined) {
      const parentId = args.parentExecutionId;
      const parentStatus = yield* ports.stepDo("parent-status", () =>
        Effect.runPromise(ports.store.status(parentId)).then((status) => status ?? null),
      );
      if (standsDown(parentStatus ?? undefined)) return yield* standDown(parentId);
    }
    const spec = args.spec;
    if (spec === undefined) return "proceed" as const;
    const supersedeOlder = args.retryOf === undefined;
    const registration = yield* ports.stepDo("supersede-register", () =>
      Effect.runPromise(
        ports.store.register(args.executionId, spec.group, {
          supersedeOlder,
          ...(spec.order !== undefined ? { rank: spec.order } : {}),
        }),
      ).then((r) => ({ superseded: [...r.superseded], supersededBy: r.supersededBy ?? null })),
    );
    if (registration.supersededBy !== null) return yield* standDown(registration.supersededBy);
    for (const [index, olderId] of registration.superseded.entries()) {
      yield* ports.stepDo(`supersede-cancel-${index}`, () =>
        Effect.runPromise(ports.cancelTree(olderId)).then(() => true),
      );
    }
    return "proceed" as const;
  });

/**
 * Leave the group on every exit of `body` — success, failure or interruption —
 * except when the engine lost the instance: the replay is the same execution
 * and stays in its group.
 */
export const withSupersessionRelease = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  opts: {
    readonly joined: boolean;
    readonly release: Effect.Effect<void>;
    readonly lost: Effect.Effect<boolean>;
  },
): Effect.Effect<A, E, R> =>
  opts.joined
    ? body.pipe(Effect.ensuring(Effect.unlessEffect(opts.release, opts.lost).pipe(Effect.asVoid)))
    : body;
