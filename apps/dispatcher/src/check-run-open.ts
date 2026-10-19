// One check-run per execution.
//
// `RunWorkflow.run` re-executes from the top on every engine replay. Opened
// outside a durable step, each replay posted a fresh `in_progress` check-run;
// GitHub renders the newest per name, so a replay that never reached the
// terminal update left the visible check running forever. The id is a durable
// step result instead, and every replay reuses it.

import { Effect } from "effect";

/** A raw durable step as an Effect — `RunWorkflow`'s `stepDo`. */
export type StepDo = <T>(name: string, body: () => Promise<T>) => Effect.Effect<T>;

/** Open the execution's check-run once; a replay reads back the same id. */
export const openCheckRun = (
  stepDo: StepDo,
  create: Effect.Effect<string>,
): Effect.Effect<string> => stepDo("open-check-run", () => Effect.runPromise(create));

/** Publish the id before reconciling a cancellation that raced check creation. */
export const persistCheckRunId = (
  checkRunId: string,
  ports: {
    readonly persist: (id: string) => Effect.Effect<void>;
    readonly status: Effect.Effect<string | undefined, Error>;
    readonly cancel: (id: string) => Effect.Effect<void>;
  },
): Effect.Effect<boolean, Error> => Effect.gen(function* () {
  yield* ports.persist(checkRunId);
  if ((yield* ports.status) !== "cancelled") return true;
  yield* ports.cancel(checkRunId);
  return false;
});
