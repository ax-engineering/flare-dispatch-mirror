// @fractalboxdev/flare-dispatch-core — IO fake.
//
// Deterministic `now` (a monotonically advancing clock) and `uuid` (a counter)
// so step replay and test assertions are reproducible. `log` collects entries
// in memory for inspection.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § io.

import { Effect, Layer, Option } from "effect";
import { IO, type IOService, type LogLevel, type PriorExecution } from "../services/io";

export type LogEntry = {
  readonly level: LogLevel;
  readonly msg: string;
  readonly attrs?: Record<string, unknown>;
};

/** Inspectable handle to a fake IO — surfaced for test assertions. */
export type IOFakeState = {
  /** every `io.log` call, in order. */
  readonly logs: LogEntry[];
  /** the next epoch-ms `io.now` will return. */
  nowCursor: number;
};

export type IOFakeOptions = {
  /** epoch ms the first `io.now` returns; advances by `tickMs` each call. */
  readonly startMs?: number;
  /** how much `io.now` advances per call. Default 1000. */
  readonly tickMs?: number;
  /**
   * When set, `io.priorExecution` returns `Option.some` of this record (for
   * every family); when omitted it returns `Option.none()` — the first-run
   * default. Lets a run test exercise the re-review / prior-findings path.
   */
  readonly prior?: PriorExecution<unknown>;
  /**
   * When set, `io.viewerUrl` returns `Option.some(viewerUrl)`; omitted it is
   * `Option.none()` — the no-public-origin default. Lets a run test assert its
   * comment links back to the log viewer.
   */
  readonly viewerUrl?: string;
  /**
   * The id `io.executionId` returns — the test stand-in for the Workflow
   * instance id. `makeCFRuntimeTest` threads its own execution id in here so a
   * run that reads `io.executionId` sees the same id steps record under.
   */
  readonly executionId?: string;
  /** Values `io.env` returns, by key; an absent key is `undefined`. */
  readonly vars?: Readonly<Record<string, string>>;
};

/**
 * Build an IO fake plus an inspectable state handle. `uuid` is a zero-padded
 * counter (`00000000-0000-4000-8000-000000000001`, ...).
 */
export const makeIOFake = (
  opts: IOFakeOptions = {},
): { layer: Layer.Layer<IO>; state: IOFakeState } => {
  const tick = opts.tickMs ?? 1000;
  const state: IOFakeState = {
    logs: [],
    nowCursor: opts.startMs ?? 1_700_000_000_000,
  };
  let uuidSeq = 0;

  const service: IOService = {
    now: Effect.sync(() => {
      const t = state.nowCursor;
      state.nowCursor += tick;
      return t;
    }),
    uuid: Effect.sync(() => {
      uuidSeq += 1;
      const n = uuidSeq.toString().padStart(12, "0");
      return `00000000-0000-4000-8000-${n}`;
    }),
    executionId: Effect.succeed(opts.executionId ?? ""),
    env: (key) => Effect.succeed(opts.vars?.[key]),
    viewerUrl: Effect.succeed(Option.fromNullable(opts.viewerUrl)),
    sleep: () => Effect.void,
    log: (level, msg, attrs) =>
      Effect.sync(() => {
        state.logs.push({ level, msg, attrs });
      }),
    priorExecution: <O>() =>
      Effect.succeed(
        opts.prior === undefined
          ? Option.none<PriorExecution<O>>()
          : Option.some(opts.prior as PriorExecution<O>),
      ),
  };

  return { layer: Layer.succeed(IO, service), state };
};

/** A ready-to-use IO fake Layer with default settings. */
export const IOFake: Layer.Layer<IO> = makeIOFake().layer;
