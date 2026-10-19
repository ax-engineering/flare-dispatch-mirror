// @fractalboxdev/flare-dispatch-runtime-cf — D1-backed run admission semaphore (issue #109).
//
// Meters in-flight runs to the container pool's capacity. A merge burst can
// create more concurrent RunWorkflow instances than `RunSandbox` /
// `RunSandboxBrowser` have instances (`max_instances: 16` each); the excess
// runs fail `ContainerLaunchFailed` / `PortNeverOpened`, burn step-retry
// budgets, and post red checks indistinguishable from test failures. Before
// its body starts (and before the per-container-id lease), every run
// enqueues a `run_admissions` row and polls an atomic FIFO claim until a
// slot in its pool frees.
//
// D1 is the store for the same reason as `container-lease-d1.ts`: D1 is
// single-threaded per database, so ONE conditional UPDATE is a real atomic
// claim — two racing claimers cannot both count under the cap. This is the
// #91 per-key mutex generalized to a per-pool counting semaphore (cap = 16)
// plus FIFO ordering and a COUNT-based queue position. Same `executions` D1
// binding; one new table, zero new wrangler config.
//
// Unlike the lease store, the poll loop does NOT live here: the dispatcher's
// `RunWorkflow` drives it through durable `step.do` / `step.sleep` calls (so
// a queued run hibernates for free and survives eviction), calling `attempt`
// once per iteration and the PURE `decideAdmission`
// (`@fractalboxdev/flare-dispatch-core` run-admission.ts, unit-tested) on what it observed.
// This module is the I/O shell — the atomic SQL.
//
// Spec: ADR #109 (global D1-backed run admission semaphore).

import { Effect, Schedule } from "effect";
import type { AdmissionObservation, AdmissionPool } from "@fractalboxdev/flare-dispatch-core";
import { LEASE_TTL_MS } from "./container-lease-d1";

/**
 * Default admission slots per pool — matches each container class's
 * `max_instances: 16` in wrangler.jsonc, so admitted runs never exceed the
 * containers that can serve them. The live cap comes from the plain
 * `ADMISSION_CAP` wrangler var (see {@link resolveAdmissionCap}); this is
 * the fallback when the var is unset.
 */
export const ADMISSION_CAP_DEFAULT = 16;

/**
 * Parse the `ADMISSION_CAP` wrangler var (vars are always strings) into the
 * per-pool slot cap. Operators tune it alongside `max_instances` in
 * wrangler.jsonc — possibly slightly below it for slot-turnover headroom.
 * Absent / unparsable / non-positive → {@link ADMISSION_CAP_DEFAULT}: a typo
 * must degrade to the safe default, never to an unmetered (or zero-slot,
 * everything-times-out) pool.
 */
export const resolveAdmissionCap = (raw: string | undefined): number => {
  if (raw === undefined) return ADMISSION_CAP_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : ADMISSION_CAP_DEFAULT;
};

/**
 * The release pool's slot cap when `ADMISSION_CAP_RELEASE` is unset — the
 * `RunSandboxRelease` container's `max_instances: 8` in wrangler.jsonc. Under
 * the shared cap of 16, two concurrent releases admit 16 cells onto 8
 * containers and the excess fail `ContainerLaunchFailed`.
 */
export const RELEASE_ADMISSION_CAP_DEFAULT = 8;

/**
 * The agent pool's slot cap when `ADMISSION_CAP_AGENT` is unset — the
 * `RunSandboxAgent` container's `max_instances: 8` in wrangler.jsonc.
 */
export const AGENT_ADMISSION_CAP_DEFAULT = 8;

/** The admission vars a pool's cap reads. */
export type AdmissionCapVars = {
  readonly ADMISSION_CAP?: string;
  readonly ADMISSION_CAP_AGENT?: string;
  readonly ADMISSION_CAP_RELEASE?: string;
};

/**
 * The slot cap for one pool. `ADMISSION_CAP` bounds every pool; the agent and
 * release pools, whose containers are fewer, are further bounded by
 * `ADMISSION_CAP_AGENT` and `ADMISSION_CAP_RELEASE` (defaults
 * {@link AGENT_ADMISSION_CAP_DEFAULT}, {@link RELEASE_ADMISSION_CAP_DEFAULT}),
 * so their cap is the smaller of the two. Lean and browser keep
 * `ADMISSION_CAP` alone. Garbage degrades to the default, as in
 * {@link resolveAdmissionCap}.
 */
