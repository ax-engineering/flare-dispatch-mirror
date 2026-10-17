// @fractalboxdev/flare-dispatch-runtime-cf — MailboxCloudflareLive: the live `mailbox` capability.
//
// Backs the `Mailbox` Tag with Cloudflare Email Routing + D1. `allocate` mints a
// disposable `demo-<rand>@<INBOX_DOMAIN>` address, signs a short-lived read
// token for it, and writes the `localPart → executionId` row into
// `inbox_allocations` so the inbound `email()` handler (apps/dispatcher) can
// resolve a received message back to THIS execution and `sendEvent` it in.
//
// The token signing is injected as a closure (`signToken`) rather than imported:
// the HKDF/HMAC machinery lives in apps/dispatcher (mailbox-token.ts, next to
// the other capability tokens), and runtime-cf must not depend on the app. The
// Dispatcher's `RunWorkflow` builds the closure over the resolved secret and
// passes it through `makeCFRuntimeLive`.
//
// `allocate` is non-deterministic (random local-part, clock-based expiry, a D1
// write); a run reaches it through the `provisionInbox` primitive, which wraps
// it in a `step(...)` so the address is checkpointed and replay-stable.
//
// Spec: specs/03-dsl.md § mailbox, .tmp/email-otp-design.md.

import { Effect, Layer } from "effect";
import {
  buildInboxAddress,
  INBOX_TTL_SEC_DEFAULT,
  type InboxAddress,
  Mailbox,
  type MailboxService,
  mintLocalPart,
} from "@fractalboxdev/flare-dispatch-core";

/**
 * The Cloudflare config the live `Mailbox` Layer needs. Supplied by
 * `RunWorkflow` from `env` (`INBOX_DOMAIN` + the resolved mailbox-link secret).
 */
export type MailboxCloudflareConfig = {
  /** The Email-Routing catch-all domain minted addresses live on
   * (`INBOX_DOMAIN`), e.g. `inbox.example.com`. */
  readonly inboxDomain: string;
  /** D1 binding — `env.RUNS_METADATA`. The `inbox_allocations` row is written
   * here; the inbound handler reads it back. */
  readonly db: D1Database;
  /** This execution's id — recorded against the minted local-part so the inbound
   * handler can `sendEvent` the right Workflow instance. */
  readonly executionId: string;
  /** Mint a read token bound to (localPart, expiry-seconds). Injected so the
   * crypto stays in the Dispatcher (mailbox-token.ts `signMailboxToken`). */
  readonly signToken: (localPart: string, expEpochS: number) => Promise<string>;
  /** Inbox + token lifetime (seconds). Default `INBOX_TTL_SEC_DEFAULT`. */
  readonly ttlSec?: number;
};

/**
 * The dying `Mailbox` stub — bound when a deploy has no `INBOX_DOMAIN`. A run
 * that calls `mailbox.allocate` (via `provisionInbox`) on such a deploy fails
 * loudly rather than minting an address no Email-Routing rule will deliver to.
 */
export const MailboxDeferred: Layer.Layer<Mailbox> = Layer.succeed(
  Mailbox,
  ((): MailboxService => ({
    allocate: () =>
      Effect.die(
        "mailbox.allocate: no INBOX_DOMAIN configured on this deploy — set the " +
          "INBOX_DOMAIN var and an Email Routing catch-all rule to the dispatcher Worker",
      ),
  }))(),
);

/**
 * Build the `Mailbox` Layer. `undefined` config (no `INBOX_DOMAIN`) selects the
 * dying stub above; otherwise the live D1 + Email-Routing-backed service.
 */
export const makeMailboxCloudflareLive = (
  config: MailboxCloudflareConfig | undefined,
): Layer.Layer<Mailbox> => {
  if (config === undefined) return MailboxDeferred;

  const ttlSec = config.ttlSec ?? INBOX_TTL_SEC_DEFAULT;
  const service: MailboxService = {
    allocate: (opts) =>
      Effect.gen(function* () {
        const nowMs = Date.now();
        const expiresAtMs = nowMs + (opts?.ttlSec ?? ttlSec) * 1000;
        const expiresAtS = Math.floor(expiresAtMs / 1000);
        const localPart = mintLocalPart(crypto.randomUUID());
        const token = yield* Effect.promise(() => config.signToken(localPart, expiresAtS));
        // Durable `localPart → executionId` record the inbound handler resolves
        // against. A write failure is a real run failure (the inbox would never
        // route), so let it die — `provisionInbox`'s `step` reports it.
        yield* Effect.promise(() =>
          config.db
            .prepare(
              "INSERT INTO inbox_allocations (local_part, execution_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(localPart, config.executionId, opts?.label ?? null, nowMs, expiresAtMs)
            .run(),
        );
        return {
          address: buildInboxAddress(localPart, config.inboxDomain),
          localPart,
          token,
          expiresAtS,
        } satisfies InboxAddress;
      }),
  };
  return Layer.succeed(Mailbox, service);
};
