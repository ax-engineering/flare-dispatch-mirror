// FlareDispatch Dispatcher — read-side D1 queries for the log/executions routes.
//
// The WRITE side of `executions` / `steps` lives in
// `@fractalboxdev/flare-dispatch-runtime-cf` (executions-d1.ts), wired into the Workflow's
// runtime. The READ side belongs to the dispatcher's HTTP surface and is kept
// here — plain functions over the `D1Database` binding (a `@cloudflare/
// workers-types` TYPE, not a `cloudflare:workers` runtime import), so the route
// modules that call them stay testable under plain Node + Vitest 2, exactly
// like routes/artifacts.ts reads `RUNS_STORAGE` directly.
//
// Schema: infra/migrations/0001_initial_schema.sql.

/** One row of the `executions` table, as stored (snake_case columns). */
export type ExecutionRow = {
  readonly id: string;
  readonly run: string;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly parent_execution_id: string | null;
  readonly input_json: string;
  readonly summary_json: string | null;
  readonly check_run_id: number | null;
  // --- Attempt lineage (infra/migrations/0007) --------------------------------
  /** 1 for a dispatched execution, N for its (N-1)th check-run re-run. */
  readonly attempt: number;
  /** The id of attempt 1 of this row's family; NULL on attempt 1 itself. */
  readonly retry_of: string | null;
  // --- Cost rollup (infra/migrations/0005; written at finishExecution) --------
  // All nullable: pre-0005 rows, still-running executions, and deploys without
  // the cost path leave these NULL.
  readonly cost_micro_usd: number | null;
  readonly cost_basis: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly vcpu_seconds: number | null;
  readonly model: string | null;
  // --- Supersession (infra/migrations/0010; `listExecutions` only) -----------
  /**
   * The execution (or pull-request close marker) that superseded this one,
   * from its `run_supersessions` row; NULL when nothing did or the row aged out.
   */
  readonly superseded_by?: string | null;
};

/** One row of the `steps` table. */
export type StepRow = {
  readonly id: string;
  readonly execution_id: string;
  readonly name: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly exit_code: number | null;
  readonly log_uri: string | null;
  readonly attempt: number;
};

/** Terminal execution statuses — logs are immutable once one is reached. */
const TERMINAL = new Set(["success", "failure", "cancelled"]);

/** True iff `status` is a terminal execution state (safe to cache logs hard). */
export const isTerminal = (status: string | undefined): boolean =>
  status !== undefined && TERMINAL.has(status);

/** Filters + paging for `listExecutions`. */
export type ListFilters = {
  readonly run?: string;
  readonly repo?: string;
  readonly status?: string;
  /** Page size, already clamped by the caller. */
  readonly limit: number;
  /**
   * Keyset cursor: only rows with `started_at < before` — or, when `beforeId`
   * is also given, `(started_at, id) < (before, beforeId)` so rows that share
   * the same `started_at` ms (concurrent runs) are not skipped or repeated at
   * page boundaries.
   */
  readonly before?: number;
  readonly beforeId?: string;
};

/**
 * List executions newest-first, with optional `run`/`repo`/`status` filters and
 * a `(started_at, id)` keyset cursor, each with the `superseded_by` of its
 * `run_supersessions` row. Returns at most `limit` rows.
 */
export const listExecutions = async (
  db: D1Database,
  filters: ListFilters,
): Promise<ExecutionRow[]> => {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filters.run !== undefined) {
    where.push("run = ?");
    binds.push(filters.run);
  }
  if (filters.repo !== undefined) {
    where.push("repo = ?");
    binds.push(filters.repo);
  }
  if (filters.status !== undefined) {
    where.push("status = ?");
    binds.push(filters.status);
  }
  if (filters.before !== undefined) {
    if (filters.beforeId !== undefined) {
      // Composite keyset: strictly older, or same-millisecond and lexically
      // earlier id — so page boundaries never drop same-ms rows.
      where.push("(started_at < ?) OR (started_at = ? AND id < ?)");
      binds.push(filters.before, filters.before, filters.beforeId);
    } else {
      where.push("started_at < ?");
      binds.push(filters.before);
    }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // The filter columns exist only on `executions`, so they stay unqualified.
  const sql = `SELECT executions.*, run_supersessions.superseded_by
                 FROM executions
                 LEFT JOIN run_supersessions ON run_supersessions.execution_id = executions.id
               ${whereSql}
               ORDER BY started_at DESC
               LIMIT ?`;
  binds.push(filters.limit);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ExecutionRow>();
  return results ?? [];
};

