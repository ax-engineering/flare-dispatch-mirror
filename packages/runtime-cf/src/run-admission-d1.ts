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
import {
  ADMISSION_CLASS_DEFAULT,
  ADMISSION_POLL_MAX_MS,
  ADMISSION_POLL_MIN_MS,
  type AdmissionClass,
  type AdmissionObservation,
  type AdmissionPool,
  fitsBurnCeiling,
} from "@fractalboxdev/flare-dispatch-core";
import { LEASE_TTL_MS } from "./container-lease-d1";

/**
 * The spend-guard burn ceiling one claimant admits under (ADR-0006 § Burn
 * ceiling): its own container class's list rate per hour, and the ceiling on
 * the summed rate of every admitted row across all pools (`null` = unlimited).
 */
export type BurnCeiling = {
  readonly hourlyRateMicroUsd: number;
  readonly burnMaxMicroUsdPerHour: number | null;
};

/** No ceiling, no rate — the store as it behaves without a spend guard. */
export const BURN_UNLIMITED: BurnCeiling = { hourlyRateMicroUsd: 0, burnMaxMicroUsdPerHour: null };

/**
 * Default admission slots per pool — matches each container class's
 * `max_instances: 16` in wrangler.jsonc, so admitted runs never exceed the
 * containers that can serve them. The live cap comes from the plain
 * `ADMISSION_CAP` wrangler var (see {@link resolveAdmissionCap}); this is
 * the fallback when the var is unset.
 */
export const ADMISSION_CAP_DEFAULT = 48;

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

/**
 * The browser pool's slot cap when `ADMISSION_CAP_BROWSER` is unset — the
 * `RunSandboxBrowser` container's `max_instances: 16` in wrangler.jsonc.
 */
export const BROWSER_ADMISSION_CAP_DEFAULT = 16;

/** The admission vars a pool's cap reads. */
export type AdmissionCapVars = {
  readonly ADMISSION_CAP?: string;
  readonly ADMISSION_CAP_AGENT?: string;
  readonly ADMISSION_CAP_BROWSER?: string;
  readonly ADMISSION_CAP_RELEASE?: string;
};

/**
 * The slot cap for one pool — an upper bound; the spend guard's burn ceiling
 * sets the operating concurrency (ADR-0009 § Pools sized under the spend
 * guard). `ADMISSION_CAP` bounds every pool; the agent, browser and release
 * pools are further bounded by `ADMISSION_CAP_AGENT`, `ADMISSION_CAP_BROWSER`
 * and `ADMISSION_CAP_RELEASE` (defaults {@link AGENT_ADMISSION_CAP_DEFAULT},
 * {@link BROWSER_ADMISSION_CAP_DEFAULT}, {@link RELEASE_ADMISSION_CAP_DEFAULT}),
 * so their cap is the smaller of the two. Lean keeps `ADMISSION_CAP` alone.
 * Garbage degrades to the default, as in {@link resolveAdmissionCap}.
 */
export const resolvePoolAdmissionCap = (pool: AdmissionPool, vars: AdmissionCapVars): number => {
  const shared = resolveAdmissionCap(vars.ADMISSION_CAP);
  const own = pool === "release" ? { raw: vars.ADMISSION_CAP_RELEASE, fallback: RELEASE_ADMISSION_CAP_DEFAULT }
    : pool === "agent" ? { raw: vars.ADMISSION_CAP_AGENT, fallback: AGENT_ADMISSION_CAP_DEFAULT }
    : pool === "browser" ? { raw: vars.ADMISSION_CAP_BROWSER, fallback: BROWSER_ADMISSION_CAP_DEFAULT }
    : undefined;
  if (own === undefined) return shared;
  const parsed = own.raw === undefined ? NaN : Number.parseInt(own.raw, 10);
  return Math.min(shared, Number.isInteger(parsed) && parsed > 0 ? parsed : own.fallback);
};

/**
 * The shortest delay between claim attempts — the head of the queue's poll.
 * A waiter further back sleeps up to {@link ADMISSION_POLL_MAX_MS}
 * (`admissionPollSleepMs`, core run-admission.ts). Each wait is a durable
 * `step.sleep`, so a queued run costs nothing while it waits. The attempt
 * count is derived from this shortest sleep, so one attempt costs three steps
 * (spend check, claim, sleep): the largest run override (6 h) bounds the loop
 * at 1,080 attempts, 3,240 steps, under the 10k Workflow step cap (#83
 * precedent); a waiter several slots back polls up to three times less often.
 */
