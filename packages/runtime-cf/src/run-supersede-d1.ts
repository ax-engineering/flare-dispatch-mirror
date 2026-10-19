// @fractalboxdev/flare-dispatch-runtime-cf — D1-backed supersession for runs that declare `supersede`.
//
// Executions that share a `SupersedeSpec.group` keep one live member: the one
// with the highest rank (`SupersedeSpec.order`, else the registration time),
// ties broken by registration time, then execution id. Registering marks every
// lower-ranked live or pending-superseded member 'superseded' with this execution's id in
// `superseded_by`, and marks this execution itself superseded when a
// higher-ranked member is already live, in one D1 batch. A re-run of the
// registration step reads both answers back by `superseded_by`, so an instance
// that dies between the batch and its checkpoint still cancels everything it
// superseded.
//
// The serial queue (serial-queue-d1.ts) supersedes WAITERS only and never
// touches a running execution. Supersession is the other policy: the older
// member is cancelled wherever it stands — queued in admission, running, or
// joined on children. `cancel` is the D1 half of that: it ends the rows, frees
// their admission and serial slots, and drops their supersession rows. The
// Workflow instances, containers and check-runs are the dispatcher's half
// (apps/dispatcher/src/supersede.ts).
//
// Execution order before `cancel` matters to children that boot late: the
// root row is marked 'cancelled' FIRST (`markCancelled`), and only then is its
// tree read, so a child whose row is not yet in that read checks its parent's
// status after the mark and stands down by itself.

import { Effect, Schedule } from "effect";

/** Rows older than this are deleted by the next release — above any run's ceiling. */
const SUPERSEDE_GC_AFTER_MS = 48 * 60 * 60_000;

/** Execution statuses that end a row; `cancel` leaves these untouched. */
export const TERMINAL_EXECUTION_STATUSES = ["success", "failure", "skipped", "cancelled"] as const;
const TERMINAL_SQL = TERMINAL_EXECUTION_STATUSES.map((status) => `'${status}'`).join(", ");

const d1 = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.retry(Schedule.recurs(2).pipe(Schedule.addDelay(() => "200 millis"))));

/** One still-open execution in a superseded tree. */
export type SupersededRow = {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly status: string;
  readonly checkRunId: string | null;
};

/** What one registration decided. */
export type SupersedeRegistration = {
  /** Lower-ranked members this execution superseded, lowest first. */
  readonly superseded: readonly string[];
  /** The higher-ranked live member that superseded this execution on arrival. */
  readonly supersededBy: string | undefined;
};

export interface RunSupersedeStore {
  /**
   * Join `group` at `rank` (default: now). With `supersedeOlder`, mark every
   * lower-ranked live or pending-superseded member superseded, or this execution when a higher-ranked
   * member is live; without it, join and supersede nothing. Idempotent: a
   * repeat returns the same answer.
   */
  readonly register: (
    executionId: string,
    group: string,
    opts: { readonly supersedeOlder: boolean; readonly rank?: number },
  ) => Effect.Effect<SupersedeRegistration, Error>;
  /** Mark one execution's row 'cancelled' unless it already ended. */
  readonly markCancelled: (executionId: string) => Effect.Effect<void, Error>;
  /** The execution and its descendants whose rows have not ended. */
  readonly openTree: (executionId: string) => Effect.Effect<readonly SupersededRow[], Error>;
  /** The status recorded on an execution's row, or `undefined` with no row. */
  readonly status: (executionId: string) => Effect.Effect<string | undefined, Error>;
  /** An execution's status and run name, or `undefined` with no row. */
  readonly row: (executionId: string) => Effect.Effect<{ readonly status: string; readonly run: string } | undefined, Error>;
  /**
   * End every row in `ids` as 'cancelled' (rows already ended keep their
   * status), and delete their admission, serial-queue and supersession rows.
   */
  readonly cancel: (ids: readonly string[]) => Effect.Effect<void, Error>;
  /** Leave the group (DELETE own row) and collect rows past the GC age. */
  readonly release: (executionId: string) => Effect.Effect<void, Error>;
}