/** Fetch one execution by id, or `null` if there is no such row. */
export const getExecution = async (db: D1Database, id: string): Promise<ExecutionRow | null> =>
  db.prepare("SELECT * FROM executions WHERE id = ?").bind(id).first<ExecutionRow>();

/**
 * The execution that posted a check-run, by the GitHub check-run id — or
 * `null` when no execution on this deploy posted it. Scoped to `repo` as well:
 * the repo named by the webhook is the one the re-run is authorized against,
 * so a row from any other repo must not answer.
 */
export const getExecutionByCheckRun = async (
  db: D1Database,
  repo: string,
  checkRunId: number,
): Promise<ExecutionRow | null> =>
  db
    .prepare("SELECT * FROM executions WHERE check_run_id = ? AND repo = ?")
    .bind(checkRunId, repo)
    .first<ExecutionRow>();

/**
 * Every attempt of one execution family: the root (attempt 1) plus each
 * re-run pointing at it through `retry_of`. Unordered; empty when the root id
 * names no row.
 */
export const getAttemptFamily = async (db: D1Database, rootId: string): Promise<ExecutionRow[]> => {
  const root = await getExecution(db, rootId);
  if (root === null) return [];
  const { results } = await db
    .prepare("SELECT * FROM executions WHERE retry_of = ?")
    .bind(rootId)
    .all<ExecutionRow>();
  return [root, ...(results ?? [])];
};

/** Every execution recorded against one commit of one repo. */
export const listExecutionsAtSha = async (
  db: D1Database,
  repo: string,
  sha: string,
): Promise<ExecutionRow[]> => {
  const { results } = await db
    .prepare("SELECT * FROM executions WHERE repo = ? AND sha = ?")
    .bind(repo, sha)
    .all<ExecutionRow>();
  return results ?? [];
};

/** Fetch an execution's steps, ordered by start time then name. */
export const getSteps = async (db: D1Database, executionId: string): Promise<StepRow[]> => {
  const { results } = await db
    .prepare(
      `SELECT * FROM steps WHERE execution_id = ?
       ORDER BY started_at ASC, name ASC`,
    )
    .bind(executionId)
    .all<StepRow>();
  return results ?? [];
};

// ---------------------------------------------------------------------------
// Analytics — per-recipe speed + cost aggregate (the `/v1/analytics.json` feed).
// ---------------------------------------------------------------------------

/** The minimal finished-execution shape the aggregate needs. */
export type AnalyticsInputRow = {
  readonly run: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly cost_micro_usd: number | null;
  readonly cost_basis: string | null;
};

/** One recipe's MEASURED rollup over recent finished executions. */
export type RunAnalytics = {
  readonly run: string;
  /** Finished executions sampled (including `skipped` capacity bow-outs). */
  readonly count: number;
  /**
   * Fraction in [0,1] that ended `success`, over the executions that actually
   * ran (`count - skipped`). A `skipped` execution (capacity bow-out →
   * neutral check) is neither a success nor a failure, so it must not drag
   * this rate down like a red run would.
   */
  readonly successRate: number;
  /** How many sampled executions were `skipped` (capacity bow-outs). */
  readonly skipped: number;
  /** Median wall-time, ms (null if no timed samples). */
  readonly p50DurationMs: number | null;
  /** 95th-percentile wall-time, ms (null if no timed samples). */
  readonly p95DurationMs: number | null;
  /** Mean cost over executions that carry a cost rollup, µ$ (null if none). */
  readonly avgCostMicroUsd: number | null;
  /** Summed cost over executions that carry a rollup, µ$. */
  readonly totalCostMicroUsd: number;
  /** How many sampled executions carry a cost rollup. */
  readonly costSamples: number;
  /** Dominant `cost_basis` across the cost samples (metered|mixed|modeled|…). */
  readonly basis: string | null;
};