export const ADMISSION_POLL_EVERY_MS = ADMISSION_POLL_MIN_MS;

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
 * heartbeat on every claim attempt, at most {@link ADMISSION_POLL_MAX_MS}
 * apart, so a row silent for three of the longest sleeps is a dead waiter —
 * excluded from the FIFO no-barge check and the position count, so a corpse
 * never blocks the line. A slow-polling live waiter never reads as dead
 * (ADR-0008 § Position-scaled admission polls).
 */
export const ADMISSION_WAITER_TTL_MS = 3 * ADMISSION_POLL_MAX_MS;

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
   * refresh our waiter heartbeat and read our queue position, the pool's
   * busy count, and whether the burn ceiling (not the cap) held us back. A
   * landed claim also stamps `executions.admitted_at` — the start of the
   * container-active window the meter prices. Returns the observation (+ the clock it was taken at) for
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
 * The rank of a class in the FIFO line: interactive (0) ahead of batch (1). A
 * row with no class (pre-0011) ranks as batch. The SQL computes the same rank
 * from `run_admissions.admission_class` with {@link CLASS_RANK_SQL}.
 */
const classRank = (admissionClass: AdmissionClass): number => (admissionClass === "interactive" ? 0 : 1);
const CLASS_RANK_SQL = (alias: string): string =>
  `(CASE WHEN ${alias}admission_class = 'interactive' THEN 0 ELSE 1 END)`;

/**
 * Build a D1-backed run admission store. `now` is injectable so tests can
 * drive the clock; production passes `Date.now` (always read inside the
 * caller's `step.do`, so replays see the checkpointed value). `cap` is the
 * per-pool slot ceiling — the dispatcher resolves it from the
 * `ADMISSION_CAP` wrangler var via {@link resolveAdmissionCap}. `burn` is
 * this claimant's hourly rate and the deploy's burn ceiling; the default
 * {@link BURN_UNLIMITED} admits on the cap alone. `admissionClass` is the
 * claimant's line: interactive waiters are admitted ahead of batch ones.
 */
