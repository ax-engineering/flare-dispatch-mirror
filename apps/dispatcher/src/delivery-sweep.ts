// FlareDispatch Dispatcher — the verdict reconcile sweep.
//
// An execution's verdict reaches the pull request only when its concluding
// check-run write lands; `RunWorkflow` stamps `executions.delivered_at` when it
// does. A write that fails — a rate-limited installation, a GitHub outage —
// leaves a finished row with an installation and no `delivered_at`. This sweep
// runs on its own cron and re-sends those conclusions, oldest first:
//
//   * only rows that finished at least `DELIVERY_GRACE_MS` ago, so a workflow
//     still between its terminal row write and its check-run write is not
//     raced;
//   * only rows younger than `DELIVERY_MAX_AGE_MS`, so a verdict an outage
//     kept from GitHub for a week stops being retried;
//   * only rows not yet refused: a write GitHub rejects for the check-run
//     itself (404 or 422 — repository, installation or commit gone) stamps
//     `delivery_refused_at` and leaves the queue, so it never holds up the
//     newer rows behind it;
//   * at most `DELIVERY_SWEEP_LIMIT` rows a tick;
//   * inside the verdict reserve: `conclude` spends the reserve and refuses
//     only an exhausted installation, and the first undelivered (not refused)
//     row of an installation stops the sweep for that installation until the
//     next tick.
//
// A row whose opener degraded holds the sentinel check-run id; `conclude`
// creates the check-run with the verdict and the sweep records the new id.
//
// Plain module, no `cloudflare:workers` import, so the dispatcher's Node test
// project loads it; routes/scheduled.ts wires the live D1 and GitHub ports.

import type { CheckConcludeOptions, CheckDelivery } from "@fractalboxdev/flare-dispatch-core";
import { checkRunNameFor, checkRunTitleFor } from "./check-name";
import { checkConclusion, type ExecutionVerdict } from "./terminal-verdict";

/** The cron the sweep runs on — armed in `wrangler.jsonc` beside the run crons. */
export const DELIVERY_SWEEP_CRON = "*/10 * * * *";

/** How long after finishing a row first becomes eligible. */
export const DELIVERY_GRACE_MS = 10 * 60_000;

/** The oldest finished row the sweep still re-sends. */
export const DELIVERY_MAX_AGE_MS = 7 * 24 * 3_600_000;

/** The most rows one tick re-sends. */
export const DELIVERY_SWEEP_LIMIT = 50;

/** A finished execution that owes GitHub its verdict. */
export type UndeliveredRow = {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly sha: string;
  readonly status: ExecutionVerdict;
  readonly attempt: number;
  readonly inputJson: string;
  readonly checkRunId: string;
  readonly installationId: number;
  readonly completedAt: number;
};

/** The I/O the sweep runs against. */
export type DeliverySweepPorts = {
  /**
   * Finished rows with neither `delivered_at` nor `delivery_refused_at`,
   * completed in `[after, before)`, oldest first.
   */
  readonly listUndelivered: (opts: {
    readonly completedBefore: number;
    readonly completedAfter: number;
    readonly limit: number;
  }) => Promise<readonly UndeliveredRow[]>;
  /** The concluding write, through the installation's checks client. */
  readonly conclude: (installationId: number, opts: CheckConcludeOptions) => Promise<CheckDelivery>;
  /** Stamp `delivered_at` and the check-run that holds the verdict. */
  readonly markDelivered: (id: string, checkRunId: string, at: number) => Promise<void>;
  /** Stamp `delivery_refused_at`: GitHub rejects this row's write for good. */
  readonly markRefused: (id: string, at: number) => Promise<void>;
  readonly now: () => number;
};

/** What one tick did. */
export type DeliverySweepResult = {
  readonly delivered: number;
  readonly undelivered: number;
  /** Rows GitHub refused for good, taken out of the queue. */
  readonly refused: number;
  /** Rows not attempted because their installation already left one undelivered this tick. */
  readonly deferred: number;
};

/** Parse a row's stored inputs; a malformed blob names the check without a label. */
const parseInputs = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

const VERDICT_LINE: Record<ExecutionVerdict, (run: string) => string> = {
  success: (run) => `✓ ${run} — execution succeeded.`,
  failure: (run) => `✗ ${run} — execution failed.`,
  skipped: (run) => `⊘ ${run} — skipped.`,
};

/** The concluding write a row owes: the name, title and conclusion its workflow posts. */
export const conclusionFor = (row: UndeliveredRow): CheckConcludeOptions => {
  const name = checkRunNameFor(row.run, parseInputs(row.inputJson));
  return {
    repo: row.repo,
    sha: row.sha,
    name,
    checkRunId: row.checkRunId,
    conclusion: checkConclusion(row.status, true),
    output: {
      title: checkRunTitleFor(name, row.attempt),
      summary:
        `${VERDICT_LINE[row.status](row.run)}\n\n` +
        `Execution \`${row.id}\`. The reconcile sweep delivered this verdict; ` +
        `the execution's own write did not reach GitHub.`,
    },
  };
};

/** One sweep tick: re-send every eligible undelivered verdict, oldest first. */
export const sweepUndelivered = async (ports: DeliverySweepPorts): Promise<DeliverySweepResult> => {
  const now = ports.now();
  const rows = await ports.listUndelivered({
    completedBefore: now - DELIVERY_GRACE_MS,
    completedAfter: now - DELIVERY_MAX_AGE_MS,
    limit: DELIVERY_SWEEP_LIMIT,
  });
  const held = new Set<number>();
  let delivered = 0;
  let undelivered = 0;
  let refused = 0;
  let deferred = 0;
  for (const row of rows) {
    if (held.has(row.installationId)) {
      deferred += 1;
      continue;
    }
    const outcome = await ports
      .conclude(row.installationId, conclusionFor(row))
      .catch((cause: unknown): CheckDelivery => ({ _tag: "undelivered", reason: String(cause) }));
    if (outcome._tag === "delivered") {
      delivered += 1;
      // GitHub holds the verdict; a failed stamp only means the next tick
      // sends the same conclusion again.
      await ports.markDelivered(row.id, outcome.checkRunId, ports.now()).catch((cause: unknown) => {
        console.warn(`[delivery-sweep] delivered_at not recorded for ${row.id}: ${String(cause)}`);
      });
    } else if (outcome._tag === "refused") {
      // The installation still answers; only this row's write is dead.
      console.warn(`[delivery-sweep] ${row.id} refused: ${outcome.reason}`);
      refused += 1;
      await ports.markRefused(row.id, ports.now()).catch((cause: unknown) => {
        console.warn(`[delivery-sweep] delivery_refused_at not recorded for ${row.id}: ${String(cause)}`);
      });
    } else {
      console.warn(`[delivery-sweep] ${row.id} undelivered: ${outcome.reason}`);
      held.add(row.installationId);
      undelivered += 1;
    }
  }
  return { delivered, undelivered, refused, deferred };
};
