// @fractalboxdev/flare-dispatch-core — run-admission: the pure admission decision logic.
//
// A merge burst can create more concurrent run executions than the container
// pool has instances (`max_instances: 16` per class). Without a gate the
// excess runs boot anyway, fail `ContainerLaunchFailed` / `PortNeverOpened`,
// and post red checks indistinguishable from test failures. The runtime
// therefore meters runs through a global, per-pool counting semaphore: every
// run enqueues before its body starts, polls an atomic FIFO claim until a
// slot frees, and times out loudly once it has queued longer than the
// dispatch-age ceiling.
//
// This module holds ONLY the pure decision: given what one claim attempt
// observed (did the atomic claim land? how many live waiters are ahead? how
// many slots are busy?), the row's enqueue time, and the current time, decide
// what the run should do — proceed, keep waiting, or give up. The
// strongly-consistent storage + the durable-step poll loop live in the
// runtime layer (`@fractalboxdev/flare-dispatch-runtime-cf` `run-admission-d1.ts` + the
// dispatcher's `RunWorkflow`), which call in here every iteration. Keeping
// the logic pure mirrors `container-lease.ts`: it is exercised by plain
// vitest without a container runtime.
//
// The admission slot is a liveness slot, not a perfect semaphore: a holder
// refreshes its `heartbeatAt` while it runs, and an admitted row whose
// heartbeat is older than the TTL stops counting toward the pool (the Worker
// holding it was evicted mid-run, the run crashed, etc.). Without that decay
// a single crashed run would shrink the pool forever. Queued rows decay on a
// much shorter waiter TTL so a dead waiter never blocks the FIFO line.
//
// Issue: #109. Pattern sibling: container-lease.ts (#91).

/** The container pool a run is admitted into — one semaphore per pool. */
export type AdmissionPool = "lean" | "browser" | "agent" | "release";

/**
 * The admission class a run waits in (ADR-0009 § Interactive admission class).
 * A claim admits the oldest live `interactive` waiter in a pool before any
 * `batch` waiter; FIFO order and the queue position apply within a class,
 * interactive ahead of batch. A run that declares no class is `batch`.
 */
export type AdmissionClass = "interactive" | "batch";

/** The class of a run that declares none. */
export const ADMISSION_CLASS_DEFAULT: AdmissionClass = "batch";

/**
 * What one claim attempt observed, read atomically by the runtime layer:
 * whether OUR atomic claim landed, and — when it did not — where we stand.
 * `position` counts live queued rows ahead of us (the FIFO line); `poolBusy`
 * counts live admitted rows in our pool (slots in use).
 */
export type AdmissionObservation = {
  /** The atomic FIFO claim UPDATE changed our row — we hold a slot. */
  readonly admitted: boolean;
  /** Live queued rows ahead of us (0 when we are next, or when admitted). */
  readonly position: number;
  /** Live admitted rows in our pool (slots currently in use). */
  readonly poolBusy: number;
  /**
   * The burn ceiling, not the pool cap, held the claim back: our pool had a
   * free slot, but the admitted hourly rates plus ours exceed the ceiling
   * (ADR-0006 § Burn ceiling). Absent = false.
   */
  readonly ceilingHeld?: boolean;
};

/**
 * The decision for a run polling for admission, given one attempt's
 * observation.
 *
 *   - `admit`   — the claim landed: proceed into the run body.
 *   - `wait`    — the pool is full (or peers are ahead): poll again.
 *   - `timeout` — the run has queued past `maxQueueAgeMs`: fail loudly with
 *                 `AdmissionTimedOut` instead of hanging toward the Workflow
 *                 wall-clock cap. Never reached once admitted — a slot taken
 *                 at the deadline is kept.
 */
export type AdmissionDecision =
  | { readonly _kind: "admit" }
  | {
      readonly _kind: "wait";
      readonly position: number;
      readonly poolBusy: number;
    }
  | {
      readonly _kind: "timeout";
      readonly queuedForMs: number;
      readonly position: number;
      readonly poolBusy: number;
      /** The final attempt saw the burn ceiling, not the pool cap, holding it. */
      readonly ceilingHeld: boolean;
    };

