// FlareDispatch Dispatcher — why a container stopped.
//
// A run whose container dies reports `ExecFailed: exec failed (exit -1):
// internal error` and nothing about the container itself. Every explanation
// offered for that class of failure — memory, disk, wall clock — has been
// measured and ruled out on the consumer that motivated it, which leaves a
// question only the platform can answer.
//
// The platform does answer it, one layer below where anyone was looking.
// `@cloudflare/containers` parses the runtime's own message — `runtime
// signalled the container to exit: <n>`, or `container exited with unexpected
// exit code: <n>` — into the `exitCode` it hands `onStop`. A container the
// kernel or the platform killed carries a signal there; one that ran to
// completion carries 0.
//
// `reason` is NOT the discriminator, despite its type. `StopParams.reason` is
// declared `'exit' | 'runtime_signal'`, but `runtime_signal` appears nowhere in
// `@cloudflare/containers@0.3.7` outside that declaration — every `callOnStop`
// site passes `'exit'`.
//
// Two things a reader of these records has to know, both properties of the SDK
// rather than of this file:
//
//   * A `0` is not proof of a clean exit. `syncPendingStoppedEvents` hardcodes
//     `exitCode: 0` when the container is gone but the DO state still reads
//     `healthy` (container.js:1596), which is a value the SDK invented — and is
//     the shape an unexplained death takes.
//   * ABSENCE of a record is not proof the container survived. When
//     `getExitCodeFromError` cannot parse the runtime's message it calls
//     `setStopped()` (container.js:1447, :1463), a status that matches neither
//     branch of `syncPendingStoppedEvents`, so `callOnStop` is never reached
//     and nothing is written.
//
// Kept in its own module, free of the Sandbox SDK import, so it is testable
// outside the workers pool.
//
// CONTAINER PATH ONLY. `apps/substrate/src/sandbox-do.ts` overrides `onStop`
// too and records no exit code, so every run that moves when
// `SUBSTRATE_BACKEND` flips to "on" loses this — silently, since nothing fails.
// Porting it is a prerequisite of the stage-2 cutover, not of this change.
//
// EXPIRY IS A DEPLOY STEP. Nothing in the Worker prunes `container-stops/` and
// no route reads it; an R2 lifecycle rule on the deploying account's bucket is
// the only expiry. Volume is bounded by the `requested` filter below — a
// healthy run writes nothing — but that is a bound, not an expiry. Every
// deploy that leaves `CONTAINER_STOP_RECORDS` on runs, once per bucket:
//
//   wrangler r2 bucket lifecycle add <RUNS_STORAGE bucket> \
//     --name expire-container-stops --prefix container-stops/ --expire-days 90

/**
 * What the Container base class passes `onStop`. Both fields are optional here
 * because the SDK's own `onStop` is declared with no parameters at all, so what
 * arrives at runtime is wider than what the types promise.
 */
export type StopParamsLike = { exitCode?: number; reason?: string };

/**
 * Ceiling on the R2 write. `callOnStop` awaits `onStop` and only then writes
 * the DO's stopped state, so an unbounded put would leave the state reading
 * `healthy` while the container is already gone.
 */
const STOP_WRITE_TIMEOUT_MS = 2000;

/**
 * The off switch. `CONTAINER_STOP_RECORDS: "off"` in the dispatcher's `vars`
 * stops the durable writes; the log line is unaffected.
 *
 * It does NOT avoid a deploy — a `vars` change is still `wrangler deploy`, and
 * the deploy that carries these classes rebuilds three container images either
 * way. What it buys is a reviewed one-line config change instead of a code
 * revert, and a switch someone can find by grepping. Same shape as
 * `SUBSTRATE_BACKEND`.
 */
export const stopRecordsEnabled = (flag: string | undefined): boolean => flag !== "off";

/** One stop record, as persisted. */
export type ContainerStopRecord = {
  readonly sandbox: string;
  readonly exitCode: number | null;
  readonly reason: string | null;
  /** Did this deploy ask for the stop (`destroy()`), or did it just happen? */
  readonly requested: boolean;
  readonly observedAt: string;
};