export const resolvePoolAdmissionCap = (pool: AdmissionPool, vars: AdmissionCapVars): number => {
  const shared = resolveAdmissionCap(vars.ADMISSION_CAP);
  const own = pool === "release" ? { raw: vars.ADMISSION_CAP_RELEASE, fallback: RELEASE_ADMISSION_CAP_DEFAULT }
    : pool === "agent" ? { raw: vars.ADMISSION_CAP_AGENT, fallback: AGENT_ADMISSION_CAP_DEFAULT }
    : undefined;
  if (own === undefined) return shared;
  const parsed = own.raw === undefined ? NaN : Number.parseInt(own.raw, 10);
  return Math.min(shared, Number.isInteger(parsed) && parsed > 0 ? parsed : own.fallback);
};

/**
 * Delay between claim attempts while the pool is full. Each wait is a
 * durable `step.sleep`, so a queued run costs nothing while it waits; 20s
 * keeps the loop ≤270 claim steps + 270 sleeps over the largest run override
 * — trivial against the 10k Workflow step cap (#83 precedent).
 */
export const ADMISSION_POLL_EVERY_MS = 20_000;

/**
 * Dispatch-age ceiling — a run queued longer than this fails
 * `AdmissionTimedOut` instead of hanging toward the Workflow wall-clock cap.
 * The default applies to ordinary runs; matrix runs can declare a longer
 * bound in their reviewed run definition.
 */
export const ADMISSION_MAX_QUEUE_AGE_MS = 20 * 60_000;

/**
 * Heartbeat staleness ceiling for ADMITTED rows — shared with the container
 * lease (`LEASE_TTL_MS`) by design: both are refreshed by the same heartbeat
 * fiber in `RunWorkflow`, so one TTL means one liveness story. An admitted
 * row whose heartbeat is older stops counting toward the pool (the holding
 * Worker was evicted / the run crashed) — a slot can never leak forever.
 */
export const ADMISSION_TTL_MS = LEASE_TTL_MS;

/**
 * Heartbeat staleness ceiling for QUEUED rows. A waiter refreshes its
 * heartbeat on every claim attempt (every `ADMISSION_POLL_EVERY_MS`), so a
 * row silent for ~5 polls is a dead waiter — excluded from the FIFO no-barge
 * check and the position count, so a corpse never blocks the line.
 */
export const ADMISSION_WAITER_TTL_MS = 100_000;

/**
 * One D1 statement, retried twice on a transient error then surfaced — the
 * same resilience shape as `container-lease-d1.ts`: an admission read/write
 * is a single fast query; a flaky D1 call should not collapse the attempt.
 */
const d1 = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.retry(Schedule.recurs(2).pipe(Schedule.addDelay(() => "200 millis"))));

export interface RunAdmissionStore {
  /**
   * Enqueue this execution into its pool's FIFO line (`state='queued'`).
   * Idempotent (`INSERT OR IGNORE`) and returns the row's `enqueued_at` — on
   * a Workflow replay the original timestamp comes back, never a fresh clock
   * read, so the FIFO key and the dispatch-age basis are stable.
   *
   * When `parentExecutionId` is given and the parent holds an admission row,
   * the child inherits the PARENT's `enqueued_at` as its FIFO key. This is
   * the matrix-children mitigation (ADR #109 note 2): a fan-out parent holds
   * its slot while `waitForChildren` blocks on children who would otherwise
   * queue behind OTHER parents — a starvation shape. Inheriting the parent's
   * priority lets children jump to their parent's place in line and drain it.
   */
  readonly enqueue: (
    executionId: string,
    pool: AdmissionPool,
    parentExecutionId?: string,
  ) => Effect.Effect<{ readonly enqueuedAt: number }, Error>;