/**
 * Decide what a queued run should do after one claim attempt. Pure: no I/O,
 * no clock read — `now` is the timestamp the observation was taken at (read
 * inside the same durable step), so the same inputs always yield the same
 * decision (replay-safe + unit-testable).
 *
 * @param observed       what the attempt saw (claim outcome, position, busy).
 * @param enqueuedAt     ms-epoch the run first enqueued — the dispatch-age basis.
 * @param now            ms-epoch the observation was taken at.
 * @param maxQueueAgeMs  dispatch-age ceiling — queued at least this long ⇒ timeout.
 */
export const decideAdmission = (
  observed: AdmissionObservation,
  enqueuedAt: number,
  now: number,
  maxQueueAgeMs: number,
): AdmissionDecision => {
  if (observed.admitted) return { _kind: "admit" };
  const queuedForMs = Math.max(0, now - enqueuedAt);
  if (queuedForMs >= maxQueueAgeMs) {
    return {
      _kind: "timeout",
      queuedForMs,
      position: observed.position,
      poolBusy: observed.poolBusy,
      ceilingHeld: observed.ceilingHeld === true,
    };
  }
  return {
    _kind: "wait",
    position: observed.position,
    poolBusy: observed.poolBusy,
  };
};

/**
 * Derive the number of claim attempts a bounded admission loop should make
 * from the dispatch-age ceiling + poll interval. At least one attempt; one
 * attempt per `pollEveryMs` up to `maxQueueAgeMs`. A COUNT, not a wall-clock
 * read, so the loop stays replay-deterministic across a Workflow checkpoint
 * resume — exactly the bound `leaseAcquireAttempts` and `waitForChildren`
 * use for their poll loops.
 *
 * With position-scaled sleeps ({@link admissionPollSleepMs}) pass the SHORTEST
 * sleep: every sleep is at least that long, so the count covers the whole
 * queue age, and the age read inside each claim step (`decideAdmission`) ends
 * a slower-polling loop at the deadline in fewer attempts. The count is the
 * ceiling on steps, the age is the ceiling on time.
 */
export const admissionAcquireAttempts = (maxQueueAgeMs: number, pollEveryMs: number): number =>
  Math.max(1, Math.ceil(maxQueueAgeMs / Math.max(1, pollEveryMs)));

/** The head-of-queue poll interval: the shortest sleep between claims. */
export const ADMISSION_POLL_MIN_MS = 20_000;

/** The longest sleep between claims, however far back a waiter stands. */
export const ADMISSION_POLL_MAX_MS = 60_000;

/**
 * The sleep before a waiter's next claim (ADR-0008 § Position-scaled admission
 * polls): `min(60 s, 20 s × ceil(position / cap))`, with the head (position 0)
 * on the 20-second poll. A waiter moves at most one place per released slot,
 * so polling far from the head admits nothing sooner.
 *
 * `position` is the one observed inside the claim step, so a replay sleeps the
 * same length. `remainingMs` (time left before the dispatch-age ceiling, from
 * the same step's clock) shortens a long sleep so the final claim lands at the
 * deadline instead of up to a minute past it; the sleep never drops below the
 * 20-second poll.
 */
export const admissionPollSleepMs = (
  position: number,
  cap: number,
  remainingMs: number = Number.POSITIVE_INFINITY,
): number => {
  const slotsBack = Math.max(1, Math.ceil(Math.max(0, position) / Math.max(1, cap)));
  const scaled = Math.min(ADMISSION_POLL_MAX_MS, ADMISSION_POLL_MIN_MS * slotsBack);
  return Math.max(ADMISSION_POLL_MIN_MS, Math.min(scaled, remainingMs));
};

/** The longest jitter an admitted run waits before its container starts. */
export const ADMISSION_JITTER_MAX_MS = 2_000;

/**
 * The pause between an admitting claim and the container start (ADR-0009 §
 * Pools sized under the spend guard), `0..ADMISSION_JITTER_MAX_MS` ms. A burst
 * of admissions spreads over two seconds instead of hitting the container
 * start-rate limit at once. Derived from the execution id (FNV-1a), so a
 * replay waits the same length.
 */
export const admissionJitterMs = (executionId: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < executionId.length; i++) {
    hash ^= executionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % (ADMISSION_JITTER_MAX_MS + 1);
};
