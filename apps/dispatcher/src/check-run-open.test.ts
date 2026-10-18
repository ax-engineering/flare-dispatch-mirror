import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { openCheckRun } from "./check-run-open";

/** A durable step store that memoizes results by name, as an engine replay does. */
const memoizingStepDo = () => {
  const recorded = new Map<string, unknown>();
  return <T>(name: string, body: () => Promise<T>): Effect.Effect<T> =>
    Effect.promise(async () => {
      if (recorded.has(name)) return recorded.get(name) as T;
      const value = await body();
      recorded.set(name, value);
      return value;
    });
};

describe("openCheckRun", () => {
  it("posts one check-run per execution across replays", async () => {
    const stepDo = memoizingStepDo();
    let creates = 0;
    const create = Effect.sync(() => {
      creates += 1;
      return `check-${creates}`;
    });

    const first = await Effect.runPromise(openCheckRun(stepDo, create));
    const replayed = await Effect.runPromise(openCheckRun(stepDo, create));

    expect(creates).toBe(1);
    expect(replayed).toBe(first);
  });
});