  /**
   * One claim attempt: try the atomic FIFO claim; when it does not land,
   * refresh our waiter heartbeat and read our queue position + the pool's
   * busy count. Returns the observation (+ the clock it was taken at) for
   * the pure `decideAdmission` — the caller runs the whole attempt inside
   * one durable `step.do`, so everything here is checkpointed together.
   */
  readonly attempt: (
    executionId: string,
    pool: AdmissionPool,
    enqueuedAt: number,
  ) => Effect.Effect<AdmissionObservation & { readonly now: number }, Error>;

  /** Refresh the holder's heartbeat so the admitted slot is never reclaimed. */
  readonly heartbeat: (executionId: string) => Effect.Effect<void, Error>;

  /**
   * Release our slot (DELETE own row — idempotent) and opportunistically GC
   * rows whose heartbeat staled past the admitted TTL: corpses are purged by
   * the next releaser, no cron sweeper needed.
   */
  readonly release: (executionId: string) => Effect.Effect<void, Error>;
}

/**
 * Build a D1-backed run admission store. `now` is injectable so tests can
 * drive the clock; production passes `Date.now` (always read inside the
 * caller's `step.do`, so replays see the checkpointed value). `cap` is the
 * per-pool slot ceiling — the dispatcher resolves it from the
 * `ADMISSION_CAP` wrangler var via {@link resolveAdmissionCap}.
 */
