import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { contextfulGate } from "@fractalboxdev/flare-dispatch-runs";
import {
  CLOSE_MARKER_PREFIX,
  closeGroup,
  closeInstanceId,
  closeMarkerId,
  closedGroups,
  isCloseGroupPayload,
  isCloseMarker,
} from "./pr-close";
import { triggersByEvent } from "./registry";
import { supersededSummary } from "./supersede";

const REPO = "fractalboxdev/contextful";
const closedPayload = (over: { merged?: boolean; headRepo?: string; action?: string } = {}) => ({
  action: over.action ?? "closed",
  repository: { full_name: REPO },
  installation: { id: 77 },
  pull_request: {
    number: 42,
    merged: over.merged ?? true,
    updated_at: "2026-10-19T10:00:05Z",
    head: { sha: "a".repeat(40), repo: { full_name: over.headRepo ?? REPO } },
    base: { sha: "b".repeat(40) },
  },
});

describe("closedGroups", () => {
  const matches = triggersByEvent("pull_request");

  it("names the gate's group, ranked one millisecond after the close, for a merged or unmerged close", () => {
    expect(matches.some(({ run }) => run.name === contextfulGate.name)).toBe(true);
    for (const merged of [true, false]) {
      expect(closedGroups("pull_request", closedPayload({ merged }), matches, 0)).toEqual([
        { group: `contextful-gate:${REPO}#42`, rank: Date.parse("2026-10-19T10:00:05Z") + 1 },
      ]);
    }
  });

  it("ranks the marker above a gate for a push in the close's own second", () => {
    // GitHub reports `updated_at` to the second: a landing's push and merge can share it.
    const push = { ...closedPayload(), action: "synchronize" };
    const gateRank = contextfulGate.supersede?.(contextfulGate.triggers![0]!.inputs({ payload: push }))?.order;
    const [close] = closedGroups("pull_request", closedPayload(), matches, 0);
    expect(gateRank).toBe(Date.parse("2026-10-19T10:00:05Z"));
    expect(close!.rank).toBeGreaterThan(gateRank!);
  });

  it("ends nothing for another action, another event, or a payload the trigger's gate refuses", () => {
    expect(closedGroups("pull_request", closedPayload({ action: "synchronize" }), matches, 0)).toEqual([]);
    expect(closedGroups("push", closedPayload(), matches, 0)).toEqual([]);
    expect(closedGroups("pull_request", closedPayload({ headRepo: "fork/contextful" }), matches, 0)).toEqual([]);
  });
});

describe("closeGroup", () => {
  const harness = (registration: { superseded: readonly string[]; supersededBy?: string }) => {
    const steps: string[] = [];
    const cancelled: Array<{ root: string; marker: string }> = [];
    const registered: Array<{ id: string; group: string; supersedeOlder: boolean; rank?: number }> = [];
    const ports = {
      stepDo: <T>(name: string, body: () => Promise<T>) =>
        Effect.promise(async () => { steps.push(name); return body(); }),
      store: {
        register: (id: string, group: string, opts: { supersedeOlder: boolean; rank?: number }) =>
          Effect.sync(() => {
            registered.push({ id, group, ...opts });
            return { superseded: registration.superseded, supersededBy: registration.supersededBy };
          }),
      },
      cancelTree: (root: string, marker: string) => Effect.sync(() => { cancelled.push({ root, marker }); }),
    };
    return { ports, steps, cancelled, registered };
  };

  it("registers a marker ranked at the close and cancels each superseded tree in its own checkpoint", async () => {
    const h = harness({ superseded: ["gate-1", "gate-2"] });
    const ids = await Effect.runPromise(closeGroup({ group: "g", rank: 5 }, h.ports));
    const marker = closeMarkerId("g", 5);
    expect(ids).toEqual(["gate-1", "gate-2"]);
    expect(h.registered).toEqual([{ id: marker, group: "g", supersedeOlder: true, rank: 5 }]);
    expect(h.steps).toEqual(["close-register", "close-cancel-0", "close-cancel-1"]);
    expect(h.cancelled).toEqual([{ root: "gate-1", marker }, { root: "gate-2", marker }]);
  });

  it("cancels nothing once a reopen outranks the close", async () => {
    const h = harness({ superseded: [], supersededBy: "gate-reopened" });
    expect(await Effect.runPromise(closeGroup({ group: "g", rank: 5 }, h.ports))).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it("concludes a cancelled tree's checks as a closed pull request, not a newer revision", () => {
    const marker = closeMarkerId("g", 5);
    expect(marker.startsWith(CLOSE_MARKER_PREFIX)).toBe(true);
    expect(isCloseMarker(marker)).toBe(true);
    expect(isCloseMarker("contextful-gate_42")).toBe(false);
    expect(supersededSummary(marker)).toBe("⊘ Cancelled — pull request closed.");
    expect(closeMarkerId("g", 5)).not.toBe(closeMarkerId("g", 6));
  });

  it("decodes the close payload and keeps instance ids valid and per-close", () => {
    expect(isCloseGroupPayload({ closeGroup: { group: "g", rank: 1, repo: REPO, installation_id: 7 } })).toBe(true);
    expect(isCloseGroupPayload({ executionId: "x", run: "check" })).toBe(false);
    const id = closeInstanceId(`contextful-gate:${REPO}#42`, 1_760_000_000_000);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(closeInstanceId(`contextful-gate:${REPO}#42`, 1_760_000_000_001)).not.toBe(id);
  });
});
