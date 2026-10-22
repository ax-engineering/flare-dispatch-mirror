// Tests for the verdict reconcile sweep — driven through in-memory ports.

import type { CheckConcludeOptions, CheckDelivery } from "@fractalboxdev/flare-dispatch-core";
import { describe, expect, it, vi } from "vitest";
import {
  conclusionFor,
  DELIVERY_GRACE_MS,
  DELIVERY_MAX_AGE_MS,
  DELIVERY_SWEEP_LIMIT,
  type DeliverySweepPorts,
  sweepUndelivered,
  type UndeliveredRow,
} from "./delivery-sweep";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

const row = (over: Partial<UndeliveredRow> = {}): UndeliveredRow => ({
  id: "exec-1",
  run: "oxlint",
  repo: "owner/name",
  sha: "abc123",
  status: "success",
  attempt: 1,
  inputJson: "{}",
  checkRunId: "77",
  installationId: 1,
  completedAt: NOW - DELIVERY_GRACE_MS - 1,
  ...over,
});

/** In-memory ports over `rows`; `answer` decides each conclude. */
const makePorts = (
  rows: UndeliveredRow[],
  answer: (installationId: number, opts: CheckConcludeOptions) => CheckDelivery = (_, opts) => ({
    _tag: "delivered",
    checkRunId: opts.checkRunId === "noop" ? "9001" : opts.checkRunId,
  }),
) => {
  const concluded: { installationId: number; opts: CheckConcludeOptions }[] = [];
  const marked: { id: string; checkRunId: string; at: number }[] = [];
  const refusedRows: { id: string; at: number }[] = [];
  const listUndelivered = vi.fn<DeliverySweepPorts["listUndelivered"]>(
    async ({ completedBefore, completedAfter, limit }) =>
      rows
        .filter((r) => r.completedAt < completedBefore && r.completedAt >= completedAfter)
        .sort((a, b) => a.completedAt - b.completedAt)
        .slice(0, limit),
  );
  const ports: DeliverySweepPorts = {
    listUndelivered,
    conclude: async (installationId, opts) => {
      concluded.push({ installationId, opts });
      return answer(installationId, opts);
    },
    markDelivered: async (id, checkRunId, at) => {
      marked.push({ id, checkRunId, at });
    },
    markRefused: async (id, at) => {
      refusedRows.push({ id, at });
    },
    now: () => NOW,
  };
  return { ports, concluded, marked, refusedRows, listUndelivered };
};

describe("sweepUndelivered", () => {
  it("asks for rows past the grace period and inside the max age, oldest first, bounded", async () => {
    const { ports, listUndelivered } = makePorts([]);
    await sweepUndelivered(ports);
    expect(listUndelivered).toHaveBeenCalledWith({
      completedBefore: NOW - DELIVERY_GRACE_MS,
      completedAfter: NOW - DELIVERY_MAX_AGE_MS,
      limit: DELIVERY_SWEEP_LIMIT,
    });
  });

  it("re-sends oldest first and stamps each delivered row", async () => {
    const { ports, concluded, marked } = makePorts([
      row({ id: "newer", completedAt: NOW - DELIVERY_GRACE_MS - 1 }),
      row({ id: "older", completedAt: NOW - DELIVERY_GRACE_MS - 60_000 }),
    ]);

    const result = await sweepUndelivered(ports);

    expect(concluded.map((c) => c.opts.output?.summary.includes("older") ?? false)).toEqual([
      true,
      false,
    ]);
    expect(marked.map((m) => m.id)).toEqual(["older", "newer"]);
    expect(result).toEqual({ delivered: 2, undelivered: 0, refused: 0, deferred: 0 });
  });

  it("records the check-run created at conclusion for a row whose opener degraded", async () => {
    const { ports, concluded, marked } = makePorts([row({ checkRunId: "noop" })]);
    await sweepUndelivered(ports);
    expect(concluded[0]!.opts.checkRunId).toBe("noop");
    expect(marked).toEqual([{ id: "exec-1", checkRunId: "9001", at: NOW }]);
  });

  it("stops an installation at its first refusal and keeps sending for the others", async () => {
    const { ports, concluded, marked } = makePorts(
      [
        row({ id: "a1", installationId: 1, completedAt: NOW - DELIVERY_GRACE_MS - 3 }),
        row({ id: "b1", installationId: 2, completedAt: NOW - DELIVERY_GRACE_MS - 2 }),
        row({ id: "a2", installationId: 1, completedAt: NOW - DELIVERY_GRACE_MS - 1 }),
      ],
      (installationId, opts) =>
        installationId === 1
          ? { _tag: "undelivered", reason: "installation quota exhausted" }
          : { _tag: "delivered", checkRunId: opts.checkRunId },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sweepUndelivered(ports);

    expect(concluded.map((c) => c.installationId)).toEqual([1, 2]);
    expect(marked.map((m) => m.id)).toEqual(["b1"]);
    expect(result).toEqual({ delivered: 1, undelivered: 1, refused: 0, deferred: 1 });
  });

  it("takes a refused row out of the queue without holding up its installation", async () => {
    const { ports, concluded, marked, refusedRows } = makePorts(
      [
        row({ id: "gone", installationId: 1, sha: "dead", completedAt: NOW - DELIVERY_GRACE_MS - 2 }),
        row({ id: "next", installationId: 1, completedAt: NOW - DELIVERY_GRACE_MS - 1 }),
      ],
      (_, opts) =>
        opts.sha === "dead"
          ? { _tag: "refused", reason: "HTTP 404" }
          : { _tag: "delivered", checkRunId: opts.checkRunId },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sweepUndelivered(ports);

    expect(concluded.map((c) => c.opts.sha)).toEqual(["dead", "abc123"]);
    expect(refusedRows).toEqual([{ id: "gone", at: NOW }]);
    expect(marked.map((m) => m.id)).toEqual(["next"]);
    expect(result).toEqual({ delivered: 1, undelivered: 0, refused: 1, deferred: 0 });
  });

  it("counts a rejected conclude as undelivered and a failed stamp as delivered", async () => {
    const { ports } = makePorts([row({ id: "x", installationId: 1 }), row({ id: "y", installationId: 2 })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sweepUndelivered({
      ...ports,
      conclude: async (installationId, opts) => {
        if (installationId === 1) throw new Error("boom");
        return { _tag: "delivered", checkRunId: opts.checkRunId };
      },
      markDelivered: async () => {
        throw new Error("d1 down");
      },
    });
    expect(result).toEqual({ delivered: 1, undelivered: 1, refused: 0, deferred: 0 });
    expect(warn).toHaveBeenCalled();
  });
});

describe("conclusionFor", () => {
  it("names, titles and concludes the check-run as the workflow does", () => {
    const opts = conclusionFor(
      row({ run: "check", inputJson: JSON.stringify({ checkLabel: "lint" }), attempt: 2, status: "skipped" }),
    );
    expect(opts).toMatchObject({
      repo: "owner/name",
      sha: "abc123",
      name: "flare-dispatch/check:lint",
      checkRunId: "77",
      conclusion: "neutral",
      output: { title: "flare-dispatch/check:lint (attempt 2)" },
    });
    expect(opts.output?.summary).toContain("⊘ check — skipped.");
  });

  it("names a row with unreadable inputs without a label", () => {
    expect(conclusionFor(row({ inputJson: "{not json" })).name).toBe("flare-dispatch/oxlint");
  });

  it("concludes a failed execution as failure", () => {
    expect(conclusionFor(row({ status: "failure" })).conclusion).toBe("failure");
  });
});
