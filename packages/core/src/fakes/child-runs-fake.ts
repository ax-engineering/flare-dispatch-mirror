// @fractalboxdev/flare-dispatch-core — ChildRuns fake.
//
// In-memory stand-in for the child-Workflow `create` call. Every `spawn`
// appends a record to `state.spawned`; tests assert on it directly — e.g.
// "fanOut spawned 5 children with these inputs" or "a re-spawn of a seen id
// returns created: false". No Workflow binding, no network.
//
// Spec: specs/03-dsl.md § spawnChildRun, specs/pm/plan.md § 3 (fakes/).

import { Effect, Layer } from "effect";
import { ChildSpawnFailed } from "../errors";
import {
  type ChildRunStatus,
  ChildRuns,
  type ChildRunsService,
  type ChildStatusRecord,
  type SpawnChildRunOpts,
} from "../services/child-runs";

/** A recorded spawn — the resolved id, the original input, and the verdict. */
export type SpawnRecord = {
  readonly run: string;
  readonly input: unknown;
  readonly instanceId: string;
  readonly created: boolean;
};

/** Inspectable in-memory spawn + poll log — surfaced for test assertions. */
export type ChildRunsFakeState = {
  readonly spawned: SpawnRecord[];
  admissionHandoffs: number;
  /** number of `poll` calls so far — surfaced so a loop test can assert it. */
  polls: number;
};

/** A poll-status seed value — a bare status or a status + output. */
type StatusSeed = ChildRunStatus | { status: ChildRunStatus; summaryJson?: string };

/**
 * Build a ChildRuns fake plus an inspectable handle.
 *
 * `existing` seeds the set of instance ids treated as already-created, so a test
 * can assert the `created: false` dedup path. An explicit `instanceId` in the
 * spawn opts is used verbatim; absent, the fake derives a deterministic id from
 * the run name + spawn ordinal (the live layer hashes the input instead — the
 * fake's id only needs to be stable and unique within a test).
 */
export const makeChildRunsFake = (opts?: {
  existing?: Iterable<string>;
  /** Reject selected spawns before recording them, for partial fan-out tests. */
  failSpawn?: (opts: SpawnChildRunOpts) => boolean;
  /**
   * Static per-id poll statuses. An id absent from the map polls as `missing`.
   * For a loop test that flips `running → success`, supply `pollFn` instead.
   */
  statuses?: Record<string, StatusSeed>;
  /**
   * Dynamic poll override — receives the requested ids and the 0-based poll
   * call number, returns the records. Wins over `statuses` when set; lets a
   * test exercise `waitForChildren`'s loop (e.g. pending on call 0, terminal on
   * call 1).
   */
  pollFn?: (ids: readonly string[], call: number) => readonly ChildStatusRecord[];
}): { layer: Layer.Layer<ChildRuns>; state: ChildRunsFakeState } => {
  const state: ChildRunsFakeState = { spawned: [], polls: 0, admissionHandoffs: 0 };
  const seen = new Set<string>(opts?.existing ?? []);

  const seedToRecord = (id: string): ChildStatusRecord => {
    const seed = opts?.statuses?.[id];
    if (seed === undefined) return { executionId: id, status: "missing" };
    if (typeof seed === "string") return { executionId: id, status: seed };
    return {
      executionId: id,
      status: seed.status,
      ...(seed.summaryJson !== undefined ? { summaryJson: seed.summaryJson } : {}),
    };
  };

  const service: ChildRunsService = {
    handoffAdmission: () =>
      Effect.sync(() => {
        state.admissionHandoffs += 1;
      }),
    spawn: ({ run, input, instanceId }: SpawnChildRunOpts) => {
      if (opts?.failSpawn?.({ run, input, instanceId })) {
        return Effect.fail(
          new ChildSpawnFailed({ run, instanceId: instanceId ?? `${run}:rejected`, cause: "rejected" }),
        );
      }
      return Effect.sync(() => {
        const id = instanceId ?? `${run}:${state.spawned.length}`;
        const created = !seen.has(id);
        seen.add(id);
        state.spawned.push({ run, input, instanceId: id, created });
        return { executionId: id, instanceId: id, created };
      });
    },

    poll: ({ ids }) =>
      Effect.sync(() => {
        const call = state.polls;
        state.polls += 1;
        return opts?.pollFn !== undefined ? opts.pollFn(ids, call) : ids.map(seedToRecord);
      }),
  };

  return { layer: Layer.succeed(ChildRuns, service), state };
};

/** A ready-to-use ChildRuns fake Layer (its state is not externally visible). */
export const ChildRunsFake: Layer.Layer<ChildRuns> = makeChildRunsFake().layer;
