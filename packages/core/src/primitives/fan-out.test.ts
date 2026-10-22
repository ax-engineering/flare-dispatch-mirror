import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeChildRunsFake } from "../testing";
import { fanOut } from "./fan-out";

/** Run `fanOut` against a fresh ChildRuns fake, returning handles + spawn log. */
const runFanOut = async <T>(
  opts: Parameters<typeof fanOut<T>>[0],
  fakeOpts?: Parameters<typeof makeChildRunsFake>[0],
) => {
  const child = makeChildRunsFake(fakeOpts);
  const handles = await Effect.runPromise(fanOut(opts).pipe(Effect.provide(child.layer)));
  return { handles, spawned: child.state.spawned };
};

describe("fanOut", () => {
  it("spawns one child per item, in order, with mapped inputs + shard coords", async () => {
    const { handles, spawned } = await runFanOut({
      run: "playwright-e2e-shard",
      items: ["a", "b", "c"],
      toInput: (item, shard) => ({ item, index: shard.index, total: shard.total }),
    });

    expect(spawned).toHaveLength(3);
    expect(spawned.map((s) => s.run)).toEqual([
      "playwright-e2e-shard",
      "playwright-e2e-shard",
      "playwright-e2e-shard",
    ]);
    // 1-based shard index, total threaded through `toInput`.
    expect(spawned.map((s) => s.input)).toEqual([
      { item: "a", index: 1, total: 3 },
      { item: "b", index: 2, total: 3 },
      { item: "c", index: 3, total: 3 },
    ]);
    // Handles returned in item order, all freshly created.
    expect(handles).toHaveLength(3);
    expect(handles.every((h) => h.created)).toBe(true);
    expect(handles.every((h) => h.executionId === h.instanceId)).toBe(true);
  });

  it("uses an explicit instance id when `toInstanceId` is supplied", async () => {
    const { handles, spawned } = await runFanOut({
      run: "pr-review",
      items: [{ pr: 42 }, { pr: 7 }],
      toInput: (item) => item,
      toInstanceId: (item) => `pr-review:owner_name:${item.pr}`,
    });

    expect(spawned.map((s) => s.instanceId)).toEqual([
      "pr-review:owner_name:42",
      "pr-review:owner_name:7",
    ]);
    expect(handles.map((h) => h.instanceId)).toEqual([
      "pr-review:owner_name:42",
      "pr-review:owner_name:7",
    ]);
  });

  it("reports created: false for an instance id that already exists (idempotent re-spawn)", async () => {
    const { handles } = await runFanOut(
      {
        run: "pr-review",
        items: [{ pr: 42 }, { pr: 7 }],
        toInput: (item) => item,
        toInstanceId: (item) => `pr-review:owner_name:${item.pr}`,
      },
      { existing: ["pr-review:owner_name:42"] },
    );

    // The pre-seeded id collapses to a no-op; the fresh one is created.
    expect(handles.map((h) => h.created)).toEqual([false, true]);
  });

  it("is a no-op for an empty item list", async () => {
    const { handles, spawned } = await runFanOut({
      run: "noop",
      items: [] as readonly string[],
      toInput: (item) => item,
    });
    expect(handles).toEqual([]);
    expect(spawned).toEqual([]);
  });
});

describe("fanOut — the spend gate (ADR-0006)", () => {
  const reason = "spend budget reached: $90.00 of $90.00 this month";

  it("skips and spawns no child once the monthly budget is reached", async () => {
    const child = makeChildRunsFake({ spendClosed: reason });
    const error = await Effect.runPromise(
      fanOut({ run: "check", items: ["a", "b"], toInput: (item) => ({ item }) }).pipe(
        Effect.flip,
        Effect.provide(child.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "RunSkipped", reason });
    expect(child.state.spawned).toEqual([]);
  });

  it("spawns under the budget", async () => {
    const { spawned } = await runFanOut({ run: "check", items: ["a"], toInput: (item) => ({ item }) });
    expect(spawned).toHaveLength(1);
  });
});
