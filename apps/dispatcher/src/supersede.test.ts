import { Effect, Exit } from "effect";
import type { ChecksService } from "@fractalboxdev/flare-dispatch-core";
import type { SupersededRow } from "@fractalboxdev/flare-dispatch-runtime-cf";
import { describe, expect, it, vi } from "vitest";
import {
  cancelSupersededTree,
  enterSupersession,
  standsDown,
  supersededSummary,
  withSupersessionRelease,
  type SupersessionPorts,
  type SupersedePorts,
} from "./supersede";

type Status = "completed" | "open" | "unknown";

const row = (id: string, over: Partial<SupersededRow> = {}): SupersededRow => ({
  id,
  run: id === "old-gate" ? "contextful-gate" : "check",
  repo: "owner/name",
  status: "running",
  checkRunId: `cr-${id}`,
  ...over,
});

const fixture = (tree: readonly SupersededRow[], statuses: Record<string, Status> = {}) => {
  const events: string[] = [];
  const updates: Parameters<ChecksService["update"]>[0][] = [];
  const ports: SupersedePorts = {
    store: {
      markCancelled: (id) => Effect.sync(() => { events.push(`mark:${id}`); }),
      status: () => Effect.succeed("cancelled"),
      openTree: (id) => Effect.sync(() => { events.push(`tree:${id}`); return tree; }),
      cancel: (ids) => Effect.sync(() => { events.push(`cancel:${ids.join(",")}`); return { admittedSlots: 0 }; }),
    },
    terminate: async (id) => {
      events.push(`terminate:${id}`);
    },
    destroySandbox: async (r) => { events.push(`destroy:${r.id}`); },
    checks: {
      status: ({ checkRunId }) => Effect.succeed(statuses[checkRunId] ?? "open"),
      update: (opts) => Effect.sync(() => { updates.push(opts); }),
    },
  };
  return { ports, events, updates };
};

