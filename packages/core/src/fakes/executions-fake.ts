// @fractalboxdev/flare-dispatch-core — Executions fake.
//
// In-memory stand-in for the D1 `executions` + `steps` tables. Every
// `startStep` / `finishStep` mutates an in-memory `steps` array; tests assert
// on it directly — e.g. "one start + one end record per step name".
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/05-byoc.md § D1 schema.

import { Effect, Layer } from "effect";
import {
  type ExecutionRecord,
  Executions,
  type ExecutionsService,
  type StepRecord,
} from "../services/executions";

/** Inspectable in-memory tables — surfaced for test assertions. */
export type ExecutionsFakeState = {
  readonly executions: ExecutionRecord[];
  readonly steps: StepRecord[];
};

const findStep = (steps: StepRecord[], executionId: string, name: string): number =>
  steps.findIndex((s) => s.executionId === executionId && s.name === name);

/** Build an Executions fake plus an inspectable handle over its tables. */
export const makeExecutionsFake = (): {
  layer: Layer.Layer<Executions>;
  state: ExecutionsFakeState;
} => {
  const state: ExecutionsFakeState = { executions: [], steps: [] };

  const service: ExecutionsService = {
    startExecution: ({ id, run, startedAt, parentExecutionId, attempt, retryOf }) =>
      Effect.sync(() => {
        state.executions.push({
          id,
          run,
          startedAt,
          ...(parentExecutionId !== undefined ? { parentExecutionId } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
          ...(retryOf !== undefined ? { retryOf } : {}),
        });
      }),

    finishExecution: ({ id, completedAt, status }) =>
      Effect.sync(() => {
        const idx = state.executions.findIndex((e) => e.id === id);
        if (idx >= 0 && state.executions[idx]?.status === undefined) {
          state.executions[idx] = {
            ...state.executions[idx]!,
            completedAt,
            status,
          };
          return true;
        }
        return false;
      }),

    startStep: ({ executionId, name, startedAt, metadata }) =>
      Effect.sync(() => {
        state.steps.push({ executionId, name, startedAt, metadata });
      }),

    finishStep: ({ executionId, name, completedAt, status, errorTag }) =>
      Effect.sync(() => {
        const idx = findStep(state.steps, executionId, name);
        if (idx >= 0) {
          state.steps[idx] = {
            ...state.steps[idx]!,
            completedAt,
            status,
            errorTag,
          };
        }
      }),
  };

  return { layer: Layer.succeed(Executions, service), state };
};

/** A ready-to-use Executions fake Layer (its state is not externally visible). */
export const ExecutionsFake: Layer.Layer<Executions> = makeExecutionsFake().layer;
