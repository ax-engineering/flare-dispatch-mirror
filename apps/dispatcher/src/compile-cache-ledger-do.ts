// FlareDispatch Dispatcher — the CompileCacheLedger Durable Object.
//
// One instance per repository (`idFromName(<owner/name>)`, lowercase). The
// ledger logic is compile-cache-ledger.ts; this class runs it over the
// object's storage, one call at a time.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Shared compile cache.

import { DurableObject } from "cloudflare:workers";
import { type CompileCacheLedgerApi, makeCompileCacheLedger, type ReserveRequest, type ReserveResult } from "./compile-cache-ledger";
import type { Env } from "./env";

export class CompileCacheLedger extends DurableObject<Env> implements CompileCacheLedgerApi {
  private readonly ledger = makeCompileCacheLedger(this.ctx.storage);

  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    return this.ledger.reserve(request);
  }

  async end(request: { readonly executionId: string; readonly expiresAt: number }): Promise<void> {
    return this.ledger.end(request);
  }

  async release(request: { readonly bytes: number; readonly nowSec: number }): Promise<number> {
    return this.ledger.release(request);
  }

  async measure(request: { readonly bytes: number; readonly nowSec: number }): Promise<number> {
    return this.ledger.measure(request);
  }
}
