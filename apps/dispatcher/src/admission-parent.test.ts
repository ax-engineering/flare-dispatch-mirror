import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  claimUnlessParentEnded,
  isParentEnded,
  leaveQueueForEndedParent,
  parentEndedSummary,
  parentHasEnded,
} from "./admission-parent";

describe("parentHasEnded", () => {
  it("ends queued children for every terminal parent status, and only those", () => {
    for (const status of ["success", "failure", "skipped", "cancelled"]) expect(parentHasEnded(status)).toBe(true);
    for (const status of ["running", "queued", undefined]) expect(parentHasEnded(status)).toBe(false);
  });
});

describe("claimUnlessParentEnded", () => {
  const claimed = { admitted: false, position: 3, poolBusy: 16, now: 1 };
  const joinsChildren = (run: string) => run === "contextful-gate";

  it("skips the claim once a joining parent's row is terminal", async () => {
    let claims = 0;
    const observed = await claimUnlessParentEnded({
      parentExecutionId: "gate",
      parentRow: async () => ({ status: "cancelled", run: "contextful-gate" }),
      joinsChildren,
      claim: async () => { claims++; return claimed; },
    });
    expect(observed).toEqual({ parentEnded: "cancelled" });
    expect(isParentEnded(observed)).toBe(true);
    expect(claims).toBe(0);
  });

  it("claims while the parent runs, for a top-level run, and when the parent read fails or finds no row", async () => {
    for (const opts of [
      { parentExecutionId: "gate", parentRow: async () => ({ status: "running", run: "contextful-gate" }) },
      { parentExecutionId: undefined, parentRow: async () => ({ status: "cancelled", run: "contextful-gate" }) },
      { parentExecutionId: "gate", parentRow: async () => { throw new Error("D1 down"); } },
      { parentExecutionId: "gate", parentRow: async () => undefined },
    ]) {
      const observed = await claimUnlessParentEnded({ ...opts, joinsChildren, claim: async () => claimed });
      expect(observed).toBe(claimed);
      expect(isParentEnded(observed)).toBe(false);
    }
  });

  it("claims for a fire-and-forget child whose parent has ended, success or not", async () => {
    // product-demo spawns demo-reel and returns without waiting on it.
    for (const status of ["success", "failure", "cancelled"]) {
      const observed = await claimUnlessParentEnded({
        parentExecutionId: "demo",
        parentRow: async () => ({ status, run: "product-demo" }),
        joinsChildren,
        claim: async () => claimed,
      });
      expect(observed).toBe(claimed);
    }
  });
});

describe("leaveQueueForEndedParent", () => {
  it("cancels its own rows in one checkpoint, concludes its check cancelled, and skips", async () => {
    const events: string[] = [];
    const exit = await Effect.runPromiseExit(
      leaveQueueForEndedParent(
        { executionId: "part-a", parentExecutionId: "gate", parentStatus: "failure" },
        {
          stepDo: (name, body) => Effect.promise(async () => { events.push(`step:${name}`); return body(); }),
          store: { cancel: (ids) => Effect.sync(() => { events.push(`cancel:${ids.join(",")}`); }) },
          concludeCancelled: (summary) => Effect.sync(() => { events.push(`conclude:${summary}`); }),
        },
      ),
    );
    expect(events).toEqual([
      "step:admission-parent-ended",
      "cancel:part-a",
      `conclude:${parentEndedSummary("gate", "failure")}`,
    ]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("parent gate ended failure");
  });
});