/**
 * Which stops are worth an object.
 *
 * NOT `exitCode !== 0`, which is the trap. `syncPendingStoppedEvents` hardcodes
 * `{ exitCode: 0 }` when the container is gone but the state still reads
 * `healthy` (@cloudflare/containers container.js:1596) — a value the SDK
 * invented, not one the platform reported, and precisely the shape of the
 * unexplained death this exists to catch. Filtering on the code would have
 * thrown away the only records that matter.
 *
 * So the discriminator is whether WE asked. `workflow.ts` calls `destroy()` on
 * every run through an `Effect.ensuring`, success or failure alike, and those
 * teardowns are the volume. Everything else is a stop nobody requested, which
 * is worth an object whatever number rides along.
 *
 * Two limits on reading `requested`, both worth knowing before trusting it:
 *
 *   * `true` is reliable, `false` is best-effort. The flag lives on the DO
 *     instance, and `destroy()` does not call `onStop` inline — the alarm loop
 *     delivers it later. An instance evicted in between reports a teardown we
 *     asked for as one we did not. It fails toward recording MORE, never toward
 *     hiding a death.
 *   * An idle timeout is correctly `false` and is not routine volume.
 *     `onActivityExpired` returns early unless the container is still running
 *     (container.js:748), and the finalize `destroy()` has normally already
 *     stopped it — so this fires only where finalize was skipped, which is a
 *     Worker eviction or a deploy mid-run, and is worth seeing.
 */
export const isStopWorthRecording = (requested: boolean): boolean => !requested;

/**
 * Read the "we asked for this" intent and consume it, one shot.
 *
 * `destroy()` does not reach `onStop` inline — the alarm loop delivers it
 * later — so the intent has to survive that gap and then stop surviving. Left
 * set, it would swallow every subsequent stop the same instance sees, including
 * a genuine death following a `destroy()` that threw.
 *
 * Extracted so the property is pinned by a test rather than by reading three
 * lines of a Durable Object that cannot be constructed outside the workers pool.
 */
export const takeRequested = (holder: { requested: boolean }): boolean => {
  const requested = holder.requested;
  holder.requested = false;
  return requested;
};

/**
 * Keys are addressable FORWARD, which is the direction that matters.
 *
 * The sandbox name is `previewSafeSandboxId(executionId)`, which is lossy — it
 * truncates and appends a digest above 40 chars, so a name cannot be reversed
 * to an execution. It is deterministic though, so anything holding an execution
 * id can compute the prefix and find that run's stops. Do not try to go the
 * other way.
 *
 * The name is restricted rather than trusted: a `/` in it would silently nest
 * objects outside the intended prefix.
 */
export const containerStopKey = (sandbox: string, now: number): string =>
  `container-stops/${sandbox.replace(/[^A-Za-z0-9._-]/g, "_")}/${now}.json`;

export const containerStopRecord = (
  sandbox: string,
  params: StopParamsLike | undefined,
  now: number,
  requested: boolean,
): ContainerStopRecord => ({
  sandbox,
  requested,
  // `null`, never absent: "the platform told us nothing" and "we did not look"
  // must not render the same way to whoever reads these next.
  exitCode: params?.exitCode ?? null,
  reason: params?.reason ?? null,
  // When the stop was OBSERVED, not when the container died. `onStop` arrives
  // from the alarm loop, which can be a tick or a restart later than the event
  // it reports (container.js:606 drains pending stopped events on the next
  // start). Close enough to correlate a run against; not a precise time of
  // death.
  observedAt: new Date(now).toISOString(),
});

/**
 * Persist the record, best-effort.
 *
 * This runs while the container is going away. A write that throws here would
 * replace a stop we can explain with one we cannot, so the failure is caught —
 * but LOGGED, because a silent no-op is indistinguishable from a deploy where
 * the record never worked at all.
 */
export const recordContainerStop = async (
  bucket: R2Bucket,
  sandbox: string,
  params: StopParamsLike | undefined,
  now: number,
  requested: boolean,
  flag?: string,
): Promise<void> => {
  const line = JSON.stringify(containerStopRecord(sandbox, params, now, requested));
  // Every stop is logged; only the ones nobody asked for are stored.
  console.log(`sandbox.stop ${line}`);
  if (!stopRecordsEnabled(flag) || !isStopWorthRecording(requested)) return;
  try {
    // Bounded, because this runs while the container is going away and the base
    // class's teardown is waiting on it. R2 being slow must not hold a stop
    // open — the log line above has already carried the record.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bucket.put(containerStopKey(sandbox, now), `${line}\n`, {
          httpMetadata: { contentType: "application/json" },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out after 2s")), STOP_WRITE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      // Cleared rather than left armed: this runs inside the alarm handler, and
      // a stray pending timer there outlives the work it was bounding.
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (cause) {
    console.warn(
      `sandbox.stop: could not persist stop record for ${sandbox} — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};
