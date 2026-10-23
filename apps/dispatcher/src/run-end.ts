// FlareDispatch Dispatcher — capabilities the workflow revokes when an
// execution's run body ends.
//
// - The self-heal AgentBudget of an agent run: its capability token is
//   deterministic and non-expiring, so `kill` stops the post-run tail
//   (specs/08-self-healing.md § 6.3). Only a run that armed the budget calls
//   it.
// - The compile-cache writes of a run holding a writable lane: `end` in the
//   repository's ledger refuses the token's further PUTs, though the token
//   stays valid for reads until it expires.
//
// An engine interruption revokes nothing: the Workflow replays the run, and
// the replay needs both. Every revocation is best-effort; a failure leaves the
// budget's hard cap and the token's expiry as the bound.

import type { CompileCacheLane } from "@fractalboxdev/flare-dispatch-core/primitives";

export type RunEnd = {
  readonly engineInterrupted: boolean;
  /** The run armed the AgentBudget Durable Object at start. */
  readonly agentBudgetArmed: boolean;
  readonly executionId: string;
  readonly repo: string;
  /** The compile-cache grant the run was minted, if any. */
  readonly compileCache?: { readonly lane: CompileCacheLane; readonly expiresAt: number };
};

export type RunEndPorts = {
  readonly agentBudget: (executionId: string) => { kill(): Promise<void> } | undefined;
  readonly ledger: (
    repo: string,
  ) => { end(request: { readonly executionId: string; readonly expiresAt: number }): Promise<void> } | undefined;
};

export const revokeAtRunEnd = async (end: RunEnd, ports: RunEndPorts): Promise<void> => {
  if (end.engineInterrupted) return;
  if (end.agentBudgetArmed) await ports.agentBudget(end.executionId)?.kill().catch(() => {});
  if (end.compileCache !== undefined && end.compileCache.lane !== "read-only") {
    await ports
      .ledger(end.repo.toLowerCase())
      ?.end({ executionId: end.executionId, expiresAt: end.compileCache.expiresAt })
      .catch(() => {});
  }
};
