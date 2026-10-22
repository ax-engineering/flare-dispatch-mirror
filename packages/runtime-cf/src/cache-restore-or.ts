// @fractalboxdev/flare-dispatch-runtime-cf — the pure cache `restoreOr` orchestration.
//
// Factored out of cache-r2.ts so it imports NO Cloudflare bindings (no
// `@cloudflare/sandbox`) and is therefore unit-testable in plain vitest —
// cache-r2.ts wires the live, container-backed `restore` / `save`; this file
// owns only the hit/miss/unapplied/error sequencing and the save's
// upload-once check.
//
// Spec: specs/03-dsl.md § cache, specs/pm/plan.md § PR8,
// specs/adr/0007-cost-efficient-execution.md § Upload each cache key once.

import { Effect, Match } from "effect";
import { CacheError, type Container } from "@fractalboxdev/flare-dispatch-core";

/**
 * What a restore did with a key:
 *
 *   - `hit` — the archive exists and is applied in the container;
 *   - `miss` — no archive is stored under the key;
 *   - `unapplied` — the archive exists, applying it failed (or the transport
 *     cannot stream it into the container).
 */
export type RestoreOutcome = "hit" | "miss" | "unapplied";

/** Restore a cached archive into a container. */
export type RestoreFn = (opts: {
  key: string;
  container: Container;
  dir?: string;
  base?: string;
}) => Effect.Effect<RestoreOutcome, CacheError>;

/** Pack container paths into an archive and persist it. */
export type SaveFn = (opts: {
  key: string;
  paths: readonly string[];
  container: Container;
  dir?: string;
  base?: string;
}) => Effect.Effect<void, CacheError>;

/** Whether an archive is already stored under a cache key. */
export type ExistsFn = (key: string) => Effect.Effect<boolean, CacheError>;

/**
 * A save that packs and uploads only when no archive is stored under its key.
 * Keys are content-addressed, so a stored archive already holds this content:
 * parallel misses on one key upload once instead of once per part. A failed
 * existence check packs as before — the check saves work, it guards nothing.
 */
export const composeSave =
  (exists: ExistsFn, pack: SaveFn): SaveFn =>
  (opts) =>
    exists(opts.key).pipe(
      Effect.catchAll((e) => Effect.as(Effect.logWarning(e.message), false)),
      Effect.flatMap((stored) =>
        stored
          ? Effect.logInfo(`cache: ${opts.key} is already stored — skipping pack and upload`)
          : pack(opts),
      ),
    );

/**
 * The pure `restoreOr` orchestration, factored out of any binding so it is
 * unit-testable with fake `restore` / `save`. Best-effort by construction:
 *
 *   - on a `hit`, `onMiss` is skipped and the Effect completes with `void`;
 *   - on a `miss`, `onMiss` runs, then `save` runs and a save failure does not
 *     fail the Effect — the `onMiss` work already succeeded;
 *   - on `unapplied`, `onMiss` runs and the save is skipped: the stored
 *     archive already holds this key's content;
 *   - a restore error is degraded to a miss — whether an archive is stored is
 *     unknown, and the save's existence check covers the case where it is.
 *
 * Never silent, though: restore and save failures and a skipped save are
 * logged. A discarded save is otherwise indistinguishable from a working cache.
 *
 * Returns `void`: on a cache hit there is no `onMiss` value, so `restoreOr`
 * cannot honestly yield an `A`. Consumers (`installCached`) discard it anyway.
 */
export const composeRestoreOr =
  (restore: RestoreFn, save: SaveFn) =>
  <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    dir?: string;
    base?: string;
    onMiss: () => Effect.Effect<A, E, R>;
  }): Effect.Effect<void, E | CacheError, R> =>
    restore(opts).pipe(
      Effect.catchAll((e) => Effect.as(Effect.logWarning(e.message), "miss" as const)),
      Effect.flatMap((outcome) =>
        Match.value(outcome).pipe(
          Match.when("hit", () => Effect.void),
          Match.when("miss", () =>
            opts.onMiss().pipe(
              Effect.tap(() =>
                save(opts).pipe(Effect.catchAll((e) => Effect.logWarning(e.message))),
              ),
              Effect.asVoid,
            ),
          ),
          Match.when("unapplied", () =>
            opts.onMiss().pipe(
              Effect.tap(() =>
                Effect.logInfo(`cache: ${opts.key} is stored but unapplied — skipping save`),
              ),
              Effect.asVoid,
            ),
          ),
          Match.exhaustive,
        ),
      ),
    );