describe("cancelSupersededTree", () => {
  it("marks the root before reading its tree, then ends and frees every open row", async () => {
    const tree = [row("old-gate", { status: "cancelled" }), row("part-a"), row("part-b", { status: "queued" })];
    const { ports, events } = fixture(tree);
    const ids = await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "g", ports));
    expect(ids).toEqual(["old-gate", "part-a", "part-b"]);
    expect(events.slice(0, 4)).toEqual(["mark:old-gate", "tree:old-gate", "terminate:old-gate", "tree:old-gate"]);
    expect(events).toContain("terminate:part-a");
    expect(events).toContain("terminate:part-b");
    expect(events).toContain("destroy:part-b");
    expect(events.indexOf("cancel:old-gate,part-a,part-b")).toBeGreaterThan(events.indexOf("terminate:part-b"));
  });

  it("concludes every open check-run of the tree cancelled, naming the newer execution", async () => {
    const tree = [row("old-gate"), row("part-a"), row("part-done"), row("part-noop", { checkRunId: "noop" })];
    const { ports, updates } = fixture(tree, { "cr-part-done": "completed" });
    await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "g", ports));
    expect(updates.map((u) => [u.checkRunId, u.conclusion])).toEqual([
      ["cr-old-gate", "cancelled"],
      ["cr-part-a", "cancelled"],
    ]);
    expect(updates[0]?.output?.summary).toBe(supersededSummary("new-gate"));
    expect(supersededSummary("new-gate")).toContain("`new-gate`");
  });

  it("logs one supersede.cancelled line counting the children, admitted slots and check-runs it ended", async () => {
    const tree = [row("old-gate"), row("part-a"), row("part-done"), row("part-noop", { checkRunId: "noop" })];
    const { ports } = fixture(tree, { "cr-part-done": "completed" });
    const counted: SupersedePorts = { ...ports, store: { ...ports.store, cancel: () => Effect.succeed({ admittedSlots: 2 }) } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "contextful-gate:o/r#7", counted));
      const lines = log.mock.calls
        .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined))
        .filter((line) => line?.event === "supersede.cancelled");
      expect(lines).toEqual([
        {
          event: "supersede.cancelled",
          group: "contextful-gate:o/r#7",
          root: "old-gate",
          supersededBy: "new-gate",
          children: 3,
          admittedSlots: 2,
          checkRuns: 2,
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("retries cleanup for a root already marked cancelled", async () => {
    const { ports, events } = fixture([row("gone")]);
    const exit = await Effect.runPromiseExit(cancelSupersededTree("gone", "new-gate", "g", ports));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toContain("cancel:gone");
  });

  it("fails when the D1 cancel fails, so the step retries the whole sequence", async () => {
    const { ports } = fixture([row("old-gate")]);
    const failing: SupersedePorts = { ...ports, store: { ...ports.store, cancel: () => Effect.fail(new Error("D1 down")) } };
    expect(Exit.isFailure(await Effect.runPromiseExit(cancelSupersededTree("old-gate", "new-gate", "g", failing)))).toBe(true);
  });

  it("leaves rows and check-runs untouched when termination fails", async () => {
    const { ports, events, updates } = fixture([row("old-gate"), row("part-a")]);
    const failing: SupersedePorts = { ...ports, terminate: async () => { throw new Error("unavailable"); } };
    expect(Exit.isFailure(await Effect.runPromiseExit(cancelSupersededTree("old-gate", "new-gate", "g", failing)))).toBe(true);
    expect(events).not.toContain("cancel:old-gate,part-a");
    expect(updates).toEqual([]);
  });

  it("does not cancel descendants of a root that already finished", async () => {
    const { ports, events } = fixture([row("old-gate", { status: "success" }), row("part-a")]);
    const finished: SupersedePorts = { ...ports, store: { ...ports.store, status: () => Effect.succeed("success") } };
    expect(await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "g", finished))).toEqual([]);
    expect(events).toEqual(["mark:old-gate"]);
  });

  it("keeps the opener alive until its check id is persisted, then cancels it on retry", async () => {
    const tree = [row("old-gate", { checkRunId: null })];
    const { ports, events, updates } = fixture(tree);
    expect(Exit.isFailure(await Effect.runPromiseExit(cancelSupersededTree("old-gate", "new-gate", "g", ports)))).toBe(true);
    expect(events).not.toContain("terminate:old-gate");
    expect(updates).toEqual([]);
    tree[0] = row("old-gate", { status: "cancelled" });
    await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "g", ports));
    expect(updates[0]?.conclusion).toBe("cancelled");
  });

  it("finds descendants spawned during termination and claims them before stopping them", async () => {
    const tree = [row("old-gate"), row("part-a")];
    const { ports, events } = fixture(tree);
    const spawning: SupersedePorts = { ...ports, terminate: async (id) => {
      events.push(`terminate:${id}`);
      if (id === "part-a") tree.push(row("grandchild"));
    } };
    expect(await Effect.runPromise(cancelSupersededTree("old-gate", "new-gate", "g", spawning))).toEqual(["old-gate", "part-a", "grandchild"]);
    expect(events.indexOf("mark:grandchild")).toBeLessThan(events.indexOf("terminate:grandchild"));
    expect(events).toContain("cancel:old-gate,part-a,grandchild");
  });
});

describe("standsDown", () => {
  it("stands a child down only when its parent was cancelled", () => {
    expect(standsDown("cancelled")).toBe(true);
    expect(standsDown("running")).toBe(false);
    expect(standsDown(undefined)).toBe(false);
  });
});

const prelude = (opts: {
  parentStatus?: string;
  superseded?: readonly string[];
  supersededBy?: string;
} = {}) => {
  const steps: string[] = [];
  const events: string[] = [];
  const registered: { id: string; group: string; supersedeOlder: boolean; rank?: number }[] = [];
  const ports: SupersessionPorts = {
    stepDo: (name, body) =>
      Effect.promise(async () => {
        steps.push(name);
        return body();
      }),
    store: {
      status: (id) => Effect.sync(() => (id === "parent" ? opts.parentStatus : undefined)),
      cancel: (ids) => Effect.sync(() => { events.push(`cancel:${ids.join(",")}`); return { admittedSlots: 0 }; }),
      register: (id, group, o) =>
        Effect.sync(() => {
          registered.push({ id, group, ...o });
          return o.supersedeOlder
            ? { superseded: opts.superseded ?? [], supersededBy: opts.supersededBy }
            : { superseded: [], supersededBy: undefined };
        }),
    },
    cancelTree: (olderId) => Effect.sync(() => { events.push(`cancel-tree:${olderId}`); }),
    concludeCancelled: (summary) => Effect.sync(() => { events.push(`conclude:${summary}`); }),
  };
  return { ports, steps, events, registered };
};

