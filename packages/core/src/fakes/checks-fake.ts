// @fractalboxdev/flare-dispatch-core — Checks fake.
//
// Records every GitHub check-run `create` / `update` call so tests can assert
// "one create with in_progress, one update with conclusion=success". `create`
// returns a deterministic incrementing check-run id.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/04-gha-integration.md.

import { Effect, Layer } from "effect";
import {
  type CheckConclusion,
  Checks,
  type ChecksService,
  type CheckOutput,
} from "../services/checks";

export type CheckCreateCall = {
  readonly checkRunId: string;
  readonly repo: string;
  readonly sha: string;
  readonly name: string;
  readonly output?: CheckOutput;
  readonly detailsUrl?: string;
};

export type CheckProgressCall = {
  readonly checkRunId: string;
  readonly repo: string;
  readonly output: CheckOutput;
  readonly detailsUrl?: string;
};

export type CheckUpdateCall = {
  readonly checkRunId: string;
  readonly repo: string;
  readonly conclusion: CheckConclusion;
  readonly output?: CheckOutput;
  readonly detailsUrl?: string;
};

/** Inspectable record of every check-run call. */
export type ChecksFakeState = {
  readonly creates: CheckCreateCall[];
  readonly progresses: CheckProgressCall[];
  readonly updates: CheckUpdateCall[];
};

/** Build a Checks fake plus an inspectable handle. */
export const makeChecksFake = (): {
  layer: Layer.Layer<Checks>;
  state: ChecksFakeState;
} => {
  const state: ChecksFakeState = { creates: [], progresses: [], updates: [] };
  let checkRunSeq = 0;

  const service: ChecksService = {
    create: ({ repo, sha, name, output, detailsUrl }) =>
      Effect.sync(() => {
        checkRunSeq += 1;
        const checkRunId = `fake-check-${checkRunSeq}`;
        state.creates.push({ checkRunId, repo, sha, name, output, detailsUrl });
        return checkRunId;
      }),

    progress: ({ repo, checkRunId, output, detailsUrl }) =>
      Effect.sync(() => {
        state.progresses.push({ checkRunId, repo, output, detailsUrl });
      }),

    // A check-run is completed once the fake recorded an update for it.
    status: ({ checkRunId }) =>
      Effect.sync(() =>
        state.creates.some((c) => c.checkRunId === checkRunId)
          ? state.updates.some((u) => u.checkRunId === checkRunId)
            ? "completed"
            : "open"
          : "unknown",
      ),

    update: ({ repo, checkRunId, conclusion, output, detailsUrl }) =>
      Effect.sync(() => {
        state.updates.push({ checkRunId, repo, conclusion, output, detailsUrl });
      }),

    conclude: ({ repo, checkRunId, conclusion, output, detailsUrl }) =>
      Effect.sync(() => {
        state.updates.push({ checkRunId, repo, conclusion, output, detailsUrl });
        return { _tag: "delivered", checkRunId } as const;
      }),
  };

  return { layer: Layer.succeed(Checks, service), state };
};

/** A ready-to-use Checks fake Layer. */
export const ChecksFake: Layer.Layer<Checks> = makeChecksFake().layer;
