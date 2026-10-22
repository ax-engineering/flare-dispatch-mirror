// @fractalboxdev/flare-dispatch-core/primitives — fanOut: child-Workflow matrix fan-out.
//
// Spawn one independent child `RunWorkflow` instance per item in a list, bounded
// by `concurrency`. The cross-instance counterpart of `sharded` (which fans out
// inside the parent's single instance): each child here is its own durable
// Workflow with its own step budget, container, and Browser Rendering session,
// so the parallelism ceiling is the *account*-level limit (container vCPU,
// Browser Rendering concurrent sessions), not the parent instance's per-instance
// step quota or per-exec container-kill window.
//
// `fanOut` is the count/list-and-index shape on top of the `spawnChildRun`
// capability, exactly as `sharded` is the shape on top of `Effect.forEach`. It
// is intentionally fire-and-spawn: it returns the spawn handles (one per item),
// not the children's outputs. Each child reports its own verdict via its own D1
// row + GitHub check-run; a parent that needs to JOIN on child results reads
// them back by `parent_execution_id` (the lineage column every child sets) in a
// later step — kept out of this primitive so the spawn shape stays small.
//
// Call inside a `step("fanout", () => fanOut(...))` so the spawn set is one
// checkpoint; the deterministic child instance ids make the underlying
// `create` idempotent on replay regardless.
//
// Before it spawns anything, `fanOut` reads the deploy's spend through the
// capability's `spendGate`: at or over the monthly budget it fails
// `RunSkipped` and spawns no child (specs/adr/0006-spend-guard.md).
//
// Spec: specs/03-dsl.md § Primitives + § spawnChildRun.

import { Effect } from "effect";
import type { ChildSpawnFailed, RunSkipped } from "../errors";
import { type ChildRunHandle, ChildRuns, spawnChildRun } from "../services/child-runs";
import type { Shard } from "./sharded";

/** A fan-out target paired with its 1-based shard coordinates. */
export type FanOutShard<T> = {
  readonly item: T;
  readonly shard: Shard;
};

/**
 * Spawn one child run per `item`, mapping each to the child's input (and,
 * optionally, an explicit semantic instance id), bounded by `concurrency`.
 * Returns the spawn handles in item order — `created: false` on any handle
 * whose instance id already existed (an idempotent re-spawn).
 *
 * @example
 * const handles = yield* step("fanout", () =>
 *   fanOut({
 *     run: "playwright-e2e-shard",
 *     items: shardPlan,
 *     toInput: (s) => ({ ...input, shard: s.shard }),
 *   }),
 * );
 */
export const fanOut = <T>(opts: {
  /** The child run name (registered on the same deploy). */
  readonly run: string;
  /** The items to fan out over — one child per item. */
  readonly items: readonly T[];
  /** Map an item (+ its shard coords) to the child run's input. */
  readonly toInput: (item: T, shard: Shard) => unknown;
  /**
   * Map an item to an explicit semantic instance id. Omit to let the live layer
   * derive a deterministic id from the parent execution id + run + input hash —
   * sufficient for a per-shard matrix where shards have no identity beyond their
   * position. Supply one when the child has its own dedup identity (e.g. a PR's
   * `repo:number:sha`) that should collapse duplicate logical work.
   */
  readonly toInstanceId?: (item: T, shard: Shard) => string;
  /** Max concurrent spawns. Default: all at once (spawn is a cheap create). */
  readonly concurrency?: number;
}): Effect.Effect<readonly ChildRunHandle[], ChildSpawnFailed | RunSkipped, ChildRuns> => {
  const total = opts.items.length;
  if (total === 0) return Effect.succeed([]);
  const spawnAll = Effect.forEach(
    opts.items.map((item, i): FanOutShard<T> => ({
      item,
      shard: { index: i + 1, total },
    })),
    ({ item, shard }) =>
      spawnChildRun({
        run: opts.run,
        input: opts.toInput(item, shard),
        ...(opts.toInstanceId !== undefined ? { instanceId: opts.toInstanceId(item, shard) } : {}),
      }),
    { concurrency: opts.concurrency ?? total },
  );
  return Effect.flatMap(ChildRuns, (c) => c.spendGate(opts.run)).pipe(Effect.andThen(spawnAll));
};