export const makeRunAdmissionD1 = (
  db: D1Database,
  now: () => number = Date.now,
  cap: number = ADMISSION_CAP_DEFAULT,
  burn: BurnCeiling = BURN_UNLIMITED,
  admissionClass: AdmissionClass = ADMISSION_CLASS_DEFAULT,
): RunAdmissionStore => {
  const rank = classRank(admissionClass);
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
             (execution_id, pool, state, enqueued_at, heartbeat_at, hourly_rate_micro_usd,
              admission_class)
           VALUES (?1, ?2, 'queued',
                   COALESCE(?3,
                            (SELECT enqueued_at FROM run_admissions
                              WHERE execution_id = ?4),
                            ?5),
                   ?5, ?6, ?7)`,
        )
        .bind(
          executionId,
          pool,
          enqueuedAt ?? null,
          parentExecutionId ?? null,
          ts,
          burn.hourlyRateMicroUsd,
          admissionClass,
        )
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
   *     ahead of us may be skipped. "Ahead" is a live waiter of a higher
   *     class (interactive ahead of batch), or of our class with an earlier
   *     `enqueued_at` (execution-id ULID as the tiebreak). A waiter silent
   *     past `ADMISSION_WAITER_TTL_MS` no longer blocks the line;
   *   - the burn-ceiling clause admits only while the hourly rates of LIVE
   *     admitted rows in EVERY pool, plus ours, fit under the ceiling. An
   *     empty admitted set admits anyone, so a claimant whose own rate
   *     exceeds the ceiling runs alone rather than waiting forever; a NULL
   *     ceiling disables the clause. `fitsBurnCeiling` (core spend.ts) is its
   *     pure mirror. The ceiling never reorders the line: a batch claimant
   *     whose lower rate would fit still waits behind a live interactive
   *     waiter the ceiling holds.
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
                     AND (${CLASS_RANK_SQL("o.")} < ?10
                          OR (${CLASS_RANK_SQL("o.")} = ?10
                              AND (o.enqueued_at < ?7
                                   OR (o.enqueued_at = ?7 AND o.execution_id < ?1)))))
             AND (?8 IS NULL
                  OR NOT EXISTS (SELECT 1 FROM run_admissions
                        WHERE state = 'admitted' AND heartbeat_at > ?4)
                  OR (SELECT COALESCE(SUM(hourly_rate_micro_usd), 0) FROM run_admissions
                        WHERE state = 'admitted' AND heartbeat_at > ?4) + ?9 <= ?8)`,
        )
        .bind(
          executionId,
          ts,
          pool,
          ts - ADMISSION_TTL_MS,
          cap,
          ts - ADMISSION_WAITER_TTL_MS,
          enqueuedAt,
          burn.burnMaxMicroUsdPerHour,
          burn.hourlyRateMicroUsd,
          rank,
        )
        .run(),
    ).pipe(Effect.map((result) => result.meta.changes === 1));

  // Stamp the start of the container-active window on the execution row from
  // our admitted row. COALESCE keeps the first stamp across a replay.
  const markAdmitted = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(
          `UPDATE executions
              SET admitted_at = COALESCE(admitted_at,
                    (SELECT admitted_at FROM run_admissions WHERE execution_id = ?1))
            WHERE id = ?1`,
        )
        .bind(executionId)
        .run(),
    ).pipe(Effect.asVoid);

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
        yield* markAdmitted(executionId);
        return { admitted: true, position: 0, poolBusy: 0, now: ts };
      }
      // Self-heal: a waiter paused past the admitted TTL has had its row
      // GC'd by a peer's release — re-insert it (original FIFO key) so the
      // claim below has a row to flip. No-op in the common case.
      if (own === null) {
        yield* insertQueued(executionId, pool, enqueuedAt, undefined, ts);
      }
      const claimed = yield* tryClaim(executionId, pool, enqueuedAt, ts);
      if (claimed) {
        yield* markAdmitted(executionId);
        return { admitted: true, position: 0, poolBusy: 0, now: ts };
      }

      // Not admitted: refresh our waiter heartbeat (so we keep blocking
      // bargers and counting in peers' position reads), then observe where
      // we stand — live queued rows ahead of us (higher class, or our class
      // and earlier), live admitted rows in our pool, and the live admitted
      // burn across every pool.
      yield* heartbeat(executionId);
      const counts = yield* d1(() =>
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM run_admissions
                 WHERE pool = ?1 AND state = 'queued'
                   AND heartbeat_at > ?2
                   AND (${CLASS_RANK_SQL("")} < ?6
                        OR (${CLASS_RANK_SQL("")} = ?6
                            AND (enqueued_at < ?3
                                 OR (enqueued_at = ?3 AND execution_id < ?4))))) AS position,
               (SELECT COUNT(*) FROM run_admissions
                 WHERE pool = ?1 AND state = 'admitted'
                   AND heartbeat_at > ?5) AS busy,
               (SELECT COUNT(*) FROM run_admissions
                 WHERE state = 'admitted' AND heartbeat_at > ?5) AS admitted_count,
               (SELECT COALESCE(SUM(hourly_rate_micro_usd), 0) FROM run_admissions
                 WHERE state = 'admitted' AND heartbeat_at > ?5) AS admitted_rate`,
          )
          .bind(pool, ts - ADMISSION_WAITER_TTL_MS, enqueuedAt, executionId, ts - ADMISSION_TTL_MS, rank)
          .first<{ position: number; busy: number; admitted_count: number; admitted_rate: number }>(),
      );
      const poolBusy = counts?.busy ?? 0;
      // The ceiling held us when our pool had a free slot but the burn did not
      // fit. A full pool is the cap's hold, whatever the burn.
      const ceilingHeld =
        poolBusy < cap &&
        !fitsBurnCeiling({
          admittedMicroUsdPerHour: counts?.admitted_rate ?? 0,
          admittedCount: counts?.admitted_count ?? 0,
          ownMicroUsdPerHour: burn.hourlyRateMicroUsd,
          burnMaxMicroUsdPerHour: burn.burnMaxMicroUsdPerHour,
        });
      return {
        admitted: false,
        position: counts?.position ?? 0,
        poolBusy,
        ...(ceilingHeld ? { ceilingHeld } : {}),
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