export const makeRunSupersedeD1 = (
  db: D1Database,
  now: () => number = Date.now,
): RunSupersedeStore => {
  const register = (
    executionId: string,
    group: string,
    opts: { readonly supersedeOlder: boolean; readonly rank?: number },
  ): Effect.Effect<SupersedeRegistration, Error> =>
    Effect.gen(function* () {
      const ts = now();
      const insert = db
        .prepare(
          `INSERT OR IGNORE INTO run_supersessions
             (execution_id, group_key, state, revision_rank, registered_at)
           VALUES (?1, ?2, 'live', ?3, ?4)`,
        )
        .bind(executionId, group, opts.rank ?? ts, ts);
      // `m` ranks below `me`: (revision_rank, registered_at, execution_id) in order.
      const below = (m: string, me: string): string =>
        `(${m}.revision_rank < ${me}.revision_rank
          OR (${m}.revision_rank = ${me}.revision_rank AND ${m}.registered_at < ${me}.registered_at)
          OR (${m}.revision_rank = ${me}.revision_rank AND ${m}.registered_at = ${me}.registered_at
              AND ${m}.execution_id < ${me}.execution_id))`;
      const supersedeLower = db
        .prepare(
          `UPDATE run_supersessions AS m SET state = 'superseded', superseded_by = ?1
            WHERE m.group_key = ?2 AND m.state IN ('live', 'superseded') AND m.execution_id != ?1
              AND EXISTS (SELECT 1 FROM run_supersessions AS me
                           WHERE me.execution_id = ?1 AND me.state = 'live' AND ${below("m", "me")})`,
        )
        .bind(executionId, group);
      const standDown = db
        .prepare(
          `UPDATE run_supersessions AS me SET state = 'superseded', superseded_by =
             (SELECT h.execution_id FROM run_supersessions AS h
               WHERE h.group_key = ?2 AND h.state = 'live' AND h.execution_id != ?1
                 AND ${below("me", "h")}
               ORDER BY h.revision_rank DESC, h.registered_at DESC, h.execution_id DESC LIMIT 1)
            WHERE me.execution_id = ?1 AND me.state = 'live'
              AND EXISTS (SELECT 1 FROM run_supersessions AS h
                           WHERE h.group_key = ?2 AND h.state = 'live' AND h.execution_id != ?1
                             AND ${below("me", "h")})`,
        )
        .bind(executionId, group);
      yield* d1(() =>
        db.batch(opts.supersedeOlder ? [insert, standDown, supersedeLower] : [insert]),
      );
      if (!opts.supersedeOlder) return { superseded: [], supersededBy: undefined };
      const { results } = yield* d1(() =>
        db
          .prepare(
            `SELECT execution_id AS id FROM run_supersessions
              WHERE superseded_by = ? ORDER BY revision_rank, registered_at, execution_id`,
          )
          .bind(executionId)
          .all<{ id: string }>(),
      );
      const own = yield* d1(() =>
        db
          .prepare(
            `SELECT superseded_by AS supersededBy FROM run_supersessions
              WHERE execution_id = ? AND state = 'superseded'`,
          )
          .bind(executionId)
          .first<{ supersededBy: string | null }>(),
      );
      return {
        superseded: results.map((row) => row.id),
        supersededBy: own?.supersededBy ?? undefined,
      };
    });

  const markCancelled = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db
        .prepare(
          `UPDATE executions SET status = 'cancelled', completed_at = ?2
            WHERE id = ?1 AND status NOT IN (${TERMINAL_SQL})`,
        )
        .bind(executionId, now())
        .run(),
    ).pipe(Effect.asVoid);

  const openTree = (executionId: string): Effect.Effect<readonly SupersededRow[], Error> =>
    d1(() =>
      db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM executions WHERE id = ?1
             UNION ALL
             SELECT child.id FROM executions AS child
               JOIN tree AS parent ON child.parent_execution_id = parent.id
           )
           SELECT id, run, repo, status, CAST(check_run_id AS TEXT) AS checkRunId
             FROM executions
            WHERE id IN (SELECT id FROM tree)
              AND (status NOT IN (${TERMINAL_SQL}) OR status = 'cancelled' OR id = ?1)`,
        )
        .bind(executionId)
        .all<SupersededRow>(),
    ).pipe(Effect.map(({ results }) => results));

  const status = (executionId: string): Effect.Effect<string | undefined, Error> =>
    d1(() =>
      db
        .prepare(`SELECT status FROM executions WHERE id = ?`)
        .bind(executionId)
        .first<{ status: string }>(),
    ).pipe(Effect.map((row) => row?.status));

  const row = (executionId: string) =>
    d1(() =>
      db
        .prepare(`SELECT status, run FROM executions WHERE id = ?`)
        .bind(executionId)
        .first<{ status: string; run: string }>(),
    ).pipe(Effect.map((found) => (found === null ? undefined : { status: found.status, run: found.run })));

  const cancel = (ids: readonly string[]): Effect.Effect<void, Error> => {
    if (ids.length === 0) return Effect.void;
    const marks = ids.map(() => "?").join(", ");
    const ts = now();
    return d1(() =>
      db.batch([
        db
          .prepare(
            `UPDATE executions SET status = 'cancelled', completed_at = ?
              WHERE id IN (${marks}) AND status NOT IN (${TERMINAL_SQL})`,
          )
          .bind(ts, ...ids),
        db.prepare(`DELETE FROM run_admissions WHERE execution_id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM serial_queue WHERE execution_id IN (${marks})`).bind(...ids),
        db.prepare(`DELETE FROM run_supersessions WHERE execution_id IN (${marks})`).bind(...ids),
      ]),
    ).pipe(Effect.asVoid);
  };

  const release = (executionId: string): Effect.Effect<void, Error> =>
    d1(() =>
      db.batch([
        // A superseded member remains discoverable until its tree is cleaned.
        db.prepare(`DELETE FROM run_supersessions WHERE execution_id = ? AND state = 'live'`).bind(executionId),
        db
          .prepare(`DELETE FROM run_supersessions WHERE registered_at < ?`)
          .bind(now() - SUPERSEDE_GC_AFTER_MS),
      ]),
    ).pipe(Effect.asVoid);

  return { register, markCancelled, openTree, status, row, cancel, release };
};