describe("enterSupersession", () => {
  it("a child of a cancelled parent cancels itself and concludes its check before queuing", async () => {
    const f = prelude({ parentStatus: "cancelled" });
    const outcome = await Effect.runPromise(
      enterSupersession({ executionId: "child", parentExecutionId: "parent", spec: undefined }, f.ports),
    );
    expect(outcome).toBe("stood-down");
    expect(f.steps).toEqual(["parent-status", "stand-down"]);
    expect(f.events).toEqual(["cancel:child", `conclude:${supersededSummary("parent")}`]);
  });

  it("a child of a live parent proceeds without joining any group", async () => {
    const f = prelude({ parentStatus: "running" });
    expect(
      await Effect.runPromise(
        enterSupersession({ executionId: "child", parentExecutionId: "parent", spec: undefined }, f.ports),
      ),
    ).toBe("proceed");
    expect(f.steps).toEqual(["parent-status"]);
    expect(f.registered).toEqual([]);
  });

  it("cancels every superseded tree, one checkpoint each, before it returns to admission", async () => {
    const f = prelude({ superseded: ["gate-1", "gate-2"] });
    const outcome = await Effect.runPromise(
      enterSupersession(
        { executionId: "gate-3", spec: { group: "g", order: 3_000 } },
        f.ports,
      ).pipe(Effect.tap(() => f.ports.stepDo("admission-enqueue", async () => null))),
    );
    expect(outcome).toBe("proceed");
    expect(f.registered).toEqual([{ id: "gate-3", group: "g", supersedeOlder: true, rank: 3_000 }]);
    expect(f.steps).toEqual([
      "supersede-register",
      "supersede-cancel-0",
      "supersede-cancel-1",
      "admission-enqueue",
    ]);
    expect(f.events).toEqual(["cancel-tree:gate-1", "cancel-tree:gate-2"]);
  });

  it("a re-run joins the group without superseding anything", async () => {
    const f = prelude({ superseded: ["gate-1"], supersededBy: "gate-9" });
    const outcome = await Effect.runPromise(
      enterSupersession({ executionId: "gate-r", retryOf: "gate-1", spec: { group: "g" } }, f.ports),
    );
    expect(outcome).toBe("proceed");
    expect(f.registered).toEqual([{ id: "gate-r", group: "g", supersedeOlder: false }]);
    expect(f.events).toEqual([]);
  });

  it("a lower revision that registers after a higher one cancels itself, never the higher one", async () => {
    const f = prelude({ supersededBy: "gate-h2" });
    const outcome = await Effect.runPromise(
      enterSupersession({ executionId: "gate-h1", spec: { group: "g", order: 1_000 } }, f.ports),
    );
    expect(outcome).toBe("stood-down");
    expect(f.steps).toEqual(["supersede-register", "stand-down"]);
    expect(f.events).toEqual(["cancel:gate-h1", `conclude:${supersededSummary("gate-h2")}`]);
  });
});

describe("withSupersessionRelease", () => {
  const harness = (lost: boolean) => {
    const released: string[] = [];
    const wrap = <A, E>(body: Effect.Effect<A, E>) =>
      withSupersessionRelease(body, {
        joined: true,
        release: Effect.sync(() => { released.push("release"); }),
        lost: Effect.succeed(lost),
      });
    return { released, wrap };
  };

  it("leaves the group on success and on failure", async () => {
    const ok = harness(false);
    await Effect.runPromise(ok.wrap(Effect.succeed(1)));
    expect(ok.released).toEqual(["release"]);
    const failed = harness(false);
    const exit = await Effect.runPromiseExit(failed.wrap(Effect.fail("red")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failed.released).toEqual(["release"]);
  });

  it("keeps the row when the engine lost the instance, so the replay stays in the group", async () => {
    const lost = harness(true);
    await Effect.runPromiseExit(lost.wrap(Effect.die("engine interrupted")));
    expect(lost.released).toEqual([]);
  });

  it("releases nothing for an execution that never joined", async () => {
    const released: string[] = [];
    await Effect.runPromise(
      withSupersessionRelease(Effect.void, {
        joined: false,
        release: Effect.sync(() => { released.push("release"); }),
        lost: Effect.succeed(false),
      }),
    );
    expect(released).toEqual([]);
  });
});