export const makeRunAdmissionD1 = (
  db: D1Database,
  now: () => number = Date.now,
  cap: number = ADMISSION_CAP_DEFAULT,
): RunAdmissionStore => {
  const insertQueued = (
    executionId: string,
    pool: AdmissionPool,
    enqueuedAt: number | undefined,
    parentExecutionId: string | undefined,
    ts: number,
  ): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(
          // `enqueued_at` resolution order: an explicit re-insert value (a
          // GC'd waiter row restored mid-loop keeps its original FIFO key) →
          // the parent's row (matrix-children priority inheritance) → now.
          `INSERT OR IGNORE INTO run_admissions
             (execution_id, pool, state, enqueued_at, heartbeat_at)
           VALUES (?1, ?2, 'queued',
                   COALESCE(?3,
                            (SELECT enqueued_at FROM run_admissions
                              WHERE execution_id = ?4),
                            ?5),
                   ?5)`,
        )
        .bind(executionId, pool, enqueuedAt ?? null, parentExecutionId ?? null, ts)
        .run(),
    ).pipe(Effect.asVoid);

  const enqueue = (
    executionId: string,
    pool: AdmissionPool,
    parentExecutionId?: string,
  ): Effect.Effect<{ readonly enqueuedAt: number }, Error> =>
    Effect.gen(function* () {
      const ts = now();
      yield* insertQueued(executionId, pool, undefined, parentExecutionId, ts);
      // Read the FIFO key back — on a duplicate (replay) the EXISTING row's
      // `enqueued_at` wins, keeping the key stable across checkpoint resumes.
      const row = yield* d1(() =>
        db
          .prepare(`SELECT enqueued_at FROM run_admissions WHERE execution_id = ?`)
          .bind(executionId)
          .first<{ enqueued_at: number }>(),
      );
      return { enqueuedAt: row?.enqueued_at ?? ts };
    });

  /**
   * The atomic FIFO claim — ONE statement, serialized by D1, so two racing
   * claimers cannot both count under the cap:
   *
   *   - the COUNT subquery admits only while LIVE admitted rows in our pool
   *     are below the cap (stale heartbeats stop counting — a crashed run's
   *     slot frees itself after the TTL);
   *   - the NOT EXISTS is the no-barge FIFO check among LIVE waiters: nobody
   *     with an earlier `enqueued_at` (execution-id ULID as the tiebreak) may
   *     be skipped, but a waiter silent past `ADMISSION_WAITER_TTL_MS` no
   *     longer blocks the line.
   *
   * `meta.changes === 1` ⇒ our row flipped to 'admitted' — we hold a slot.
   */
  const tryClaim = (
    executionId: string,
    pool: AdmissionPool,
    enqueuedAt: number,
    ts: number,
  ): Effect.Effect<boolean, Error> =>
    d1(() =>
      db
        .prepare(
          `UPDATE run_admissions SET state='admitted', admitted_at=?2, heartbeat_at=?2
           WHERE execution_id = ?1 AND state = 'queued'
             AND (SELECT COUNT(*) FROM run_admissions
                   WHERE pool = ?3 AND state = 'admitted' AND heartbeat_at > ?4) < ?5
             AND NOT EXISTS (SELECT 1 FROM run_admissions o
                   WHERE o.pool = ?3 AND o.state = 'queued'
                     AND o.heartbeat_at > ?6
                     AND (o.enqueued_at < ?7
                          OR (o.enqueued_at = ?7 AND o.execution_id < ?1)))`,
        )
        .bind(
          executionId,
          ts,
          pool,
          ts - ADMISSION_TTL_MS,
          cap,
          ts - ADMISSION_WAITER_TTL_MS,
          enqueuedAt,
        )
        .run(),
    ).pipe(Effect.map((result) => result.meta.changes === 1));

  const attempt = (
    executionId: string,
    pool: AdmissionPool,
    enqueuedAt: number,
  ): Effect.Effect<AdmissionObservation & { readonly now: number }, Error> =>
    Effect.gen(function* () {
      const ts = now();
      // Re-entrant short-circuit (the lease's `held` branch): a Worker that
      // died after the claim UPDATE landed but before the step checkpointed
      // replays this attempt with its row ALREADY 'admitted' — `tryClaim`
      // (which flips 'queued' rows only) would never succeed again and the
      // run would time out while holding a slot. Refresh + proceed instead.
      const own = yield* d1(() =>
        db
          .prepare(`SELECT state FROM run_admissions WHERE execution_id = ?`)
          .bind(executionId)
          .first<{ state: string }>(),
      );
      if (own?.state === "admitted") {
        yield* heartbeat(executionId);
        return { admitted: true, position: 0, poolBusy: 0, now: ts };
      }
      // Self-heal: a waiter paused past the admitted TTL has had its row
      // GC'd by a peer's release — re-insert it (original FIFO key) so the
      // claim below has a row to flip. No-op in the common case.
      if (own === null) {
        yield* insertQueued(executionId, pool, enqueuedAt, undefined, ts);
      }
      const claimed = yield* tryClaim(executionId, pool, enqueuedAt, ts);
      if (claimed) return { admitted: true, position: 0, poolBusy: 0, now: ts };

      // Not admitted: refresh our waiter heartbeat (so we keep blocking
      // bargers and counting in peers' position reads), then observe where
      // we stand — live queued rows ahead of us + live admitted rows.
      yield* heartbeat(executionId);
      const counts = yield* d1(() =>
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM run_admissions
                 WHERE pool = ?1 AND state = 'queued'
                   AND heartbeat_at > ?2
                   AND (enqueued_at < ?3
                        OR (enqueued_at = ?3 AND execution_id < ?4))) AS position,
               (SELECT COUNT(*) FROM run_admissions
                 WHERE pool = ?1 AND state = 'admitted'
                   AND heartbeat_at > ?5) AS busy`,
          )
          .bind(pool, ts - ADMISSION_WAITER_TTL_MS, enqueuedAt, executionId, ts - ADMISSION_TTL_MS)
          .first<{ position: number; busy: number }>(),
      );
      return {
        admitted: false,
        position: counts?.position ?? 0,
        poolBusy: counts?.busy ?? 0,
        now: ts,
      };
    });

  const heartbeat = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(`UPDATE run_admissions SET heartbeat_at = ? WHERE execution_id = ?`)
        .bind(now(), executionId)
        .run(),
    ).pipe(Effect.asVoid);

  const release = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db.batch([
        db.prepare(`DELETE FROM run_admissions WHERE execution_id = ?`).bind(executionId),
        // Opportunistic GC: purge rows (any state) whose heartbeat staled
        // past the admitted TTL. Stale rows already stopped counting; this
        // just keeps the table from accumulating corpses.
        db
          .prepare(`DELETE FROM run_admissions WHERE heartbeat_at < ?`)
          .bind(now() - ADMISSION_TTL_MS),
      ]),
    ).pipe(Effect.asVoid);

  return { enqueue, attempt, heartbeat, release };
};