/** Nearest-rank percentile over a numeric sample (p in [0,1]). */
const percentile = (sortedAsc: readonly number[], p: number): number | null => {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
};

/**
 * Pure per-run aggregation — kept separate from the D1 read so it is unit-
 * testable. Groups finished executions by `run`, computes success rate, p50/p95
 * wall-time, and average/total cost (over rows that carry a rollup), and picks
 * the dominant cost basis so the surface can label metered vs modeled honestly.
 */
export const summarizeRuns = (rows: readonly AnalyticsInputRow[]): RunAnalytics[] => {
  type Acc = {
    durations: number[];
    count: number;
    successes: number;
    skipped: number;
    costTotal: number;
    costSamples: number;
    basisCounts: Map<string, number>;
  };
  const byRun = new Map<string, Acc>();
  for (const r of rows) {
    let a = byRun.get(r.run);
    if (a === undefined) {
      a = {
        durations: [],
        count: 0,
        successes: 0,
        skipped: 0,
        costTotal: 0,
        costSamples: 0,
        basisCounts: new Map(),
      };
      byRun.set(r.run, a);
    }
    a.count += 1;
    // A `skipped` execution is a capacity bow-out (`RunSkipped` → neutral
    // check): neither a success nor a failure, so it is counted on its own
    // aggregate and excluded from the success-rate denominator below — but
    // still sampled (duration + cost are real spend), so a run whose recent
    // history is all-skipped stays visible instead of vanishing entirely.
    if (r.status === "skipped") a.skipped += 1;
    else if (r.status === "success") a.successes += 1;
    if (r.started_at !== null && r.completed_at !== null && r.completed_at > r.started_at) {
      a.durations.push(r.completed_at - r.started_at);
    }
    if (r.cost_micro_usd !== null) {
      a.costTotal += r.cost_micro_usd;
      a.costSamples += 1;
      const b = r.cost_basis ?? "modeled";
      a.basisCounts.set(b, (a.basisCounts.get(b) ?? 0) + 1);
    }
  }

  const out: RunAnalytics[] = [];
  for (const [run, a] of byRun) {
    const sorted = [...a.durations].sort((x, y) => x - y);
    let basis: string | null = null;
    let best = -1;
    for (const [b, n] of a.basisCounts) {
      if (n > best) {
        best = n;
        basis = b;
      }
    }
    const rated = a.count - a.skipped;
    out.push({
      run,
      count: a.count,
      successRate: rated > 0 ? a.successes / rated : 0,
      skipped: a.skipped,
      p50DurationMs: percentile(sorted, 0.5),
      p95DurationMs: percentile(sorted, 0.95),
      avgCostMicroUsd: a.costSamples > 0 ? Math.round(a.costTotal / a.costSamples) : null,
      totalCostMicroUsd: a.costTotal,
      costSamples: a.costSamples,
      basis,
    });
  }
  // Busiest recipes first.
  out.sort((x, y) => y.count - x.count);
  return out;
};

/**
 * MEASURED per-recipe analytics over the most recent `limit` finished
 * executions. Bounded by `limit` (newest-first) so the aggregate is a cheap
 * single scan, not an unbounded table sweep.
 */
export const aggregateByRun = async (db: D1Database, limit: number): Promise<RunAnalytics[]> => {
  const { results } = await db
    .prepare(
      `SELECT run, status, started_at, completed_at, cost_micro_usd, cost_basis
         FROM executions
        WHERE completed_at IS NOT NULL
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<AnalyticsInputRow>();
  return summarizeRuns(results ?? []);
};
