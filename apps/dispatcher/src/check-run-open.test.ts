import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { openCheckRun, persistCheckRunId } from "./check-run-open";

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
  it("concludes an opened check when cancellation wins before id persistence", async () => {
    let status = "running";
    const events: string[] = [];
    const id = await Effect.runPromise(openCheckRun(memoizingStepDo(), Effect.sync(() => {
      status = "cancelled";
      return "check-raced";
    })));
    const active = await Effect.runPromise(persistCheckRunId(id, {
      persist: (id) => Effect.sync(() => { events.push(`persist:${id}`); }),
      status: Effect.sync(() => status),
      cancel: (id) => Effect.sync(() => { events.push(`cancel:${id}`); }),
    }));
    expect(active).toBe(false);
    expect(events).toEqual(["persist:check-raced", "cancel:check-raced"]);
  });

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
