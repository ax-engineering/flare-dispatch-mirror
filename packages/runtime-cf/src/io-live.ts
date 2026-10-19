// @fractalboxdev/flare-dispatch-runtime-cf — IOLive: the live `io` capability.
//
// Backs `IOService` with the Workers platform primitives: `Date.now()` for the
// clock, `globalThis.crypto.randomUUID()` for UUIDs, `console` for structured
// logs. The DSL forces non-determinism through `io.*` precisely so the live
// runtime can supply these here and the test runtime can supply a deterministic
// fake — Workflow checkpoint replay then stays consistent (specs/03-dsl.md
// § io, specs/pm/plan.md § 6 "Run replay determinism").
//
// `io.env` is a graceful no-op (no per-run env surface yet). `io.priorExecution`
// queries D1 for the most recent terminal execution in the semantic family
// when the live D1 binding + current execution id are supplied (the normal
// per-execution wiring in runtime.ts). Without them — a stand-alone `IOLive`
// for tests or local dev — it returns `Option.none()`, the documented "first
// execution of a family" result.
//
// Spec: specs/03-dsl.md § io, specs/pm/plan.md § PR4.

import { Duration, Effect, Layer, Option, Schema } from "effect";
import { IO, type IOService } from "@fractalboxdev/flare-dispatch-core";

/**
 * Options for {@link makeIOLive}. All optional — IOLive runs with no bindings
 * for tests and local dev. Supplying `{db, currentExecutionId}` enables the
 * live `priorExecution` D1 query.
 */
export type IOLiveOptions = {
  /** D1 binding (`env.RUNS_METADATA`) — required for live `priorExecution`. */
  readonly db?: D1Database;
  /**
   * The current execution's instanceId — excluded from `priorExecution`
   * results so a run never sees itself as its own prior.
   */
  readonly currentExecutionId?: string;
  /**
   * The tokened log-viewer base URL for this execution — the dispatcher mints
   * it (it owns the log-token secret) and threads it through so `io.viewerUrl`
   * can hand a run its own readable log/artifact surface. `undefined` (no
   * public origin or no log-link key on the deploy) → `io.viewerUrl` is
   * `Option.none()`.
   */
  readonly logsViewerBase?: string;
  /**
   * Values `io.env` answers, by key — the dispatcher's per-execution facts
   * (`EXECUTION_CREATED_AT_ENV`, `DEPLOYED_VERSION_ENV`). Any other key is
   * `undefined`.
   */
  readonly vars?: Readonly<Record<string, string>>;
};

/** Build the live `IO` Layer. */
export const makeIOLive = (opts: IOLiveOptions = {}): Layer.Layer<IO> =>
  Layer.succeed(IO, {
    now: Effect.sync(() => Date.now()),

    // `crypto` is a Workers runtime global (WebCrypto) — the standard
    // replay-safe UUID source the DSL routes `io.uuid` through.
    uuid: Effect.sync(() => crypto.randomUUID()),

    // This execution's id == the Workflow instanceId (the dispatcher passes it
    // as `currentExecutionId`). A run reads it to address itself — e.g. the
    // release-PR approval marker. `""` on a bare stand-alone IO layer.
    executionId: Effect.succeed(opts.currentExecutionId ?? ""),

    // Runs are dispatched with explicit inputs; `io.env` answers only the
    // dispatcher's per-execution facts in `vars`, and `undefined` otherwise.
    env: (key) => Effect.succeed(opts.vars?.[key]),

    // The readable log/artifact surface for this execution. `none` when the
    // deploy lacks a public origin or log-link key (the dispatcher then passes
    // no `logsViewerBase`), keeping `io.viewerUrl` total.
    viewerUrl: Effect.succeed(Option.fromNullable(opts.logsViewerBase)),

    // `Duration.decode` normalises the IOService input to a `Duration`. The
    // interface types the input as a plain `string`; Effect's `DurationInput`
    // is the narrower `` `${number} ${unit}` `` template — the cast asserts
    // the documented contract (a duration-shaped string).
    sleep: (d) => Effect.sleep(Duration.decode(d as Duration.DurationInput)),

    log: (level, msg, attrs) =>
      Effect.sync(() => {
        const line = { level, msg, ...attrs };
        // Workers logs are JSON-lines on stdout; `console` is the platform sink.
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
      }),

    // `io.priorExecution` (specs/03-dsl.md § io.priorExecution) — most recent
    // terminal execution in the semantic family. The family is the instanceId
    // prefix (e.g. `pr-review:owner/name:42`); the query matches `id LIKE
    // 'family:%'` and excludes the current execution. A NULL or malformed
    // `summary_json` degrades to `Option.none()` rather than failing — the
    // capability is "best-effort tuning, never a hard run failure" per spec.
    priorExecution: <O, I>({
      family,
      outputSchema,
    }: {
      family: string;
      outputSchema: Schema.Schema<O, I>;
    }) =>
      opts.db === undefined
        ? Effect.succeed(
            Option.none<{
              executionId: string;
              sha: string;
              output: O;
              finishedAt: number;
            }>(),
          )
        : Effect.tryPromise(async () => {
            // `LIKE` with a `family:%` prefix; SQLite treats `:` as a literal
            // char (it is not a parameter marker in `prepare` bind position).
            const row = await opts
              .db!.prepare(
                `SELECT id, sha, summary_json, completed_at
                   FROM executions
                  WHERE id LIKE ?
                    AND id != ?
                    AND status IN ('success', 'failure')
                    AND summary_json IS NOT NULL
                  ORDER BY completed_at DESC
                  LIMIT 1`,
              )
              .bind(`${family}:%`, opts.currentExecutionId ?? "")
              .first<{
                id: string;
                sha: string;
                summary_json: string;
                completed_at: number;
              }>();
            if (row === null) {
              return Option.none<{
                executionId: string;
                sha: string;
                output: O;
                finishedAt: number;
              }>();
            }
            // Decode summary_json against the run's outputSchema. A mismatch
            // (prior execution ran an older run version with a different
            // output shape) → none, not failure.
            let parsed: unknown;
            try {
              parsed = JSON.parse(row.summary_json);
            } catch {
              return Option.none<{
                executionId: string;
                sha: string;
                output: O;
                finishedAt: number;
              }>();
            }
            const decoded = Schema.decodeUnknownEither(outputSchema)(parsed);
            if (decoded._tag === "Left") {
              return Option.none<{
                executionId: string;
                sha: string;
                output: O;
                finishedAt: number;
              }>();
            }
            return Option.some({
              executionId: row.id,
              sha: row.sha,
              output: decoded.right,
              finishedAt: row.completed_at,
            });
          }).pipe(
            // A D1 outage during this lookup is not a fatal run condition —
            // degrade to `Option.none()` so the run proceeds as if first in
            // its family (matches spec's "best-effort tuning" framing).
            Effect.orElseSucceed(() =>
              Option.none<{
                executionId: string;
                sha: string;
                output: O;
                finishedAt: number;
              }>(),
            ),
          ),
  } satisfies IOService);

/** The live `IO` Layer — platform `crypto` + `Date`, no D1. */
export const IOLive: Layer.Layer<IO> = makeIOLive();
