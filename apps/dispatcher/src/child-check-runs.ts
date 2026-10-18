// A fan-out parent concludes its children's open check-runs as it closes.
//
// A child's own terminal update can fail to land — a degraded GitHub write, or
// a replay that never reached the terminal path — and its check-run then stays
// `in_progress` after the parent has already read the child's row and moved
// on. At its terminal path the parent reads each child row that carries a
// check-run id, reads that check-run, and concludes only those still open:
// with the verdict the row records, or as `failure` when the row never settled.
//
// Best-effort throughout: every read and write is absorbed, and nothing here
// changes the parent's own verdict.

import { Effect } from "effect";
import type { CheckConclusion, ChecksService } from "@fractalboxdev/flare-dispatch-core";

/** The no-op sentinel a degraded `checks.create` returns — no check-run to read. */
const NOOP_CHECK_RUN_ID = "noop";

/** A child execution row, as the parent's close reads it. */
export type ChildCheckRunRow = {
  readonly id: string;
  readonly repo: string;
  readonly status: string;
  readonly checkRunId: string | null;
};

const conclusionFor = (status: string): CheckConclusion | undefined => {
  switch (status) {
    case "success":
    case "failure":
    case "cancelled":
      return status;
    case "skipped":
      return "neutral";
    default:
      return undefined;
  }
};

const summaryFor = (row: ChildCheckRunRow, recorded: CheckConclusion | undefined): string =>
  recorded === undefined
    ? `✗ \`${row.id}\` — the parent closed before this part settled; no verdict is on record.`
    : `\`${row.id}\` recorded \`${row.status}\`; its own check-run update did not land, so the parent concluded it at close.`;

/**
 * Conclude every child check-run in `rows` that is still open. Resolves to the
 * ids of the children it concluded; never fails.
 */
export const concludeOpenChildCheckRuns = (
  rows: readonly ChildCheckRunRow[],
  checks: Pick<ChecksService, "status" | "update">,
): Effect.Effect<readonly string[]> =>
  Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const checkRunId = row.checkRunId;
        if (checkRunId === null || checkRunId === NOOP_CHECK_RUN_ID) return [];
        const state = yield* checks.status({ repo: row.repo, checkRunId });
        if (state !== "open") return [];
        const recorded = conclusionFor(row.status);
        yield* checks.update({
          repo: row.repo,
          checkRunId,
          conclusion: recorded ?? "failure",
          output: { title: "Concluded at parent close", summary: summaryFor(row, recorded) },
        });
        return [row.id];
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.as(
            Effect.logWarning(`child check-run ${row.id} not concluded at parent close — ${cause}`),
            [] as string[],
          ),
        ),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((concluded) => concluded.flat()));

/** Read the children of `parentExecutionId` that carry a check-run id. */
export const readChildCheckRuns = (
  db: D1Database,
  parentExecutionId: string,
): Effect.Effect<readonly ChildCheckRunRow[]> =>
  Effect.tryPromise(() =>
    db
      .prepare(
        `SELECT id, repo, status, check_run_id AS checkRunId
           FROM executions
          WHERE parent_execution_id = ? AND check_run_id IS NOT NULL`,
      )
      .bind(parentExecutionId)
      .all<ChildCheckRunRow>(),
  ).pipe(
    Effect.map(({ results }) => results),
    Effect.catchAllCause((cause) =>
      Effect.as(
        Effect.logWarning(`child check-runs unreadable at parent close — ${cause}`),
        [] as ChildCheckRunRow[],
      ),
    ),
  );
