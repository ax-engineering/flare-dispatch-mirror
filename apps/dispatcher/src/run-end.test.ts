// What the workflow revokes when an execution's run body ends: the self-heal
// budget of an agent run, and the compile-cache writes of a run that holds a
// writable grant.

import { describe, expect, it, vi } from "vitest";
import { revokeAtRunEnd } from "./run-end";

const EXPIRES = 1_800_003_600;

const ports = () => {
  const kill = vi.fn(async () => {});
  const end = vi.fn(async (_: { executionId: string; expiresAt: number }) => {});
  return {
    kill,
    end,
    agentBudget: () => ({ kill }),
    ledger: (_repo: string) => ({ end }),
  };
};

describe("revokeAtRunEnd", () => {
  it("kills the agent budget of a self-heal run and nothing else", async () => {
    const p = ports();
    await revokeAtRunEnd({ engineInterrupted: false, agentBudgetArmed: true, executionId: "e", repo: "o/n" }, p);
    expect(p.kill).toHaveBeenCalledTimes(1);
    expect(p.end).not.toHaveBeenCalled();
  });

  it("ends a compile-cache run's writes without touching an agent budget it never armed", async () => {
    const p = ports();
    await revokeAtRunEnd(
      { engineInterrupted: false, agentBudgetArmed: false, executionId: "e", repo: "O/N", compileCache: { lane: "pr-7", expiresAt: EXPIRES } },
      p,
    );
    expect(p.kill).not.toHaveBeenCalled();
    expect(p.end).toHaveBeenCalledWith({ executionId: "e", expiresAt: EXPIRES });
  });

  it("has nothing to end for a read-only grant", async () => {
    const p = ports();
    await revokeAtRunEnd(
      { engineInterrupted: false, agentBudgetArmed: false, executionId: "e", repo: "o/n", compileCache: { lane: "read-only", expiresAt: EXPIRES } },
      p,
    );
    expect(p.end).not.toHaveBeenCalled();
  });

  it("revokes nothing when the engine interrupted the run, which resumes on replay", async () => {
    const p = ports();
    await revokeAtRunEnd(
      { engineInterrupted: true, agentBudgetArmed: true, executionId: "e", repo: "o/n", compileCache: { lane: "base", expiresAt: EXPIRES } },
      p,
    );
    expect(p.kill).not.toHaveBeenCalled();
    expect(p.end).not.toHaveBeenCalled();
  });

  it("swallows a failed revocation", async () => {
    const failing = {
      agentBudget: () => ({ kill: async () => Promise.reject(new Error("down")) }),
      ledger: () => ({ end: async () => Promise.reject(new Error("down")) }),
    };
    await expect(
      revokeAtRunEnd(
        { engineInterrupted: false, agentBudgetArmed: true, executionId: "e", repo: "o/n", compileCache: { lane: "base", expiresAt: EXPIRES } },
        failing,
      ),
    ).resolves.toBeUndefined();
  });
});
