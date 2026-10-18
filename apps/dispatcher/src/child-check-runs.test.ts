import { Effect } from "effect";
import type { ChecksService } from "@fractalboxdev/flare-dispatch-core";
import { describe, expect, it } from "vitest";
import { concludeOpenChildCheckRuns, type ChildCheckRunRow } from "./child-check-runs";

type Status = "completed" | "open" | "unknown";

const fakeChecks = (statuses: Record<string, Status>) => {
  const updates: Parameters<ChecksService["update"]>[0][] = [];
  const reads: string[] = [];
  const checks: Pick<ChecksService, "status" | "update"> = {
    status: ({ checkRunId }) =>
      Effect.sync(() => {
        reads.push(checkRunId);
        return statuses[checkRunId] ?? "unknown";
      }),
    update: (opts) =>
      Effect.sync(() => {
        updates.push(opts);
      }),
  };
  return { checks, updates, reads };
};

const row = (r: Partial<ChildCheckRunRow> & { id: string }): ChildCheckRunRow => ({
  repo: "owner/name",
  status: "success",
  checkRunId: `cr-${r.id}`,
  ...r,
});

describe("concludeOpenChildCheckRuns", () => {
  it("leaves a completed child check-run untouched", async () => {
    const { checks, updates } = fakeChecks({ "cr-a": "completed" });
    await Effect.runPromise(concludeOpenChildCheckRuns([row({ id: "a" })], checks));
    expect(updates).toEqual([]);
  });

  it("concludes a still-open child with the verdict its row records", async () => {
    const { checks, updates } = fakeChecks({ "cr-a": "open", "cr-b": "open", "cr-c": "open" });
    const concluded = await Effect.runPromise(
      concludeOpenChildCheckRuns(
        [
          row({ id: "a", status: "failure" }),
          row({ id: "b", status: "success" }),
          row({ id: "c", status: "skipped" }),
        ],
        checks,
      ),
    );
    expect(concluded).toEqual(["a", "b", "c"]);
    expect(updates.map((u) => [u.checkRunId, u.conclusion])).toEqual([
      ["cr-a", "failure"],
      ["cr-b", "success"],
      ["cr-c", "neutral"],
    ]);
  });

  it("concludes an unsettled child as failure, saying the parent closed first", async () => {
    const { checks, updates } = fakeChecks({ "cr-a": "open" });
    await Effect.runPromise(
      concludeOpenChildCheckRuns([row({ id: "a", status: "running" })], checks),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.conclusion).toBe("failure");
    expect(updates[0]!.output?.summary).toMatch(/parent closed before this part settled/);
  });

  it("skips a child with no real check-run or an unreadable one", async () => {
    const { checks, updates, reads } = fakeChecks({});
    await Effect.runPromise(
      concludeOpenChildCheckRuns(
        [
          row({ id: "a", checkRunId: null }),
          row({ id: "b", checkRunId: "noop" }),
          row({ id: "c", status: "running" }),
        ],
        checks,
      ),
    );
    expect(reads).toEqual(["cr-c"]);
    expect(updates).toEqual([]);
  });

  it("never fails when a check-run read or write dies", async () => {
    const checks: Pick<ChecksService, "status" | "update"> = {
      status: () => Effect.die(new Error("GitHub down")),
      update: () => Effect.die(new Error("GitHub down")),
    };
    await expect(
      Effect.runPromise(concludeOpenChildCheckRuns([row({ id: "a" })], checks)),
    ).resolves.toEqual([]);
  });
});
