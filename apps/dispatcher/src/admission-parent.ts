// A queued child whose joining parent has ended leaves the admission queue.
//
// A fan-out child enqueues for an admission slot and waits, polling one durable
// claim step at a time. A parent whose run declares `joinsChildren` reads every
// child's verdict; once it ends — superseded, failed or cancelled — nothing
// reads the verdict of a child still queued. So each claim step first reads the
// parent's row: once that row is terminal and its run joins its children, the
// child ends its own row `cancelled` and deletes its admission, serial-queue and
// supersession rows in one checkpoint, concludes its check-run `cancelled`, and
// fails `RunSkipped`. Its row is already `cancelled`, so the finalizer records
// and concludes nothing further.
//
// A parent that spawns children without waiting on them (product-demo's
// demo-reel and self-heal-pr) declares no `joinsChildren`; its children outlive
// it. The rule reads the parent's run from its row, so a child spawned before
// a deploy follows it too. A parent-row read that fails keeps the child
// waiting: the claim proceeds exactly as it would without the read.

import { Effect } from "effect";
import { RunSkipped } from "@fractalboxdev/flare-dispatch-core";
import {
  TERMINAL_EXECUTION_STATUSES,
  type RunSupersedeStore,
} from "@fractalboxdev/flare-dispatch-runtime-cf/run-supersede";

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_EXECUTION_STATUSES);

/** A claim step's answer when the parent has ended: no claim was attempted. */
export type ParentEnded = { readonly parentEnded: string };

/** Whether a parent row's status ends its queued children. */
export const parentHasEnded = (status: string | undefined): status is string =>
  status !== undefined && TERMINAL.has(status);

export const parentEndedSummary = (parentId: string, status: string): string =>
  `⊘ Cancelled — parent execution \`${parentId}\` ended \`${status}\` while this part waited for an admission slot.`;

/**
 * One claim step's body: the parent's row first, then — unless a joining
 * parent has ended — the admission claim itself.
 */
export const claimUnlessParentEnded = async <A>(opts: {
  readonly parentExecutionId: string | undefined;
  readonly parentRow: (id: string) => Promise<{ readonly status: string; readonly run: string } | undefined>;
  /** Whether a run declares `joinsChildren`. */
  readonly joinsChildren: (run: string) => boolean;
  readonly claim: () => Promise<A>;
}): Promise<A | ParentEnded> => {
  if (opts.parentExecutionId !== undefined) {
    const row = await opts.parentRow(opts.parentExecutionId).catch(() => undefined);
    if (row !== undefined && parentHasEnded(row.status) && opts.joinsChildren(row.run)) {
      return { parentEnded: row.status };
    }
  }
  return opts.claim();
};

export const isParentEnded = (observed: object): observed is ParentEnded =>
  "parentEnded" in observed && typeof (observed as ParentEnded).parentEnded === "string";

export type LeaveQueuePorts = {
  /** A durable checkpoint (RunWorkflow's `step.do`). */
  readonly stepDo: <T>(name: string, body: () => Promise<T>) => Effect.Effect<T>;
  readonly store: Pick<RunSupersedeStore, "cancel">;
  /** Conclude this execution's check-run `cancelled` with `summary`; never fails. */
  readonly concludeCancelled: (summary: string) => Effect.Effect<void>;
};

/** End a queued child whose parent ended: row, queue rows, check-run, then `RunSkipped`. */
export const leaveQueueForEndedParent = (
  args: { readonly executionId: string; readonly parentExecutionId: string; readonly parentStatus: string },
  ports: LeaveQueuePorts,
): Effect.Effect<never, RunSkipped> =>
  Effect.gen(function* () {
    yield* ports.stepDo("admission-parent-ended", () =>
      Effect.runPromise(ports.store.cancel([args.executionId])).then(() => true),
    );
    yield* ports.concludeCancelled(parentEndedSummary(args.parentExecutionId, args.parentStatus));
    return yield* Effect.fail(
      new RunSkipped({
        reason: `parent ${args.parentExecutionId} ended ${args.parentStatus} before this part was admitted`,
      }),
    );
  });
